import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BLOCKED_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
]);

const STATE_DIR = path.join(os.homedir(), '.opencode');
const STATE_FILE = path.join(STATE_DIR, 'proxy-state.json');

const PORT_MIN = 4097;
const PORT_MAX = 5002;

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

function createRequestHandler(targetUrl: string, auth: string | null): http.RequestListener {
  const parsed = new URL(targetUrl);
  const targetHost = parsed.host;
  const connectHost = targetHost.replace(/^localhost:/i, '127.0.0.1:');
  const baseUrl = `http://${connectHost}`;

  return (req, res) => {
    const target = baseUrl + (req.url || '/');

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }
    headers['host'] = targetHost;
    if (auth) {
      headers['authorization'] = auth;
    }

    const proxyReq = http.request(target, {
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
      const resHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (!BLOCKED_HEADERS.has(key.toLowerCase())) {
          resHeaders[key] = value as string | string[];
        }
      }
      res.writeHead(proxyRes.statusCode || 200, resHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('upgrade', (proxyRes, socket) => {
      const resHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (!BLOCKED_HEADERS.has(key.toLowerCase())) {
          resHeaders[key] = value as string | string[];
        }
      }
      res.writeHead(101, resHeaders);
      socket.pipe(res);
      res.pipe(socket);
    });

    req.pipe(proxyReq);
  };
}

async function tryBind(port: number, handler: http.RequestListener): Promise<http.Server | null> {
  const server = http.createServer(handler);
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
  const key = `${parsed.protocol}//${parsed.host}`;
  const auth = parsed.username
    ? `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64')}`
    : null;

  const handler = createRequestHandler(targetUrl, auth);

  const state = readState();
  cleanStalePids(state);

  const existing = state.proxies[key];

  if (existing) {
    const alive = await testProxyAlive(existing.port);
    if (alive) {
      if (!existing.clientPids.includes(process.pid)) {
        existing.clientPids.push(process.pid);
      }
      writeState(state);

      const dispose = async () => {
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
      };

      registerExitCleanup(dispose);
      return { port: existing.port, dispose };
    }

    delete state.proxies[key];
    writeState(state);
  }

  const usedPorts = new Set(
    Object.values(state.proxies).map(e => e.port)
  );

  let server: http.Server | null = null;

  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (usedPorts.has(port)) continue;
    server = await tryBind(port, handler);
    if (server) {
      state.proxies[key] = { port, ownerPid: process.pid, clientPids: [process.pid] };
      writeState(state);

      const dispose = async () => {
        const s = readState();
        const e = s.proxies[key];
        if (!e) return;
        e.clientPids = e.clientPids.filter(p => p !== process.pid);
        const live = e.clientPids.filter(isPidAlive);
        if (live.length === 0) {
          delete s.proxies[key];
          server?.close();
        } else if (e.ownerPid === process.pid) {
          e.ownerPid = live[0];
        }
        writeState(s);
      };

      registerExitCleanup(dispose);
      return { port, dispose };
    }
  }

  server = await tryBind(0, handler);
  if (!server) throw new Error('Failed to bind proxy to any port');

  const addr = server.address();
  if (!addr || typeof addr !== 'object') {
    server.close();
    throw new Error('Failed to get proxy port');
  }

  state.proxies[key] = { port: addr.port, ownerPid: process.pid, clientPids: [process.pid] };
  writeState(state);

  const dispose = async () => {
    const s = readState();
    const e = s.proxies[key];
    if (!e) return;
    e.clientPids = e.clientPids.filter(p => p !== process.pid);
    const live = e.clientPids.filter(isPidAlive);
    if (live.length === 0) {
      delete s.proxies[key];
      server?.close();
    } else if (e.ownerPid === process.pid) {
      e.ownerPid = live[0];
    }
    writeState(s);
  };

  registerExitCleanup(dispose);
  return { port: addr.port, dispose };
}

function registerExitCleanup(dispose: () => Promise<void>): void {
  const cleanup = () => {
    dispose().catch(() => {});
  };

  process.on('exit', () => {
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
  });
}
