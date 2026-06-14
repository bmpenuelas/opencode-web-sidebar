import * as http from 'http';

const BLOCKED_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
]);

export interface ProxyServer {
  port: number;
  dispose(): void;
  setWorkspaceFolder(folder: string): void;
}

export function startProxy(targetUrl: string, workspaceFolder = ''): Promise<ProxyServer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const targetHost = parsed.host;
    const connectHost = targetHost.replace(/^localhost:/i, '127.0.0.1:');
    const auth =
      parsed.username
        ? `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64')}`
        : null;

    const baseUrl = `http://${connectHost}`;
    let currentWorkspace = workspaceFolder;

    const server = http.createServer((req, res) => {
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
      if (currentWorkspace) {
        headers['x-workspace-folder'] = currentWorkspace;
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
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({
          port: addr.port,
          setWorkspaceFolder: (folder) => { currentWorkspace = folder; },
          dispose: () => server.close(),
        });
      } else {
        reject(new Error('Failed to get proxy port'));
      }
    });
  });
}
