// test-proxy.mjs — local proxy test harness for bot/lib/proxyfetch.js.
//
//   node test-proxy.mjs serve   — run local CONNECT :8888 + SOCKS5 :8889
//   node test-proxy.mjs test    — duck.ai through both proxies (servers up)
//   node test-proxy.mjs         — both: servers up, tests, exit
//
// The "proxies" are dumb TCP relays: they prove that makeProxiedFetch
// tunnels correctly end-to-end (handshake → request → SSE stream), they do
// not inspect or cache anything.

import http from 'node:http';
import net from 'node:net';
import { makeProxiedFetch } from './bot/lib/proxyfetch.js';
import { getFeVersion, chat as duckChat } from './bot/lib/duckai.js';

const mode = process.argv[2] || '';

function startServers() {
  const httpProxy = http.createServer((req, res) => { res.writeHead(405); res.end('CONNECT only'); });
  httpProxy.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  const socks = net.createServer((client) => {
    client.once('data', () => {
      client.write(Buffer.from([5, 0])); // no auth
      client.once('data', (req) => {
        const atyp = req[3];
        let host, port, skip;
        if (atyp === 3) { const l = req[4]; host = req.slice(5, 5 + l).toString('latin1'); port = req.readUInt16BE(5 + l); skip = 5 + l + 2; }
        else if (atyp === 1) { host = req.slice(4, 8).join('.'); port = req.readUInt16BE(8); skip = 10; }
        else { client.write(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return client.destroy(); }
        const leftover = req.slice(skip);
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (leftover.length) upstream.write(leftover);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      });
    });
  });
  return new Promise((resolve) => {
    let a = false, b = false;
    const check = () => { if (a && b) resolve({ httpProxy, socks }); };
    httpProxy.listen(8888, () => { a = true; check(); });
    socks.listen(8889, () => { b = true; check(); });
  });
}

async function tests() {
  const f1 = await makeProxiedFetch('http://127.0.0.1:8888');
  console.log('[1] CONNECT proxy  → fe version:', (await getFeVersion(f1)).slice(0, 28) + '…');

  const f2 = await makeProxiedFetch('socks5://127.0.0.1:8889');
  const modelsRaw = await (await f2('https://duck.ai/duckchat/v1/models', { headers: { accept: 'application/json' } })).text();
  console.log('[2] SOCKS5 proxy   → models payload:', modelsRaw.slice(0, 56).replace(/\n/g, ' ') + '…');

  const t0 = performance.now();
  const out = await duckChat({
    model: 'gpt-5.4-mini', effort: 'none', webSearch: false,
    messages: [{ role: 'user', content: 'Reply with one word: alive' }],
    fetchFn: f2,
  });
  console.log('[3] full chat via SOCKS5 in', Math.round(performance.now() - t0), 'ms →', String(typeof out === 'string' ? out : out.text || '').slice(0, 60).replace(/\n/g, ' '));
  console.log('ALL PROXY TESTS PASSED');
}

if (mode === 'serve') {
  await startServers();
  console.log('local proxies up: CONNECT :8888, SOCKS5 :8889');
  setInterval(() => {}, 60000); // keep alive
} else if (mode === 'test') {
  await tests();
  process.exit(0);
} else {
  await startServers();
  await tests();
  process.exit(0);
}
