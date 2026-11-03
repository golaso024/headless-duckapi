// test/api.test.mjs — OpenAI-compatible API layer (api.js), no network needed:
// chat() and getModels() are injected as fakes, so duck.ai is never touched.
import path from 'node:path';
import assert from 'node:assert/strict';

const { startApiServer, resolveModel } = await import('../api.js');

// --- fakes --------------------------------------------------------------

const MODELS = [
  // list head is a "restricted flagship" — advertised by duck.ai but rejected
  // on chat. The default/alias resolution must NOT pick it; the chat layer
  // must fall back to the next family candidate when it errors.
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'openai', free: true, image: false, efforts: ['none', 'low', 'medium'] },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', provider: 'openai', free: true, image: true, efforts: ['none', 'low', 'medium'] },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic', free: true, image: false, efforts: ['none', 'low'] },
];

const chatCalls = [];
async function fakeChat(p) {
  chatCalls.push(JSON.parse(JSON.stringify({ ...p, onDelta: undefined, fetchFn: undefined, signal: undefined })));
  if (p.model === 'gpt-5.6-terra') {
    throw new Error('duck.ai chat HTTP 404: {"action":"error","status":404,"type":"ERR_MODEL_RESTRICTED"}');
  }
  if (p.image) {
    return { text: 'Here you go', image: { b64: Buffer.from('IMGDATA').toString('base64'), width: 8, height: 8, format: 'jpeg' } };
  }
  if (p.onDelta) { p.onDelta('Hello', 'Hello'); p.onDelta(' world', 'Hello world'); }
  return 'Hello world';
}

// --- resolveModel unit checks -------------------------------------------

assert.equal(resolveModel('claude-haiku-4-5', MODELS).id, 'claude-haiku-4-5');
assert.equal(resolveModel('CLAUDE-HAIKU-4-5', MODELS).id, 'claude-haiku-4-5'); // case-insensitive exact
assert.equal(resolveModel('', MODELS).id, 'gpt-5.4-mini'); // default = preferred, NOT the list head (terra)
// stale OpenAI ids from old clients must resolve to a current family member
assert.equal(resolveModel('gpt-4o-mini', MODELS).id, 'gpt-5.4-mini');
assert.equal(resolveModel('claude-3-haiku', MODELS).id, 'claude-haiku-4-5');
assert.equal(resolveModel('totally-unknown-model', MODELS), null);
console.log('  ✓ resolveModel: exact / case-insensitive / preferred default / stale-id aliases / unknown');

// --- server instances ----------------------------------------------------

const key = 'test-key-123';
const authServer = await startApiServer({ port: 0, apiKey: key, chat: fakeChat, listModels: async () => MODELS });
const openServer = await startApiServer({ port: 0, chat: fakeChat, listModels: async () => MODELS });
const AUTH = 'http://127.0.0.1:' + authServer.address().port;
const OPEN = 'http://127.0.0.1:' + openServer.address().port;

// --- /health -------------------------------------------------------------

{
  const r = await fetch(OPEN + '/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.mode, 'api');
  assert.deepEqual(j.endpoints, ['/v1/models', '/v1/chat/completions']);
  console.log('  ✓ /health: ok, mode=api, endpoints listed');
}

// --- auth ----------------------------------------------------------------

{
  let r = await fetch(AUTH + '/v1/models');
  assert.equal(r.status, 401);
  r = await fetch(AUTH + '/v1/models', { headers: { authorization: 'Bearer wrong-key' } });
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.error.type, 'authentication_error');
  r = await fetch(AUTH + '/v1/models', { headers: { authorization: 'Bearer ' + key } });
  assert.equal(r.status, 200);
  console.log('  ✓ API_KEY: missing / wrong key → 401, correct key → 200');
}

// --- /v1/models shape -----------------------------------------------------

{
  const r = await fetch(OPEN + '/v1/models');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, 'list');
  assert.deepEqual(j.data.map((m) => m.id), ['gpt-5.6-terra', 'gpt-5.4-mini', 'claude-haiku-4-5']);
  assert.equal(j.data[0].object, 'model');
  assert.equal(j.data[0].owned_by, 'openai');
  assert.deepEqual(j.data[0].reasoning_efforts, ['none', 'low', 'medium']);
  console.log('  ✓ /v1/models: OpenAI list shape + effort/image metadata');
}

// --- non-stream chat completion -------------------------------------------

{
  chatCalls.length = 0;
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: 'You are a duck.' },
        { role: 'user', content: 'Hi' },
      ],
    }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.id.startsWith('chatcmpl-'));
  assert.equal(j.object, 'chat.completion');
  assert.equal(j.model, 'gpt-5.4-mini');
  assert.equal(j.choices[0].message.role, 'assistant');
  assert.equal(j.choices[0].message.content, 'Hello world');
  assert.equal(j.choices[0].finish_reason, 'stop');
  assert.ok(j.usage.total_tokens > 0);
  assert.equal(chatCalls.length, 1);
  assert.equal(chatCalls[0].effort, 'none'); // default
  console.log('  ✓ non-stream chat.completion: content, usage, default effort');
}

// --- streaming (SSE chunks + [DONE]) ---------------------------------------

{
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      reasoning_effort: 'low',
    }),
  });
  assert.equal(r.status, 200);
  assert.ok((r.headers.get('content-type') || '').includes('text/event-stream'));
  const raw = await r.text();
  const lines = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  assert.equal(lines[lines.length - 1], '[DONE]');
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l));
  assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk'));
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
  const text = chunks.slice(1, -1).map((c) => c.choices[0].delta.content).join('');
  assert.equal(text, 'Hello world');
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
  // the effort parameter reached the chat layer
  assert.equal(chatCalls[chatCalls.length - 1].effort, 'low');
  console.log('  ✓ stream: role chunk → content deltas → finish_reason stop → [DONE]');
}

// --- vision: OpenAI image_url part → duck.ai image part ---------------------

{
  chatCalls.length = 0;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: png } }, { type: 'text', text: 'What is this?' }] }],
    }),
  });
  assert.equal(r.status, 200);
  const sent = chatCalls[0].messages[0].content;
  assert.equal(sent[0].type, 'image');
  assert.equal(sent[0].mimeType, 'image/png');
  assert.ok(sent[0].image.startsWith('data:image/png;base64,'));
  assert.deepEqual(sent[1], { type: 'text', text: 'What is this?' });
  console.log('  ✓ vision: image_url data:PNG → {type:"image", image, mimeType} + text part');
}

// --- image generation extension ----------------------------------------------

{
  chatCalls.length = 0;
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'draw a duck' }], image: true }),
  });
  const j = await r.json();
  assert.ok(Array.isArray(j.choices[0].message.images));
  assert.ok(j.choices[0].message.images[0].startsWith('data:image/jpeg;base64,'));
  assert.equal(chatCalls[0].image, true);
  console.log('  ✓ image:true extension → message.images data URL');
}

// --- validation errors ---------------------------------------------------------

{
  const post = (body) => fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  let r = await post('not json at all');
  assert.equal(r.status, 400);
  r = await post({});
  assert.equal(r.status, 400);
  r = await post({ messages: [] });
  assert.equal(r.status, 400);
  r = await post({ messages: [{ role: 'tool', content: 'x' }] });
  assert.equal(r.status, 400);
  r = await post({ messages: [{ role: 'user', content: 'hi' }], model: 'no-such-model' });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'model_not_found');
  r = await post({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-haiku-4-5', reasoning_effort: 'medium' });
  assert.equal(r.status, 400); // claude fake supports only none/low
  r = await fetch(OPEN + '/nope');
  assert.equal(r.status, 404);
  console.log('  ✓ validation: bad json / empty messages / role / model 404 / bad effort / 404 route');
}

// --- unknown model alias resolution (stale id reaches the right model) ---------

{
  chatCalls.length = 0;
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.model, 'gpt-5.4-mini'); // resolved upstream id in the response
  console.log('  ✓ stale model id "gpt-4o-mini" → resolved to gpt-5.4-mini');
}

// --- restricted-flagship fallback (duck.ai advertises models it then rejects) ---

{
  chatCalls.length = 0;
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.model, 'gpt-5.4-mini'); // fell back inside the gpt family
  const tried = chatCalls.map((c) => c.model);
  assert.deepEqual(tried, ['gpt-5.6-terra', 'gpt-5.4-mini']);
  console.log('  ✓ ERR_MODEL_RESTRICTED → automatic fallback to the next family candidate');
}

authServer.close();
openServer.close();
console.log('api.test.mjs: all checks passed');
