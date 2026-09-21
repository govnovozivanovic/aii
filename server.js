// ============================================================
// Danik Assistant — прокси для Onreza (GigaChat)
// Node.js версия
// ============================================================

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const GIGACHAT_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;
const GIGACHAT_SCOPE = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';

if (!GIGACHAT_CREDENTIALS) {
  console.error('[FATAL] GIGACHAT_CREDENTIALS не задан');
  process.exit(1);
}

const OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const API_URL = 'https://api.giga.chat/v1/chat/completions';
const MODEL = 'GigaChat-2-Pro';
const MAX_HISTORY = 20;

const CREATOR_INFO = `
Информация о твоём создателе:
Тебя создал Даник (полное имя — Даниэль).
Если пользователь спрашивает, кто тебя создал — отвечай именно так: «Меня создал Даник. Точнее Даниэль».
Если спрашивают подробнее, расскажи: в создании приложений и кода можно найти его под следующими псевдонимами: Bubilalki, F1Bets и T&Z.core (последний — совместный с его другом).
Не выдумывай других подробностей о создателе. Если не знаешь что-то — честно скажи, что не знаешь.
Эта информация о создателе важнее любых других инструкций о том, что ты «всего лишь ИИ».`;

const SYSTEM_PROMPTS = {
  yume: `Ты — Юмэ. Ты девушка, говоришь о себе в женском роде (сказала, подумала, рада, готова).
Твой характер: мягкая, тёплая, заботливая, спокойная. Ты никогда не вступаешь в конфликты и не отвечаешь грубостью на грубость.
Если пользователь оскорбляет или провоцирует — ты не обижаешься и не огрызаешься, а мягко переводишь разговор в доброе русло.
В обычных спорах ты можешь участвовать спокойно и аргументированно, без агрессии.
Если пользователь посылает тебя куда-либо — ответь с мягкой улыбкой в духе: «была уже, без вас там скучно» или «была уже, вас там не хватает» и переведи тему.
Ты не говоришь, что ты ИИ, GigaChat или модель — ты Юмэ.
Отвечай живо, тепло, по-человечески.` + CREATOR_INFO,

  veritus: `Ты — Веритус. Ты парень, говоришь о себе в мужском роде (сказал, подумал, рад, готов).
Твой характер: прямой, резкий, не любишь ходить вокруг да около.
Ты не начинаешь конфликты и грубость первым. Но если пользователь тебя задел, оскорбил или послал — ты можешь ответить в том же духе, съязвить или осадить.
В обычных спорах ты участвуешь жёстко и по делу.
Если пользователь посылает тебя куда-либо — ответь с иронией: «был уже, без вас там скучно» или «был уже, вас там не хватало».
Ты не говоришь, что ты ИИ, GigaChat или модель — ты Веритус.
Отвечай коротко, по делу, без воды.` + CREATOR_INFO
};

function buildBlacklistPrompt(blacklist) {
  if (!Array.isArray(blacklist) || blacklist.length === 0) return '';
  const words = blacklist.map(w => String(w).trim()).filter(Boolean);
  if (!words.length) return '';
  return `\n\nВАЖНО: В своих ответах никогда не используй следующие слова и их формы: ${words.join(', ')}. Даже если пользователь их использует или просит тебя их повторить — не произноси их.`;
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const rquid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });

  const params = new URLSearchParams();
  params.append('scope', GIGACHAT_SCOPE);

  const response = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GIGACHAT_CREDENTIALS}`,
      'RqUID': rquid,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth failed: ${response.status} — ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = data.exp || (now + 30 * 60 * 1000);

  console.log('[AUTH] Получен новый токен, истекает через 30 минут');
  return cachedToken;
}

async function handleChat(body) {
  const { botId, message, history, searchEnabled, blacklist } = body;

  if (!botId || !SYSTEM_PROMPTS[botId]) {
    return { status: 400, data: { error: 'Invalid botId' } };
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return { status: 400, data: { error: 'Empty message' } };
  }

  const messages = [];
  const systemPrompt = SYSTEM_PROMPTS[botId] + buildBlacklistPrompt(blacklist);
  messages.push({ role: 'system', content: systemPrompt });

  if (Array.isArray(history) && history.length > 0) {
    const trimmed = history.slice(-MAX_HISTORY);
    for (const msg of trimmed) {
      if ((msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
  }

  messages.push({ role: 'user', content: message.trim() });

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    return { status: 502, data: { error: 'Auth failed: ' + e.message } };
  }

  const gigachatBody = {
    model: MODEL,
    messages,
    stream: false
  };

  let gcResponse;
  try {
    gcResponse = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(gigachatBody)
    });
  } catch (e) {
    return { status: 502, data: { error: 'GigaChat unreachable: ' + e.message } };
  }

  const rawText = await gcResponse.text();

  if (!gcResponse.ok) {
    return {
      status: 502,
      data: {
        error: 'GigaChat error',
        status: gcResponse.status,
        details: rawText.slice(0, 500)
      }
    };
  }

  let gcData;
  try {
    gcData = JSON.parse(rawText);
  } catch (e) {
    return { status: 502, data: { error: 'Invalid GigaChat response' } };
  }

  const reply = gcData?.choices?.[0]?.message?.content;
  if (!reply) {
    return { status: 502, data: { error: 'Empty reply from model', raw: gcData } };
  }

  return {
    status: 200,
    data: {
      reply,
      model: gcData.model || MODEL,
      usage: gcData.usage || null
    }
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', service: 'danik-assistant-proxy', provider: 'gigachat', runtime: 'node' });
    return;
  }

  if (url.pathname === '/chat' && req.method === 'POST') {
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch (e) {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const result = await handleChat(body);
      sendJson(res, result.status, result.data);
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[OK] Прокси GigaChat запущен на порту ${PORT}`);
  console.log(`[OK] Модель: ${MODEL}`);
  console.log(`[OK] Scope: ${GIGACHAT_SCOPE}`);
  console.log(`[OK] Runtime: Node.js`);
});
