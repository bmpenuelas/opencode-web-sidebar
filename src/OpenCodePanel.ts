import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { startProxy, type ProxyServer } from './ProxyServer';

function escapeAttr(text: string): string {
  return text.replace(/"/g, '&quot;');
}

type ConnectionState = 'disconnected' | 'auth-required' | 'connected' | 'starting';

export class OpenCodePanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'opencode-web-sidebar.view';

  private _view: vscode.WebviewView | undefined;
  private _isVisible = false;
  private _connectionState: ConnectionState = 'disconnected';
  private _statusBarItem: vscode.StatusBarItem;
  private _pollTimer: ReturnType<typeof setInterval> | undefined;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _reconnectAttempts = 0;
  private _disposed = false;
  private _isReconnecting = false;
  private _cachedUsername = '';
  private _cachedPassword = '';
  private _proxy: ProxyServer | undefined;
  private _serverProcess: ChildProcess | undefined;
  private _serverProcessId = 0;
  private _startedByUs = false;
  private _log: vscode.OutputChannel;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _secrets: vscode.SecretStorage,
  ) {
    this._log = vscode.window.createOutputChannel('OpenCode Sidebar');
    this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this._statusBarItem.command = 'opencode-web-sidebar.focusPanel';
    this.loadCachedCredentials();
    this.updateStatusBar();
    vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.onWorkspaceFoldersChanged());
  }

  private log(msg: string): void {
    this._log.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  private async loadCachedCredentials(): Promise<void> {
    this._cachedUsername = await this._secrets.get('opencode-web-sidebar.username') || '';
    this._cachedPassword = await this._secrets.get('opencode-web-sidebar.password') || '';
    if (!this._cachedPassword && process.env.OPENCODE_SERVER_PASSWORD) {
      this.log('Using OPENCODE_SERVER_PASSWORD env var');
      this._cachedPassword = process.env.OPENCODE_SERVER_PASSWORD;
      if (!this._cachedUsername) {
        this._cachedUsername = 'opencode';
      }
    }
    if (this._cachedPassword) {
      this.log(`Credentials loaded (user: ${this._cachedUsername})`);
    }
  }

  get cachedUsername(): string {
    return this._cachedUsername;
  }

  async saveCredentials(username: string, password: string): Promise<void> {
    this.log('Saving credentials');
    await this._secrets.store('opencode-web-sidebar.username', username);
    await this._secrets.store('opencode-web-sidebar.password', password);
    this._cachedUsername = username;
    this._cachedPassword = password;
    await this.restartProxy();
    await this.pollOnce();
  }

  async clearCredentials(): Promise<void> {
    this.log('Clearing credentials');
    await this._secrets.delete('opencode-web-sidebar.username');
    await this._secrets.delete('opencode-web-sidebar.password');
    this._cachedUsername = '';
    this._cachedPassword = '';
    await this.stopProxy();
    await this.pollOnce();
  }

  get isVisible(): boolean {
    return this._isVisible;
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this._view = webviewView;
    this._isVisible = true;
    this.log('Webview resolved');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      this.log(`Message from webview: ${JSON.stringify(msg)}`);
      if (msg.type === 'closePanel') {
        vscode.commands.executeCommand('opencode-web-sidebar.openPanel');
      } else if (msg.type === 'openSettings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'opencode-web-sidebar');
      } else if (msg.type === 'setPassword') {
        vscode.commands.executeCommand('opencode-web-sidebar.setPassword');
      } else if (msg.type === 'refresh') {
        this.render();
      } else if (msg.type === 'startServer') {
        this.startServer();
      } else if (msg.type === 'stopServer') {
        this.stopServer();
      } else if (msg.type === 'cancelReconnect') {
        this.cancelReconnect();
      }
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
      this._isVisible = false;
      this.stopPolling();
      this.log('Webview disposed');
    });

    webviewView.onDidChangeVisibility(() => {
      this._isVisible = webviewView.visible;
      this.log(`Visibility changed: ${this._isVisible}`);
      if (this._isVisible) {
        this.startPolling();
      } else {
        this.stopPolling();
      }
    });

    await this.loadCachedCredentials();
    await this.startProxy();
    this.startPolling();
    this.render();
  }

  async show(): Promise<void> {
    if (this._isVisible) {return;}
    await vscode.commands.executeCommand('workbench.view.extension.opencode-web-sidebar');
  }

  async close(): Promise<void> {
    this._isVisible = false;
    this._view = undefined;
    this.stopPolling();
    try {
      await vscode.commands.executeCommand('workbench.action.agentToggleSecondarySidebarVisibility');
    } catch {
      await vscode.commands.executeCommand('workbench.action.toggleSecondarySidebarVisibility');
    }
  }

  render(): void {
    if (!this._view) {return;}
    this._view.webview.html = this.getHtmlContent();
    this.log('Rendered webview HTML');
  }

  async onUrlChanged(): Promise<void> {
    this.log('URL config changed');
    await this.startProxy();
    await this.pollOnce();
  }

  dispose(): void {
    this._disposed = true;
    if (this._startedByUs && this._serverProcess) {
      this.log('Killing server on deactivate');
      this._killServerProcess();
    }
    this.stopProxy();
    this.stopPolling();
    this.clearReconnectTimer();
    this._statusBarItem.dispose();
    this._log.dispose();
  }

  private getConfiguredUrl(): string {
    return vscode.workspace.getConfiguration('opencode-web-sidebar').get('url', 'http://localhost:4096');
  }

  private getUrlOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  private getWorkspaceFolder(): string {
    const raw = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    this.log(`Workspace folder raw: ${raw || '(none)'}`);
    if (!raw) {return '';}
    const style = vscode.workspace.getConfiguration('opencode-web-sidebar')
      .get<'none' | 'wsl'>('workspacePathStyle', 'none');
    if (style === 'wsl' && process.platform === 'win32') {
      const translated = raw.replace(/^([A-Za-z]):\\/, (_, l: string) => `/mnt/${l.toLowerCase()}/`)
                .replace(/\\/g, '/');
      this.log(`Workspace folder translated (wsl): ${translated}`);
      return translated;
    }
    this.log(`Workspace folder: ${raw}`);
    return raw;
  }

  private async startProxy(): Promise<void> {
    await this.stopProxy();
    const url = this.getConfiguredUrl();
    if (!url) {
      this.log('No URL configured, skipping proxy');
      return;
    }
    try {
      const parsed = new URL(url);
      if (this._cachedPassword) {
        parsed.username = this._cachedUsername || 'opencode';
        parsed.password = this._cachedPassword;
      }
      const targetUrl = parsed.toString();
      const wsFolder = this.getWorkspaceFolder();
      this.log(`Starting proxy for ${parsed.host} workspace=${wsFolder || '(none)'}${this._cachedPassword ? ' (with auth)' : ' (no auth)'}`);
      this._proxy = await startProxy(targetUrl, wsFolder);
      this.log(`Proxy listening on port ${this._proxy.port}`);
    } catch (err) {
      this.log(`Failed to start proxy: ${err}`);
    }
  }

  private onWorkspaceFoldersChanged(): void {
    this._proxy?.setWorkspaceFolder(this.getWorkspaceFolder());
  }

  private async stopProxy(): Promise<void> {
    if (this._proxy) {
      this.log('Stopping proxy');
      this._proxy.dispose();
      this._proxy = undefined;
    }
  }

  private async restartProxy(): Promise<void> {
    await this.startProxy();
    this.render();
  }

  async startServer(): Promise<void> {
    if (this._connectionState === 'connected' || this._connectionState === 'starting') {
      return;
    }

    const state = await this.checkHealth();
    if (state === 'connected' || state === 'auth-required') {
      this._connectionState = state;
      this._startedByUs = false;
      vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
      this.updateStatusBar();
      this.render();
      return;
    }

    const cmdStr = vscode.workspace.getConfiguration('opencode-web-sidebar')
      .get('serverCommand', 'opencode web --port 4096');
    if (!cmdStr) {
      this.log('No server command configured');
      return;
    }

    const parts = cmdStr.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    this.log(`Starting server: ${cmdStr}`);

    this._connectionState = 'starting';
    this._isReconnecting = false;
    this._startedByUs = true;
    vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', true);
    this.updateStatusBar();
    this.render();

    this.stopPolling();
    this._pollTimer = setInterval(() => this.pollOnce(), 2000);

    try {
      const id = ++this._serverProcessId;
      this._serverProcess = spawn(cmd, args, {
        cwd: workspaceFolder,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this._serverProcess.stdout?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) {this.log(`[server] ${trimmed}`);}
        }
      });

      this._serverProcess.stderr?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) {this.log(`[server] ${trimmed}`);}
        }
      });

      this._serverProcess.on('error', (err) => {
        if (id !== this._serverProcessId) {return;}
        this.log(`Server process error: ${err.message}`);
        this._serverProcess = undefined;
        this.cleanupServer();
      });

      this._serverProcess.on('exit', (code, signal) => {
        if (id !== this._serverProcessId) {return;}
        this.log(`Server process exited (code=${code}, signal=${signal})`);
        this._serverProcess = undefined;
        this.cleanupServer();
      });
    } catch (err) {
      this.log(`Failed to spawn server: ${err}`);
      this.cleanupServer();
    }
  }

  async stopServer(): Promise<void> {
    if (!this._startedByUs || !this._serverProcess) {return;}

    this.log('Stopping server process');
    this._killServerProcess();
    this._startedByUs = false;
    vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
    await this.pollOnce();
  }

  private _killServerProcess(): void {
    if (!this._serverProcess) {return;}
    this._serverProcess.kill('SIGTERM');
    const proc = this._serverProcess;
    setTimeout(() => {
      try {
        if (proc && !proc.killed) {proc.kill('SIGKILL');}
      } catch { /* ignore */ }
    }, 3000);
    this._serverProcess = undefined;
  }

  private cleanupServer(): void {
    if (!this._startedByUs) {return;}
    this._startedByUs = false;
    vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
    if (this._connectionState === 'starting') {
      this._connectionState = 'disconnected';
      this.updateStatusBar();
      this.render();
    }
    this.stopPolling();
    this.startPolling();
  }

  private updateStatusBar(): void {
    if (this._connectionState === 'starting') {
      this._statusBarItem.text = '$(globe) OpenCode: Starting...';
      this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this._statusBarItem.tooltip = 'Starting OpenCode server...';
      this._statusBarItem.show();
    } else if (this._isReconnecting) {
      this._statusBarItem.text = '$(globe) OpenCode: Reconnecting...';
      this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this._statusBarItem.tooltip = 'Attempting to reconnect to OpenCode server';
      this._statusBarItem.show();
    } else if (this._connectionState === 'connected') {
      this._statusBarItem.text = '$(globe) OpenCode: Connected';
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = 'OpenCode server is reachable';
      this._statusBarItem.show();
    } else if (this._connectionState === 'auth-required') {
      this._statusBarItem.text = '$(key) OpenCode: Password Required';
      this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this._statusBarItem.tooltip = 'OpenCode server requires a password — click to open panel';
      this._statusBarItem.show();
    } else {
      this._statusBarItem.text = '$(globe) OpenCode: Disconnected';
      this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this._statusBarItem.tooltip = 'OpenCode server is not reachable — click to open panel';
      this._statusBarItem.show();
    }
  }

  private async checkHealth(): Promise<ConnectionState> {
    const url = this.getConfiguredUrl();
    if (!url) {return 'disconnected';}

    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        method: 'HEAD',
      });
      this.log(`Health check (no auth): ${resp.status}`);
      if (resp.ok) {return 'connected';}

      if (resp.status === 401 && this._cachedPassword) {
        const encoded = Buffer.from(`${this._cachedUsername || 'opencode'}:${this._cachedPassword}`).toString('base64');
        try {
          const authResp = await fetch(url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(3000),
            headers: { 'Authorization': `Basic ${encoded}` },
          });
          this.log(`Health check (with auth): ${authResp.status}`);
          if (authResp.ok) {return 'connected';}
        } catch {
          this.log('Health check (with auth) failed');
          return 'auth-required';
        }
      }

      if (resp.status === 401) {return 'auth-required';}
      return 'connected';
    } catch {
      this.log('Health check failed (server unreachable)');
      return 'disconnected';
    }
  }

  private startPolling(): void {
    if (this._pollTimer) {return;}
    this.pollOnce();
    this._pollTimer = setInterval(() => this.pollOnce(), 10000);
  }

  private stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  private clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this._disposed) {return;}
    const state = await this.checkHealth();
    if (state === this._connectionState && !this._isReconnecting) {return;}

    if (state === 'connected' || state === 'auth-required') {
      if (this._connectionState === 'starting') {
        this.log(`Server is ready (${state})`);
        this.stopPolling();
        this._pollTimer = setInterval(() => this.pollOnce(), 10000);
      }
      this._isReconnecting = false;
      this._reconnectAttempts = 0;
      this.clearReconnectTimer();
      if (state !== this._connectionState) {
        this.log(`State change: ${this._connectionState} -> ${state}`);
        this._connectionState = state;
      }
      this.updateStatusBar();
      this.render();
    } else if (this._connectionState === 'starting') {
      this.log('Waiting for server to start...');
    } else {
      this._isReconnecting = true;
      this._connectionState = 'disconnected';
      this.updateStatusBar();
      this.render();
      this.scheduleReconnect();
    }
  }

  private cancelReconnect(): void {
    this._isReconnecting = false;
    this._reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.updateStatusBar();
    this.render();
  }

  private scheduleReconnect(): void {
    if (this._disposed) {return;}
    const autoReconnect = vscode.workspace.getConfiguration('opencode-web-sidebar').get('autoReconnect', true);
    if (!autoReconnect) {
      this._isReconnecting = false;
      this.updateStatusBar();
      this.render();
      return;
    }

    const maxAttempts = vscode.workspace.getConfiguration('opencode-web-sidebar').get('maxReconnectAttempts', 0);
    if (maxAttempts > 0 && this._reconnectAttempts >= maxAttempts) {
      this._isReconnecting = false;
      this.updateStatusBar();
      this.render();
      return;
    }

    const delay = Math.min(Math.pow(2, this._reconnectAttempts) * 1000, 30000);
    this._reconnectAttempts++;

    this.clearReconnectTimer();
    this._reconnectTimer = setTimeout(async () => {
      if (this._disposed) {return;}
      const state = await this.checkHealth();
      if (state === 'connected' || state === 'auth-required') {
        this._isReconnecting = false;
        this._connectionState = state;
        this._reconnectAttempts = 0;
        this.updateStatusBar();
        this.render();
      } else {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private getHtmlContent(): string {
    const url = this.getConfiguredUrl();
    const proxyUrl = this._proxy
      ? `http://127.0.0.1:${this._proxy.port}`
      : '';
    const origin = this.getUrlOrigin(url);

    this.log(`Generating HTML (state=${this._connectionState}, proxyPort=${this._proxy?.port ?? 'none'})`);

    let statusColor: string;
    let statusText: string;
    if (this._connectionState === 'starting') {
      statusColor = '#e5c07b';
      statusText = 'Starting...';
    } else if (this._isReconnecting) {
      statusColor = '#e06c75';
      statusText = 'Reconnecting...';
    } else if (this._connectionState === 'connected') {
      statusColor = '#4ec94e';
      statusText = 'Connected';
    } else if (this._connectionState === 'auth-required') {
      statusColor = '#e5c07b';
      statusText = 'Password Required';
    } else {
      statusColor = '#e06c75';
      statusText = 'Disconnected';
    }

    let overlayContent: string;
    const showIframe = !this._isReconnecting && this._connectionState === 'connected' && proxyUrl;
    if (showIframe) {
      overlayContent = '';
    } else if (!url) {
      overlayContent =
        '<span>No URL configured. Set <code>opencode-web-sidebar.url</code> in settings.</span>' +
        '<div class="btn-row"><button onclick="openSettings()">Open Settings</button></div>';
    } else if (this._isReconnecting) {
      overlayContent =
        '<span>Connection lost, reconnecting...</span>' +
        '<div class="btn-row"><button onclick="cancelReconnect()">Cancel</button>' +
        '<button onclick="openSettings()">Settings</button></div>';
    } else if (this._connectionState === 'starting') {
      overlayContent =
        '<div class="spinner"></div>' +
        '<span>Starting OpenCode server...</span>';
    } else if (this._connectionState === 'auth-required') {
      overlayContent =
        '<div class="lock-icon">\uD83D\uDD12</div>' +
        '<span>Server is online but password protected</span>' +
        '<div class="btn-row"><button onclick="setPassword()">Login with Username &amp; Password</button></div>';
    } else if (this._connectionState === 'disconnected') {
      overlayContent =
        '<span>OpenCode server is not reachable</span>' +
        '<div class="btn-row"><button onclick="startServer()">Start OpenCode Web Server</button>' +
        '<button onclick="openSettings()">Settings</button></div>';
    } else {
      overlayContent = '';
    }

    const statusBarStop = this._startedByUs
      ? '<a onclick="stopServer()">Stop</a>'
      : '';
    const proxyOrigin = proxyUrl
      ? `http://127.0.0.1:${this._proxy!.port}`
      : '';
    const frameSrc = proxyOrigin
      ? `frame-src ${proxyOrigin};`
      : origin
        ? `frame-src ${origin};`
        : "frame-src http://127.0.0.1:* http://localhost:*;";

    const imgSrc = proxyOrigin || origin || 'http://127.0.0.1:* http://localhost:* https:';
    const connectSrc = proxyOrigin || origin || 'http://127.0.0.1:* http://localhost:*';

    const csp = [
      "default-src 'self';",
      frameSrc,
      "style-src 'self' 'unsafe-inline';",
      "script-src 'self' 'unsafe-inline';",
      `img-src 'self' ${imgSrc} data:;`,
      `connect-src 'self' ${connectSrc} data:;`,
      "font-src 'self' data:;",
    ].join(' ');

    const workspaceDir = this.getWorkspaceFolder();
    const workspaceQuery = workspaceDir
      ? `/${Buffer.from(workspaceDir).toString('base64').replace(/=+$/, '')}`
      : '';

    const iframeSrc = showIframe
      ? `src="${escapeAttr(proxyUrl + workspaceQuery)}"` : '';

    this.log(`iframe URL: ${proxyUrl}${workspaceQuery} (showIframe=${showIframe})`);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>OpenCode</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { height:100%; width:100%; overflow:hidden; background:var(--vscode-sideBar-background,#1e1e1e); }
    iframe { width:100%; height:calc(100% - 24px); border:none; }
    .status-bar {
      height:24px; display:flex; align-items:center; padding:0 10px;
      font-family:var(--vscode-font-family,sans-serif); font-size:11px;
      background:var(--vscode-statusBar-background,#007acc);
      color:var(--vscode-statusBar-foreground,#fff);
      gap:6px; user-select:none;
    }
    .status-bar .dot {
      display:inline-block; width:8px; height:8px; border-radius:50%;
      background:${statusColor}; flex-shrink:0;
    }
    .status-bar .spacer { flex:1; }
    .status-bar a {
      color:inherit; opacity:.7; text-decoration:none; cursor:pointer;
    }
    .status-bar a:hover { opacity:1; text-decoration:underline; }
    .overlay {
      position:absolute; inset:24px 0 0 0; display:flex; flex-direction:column;
      align-items:center; justify-content:center; gap:10px;
      color:var(--vscode-descriptionForeground,#999);
      font-family:var(--vscode-font-family,sans-serif); font-size:13px;
      padding:20px;
    }
    .overlay.hidden { display:none; }
    .overlay .lock-icon { font-size:32px; }
    .overlay code { font-size:12px; opacity:.8; }
    .overlay .btn-row { display:flex; gap:8px; margin-top:4px; }
    .overlay button {
      padding:8px 16px; border:none; cursor:pointer; border-radius:2px;
      background:var(--vscode-button-background,#007acc);
      color:var(--vscode-button-foreground,#fff);
      font-family:var(--vscode-font-family,sans-serif);
    }
    .overlay .spinner {
      width:24px; height:24px; border:3px solid var(--vscode-descriptionForeground,#999);
      border-top-color:transparent; border-radius:50%;
      animation:spin .8s linear infinite;
    }
    @keyframes spin { to { transform:rotate(360deg); } }
  </style>
</head>
<body>
  <div class="status-bar">
    <span class="dot"></span>
    <span>${statusText}</span>
    <span class="spacer"></span>
    ${statusBarStop ? `<a onclick="stopServer()">Stop</a>` : ''}
    <a onclick="refresh()" style="margin-left:8px">Refresh</a>
    <a onclick="closePanel()" style="margin-left:8px">Close</a>
  </div>

  <iframe id="ocFrame" onload="sendWorkspace()" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    ${iframeSrc}></iframe>

  <div id="overlay" class="overlay ${showIframe ? 'hidden' : ''}">
    ${overlayContent}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function openSettings() {
      vscode.postMessage({ type: 'openSettings' });
    }

    function closePanel() {
      vscode.postMessage({ type: 'closePanel' });
    }

    function setPassword() {
      vscode.postMessage({ type: 'setPassword' });
    }

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    function startServer() {
      vscode.postMessage({ type: 'startServer' });
    }

    function stopServer() {
      vscode.postMessage({ type: 'stopServer' });
    }

    function cancelReconnect() {
      vscode.postMessage({ type: 'cancelReconnect' });
    }

    function sendWorkspace() {
      const iframe = document.getElementById('ocFrame');
      const folder = ${JSON.stringify(this.getWorkspaceFolder())};
      if (iframe && iframe.contentWindow && folder) {
        const origin = iframe.src ? new URL(iframe.src).origin : '*';
        const b64 = btoa(folder).replace(/=+$/, '');
        iframe.contentWindow.postMessage(
          { type: 'openProject', path: folder, dir: b64, source: 'vscode' }, origin
        );
      }
    }

    function syncTheme() {
      const classes = document.body.className;
      const theme = classes.includes('vscode-dark') ? 'dark'
        : classes.includes('vscode-high-contrast') ? 'high-contrast'
        : 'light';
      const iframe = document.getElementById('ocFrame');
      if (iframe && iframe.contentWindow) {
        const origin = iframe.src ? new URL(iframe.src).origin : '*';
        iframe.contentWindow.postMessage(
          { type: 'opencodeTheme', theme, source: 'vscode' }, origin
        );
      }
    }

    syncTheme();
    const obs = new MutationObserver(syncTheme);
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  </script>
</body>
</html>`;
  }
}
