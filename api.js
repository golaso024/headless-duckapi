#!/usr/bin/env node
// api.js — OpenAI-compatible HTTP API over the duck.ai protocol.
//
// A Telegram-free entrypoint: no BOT_TOKEN, no Bot API, no SQLite. The whole
// duck.ai client (bot/lib/duckai.js) is standalone, so this file is just a
// thin HTTP adapter on top of it. Challenge tokens / fe-metadata are cached
// in process memory (pass store: null — nothing is persisted).
//
//   GET  /                        — status (also used by the Docker healthcheck)
//   GET  /health                  — same as /
//   GET  /v1/models               — live model list from duck.ai (static fallback)
//   POST /v1/chat/completions     — chat completion, stream and non-stream
//
// OpenAI-compatible request/response. Extensions beyond the OpenAI schema:
//   "reasoning_effort": "none" | "low" | "medium"   (duck.ai reasoning effort)
//   "web_search": true                              (duck.ai WebSearch tool)
//   "image": true                                   (duck.ai GenerateImage tool;
//        response carries message.images = ["data:image/...;base64,..."])
// Vision works via standard OpenAI image_url parts (data: or http(s) URLs;
// JPEG is re-encoded to PNG in pure JS, duck.ai rejects JPEG parts).
//
// Env:  PORT (default 8080), API_KEY (optional; when set, clients must send
//       "Authorization: Bearer <API_KEY>"), DATA_DIR (unused, accepted for
//       symmetry with app.js).
//
// CLI:  node api.js            — run the API server
//       node api.js models     — print the model list and exit

import './env.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as duckai from './bot/lib/duckai.js';
import { makeProxiedFetch, redactProxyUrl } from './bot/lib/proxyfetch.js';
import { sniffImageMime, jpegToPngDataUrl } from './bot/lib/imgconv.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Static fallback (same ids as bot/lib/settings.js MODEL_NAMES) for the rare
// moments duck.ai itself is unreachable — /v1/models must stay predictable.
const FALLBACK_MODELS = [
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', provider: 'openai', free: true, image: false, efforts: ['none', 'low', 'medium'] },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'openai', free: true, image: false, efforts: ['none', 'low', 'medium'] },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic', free: true, image: false, efforts: ['none', 'low', 'medium'] },
  { id: 'mistral-small-2603', name: 'Mistral Small 2603', provider: 'mistral', free: true, image: false, efforts: ['none', 'low', 'medium'] },
  { id: 'tinfoil/gpt-oss-120b', name: 'GPT-OSS 120B', provider: 'tinfoil', free: true, image: false, efforts: ['none', 'low', 'medium'] },
  { id: 'tinfoil/gemma4-31b', name: 'Gemma 4 31B', provider: 'tinfoil', free: true, image: false, efforts: ['none', 'low', 'medium'] },
];
const MODELS_TTL_MS = 10 * 60 * 1000;

// duck.ai's own model list leads with new flagships that are frequently
// RESTRICTED for anonymous users (ERR_MODEL_RESTRICTED on chat, Oct 2026:
// gpt-5.6-terra, claude-sonnet-5-5) even though GET /duckchat/v1/models lists
// them. So the default model and family-alias resolution prefer this order —
// models that actually answer on the free tier. Anything not listed keeps the
// duck.ai order.
const PREFERRED_MODELS = [
  'gpt-5.4-mini', 'gpt-6-luna', 'claude-haiku-4-5', 'mistral-small-2603',
  'tinfoil/gemma4-31b', 'tinfoil/gpt-oss-120b',
  'gpt-5.6-terra', 'gpt-5.6-sol', 'claude-sonnet-5-5', 'claude-opus-5-5',
];
const prefRank = (id) => {
  const i = PREFERRED_MODELS.indexOf(String(id));
  return i === -1 ? 99 : i;
};

const MAX_BODY = 32 * 1024 * 1024; // image data URLs can be large
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, type, code) {
  return sendJson(res, status, { error: { message, type: type || 'invalid_request_error', code: code || null } });
}

function estimateTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

function authOk(req, apiKeys) {
  if (!apiKeys.length) return true; // open server (no keys configured)
  const m = String(req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  return !!m && apiKeys.includes(m[1].trim());
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

export function makeModelCache({ fetchFn, chat, listModels } = {}) {
  const getM = listModels || ((...a) => duckai.getModels(...a));
  let cache = null;
  let ts = 0;
  let inflight = null;

  return async function getModels() {
    if (cache && Date.now() - ts < MODELS_TTL_MS) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const models = await getM(fetchFn);
        if (models && models.length) { cache = models; ts = Date.now(); return models; }
      } catch (e) {
        log('[api] model list fetch failed, using static fallback:', (e && e.message) || e);
      }
      cache = cache || FALLBACK_MODELS;
      ts = Date.now();
      return cache;
    })().finally(() => { inflight = null; });
    return inflight;
  };
}

// Resolve a client-supplied model id to a live duck.ai model. Exact id wins,
// then a substring match, then family aliases — so stale ids like
// "gpt-4o-mini" (removed from duck.ai long ago) still resolve to a current
// GPT instead of erroring out. Preferred (known-working) models win inside
// their family; the default is the best preferred model, not duck.ai's list
// head (which is often a restricted flagship).
export function resolveModel(requested, models) {
  const q = String(requested || '').trim().toLowerCase();
  if (!models || !models.length) return null;
  const byPref = (a, b) => prefRank(a.id) - prefRank(b.id);
  if (!q) return models.slice().sort(byPref)[0];
  let hit = models.find((m) => m.id.toLowerCase() === q);
  if (hit) return hit;
  hit = models.find((m) => m.id.toLowerCase().includes(q));
  if (hit) return hit;
  const family = /gpt|openai|o[134]-/.test(q) ? 'gpt'
    : /claude|anthropic/.test(q) ? 'claude'
    : /mistral/.test(q) ? 'mistral'
    : /gemma/.test(q) ? 'gemma'
    : /oss/.test(q) ? 'oss' : null;
  if (family) {
    const candidates = models.filter((m) => m.id.toLowerCase().includes(family)).sort(byPref);
    if (candidates.length) return candidates[0];
  }
  return null;
}

// Models do not all accept the same reasoning efforts: e.g.
// tinfoil/gpt-oss-120b lists only "low", so the previous hard-coded default
// "none" made duck.ai answer 400 ERR_BAD_REQUEST. When the client does not
// ask for a specific effort, pick one the model advertises.
export function defaultEffort(model) {
  const efforts = (model && model.efforts) || [];
  return efforts.includes('none') ? 'none' : (efforts[0] || 'none');
}

// Chat with automatic model fallback: when duck.ai rejects the resolved model
// with ERR_MODEL_RESTRICTED / ERR_MODEL_UNAVAILABLE (its own list advertises
// models the free tier can't use), retry the same family in preferred order.
// Returns { result, modelUsed }; onModelChange(id) fires before each retry so
// streaming handlers can correct the model they advertise.
export async function chatWithFallback(params, model, models, chat, onModelChange) {
  const family = /gpt/.test(model.id) ? 'gpt'
    : /claude/.test(model.id) ? 'claude'
    : /mistral/.test(model.id) ? 'mistral'
    : /gemma/.test(model.id) ? 'gemma'
    : /oss/.test(model.id) ? 'oss' : null;
  const candidates = family
    ? models.filter((m) => m.id !== model.id && m.id.toLowerCase().includes(family))
        .map((m) => m.id).sort((a, b) => prefRank(a) - prefRank(b))
    : [];
  let current = model.id;
  for (let i = 0; ; i++) {
    try {
      const result = await chat({ ...params, model: current });
      return { result, modelUsed: current };
    } catch (e) {
      const msg = String((e && e.message) || e);
      const restricted = /ERR_MODEL_RESTRICTED|ERR_MODEL_UNAVAILABLE/.test(msg);
      if (restricted && i < candidates.length) {
        log('[api] model ' + current + ' rejected by duck.ai (' + (msg.match(/ERR_MODEL_\w+/) || ['restricted'])[0] +
          ') — retrying with ' + candidates[i]);
        current = candidates[i];
        if (onModelChange) { try { onModelChange(current); } catch (e2) {} }
        continue;
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// vision: OpenAI content parts -> duck.ai parts ({type:'image'|'text', ...})
// ---------------------------------------------------------------------------

async function imagePartFromUrl(url, fetchFn) {
  let mime = null;
  let dataUrl = null;
  if (/^data:/i.test(url)) {
    const m = url.match(/^data:([^;,]+)[^,]*,/) || [];
    mime = (m[1] || '').toLowerCase();
    if (mime === 'image/png' || mime === 'image/webp') dataUrl = url;
    else if (mime !== 'image/jpeg') throw new Error('unsupported image data URL: ' + (mime || 'unknown') + ' (use PNG/WebP/JPEG)');
    else dataUrl = url; // jpeg — re-encoded below
  } else if (/^https?:\/\//i.test(url)) {
    const f = fetchFn || fetch;
    const r = await f(url, { headers: { 'user-agent': 'headless-duckapi/1.1' } });
    if (!r.ok) throw new Error('failed to fetch image_url: HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large');
    mime = sniffImageMime(buf) || (String(r.headers.get('content-type') || '').split(';')[0].toLowerCase());
    if (mime !== 'image/png' && mime !== 'image/webp' && mime !== 'image/jpeg') {
      throw new Error('unsupported image type: ' + mime + ' (use PNG/WebP/JPEG)');
    }
    if (mime === 'image/jpeg') {
      dataUrl = jpegToPngDataUrl(buf, 1024); // duck.ai rejects JPEG parts
    } else {
      dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
    }
  } else {
    throw new Error('image_url.url must be a data: or http(s) URL');
  }

  if (dataUrl && (mime === 'image/jpeg')) {
    // data URLs carry their own base64; re-encode to PNG via the pure-JS decoder
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    dataUrl = jpegToPngDataUrl(Buffer.from(b64, 'base64'), 1024);
  }
  const finalMime = (dataUrl.match(/^data:([^;,]+)/) || [])[1] || 'image/png';
  return { type: 'image', image: dataUrl, mimeType: finalMime };
}

async function normalizeMessage(content, fetchFn) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error('message content must be a string or an array of parts');
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') throw new Error('invalid content part');
    if (part.type === 'text' && typeof part.text === 'string') {
      out.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
      out.push(await imagePartFromUrl(part.image_url.url, fetchFn));
    } else if (part.type === 'input_text' && typeof part.text === 'string') {
      out.push({ type: 'text', text: part.text });
    } else if (part.type === 'input_image' && part.image_url && typeof part.image_url === 'string') {
      out.push(await imagePartFromUrl(part.image_url, fetchFn));
    } else {
      throw new Error('unsupported content part type: ' + (part.type || JSON.stringify(part).slice(0, 40)));
    }
  }
  if (!out.length) throw new Error('message content is empty');
  return out;
}

// duck.ai's chat endpoint rejects role:"system" outright:
//   HTTP 400 {"action":"error","status":400,"type":"ERR_BAD_REQUEST"}
// Verified for every position, an empty system message and array content; the
// upstream only accepts user/assistant turns. The OpenAI schema (and our own
// README) allow system/developer, so fold those prompts into the first user
// turn instead of forwarding them. Consecutive user turns are fine upstream.
function foldSystemPrompts(msgs) {
  const prompts = [];
  const out = [];
  for (const m of msgs) {
    if (m.role !== 'system') { out.push(m); continue; }
    const text = typeof m.content === 'string'
      ? m.content
      : m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
    if (text.trim()) prompts.push(text);
  }
  if (!prompts.length) return out;
  const prefix = prompts.join('\n\n');
  const firstUser = out.find((m) => m.role === 'user');
  if (!firstUser) {
    out.unshift({ role: 'user', content: prefix });
  } else if (typeof firstUser.content === 'string') {
    firstUser.content = prefix + '\n\n' + firstUser.content;
  } else {
    firstUser.content = [{ type: 'text', text: prefix }, ...firstUser.content];
  }
  return out;
}

async function normalizeMessages(messages, fetchFn) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages must be a non-empty array');
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') throw new Error('invalid message');
    let role = m.role;
    if (role === 'developer') role = 'system';
    if (!['system', 'user', 'assistant'].includes(role)) {
      throw new Error('unsupported role: ' + String(role) + ' (system, user, assistant are supported)');
    }
    out.push({ role, content: await normalizeMessage(m.content, fetchFn) });
  }
  const folded = foldSystemPrompts(out);
  if (!folded.length) throw new Error('messages must contain at least one non-empty message');
  return folded;
}

// ---------------------------------------------------------------------------
// request handlers
// ---------------------------------------------------------------------------

async function handleModels(res, getModels) {
  const models = await getModels();
  const created = Math.floor(Date.now() / 1000);
  return sendJson(res, 200, {
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created,
      owned_by: m.provider || 'duck.ai',
      // extra metadata (ignored by OpenAI clients):
      name: m.name || m.id,
      supports_image: !!m.image,
      reasoning_efforts: m.efforts || [],
    })),
  });
}

async function handleChatCompletions(req, res, ctx) {
  const { getModels, chat, fetchFn, meta } = ctx;
  const status = (s) => { if (meta) meta.status = s; return s; };
  let body;
  try {
    body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8') || '{}');
  } catch (e) {
    return sendError(res, status(400), 'invalid JSON body: ' + (e && e.message ? e.message : e));
  }
  if (!body || typeof body !== 'object') return sendError(res, status(400), 'request body must be a JSON object');

  let messages;
  try {
    messages = await normalizeMessages(body.messages, fetchFn);
  } catch (e) {
    return sendError(res, status(400), (e && e.message) || 'invalid messages');
  }

  const models = await getModels();
  const model = resolveModel(body.model, models);
  if (!model) {
    return sendError(res, status(404), 'model not found: ' + String(body.model) +
      '. Available: ' + models.map((m) => m.id).join(', '), 'invalid_request_error', 'model_not_found');
  }

  const explicitEffort = body.reasoning_effort != null;
  const effort = explicitEffort ? String(body.reasoning_effort) : defaultEffort(model);
  if (explicitEffort && !(model.efforts || []).includes(effort)) {
    return sendError(res, status(400), 'model ' + model.id + ' does not support reasoning_effort "' + effort +
      '" (supported: ' + (model.efforts || []).join(', ') + ')');
  }
  const wantImage = body.image === true;
  // no capability gate here: GenerateImage is a duck.ai tool, not a model flag
  // (m.image = supportsImageUpload, i.e. vision INPUT). duck.ai itself rejects
  // models that can't generate — that surfaces as a 502 with its message.

  const params = {
    model: model.id,
    messages,
    effort,
    webSearch: body.web_search === true,
    image: wantImage,
    fetchFn,
    store: ctx.store || null,
    signal: undefined, // set below for stream mode; non-stream ends naturally
  };

  const stream = body.stream === true;
  const id = 'chatcmpl-' + randomUUID();
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    try {
      const { result: out, modelUsed } = await chatWithFallback(params, model, models, chat);
      const text = (out && typeof out === 'object') ? (out.text || '') : String(out || '');
      const img = (out && typeof out === 'object' && out.image) ? out.image : null;
      const message = { role: 'assistant', content: text };
      if (img && img.b64) {
        message.images = ['data:image/' + (img.format || 'jpeg') + ';base64,' + img.b64];
      }
      const promptTokens = estimateTokens(JSON.stringify(messages));
      const completionTokens = estimateTokens(text);
      return sendJson(res, status(200), {
        id,
        object: 'chat.completion',
        created,
        model: modelUsed,
        system_fingerprint: 'duckai',
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    } catch (e) {
      return upstreamError(res, e, status);
    }
  }

  // --- streaming (SSE, OpenAI chunk format) ---
  const controller = new AbortController();
  params.signal = controller.signal;

  res.writeHead(status(200), {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  let usedModelId = model.id; // corrected by the fallback before any content streams
  const chunk = (delta, finish) => ({
    id, object: 'chat.completion.chunk', created, model: usedModelId, system_fingerprint: 'duckai',
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  });

  let closed = false;
  req.on('close', () => { closed = true; try { controller.abort(); } catch (e) {} });

  // The role chunk is sent lazily (first delta or finish), so a model fallback
  // that happens before duck.ai accepts the request never leaks a stale model.
  let roleSent = false;
  const sendRole = () => {
    if (!roleSent) { roleSent = true; send(chunk({ role: 'assistant', content: '' })); }
  };

  try {
    const out = await chatWithFallback({
      ...params,
      onDelta: (d) => { if (!closed) { sendRole(); send(chunk({ content: d })); } },
    }, model, models, chat, (mid) => { usedModelId = mid; });
    if (closed) return;
    sendRole();
    const img = (out && typeof out === 'object' && out.image && out.image.b64) ? out.image : null;
    if (img) {
      send(chunk({ images: ['data:image/' + (img.format || 'jpeg') + ';base64,' + img.b64] })); // extension
    }
    const text = (out && typeof out === 'object') ? (out.text || '') : String(out || '');
    if (body.stream_options && body.stream_options.include_usage) {
      send({ ...chunk({}, 'stop'), usage: { prompt_tokens: estimateTokens(JSON.stringify(messages)), completion_tokens: estimateTokens(text), total_tokens: 0 } });
    } else {
      send(chunk({}, 'stop'));
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    if (closed || (e && (e.name === 'AbortError' || /aborted/i.test(String(e && e.message))))) {
      try { res.end(); } catch (e2) {}
      return;
    }
    // headers are already sent — report the error as a final chunk + [DONE]
    try {
      const msg = (e && e.message) || String(e);
      const type = /HTTP 418|HTTP 429/.test(msg) ? 'rate_limit_error'
        : /HTTP 400/.test(msg) ? 'invalid_request_error' : 'api_error';
      send({ error: { message: msg, type, code: null } });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e2) { /* socket gone */ }
  }
}

function upstreamError(res, e, status) {
  const st = (s) => (typeof status === 'function' ? status(s) : s);
  const msg = (e && e.message) || String(e);
  if (/HTTP 418|HTTP 429/.test(msg)) {
    return sendError(res, st(429), 'duck.ai is rate-limiting this IP (' + msg + '). Wait a moment and retry.', 'rate_limit_error');
  }
  // duck.ai 400 = the request shape is wrong (unsupported role/effort/model
  // combination), not a transient gateway failure. Surface it as 400 so OpenAI
  // clients don't retry a request that can never succeed — retry storms are
  // exactly what pushes a shared IP into duck.ai's 429 window.
  if (/HTTP 400/.test(msg)) {
    return sendError(res, st(400), 'duck.ai rejected the request: ' + msg, 'invalid_request_error');
  }
  if (/HTTP \d{3}/.test(msg)) {
    return sendError(res, st(502), 'duck.ai upstream error: ' + msg, 'api_error');
  }
  return sendError(res, st(502), 'duck.ai request failed: ' + msg, 'api_error');
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export function startApiServer(opts = {}) {
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : (process.env.API_KEY || '');
  // Multi-key: API_KEYS=k1,k2 (each key gets its own rate-limit bucket);
  // single API_KEY keeps working as a one-element list.
  const apiKeys = String(opts.apiKeys !== undefined ? opts.apiKeys : (process.env.API_KEYS || apiKey || ''))
    .split(',').map((s) => s.trim()).filter(Boolean);
  // Per-key token bucket, requests per minute. RATE_LIMIT_RPM=0 disables.
  // Only applies to authenticated keys: an open server is not limited.
  const rpm = parseInt(process.env.RATE_LIMIT_RPM || '30', 10);
  const buckets = new Map(); // key → { tokens, last }
  const limiter = (key) => {
    if (!rpm || rpm <= 0 || !apiKeys.length || !key) return 0; // 0s = allowed
    const now = Date.now();
    const b = buckets.get(key) || { tokens: rpm, last: now };
    b.tokens = Math.min(rpm, b.tokens + Math.floor(((now - b.last) / 60000) * rpm));
    if (b.tokens <= 0) { buckets.set(key, b); return Math.max(1, Math.ceil(60 / rpm)); }
    b.tokens -= 1;
    b.last = now;
    buckets.set(key, b);
    return 0;
  };
  const fetchFn = opts.fetchFn;
  const store = opts.store !== undefined ? opts.store : null;
  const chat = opts.chat || ((p) => duckai.chat(p));
  const getModels = makeModelCache({ fetchFn, listModels: opts.listModels });
  const startedAt = Date.now();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const t0 = Date.now();

    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const done = (status) =>
      log('[api]', req.method, pathname, status, (Date.now() - t0) + 'ms');

    try {
      if (!authOk(req, apiKeys)) {
        done(401);
        return sendError(res, 401, 'invalid API key (set Authorization: Bearer <API_KEY>, or unset API_KEY on the server)', 'authentication_error');
      }
      const bearer = (String(req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i) || [])[1];
      const retryAfter = limiter(bearer ? bearer.trim() : null);
      if (retryAfter > 0) {
        done(429);
        res.setHeader('retry-after', String(retryAfter));
        return sendError(res, 429, 'rate limit exceeded for this key — retry in ' + retryAfter + 's', 'rate_limit_error');
      }

      if (pathname === '/' || pathname === '/health') {
        done(200);
        return sendJson(res, 200, {
          ok: true,
          service: 'headless-duckapi',
          mode: 'api',
          uptime_s: Math.floor((Date.now() - startedAt) / 1000),
          endpoints: ['/v1/models', '/v1/chat/completions'],
          auth: apiKeys.length ? 'bearer' : 'open',
        });
      }

      if (pathname === '/v1/models' && (req.method === 'GET' || req.method === 'HEAD')) {
        try { await handleModels(res, getModels); done(200); } catch (e) { done(500); sendError(res, 500, (e && e.message) || String(e), 'api_error'); }
        return;
      }

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        const meta = {};
        await handleChatCompletions(req, res, { getModels, chat, fetchFn, store, meta });
        done(meta.status || 200);
        return;
      }

      done(404);
      return sendError(res, 404, 'unknown endpoint: ' + req.method + ' ' + pathname +
        ' (available: GET /v1/models, POST /v1/chat/completions, GET /health)', 'invalid_request_error', 'not_found');
    } catch (e) {
      done(500);
      try { sendError(res, 500, 'internal error: ' + ((e && e.message) || e), 'api_error'); } catch (e2) { /* headers sent */ }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const port = opts.port !== undefined ? opts.port : (parseInt(process.env.PORT || '8080', 10) || 8080);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();

  if (cmd === 'models') {
    const models = await duckai.getModels().catch(() => FALLBACK_MODELS);
    for (const m of models) log((m.free ? '✓' : ' '), m.id, '—', m.name || '', m.image ? '[image]' : '');
    return;
  }

  if (cmd && cmd !== 'run') throw new Error('unknown command: ' + cmd + ' (use: node api.js [models|run])');

  const port = parseInt(process.env.PORT || '8080', 10) || 8080;
  // PROXY_URL: route ALL duck.ai traffic through a forward proxy
  // (http://, https:// or socks5:// for Cloudflare WARP: warp-cli proxy
  // start → socks5://127.0.0.1:40000). Fail-closed: no direct fallback.
  let fetchFn;
  if (process.env.PROXY_URL) {
    fetchFn = await makeProxiedFetch(process.env.PROXY_URL);
    log('[api] duck.ai traffic via proxy: ' + redactProxyUrl(process.env.PROXY_URL));
  }
  await startApiServer({ port, fetchFn });
  log('duck.ai OpenAI-compatible API listening on http://0.0.0.0:' + port +
    (process.env.API_KEY ? ' (API_KEY: required)' : ' (API_KEY: not set — open to anyone with network access)'));
  log('POST /v1/chat/completions · GET /v1/models · GET /health — Ctrl+C to stop');

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  // keep the event loop alive
  await sleep(2147483647);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error('fatal:', (e && e.stack) || e);
    process.exit(1);
  });
}
