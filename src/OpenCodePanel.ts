import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { getOrCreateProxy } from './ProxyServer';

function escapeAttr(text: string): string {
  return text.replace(/"/g, '&quot;');
}

type ConnectionState = 'checking' | 'disconnected' | 'auth-required' | 'connected' | 'starting';

interface ServerConfig {
  id: string;
  url: string;
  label?: string;
  isWsl: boolean;
  isDefault: boolean;
  serverCommand?: string;
  username?: string;
  authEnabled?: boolean;
}

export class OpenCodePanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'opencode-web-sidebar.view';

  private _view: vscode.WebviewView | undefined;
  private _isVisible = false;
  private _connectionState: ConnectionState = 'checking';
  private _statusBarItem: vscode.StatusBarItem;
  private _pollTimer: ReturnType<typeof setInterval> | undefined;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _reconnectAttempts = 0;
  private _disposed = false;
  private _isReconnecting = false;
  private _cachedUsername = '';
  private _cachedPassword = '';
  private _servers: ServerConfig[] = [];
  private _activeServerId = '';
  private _serverGeneration = 0;
  private _showServerSelector = false;
  private _proxyPort: number | undefined;
  private _proxyDispose: (() => Promise<void>) | undefined;
  private _proxyBaseUrl: string | undefined;
  private _serverProcess: ChildProcess | undefined;
  private _serverProcessId = 0;
  private _startedByUs = false;
  private _log: vscode.OutputChannel;
  private _migrationDone = false;
  private _usingEnvPassword = false;
  private _consecutiveHealthFailures = 0;
  private _consecutiveAuthRequired = 0;

  private readonly _passwordsCache = new Map<string, string>();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _secrets: vscode.SecretStorage,
    private readonly _globalState: vscode.Memento,
  ) {
    this._log = vscode.window.createOutputChannel('OpenCode Sidebar');
    this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this._statusBarItem.command = 'opencode-web-sidebar.focusPanel';
    this.updateStatusBar();
    vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
  }

  private log(msg: string): void {
    this._log.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  private async migrateFromOldSettings(): Promise<void> {
    if (this._migrationDone) return;
    this._migrationDone = true;

    const config = vscode.workspace.getConfiguration('opencode-web-sidebar');
    const inspect = config.inspect<ServerConfig[]>('servers');
    const hasExplicitServers = inspect?.globalValue !== undefined || inspect?.workspaceValue !== undefined
      || inspect?.workspaceFolderValue !== undefined;

    if (hasExplicitServers) {
      const sv = config.get<ServerConfig[]>('servers');
      if (sv && sv.length > 0) {
        this.log(`Loaded ${sv.length} servers from settings`);
        this._servers = sv;
        return;
      }
    }

    const oldUrl = config.get<string>('url', 'http://localhost:4096');
    const oldCmd = config.get<string>('serverCommand', 'opencode web --port 4096');
    const oldWsl = config.get<'none' | 'wsl'>('workspacePathStyle', 'none');

    let servers: ServerConfig[] = [];

    const oldUsername = await this._secrets.get('opencode-web-sidebar.username') || '';
    const oldPassword = await this._secrets.get('opencode-web-sidebar.password') || '';

    this.log(`Migrating from old single-server config (url=${oldUrl})`);

    const localId = 'default';
    servers.push({
      id: localId,
      url: oldUrl,
      label: 'Local Server',
      username: oldUsername,
      isWsl: oldWsl === 'wsl',
      isDefault: true,
      serverCommand: oldCmd,
      authEnabled: !!(oldUsername || oldPassword),
    });

    if (oldPassword) {
      await this._secrets.store(`opencode-web-sidebar.server.${localId}.password`, oldPassword);
      await this._secrets.delete('opencode-web-sidebar.password');
    }
    await this._secrets.delete('opencode-web-sidebar.username');

    await config.update('servers', servers, vscode.ConfigurationTarget.Global);
    this._servers = servers;
    this.log('Migration complete');
  }

  private async loadServers(): Promise<void> {
    await this.migrateFromOldSettings();

    const config = vscode.workspace.getConfiguration('opencode-web-sidebar');
    const servers = config.get<ServerConfig[]>('servers', []);
    if (servers.length > 0) {
      this._servers = servers;
    }

    for (const s of this._servers) {
      if (!this._passwordsCache.has(s.id)) {
        const pass = await this._secrets.get(`opencode-web-sidebar.server.${s.id}.password`) || '';
        this._passwordsCache.set(s.id, pass);
      }
    }

    const savedActive = this._globalState.get<string>('opencode-web-sidebar.activeServerId', '');
    const defaultServer = this._servers.find(s => s.isDefault);
    if (savedActive && this._servers.find(s => s.id === savedActive)) {
      this._activeServerId = savedActive;
    } else if (defaultServer) {
      this._activeServerId = defaultServer.id;
      await this._globalState.update('opencode-web-sidebar.activeServerId', this._activeServerId);
    } else if (this._servers.length > 0) {
      this._activeServerId = this._servers[0].id;
      await this._globalState.update('opencode-web-sidebar.activeServerId', this._activeServerId);
    }

    this.loadCredentialsForActive();
    this.log(`Active server: ${this._activeServerId}`);
  }

  private loadCredentialsForActive(): void {
    const active = this.getActiveServer();
    this._cachedUsername = active?.username || '';
    this._cachedPassword = this._passwordsCache.get(this._activeServerId) || '';
    this._usingEnvPassword = false;
    if (!this._cachedPassword && process.env.OPENCODE_SERVER_PASSWORD) {
      this.log('Using OPENCODE_SERVER_PASSWORD env var');
      this._cachedPassword = process.env.OPENCODE_SERVER_PASSWORD;
      this._usingEnvPassword = true;
      if (!this._cachedUsername) {
        this._cachedUsername = 'opencode';
      }
    }
    if (this._cachedPassword || this._cachedUsername) {
      this.log(`Credentials for ${this._activeServerId} (user: ${this._cachedUsername})`);
    }
  }

  get cachedUsername(): string {
    return this._cachedUsername;
  }

  private getActiveServer(): ServerConfig | undefined {
    return this._servers.find(s => s.id === this._activeServerId);
  }

  private async saveServerPassword(serverId: string, password: string): Promise<void> {
    this.log(`Saving password for server ${serverId}`);
    if (password) {
      await this._secrets.store(`opencode-web-sidebar.server.${serverId}.password`, password);
    } else {
      await this._secrets.delete(`opencode-web-sidebar.server.${serverId}.password`);
    }
    this._passwordsCache.set(serverId, password);
    if (serverId === this._activeServerId) {
      this.loadCredentialsForActive();
      await this.restartProxy();
      await this.pollOnce();
    }
    this.sendStateUpdate();
  }

  private async clearServerPassword(serverId: string): Promise<void> {
    this.log(`Clearing password for server ${serverId}`);
    await this._secrets.delete(`opencode-web-sidebar.server.${serverId}.password`);
    this._passwordsCache.set(serverId, '');
    if (serverId === this._activeServerId) {
      this._cachedPassword = '';
      await this.stopProxy();
      await this.pollOnce();
    }
    this.sendStateUpdate();
  }

  private async persistServers(): Promise<void> {
    const config = vscode.workspace.getConfiguration('opencode-web-sidebar');
    await config.update('servers', this._servers, vscode.ConfigurationTarget.Global);
  }

  private async switchToServer(serverId: string): Promise<void> {
    const gen = ++this._serverGeneration;
    this.log(`Switching to server: ${serverId}`);

    this._isReconnecting = false;
    this._reconnectAttempts = 0;
    this.clearReconnectTimer();
    this._showServerSelector = false;

    if (this._startedByUs && this._serverProcess && serverId !== this._activeServerId) {
      this.log('Stopping previously-started server on switch');
      this._killServerProcess();
      this._startedByUs = false;
      vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
    }

    this._activeServerId = serverId;
    await this._globalState.update('opencode-web-sidebar.activeServerId', serverId);
    this.loadCredentialsForActive();

    this._connectionState = 'checking';
    this.updateStatusBar();
    if (gen === this._serverGeneration) {
      this.render();
    }

    await this.startProxy();
    if (gen !== this._serverGeneration) return;
    await this.pollOnce();
  }

  private async updateServerConfig(serverId: string, key: string, value: any): Promise<void> {
    const server = this._servers.find(s => s.id === serverId);
    if (!server) return;

    const gen = this._serverGeneration;

    if (key === 'url') server.url = value;
    else if (key === 'label') server.label = value;
    else if (key === 'username') server.username = value;
    else if (key === 'isWsl') server.isWsl = !!value;
    else if (key === 'authEnabled') server.authEnabled = !!value;
    else if (key === 'serverCommand') server.serverCommand = value;

    await this.persistServers();
    if (serverId === this._activeServerId && gen === this._serverGeneration) {
      if (key === 'url' || key === 'isWsl') {
        this._connectionState = 'checking';
        this.updateStatusBar();
        this.render();
        await this.startProxy();
        if (gen === this._serverGeneration) {
          await this.pollOnce();
        }
      } else {
        this.sendStateUpdate();
      }
    } else {
      this.sendStateUpdate();
    }
  }

  private async setDefaultServer(serverId: string): Promise<void> {
    for (const s of this._servers) {
      s.isDefault = s.id === serverId;
    }
    await this.persistServers();
    this.sendStateUpdate();
  }

  private async removeServer(serverId: string): Promise<void> {
    const idx = this._servers.findIndex(s => s.id === serverId);
    if (idx < 0) return;

    this._servers.splice(idx, 1);
    await this.clearServerPassword(serverId);
    await this.persistServers();

    if (this._activeServerId === serverId) {
      const defaultServer = this._servers.find(s => s.isDefault) || this._servers[0];
      if (defaultServer) {
        await this.switchToServer(defaultServer.id);
      } else {
        this._activeServerId = '';
        this._connectionState = 'disconnected';
        this._showServerSelector = true;
        this.updateStatusBar();
        this.sendStateUpdate();
      }
    } else {
      this.sendStateUpdate();
    }
  }

  private async addServer(config: { url: string; label?: string; isWsl?: boolean }): Promise<void> {
    const id = `srv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this._servers.push({
      id,
      url: config.url,
      label: config.label || config.url,
      isWsl: config.isWsl || false,
      isDefault: false,
    });
    await this.persistServers();
    this.sendStateUpdate();
  }

  async saveCredentials(username: string, password: string): Promise<void> {
    await this.updateServerConfig(this._activeServerId, 'username', username);
    await this.saveServerPassword(this._activeServerId, password);
  }

  async clearCredentials(): Promise<void> {
    await this.clearServerPassword(this._activeServerId);
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
      switch (msg.type) {
        case 'closePanel':
          vscode.commands.executeCommand('opencode-web-sidebar.openPanel');
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'opencode-web-sidebar');
          break;
        case 'setPassword':
          vscode.commands.executeCommand('opencode-web-sidebar.setPassword');
          break;
        case 'refresh':
          this.render();
          break;
        case 'startServer':
          this.startServer();
          break;
        case 'stopServer':
          this.stopServer();
          break;
        case 'cancelReconnect':
          this.cancelReconnect();
          break;
        case 'selectServer':
          this._showServerSelector = !this._showServerSelector;
          this.sendStateUpdate();
          break;
        case 'connectToServer':
          if (msg.serverId) {
            await this.switchToServer(msg.serverId);
          }
          break;
        case 'startAndConnect':
          if (msg.serverId) {
            const gen = ++this._serverGeneration;
            this._showServerSelector = false;
            this._activeServerId = msg.serverId;
            await this._globalState.update('opencode-web-sidebar.activeServerId', msg.serverId);
            this.loadCredentialsForActive();
            this._connectionState = 'checking';
            this.updateStatusBar();
            this.render();
            await this.startProxy();
            if (gen !== this._serverGeneration) break;
            const state = await this.checkHealth();
            if (gen !== this._serverGeneration) break;
            if (state === 'connected' || state === 'auth-required') {
              this._connectionState = state;
              this._startedByUs = false;
              vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
              this.updateStatusBar();
              this.sendStateUpdate();
            } else {
              await this.startServer();
            }
          }
          break;
        case 'updateServerConfig':
          if (msg.serverId && msg.key !== undefined) {
            await this.updateServerConfig(msg.serverId, msg.key, msg.value);
          }
          break;
        case 'saveCredentials':
          if (msg.serverId) {
            await this.saveServerPassword(msg.serverId, msg.password || '');
          }
          break;
        case 'removeServer':
          if (msg.serverId) {
            await this.removeServer(msg.serverId);
          }
          break;
        case 'setDefaultServer':
          if (msg.serverId) {
            await this.setDefaultServer(msg.serverId);
          }
          break;
        case 'addServer':
          await this.addServer(msg.config);
          break;
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

    await this.loadServers();
    await this.startProxy();
    this.startPolling();
    this.render();
  }

  async show(): Promise<void> {
    if (this._isVisible) { return; }
    await vscode.commands.executeCommand('workbench.view.extension.opencode-web-sidebar');
  }

  async close(): Promise<void> {
    this._isVisible = false;
    this._view = undefined;
    this.stopPolling();
    try {
      await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
    } catch {
      vscode.window.showErrorMessage('Failed to close sidebar panel');
    }
  }

  render(): void {
    if (!this._view) { return; }
    this._view.webview.html = this.getHtmlContent();
    this.log('Rendered webview HTML');
  }

  async onUrlChanged(): Promise<void> {
    this.log('Config changed, reloading servers');
    await this.loadServers();
    this._connectionState = 'checking';
    this._isReconnecting = false;
    this._reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.updateStatusBar();
    this.render();
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
    const active = this.getActiveServer();
    return active ? active.url : '';
  }

  private getServerCommand(): string {
    const active = this.getActiveServer();
    if (active?.serverCommand) return active.serverCommand;
    return vscode.workspace.getConfiguration('opencode-web-sidebar').get('serverCommand', 'opencode web --port 4096');
  }

  private getWorkspaceStyle(): 'none' | 'wsl' {
    const active = this.getActiveServer();
    if (active?.isWsl) return 'wsl';
    return 'none';
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
    if (!raw) { return ''; }
    const style = this.getWorkspaceStyle();
    if (style === 'wsl' && process.platform === 'win32') {
      const translated = raw.replace(/^([A-Za-z]):\\/, (_, l: string) => `/mnt/${l.toLowerCase()}/`)
        .replace(/\\/g, '/');
      this.log(`Workspace folder translated (wsl): ${translated}`);
      return translated;
    }
    this.log(`Workspace folder: ${raw}`);
    return raw;
  }

  private computeUIState(): {
    statusColor: string;
    statusText: string;
    statusBarStop: string;
    overlayContent: string;
    overlayHidden: boolean;
    showIframe: boolean;
    iframeUrl: string;
  } {
    let statusColor: string;
    let statusText: string;
    if (this._connectionState === 'checking') {
      statusColor = '#e5c07b';
      statusText = 'Checking...';
    } else if (this._connectionState === 'starting') {
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

    const url = this.getConfiguredUrl();
    let overlayContent: string;
    if (this._showServerSelector) {
      overlayContent = this.renderServerSelector();
    } else if (!url) {
      overlayContent =
        '<span>No URL configured. Configure a server below.</span>' +
        '<div class="btn-row"><button onclick="selectServer()">Servers</button></div>';
    } else if (this._isReconnecting) {
      overlayContent =
        '<span>Connection lost, reconnecting...</span>' +
        '<div class="btn-row"><button onclick="cancelReconnect()">Cancel</button>' +
        '<button onclick="selectServer()">Servers</button></div>';
    } else if (this._connectionState === 'checking') {
      overlayContent =
        '<div class="oc-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="40" height="40" fill="none"><path fill="#f1ecec" d="M180 60H60v180h120zm60 240H0V0h240z" clip-path="url(#b)" mask="url(#a)" transform="translate(30)"/><defs><clipPath id="b" clipPathUnits="userSpaceOnUse"><path fill="#fff" d="M0 0h240v300H0z"/></clipPath><mask id="a" maskUnits="userSpaceOnUse"><path fill="#fff" d="M240 0H0v300h240z"/></mask></defs></svg></div>' +
        '<div class="spinner"></div>' +
        '<span>Connecting to server...</span>';
    } else if (this._connectionState === 'starting') {
      overlayContent =
        '<div class="spinner"></div>' +
        '<span>Starting OpenCode server...</span>';
    } else if (this._connectionState === 'auth-required') {
      overlayContent =
        '<div class="lock-icon">🔒</div>' +
        '<span>Server is online but password protected</span>' +
        '<div class="btn-row"><button onclick="setPassword()">Login with Username &amp; Password</button></div>';
    } else if (this._connectionState === 'disconnected') {
      overlayContent =
        '<span>OpenCode server is not reachable</span>' +
        '<div class="btn-row"><button onclick="selectServer()">Servers</button>' +
        '<button onclick="openSettings()">Settings</button></div>';
    } else {
      overlayContent = '';
    }

    const proxyUrl = this._proxyBaseUrl || (this._proxyPort
      ? `http://127.0.0.1:${this._proxyPort}`
      : '');
    const workspaceDir = this.getWorkspaceFolder();
    const workspaceQuery = workspaceDir
      ? `/${Buffer.from(workspaceDir).toString('base64').replace(/=+$/, '')}/session`
      : '';
    const iframeUrl = proxyUrl ? proxyUrl + workspaceQuery : '';
    const showIframe = !this._isReconnecting && this._connectionState === 'connected' && !!iframeUrl && !this._showServerSelector;
    const overlayHidden = showIframe && !this._showServerSelector;

    const statusBarStop = this._startedByUs
      ? '<a onclick="stopServer()">Stop</a><span class="separator">&nbsp;|&nbsp;</span>'
      : '';

    return { statusColor, statusText, statusBarStop, overlayContent, overlayHidden, showIframe, iframeUrl };
  }

  private sendStateUpdate(): void {
    if (!this._view) return;
    const state = this.computeUIState();
    this.log(`sendStateUpdate: state=${this._connectionState} showIframe=${state.showIframe} overlayHidden=${state.overlayHidden} iframeUrl=${state.iframeUrl ? 'set' : 'empty'}`);
    this._view.webview.postMessage({
      type: 'updateState',
      statusColor: state.statusColor,
      statusText: state.statusText,
      statusBarStop: state.statusBarStop,
      overlayContent: state.overlayContent,
      overlayHidden: state.overlayHidden,
      showIframe: state.showIframe,
      iframeUrl: state.iframeUrl,
    });
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
      this.log(`Starting proxy for ${parsed.host}${this._cachedPassword ? ' (with auth)' : ' (no auth)'}`);
      const handle = await getOrCreateProxy(targetUrl);
      this._proxyPort = handle.port;
      this._proxyDispose = handle.dispose;
      this.log(`Proxy listening on port ${this._proxyPort}`);
      this._proxyBaseUrl = await this.resolveProxyBaseUrl();
    } catch (err) {
      this.log(`Failed to start proxy: ${err}`);
    }
  }

  private async resolveProxyBaseUrl(): Promise<string | undefined> {
    try {
      if (this._proxyPort && vscode.env.remoteName) {
        const uri = vscode.Uri.parse(`http://127.0.0.1:${this._proxyPort}`);
        const external = await vscode.env.asExternalUri(uri);
        const result = external.toString().replace(/\/$/, '');
        this.log(`Resolved proxy URL (remote=${vscode.env.remoteName}): ${result}`);
        return result;
      }
    } catch (err) {
      this.log(`Failed to resolve proxy external URL: ${err}`);
    }
    return undefined;
  }

  private async stopProxy(): Promise<void> {
    if (this._proxyDispose) {
      this.log('Stopping proxy');
      await this._proxyDispose();
      this._proxyDispose = undefined;
    }
    this._proxyPort = undefined;
    this._proxyBaseUrl = undefined;
  }

  private async restartProxy(): Promise<void> {
    await this.startProxy();
    this.sendStateUpdate();
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
      this.sendStateUpdate();
      return;
    }

    const cmdStr = this.getServerCommand();
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
    this.sendStateUpdate();

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
          if (trimmed) { this.log(`[server] ${trimmed}`); }
        }
      });

      this._serverProcess.stderr?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) { this.log(`[server] ${trimmed}`); }
        }
      });

      this._serverProcess.on('error', (err) => {
        if (id !== this._serverProcessId) { return; }
        this.log(`Server process error: ${err.message}`);
        this._serverProcess = undefined;
        this.cleanupServer();
      });

      this._serverProcess.on('exit', (code, signal) => {
        if (id !== this._serverProcessId) { return; }
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
    if (!this._startedByUs || !this._serverProcess) { return; }

    this.log('Stopping server process');
    this._killServerProcess();
    this._startedByUs = false;
    vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
    await this.pollOnce();
  }

  private _killServerProcess(): void {
    if (!this._serverProcess) { return; }
    this._serverProcess.kill('SIGTERM');
    const proc = this._serverProcess;
    setTimeout(() => {
      try {
        if (proc && !proc.killed) { proc.kill('SIGKILL'); }
      } catch { /* ignore */ }
    }, 3000);
    this._serverProcess = undefined;
  }

  private cleanupServer(): void {
    if (!this._startedByUs) { return; }
    this._startedByUs = false;
    vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
    if (this._connectionState === 'starting') {
      this._connectionState = 'disconnected';
      this.updateStatusBar();
      this.sendStateUpdate();
    }
    this.stopPolling();
    this.startPolling();
  }

  private updateStatusBar(): void {
    if (this._connectionState === 'checking') {
      this._statusBarItem.text = '$(globe) OpenCode: Checking...';
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = 'Checking OpenCode server...';
      this._statusBarItem.show();
    } else if (this._connectionState === 'starting') {
      this._statusBarItem.text = '$(globe) OpenCode: Starting...';
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = 'Starting OpenCode server...';
      this._statusBarItem.show();
    } else if (this._isReconnecting) {
      this._statusBarItem.text = '$(globe) OpenCode: Reconnecting...';
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = 'Attempting to reconnect to OpenCode server';
      this._statusBarItem.show();
    } else if (this._connectionState === 'connected') {
      this._statusBarItem.text = '$(globe) OpenCode: Connected';
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = 'OpenCode server is reachable';
      this._statusBarItem.show();
    } else if (this._connectionState === 'auth-required') {
      this._statusBarItem.text = '$(key) OpenCode: Password Required';
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = 'OpenCode server requires a password — click to open panel';
      this._statusBarItem.show();
    } else {
      this._statusBarItem.text = '$(globe) OpenCode: Disconnected';
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = 'OpenCode server is not reachable — click to open panel';
      this._statusBarItem.show();
    }
  }

  private async checkHealth(): Promise<ConnectionState> {
    const url = this.getConfiguredUrl();
    if (!url) { return 'disconnected'; }

    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        method: 'HEAD',
      });
      this.log(`Health check (no auth): ${resp.status}`);
      if (resp.ok) { return 'connected'; }

      if (resp.status === 401 && this._cachedPassword) {
        const encoded = Buffer.from(`${this._cachedUsername || 'opencode'}:${this._cachedPassword}`).toString('base64');
        try {
          const authResp = await fetch(url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(3000),
            headers: { 'Authorization': `Basic ${encoded}` },
          });
          this.log(`Health check (with auth): ${authResp.status}`);
          if (authResp.ok) { return 'connected'; }
        } catch {
          this.log('Health check (with auth) failed');
          return 'auth-required';
        }
      }

      if (resp.status === 401) { return 'auth-required'; }
      return 'connected';
    } catch {
      this.log('Health check failed (server unreachable)');
      return 'disconnected';
    }
  }

  private startPolling(): void {
    if (this._pollTimer) { return; }
    this.pollOnce();
    this._pollTimer = setInterval(() => this.pollOnce(), 2500);
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
    const gen = this._serverGeneration;
    if (this._disposed) { return; }
    const state = await this.checkHealth();
    if (gen !== this._serverGeneration) { return; }
    if (state === this._connectionState && !this._isReconnecting) { return; }

    if (state === 'connected') {
      this._consecutiveAuthRequired = 0;
      if (this._connectionState !== 'connected') {
        this.stopPolling();
        this._pollTimer = setInterval(() => this.pollOnce(), 10000);
        if (this._connectionState === 'starting') {
          this.log(`Server is ready (${state})`);
        }
      }
      this._consecutiveHealthFailures = 0;
      this._isReconnecting = false;
      this._reconnectAttempts = 0;
      this.clearReconnectTimer();
      if (state !== this._connectionState) {
        this.log(`State change: ${this._connectionState} -> ${state}`);
        this._connectionState = state;
      }
      this.updateStatusBar();
      if (gen === this._serverGeneration) {
        this.sendStateUpdate();
      }
    } else if (state === 'auth-required') {
      this._consecutiveHealthFailures = 0;
      this._consecutiveAuthRequired++;
      if (this._consecutiveAuthRequired < 2) {
        return;
      }
      this._consecutiveAuthRequired = 0;
      if (this._connectionState !== 'auth-required') {
        this.stopPolling();
        this._pollTimer = setInterval(() => this.pollOnce(), 10000);
        if (this._connectionState === 'starting') {
          this.log(`Server is ready (${state})`);
        }
      }
      this._isReconnecting = false;
      this._reconnectAttempts = 0;
      this.clearReconnectTimer();
      if (state !== this._connectionState) {
        this.log(`State change: ${this._connectionState} -> ${state}`);
        this._connectionState = state;
      }
      this.updateStatusBar();
      if (gen === this._serverGeneration) {
        this.sendStateUpdate();
      }
    } else if (this._connectionState === 'starting') {
      this.log('Waiting for server to start...');
    } else if (this._connectionState === 'checking') {
      this._connectionState = 'disconnected';
      this.updateStatusBar();
      if (gen === this._serverGeneration) {
        this.sendStateUpdate();
      }
    } else {
      this._consecutiveHealthFailures++;
      if (this._consecutiveHealthFailures < 2 && this._connectionState === 'connected') {
        return;
      }
      this._isReconnecting = true;
      this._connectionState = 'disconnected';
      this.updateStatusBar();
      if (gen === this._serverGeneration) {
        this.sendStateUpdate();
      }
      this.scheduleReconnect();
    }
  }

  private cancelReconnect(): void {
    this._isReconnecting = false;
    this._reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.updateStatusBar();
    this.sendStateUpdate();
  }

  private scheduleReconnect(): void {
    if (this._disposed) { return; }
    const autoReconnect = vscode.workspace.getConfiguration('opencode-web-sidebar').get('autoReconnect', true);
    if (!autoReconnect) {
      this._isReconnecting = false;
      this.updateStatusBar();
      this.sendStateUpdate();
      return;
    }

    const maxAttempts = vscode.workspace.getConfiguration('opencode-web-sidebar').get('maxReconnectAttempts', 0);
    if (maxAttempts > 0 && this._reconnectAttempts >= maxAttempts) {
      this._isReconnecting = false;
      this.updateStatusBar();
      this.sendStateUpdate();
      return;
    }

    const delay = Math.min(Math.pow(2, this._reconnectAttempts) * 1000, 30000);
    this._reconnectAttempts++;
    const gen = this._serverGeneration;

    this.clearReconnectTimer();
    this._reconnectTimer = setTimeout(async () => {
      if (this._disposed || gen !== this._serverGeneration) { return; }
      const state = await this.checkHealth();
      if (gen !== this._serverGeneration) { return; }
      if (state === 'connected' || state === 'auth-required') {
        this._isReconnecting = false;
        this._connectionState = state;
        this._reconnectAttempts = 0;
        this.updateStatusBar();
        this.sendStateUpdate();
      } else {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private renderServerRow(server: ServerConfig, isLocal: boolean): string {
    const activeId = this._activeServerId;
    const isActive = server.id === activeId;
    const hasPassword = !!(this._passwordsCache.get(server.id));
    const usingEnv = isActive && this._usingEnvPassword && !hasPassword;
    const isDefault = server.isDefault;
    const authEnabled = server.authEnabled ?? true;

    const urlValue = escapeAttr(server.url);

    let actions: string;

    if (isLocal) {
      const showStartAndConnect = !isActive;
      actions = `<div class="srv-actions srv-actions-local">`;
      if (showStartAndConnect) {
        actions += `<button class="srv-btn srv-btn-primary" onclick="startAndConnect('${server.id}')">START AND CONNECT</button>`;
      } else {
        actions += `<div class="srv-spacer"></div>`;
      }
      if (isActive) {
        actions += `<div class="srv-active-badge">ACTIVE</div>`;
      } else {
        actions += `<button class="srv-btn" onclick="connectToServer('${server.id}')">CONNECT</button>`;
      }
      const showDefaultBadge = isDefault;
      if (showDefaultBadge) {
        actions += `<span class="srv-default-badge srv-default-visible">default</span>`;
      } else {
        actions += `<span class="srv-default-badge"></span>`;
      }
      actions += `</div>`;
    } else {
      actions = `<div class="srv-actions">`;
      if (isActive) {
        actions += `<div class="srv-active-badge">ACTIVE</div>`;
      } else {
        actions += `<button class="srv-btn" onclick="connectToServer('${server.id}')">CONNECT</button>`;
      }
      if (isDefault) {
        actions += `<span class="srv-default-badge"></span>`;
      } else {
        actions += `<span class="srv-default-badge srv-default-hover" onclick="setDefaultServer('${server.id}')">default</span>`;
      }
      actions += `</div>`;
    }

    const userPlaceholder = (usingEnv && !server.username) ? '[Using opencode]' : 'Username';
    const passPlaceholder = usingEnv ? '[Using OPENCODE_SERVER_PASSWORD]' : hasPassword ? '••••••••' : 'Password';
    const authFieldsStyle = authEnabled ? '' : ' style="display:none"';

    const fields = `<div class="srv-fields">
      <input class="srv-url" type="text" value="${urlValue}" onchange="updateServerConfig('${server.id}','url',this.value)" placeholder="http://localhost:4096">
      <div class="srv-field-row"${authFieldsStyle}>
        <input class="srv-user" id="user-${server.id}" type="text" placeholder="${userPlaceholder}" value="${escapeAttr(server.username || '')}" onchange="updateServerConfig('${server.id}','username',this.value)">
        <input class="srv-pass" id="pass-${server.id}" type="password" placeholder="${passPlaceholder}" onchange="saveCredentials('${server.id}',this.value)">
      </div>
      <div class="srv-toggle-row">
        <label class="srv-toggle">
          <input type="checkbox" ${authEnabled ? 'checked' : ''} onchange="updateServerConfig('${server.id}','authEnabled',this.checked)">
          <span>authentication</span>
        </label>
        <label class="srv-toggle">
          <input type="checkbox" ${server.isWsl ? 'checked' : ''} onchange="updateServerConfig('${server.id}','isWsl',this.checked)">
          <span>is WSL / Linux</span>
        </label>
      </div>
    </div>`;

    const trashSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="pointer-events:none;display:block;opacity:0.6" title="Remove server"><path d="M6.5 1.5H5V3h6V1.5H9.5L9 1H7L6.5 1.5zM3 4v1h1v9.5c0 .3.2.5.5.5h7c.3 0 .5-.2.5-.5V5h1V4H3zm2 1h6v9H5V5z"/></svg>';
    const removeBtn = `<div class="srv-remove" onclick="removeServer('${server.id}')">${trashSvg}</div>`;

    return `<div class="srv-row" data-id="${server.id}">${actions}${fields}${removeBtn}</div>`;
  }

  private getHtmlContent(): string {
    const url = this.getConfiguredUrl();
    const activeServer = this.getActiveServer();

    this.log(`Generating HTML (state=${this._connectionState}, showSelector=${this._showServerSelector})`);

    const uiState = this.computeUIState();
    const { statusColor, statusText, statusBarStop, overlayContent, overlayHidden, showIframe, iframeUrl } = uiState;

    const origin = this.getUrlOrigin(url);

    const proxyOrigin = this._proxyBaseUrl
      ? new URL(this._proxyBaseUrl).origin
      : (this._proxyPort ? `http://127.0.0.1:${this._proxyPort}` : '');
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

    const iframeSrc = iframeUrl
      ? `src="${escapeAttr(iframeUrl)}"` : '';

    this.log(`iframe URL: ${iframeUrl} (showIframe=${showIframe})`);

    const activeLabel = activeServer?.label || activeServer?.url || 'Server';

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
    input { font-family:inherit; font-size:inherit; }
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
    .separator { color:inherit; opacity:.35; }
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
    .overlay .oc-icon {
      display:flex; align-items:center; justify-content:center; opacity:.5;
      margin-bottom:8px;
    }
    .overlay .spinner {
      width:24px; height:24px; border:3px solid var(--vscode-descriptionForeground,#999);
      border-top-color:transparent; border-radius:50%;
      animation:spin .8s linear infinite;
    }
    @keyframes spin { to { transform:rotate(360deg); } }

    .server-selector {
      width:100%; height:100%; overflow-y:auto; padding:12px;
      display:flex; flex-direction:column; gap:8px;
    }
    .server-selector .btn-row {
      display:flex; gap:8px; justify-content:center; margin-top:8px; flex-shrink:0;
    }
    .server-selector .btn-row button {
      padding:6px 14px; border:none; cursor:pointer; border-radius:2px;
      background:var(--vscode-button-background,#007acc);
      color:var(--vscode-button-foreground,#fff);
      font-family:var(--vscode-font-family,sans-serif); font-size:12px;
    }
    .server-selector .btn-row button:hover {
      opacity:.9;
    }
    .srv-row {
      display:grid; grid-template-columns:auto 1fr auto; gap:8px;
      padding:10px; border-radius:4px;
      background:var(--vscode-sideBar-background,#1e1e1e);
      border:1px solid var(--vscode-sideBar-border,transparent);
    }
    .srv-row:hover {
      background:var(--vscode-list-hoverBackground,#2a2d2e);
    }
    .srv-actions {
      display:flex; flex-direction:column; gap:4px; align-items:center; justify-content:center; min-width:90px;
    }
    .srv-actions-local {
      justify-content:flex-start;
    }
    .srv-btn {
      padding:4px 10px; border:none; cursor:pointer; border-radius:2px; font-size:11px; white-space:nowrap;
      background:var(--vscode-button-background,#007acc);
      color:var(--vscode-button-foreground,#fff);
      font-family:var(--vscode-font-family,sans-serif);
    }
    .srv-btn:hover { opacity:.85; }
    .srv-btn-primary {
      background:var(--vscode-button-hoverBackground,#006bb3);
    }
    .srv-active-badge {
      padding:4px 10px; border-radius:2px; font-size:11px; font-weight:600; white-space:nowrap;
      background:var(--vscode-inputValidation-infoBackground,#063b6d);
      color:var(--vscode-inputValidation-infoBorder,#3794ff);
      border:1px solid var(--vscode-inputValidation-infoBorder,#3794ff);
    }
    .srv-spacer { height:26px; }
    .srv-default-badge {
      font-size:10px; padding:1px 6px; border-radius:3px; cursor:pointer;
      background:var(--vscode-badge-background,#4d4d4d);
      color:var(--vscode-badge-foreground,#fff);
      transition:opacity .15s; opacity:0; pointer-events:none;
    }
    .srv-default-hover {
      pointer-events:auto;
    }
    .srv-row:hover .srv-default-hover {
      opacity:1;
    }
    .srv-default-visible {
      opacity:1; pointer-events:none;
    }
    .srv-fields {
      display:flex; flex-direction:column; gap:4px; min-width:0;
    }
    .srv-field-row {
      display:flex; gap:4px;
    }
    .srv-url {
      width:100%; padding:4px 6px; border:1px solid var(--vscode-input-border,#3c3c3c); border-radius:2px;
      background:var(--vscode-input-background,#3c3c3c); color:var(--vscode-input-foreground,#ccc);
      font-family:var(--vscode-font-family,sans-serif); font-size:12px;
    }
    .srv-user, .srv-pass {
      flex:1; min-width:0; padding:4px 6px; border:1px solid var(--vscode-input-border,#3c3c3c); border-radius:2px;
      background:var(--vscode-input-background,#3c3c3c); color:var(--vscode-input-foreground,#ccc);
      font-family:var(--vscode-font-family,sans-serif); font-size:12px;
    }
    .srv-toggle-row {
      display:flex; align-items:center; gap:12px; flex-wrap:wrap;
    }
    .srv-toggle {
      display:flex; align-items:center; gap:4px; cursor:pointer; font-size:11px; padding:2px 0;
    }
    .srv-toggle input { cursor:pointer; }
    .srv-remove {
      display:flex; align-items:center; justify-content:center; min-width:24px;
    }
    .srv-remove svg:hover { opacity:1 !important; }

    .local-server-section {
      margin-top:16px; padding-top:12px;
      border-top:1px solid var(--vscode-sideBar-border,#3c3c3c);
    }
    .section-title {
      text-align:center; font-size:12px; font-weight:600; text-transform:uppercase;
      color:var(--vscode-descriptionForeground,#999); margin-bottom:10px;
      letter-spacing:.5px;
    }
  </style>
</head>
<body>
  <div class="status-bar">
    <span class="dot" id="statusDot" style="background:${statusColor}"></span>
    <span id="statusText">${statusText}</span>
    <span class="spacer"></span>
    <span id="statusBarActions">${statusBarStop}</span>
    <a onclick="refresh()">Refresh</a>
    <span class="separator">&nbsp;|&nbsp;</span>
    <a onclick="selectServer()">Servers</a>
    <span class="separator">&nbsp;|&nbsp;</span>
    <a onclick="closePanel()">Close</a>
  </div>

  <iframe id="ocFrame" onload="sendWorkspace()" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    ${iframeSrc}></iframe>

  <div id="overlay" class="overlay ${overlayHidden ? 'hidden' : ''}">
    ${overlayContent}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    claimFocus();
    [50, 150, 400, 1000].forEach(d => setTimeout(claimFocus, d));

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'updateState') {
        document.getElementById('statusDot').style.background = msg.statusColor;
        document.getElementById('statusText').textContent = msg.statusText;
        document.getElementById('statusBarActions').innerHTML = msg.statusBarStop || '';
        document.getElementById('overlay').innerHTML = msg.overlayContent;
        document.getElementById('overlay').className = 'overlay' + (msg.overlayHidden ? ' hidden' : '');
        const iframe = document.getElementById('ocFrame');
        if (iframe) {
          iframe.style.display = msg.showIframe ? 'block' : 'none';
          if (msg.iframeUrl && (!iframe.src || iframe.src === '' || iframe.src === 'about:blank')) {
            iframe.src = msg.iframeUrl;
          }
        }
      }
    });

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
      const iframe = document.getElementById('ocFrame');
      if (iframe && iframe.src) {
        iframe.src = iframe.src;
      }
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

    function selectServer() {
      vscode.postMessage({ type: 'selectServer' });
    }

    function connectToServer(serverId) {
      vscode.postMessage({ type: 'connectToServer', serverId });
    }

    function startAndConnect(serverId) {
      vscode.postMessage({ type: 'startAndConnect', serverId });
    }

    function updateServerConfig(serverId, key, value) {
      vscode.postMessage({ type: 'updateServerConfig', serverId, key, value });
    }

    function saveCredentials(serverId, password) {
      vscode.postMessage({ type: 'saveCredentials', serverId, password });
    }

    function removeServer(serverId) {
      if (confirm('Remove this server?')) {
        vscode.postMessage({ type: 'removeServer', serverId });
      }
    }

    function setDefaultServer(serverId) {
      vscode.postMessage({ type: 'setDefaultServer', serverId });
    }

    function addServer() {
      vscode.postMessage({ type: 'addServer', config: { url: 'http://', label: '' } });
    }

    function claimFocus() {
      document.body.setAttribute('tabindex', '-1');
      document.body.focus();
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
      claimFocus();
      [50, 150, 400, 1000].forEach(d => setTimeout(claimFocus, d));
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

  private renderServerSelector(): string {
    const regularServers = this._servers.filter(s => s.id !== 'default');
    const localServer = this._servers.find(s => s.id === 'default');

    const regularHtml = regularServers.map(s => this.renderServerRow(s, false)).join('\n');
    const localHtml = localServer ? this.renderServerRow(localServer, true) : '';

    return `<div class="server-selector">
      ${regularHtml}
      <div class="local-server-section">
        <div class="section-title">Local Server</div>
        ${localHtml || '<span style="font-size:12px;opacity:.7">No local server configured</span>'}
      </div>
      <div class="btn-row">
        <button onclick="addServer()">+ Add Server</button>
      </div>
    </div>`;
  }
}
