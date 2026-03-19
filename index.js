const axios = require('axios');
const crypto = require('crypto');

// 飞书配置
const FEISHU_CONFIG = {
  app_id: process.env.FEISHU_APP_ID || 'cli_a927389a6d38dcbb',
  app_secret: process.env.FEISHU_APP_SECRET || 'dmuy4cWWJcH7WaSQHmPebfcYUj1z7iI7',
  receive_id: process.env.FEISHU_RECEIVE_ID || 'ou_99c59002c1476b309d6e1baa7675f465',
  receive_id_type: process.env.FEISHU_RECEIVE_ID_TYPE || 'open_id',
};

// 百度网盘分享链接配置
const BAIDU_SHARE_CONFIG = {
  url: process.env.BAIDU_SHARE_URL || 'https://pan.baidu.com/s/15GmNkLcV0V66awfEDOzSkg?pwd=w8V2',
  pwd: process.env.BAIDU_SHARE_PWD || 'w8V2',
};

// KV 存储键名
const SNAPSHOT_KEY = 'baiduyun_snapshot';

// 获取页面 MD5 指纹
async function getPageFingerprint(url) {
  try {
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      maxRedirects: 5,
    });

    const content = response.data;
    const fingerprint = crypto.createHash('md5').update(content).digest('hex');
    return fingerprint;
  } catch (error) {
    console.error('获取页面指纹失败:', error.message);
    return null;
  }
}

// 获取飞书 tenant_access_token
async function getFeishuToken() {
  try {
    const response = await axios.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: FEISHU_CONFIG.app_id,
        app_secret: FEISHU_CONFIG.app_secret,
      }
    );

    if (response.data.code === 0) {
      return response.data.tenant_access_token;
    } else {
      throw new Error(`获取 token 失败: ${response.data.msg}`);
    }
  } catch (error) {
    console.error('获取飞书 token 失败:', error.message);
    throw error;
  }
}

// 发送飞书通知
async function sendFeishuNotify(token, shareUrl, changes) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  const card = {
    header: {
      title: { tag: 'plain_text', content: '百度网盘资源更新提醒' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**检测时间：** ${now}\n**分享链接：** [点击打开](${shareUrl})\n\n**变化内容：**\n${changes}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: '请打开分享链接查看并转存您需要的文件。' },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '打开分享链接' },
            type: 'primary',
            url: shareUrl,
          },
        ],
      },
    ],
  };

  try {
    const response = await axios.post(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${FEISHU_CONFIG.receive_id_type}`,
      {
        receive_id: FEISHU_CONFIG.receive_id,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data.code === 0) {
      console.log('飞书通知发送成功');
      return true;
    } else {
      console.error('飞书 API 返回错误:', response.data);
      return false;
    }
  } catch (error) {
    console.error('发送飞书通知失败:', error.message);
    return false;
  }
}

// 主处理函数
async function monitorShare() {
  console.log('开始监控...');

  // 1. 获取当前页面指纹
  console.log('正在获取分享链接页面指纹...');
  const currentFingerprint = await getPageFingerprint(BAIDU_SHARE_CONFIG.url);

  if (!currentFingerprint) {
    console.error('无法获取页面指纹');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: '无法获取页面指纹' }),
    };
  }

  console.log('当前页面指纹:', currentFingerprint);

  // 2. 获取上次的快照（从 KV 存储）
  let oldFingerprint = null;
  try {
    if (typeof process.env.KV_SNAPSHOT === 'string') {
      oldFingerprint = process.env.KV_SNAPSHOT;
      console.log('上次的页面指纹:', oldFingerprint);
    }
  } catch (error) {
    console.log('无法读取上次快照，视为首次运行');
  }

  // 3. 对比指纹
  if (oldFingerprint === currentFingerprint) {
    console.log('无更新，页面指纹与上次一致');
    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'no_change', fingerprint: currentFingerprint }),
    };
  }

  console.log('检测到更新！');

  // 4. 发送飞书通知
  console.log('正在发送飞书通知...');
  const changes = '分享链接页面内容发生变化，可能有文件更新。\n请打开链接查看详细内容。';
  await sendFeishuNotify(await getFeishuToken(), BAIDU_SHARE_CONFIG.url, changes);

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: 'changed',
      fingerprint: currentFingerprint,
      previous_fingerprint: oldFingerprint,
    }),
  };
}

// Vercel Serverless Function 入口
module.exports = async (req, res) => {
  // 设置 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 只接受 GET 请求（或定时任务触发）
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await monitorShare();
    return res.status(result.statusCode).json(JSON.parse(result.body));
  } catch (error) {
    console.error('监控失败:', error);
    return res.status(500).json({ error: error.message });
  }
};
