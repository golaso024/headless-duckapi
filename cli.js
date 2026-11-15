#!/usr/bin/env node
// cli.js — interactive terminal chat over the duck.ai protocol engine.
//
// The third face of headless-duckapi: the same bot/lib/duckai.js engine as
// app.js (Telegram) and api.js (HTTP), but straight in your terminal.
// Zero dependencies beyond the engine itself.
//
//   node cli.js                    — chat with the default model
//   node cli.js --model <id|part>  — start with another model
//   node cli.js --web              — start with duck.ai WebSearch on
//
// Session commands:
//   /model [id|part]   show the live model list or switch models
//   /web [on|off]      toggle duck.ai WebSearch
//   /effort            cycle reasoning effort: none → low → medium
//   /img <prompt>      generate an image, save it into the out dir
//   /reset             clear in-memory conversation history
//   /help              this list
//   /exit              quit
//
// Env: DUCK_CLI_OUT (default ./out) — directory for generated images.

import { createInterface, emitKeypressEvents } from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as duckai from './bot/lib/duckai.js';
import { makeProxiedFetch, redactProxyUrl } from './bot/lib/proxyfetch.js';

const HISTORY_LIMIT = 12;
const OUT_DIR = path.resolve(process.env.DUCK_CLI_OUT || './out');
const EFFORTS = ['none', 'low', 'medium'];
const FALLBACK_MODELS = [
  'gpt-5.4-mini', 'gpt-6-luna', 'claude-haiku-5-5', 'mistral-small-2603',
  'tinfoil/gpt-oss-120b', 'tinfoil/gemma4-31b',
];

const state = {
  model: 'gpt-5.4-mini',
  effort: 'none',
  web: false,
  history: [], // { role, content }
  duoModel: null, // explicit second model for /duo; null = auto (opposite family)
  proxyUrl: '', // set from --proxy or PROXY_URL; ALL duck.ai traffic goes through it (fail-closed)
  fetchFn: null, // built once in main() when proxyUrl is set
};

// ── engine noise filter: [duckai] console lines stay in the log file,
// not in the chat UI ──
const engineQuiet = (orig) => (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : '')).join(' ');
  if (s.includes('[duckai]')) return;
  orig(...a);
};
console.log = engineQuiet(console.log.bind(console));
console.warn = engineQuiet(console.warn.bind(console));
console.error = engineQuiet(console.error.bind(console));

const isTTY = process.stdout.isTTY;
const termCols = () => (process.stdout.columns || 100);
const paint = (code, s) => (isTTY && s ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => paint(2, s);
const bold = (s) => paint(1, s);
const yellow = (s) => paint('38;5;220', s);
const cyan = (s) => paint(36, s);

// ── rubber duck banner (braille pixel art, TTY only) ──
const DUCK_ART = [
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⡶⠿⠿⠷⣶⣄⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣰⡿⠁⠀⠀⢀⣀⡀⠙⣷⡀⠀⠀⠀',
  '⠀⠀⠀⡀⠀⠀⠀⠀⠀⢠⣿⠁⠀⠀⠀⠘⠿⠃⠀⢸⣿⣿⣿⣿',
  '⠀⣠⡿⠛⢷⣦⡀⠀⠀⠈⣿⡄⠀⠀⠀⠀⠀⠀⠀⣸⣿⣿⣿⠟',
  '⢰⡿⠁⠀⠀⠙⢿⣦⣤⣤⣼⣿⣄⠀⠀⠀⠀⠀⢴⡟⠛⠋⠁⠀',
  '⣿⠇⠀⠀⠀⠀⠀⠉⠉⠉⠉⠉⠁⠀⠀⠀⠀⠀⠈⣿⡀⠀⠀⠀',
  '⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢹⡇⠀⠀⠀',
  '⣿⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⡇⠀⠀⠀',
  '⠸⣷⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⡿⠀⠀⠀⠀',
  '⠀⠹⣷⣤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣰⡿⠁⠀⠀⠀⠀',
  '⠀⠀⠀⠉⠙⠛⠿⠶⣶⣶⣶⣶⣶⠶⠿⠟⠛⠉⠀⠀⠀⠀⠀⠀',
].join('\n');

const WHATS_NEW = [
  '/duo — two model families at once',
  '/duomodel — pin the second model',
  'Esc interrupts · typed lines queue up',
  'PROXY_URL — WARP / any proxy for a clean IP',
];

const STATE_FILE = path.join(os.homedir(), '.duck-cli.json');
function loadAppState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { turns: 0, models: [], lastUsed: 0 }; }
}
function saveAppState(st) {
  try { writeFileSync(STATE_FILE, JSON.stringify(st)); } catch (e) { /* cosmetic */ }
}
function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return Math.max(1, Math.round(d / 1000)) + 'm ago';
  if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
  return Math.round(d / 86400000) + 'd ago';
}

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const padV = (s, w) => s + ' '.repeat(Math.max(0, w - plain(s).length));

let rli = null; // active interactive readline (closed during the model picker)
function ensureRl() {
  if (!rli) rli = createInterface({ input: process.stdin, output: process.stdout });
  return rli;
}

// ── Claude Code style welcome: dashed box, duck on the left, activity on
// the right, plus a quack-bubble toggle animation on the art head row ──
async function renderWelcomeBox() {
  const cols = Math.min(termCols() - 2, 112);
  const art = DUCK_ART.split('\n');
  const lw = 44;
  const rw = Math.min(64, Math.max(24, cols - lw - 8));
  const st = loadAppState();
  const used = (st.models || []).slice(-2);

  const left = art.map((l) => yellow(l));
  left.push('');
  left.push(bold('Welcome back!'));
  left.push(dim('model: ') + state.model + (state.proxyUrl ? dim(' · proxy') : ''));
  left.push(dim('cwd: ' + process.cwd()));

  const right = [cyan('Recent activity')];
  if (st.turns) {
    right.push(relTime(st.lastUsed) + '   ' + st.turns + ' turns');
    if (used.length) right.push(dim(used.join(', ')));
    right.push(dim('… /stats-like numbers in the bot'));
  } else {
    right.push(dim('first run — say hi!'));
  }
  right.push('');
  right.push(cyan("What's new"));
  for (const t of WHATS_NEW) right.push(t);
  right.push(dim('… /help for more'));

  const inner = Math.max(left.length, right.length);
  while (left.length < inner) left.push('');
  while (right.length < inner) right.push('');

  const buildRow = (i, quack) => {
    let l;
    if (i === 0) l = quack ? yellow(art[0] + ' quack!') : yellow(art[0]);
    else l = left[i] || '';
    return '┊ ' + padV(l, lw) + '┊ ' + padV(right[i] || '', rw) + ' ┊';
  };
  const title = bold('duck.ai CLI v1.2.0');
  const rowsArr = [];
  rowsArr.push(dim('·─ ') + title + dim(' ' + '─'.repeat(Math.max(3, lw + rw + 6 - 22)) + '·'));
  for (let i = 0; i < inner; i++) rowsArr.push(buildRow(i, false));
  rowsArr.push(dim('·' + '─'.repeat(lw + rw + 8) + '·'));
  console.log(rowsArr.join('\n'));

  // quack toggle on the art head row (inner row index 0, above the beak)
  const k = 0;
  for (let t = 0; t < 4; t++) {
    await new Promise((r) => setTimeout(r, 430));
    const on = t % 2 === 0;
    process.stdout.write('\x1b[' + (inner + 2 - k) + 'A\r\x1b[2K' + buildRow(k, on) + '\x1b[' + (inner + 1 - k) + 'B\r');
  }
}

function banner() {
  if (!isTTY) return;
  const art = DUCK_ART.split('\n');
  const info = [
    bold('duck.ai CLI') + dim('  quack.'),
    dim('GPT-6 · Claude · Mistral · Gemma, free'),
    '',
    dim('model: ') + bold(state.model),
    state.proxyUrl ? dim('proxy: ') + redactProxyUrl(state.proxyUrl) : '',
    dim('/help commands · /exit quit'),
  ];
  for (let i = 0; i < Math.max(art.length, info.length); i++) {
    console.log(yellow((art[i] || '').padEnd(40)) + (info[i] || ''));
  }
  console.log();
}

// ── markdown → terminal ──
function stripCitations(s) {
  return String(s)
    .replace(/<citation\b[^>]*>[\s\S]*?<\/citation>/gi, '')
    .replace(/<citation\b[^>]*\/>/gi, '')
    .replace(/<\/?citation\b[^>]*>/gi, '');
}

function inlineMd(s, ansi) {
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => (ansi ? t : t + ' (' + u + ')'));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (m, t) => (ansi ? bold(t) : t));
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, (m, p, t) => p + (ansi ? paint(3, t) : t));
  s = s.replace(/`([^`\n]+)`/g, (m, t) => (ansi ? cyan(t) : t));
  return s;
}

// Render a markdown answer as terminal lines. ansi=false → clean plain text.
function renderMd(src, ansi) {
  const lines = stripCitations(src).replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  let inFence = false;
  let table = [];
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map((r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));
    const data = rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c) || c === ''));
    if (data.length) {
      const n = Math.max(...data.map((r) => r.length));
      const w = Array.from({ length: n }, (_, j) => Math.max(3, ...data.map((r) => (r[j] || '').length)));
      for (let r = 0; r < data.length; r++) {
        const cells = data[r].map((c, j) => (c + ' '.repeat(w[j] - c.length)));
        let row = '  ' + cells.join(ansi ? dim(' │ ') : ' | ');
        if (r === 0 && ansi) row = bold(row);
        out.push(row);
        if (r === 0) out.push('  ' + w.map((x) => '─'.repeat(x)).join(ansi ? dim('─┼─') : '-+-'));
      }
    }
    table = [];
  };
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (/^```/.test(t)) {
      flushTable();
      inFence = !inFence;
      if (ansi) out.push(dim(inFence ? '┌─ code' : '└─'));
      continue;
    }
    if (inFence) { out.push(ansi ? '│ ' + cyan(raw) : '  ' + raw); continue; }
    if (/^\s*\|.*\|\s*$/.test(raw) && raw.includes('|', 1)) { table.push(raw); continue; }
    flushTable();
    if (!t) { out.push(''); continue; }
    const hm = t.match(/^(#{1,6})\s+(.*)$/);
    if (hm) { out.push((ansi ? bold(paint(4, inlineMd(hm[2], ansi))) : inlineMd(hm[2], ansi))); continue; }
    if (/^(-{3,}|\*{3,})$/.test(t)) { out.push(ansi ? dim('────') : '────'); continue; }
    const q = t.match(/^&gt;\s?(.*)$|^>\s?(.*)$/);
    if (q) { out.push(ansi ? dim('│ ') + inlineMd(q[1] || q[2], ansi) : '> ' + inlineMd(q[1] || q[2], ansi)); continue; }
    const ul = t.match(/^[-*•]\s+(.*)$/);
    if (ul) { out.push('  ' + (ansi ? dim('• ') : '- ') + inlineMd(ul[1], ansi)); continue; }
    const ol = t.match(/^(\d+)[.)]\s+(.*)$/);
    if (ol) { out.push('  ' + dim(ol[1] + '.') + ' ' + inlineMd(ol[2], ansi)); continue; }
    out.push(inlineMd(raw, ansi));
  }
  flushTable();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// ── live stream block: exact line accounting for clean repaint ──
class LiveBlock {
  constructor() {
    this.rows = 0;
    this.col = 0;
  }
  write(s) {
    const cols = termCols();
    for (const ch of s) {
      if (ch === '\n') { this.rows++; this.col = 0; }
      else {
        this.col++;
        if (this.col >= cols) { this.rows++; this.col = 0; }
      }
    }
    process.stdout.write(s);
  }
  clear() {
    process.stdout.write((this.rows > 0 ? '\x1b[' + this.rows + 'A' : '') + '\r\x1b[0J');
  }
}

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function spinner(text) {
  if (!isTTY) return { stop: () => {} };
  let i = 0;
  const t0 = Date.now();
  const tick = () => {
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write('\r\x1b[0J' + dim(SPIN_FRAMES[i++ % SPIN_FRAMES.length] + ' ' + text + ' · ' + sec + 's'));
  };
  tick();
  const iv = setInterval(tick, 110);
  return { stop: () => { clearInterval(iv); process.stdout.write('\r\x1b[0J'); } };
}

// ── one chat turn with the full TTY experience ──
async function chatTurn(text) {
  const t0 = Date.now();
  let live = null;
  let stripTail = '';
  const rawParts = [];   // stripped deltas, so an Esc-interrupt keeps the partial
  const ac = new AbortController();
  let interrupted = false;
  const pending = [];    // lines typed while the answer streams (claude-code style queue)
  let queueBuffer = '';
  const spin = spinner('duck is thinking');

  // Raw input layer over the stream: Esc/Ctrl+C interrupts, typed characters
  // queue a follow-up message, Enter submits it right after this answer.
  // The interactive readline is closed for this window (close+resume is the
  // proven pattern from the model picker) and recreated in restoreInput().
  if (rli) { rli.close(); rli = null; process.stdin.resume(); }
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  const onKey = (s, k) => {
    if (!k) return;
    if (k.name === 'escape' || (k.ctrl && k.name === 'c')) { interrupted = true; ac.abort(); return; }
    if (k.name === 'backspace') { queueBuffer = queueBuffer.slice(0, -1); process.stdout.write('\b \b'); return; }
    if (k.name === 'return') {
      if (queueBuffer.trim()) { pending.push(queueBuffer.trim()); queueBuffer = ''; process.stdout.write('\n' + dim('  (queued)')); }
      return;
    }
    if (k.ctrl || k.meta) return;
    if (k.name === 'space') { queueBuffer += ' '; process.stdout.write(dim(' ')); return; }
    if (k.name && k.name.length > 1) return; // arrows, tab, function keys…
    if (s && s.length === 1) { queueBuffer += s; process.stdout.write(dim(s)); }
  };
  process.stdin.on('keypress', onKey);
  const restoreInput = () => {
    process.stdin.removeListener('keypress', onKey);
    process.stdin.setRawMode(wasRaw || false);
    ensureRl();
  };

  const stripStream = (chunk) => {
    let s = stripTail + chunk;
    stripTail = '';
    s = stripCitations(s);
    const open = s.lastIndexOf('<');
    if (open !== -1 && /<(\/?citation)?[a-z]*$/i.test(s.slice(open))) {
      stripTail = s.slice(open);
      s = s.slice(0, open);
    }
    return s;
  };

  let full = '';
  let failed = null;
  try {
    const out = await duckai.chat({
      model: state.model, effort: state.effort, webSearch: state.web,
      messages: buildMessages(text),
      fetchFn: state.fetchFn,
      signal: ac.signal,
      onDelta: (d) => {
        const s = stripStream(d);
        if (!s) return;
        rawParts.push(s);
        if (!live) { spin.stop(); live = new LiveBlock(); }
        live.write(s);
      },
    });
    spin.stop();
    full = String(typeof out === 'string' ? out : out && out.text || '') || rawParts.join('');
    const rendered = renderMd(full, isTTY);
    if (live) live.clear();
    if (rendered) console.log(rendered);
  } catch (e) {
    spin.stop();
    if (live) live.clear();
    failed = e;
    full = rawParts.join('');
    const msg = String((e && e.description) || (e && e.message) || e);
    if (/abort/i.test(msg) || interrupted) {
      const rendered = renderMd(full, isTTY);
      if (rendered) console.log(rendered);
      console.log(dim('· interrupted by Esc — partial answer above'));
    } else {
      if (full) console.log(renderMd(full, isTTY));
      console.log('chat failed: ' + msg.slice(0, 200));
      if (/429|limit/i.test(msg)) console.log(dim('duck.ai quota for this IP is spent — wait a few minutes or set a proxy'));
      if (/RESTRICTED/i.test(msg)) console.log(dim('this model is closed for anonymous use — /model to pick another'));
    }
  } finally {
    restoreInput();
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(dim('· ' + state.model + (state.web ? ' + web' : '') + (state.proxyUrl ? ' · proxy' : '') + (interrupted ? ' · interrupted' : '') + ' · ' + sec + 's'));
  if (full && !failed) {
    state.history.push({ role: 'user', content: text });
    state.history.push({ role: 'assistant', content: full.slice(0, 8000) });
    const st = loadAppState();
    st.turns = (st.turns || 0) + 1;
    st.models = [...new Set([state.model].concat(st.models || []))].slice(0, 4);
    st.lastUsed = Date.now();
    saveAppState(st);
  }
  // lines queued during the stream run right after the answer
  for (const q of pending) {
    console.log(dim('» ' + q));
    const stop = await handle(q);
    if (stop) process.exit(0);
  }
  return interrupted ? '' : full;
}

async function chatTurnPiped(text) {
  try {
    const out = await duckai.chat({
      model: state.model, effort: state.effort, webSearch: state.web,
      messages: buildMessages(text),
      fetchFn: state.fetchFn,
    });
    const full = String(typeof out === 'string' ? out : out && out.text || '');
    console.log(renderMd(full, false));
    return full;
  } catch (e) {
    console.log('chat failed: ' + String((e && e.description) || (e && e.message) || e).slice(0, 200));
    return '';
  }
}

const turn = () => (isTTY ? chatTurn : chatTurnPiped);

async function resolveModel(part) {
  const q = String(part || '').trim().toLowerCase();
  const ids = await freeModels();
  if (!q) return null;
  const exact = ids.find((id) => id.toLowerCase() === q || id.toLowerCase().endsWith('/' + q));
  if (exact) return exact;
  const partial = ids.filter((id) => id.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  return null;
}

async function freeModels() {
  if (modelsCache) return modelsCache;
  try {
    const list = (await duckai.getModels(state.fetchFn)).filter((m) => m && m.free !== false);
    modelsCache = list.length ? list.map((m) => m.id) : FALLBACK_MODELS;
  } catch (e) {
    modelsCache = FALLBACK_MODELS;
  }
  return modelsCache;
}
let modelsCache = null;

function buildMessages(text) {
  const system = {
    role: 'user',
    content: 'You are a helpful AI assistant in a terminal CLI. Today is ' +
      new Date().toISOString().slice(0, 10) +
      '. Answer in the same language the user writes in. Be concise by default. Markdown is fine.',
  };
  const hist = state.history.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, content: m.content }));
  return [system].concat(hist).concat([{ role: 'user', content: text }]);
}

function saveImage(b64) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'duck-' + Date.now() + '.jpg');
  writeFileSync(file, duckai.b64ToBytes(b64));
  return file;
}

const HELP = dim([
  '/model [id|part]  show the live model list or switch models',
  '/web [on|off]     toggle duck.ai WebSearch',
  '/effort           cycle reasoning effort: none → low → medium',
  '/img <prompt>     generate an image into ' + OUT_DIR,
  '/duo <question>   one question, two model families, two answers',
  '/duomodel [id|auto]  pick the second /duo model (auto = opposite family)',
  'Esc              interrupt the current answer · typed lines are queued',
  '/reset            clear conversation history',
  '/help             this list',
  '/exit             quit',
].join('\n'));

// ── interactive model picker: ↑/↓ + Enter, digits 1-9, Esc cancels ──
function pickModel(ids, preselect) {
  return new Promise((resolve) => {
    if (!isTTY || !process.stdin.isTTY || !process.stdin.setRawMode) return resolve(null);
    // KEY FIX: rl.pause() freezes the stdin data flow, so keypress events
    // never fire and the picker hangs (Ctrl+C then kills the CLI). Closing
    // detaches readline, but rl.close() also pauses stdin — resume() after
    // close() is what makes raw-mode keypresses flow (verified live).
    if (rli) { rli.close(); rli = null; process.stdin.resume(); }
    emitKeypressEvents(process.stdin);
    let sel = Math.max(0, ids.indexOf(preselect || state.model));
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);

    const render = (first) => {
      if (!first) process.stdout.write('\x1b[' + ids.length + 'A');
      process.stdout.write(ids.map((id, i) => {
        const cur = id === state.model;
        const line = dim((i + 1) + '. ') +
          (i === sel ? yellow(bold('› ' + id)) : dim('  ' + id + (cur ? ' (current)' : '')));
        return '\x1b[2K\r' + line;
      }).join('\n') + '\n');
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(wasRaw);
      ensureRl(); // recreate the interactive readline for the next turn
    };
    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }
      if (key.name === 'up') { sel = (sel - 1 + ids.length) % ids.length; render(false); }
      else if (key.name === 'down') { sel = (sel + 1) % ids.length; render(false); }
      else if (key.name === 'return') { cleanup(); resolve(ids[sel]); }
      else if (key.name === 'escape') { cleanup(); resolve(null); }
      else if (/^[1-9]$/.test(str)) {
        const idx = Number(str) - 1;
        if (idx < ids.length) { cleanup(); resolve(ids[idx]); }
      }
    };
    process.stdin.on('keypress', onKey);
    render(true);
  });
}

async function handle(line) {
  const text = line.trim();
  if (!text) return false;
  if (text === '/exit' || text === '/quit' || text === '/q') return true;

  if (text === '/help') { console.log(HELP); return false; }
  if (text === '/reset') { state.history = []; console.log(dim('history cleared')); return false; }
  if (text === '/effort') {
    state.effort = EFFORTS[(EFFORTS.indexOf(state.effort) + 1) % EFFORTS.length];
    console.log(dim('reasoning effort: ' + state.effort));
    return false;
  }
  if (text.startsWith('/web')) {
    const arg = text.slice(4).trim().toLowerCase();
    state.web = arg ? /^(on|1|true|yes)$/i.test(arg) : !state.web;
    console.log(dim('web search: ' + (state.web ? 'on' : 'off')));
    return false;
  }
  if (text.startsWith('/model')) {
    const part = text.slice(6).trim();
    if (!part && isTTY) {
      const ids = await freeModels();
      const picked = await pickModel(ids);
      if (picked) { state.model = picked; console.log(dim('model: ' + picked)); }
      return false;
    }
    if (!part) {
      const ids = await freeModels();
      console.log(ids.map((id) => (id === state.model ? bold('* ' + id) : dim('  ' + id))).join('\n'));
      return false;
    }
    if (/^\d+$/.test(part)) {
      const ids = await freeModels();
      const idx = Number(part) - 1;
      if (idx >= 0 && idx < ids.length) { state.model = ids[idx]; console.log(dim('model: ' + state.model)); }
      else console.log(dim('no such number — /model shows the list'));
      return false;
    }
    const id = await resolveModel(part);
    if (!id) console.log(dim('no model matches "' + part + '" — /model shows the list'));
    else { state.model = id; console.log(dim('model: ' + id)); }
    return false;
  }
  if (text.startsWith('/img')) {
    const prompt = text.slice(4).trim();
    if (!prompt) { console.log(dim('usage: /img <prompt>')); return false; }
    const spin = spinner('duck is drawing');
    try {
      const out = await duckai.chat({
        model: state.model, effort: 'none', webSearch: false, image: true,
        messages: buildMessages(prompt),
        fetchFn: state.fetchFn,
      });
      spin.stop();
      const img = out && typeof out === 'object' ? out.image : null;
      if (!img) { console.log(dim('the model did not return an image this time')); return false; }
      const file = saveImage(img.b64);
      console.log('saved: ' + file + (out.text ? '\n' + dim(String(out.text).slice(0, 300)) : ''));
    } catch (e) {
      spin.stop();
      console.log('image failed: ' + ((e && e.message) || e));
    }
    return false;
  }

  if (text.startsWith('/duomodel')) {
    const part = text.slice(9).trim();
    if (part === 'auto' || part === 'off') {
      state.duoModel = null;
      console.log(dim('duo partner: auto (opposite family)'));
      return false;
    }
    if (!part && isTTY) {
      const ids = await freeModels();
      const picked = await pickModel(ids, state.duoModel);
      if (picked) { state.duoModel = picked; console.log(dim('duo partner: ' + picked)); }
      return false;
    }
    if (!part) {
      console.log(dim('duo partner: ' + (state.duoModel || 'auto (opposite family)')));
      const ids = await freeModels();
      console.log(ids.map((id) => (id === state.duoModel ? bold('* ' + id) : dim('  ' + id))).join('\n'));
      return false;
    }
    if (/^\d+$/.test(part)) {
      const ids = await freeModels();
      const idx = Number(part) - 1;
      if (idx >= 0 && idx < ids.length) { state.duoModel = ids[idx]; console.log(dim('duo partner: ' + state.duoModel)); }
      else console.log(dim('no such number — /duomodel shows the list'));
      return false;
    }
    const id = await resolveModel(part);
    if (!id) console.log(dim('no model matches "' + part + '" — /duomodel shows the list'));
    else { state.duoModel = id; console.log(dim('duo partner: ' + id)); }
    return false;
  }
  if (text.startsWith('/duo')) {
    const q = text.slice(4).trim();
    if (q.length < 2) { console.log(dim('usage: /duo <question> — one question, two model families, two answers')); return false; }
    const ids = await freeModels();
    const isClaude = /claude/.test(state.model);
    const m1 = ids.includes(state.model) ? state.model : state.model;
    // second model: explicit /duomodel choice first, then auto opposite family
    let m2 = (state.duoModel && ids.includes(state.duoModel) && state.duoModel !== m1) ? state.duoModel : null;
    if (!m2) m2 = ids.find((id) => id.startsWith(isClaude ? 'gpt-6' : 'claude')) || null;
    if (!m2 || m2 === m1) m2 = (isClaude ? FALLBACK_MODELS[0] : FALLBACK_MODELS[2]);
    console.log(dim('asking two AIs: ' + m1 + ' + ' + m2));
    const t0 = Date.now();
    const ask = (model) => duckai.chat({
      model, effort: state.effort, webSearch: state.web,
      messages: buildMessages(q), fetchFn: state.fetchFn,
    });
    const results = await Promise.allSettled([ask(m1), ask(m2)]);
    [m1, m2].forEach((id, i) => {
      console.log(dim('── ') + bold(id) + dim(' ──'));
      const r = results[i];
      if (r.status === 'fulfilled') {
        const full = String(typeof r.value === 'string' ? r.value : r.value && r.value.text || '');
        console.log(renderMd(full, isTTY) || dim('(empty)'));
      } else {
        console.log('failed: ' + String((r.reason && r.reason.message) || r.reason).slice(0, 160));
      }
      console.log('');
    });
    console.log(dim('· duo · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's · 2 model calls'));
    if (results.some((r) => r.status === 'rejected' && /429/.test(String((r.reason && r.reason.message) || r.reason)))) {
      console.log(dim('duck.ai rate limit hit for this IP — it resets in a few minutes, or use --proxy / PROXY_URL'));
    }
    return false;
  }

  // unknown slash commands never reach the model
  if (text.startsWith('/')) {
    console.log(dim('unknown command: ' + text.split(/\s+/)[0] + ' — /help'));
    return false;
  }
  const full = await turn()(text);
  return false;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model' && argv[i + 1]) { state.model = argv[++i]; }
    else if (argv[i] === '--web') { state.web = true; }
    else if (argv[i] === '--proxy' && argv[i + 1]) { state.proxyUrl = argv[++i]; }
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: node cli.js [--model <id|part>] [--web] [--proxy <http|socks5 url>]');
      process.exit(0);
    }
  }
  if (!state.proxyUrl && process.env.PROXY_URL) state.proxyUrl = process.env.PROXY_URL;
}

async function main() {
  parseArgs();
  if (state.proxyUrl) {
    // Fail-closed: every duck.ai request goes through this proxy and proxy
    // errors fail the request — there is no direct-connection fallback.
    state.fetchFn = await makeProxiedFetch(state.proxyUrl);
  }
  if (isTTY) await renderWelcomeBox(); else banner();
  if (!isTTY) {
    // piped mode: scripted testing. Lines are processed strictly one by one
    // (a promise chain). EOF must not kill anything: exit happens only when
    // every received line has been processed (or /exit was typed).
    const rl = createInterface({ input: process.stdin, terminal: false });
    let chain = Promise.resolve();
    let stdinEnded = false;
    let queued = 0;
    let processed = 0;
    rl.on('line', (l) => {
      queued++;
      chain = chain
        .then(() => handle(l))
        .then((stop) => {
          processed++;
          if (stop) process.exit(0);
          if (stdinEnded && processed >= queued) process.exit(0);
        })
        .catch((e) => { processed++; console.log('error: ' + ((e && e.message) || e)); });
    });
    rl.on('close', () => { stdinEnded = true; if (processed >= queued) process.exit(0); });
    return;
  }
  const ask = () => {
    const rl = ensureRl();
    rl.question(dim('you › '), async (line) => {
      const stop = await handle(line);
      if (stop) { rl.close(); process.exit(0); }
      ask();
    });
  };
  ask();
}

main().catch((e) => { console.error('fatal:', (e && e.message) || e); process.exit(1); });
