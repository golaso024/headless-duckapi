// proxyfetch.js — zero-dependency proxied fetch for the duck.ai engine.
//
// PROXY_URL protocols:
//   http://host:port  / https://host:port  — forward proxy, CONNECT tunnel
//   socks5://host:port (also socks://)     — SOCKS5 CONNECT. Cloudflare WARP:
//                                            `warp-cli proxy start` serves
//                                            socks5 on 127.0.0.1:40000, so
//                                            PROXY_URL=socks5://127.0.0.1:40000
//                                            routes every duck.ai request
//                                            through WARP.
//
// Fail-closed guarantee: when a proxy is configured, EVERY request goes
// through it and a proxy failure fails the request. There is no silent
// direct-connection fallback — user traffic can never leak past the proxy.
// DNS for the target host is resolved by the proxy (SOCKS5 domain ATYP /
// HTTP CONNECT hostname), not locally.
// Proxy credentials are never logged: URLs are redacted in every error.
//
// makeProxiedFetch(proxyUrl) → async (url, opts) => Response
// The returned Response is a real undici Response (status/headers/ok/text())
// whose body is a decoded streaming web stream — duckai.js iterates res.body
// for SSE, so chunked transfer-encoding is decoded here.
//
// Node-only (uses node:net/tls/http + Buffer). The Telegram Serverless
// isolate never imports this file.

import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { Readable } from 'node:stream';

const CONNECT_TIMEOUT_MS = 15000;
const REDIRECTS = [301, 302, 303, 307, 308];

export function redactProxyUrl(u) {
  return String(u || '').replace(/\/\/([^@/]+)@/, '//[REDACTED]@');
}

function parseProxyUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('bad PROXY_URL: ' + redactProxyUrl(raw)); }
  const proto = u.protocol.replace(':', '').toLowerCase();
  if (proto !== 'http' && proto !== 'https' && proto !== 'socks5' && proto !== 'socks') {
    throw new Error('unsupported proxy protocol "' + proto + '" — use http://, https:// or socks5://');
  }
  return {
    proto,
    host: u.hostname,
    port: Number(u.port) || (proto.startsWith('socks') ? 1080 : (proto === 'https' ? 443 : 80)),
    user: u.username ? decodeURIComponent(u.username) : '',
    pass: u.password ? decodeURIComponent(u.password) : '',
    auth: u.username
      ? 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64')
      : null,
  };
}

const writeBuf = (sock, buf) => new Promise((resolve, reject) => sock.write(buf, (e) => (e ? reject(e) : resolve())));

function attachAbort(sock, signal, fail) {
  if (!signal) return;
  if (signal.aborted) { fail(new Error('aborted')); return; }
  signal.addEventListener('abort', () => fail(new Error('aborted')), { once: true });
}

function tcpConnect(proxy, signal) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    const fail = (e) => { sock.destroy(); reject(new Error('proxy ' + redactProxyUrl(proxy.raw) + ': ' + ((e && e.message) || e))); };
    attachAbort(sock, signal, fail);
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error('connect timeout')));
    sock.once('connect', () => { sock.setTimeout(0); resolve(sock); });
    sock.once('error', fail);
  });
}

// HTTP forward proxy: CONNECT host:port → raw tunnel socket.
function httpConnect(proxy, targetHost, targetPort, signal) {
  return new Promise((resolve, reject) => {
    const headers = { host: targetHost + ':' + targetPort, 'user-agent': 'headless-duckapi/1.2' };
    if (proxy.auth) headers['proxy-authorization'] = proxy.auth;
    const req = http.request({
      host: proxy.host, port: proxy.port,
      method: 'CONNECT', path: targetHost + ':' + targetPort, headers,
    });
    const fail = (e) => { req.destroy(); reject(new Error('proxy CONNECT: ' + ((e && e.message) || e))); };
    attachAbort(req, signal, fail);
    req.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error('CONNECT timeout')));
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error('proxy CONNECT refused: HTTP ' + res.statusCode)); return; }
      socket.setTimeout(0);
      resolve(socket);
    });
    req.once('error', fail);
    req.end();
  });
}

// SOCKS5 (RFC 1928): greeting → optional user/pass → CONNECT by hostname
// (ATYP 3: the proxy resolves DNS, nothing leaks locally).
async function socks5Connect(proxy, targetHost, targetPort, signal) {
  const sock = await tcpConnect(proxy, signal);
  const fail = (msg) => { sock.destroy(); throw new Error('socks5: ' + msg); };
  const readBytes = (n) => new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;
    const done = (err, buf) => {
      sock.off('data', onData); sock.off('error', done); sock.off('close', onClose);
      if (err) return reject(err);
      sock.pause();
      if (buf.length > n) sock.unshift(buf.slice(n)); // give leftovers back
      resolve(buf.slice(0, n));
    };
    const onData = (d) => { chunks.push(d); got += d.length; if (got >= n) done(null, Buffer.concat(chunks)); };
    const onClose = () => done(new Error('connection closed mid-handshake'));
    if (signal && signal.aborted) return done(new Error('aborted'));
    sock.on('data', onData); sock.on('error', done); sock.on('close', onClose);
    if (signal) signal.addEventListener('abort', () => done(new Error('aborted')), { once: true });
    sock.resume();
  });

  await writeBuf(sock, Buffer.from(proxy.user ? [5, 2, 0, 2] : [5, 1, 0]));
  const method = await readBytes(2);
  if (method[0] !== 5) return fail('bad version byte ' + method[0]);
  if (method[1] === 2) {
    const u = Buffer.from(proxy.user || '', 'utf8');
    const p = Buffer.from(proxy.pass || '', 'utf8');
    await writeBuf(sock, Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const auth = await readBytes(2);
    if (auth[1] !== 0) return fail('auth rejected by proxy');
  } else if (method[1] !== 0) {
    return fail('no acceptable auth method');
  }

  const bareHost = String(targetHost).replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const atyp = net.isIPv4(bareHost) ? 1 : (net.isIPv6(bareHost) ? 4 : 3);
  const addr = atyp === 1 ? Buffer.from(bareHost.split('.').map(Number))
    : atyp === 4 ? Buffer.from(bareHost.split(':').flatMap((piece) => {
        const x = piece.padStart(4, '0');
        return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2), 16)];
      }))
    : Buffer.concat([Buffer.from([bareHost.length]), Buffer.from(bareHost, 'utf8')]);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(targetPort);
  await writeBuf(sock, Buffer.concat([Buffer.from([5, 1, 0, atyp]), addr, portBuf]));

  const head = await readBytes(4);
  if (head[1] !== 0) return fail('CONNECT failed, code ' + head[1]);
  if (head[3] === 3) {
    const len = (await readBytes(1))[0];
    await readBytes(len + 2); // domain + port
  } else {
    await readBytes((head[3] === 1 ? 4 : head[3] === 4 ? 16 : 0) + 2); // addr + port
  }
  sock.resume(); // handshake listeners are off; raw tunnel from here
  return sock;
}

// Plain HTTP/1.1 over an established tunnel socket. Resolves once response
// headers are parsed; the body keeps streaming into `out.stream` (chunked
// transfer-encoding is decoded, SSE arrives live).
function httpOverSocket(sock, method, tUrl, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const t = new URL(tUrl);
    const head = [
      method + ' ' + (t.pathname + (t.search || '')) + ' HTTP/1.1',
      'Host: ' + t.host,
      'Connection: close',
      ...Object.entries(headers).map(([k, v]) => k + ': ' + v),
    ].join('\r\n') + '\r\n\r\n';

    const pt = new Readable({ read() {} });
    const out = { status: 0, headers: {}, stream: pt };
    let buf = Buffer.alloc(0);
    let phase = 'head';
    let chunkLeft = -2; // -1 = read next size line, -2 = raw stream, 0 = done
    let settled = false;
    const fail = (e) => {
      if (settled) { pt.destroy(e); return; }
      settled = true; sock.destroy(); reject(e);
    };
    const abort = () => fail(new Error('aborted'));
    if (signal) { if (signal.aborted) return fail(new Error('aborted')); signal.addEventListener('abort', abort, { once: true }); }
    sock.on('error', fail);
    sock.on('close', () => {
      if (!settled) return fail(new Error('connection closed before response headers'));
      if (chunkLeft !== 0) pt.push(null);
    });

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (phase === 'head') {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const headBlock = buf.slice(0, idx).toString('latin1');
        buf = buf.slice(idx + 4);
        const lines = headBlock.split('\r\n');
        const m = lines[0].match(/^HTTP\/[\d.]+ (\d+)/);
        out.status = m ? Number(m[1]) : 0;
        for (const l of lines.slice(1)) {
          const c = l.indexOf(':');
          if (c > 0) out.headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
        }
        phase = 'body';
        chunkLeft = String(out.headers['transfer-encoding'] || '').toLowerCase().includes('chunked') ? -1 : -2;
        settled = true;
        resolve(out);
      }
      if (chunkLeft === -1) {
        // chunked: [size]\r\n, size bytes, \r\n, … 0\r\n ends
        for (;;) {
          if (chunkLeft < 0) {
            const idx = buf.indexOf('\r\n');
            if (idx === -1) return;
            chunkLeft = parseInt(buf.slice(0, idx).toString('latin1').split(';')[0].trim(), 16);
            buf = buf.slice(idx + 2);
            if (chunkLeft === 0) { chunkLeft = 0; pt.push(null); sock.end(); return; }
          } else {
            if (buf.length < chunkLeft + 2) return;
            pt.push(buf.slice(0, chunkLeft));
            buf = buf.slice(chunkLeft + 2);
            chunkLeft = -1;
          }
        }
      } else if (chunkLeft === -2 && buf.length) {
        pt.push(buf);
        buf = Buffer.alloc(0);
      }
    });

    sock.write(head + (body != null ? body : ''));
  });
}

// One request through the proxy, following up to 3 redirects. Every hop
// opens a fresh tunnel through the SAME proxy — traffic never goes direct.
export async function makeProxiedFetch(proxyUrl) {
  const proxy = parseProxyUrl(proxyUrl);
  proxy.raw = proxyUrl;
  return async function proxiedFetch(url, opts = {}) {
    const signal = opts.signal || null;
    let method = String(opts.method || 'GET').toUpperCase();
    let body = opts.body != null ? String(opts.body) : null;
    let target = String(url);
    const baseHeaders = Object.assign({}, opts.headers || {});
    delete baseHeaders['accept-encoding']; // identity only: no decompression layer here

    for (let hop = 0; hop < 4; hop++) {
      const t = new URL(target);
      const isHttps = t.protocol === 'https:';
      const port = Number(t.port) || (isHttps ? 443 : 80);
      let sock = proxy.proto.startsWith('socks')
        ? await socks5Connect(proxy, t.hostname, port, signal)
        : await httpConnect(proxy, t.hostname, port, signal);
      if (isHttps) sock = tls.connect({ socket: sock, servername: t.hostname });

      const headers = Object.assign({}, baseHeaders);
      if (body != null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      const res = await httpOverSocket(sock, method, t, headers, body, signal);

      if (REDIRECTS.includes(res.status) && res.headers.location && hop < 3) {
        const chunks = [];
        for await (const c of res.stream) chunks.push(c); // drain tiny redirect body
        target = new URL(res.headers.location, target).href;
        if (method === 'POST' && res.status !== 307 && res.status !== 308) {
          method = 'GET'; body = null; delete headers['content-length'];
        }
        continue;
      }
      return new Response(Readable.toWeb(res.stream), { status: res.status, headers: res.headers });
    }
    throw new Error('proxy: too many redirects');
  };
}
