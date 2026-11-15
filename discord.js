// discord.js — zero-dependency Discord adapter over the duck.ai engine.
//
// Discord has no AI of its own: bots wire their own backend, and this file
// wires OURS (bot/lib/duckai.js) into a real Discord bot account (user
// account automation breaks Discord ToS — always use a registered bot).
//
//   node discord.js
//
// Env:
//   DISCORD_BOT_TOKEN   required — bot token from the Discord dev portal
//   DISCORD_CLIENT_ID   required — application id (for slash commands)
//   PROXY_URL           optional — duck.ai traffic through the proxy (REST
//                       calls go through it too; the gateway socket connects
//                       directly — the token stays on Discord's TLS anyway)
//
// Dev portal checklist:
//   1. create an application + bot, copy the token and the application id
//   2. enable the MESSAGE CONTENT intent (privileged) — guild text is
//      invisible without it; DMs always carry content
//   3. invite the bot with the "bot" scope into your server
//
// What it does:
//   * DMs and @mentions → the engine answers (per-channel history, 12 msgs)
//   * slash commands: /ask <question>, /duo <question>, /models
//   * typing indicator while the answer streams; final reply in ≤1900-char
//     chunks (Discord edits are rate-limited harder than Telegram, so we do
//     not fake streaming with edits)

import path from 'node:path';
import * as duckai from './bot/lib/duckai.js';
import { makeProxiedFetch, redactProxyUrl } from './bot/lib/proxyfetch.js';

const TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const HISTORY_LIMIT = 12;
const CHUNK = 1900; // Discord hard cap is 2000

const state = { model: 'gpt-5.4-mini', effort: 'none', web: false, fetchFn: null, seq: null };
let shuttingDown = false;
const hist = new Map(); // channelId → [{ role, content }]
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunkText(text) {
  const clean = String(text || '').trim() || '(empty)';
  if (clean.length <= CHUNK) return [clean];
  const parts = [];
  let rest = clean;
  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf('\n', CHUNK);
    if (cut < CHUNK - 800) cut = rest.lastIndexOf(' ', CHUNK);
    if (cut < 400) cut = CHUNK;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

// ── REST with basic 429 respect ──
async function rest(method, apiPath, body) {
  const doFetch = () => (state.fetchFn || fetch)(API + apiPath, {
    method,
    headers: {
      authorization: 'Bot ' + TOKEN,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await doFetch().catch((e) => { throw new Error('REST network error: ' + ((e && e.message) || e)); });
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    await sleep(Math.ceil((j.retry_after || 1) * 1000));
    res = await doFetch();
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function sendTyping(channelId) {
  return rest('POST', '/channels/' + channelId + '/typing').catch(() => null);
}

async function sendMessage(channelId, content) {
  for (const part of chunkText(content)) {
    const r = await rest('POST', '/channels/' + channelId + '/messages', { content: part });
    if (r.status >= 400) {
      log('send failed:', r.status, JSON.stringify(r.json).slice(0, 160));
      return;
    }
  }
}

// ── engine glue ──
function historyFor(channelId) {
  if (!hist.has(channelId)) hist.set(channelId, []);
  return hist.get(channelId);
}

function buildMessages(channelId, text) {
  const system = {
    role: 'user',
    content: 'You are a helpful AI assistant inside a Discord bot (DuckAI bot). Today is ' +
      new Date().toISOString().slice(0, 10) + '. Answer in the same language the user writes in. Be concise by default.',
  };
  const h = historyFor(channelId).slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, content: m.content }));
  return [system].concat(h.slice(0, -1)).concat([{ role: 'user', content: text }]);
}

async function engineTurn(channelId, text, model, webSearch, onDelta) {
  return duckai.chat({
    model: model || state.model,
    effort: state.effort,
    webSearch: webSearch != null ? webSearch : state.web,
    messages: buildMessages(channelId, text),
    fetchFn: state.fetchFn,
    onDelta,
  });
}

async function answerText(channelId, text, model) {
  const typing = setInterval(() => sendTyping(channelId), 8000);
  sendTyping(channelId);
  try {
    const out = await engineTurn(channelId, text, model);
    const full = typeof out === 'string' ? out : (out && out.text) || '';
    const img = (out && typeof out === 'object' && out.image) ? out.image : null;
    const h = historyFor(channelId);
    h.push({ role: 'user', content: text });
    h.push({ role: 'assistant', content: full.slice(0, 4000) });
    if (img) await sendMessage(channelId, '🎨 [image generated — CLI or Telegram build shows the picture]');
    return full;
  } finally {
    clearInterval(typing);
  }
}

// ── duo: two families, two messages ──
async function duoAnswer(channelId, q, rowModel) {
  const ids = await duckai.getModels(state.fetchFn).catch(() => []);
  const free = ids.filter((m) => m && m.free !== false).map((m) => m.id);
  const isClaude = /claude/.test(rowModel);
  let m1 = free.includes(rowModel) ? rowModel : rowModel;
  let m2 = free.find((id) => id.startsWith(isClaude ? 'gpt-6' : 'claude')) || null;
  if (!m2) m2 = isClaude ? 'gpt-5.4-mini' : 'claude-haiku-5-5';
  await sendMessage(channelId, '🎯 Asking two AIs: ' + m1 + ' + ' + m2);
  const run = (model) => engineTurn(channelId, q, model).catch((e) => 'failed: ' + ((e && e.message) || e));
  const [a, b] = await Promise.all([run(m1), run(m2)]);
  await sendMessage(channelId, '── ' + m1 + ' ──\n' + a);
  await sendMessage(channelId, '── ' + m2 + ' ──\n' + b);
}

// ── gateway ──
const GUILD_MESSAGES = 1 << 9;
const DIRECT_MESSAGES = 1 << 8;
const MESSAGE_CONTENT = 1 << 15;
const GUILDS = 1 << 0;
const INTENTS = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT;

function connectGateway(onDispatch) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY);
    let hb = null;
    let ready = false;
    const preFail = (err) => { if (hb) clearInterval(hb); reject(err); };
    ws.onmessage = (ev) => {
      const p = JSON.parse(ev.data);
      if (p.s !== null && p.s !== undefined) state.seq = p.s;
      if (p.op === 10) { // hello → identify + heartbeat
        hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: state.seq })); } catch (e) {} }, p.d.heartbeat_interval);
        ws.send(JSON.stringify({
          op: 2,
          d: {
            token: 'Bot ' + TOKEN,
            intents: INTENTS,
            properties: { os: 'linux', browser: 'headless-duckapi', device: 'headless-duckapi' },
          },
        }));
      } else if (p.op === 9) { // invalid session: bad token / bad intents (before READY)
        preFail(new Error('invalid session (op 9) — check DISCORD_BOT_TOKEN and the MESSAGE CONTENT intent'));
      } else if (p.op === 0 && p.t === 'READY') {
        ready = true;
        resolve(ws);
      } else if (p.op === 0 && p.t) {
        try { onDispatch(p.t, p.d); } catch (e) { console.error('[discord] dispatch error:', (e && e.message) || e); }
      }
    };
    ws.onclose = (ev) => {
      if (hb) clearInterval(hb);
      if (!ready) return preFail(new Error(ev.code === 4004 ? 'authentication failed (4004) — check DISCORD_BOT_TOKEN' : 'gateway closed before READY (code ' + ev.code + ')'));
      if (shuttingDown) return;
      log('gateway closed — reconnecting in 5s');
      setTimeout(() => { connectGateway(onDispatch).catch((e) => { log('reconnect fatal:', (e && e.message) || e); process.exit(1); }); }, 5000);
    };
    ws.onerror = () => {};
  });
}

// ── slash commands ──
const SLASH = [
  { name: 'ask', description: 'Ask the DuckAI model', options: [{ name: 'question', description: 'Your question', type: 3, required: true }] },
  { name: 'duo', description: 'Two models answer the same question', options: [{ name: 'question', description: 'Your question', type: 3, required: true }] },
  { name: 'models', description: 'List live duck.ai models' },
];

async function main() {
  if (!TOKEN || !CLIENT_ID) {
    console.log([
      'Discord setup is incomplete:',
      '  1. create an application + bot at discord.com/developers/applications',
      '  2. copy the bot token       → DISCORD_BOT_TOKEN',
      '  3. copy the application id  → DISCORD_CLIENT_ID',
      '  4. enable the MESSAGE CONTENT intent (Bot → Privileged Gateway Intents)',
      '  5. invite the bot with the "bot" scope: applications.oauth2 → URL generator',
      '  6. run: node discord.js',
      'Bot accounts only — user-account automation breaks Discord ToS.',
    ].join('\n'));
    process.exit(1);
  }
  if (process.env.PROXY_URL) {
    state.fetchFn = await makeProxiedFetch(process.env.PROXY_URL);
    log('duck.ai traffic via proxy:', redactProxyUrl(process.env.PROXY_URL));
  }

  const reg = await rest('PUT', '/applications/' + CLIENT_ID + '/commands', SLASH);
  if (reg.status >= 400) {
    console.error('slash commands registration failed:', reg.status, JSON.stringify(reg.json).slice(0, 160));
    console.error('check DISCORD_CLIENT_ID and the token scopes (applications.commands)');
  } else {
    log('slash commands registered:', SLASH.map((c) => '/' + c.name).join(' '));
  }

  log('connecting to the Discord gateway…');
  const ws = await connectGateway(async (t, d) => {
    if (t === 'MESSAGE_CREATE' && d.content && !d.author.bot) {
      const isDM = d.guild_id === undefined;
      const mentioned = d.mentions && d.mentions.some((u) => u.id === CLIENT_ID);
      if (!isDM && !mentioned) return;
      const q = d.content.replace(new RegExp('<@!?' + CLIENT_ID + '>', 'g'), '').trim();
      if (!q) { await sendMessage(d.channel_id, 'Ask me anything — here or in a DM 🦆'); return; }
      log('message', d.channel_id, ':', q.slice(0, 60));
      try { await answerText(d.channel_id, q); } catch (e) {
        await sendMessage(d.channel_id, '⚠️ ' + String((e && e.message) || e).slice(0, 500)).catch(() => {});
      }
    }
    if (t === 'INTERACTION_CREATE') {
      const { id, token: itok, data, channel_id } = d;
      await rest('POST', '/interactions/' + id + '/' + itok + '/callback', { type: 5 }); // defer
      const opt = (name) => ((data.options || []).find((o) => o.name === name) || {}).value || '';
      try {
        if (data.name === 'models') {
          const ids = await duckai.getModels(state.fetchFn).catch(() => []);
          const free = ids.filter((m) => m && m.free !== false).map((m) => m.id);
          await rest('PATCH', '/webhooks/' + CLIENT_ID + '/' + itok + '/messages/@original', { content: 'Free models: ' + free.join(', ') });
        } else if (data.name === 'ask') {
          const q = opt('question');
          const ans = await answerText(channel_id || d.channel_id, q);
          await rest('PATCH', '/webhooks/' + CLIENT_ID + '/' + itok + '/messages/@original', { content: chunkText(ans)[0] || '(empty)' });
        } else if (data.name === 'duo') {
          await duoAnswer(channel_id || d.channel_id, opt('question'));
          await rest('PATCH', '/webhooks/' + CLIENT_ID + '/' + itok + '/messages/@original', { content: '🎯 both opinions delivered above' });
        }
      } catch (e) {
        await rest('PATCH', '/webhooks/' + CLIENT_ID + '/' + itok + '/messages/@original', { content: '⚠️ ' + String((e && e.message) || e).slice(0, 500) }).catch(() => {});
      }
    }
  }).catch((e) => { log('gateway:', (e && e.message) || e); process.exit(1); });

  log('DuckAI bot is live — mentions and DMs answer, /ask /duo /models registered');
  process.on('SIGINT', () => process.exit(0));
  await sleep(2147483647);
}

main().catch((e) => { console.error('fatal:', (e && e.message) || e); process.exit(1); });
