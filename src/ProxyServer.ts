import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type * as net from 'net';

const BLOCKED_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
]);

const STATE_DIR = path.join(os.homedir(), '.opencode');
const STATE_FILE = path.join(STATE_DIR, 'proxy-state.json');

const PORT_MIN = 4097;
const PORT_MAX = 5002;
const PROXY_FEATURE_KEY = 'web-sidebar-injection-v2';

const LOCK_DIR = path.join(STATE_DIR, 'proxy-state.lock');
const LOCK_STALE_MS = 5000;
const LOCK_RETRIES = 50;

function acquireLockSync(): void {
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(LOCK_DIR);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(LOCK_DIR);
          continue;
        }
      } catch {
        continue;
      }
      const start = Date.now();
      while (Date.now() - start < 50) { /* spin */ }
    }
  }
  throw new Error('Could not acquire proxy state lock');
}

function releaseLockSync(): void {
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch {
    // Best effort
  }
}

interface ProxyEntry {
  port: number;
  ownerPid: number;
  clientPids: number[];
}

interface ProxyState {
  proxies: Record<string, ProxyEntry>;
}

function readState(): ProxyState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { proxies: {} };
  }
}

function writeState(state: ProxyState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanStalePids(state: ProxyState): void {
  for (const [key, entry] of Object.entries(state.proxies)) {
    entry.clientPids = entry.clientPids.filter(isPidAlive);
    if (entry.clientPids.length === 0) {
      delete state.proxies[key];
    } else if (!entry.clientPids.includes(entry.ownerPid)) {
      entry.ownerPid = entry.clientPids[0];
    }
  }
}

async function testProxyAlive(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2000),
    });
    return true;
  } catch {
    return false;
  }
}

function copyHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

function filteredHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!BLOCKED_HEADERS.has(key.toLowerCase()) && value !== undefined) {
      result[key] = value as string | string[];
    }
  }
  return result;
}

function getHttpModule(protocol: string): typeof http | typeof https {
  return protocol === 'https:' ? https : http;
}

const WEBSIDEBAR_URL_TRACKER = `<script>
(function(){
  if (window.__ocWebSidebarUrlTracker) return;
  window.__ocWebSidebarUrlTracker = true;

  function sendUrl() {
    try {
      var path = window.location.pathname + window.location.search + window.location.hash;
      window.parent.postMessage({ type: 'ocFrameUrlChanged', path: path }, '*');
    } catch(e) {}
  }

  sendUrl();

  var origPushState = history.pushState;
  var origReplaceState = history.replaceState;

  history.pushState = function() {
    origPushState.apply(this, arguments);
    sendUrl();
  };
  history.replaceState = function() {
    origReplaceState.apply(this, arguments);
    sendUrl();
  };

  window.addEventListener('popstate', sendUrl);
  window.addEventListener('hashchange', sendUrl);
})();
</script>`;

const WEBSIDEBAR_FOCUS_GUARD_SCRIPT = `<script>
(function(){
  function installSiteTweaks(){
    if(document.getElementById('oc-web-sidebar-site-tweaks'))return;
    var style=document.createElement('style');
    style.id='oc-web-sidebar-site-tweaks';
    style.textContent='div[data-slot="tabs-trigger-wrapper"][data-value="servers"],[data-slot="tabs-trigger-wrapper"][data-value="servers"],[role="tab"][data-value="servers"],button[data-value="servers"],div[id$="-content-servers"],[role="tabpanel"][data-value="servers"],[data-slot="tabs-content"][data-value="servers"],#opencode-titlebar-right .bg-icon-success-base{display:none!important}';
    (document.head||document.documentElement).appendChild(style);
  }

  installSiteTweaks();

  if(window.__ocWebSidebarFocusGuard)return;
  window.__ocWebSidebarFocusGuard=true;

  var allowProgrammaticFocusUntil=0;
  var focusIntentWindowMs=6000;
  var nativeFocus=HTMLElement.prototype.focus;

  function markUserIntent(){
    allowProgrammaticFocusUntil=Date.now()+focusIntentWindowMs;
  }

  ['pointerdown','mousedown','touchstart','keydown'].forEach(function(type){
    document.addEventListener(type,function(event){
      if(event.isTrusted!==false)markUserIntent();
    },true);
  });

  function canProgrammaticallyFocus(){
    return Date.now()<=allowProgrammaticFocusUntil;
  }

  HTMLElement.prototype.focus=function(options){
    if(!canProgrammaticallyFocus()){
      return;
    }
    return nativeFocus.call(this,options);
  };

  function removeAutofocus(root){
    if(!root||!root.querySelectorAll)return;
    if(root.hasAttribute&&root.hasAttribute('autofocus'))root.removeAttribute('autofocus');
    root.querySelectorAll('[autofocus]').forEach(function(el){el.removeAttribute('autofocus')});
  }

  removeAutofocus(document);
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',function(){installSiteTweaks();removeAutofocus(document)});
  }

  new MutationObserver(function(records){
    records.forEach(function(record){
      if(record.type==='attributes'&&record.target&&record.target.removeAttribute){
        record.target.removeAttribute('autofocus');
      }
      record.addedNodes&&record.addedNodes.forEach(function(node){removeAutofocus(node)});
    });
  }).observe(document.documentElement||document,{subtree:true,childList:true,attributes:true,attributeFilter:['autofocus']});
})();

(function(){
  if(window.__ocWebSidebarNavFix)return;
  window.__ocWebSidebarNavFix=true;
  function closeSidebar(){
    var n=document.querySelector('[data-component="sidebar-nav-mobile"]');
    if(!n)return;
    var o=n.previousElementSibling;
    if(o&&o.classList.contains('opacity-100'))o.click()
  }
  document.addEventListener('click',function(e){
    var t=e.target;
    while(t&&t!==document){
      if(t.tagName==='A'&&t.getAttribute('href')&&t.getAttribute('href').includes('/session')){
        setTimeout(closeSidebar,0);
        break;
      }
      t=t.parentElement
    }
  },true);
})();
</script>`;

function shouldInjectScript(req: http.IncomingMessage, proxyRes: http.IncomingMessage): boolean {
  if (req.method === 'HEAD') {
    return false;
  }
  const statusCode = proxyRes.statusCode || 200;
  if (statusCode < 200 || statusCode >= 300) {
    return false;
  }
  if (statusCode === 204 || statusCode === 205) {
    return false;
  }

  const encoding = proxyRes.headers['content-encoding'];
  if (encoding) {
    return false;
  }

  const contentType = proxyRes.headers['content-type'];
  const contentTypeValue = Array.isArray(contentType) ? contentType.join(';') : contentType || '';
  return /\btext\/html\b/i.test(contentTypeValue);
}

function injectWebSidebarScript(html: string): string {
  if (html.includes('__ocWebSidebarFocusGuard')) {
    return html;
  }

  const injectedScripts = WEBSIDEBAR_URL_TRACKER + WEBSIDEBAR_FOCUS_GUARD_SCRIPT;

  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (headMatch?.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return html.slice(0, insertAt) + injectedScripts + html.slice(insertAt);
  }

  const scriptMatch = /<script\b/i.exec(html);
  if (scriptMatch?.index !== undefined) {
    return html.slice(0, scriptMatch.index) + injectedScripts + html.slice(scriptMatch.index);
  }

  return injectedScripts + html;
}

function sendInjectedHtml(
  proxyRes: http.IncomingMessage,
  res: http.ServerResponse,
  resHeaders: Record<string, string | string[]>,
): void {
  const chunks: Buffer[] = [];

  proxyRes.on('data', chunk => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  proxyRes.on('end', () => {
    if (res.destroyed) {
      return;
    }

    const html = Buffer.concat(chunks).toString('utf8');
    const injected = injectWebSidebarScript(html);
    const body = Buffer.from(injected, 'utf8');

    delete resHeaders['content-length'];
    delete resHeaders['Content-Length'];
    delete resHeaders['transfer-encoding'];
    delete resHeaders['Transfer-Encoding'];
    delete resHeaders['etag'];
    delete resHeaders['ETag'];
    resHeaders['content-length'] = String(body.byteLength);

    res.writeHead(proxyRes.statusCode || 200, resHeaders);
    res.end(body);
  });

  proxyRes.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Bad Gateway: ${err.message}`);
    }
  });
}

function createRequestHandler(targetUrl: string, auth: string | null): http.RequestListener {
  const parsed = new URL(targetUrl);
  const targetHost = parsed.host;
  const connectHost = targetHost.replace(/^localhost:/i, '127.0.0.1:');
  const baseUrl = `${parsed.protocol}//${connectHost}`;
  const httpModule = getHttpModule(parsed.protocol);

  return (req, res) => {
    const target = baseUrl + (req.url || '/');

    const headers = copyHeaders(req.headers);
    headers['host'] = targetHost;
    delete headers['accept-encoding'];
    if (auth) {
      headers['authorization'] = auth;
    }

    const proxyReq = httpModule.request(target, {
      method: req.method,
      headers,
      timeout: 10000,
      agent: false,
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`Bad Gateway: ${err.message}`);
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'text/plain' });
        res.end('Gateway Timeout');
      }
    });

    proxyReq.on('response', (proxyRes) => {
      const resHeaders = filteredHeaders(proxyRes.headers);
      if (shouldInjectScript(req, proxyRes)) {
        sendInjectedHtml(proxyRes, res, resHeaders);
      } else {
        res.writeHead(proxyRes.statusCode || 200, resHeaders);
        proxyRes.pipe(res);
      }
    });

    req.pipe(proxyReq);
  };
}

function createUpgradeHandler(
  targetUrl: string,
  auth: string | null,
): (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void {
  const parsed = new URL(targetUrl);
  const targetHost = parsed.host;
  const connectHost = targetHost.replace(/^localhost:/i, '127.0.0.1:');
  const httpModule = getHttpModule(parsed.protocol);

  return (req, socket, head) => {
    const target = `${parsed.protocol}//${connectHost}${req.url || '/'}`;
    const headers = copyHeaders(req.headers);
    headers['host'] = targetHost;
    if (auth) {
      headers['authorization'] = auth;
    }

    const proxyReq = httpModule.request(target, {
      method: req.method,
      headers,
      timeout: 10000,
      agent: false,
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      const resHeaders = filteredHeaders(proxyRes.headers);
      const headerLines = Object.entries(resHeaders).flatMap(([key, value]) =>
        Array.isArray(value)
          ? value.map(v => `${key}: ${v}`)
          : [`${key}: ${value}`]
      );
      socket.write([
        `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode || 101} ${proxyRes.statusMessage || 'Switching Protocols'}`,
        ...headerLines,
        '',
        '',
      ].join('\r\n'));
      if (proxyHead.length > 0) {
        socket.write(proxyHead);
      }
      if (head.length > 0) {
        proxySocket.write(head);
      }
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxyReq.on('response', (proxyRes) => {
      socket.write(`HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode || 502} ${proxyRes.statusMessage || 'Bad Gateway'}\r\n\r\n`);
      socket.destroy();
      proxyRes.resume();
    });

    proxyReq.on('error', (err) => {
      if (!socket.destroyed) {
        socket.write(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\n\r\nBad Gateway: ${err.message}`);
        socket.destroy();
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 504 Gateway Timeout\r\ncontent-type: text/plain\r\n\r\nGateway Timeout');
        socket.destroy();
      }
    });

    proxyReq.end();
  };
}

async function tryBind(
  port: number,
  handler: http.RequestListener,
  upgradeHandler: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void,
): Promise<http.Server | null> {
  const server = http.createServer(handler);
  server.on('upgrade', upgradeHandler);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        resolve();
      });
    });
    return server;
  } catch (err: any) {
    server.close();
    if (err.code === 'EADDRINUSE') return null;
    throw err;
  }
}

interface SharedProxyHandle {
  port: number;
  dispose: () => Promise<void>;
}

export async function getOrCreateProxy(targetUrl: string): Promise<SharedProxyHandle> {
  const parsed = new URL(targetUrl);
  const auth = parsed.username
    ? `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64')}`
    : null;
  const authKey = auth ? crypto.createHash('sha256').update(auth).digest('hex') : 'none';
  const key = `${parsed.protocol}//${parsed.host}|auth=${authKey}|features=${PROXY_FEATURE_KEY}`;

  const handler = createRequestHandler(targetUrl, auth);
  const upgradeHandler = createUpgradeHandler(targetUrl, auth);

  const existing = (() => {
    const s = readState();
    cleanStalePids(s);
    return s.proxies[key] ?? null;
  })();

  if (existing) {
    const alive = await testProxyAlive(existing.port);
    if (alive) {
      acquireLockSync();
      try {
        const s = readState();
        const entry = s.proxies[key];
        if (entry && !entry.clientPids.includes(process.pid)) {
          entry.clientPids.push(process.pid);
        }
        writeState(s);
      } finally {
        releaseLockSync();
      }

      const dispose = async () => {
        acquireLockSync();
        try {
          const s = readState();
          const e = s.proxies[key];
          if (!e) return;
          e.clientPids = e.clientPids.filter(p => p !== process.pid);
          const live = e.clientPids.filter(isPidAlive);
          if (live.length === 0) {
            delete s.proxies[key];
          } else if (e.ownerPid === process.pid) {
            e.ownerPid = live[0];
          }
          writeState(s);
        } finally {
          releaseLockSync();
        }
      };

      return { port: existing.port, dispose };
    }

    acquireLockSync();
    try {
      const s = readState();
      delete s.proxies[key];
      writeState(s);
    } finally {
      releaseLockSync();
    }
  }

  const usedPorts = new Set(
    Object.values(readState().proxies).map(e => e.port)
  );

  let server: http.Server | null = null;

  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (usedPorts.has(port)) continue;
    server = await tryBind(port, handler, upgradeHandler);
    if (server) {
      acquireLockSync();
      try {
        const s = readState();
        s.proxies[key] = { port, ownerPid: process.pid, clientPids: [process.pid] };
        writeState(s);
      } finally {
        releaseLockSync();
      }

      const dispose = async () => {
        let shouldClose = false;
        acquireLockSync();
        try {
          const s = readState();
          const e = s.proxies[key];
          if (!e) return;
          e.clientPids = e.clientPids.filter(p => p !== process.pid);
          const live = e.clientPids.filter(isPidAlive);
          if (live.length === 0) {
            delete s.proxies[key];
            shouldClose = true;
          } else if (e.ownerPid === process.pid) {
            e.ownerPid = live[0];
          }
          writeState(s);
        } finally {
          releaseLockSync();
        }
        if (shouldClose) {
          await new Promise<void>(resolve => server?.close(() => resolve()));
        }
      };

      return { port, dispose };
    }
  }

  server = await tryBind(0, handler, upgradeHandler);
  if (!server) throw new Error('Failed to bind proxy to any port');

  const addr = server.address();
  if (!addr || typeof addr !== 'object') {
    server.close();
    throw new Error('Failed to get proxy port');
  }

  acquireLockSync();
  try {
    const s = readState();
    s.proxies[key] = { port: addr.port, ownerPid: process.pid, clientPids: [process.pid] };
    writeState(s);
  } finally {
    releaseLockSync();
  }

  const dispose = async () => {
    let shouldClose = false;
    acquireLockSync();
    try {
      const s = readState();
      const e = s.proxies[key];
      if (!e) return;
      e.clientPids = e.clientPids.filter(p => p !== process.pid);
      const live = e.clientPids.filter(isPidAlive);
      if (live.length === 0) {
        delete s.proxies[key];
        shouldClose = true;
      } else if (e.ownerPid === process.pid) {
        e.ownerPid = live[0];
      }
      writeState(s);
    } finally {
      releaseLockSync();
    }
    if (shouldClose) {
      await new Promise<void>(resolve => server?.close(() => resolve()));
    }
  };

  return { port: addr.port, dispose };
}

function registerExitCleanup(): void {
  process.on('exit', () => {
    try {
      acquireLockSync();
      try {
        const s = readState();
        for (const [key, entry] of Object.entries(s.proxies)) {
          entry.clientPids = entry.clientPids.filter(p => p !== process.pid);
          const live = entry.clientPids.filter(isPidAlive);
          if (live.length === 0) {
            delete s.proxies[key];
          } else if (entry.ownerPid === process.pid) {
            entry.ownerPid = live[0];
          }
        }
        writeState(s);
      } finally {
        releaseLockSync();
      }
    } catch {
      // Best effort on exit — stale entries cleaned on next launch
    }
  });
}

registerExitCleanup();
