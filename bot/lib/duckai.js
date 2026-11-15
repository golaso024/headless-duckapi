// ============================================================================
// duckai.js v2 — DuckDuckGo AI Chat (duck.ai) client, hardened against the
// antibot. Key change vs v1: the browser mock now behaves like a REAL browser
// for every check the challenge family uses (verified against 4 captured
// flavors, Oct 2026):
//   * HTML5 fragment parsing for innerHTML (tag balancing, <p> scoping rules,
//     orphan </p> synthesizes an empty <p>, EOF-in-tag is dropped) and
//     normalized serialization on the getter.
//   * Real querySelector/querySelectorAll('*') tree walking; live `children`.
//   * NodeList (named exactly so `constructor.name === "NodeList"`).
//   * window [object Window] via Symbol.toStringTag.
//   * sloppy-mode global idiom (function(){return this;})() === window.
// The old mock returned values no real browser produces -> 418 on some
// challenge flavors.
// Ported from aurora-develop/Duck2api protocol (Sep 2026) + flavor analysis.
// ============================================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const ORIGIN = 'https://duck.ai';
const STACK = 'Error\nat l (https://duck.ai/dist/duckai-dist/entry.duckai.c0a8c794abcbc8ee2d3c.js:2:1446307)\nat async https://duck.ai/dist/duckai-dist/entry.duckai.c0a8c794abcbc8ee2d3c.js:2:1294181';

// sha256Base64 unchanged from v1 (pure JS, no crypto.subtle dependency)
function sha256Base64(text) {
  const str = String(text);
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else if (c < 2048) { bytes.push((c >> 6) | 192, (c & 63) | 128); }
    else if (c < 55296 || c >= 57344) { bytes.push((c >> 12) | 224, ((c >> 6) & 63) | 128, (c & 63) | 128); }
    else { c = 65536 + (((c & 1023) << 10) | (str.charCodeAt(++i) & 1023)); bytes.push((c >> 18) | 240, ((c >> 12) & 63) | 128, ((c >> 6) & 63) | 128, (c & 63) | 128); }
  }
  const msgLen = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bits = msgLen * 8;
  const hi = Math.floor(bits / 4294967296);
  const lo = bits % 4294967296;
  bytes.push(Math.floor(hi / 16777216) & 255, Math.floor(hi / 65536) & 255, Math.floor(hi / 256) & 255, hi & 255,
             Math.floor(lo / 16777216) & 255, Math.floor(lo / 65536) & 255, Math.floor(lo / 256) & 255, lo & 255);
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const w = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >>> 3);
      const s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0, (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0];
  }
  const out = [];
  for (let i = 0; i < 8; i++) out.push((H[i] >>> 24) & 0xff, (H[i] >>> 16) & 0xff, (H[i] >>> 8) & 0xff, H[i] & 0xff);
  let b64 = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < out.length; i += 3) {
    const b0 = out[i], b1 = out[i + 1], b2 = out[i + 2];
    b64 += chars[b0 >> 2] + chars[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    b64 += b1 === undefined ? '=' : chars[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    b64 += b2 === undefined ? '=' : chars[b2 & 63];
  }
  return b64;
}

const B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64C[b0 >> 2];
    out += B64C[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : B64C[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : B64C[b2 & 63];
  }
  return out;
}
// b64 -> bytes (binary-safe, no Buffer/atob needed; JPEG-safe).
function b64ToBytes(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const e0 = B64C.indexOf(clean[i]), e1 = B64C.indexOf(clean[i + 1]);
    const e2 = clean[i + 2] === '=' ? 0 : B64C.indexOf(clean[i + 2]);
    const e3 = clean[i + 3] === '=' ? 0 : B64C.indexOf(clean[i + 3]);
    out[p++] = (e0 << 2) | (e1 >> 4);
    if (clean[i + 2] !== '=') out[p++] = ((e1 & 15) << 4) | (e2 >> 2);
    if (clean[i + 3] !== '=') out[p++] = ((e2 & 3) << 6) | e3;
  }
  return out.subarray(0, p);
}

function utf8Bytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c < 0xdc00) {
      const c2 = s.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function btoaUtf8(s) { return bytesToB64(utf8Bytes(s)); }
function atobUtf8(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 4) {
    const e0 = B64C.indexOf(clean[i]), e1 = B64C.indexOf(clean[i + 1]), e2 = clean[i + 2] === '=' ? 0 : B64C.indexOf(clean[i + 2]), e3 = clean[i + 3] === '=' ? 0 : B64C.indexOf(clean[i + 3]);
    bytes.push((e0 << 2) | (e1 >> 4));
    if (clean[i + 2] !== '=') bytes.push(((e1 & 15) << 4) | (e2 >> 2));
    if (clean[i + 3] !== '=') bytes.push(((e2 & 3) << 6) | e3);
  }
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const c = bytes[i];
    if (c < 0x80) { out += String.fromCharCode(c); i++; }
    else if (c < 0xe0) { out += String.fromCharCode(((c & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
    else if (c < 0xf0) { out += String.fromCharCode(((c & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 3; }
    else {
      const cp = ((c & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
      out += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
      i += 4;
    }
  }
  return out;
}

function uuidv4() {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else s += hex[Math.floor(Math.random() * 16)];
  }
  s = s.slice(0, 19) + '89ab'[Math.floor(Math.random() * 4)] + s.slice(20);
  return s;
}
function randomHex(byteLen) {
  let s = '';
  const hex = '0123456789abcdef';
  for (let i = 0; i < byteLen * 2; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

// ----------------------------------------------------------------------------
// x-fe-signals: mimic the event log a real duck.ai session records
// ----------------------------------------------------------------------------
function createFESignals() {
  const now = Date.now();
  const impression = 50 + Math.floor(Math.random() * 100);
  const action = impression + 5000 + Math.floor(Math.random() * 25000);
  const finish = action + 1000 + Math.floor(Math.random() * 9000);
  const startChat = finish + 10 + Math.floor(Math.random() * 90);
  const end = startChat + Math.floor(Math.random() * 10);
  const payload = {
    start: now - end,
    events: [
      { name: 'onboarding_impression', delta: impression },
      { name: 'action', delta: action, trusted: true },
      { name: 'onboarding_finish', delta: finish },
      { name: 'startNewChat_free', delta: startChat },
    ],
    end,
  };
  return btoaUtf8(JSON.stringify(payload));
}

// ============================================================================
// Mini HTML5 fragment parser + serializer (for innerHTML normalization)
// ============================================================================
const VOID_TAGS = new Set(['br', 'img', 'hr', 'meta', 'input', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
// Start tags that close an open <p> (button scope), per HTML5 "in body".
const P_CLOSERS = new Set(['address','article','aside','blockquote','center','details','dialog','dir','div','dl','fieldset','figcaption','figure','footer','header','hgroup','main','menu','nav','ol','p','section','summary','ul','h1','h2','h3','h4','h5','h6','pre','listing','form','li','dd','dt','plaintext','table','hr','xmp']);
// Elements that end button scope.
const SCOPE_STOPPERS = new Set(['html','table','td','th','caption','applet','marquee','object','template','select','optgroup','option']);

function parseFragment(html, makeEl) {
  const root = { tag: '#fragment', children: [], _kids: null };
  root._kids = root.children;
  const stack = [root];
  const closeP = () => {
    for (let k = stack.length - 1; k > 0; k--) {
      const t = stack[k].tag;
      if (t === 'p') { stack.length = k; return true; }
      if (SCOPE_STOPPERS.has(t)) return false;
    }
    return false;
  };
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] === '<') {
      if (html.startsWith('<!--', i)) {
        const endC = html.indexOf('-->', i);
        i = endC === -1 ? n : endC + 3;
        continue;
      }
      if (html[i + 1] === '/') {
        const end = html.indexOf('>', i);
        if (end === -1) break; // EOF-in-tag: dropped
        const tag = html.slice(i + 2, end).trim().toLowerCase().split(/\s+/)[0];
        i = end + 1;
        let found = -1;
        for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) { found = k; break; }
        if (found > 0) { stack.length = found; continue; }
        if (tag === 'p') {
          // orphan </p>: synthesize an empty <p></p> at the current node
          const p = makeEl ? makeEl('p') : { tag: 'p', children: [], _kids: [] };
          p.tag = 'p';
          stack[stack.length - 1]._kids.push(p);
        }
        // other unmatched end tags: ignored
      } else {
        const end = html.indexOf('>', i);
        if (end === -1) break; // EOF-in-tag: dropped
        let src = html.slice(i + 1, end);
        i = end + 1;
        const selfClosing = /\/\s*$/.test(src);
        const tag = (src.replace(/\/\s*$/, '').trim().split(/\s+/)[0] || '').toLowerCase();
        if (!tag) continue;
        if (P_CLOSERS.has(tag)) closeP();
        const el = makeEl ? makeEl(tag) : { tag, children: [], _kids: [], attrs: {} };
        el.tag = tag; // bookkeeping used by the parser/serializer
        stack[stack.length - 1]._kids.push(el);
        if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(el);
      }
    } else {
      const next = html.indexOf('<', i);
      const text = html.slice(i, next === -1 ? n : next);
      if (text) stack[stack.length - 1]._kids.push({ text });
      i = next === -1 ? n : next;
    }
  }
  return root;
}

function serializeNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.text !== undefined) { out += nd.text; continue; }
    if (VOID_TAGS.has(nd.tag)) { out += '<' + nd.tag + '>'; continue; }
    out += '<' + nd.tag + '>' + serializeNodes(nd._kids || nd.children) + '</' + nd.tag + '>';
  }
  return out;
}

// ----------------------------------------------------------------------------
// Browser mock sandbox for the challenge JS — realistic edition
// ----------------------------------------------------------------------------
export function buildBrowserMock(ua) {
  // NOTE: named exactly "NodeList" — challenges check constructor.name.
  function NodeList(items) {
    const vals = items || [];
    for (let i = 0; i < vals.length; i++) this[i] = vals[i];
    this.length = vals.length;
  }
  NodeList.prototype.item = function (i) { return this[i] || null; };
  NodeList.prototype.forEach = function (fn) { for (let i = 0; i < this.length; i++) fn(this[i], i, this); };
  const makeNodeList = (items) => new NodeList(items);

  function Element(tagName) {
    const name = String(tagName || '').toUpperCase();
    this.tagName = name;
    this.nodeType = 1;
    this.nodeName = name;
    this.parentNode = null;
    this.ownerDocument = null;
    this.attributes = {};
    this.textContent = '';
    this.srcdoc = '';
    this.src = '';
    this.style = {
      cssText: '', display: 'inline-block',
      getPropertyValue(n) { return String(n).toLowerCase() === 'display' ? this.display || 'inline-block' : ''; },
    };
    this.offsetWidth = 1;
    this.offsetHeight = 1;
    this.scrollHeight = 1;
    this.clientWidth = 1;
    this.clientHeight = 1;
    this._kids = [];
    const self = this;
    // innerHTML: HTML5-ish parse on set (real browser normalization),
    // normalized serialize on get.
    Object.defineProperty(this, 'innerHTML', {
      get() { return serializeNodes(self._kids); },
      set(v) { self._kids = parseFragment(String(v), (t) => new Element(t))._kids; },
      configurable: true,
    });
    // live HTMLCollection-ish view (challenge reads .length after appendChild)
    Object.defineProperty(this, 'children', {
      get() {
        return {
          get length() { return self._kids.length; },
          item(i) { return self._kids[i] || null; },
        };
      },
      set() {},
      configurable: true,
    });
  }
  Element.prototype.appendChild = function (child) { child.parentNode = this; child.ownerDocument = this.ownerDocument; this._kids.push(child); return child; };
  Element.prototype.removeChild = function (child) { const i = this._kids ? this._kids.indexOf(child) : -1; if (i >= 0) this._kids.splice(i, 1); child.parentNode = null; return child; };
  // selector engine: '*', 'tag', '#id' over the subtree
  function matches(el, sel) {
    const s = String(sel).trim();
    if (s === '*') return true;
    if (s.startsWith('#')) return (el.attributes && el.attributes.id) === s.slice(1);
    return el.tagName && el.tagName.toLowerCase() === s.toLowerCase();
  }
  function walk(el, sel, out) {
    for (const c of el._kids || []) {
      if (c.text !== undefined) continue;
      if (matches(c, sel)) out.push(c);
      walk(c, sel, out);
    }
    return out;
  }
  Element.prototype.querySelectorAll = function (sel) { return makeNodeList(walk(this, sel, [])); };
  Element.prototype.querySelector = function (sel) { const r = walk(this, sel, []); return r[0] || null; };
  Element.prototype.getAttribute = function (n) { return this.attributes[String(n)] || null; };
  Element.prototype.setAttribute = function (n, v) { this.attributes[String(n)] = String(v); };
  Element.prototype.getBoundingClientRect = function () { return { width: 1, height: 1, top: 0, right: 1, bottom: 1, left: 0, x: 0, y: 0 }; };
  Element.prototype.addEventListener = function () {};
  Element.prototype.removeEventListener = function () {};
  Element.prototype.focus = function () {};
  Element.prototype.blur = function () {};
  Element.prototype.cloneNode = function () { return Object.create(this); };

  function HTMLElement() { Element.apply(this, arguments); }
  HTMLElement.prototype = Object.create(Element.prototype);
  HTMLElement.prototype.constructor = HTMLElement;
  function HTMLDivElement() { HTMLElement.apply(this, arguments); }
  HTMLDivElement.prototype = Object.create(HTMLElement.prototype);
  HTMLDivElement.prototype.constructor = HTMLDivElement;
  function HTMLIFrameElement() { HTMLElement.apply(this, arguments); }
  HTMLIFrameElement.prototype = Object.create(HTMLElement.prototype);
  HTMLIFrameElement.prototype.constructor = HTMLIFrameElement;
  function HTMLScriptElement() { HTMLElement.apply(this, arguments); }
  HTMLScriptElement.prototype = Object.create(HTMLElement.prototype);
  HTMLScriptElement.prototype.constructor = HTMLScriptElement;

  function createElementMock(tag) {
    const t = String(tag || '').toLowerCase();
    if (t === 'div') return new HTMLDivElement(t);
    if (t === 'iframe') return new HTMLIFrameElement(t);
    if (t === 'script') return new HTMLScriptElement(t);
    return new Element(t);
  }

  const navigatorMock = {
    userAgent: ua,
    platform: 'Win32',
    language: 'en-US',
    languages: ['en-US', 'en'],
    cookieEnabled: true,
    onLine: true,
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
    vendor: 'Google Inc.',
    vendorSub: '',
    productSub: '20030107',
    appCodeName: 'Mozilla',
    appName: 'Netscape',
    appVersion: ua,
    product: 'Gecko',
    doNotTrack: null,
    mimeTypes: { length: 0, item() { return null; }, namedItem() { return null; } },
    plugins: { length: 0, item() { return null; }, namedItem() { return null; } },
    webdriver: false,
    deviceMemory: 8,
    javaEnabled() { return false; },
    getBattery() { return Promise.resolve({ level: 1, charging: true }); },
  };

  const docLocation = {
    href: 'https://duck.ai/', origin: ORIGIN, protocol: 'https:', host: 'duck.ai',
    hostname: 'duck.ai', port: '', pathname: '/', search: '', hash: '',
  };

  function makeDocument() {
    const doc = {
      body: null,
      documentElement: null,
      head: null,
      cookie: '',
      title: '',
      referrer: '',
      URL: 'https://duck.ai/',
      domain: 'duck.ai',
      readyState: 'complete',
      visibilityState: 'visible',
      hidden: false,
      defaultView: null,
      location: docLocation,
      createElement(tag) { const el = createElementMock(tag); el.ownerDocument = this; return el; },
      createTextNode(t) { return { text: String(t), nodeType: 3 }; },
      createComment() { return {}; },
      createEvent() { return { initEvent() {} }; },
      dispatchEvent() { return true; },
      addEventListener() {},
      removeEventListener() {},
    };
    const html = new Element('html');
    const head = new Element('head');
    const body = new Element('body');
    html.ownerDocument = doc; head.ownerDocument = doc; body.ownerDocument = doc;
    html._kids.push(head); html._kids.push(body);
    head.parentNode = html; body.parentNode = html;
    doc.documentElement = html; doc.head = head; doc.body = body;
    doc.querySelector = function (sel) { const r = walk(doc.documentElement, sel, []); return r[0] || null; };
    doc.querySelectorAll = function (sel) { return makeNodeList(walk(doc.documentElement, sel, [])); };
    doc.getElementById = function (id) {
      const found = (function find(el) {
        for (const c of el._kids || []) {
          if (c.attributes && c.attributes.id === id) return c;
          const f = find(c);
          if (f) return f;
        }
        return null;
      })(doc.documentElement);
      return found;
    };
    return doc;
  }

  const doc = makeDocument();

  const contentDoc = makeDocument();
  contentDoc.defaultView = null;

  const contentWin = {
    Array, Promise, Proxy, Symbol, Object, JSON, Math, Date,
    String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet,
    Error, TypeError, RangeError, ReferenceError, SyntaxError,
    EvalError, URIError, AggregateError,
    Int8Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
    Int16Array, Int32Array, Float32Array, Float64Array,
    BigInt64Array, BigUint64Array, ArrayBuffer, SharedArrayBuffer, DataView,
    BigInt, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    TextEncoder: { encode(s) { return utf8Bytes(String(s)); } },
    TextDecoder: { decode(b) { return utf8Decode(b); } },
    crypto: {
      subtle: { digest() { return Promise.resolve(new ArrayBuffer(32)); } },
      getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; },
    },
    Element, HTMLElement, HTMLDivElement, HTMLIFrameElement, HTMLScriptElement, NodeList,
    navigator: navigatorMock,
    document: contentDoc,
    location: { href: 'about:srcdoc', origin: 'null', protocol: 'about:', host: '', hostname: '', port: '', pathname: 'srcdoc', search: '', hash: '' },
    btoa: btoaUtf8,
    atob: atobUtf8,
    setTimeout(fn) { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    getComputedStyle(el) { return el && el.style ? el.style : { getPropertyValue() { return ''; }, cssText: '' }; },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
    performance: { now() { return Date.now() % 1000 + Math.random(); }, timing: { navigationStart: Date.now() - 1000 } },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  };
  contentWin.self = contentWin;
  contentWin.window = contentWin;
  contentWin.top = contentWin;
  contentWin.parent = contentWin;
  try { contentWin[Symbol.toStringTag] = 'Window'; } catch (e) {}
  contentWin.Window = function Window() {};
  contentWin.Window.prototype = contentWin;
  contentDoc.defaultView = contentWin;

  const win = {
    Array, Promise, Proxy, Symbol, Object, JSON, Math, Date,
    String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet,
    Error, TypeError, RangeError, ReferenceError, SyntaxError,
    EvalError, URIError, AggregateError,
    Int8Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
    Int16Array, Int32Array, Float32Array, Float64Array,
    BigInt64Array, BigUint64Array, ArrayBuffer, SharedArrayBuffer, DataView,
    BigInt, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    TextEncoder: contentWin.TextEncoder,
    TextDecoder: contentWin.TextDecoder,
    crypto: contentWin.crypto,
    Element,
    HTMLElement,
    HTMLDivElement,
    HTMLIFrameElement,
    HTMLScriptElement,
    NodeList,
    document: doc,
    location: docLocation,
    navigator: navigatorMock,
    btoa: btoaUtf8,
    atob: atobUtf8,
    getComputedStyle(el) { return el && el.style ? el.style : { getPropertyValue() { return ''; }, cssText: '' }; },
    setTimeout(fn) { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    requestAnimationFrame(fn) { if (typeof fn === 'function') fn(0); return 0; },
    cancelAnimationFrame() {},
    matchMedia() { return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }; },
    performance: { now() { return Date.now() % 1000 + Math.random(); }, timing: { navigationStart: Date.now() - 1000 }, timeOrigin: Date.now() - 1000 },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
    history: { length: 1, state: null, scrollRestoration: 'auto' },
    localStorage: (() => { const s = {}; return { getItem(k) { return k in s ? s[k] : null; }, setItem(k, v) { s[k] = String(v); }, removeItem(k) { delete s[k]; }, clear() { for (const k in s) delete s[k]; }, key(i) { return Object.keys(s)[i] || null; }, get length() { return Object.keys(s).length; } }; })(),
    sessionStorage: (() => { const s = {}; return { getItem(k) { return k in s ? s[k] : null; }, setItem(k, v) { s[k] = String(v); }, removeItem(k) { delete s[k]; }, clear() { for (const k in s) delete s[k]; }, key(i) { return Object.keys(s)[i] || null; }, get length() { return Object.keys(s).length; } }; })(),
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    XMLHttpRequest: function XMLHttpRequest() { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; this.abort = () => {}; this.readyState = 4; this.status = 200; this.responseText = ''; },
    Image: function Image() { this.width = 0; this.height = 0; this.naturalWidth = 0; this.naturalHeight = 0; this.complete = false; },
    __DDG_BE_VERSION__: 'dev',
    __DDG_FE_CHAT_HASH__: 'hash',
  };
  win.self = win;
  win.top = win;
  win.parent = win;
  win.window = win;
  try { win[Symbol.toStringTag] = 'Window'; } catch (e) {}
  win.Window = function Window() {};
  win.Window.prototype = win;
  doc.defaultView = win;

  return {
    params: {
      window: win, document: doc, navigator: navigatorMock, location: docLocation,
      getComputedStyle: win.getComputedStyle, btoa: win.btoa, atob: win.atob,
      performance: win.performance, screen: win.screen, localStorage: win.localStorage,
      sessionStorage: win.sessionStorage, history: win.history,
      requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame,
      matchMedia: win.matchMedia, Image: win.Image, XMLHttpRequest: win.XMLHttpRequest,
      Element: win.Element, HTMLElement: win.HTMLElement, HTMLDivElement: win.HTMLDivElement,
      HTMLIFrameElement: win.HTMLIFrameElement, HTMLScriptElement: win.HTMLScriptElement, NodeList: win.NodeList,
      TextEncoder: win.TextEncoder, TextDecoder: win.TextDecoder, crypto: win.crypto,
      setTimeout: win.setTimeout, clearTimeout: win.clearTimeout, setInterval: win.setInterval, clearInterval: win.clearInterval,
      self: win.self, top: win.top, parent: win.parent,
      __DDG_BE_VERSION__: win.__DDG_BE_VERSION__, __DDG_FE_CHAT_HASH__: win.__DDG_FE_CHAT_HASH__,
    },
  };
}

// The sloppy-mode global idiom `(function(){return this;})()` resolves to the
// isolate's real global, not the mock window. Rewrite the idiom so the check
// matches a real browser (where it equals `window`).
function normalizeChallengeSource(js) {
  return String(js).replace(
    /\(\s*function\s*\(\s*\)\s*\{\s*return\s+this\s*;?\s*\}\s*\(\s*\)\s*\)/g,
    '(function(){return window;})()'
  );
}

// ----------------------------------------------------------------------------
// SSE chunk decoding (no TextDecoder dependency)
// ----------------------------------------------------------------------------
function decodeChunk(chunk) {
  if (typeof chunk === 'string') return chunk;
  const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  return utf8Decode(bytes);
}

function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i];
    if (c < 0x80) { out += String.fromCharCode(c); i += 1; }
    else if (c < 0xe0) { out += String.fromCharCode(((c & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
    else if (c < 0xf0) {
      out += String.fromCharCode(((c & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63));
      i += 3;
    } else {
      const cp = ((c & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
      out += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
      i += 4;
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Challenge solver
// ----------------------------------------------------------------------------
export async function solveChallenge(challengeB64, { ua = UA, origin = ORIGIN, stack = STACK } = {}) {
  let jsCode;
  try { jsCode = atobUtf8(challengeB64); } catch (e) {
    throw new Error('bad challenge base64: ' + e.message);
  }
  jsCode = normalizeChallengeSource(jsCode);
  const started = Date.now();
  let payload = null;
  let execError = null;
  try {
    const { params } = buildBrowserMock(ua);
    const argNames = Object.keys(params);
    const argVals = argNames.map((k) => params[k]);
    const fn = new Function(...argNames, 'return (' + jsCode + ');');
    let result = fn(...argVals);
    if (result && typeof result.then === 'function') result = await result;
    if (!result || typeof result !== 'object') throw new Error('challenge did not return an object');
    if (!Array.isArray(result.client_hashes)) throw new Error('challenge returned no client_hashes');

    const hashed = result.client_hashes.map((v) => sha256Base64(String(v)));
    const meta = Object.assign({}, result.meta || {});
    meta.origin = origin;
    meta.stack = stack;
    // real browsers need a few ms to run the challenge; duration '0' looks synthetic
    meta.duration = String(Math.max(Date.now() - started, 3 + Math.floor(Math.random() * 30)));

    const out = {};
    for (const k of Object.keys(result)) {
      if (k !== 'client_hashes' && k !== 'meta') out[k] = result[k];
    }
    out.client_hashes = hashed;
    out.meta = meta;
    payload = JSON.stringify(out);
  } catch (e) {
    execError = e;
    payload = jsCode + '::' + (e && e.message ? e.message : String(e)) + '::' + stack + '::' + origin;
  }
  return { token: btoaUtf8(payload), fallback: execError !== null };
}

// ----------------------------------------------------------------------------
// HTTP header builders
// ----------------------------------------------------------------------------
function baseHeaders() {
  return {
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'origin': ORIGIN,
    'referer': ORIGIN + '/',
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': UA,
    'cache-control': 'no-store',
    'cookie': 'dcm=3',
  };
}

// ----------------------------------------------------------------------------
// Token + frontend-metadata caches (L1 in-process, L2 optional store)
// ----------------------------------------------------------------------------
const TOKEN_TTL_MS = 9 * 60 * 1000;
const FE_TTL_MS = 25 * 60 * 1000;

let cachedToken = null;
let cachedFeMeta = null;

export function resetToken() { cachedToken = null; }
export function resetFeVersion() { cachedFeMeta = null; }

function sleep(ms) {
  return new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, ms);
    else resolve(); // no timers in this environment — proceed immediately
  });
}

async function fromStore(store, key, ttlMs) {
  if (!store) return null;
  try {
    const raw = await store.get(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.v || !obj.ts || Date.now() - obj.ts > ttlMs) return null;
    return obj.v;
  } catch (e) { return null; }
}

async function toStore(store, key, value) {
  if (!store) return;
  try { await store.set(key, JSON.stringify({ v: value, ts: Date.now() })); } catch (e) {}
}

export async function clearStoredToken(store) {
  cachedToken = null;
  if (!store) return;
  try { await store.set('duckai_token', null); } catch (e) {}
}

const ENTRY_RE = /(?:https:\/\/duck\.ai)?\/dist\/duckai-dist\/entry\.duckai\.[a-z0-9]+\.js/i;
function stackFromEntryUrl(url) {
  const u = url.startsWith('http') ? url : 'https://duck.ai' + url;
  return 'Error\nat l (' + u + ':2:1446307)\nat async ' + u + ':2:1294181';
}

export async function getFeMeta(fetchFn, opts = {}) {
  const f = fetchFn || fetch;
  const store = opts.store || null;
  if (cachedFeMeta && Date.now() - cachedFeMeta.ts < FE_TTL_MS) return cachedFeMeta.value;
  const stored = await fromStore(store, 'duckai_fe_meta', FE_TTL_MS);
  if (stored) { cachedFeMeta = { value: stored, ts: Date.now() }; return stored; }

  const headers = Object.assign({}, baseHeaders(), { accept: 'text/html' });
  const res = await f('https://duck.ai/', { method: 'GET', headers });
  const html = await res.text();
  const t = html.match(/data-version-tag="([^"]+)"/);
  const s = html.match(/data-version-sha="([^"]+)"/);
  if (!t || !s) throw new Error('fe-version: metadata not found');

  const feVersion = t[1] + '-' + s[1];
  let stack = STACK;
  const entry = html.match(ENTRY_RE);
  if (entry) stack = stackFromEntryUrl(entry[0]);
  const value = { feVersion, stack, entry: entry ? entry[0] : null };

  cachedFeMeta = { value, ts: Date.now() };
  await toStore(store, 'duckai_fe_meta', value);
  console.log('[duckai] fe meta refreshed: ' + feVersion + (value.entry ? ' (' + value.entry.slice(-40) + ')' : ''));
  return value;
}

export async function getFeVersion(fetchFn, opts = {}) {
  const meta = await getFeMeta(fetchFn, opts);
  return meta.feVersion;
}

let inflightToken = null; // single-flight: concurrent callers share one challenge solve

export async function getToken(fetchFn, opts = {}) {
  const f = fetchFn || fetch;
  const store = opts.store || null;
  if (cachedToken && Date.now() - cachedToken.ts < TOKEN_TTL_MS) return cachedToken.value;
  const stored = await fromStore(store, 'duckai_token', TOKEN_TTL_MS);
  if (stored) { cachedToken = { value: stored, ts: Date.now() }; return stored; }

  // One /duckchat/v1/status hit per burst, not N: /duo fires two chats in
  // parallel, api.js serves whoever calls it — without this the 429 window
  // burns on the first burst of cold requests.
  if (inflightToken) return inflightToken;
  inflightToken = (async () => {
    const headers = Object.assign({}, baseHeaders(), { accept: '*/*', 'x-vqd-accept': '1' });
    const res = await f(ORIGIN + '/duckchat/v1/status', { method: 'GET', headers });
    const challenge = res.headers.get('x-vqd-hash-1');
    if (!challenge) throw new Error('status: no x-vqd-hash-1 header (HTTP ' + res.status + ')');
    const { token, fallback } = await solveChallenge(challenge, { ua: UA, stack: opts.stack || STACK });
    console.log('[duckai] challenge solved, fallback=' + fallback);
    cachedToken = { value: token, ts: Date.now() };
    await toStore(store, 'duckai_token', token);
    return token;
  })();
  try {
    return await inflightToken;
  } finally {
    inflightToken = null;
  }
}

// ----------------------------------------------------------------------------
// Models
// ----------------------------------------------------------------------------
export async function getModels(fetchFn) {
  const f = fetchFn || fetch;
  const headers = Object.assign({}, baseHeaders(), { accept: 'application/json' });
  const res = await f(ORIGIN + '/duckchat/v1/models', { method: 'GET', headers });
  if (!res.ok) throw new Error('models: HTTP ' + res.status);
  const data = await res.json();
  return (data.models || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    provider: m.provider,
    free: m.entityHasAccess === true,
    image: m.supportsImageUpload === true,
    efforts: m.supportedReasoningEffort || [],
  }));
}

// ----------------------------------------------------------------------------
// Fallback RSA public key (used when crypto.subtle is unavailable).
// ----------------------------------------------------------------------------
const FALLBACK_JWK = {kty:"RSA",alg:"RSA-OAEP-256",e:"AQAB",n:"sC3nTTARmuTwcvF0Qu1cpYs65QvNyuIeLySJ0AKaGKB-4B9gVyZC0FO45VeDx8GzYR9mJ_vLCX_B8xusFA3fmQ98LYo1XsJbpLaGky0l5BVE1cfIhMYkm209a2v5R6CVZddrdzdBzRaLGAa1cwhA4RlArEa_Gp61CA61dbIpaKhwAHjejU5ijIrjxnPNriqhcs0AvUtAJVOCqLjn5MGi7Fpy_oD3w3-E36PgMFZGItqxUq3woG7bhqs7bf1K-vthYYFB8WVf3yZ0JxdJrYCdiwzaMve7pk1HehNGsnRKHvUI0hvF3O7q3HNe7WCnoxEpBG3O5HJgHOLanyakdunTow",use:"enc",ext:true,key_ops:["encrypt"]};

async function makeDurableStream() {
  let jwk = null;
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const kp = await crypto.subtle.generateKey(
        { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true, ['encrypt', 'decrypt']);
      const k = await crypto.subtle.exportKey('jwk', kp.publicKey);
      jwk = { kty: k.kty, alg: 'RSA-OAEP-256', e: k.e, n: k.n, use: 'enc', ext: true, key_ops: ['encrypt'] };
    }
  } catch (e) { /* fall through */ }
  if (!jwk) jwk = FALLBACK_JWK;
  return { messageId: uuidv4(), conversationId: uuidv4(), publicKey: jwk };
}

// ----------------------------------------------------------------------------
// Chat (SSE). onDelta(textChunk) is called as tokens arrive.
// stats (optional) — { bump(field, n?) } — feeds bot metrics: solves,
// fallbacks, 418/429 hits, retries, successes.
// ----------------------------------------------------------------------------
export async function chat({ model, messages, effort = 'none', webSearch = false, image = false, fetchFn, signal, onDelta, onImageEvent, store, stats }) {
  const f = fetchFn || fetch;
  const bump = (k, n) => { try { if (stats && stats.bump) stats.bump(k, n); } catch (e) {} };

  const body = {
    model,
    metadata: {
      toolChoice: {
        GenerateImage: !!image, WebSearch: !!webSearch, NewsSearch: false,
        VideosSearch: false, LocalSearch: false, WeatherForecast: false,
      },
    },
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    canUseTools: true,
    reasoningEffort: effort || 'none',
    canUseApproxLocation: null,
    canDelegateImageGeneration: image ? true : null,
    durableStream: await makeDurableStream(),
  };

  const maxRetries = 3;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let stack = STACK;
    let feVersion = '';
    try {
      const meta = await getFeMeta(f, { store });
      feVersion = meta.feVersion;
      stack = meta.stack || STACK;
    } catch (e) { /* fall back to the built-in stack */ }

    let token;
    try {
      token = await getToken(f, { store, stack });
      bump('duck_token_reused');
    } catch (e) {
      lastErr = e;
      bump('duck_status_err');
      console.warn('[duckai] status/token failed (attempt ' + (attempt + 1) + '): ' + (e && e.message ? e.message : e));
      await sleep(700 * (attempt + 1));
      continue;
    }

    const headers = Object.assign({}, baseHeaders(), {
      accept: 'text/event-stream',
      priority: 'u=1, i',
      'x-ddg-journey-id': randomHex(16),
      'x-fe-signals': createFESignals(),
      'x-vqd-hash-1': token,
    });
    if (feVersion) headers['x-fe-version'] = feVersion;

    let res;
    try {
      res = await f(ORIGIN + '/duckchat/v1/chat', {
        method: 'POST', headers, body: JSON.stringify(body), signal,
      });
    } catch (e) {
      lastErr = e; bump('duck_net_err'); resetToken(); continue;
    }

    if (res.status === 418 || res.status === 429) {
      bump(res.status === 418 ? 'duck_418' : 'duck_429');
      console.warn('[duckai] HTTP ' + res.status + ' on chat, refreshing token (attempt ' + (attempt + 1) + ')');
      await clearStoredToken(store);
      lastErr = new Error('HTTP ' + res.status + ' (rate/challenge), attempt ' + (attempt + 1));
      try { await res.text(); } catch (e) {}
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (e) {}
      bump('duck_http_' + res.status);
      throw new Error('duck.ai chat HTTP ' + res.status + ': ' + detail);
    }

    bump('duck_chat_ok');
    let full = '';
    let buf = '';
    let imgTitle = '';
    let imgPreview = null;
    let imgFinal = null;
    for await (const chunk of res.body) {
      buf += decodeChunk(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(data); } catch (e) { continue; }
        if (ev && typeof ev.message === 'string' && ev.message !== '') {
          full += ev.message;
          if (onDelta) { try { onDelta(ev.message, full); } catch (e) {} }
        }
        // GenerateImage tool progress (role 'ui-component', name 'generate-image').
        // Final shape: data { status:'success', b64Image, width, height, format,
        // generationDurationMs, moderationToken, imageModelDisplayName }.
        if (ev && ev.name === 'generate-image' && ev.data && typeof ev.data === 'object') {
          const d = ev.data;
          if (d.type === 'image-title' && d.title) {
            imgTitle = d.title;
            if (onImageEvent) { try { onImageEvent({ type: 'title', title: d.title }); } catch (e) {} }
          } else if (d.type === 'image-partial' && d.b64Image && !imgFinal) {
            imgPreview = { b64: d.b64Image, width: d.width, height: d.height, format: d.format || 'jpeg' };
            if (onImageEvent) { try { onImageEvent(Object.assign({ type: 'preview' }, imgPreview)); } catch (e) {} }
          } else if (d.status === 'success' && d.b64Image) {
            imgFinal = {
              b64: d.b64Image, width: d.width, height: d.height,
              format: d.format || 'jpeg', model: d.imageModelDisplayName || '',
              ms: d.generationDurationMs || 0, title: imgTitle,
            };
            if (onImageEvent) { try { onImageEvent({ type: 'done', image: imgFinal }); } catch (e) {} }
          }
        }
      }
    }
    if (imgFinal) return { text: full, image: imgFinal };
    if (imgPreview) return { text: full, image: Object.assign({ partial: true, title: imgTitle, model: '' }, imgPreview) };
    if (image) return { text: full, image: null };
    return full;
  }
  throw lastErr || new Error('duck.ai chat failed');
}

export { bytesToB64 as bytesToBase64, b64ToBytes };
