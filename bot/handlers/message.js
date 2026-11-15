// Main handler: commands + AI chat (text and photos) via duck.ai.
import { api, db, fetch as sdkFetch, InputFile } from 'sdk';
import { eq, desc, and, lt } from 'sdk/db';
import { chats, messages, config, statsDaily } from '../schema.js';
import { chat as duckChat, bytesToBase64, b64ToBytes } from '../lib/duckai.js';
import { sniffImageMime, jpegToPngDataUrl } from '../lib/imgconv.js';
import { StreamReply, escHtml, friendlyError, mainKeyboard, cleanText } from '../lib/reply.js';
import {
  getChatRow, listModels, modelName, effortInline, modelsInline, renderSettings,
  refreshReplyKeyboard, EFFORTS, EFFORT_LABELS,
} from '../lib/settings.js';
import {
  touchUser, normalizeSource, bumpDaily, bumpModel, isAdmin, renderStats, makeDuckStats,
} from '../lib/metrics.js';
import { maybeRunOneShotSetup } from '../lib/botsetup.js';

const HISTORY_LIMIT = 12;  // messages sent to the model as context
const KEEP_LIMIT = 60;     // history rows kept in the DB per chat

// /img: duck.ai's GenerateImage tool rides on a GPT chat model. Overrides via
// the config table: 'img_model' (model id), 'img_daily_limit' (per user/day),
// 'img_enabled' ('false' kills the feature without a redeploy).
const IMG_MODEL_DEFAULT = 'gpt-6-luna';
const IMG_DAILY_LIMIT = 3;

const ALIASES = {
  gpt: 'gpt-6-luna', gpt6: 'gpt-6-luna', luna: 'gpt-6-luna',
  mini: 'gpt-5.4-mini', gptmini: 'gpt-5.4-mini', '5.4': 'gpt-5.4-mini',
  claude: 'claude-haiku-4-5', haiku: 'claude-haiku-4-5',
  mistral: 'mistral-small-2603',
  oss: 'tinfoil/gpt-oss-120b',
  gemma: 'tinfoil/gemma4-31b',
};

const START = 'Привет! Я AI-бот на Serverless Телеграма 🚀\n\n' +
  'Работаю прямо в облаке Telegram — без серверов, модели через duck.ai: GPT-6 Luna, GPT-5.4 mini, Claude Haiku, Mistral и другие (бесплатные).\n\n' +
  'Просто пиши — отвечу, ответы стримятся в живую. Можно кидать фото.\n' +
  'Управление — кнопками меню под полем ввода и командами: /help';

const HELP = [
  '🤖 <b>AI-бот на Telegram Serverless</b> — работает прямо в облаке Телеграма, модели через duck.ai.',
  '',
  '<b>Кнопки меню</b> (под полем ввода):',
  '🤖 Модели — выбрать модель (кнопками)',
  '⚙️ Статус — настройки с быстрыми кнопками',
  '🌐 Поиск — вкл/выкл веб-поиск',
  '🧠 Размышления — выбрать уровень (◉ кнопками)',
  '🎛 Настройки — Mini App в стиле Телеграма',
  '🧹 Очистить историю — сброс диалога',
  '',
  '<b>Команды:</b>',
  '/img <описание> — 🎨 нарисовать картинку (GPT Image 2)',
  '/models — выбрать модель (кнопками)',
  '/model &lt;имя&gt; — выбрать модель текстом (например: <code>/model claude</code>)',
  '/effort — выбрать «размышления» кнопками',
  '/effort none|low|medium — задать напрямую',
  '/web — включить/выключить веб-поиск у модели',
  '/reset — очистить историю диалога',
  '/settings — настройки',
  '/stats — статистика бота (только для владельца)',
  '/duo <вопрос> — 🎯 мнение двух ИИ сразу (GPT + Claude, как 2nd Opinion в duck.ai)',
  '/duomodel <имя|auto> — выбрать вторую модель для /duo',
  '',
  'Просто пиши текст — ответ стримится в живую. Можно кидать <b>фото</b> (с подписью или без).',
  'Картинки — <code>/img утёнок-космонавт</code> 🎨',
  'Алиасы моделей: gpt, mini, claude, mistral, oss, gemma.',
].join('\n');

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
async function pruneHistory(chatId) {
  const over = await db.select({ id: messages.id }).from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.id))
    .limit(1).offset(KEEP_LIMIT).all();
  if (over.length > 0) {
    await db.delete(messages).where(and(eq(messages.chatId, chatId), lt(messages.id, over[0].id + 1))).run();
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdModels(chatId, currentModel) {
  const models = await listModels(sdkFetch);
  await api.sendMessage({
    chat_id: chatId,
    text: '🤖 Выбери модель (🔒 — тариф duck.ai Plus/Pro):',
    reply_markup: modelsInline(models, currentModel),
  });
}

async function cmdModel(chatId, row, arg) {
  const raw = (arg || '').trim().toLowerCase().replace(/^tinfoil\//, '');
  if (!raw) {
    await api.sendMessage({ chat_id: chatId, text: 'Укажи модель: /model claude (или gpt, mini, mistral, oss, gemma, или полный id)' });
    return;
  }
  let id = ALIASES[raw] || null;
  if (!id) {
    // try full id (with or without tinfoil/ prefix)
    try {
      const models = await listModels(sdkFetch);
      const found = models.find((m) => m.id.toLowerCase() === raw || m.id.toLowerCase().endsWith('/' + raw));
      id = found ? found.id : null;
    } catch (e) { id = null; }
  }
  if (!id) {
    await api.sendMessage({ chat_id: chatId, text: 'Не знаю модель «' + escHtml(arg) + '». Глянь список: /models' });
    return;
  }
  await db.update(chats).set({ model: id }).where(eq(chats.chatId, chatId)).run();
  const updated = Object.assign({}, row, { model: id });
  await api.sendMessage({
    chat_id: chatId,
    text: '✅ Модель: <b>' + escHtml(modelName(id)) + '</b>',
    parse_mode: 'HTML',
    reply_markup: mainKeyboard(updated),
  });
}

// /effort — no arg: inline radio picker; with arg: set directly.
async function cmdEffort(chatId, row, arg) {
  const v = (arg || '').trim().toLowerCase();
  if (!v) {
    await api.sendMessage({
      chat_id: chatId,
      text: '🧠 <b>Размышления</b> — выбери уровень:',
      parse_mode: 'HTML',
      reply_markup: effortInline(row.effort),
    });
    return;
  }
  if (!EFFORTS.includes(v)) {
    await api.sendMessage({ chat_id: chatId, text: 'Использование: /effort none|low|medium (или просто /effort — выберу кнопками)' });
    return;
  }
  await db.update(chats).set({ effort: v }).where(eq(chats.chatId, chatId)).run();
  const updated = Object.assign({}, row, { effort: v });
  await api.sendMessage({
    chat_id: chatId,
    text: '🧠 Размышления: <b>' + EFFORT_LABELS[v] + '</b>',
    parse_mode: 'HTML',
    reply_markup: mainKeyboard(updated),
  });
}

async function cmdWeb(chatId, row) {
  const next = !row.webSearch;
  await db.update(chats).set({ webSearch: next }).where(eq(chats.chatId, chatId)).run();
  await api.sendMessage({
    chat_id: chatId,
    text: next ? '🌐 Веб-поиск у модели: <b>включён</b>' : '🌐 Веб-поиск у модели: <b>выключен</b>',
    parse_mode: 'HTML',
    reply_markup: mainKeyboard(Object.assign({}, row, { webSearch: next })),
  });
}

async function cmdReset(chatId, row) {
  await db.delete(messages).where(eq(messages.chatId, chatId)).run();
  await api.sendMessage({ chat_id: chatId, text: '🧹 История диалога очищена.', reply_markup: mainKeyboard(row) });
}

async function cmdSettings(chatId) {
  const s = await renderSettings(chatId, sdkFetch);
  await api.sendMessage({
    chat_id: chatId,
    text: s.text,
    parse_mode: 'HTML',
    reply_markup: s.keyboard,
  });
}

async function cmdStats(chatId, from) {
  const ok = await isAdmin(from && from.id);
  if (!ok) {
    await api.sendMessage({
      chat_id: chatId,
      text: '🔒 Статистика доступна только владельцу бота.\n' +
        'Твой Telegram ID: <code>' + (from ? from.id : '?') + '</code>',
      parse_mode: 'HTML',
    });
    return;
  }
  const s = await renderStats();
  await api.sendMessage({ chat_id: chatId, text: s, parse_mode: 'HTML' });
}

// ---------------------------------------------------------------------------
// /duo — "2nd Opinion": one question, two model families, two answers.
// duck.ai ships this in its own web UI (the "2nd Opinion" button); here it
// is two parallel chat() calls. Both share one challenge token (single-
// flight in getToken) and do NOT touch the conversation history: the duo
// round is a side-channel, the main chat stays clean.
// ---------------------------------------------------------------------------
async function cmdDuo(msg, row, uid, arg) {
  const chatId = msg.chat.id;
  const q = (arg || '').trim();
  if (q.length < 2) {
    await api.sendMessage({
      chat_id: chatId,
      text: '🎯 Мнение двух ИИ: задай вопрос после команды.\n<code>/duo Чем мыть газовую плиту?</code>',
      parse_mode: 'HTML',
    });
    return;
  }

  // Pair: the chat's model + the opposite family. A per-chat /duomodel
  // choice (config kv) overrides the auto pick; everything is resolved
  // against the live list so a duck.ai rename (haiku 4.5 → 5.5) doesn't
  // break the feature.
  let duoCfg = null;
  try {
    const r = await db.select().from(config).where(eq(config.key, 'duo_model:' + chatId)).get();
    duoCfg = (r && r.value) || null;
  } catch (e) { /* config must never break the bot */ }
  const isClaude = /claude/.test(row.model);
  const family = isClaude ? 'gpt-6' : 'claude';
  let pair = [row.model, null];
  try {
    const ids = (await listModels(sdkFetch)).filter((m) => m && m.free !== false).map((m) => m.id);
    if (!ids.includes(pair[0])) pair[0] = ids.find((id) => id.startsWith(isClaude ? 'claude' : 'gpt-6')) || pair[0];
    pair[1] = (duoCfg && ids.includes(duoCfg) && duoCfg !== pair[0])
      ? duoCfg
      : ids.find((id) => id.startsWith(family)) || null;
  } catch (e) { /* live list unreachable — fallback ids below */ }
  if (!pair[0]) pair[0] = isClaude ? 'claude-haiku-5-5' : 'gpt-6-luna';
  if (!pair[1]) pair[1] = isClaude ? 'gpt-6-luna' : 'claude-haiku-5-5';

  // Same context as a normal chat turn, but the question itself is not
  // saved: history stays as-is, both models see the same payload.
  const history = (await db.select({ role: messages.role, content: messages.content }).from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.id))
    .limit(HISTORY_LIMIT).all()).reverse();
  const payload = buildMessages(history.concat([{ role: 'user', content: q }]), [{ type: 'text', text: q }]);

  await api.sendMessage({
    chat_id: chatId,
    text: '🎯 Спрашиваю два ИИ: <b>' + escHtml(modelName(pair[0])) + '</b> и <b>' + escHtml(modelName(pair[1])) + '</b>',
    parse_mode: 'HTML',
  });
  api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});

  // Two streams in parallel, one quota hit for the challenge (single-flight).
  const r1 = new StreamReply(chatId);
  const r2 = new StreamReply(chatId);
  const runOne = async (model, reply) => {
    try {
      const out = await duckChat({
        model, effort: row.effort, webSearch: row.webSearch,
        messages: payload,
        fetchFn: sdkFetch, store: duckStore, stats: makeDuckStats(),
        onDelta: (d, f) => reply.push(d, f),
      });
      const full = typeof out === 'string' ? out : (out && out.text) || '';
      await reply.finish(full, '🎯 ' + modelName(model));
      if (uid) { await bumpDaily(uid, 'msgsOut'); await bumpModel(uid, model); }
    } catch (e) {
      console.error('[duo]', model, 'failed:', e);
      if (uid) await bumpDaily(uid, 'errors');
      await reply.fail(e);
    }
  };
  await Promise.all([runOne(pair[0], r1), runOne(pair[1], r2)]);
}

// /duomodel <имя|auto> — фиксирует вторую модель для /duo (config kv,
// без миграций). auto / без аргумента с "auto" — вернуть авто-подбор.
async function cmdDuoModel(chatId, arg) {
  const raw = (arg || '').trim().toLowerCase().replace(/^tinfoil\//, '');
  if (!raw || raw === 'auto') {
    await db.delete(config).where(eq(config.key, 'duo_model:' + chatId)).run();
    await api.sendMessage({ chat_id: chatId, text: '🎯 Вторая модель /duo: <b>авто</b> (противоположное семейство)', parse_mode: 'HTML' });
    return;
  }
  let id = ALIASES[raw] || null;
  if (!id) {
    try {
      const models = await listModels(sdkFetch);
      const found = models.find((m) => m.id.toLowerCase() === raw || m.id.toLowerCase().endsWith('/' + raw));
      id = found ? found.id : null;
    } catch (e) { id = null; }
  }
  if (!id) {
    await api.sendMessage({ chat_id: chatId, text: 'Не знаю модель «' + escHtml(arg) + '». Глянь список: /models (сброс: <code>/duomodel auto</code>)' });
    return;
  }
  await db.delete(config).where(eq(config.key, 'duo_model:' + chatId)).run();
  await db.insert(config).values({ key: 'duo_model:' + chatId, value: id }).run();
  await api.sendMessage({
    chat_id: chatId,
    text: '🎯 Вторая модель /duo: <b>' + escHtml(modelName(id)) + '</b> (сбросить: <code>/duomodel auto</code>)',
    parse_mode: 'HTML',
  });
}

// ---------------------------------------------------------------------------
// /img — GenerateImage (GPT Image 2 via duck.ai)
// ---------------------------------------------------------------------------
async function imgConfig(key, fallback) {
  try {
    const r = await db.select().from(config).where(eq(config.key, key)).get();
    if (r && r.value !== null && r.value !== undefined && r.value !== '') return r.value;
  } catch (e) { /* config must never break the bot */ }
  return fallback;
}

async function imgUsedToday(uid) {
  if (!uid) return 0;
  try {
    const row = await db.select({ imgs: statsDaily.imgs }).from(statsDaily)
      .where(and(eq(statsDaily.day, todayStr()), eq(statsDaily.userId, uid))).get();
    return (row && row.imgs) || 0;
  } catch (e) { return 0; }
}

// Send a generated image (b64 jpeg) to a chat; counts metrics.
async function deliverImage(chatId, img, caption, uid) {
  const bytes = b64ToBytes(img.b64);
  await api.sendPhoto({
    chat_id: chatId,
    photo: new InputFile(bytes, 'img.jpg', { type: 'image/jpeg' }),
    caption: String(caption || '').slice(0, 1000) || undefined,
  });
  makeDuckStats().bump('duck_imgs');
  if (uid) await bumpDaily(uid, 'imgs');
}

async function cmdImg(msg, row, uid, arg) {
  const chatId = msg.chat.id;
  const prompt = (arg || '').trim();
  if (prompt.length < 2) {
    await api.sendMessage({
      chat_id: chatId,
      text: '🎨 Опиши, что нарисовать:\n<code>/img утёнок-космонавт в открытом космосе</code>',
      parse_mode: 'HTML',
    });
    return;
  }

  const enabled = await imgConfig('img_enabled', 'true');
  if (enabled === 'false') {
    await api.sendMessage({ chat_id: chatId, text: '🎨 Генерация картинок сейчас выключена.' });
    return;
  }

  // Quota: duck.ai's free image allowance is shared by the whole isolate,
  // so keep per-user daily caps (groups count as one "user").
  const limit = parseInt(await imgConfig('img_daily_limit', String(IMG_DAILY_LIMIT)), 10) || IMG_DAILY_LIMIT;
  const used = await imgUsedToday(uid);
  if (used >= limit) {
    await api.sendMessage({
      chat_id: chatId,
      text: '🎨 Дневной лимит картинок исчерпан (' + used + '/' + limit + ').\nОбнулится в 00:00 UTC.',
    });
    return;
  }

  const model = await imgConfig('img_model', IMG_MODEL_DEFAULT);
  const progress = await api.sendMessage({
    chat_id: chatId,
    text: '🎨 Рисую: ' + escHtml(prompt.slice(0, 200)) + (prompt.length > 200 ? '…' : ''),
  });
  const progressId = progress && progress.message_id;
  api.sendChatAction({ chat_id: chatId, action: 'upload_photo' }).catch(() => {});

  let previewMsgId = null;
  let chain = Promise.resolve(); // serialize the async UI updates from stream callbacks

  try {
    const out = await duckChat({
      model,
      effort: 'none',
      webSearch: false,
      image: true,
      messages: [{ role: 'user', content: prompt }],
      fetchFn: sdkFetch,
      store: duckStore,
      stats: makeDuckStats(),
      onImageEvent: (ev) => {
        chain = chain.then(async () => {
          if (ev.type === 'title' && progressId) {
            try {
              await api.editMessageText({ chat_id: chatId, message_id: progressId, text: '🎨 ' + escHtml(ev.title) + '…' });
            } catch (e) { /* "not modified" / throttled — cosmetic */ }
          } else if (ev.type === 'preview' && !previewMsgId && ev.b64) {
            try {
              const m = await api.sendPhoto({
                chat_id: chatId,
                photo: new InputFile(b64ToBytes(ev.b64), 'preview.jpg', { type: 'image/jpeg' }),
                caption: '⚡️ Черновик — финальная версия через пару секунд…',
              });
              previewMsgId = m.message_id;
            } catch (e) { /* preview is cosmetic */ }
          }
        }).catch(() => {});
      },
    });

    const img = (out && typeof out === 'object') ? out.image : null;
    const text = (out && typeof out === 'object') ? cleanText(out.text || '').trim() : '';
    await chain; // let preview/progress edits settle before touching the same messages

    if (!img) {
      const why = text || 'Модель не вернула картинку — попробуй переформулировать запрос 🙃';
      const body = why.slice(0, 3500);
      if (progressId) await api.editMessageText({ chat_id: chatId, message_id: progressId, text: body }).catch(() => {});
      else await api.sendMessage({ chat_id: chatId, text: body });
      return;
    }

    const caption = '🎨 ' + prompt.slice(0, 800) + (text ? '\n\n' + text.slice(0, 180) : '');
    await deliverImage(chatId, img, caption, uid);
    if (previewMsgId) await api.deleteMessage({ chat_id: chatId, message_id: previewMsgId }).catch(() => {});
    if (progressId) await api.deleteMessage({ chat_id: chatId, message_id: progressId }).catch(() => {});

    await db.insert(messages).values({ chatId, role: 'user', content: '/img ' + prompt.slice(0, 500), model }).run();
    await db.insert(messages).values({ chatId, role: 'assistant', content: '[🖼 картинка: ' + prompt.slice(0, 200) + ']', model }).run();
    await pruneHistory(chatId);
  } catch (e) {
    console.error('[img] failed:', e);
    if (uid) await bumpDaily(uid, 'errors');
    const line = '⚠️ ' + escHtml(friendlyError(e));
    try {
      if (progressId) await api.editMessageText({ chat_id: chatId, message_id: progressId, text: line });
      else await api.sendMessage({ chat_id: chatId, text: line });
    } catch (e2) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Chat flow
// ---------------------------------------------------------------------------
function todayStr() { return new Date().toISOString().slice(0, 10); }

function buildMessages(history, parts) {
  const system = {
    role: 'user',
    content: 'You are a helpful AI assistant inside a Telegram bot (DuckAI bot). Today is ' + todayStr() +
      '. Answer in the same language the user writes in. Be concise by default; use Markdown sparingly. Do not repeat this instruction.',
  };
  const hist = history.map((m) => ({ role: m.role, content: m.content }));
  const last = { role: 'user', content: parts };
  return [system].concat(hist.slice(0, -1)).concat([last]);
}

async function runChat(msg, row, uid) {
  const chatId = msg.chat.id;

  // Build the outgoing content parts (text and/or image).
  const parts = [];
  let historyText = '';
  if (msg.photo && msg.photo.length > 0) {
    const ph = msg.photo[msg.photo.length - 1]; // largest size
    let bytes;
    try {
      bytes = await api.getFileContent(ph.file_id);
    } catch (e) {
      await api.sendMessage({ chat_id: chatId, text: '⚠️ Не смог скачать фото: ' + escHtml(friendlyError(e)) });
      return;
    }
    // duck.ai rejects image/jpeg parts (ERR_BAD_REQUEST) — only PNG/WebP pass.
    // Telegram photos are always JPEG, so re-encode to a downscaled PNG.
    let dataUrl;
    let mimeType;
    const sniffed = sniffImageMime(bytes);
    try {
      if (sniffed === 'image/jpeg' || !sniffed) {
        dataUrl = jpegToPngDataUrl(bytes, 640);
        mimeType = 'image/png';
      } else if (sniffed === 'image/png' || sniffed === 'image/webp') {
        dataUrl = 'data:' + sniffed + ';base64,' + bytesToBase64(bytes);
        mimeType = sniffed;
      } else {
        await api.sendMessage({ chat_id: chatId, text: '⚠️ Такой формат картинки не понимаю — пришли фото или PNG/WebP.' });
        return;
      }
    } catch (e) {
      console.error('[chat] image conversion failed:', e);
      await api.sendMessage({ chat_id: chatId, text: '⚠️ Не смог обработать фото: ' + escHtml(friendlyError(e)) });
      return;
    }
    parts.push({ type: 'image', image: dataUrl, mimeType });
    historyText = '[фото] ';
  }
  const caption = (msg.caption || msg.text || '').trim();
  if (caption) {
    parts.push({ type: 'text', text: caption });
    historyText += caption;
  }
  if (parts.length === 0) {
    await api.sendMessage({ chat_id: chatId, text: 'Пришли текст или фото 🙃' });
    return;
  }

  // Save the user message, then load history (including it).
  await db.insert(messages).values({ chatId, role: 'user', content: historyText, model: row.model }).run();
  if (uid) { await bumpDaily(uid, 'msgsIn'); await bumpModel(uid, row.model); }
  const history = (await db.select({ role: messages.role, content: messages.content }).from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.id))
    .limit(HISTORY_LIMIT).all()).reverse();

  const payload = buildMessages(history, parts);

  const reply = new StreamReply(chatId);
  try {
    const out = await duckChat({
      model: row.model,
      effort: row.effort,
      webSearch: row.webSearch,
      messages: payload,
      fetchFn: sdkFetch,
      store: duckStore,
      stats: makeDuckStats(),
      onDelta: (d, f) => reply.push(d, f),
    });
    // chat() returns a plain string for text-only turns, or { text, image }
    // when the model invoked its GenerateImage tool ("нарисуй ..." in chat).
    const full = typeof out === 'string' ? out : (out && out.text) || '';
    const img = (out && typeof out === 'object' && out.image) ? out.image : null;
    const note = row.webSearch ? '🔎 модель ' + row.model + ' (с веб-поиском)' : null;
    await reply.finish(full, note);
    if (img) {
      try {
        await deliverImage(chatId, img, '🎨 ' + (cleanText(full) || 'Картинка готова'), uid);
      } catch (e) { console.error('[chat] image delivery failed:', e); }
    }
    if (uid) await bumpDaily(uid, 'msgsOut');
    await db.insert(messages).values({ chatId, role: 'assistant', content: cleanText(full) || '(пустой ответ)', model: row.model }).run();
    await pruneHistory(chatId);
  } catch (e) {
    console.error('[chat] failed:', e);
    if (uid) await bumpDaily(uid, 'errors');
    await reply.fail(e);
  }
}

// L2 store for duckai.js: the solved challenge token and frontend metadata
// live in the `config` table, so they survive isolate restarts — the bot
// bothers duck.ai's challenge endpoint far less often (fewer 418/429).
const duckStore = {
  async get(key) {
    const row = await db.select().from(config).where(eq(config.key, key)).get();
    return row ? row.value : null;
  },
  async set(key, value) {
    await db.delete(config).where(eq(config.key, key)).run();
    if (value != null) await db.insert(config).values({ key, value }).run();
  },
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export default async function (msg) {
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';

  const text = msg.text || msg.caption || '';

  // In groups: only commands (Telegram's privacy mode filters the rest anyway).
  const isCommand = text.startsWith('/');
  if (!isPrivate && !isCommand) return;

  // One-shot bot setup (registers /stats in the command menu after deploys).
  await maybeRunOneShotSetup();

  // Metrics: register the user and how they arrived (deep-link /start payload
  // becomes a source tag; groups are tracked with negative ids).
  let uid = null;
  try {
    if (isPrivate) {
      const sm = isCommand ? text.match(/^\/start(?:@[A-Za-z0-9_]+)?\s*([\s\S]*)$/) : null;
      const src = sm && sm[1] && sm[1].trim() ? normalizeSource(sm[1]) : undefined;
      uid = await touchUser(msg.from, { source: src });
    } else if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
      uid = await touchUser(msg.from, { isGroup: true, chatId, title: msg.chat.title, source: 'group' });
    }
  } catch (e) { /* metrics must never break the bot */ }

  const row = await getChatRow(chatId);

  // Reply-keyboard menu buttons arrive as plain text messages.
  if (isPrivate && msg.text) {
    if (text === '🤖 Модели') { await cmdModels(chatId, row.model); return; }
    if (text === '⚙️ Статус') { await cmdSettings(chatId); return; }
    if (text.startsWith('🌐 Поиск')) { await cmdWeb(chatId, row); return; }
    if (text.startsWith('🧠 Размышления')) { await cmdEffort(chatId, row, ''); return; }
    if (text === '🧹 Очистить историю') { await cmdReset(chatId, row); return; }
  }

  if (isCommand) {
    const m = text.match(/^\/([a-zA-Z_]+)(@[A-Za-z0-9_]+)?\s*([\s\S]*)$/);
    const cmd = m ? m[1].toLowerCase() : '';
    const arg = m ? m[3].trim() : '';
    switch (cmd) {
      case 'start':
        await api.sendMessage({ chat_id: chatId, text: START, reply_markup: mainKeyboard(row) });
        break;
      case 'help':
        await api.sendMessage({ chat_id: chatId, text: HELP, parse_mode: 'HTML', reply_markup: mainKeyboard(row) });
        break;
      case 'img':
        await cmdImg(msg, row, uid, arg);
        break;
      case 'models':
        await cmdModels(chatId, row.model);
        break;
      case 'model':
        await cmdModel(chatId, row, arg);
        break;
      case 'effort':
        await cmdEffort(chatId, row, arg);
        break;
      case 'web':
        await cmdWeb(chatId, row);
        break;
      case 'reset':
        await cmdReset(chatId, row);
        break;
      case 'settings':
        await cmdSettings(chatId);
        break;
      case 'stats':
        await cmdStats(chatId, msg.from);
        break;
      case 'duo':
        await cmdDuo(msg, row, uid, arg);
        break;
      case 'duomodel':
        await cmdDuoModel(chatId, arg);
        break;
      default:
        await api.sendMessage({ chat_id: chatId, text: 'Не знаю такую команду — /help' });
    }
    return;
  }

  // Regular message → chat. Ignore non-text/non-photo content.
  if (!msg.text && !msg.photo) {
    if (isPrivate) await api.sendMessage({ chat_id: chatId, text: 'Пока понимаю только текст и фото 🙂' });
    return;
  }
  await runChat(msg, row, uid);
}
