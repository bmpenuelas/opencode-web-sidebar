import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { getOrCreateProxy } from './ProxyServer';

const HEALTH_CHECK_TIMEOUT_MS = 3000;
const PROXY_START_TIMEOUT_MS = 4000;
const CONNECTION_RECHECK_TIMEOUT_MS = 6000;

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
  private _pendingChanges = new Map<string, Record<string, any>>();
  private _serverStatuses = new Map<string, ConnectionState | 'unknown'>();
  private _allServersPollTimer: ReturnType<typeof setInterval> | undefined;
  private _pollInFlight: Promise<void> | undefined;
  private _proxyOperationId = 0;
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
  private _savedIframePath = '';
  private _initialUrlSent = false;
  private _iframeWasConnected = false;

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

  private renderCurrentServerCard(): string {
    const server = this.getActiveServer();
    if (!server) return '';

    let dotClass = 'status-dot';
    let statusLabel = '';
    if (this._connectionState === 'connected') { dotClass += ' connected'; statusLabel = 'Connected'; }
    else if (this._connectionState === 'checking') { dotClass += ' pulse'; statusLabel = 'Connecting...'; }
    else if (this._connectionState === 'starting') { dotClass += ' pulse'; statusLabel = 'Starting...'; }
    else if (this._connectionState === 'auth-required') { dotClass += ' auth'; statusLabel = 'Password required'; }
    else if (this._isReconnecting) { dotClass += ' pulse'; statusLabel = 'Reconnecting...'; }
    else { dotClass += ' disconnected'; statusLabel = 'Disconnected'; }

    const label = escapeAttr(server.label || server.url);
    const url = escapeAttr(server.url);

    return `<div class="card" style="cursor:pointer;width:100%;max-width:400px" onclick="selectServer()">
      <div class="card-header">
        <div class="card-title">
          <span>${label}</span>
          <span class="${dotClass}"></span>
        </div>
        <div class="card-description">${url}</div>
      </div>
      <div class="card-content" style="flex-direction:row;justify-content:space-between;align-items:center;padding-top:2px">
        <span style="font-size:11px;color:var(--muted-foreground)">${statusLabel}</span>
        <span style="font-size:11px;color:var(--muted-foreground)">Manage &rarr;</span>
      </div>
    </div>`;
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
    if (this._allServersPollTimer) {
      clearInterval(this._allServersPollTimer);
      this._allServersPollTimer = undefined;
    }
    this._serverStatuses.clear();

    if (this._startedByUs && this._serverProcess && serverId !== this._activeServerId) {
      this.log('Stopping previously-started server on switch');
      this._killServerProcess();
      this._startedByUs = false;
      vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
    }

    this._savedIframePath = '';
    this._iframeWasConnected = false;
    await this.commitPendingChanges(serverId);
    this._activeServerId = serverId;
    await this._globalState.update('opencode-web-sidebar.activeServerId', serverId);
    this.loadCredentialsForActive();

    this._connectionState = 'checking';
    this.updateStatusBar();
    if (gen === this._serverGeneration) {
      this.render();
    }

    const proxyReady = await this.startProxy();
    if (gen !== this._serverGeneration) return;
    if (!proxyReady) {
      this._connectionState = 'disconnected';
      this.updateStatusBar();
      this.sendStateUpdate();
      return;
    }
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
        const proxyReady = await this.startProxy();
        if (gen === this._serverGeneration) {
          if (proxyReady) {
            await this.pollOnce();
          } else {
            this._connectionState = 'disconnected';
            this.updateStatusBar();
            this.sendStateUpdate();
          }
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
    const count = this._servers.filter(s => s.id !== 'default').length + 1;
    this._servers.push({
      id,
      url: config.url,
      label: config.label || `Server #${count}`,
      authEnabled: false,
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
          await this.recheckConnection({ showChecking: true, reloadIframe: true });
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
          if (this._showServerSelector) {
            this.pollAllServers();
            this._allServersPollTimer = setInterval(() => this.pollAllServers(), 5000);
          } else {
            if (this._allServersPollTimer) {
              clearInterval(this._allServersPollTimer);
              this._allServersPollTimer = undefined;
            }
            this._serverStatuses.clear();
          }
          this.sendStateUpdate();
          break;
        case 'connectToServer':
          if (msg.serverId) {
            await this.switchToServer(msg.serverId);
          }
          break;
        case 'startAndConnect':
          if (msg.serverId) {
            await this.commitPendingChanges(msg.serverId);
            const gen = ++this._serverGeneration;
            this._showServerSelector = false;
            this._iframeWasConnected = false;
            if (this._allServersPollTimer) {
              clearInterval(this._allServersPollTimer);
              this._allServersPollTimer = undefined;
            }
            this._serverStatuses.clear();
            this._activeServerId = msg.serverId;
            await this._globalState.update('opencode-web-sidebar.activeServerId', msg.serverId);
            this.loadCredentialsForActive();
            this._connectionState = 'checking';
            this.updateStatusBar();
            this.render();
            const proxyReady = await this.startProxy();
            if (gen !== this._serverGeneration) break;
            const state = proxyReady ? await this.checkHealth() : 'disconnected';
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
            const result = await vscode.window.showWarningMessage('Remove this server?', { modal: true }, 'Remove');
            if (result === 'Remove') {
              this._pendingChanges.delete(msg.serverId);
              await this.removeServer(msg.serverId);
            }
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
        case 'pendingChange':
          if (msg.serverId) {
            const existing = this._pendingChanges.get(msg.serverId) || {};
            existing[msg.key] = msg.value;
            this._pendingChanges.set(msg.serverId, existing);
            this.sendStateUpdate();
          }
          break;
        case 'commitServerChanges':
          if (msg.serverId) {
            await this.commitPendingChanges(msg.serverId);
          }
          break;
        case 'ocFrameUrlChanged':
          if (msg.path) {
            this._savedIframePath = msg.path;
          }
          break;
      }
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
      this._isVisible = false;
      this.stopPolling();
      if (this._allServersPollTimer) {
        clearInterval(this._allServersPollTimer);
        this._allServersPollTimer = undefined;
      }
      this._serverStatuses.clear();
      this.log('Webview disposed');
    });

    webviewView.onDidChangeVisibility(() => {
      this._isVisible = webviewView.visible;
      this.log(`Visibility changed: ${this._isVisible}`);
      if (this._isVisible) {
        this._view = webviewView;
        void this.recheckConnection({ showChecking: false });
      } else {
        this.stopPolling();
      }
    });

    await this.loadServers();
    this._savedIframePath = '';
    this._initialUrlSent = false;
    this._connectionState = 'checking';
    this._isReconnecting = false;
    this.updateStatusBar();
    this.render();
    await this.recheckConnection({ showChecking: false });
    this.startPolling();
  }

  async show(): Promise<void> {
    if (this._isVisible) { return; }
    await vscode.commands.executeCommand('workbench.view.extension.opencode-web-sidebar');
  }

  async close(): Promise<void> {
    this._isVisible = false;
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

  private async recheckConnection(options: { showChecking?: boolean; reloadIframe?: boolean } = {}): Promise<void> {
    const { showChecking = true, reloadIframe = false } = options;
    const gen = ++this._serverGeneration;

    this._isReconnecting = false;
    this._reconnectAttempts = 0;
    this._consecutiveHealthFailures = 0;
    this._consecutiveAuthRequired = 0;
    this.clearReconnectTimer();

    if (showChecking) {
      this._connectionState = 'checking';
      this.updateStatusBar();
      this.sendStateUpdate();
    }

    let state: ConnectionState = 'disconnected';
    try {
      state = await withTimeout((async () => {
        const proxyReady = await this.startProxy();
        if (!proxyReady) {
          return 'disconnected';
        }
        return await this.checkHealth();
      })(), CONNECTION_RECHECK_TIMEOUT_MS, 'connection recheck');
    } catch (err) {
      this.log(`Connection recheck failed: ${err}`);
      state = 'disconnected';
    }

    if (this._disposed || gen !== this._serverGeneration) {
      return;
    }

    this._connectionState = state;
    this._isReconnecting = false;
    this.updateStatusBar();

    if (reloadIframe && state === 'connected') {
      this.render();
    } else {
      this.sendStateUpdate();
    }

    if (state === 'disconnected') {
      this.scheduleReconnect();
    }

    if (this._isVisible) {
      this.startPolling();
    }
  }

  async onUrlChanged(): Promise<void> {
    this.log('Config changed, reloading servers');
    await this.loadServers();
    await this.recheckConnection({ showChecking: true });
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
        '<div class="btn-row"><button class="btn btn-default" onclick="selectServer()">Servers</button></div>';
    } else {
      const card = this.renderCurrentServerCard();
      const statusHtml = this._isReconnecting ? (
        '<span>Connection lost, reconnecting...</span>' +
        '<div class="btn-row"><button class="btn btn-default" onclick="cancelReconnect()">Cancel</button>' +
        '<button class="btn btn-outline" onclick="selectServer()">Servers</button></div>'
      ) : this._connectionState === 'checking' ? (
        '<div class="oc-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="40" height="40" fill="none"><path fill="#f1ecec" d="M180 60H60v180h120zm60 240H0V0h240z" clip-path="url(#b)" mask="url(#a)" transform="translate(30)"/><defs><clipPath id="b" clipPathUnits="userSpaceOnUse"><path fill="#fff" d="M0 0h240v300H0z"/></clipPath><mask id="a" maskUnits="userSpaceOnUse"><path fill="#fff" d="M240 0H0v300h240z"/></mask></defs></svg></div>' +
        '<div class="spinner"></div>' +
        '<span>Connecting to server...</span>'
      ) : this._connectionState === 'starting' ? (
        '<div class="spinner"></div>' +
        '<span>Starting OpenCode server...</span>'
      ) : this._connectionState === 'auth-required' ? (
        '<div class="lock-icon">🔒</div>' +
        '<span>Server is online but password protected</span>' +
        '<div class="btn-row"><button class="btn btn-default" onclick="setPassword()">Login with Username &amp; Password</button></div>'
      ) : this._connectionState === 'disconnected' ? (
        '<span>OpenCode server is not reachable</span>' +
        '<div class="btn-row"><button class="btn btn-default" onclick="selectServer()">Servers</button>' +
        '<button class="btn btn-outline" onclick="openSettings()">Settings</button></div>'
      ) : '';

      overlayContent = card
        ? `<div style="display:flex;flex-direction:column;width:100%;height:100%;align-items:center">
            <div style="display:flex;flex-direction:column;align-items:center;width:100%;padding:32px 12px 0;flex-shrink:0">${card}</div>
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;width:100%">${statusHtml}</div>
          </div>`
        : statusHtml;
    }

    const proxyUrl = this._proxyBaseUrl || (this._proxyPort
      ? `http://127.0.0.1:${this._proxyPort}`
      : '');
    let iframeUrl = '';
    if (proxyUrl) {
      if (this._savedIframePath) {
        iframeUrl = proxyUrl + this._savedIframePath;
      } else {
        const workspaceDir = this.getWorkspaceFolder();
        const workspaceQuery = workspaceDir
          ? `/${Buffer.from(workspaceDir).toString('base64').replace(/=+$/, '')}/session`
          : '';
        iframeUrl = proxyUrl + workspaceQuery;
      }
    }
    const connectedAndReady = !this._isReconnecting && this._connectionState === 'connected' && !!iframeUrl && !this._showServerSelector;
    if (connectedAndReady) {
      this._iframeWasConnected = true;
    }
    const showIframe = this._iframeWasConnected && !!iframeUrl && !this._showServerSelector;
    const overlayHidden = showIframe && !this._showServerSelector;

    const statusBarStop = this._startedByUs
      ? '<a onclick="stopServer()">Stop</a><span class="separator">&nbsp;|&nbsp;</span>'
      : '';

    return { statusColor, statusText, statusBarStop, overlayContent, overlayHidden, showIframe, iframeUrl };
  }

  private sendStateUpdate(): void {
    if (!this._view) return;
    const state = this.computeUIState();

    const needsUrl = state.showIframe && !this._initialUrlSent;
    if (needsUrl) {
      this._initialUrlSent = true;
    }
    const iframeUrl = needsUrl ? state.iframeUrl : '';

    this.log(`sendStateUpdate: state=${this._connectionState} showIframe=${state.showIframe} overlayHidden=${state.overlayHidden} iframeUrl=${iframeUrl ? 'set' : (state.iframeUrl ? 'suppressed' : 'empty')}`);
    this._view.webview.postMessage({
      type: 'updateState',
      statusColor: state.statusColor,
      statusText: state.statusText,
      statusBarStop: state.statusBarStop,
      overlayContent: state.overlayContent,
      overlayHidden: state.overlayHidden,
      showIframe: state.showIframe,
      iframeUrl,
    });
  }

  private async startProxy(): Promise<boolean> {
    const opId = ++this._proxyOperationId;
    await this.stopProxy(false);
    const url = this.getConfiguredUrl();
    if (!url) {
      this.log('No URL configured, skipping proxy');
      return false;
    }
    try {
      const parsed = new URL(url);
      if (this._cachedPassword) {
        parsed.username = this._cachedUsername || 'opencode';
        parsed.password = this._cachedPassword;
      }
      const targetUrl = parsed.toString();
      this.log(`Starting proxy for ${parsed.host}${this._cachedPassword ? ' (with auth)' : ' (no auth)'}`);
      const handle = await withTimeout(getOrCreateProxy(targetUrl), PROXY_START_TIMEOUT_MS, 'proxy startup');
      if (opId !== this._proxyOperationId || this._disposed) {
        await handle.dispose();
        return false;
      }
      this._proxyPort = handle.port;
      this._proxyDispose = handle.dispose;
      this.log(`Proxy listening on port ${this._proxyPort}`);
      this._proxyBaseUrl = await withTimeout(this.resolveProxyBaseUrl(), PROXY_START_TIMEOUT_MS, 'proxy URI resolution');
      return true;
    } catch (err) {
      this.log(`Failed to start proxy: ${err}`);
      return false;
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

  private async stopProxy(invalidateInFlight = true): Promise<void> {
    if (invalidateInFlight) {
      this._proxyOperationId++;
    }
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
      if (state === 'connected' && !this._proxyPort && !this._proxyBaseUrl) {
        const proxyReady = await this.startProxy();
        if (!proxyReady) {
          this._connectionState = 'disconnected';
          this.updateStatusBar();
          this.sendStateUpdate();
          return;
        }
      }
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

  private async pollAllServers(): Promise<void> {
    const gen = this._serverGeneration;
    for (const server of this._servers) {
      if (server.id === this._activeServerId) continue;
      try {
        const resp = await fetch(server.url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          this._serverStatuses.set(server.id, 'connected');
        } else if (resp.status >= 500) {
          this._serverStatuses.set(server.id, 'disconnected');
        } else {
          this._serverStatuses.set(server.id, 'connected');
        }
      } catch {
        this._serverStatuses.set(server.id, 'disconnected');
      }
      if (this._disposed || gen !== this._serverGeneration) { return; }
    }
    this.sendStateUpdate();
  }

  private async commitPendingChanges(serverId: string): Promise<void> {
    const pending = this._pendingChanges.get(serverId);
    if (!pending) return;
    const server = this._servers.find(s => s.id === serverId);
    if (!server) { this._pendingChanges.delete(serverId); return; }
    if ('password' in pending) {
      await this.saveServerPassword(serverId, pending.password || '');
    }
    for (const key of Object.keys(pending)) {
      if (key === 'password') continue;
      (server as any)[key] = pending[key];
    }
    this._pendingChanges.delete(serverId);
    await this.persistServers();
    this.sendStateUpdate();
  }

  private getHealthUrl(): string {
    const base = this.getConfiguredUrl();
    if (!base) return '';
    return base.replace(/\/+$/, '') + '/global/health';
  }

  private async checkHealth(): Promise<ConnectionState> {
    const url = this.getHealthUrl();
    if (!url) { return 'disconnected'; }

    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        method: 'HEAD',
      });
      this.log(`Health check (no auth): ${resp.status}`);
      if (resp.ok) { return 'connected'; }

      if (resp.status === 401 && this._cachedPassword) {
        const encoded = Buffer.from(`${this._cachedUsername || 'opencode'}:${this._cachedPassword}`).toString('base64');
        try {
          const authResp = await fetch(url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
            headers: { 'Authorization': `Basic ${encoded}` },
          });
          this.log(`Health check (with auth): ${authResp.status}`);
          if (authResp.ok) { return 'connected'; }
        } catch (err) {
          this.log(`Health check (with auth) failed: ${err}`);
          return 'auth-required';
        }
      }

      if (resp.status === 401) { return 'auth-required'; }
      if (resp.status >= 500) {
        this.log(`Health check: upstream unavailable (${resp.status})`);
        return 'disconnected';
      }
      return 'connected';
    } catch (err) {
      this.log(`Health check failed: ${err}`);
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
    if (this._pollInFlight) {
      return this._pollInFlight;
    }
    this._pollInFlight = this.doPollOnce().finally(() => {
      this._pollInFlight = undefined;
    });
    return this._pollInFlight;
  }

  private async doPollOnce(): Promise<void> {
    const gen = this._serverGeneration;
    if (this._disposed) { return; }
    const state = await this.checkHealth();
    if (gen !== this._serverGeneration) { return; }
    if (
      state === this._connectionState &&
      !this._isReconnecting &&
      !(state === 'connected' && !this._proxyPort && !this._proxyBaseUrl)
    ) { return; }

    if (state === 'connected') {
      if (!this._proxyPort && !this._proxyBaseUrl) {
        const proxyReady = await this.startProxy();
        if (gen !== this._serverGeneration || !proxyReady) {
          this._connectionState = 'disconnected';
          this.updateStatusBar();
          this.sendStateUpdate();
          return;
        }
      }
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
      this.scheduleReconnect();
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
        if (state === 'connected' && !this._proxyPort && !this._proxyBaseUrl) {
          const proxyReady = await this.startProxy();
          if (gen !== this._serverGeneration || !proxyReady) {
            this.scheduleReconnect();
            return;
          }
        }
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
    const pending = this._pendingChanges.get(server.id);
    const hasPending = !!pending;
    const serverIdJs = escapeJsString(server.id);
    const serverIdAttr = escapeAttr(server.id);
    const label = pending?.label ?? server.label ?? '';
    const url = pending?.url ?? server.url;
    const serverUsername = pending?.username ?? server.username ?? '';
    const authEnabled = pending?.authEnabled ?? server.authEnabled ?? false;
    const isWsl = pending?.isWsl ?? server.isWsl ?? false;
    const hasPassword = !!(this._passwordsCache.get(server.id));
    const usingEnv = isActive && this._usingEnvPassword && !hasPassword;
    const isDefault = server.isDefault;

    const urlValue = escapeAttr(url);

    let statusClass = 'status-dot';
    if (isActive) {
      if (this._connectionState === 'connected') statusClass += ' connected';
      else if (this._connectionState === 'checking' || this._connectionState === 'starting') statusClass += ' pulse';
      else if (this._connectionState === 'auth-required') statusClass += ' auth';
      else statusClass += ' disconnected';
    } else {
      const s = this._serverStatuses.get(server.id) || 'unknown';
      if (s === 'connected') statusClass += ' connected';
      else if (s === 'auth-required') statusClass += ' auth';
      else statusClass += ' disconnected';
    }

    let action: string;
    if (isLocal) {
      if (isActive) {
        action = `<span class="badge badge-active">ACTIVE</span>`;
      } else {
        action = `<div class="btn-row">
          <button class="btn btn-outline btn-xs" onclick="startAndConnect('${serverIdJs}')">Start &amp; Connect</button>
          <button class="btn btn-default btn-xs" onclick="connectToServer('${serverIdJs}')">Connect</button>
        </div>`;
      }
    } else {
      if (isActive) {
        action = `<span class="badge badge-active">ACTIVE</span>`;
      } else {
        action = `<button class="btn btn-default btn-xs" onclick="connectToServer('${serverIdJs}')">Connect</button>`;
      }
    }

    let footerLeft = '';
    if (isDefault) {
      footerLeft = `<span class="badge badge-outline">default</span>`;
    } else {
      footerLeft = `<button class="btn btn-ghost btn-xs" onclick="setDefaultServer('${serverIdJs}')">Set Default</button>`;
    }

    const trashSvg = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="pointer-events:none;display:block"><path d="M6.5 1.5H5V3h6V1.5H9.5L9 1H7L6.5 1.5zM3 4v1h1v9.5c0 .3.2.5.5.5h7c.3 0 .5-.2.5-.5V5h1V4H3zm2 1h6v9H5V5z"/></svg>';
    const saveSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="pointer-events:none;display:block"><path fill-rule="evenodd" clip-rule="evenodd" d="M18.1716 1C18.702 1 19.2107 1.21071 19.5858 1.58579L22.4142 4.41421C22.7893 4.78929 23 5.29799 23 5.82843V20C23 21.6569 21.6569 23 20 23H4C2.34315 23 1 21.6569 1 20V4C1 2.34315 2.34315 1 4 1H18.1716ZM4 3C3.44772 3 3 3.44772 3 4V20C3 20.5523 3.44772 21 4 21L5 21L5 15C5 13.3431 6.34315 12 8 12L16 12C17.6569 12 19 13.3431 19 15V21H20C20.5523 21 21 20.5523 21 20V6.82843C21 6.29799 20.7893 5.78929 20.4142 5.41421L18.5858 3.58579C18.2107 3.21071 17.702 3 17.1716 3H17V5C17 6.65685 15.6569 8 14 8H10C8.34315 8 7 6.65685 7 5V3H4ZM17 21V15C17 14.4477 16.5523 14 16 14L8 14C7.44772 14 7 14.4477 7 15L7 21L17 21ZM9 3H15V5C15 5.55228 14.5523 6 14 6H10C9.44772 6 9 5.55228 9 5V3Z"/></svg>';
    const saveBtn = hasPending
      ? `<span class="btn btn-default btn-xs" onclick="commitServerChanges('${serverIdJs}')" title="Save changes" role="button" tabindex="0" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px">SAVE ${saveSvg}</span>`
      : '';

    const userPlaceholder = (usingEnv && !server.username) ? '[Using opencode]' : 'Username';
    const passPlaceholder = usingEnv ? '[Using OPENCODE_SERVER_PASSWORD]' : hasPassword ? '••••••••' : 'Password';
    const authFieldsStyle = authEnabled ? '' : ' style="display:none"';

    return `<div class="card" data-id="${serverIdAttr}">
      <div class="card-header">
        <div class="card-title">
          <input class="input-title" type="text" value="${escapeAttr(label)}" onchange="pendingChange('${serverIdJs}','label',this.value)" placeholder="Server name" spellcheck="false">
          ${isActive ? `<span class="${statusClass}"></span>` : ''}
        </div>
        <div class="card-description">${urlValue}</div>
        <div class="card-action">${isActive ? action : `<span class="${statusClass}"></span> ${action}`}</div>
      </div>
      <div class="card-content">
        <input class="input" type="text" value="${urlValue}" onchange="pendingChange('${serverIdJs}','url',this.value)" placeholder="http://localhost:4096">
        <div class="field-row"${authFieldsStyle}>
          <input class="input input-sm" id="user-${serverIdAttr}" type="text" placeholder="${escapeAttr(userPlaceholder)}" value="${escapeAttr(serverUsername)}" onchange="pendingChange('${serverIdJs}','username',this.value)">
          <input class="input input-sm" id="pass-${serverIdAttr}" type="password" placeholder="${escapeAttr(passPlaceholder)}" onchange="pendingChange('${serverIdJs}','password',this.value)">
        </div>
        <div class="toggle-row">
          <label class="switch-label">
            <input type="checkbox" class="switch-input" ${authEnabled ? 'checked' : ''} onchange="pendingChange('${serverIdJs}','authEnabled',this.checked)">
            <span>authentication</span>
          </label>
          <label class="switch-label">
            <input type="checkbox" class="switch-input" ${isWsl ? 'checked' : ''} onchange="pendingChange('${serverIdJs}','isWsl',this.checked)">
            <span>is WSL / Linux</span>
          </label>
        </div>
      </div>
      <div class="card-footer">
        ${footerLeft}
        <div style="flex:1"></div>
        ${saveBtn}
        ${isLocal ? '' : `<span class="btn btn-ghost btn-xs" onclick="removeServer('${serverIdJs}')" title="Remove server" role="button" tabindex="0" style="cursor:pointer">${trashSvg}</span>`}
      </div>
    </div>`;
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
    const frameSrcBase = proxyOrigin || origin;
    const frameSrc = showIframe && frameSrcBase
      ? `frame-src ${frameSrcBase};`
      : "frame-src http://127.0.0.1:* http://localhost:*;";

    const imgSrc = showIframe && (proxyOrigin || origin)
      ? `${proxyOrigin || origin}`
      : 'http://127.0.0.1:* http://localhost:* https:';
    const connectSrc = showIframe && (proxyOrigin || origin)
      ? `${proxyOrigin || origin}`
      : 'http://127.0.0.1:* http://localhost:*';

    const csp = [
      "default-src 'self';",
      frameSrc,
      "style-src 'self' 'unsafe-inline';",
      "script-src 'self' 'unsafe-inline';",
      `img-src 'self' ${imgSrc} data:;`,
      `connect-src 'self' ${connectSrc} data:;`,
      "font-src 'self' data:;",
    ].join(' ');

    const iframeSrc = showIframe && iframeUrl
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
    :root {
      --background: var(--vscode-sideBar-background, #1e1e1e);
      --foreground: var(--vscode-sideBar-foreground, #cccccc);
      --card: var(--vscode-sideBar-background, #1e1e1e);
      --card-foreground: var(--vscode-foreground, #cccccc);
      --primary: var(--vscode-button-background, #007acc);
      --primary-foreground: var(--vscode-button-foreground, #ffffff);
      --secondary: #2d2d2d;
      --secondary-foreground: #cccccc;
      --muted: #2d2d2d;
      --muted-foreground: #888888;
      --accent: #2d2d2d;
      --accent-foreground: #cccccc;
      --destructive: #e06c75;
      --destructive-foreground: #ffffff;
      --border: rgba(255,255,255,0.1);
      --input: rgba(255,255,255,0.15);
      --ring: rgba(255,255,255,0.3);
      --radius: 0.625rem;
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { height:100%; width:100%; overflow:hidden; background:var(--background); color:var(--foreground); font-family:var(--vscode-font-family,sans-serif); font-size:13px; -webkit-font-smoothing:antialiased; }
    iframe { width:100%; height:calc(100% - 24px); border:none; display:none; }
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
      flex-shrink:0;
    }
    .status-bar .spacer { flex:1; }
    .status-bar a {
      color:inherit; opacity:.7; text-decoration:none; cursor:pointer;
    }
    .status-bar a:hover { opacity:1; text-decoration:underline; }
    .separator { color:inherit; opacity:.35; }

    .overlay {
      position:absolute; inset:24px 0 0 0; display:flex; flex-direction:column;
      align-items:center; justify-content:center; gap:12px;
      color:var(--muted-foreground);
      font-family:var(--vscode-font-family,sans-serif); font-size:13px;
      padding:20px;
    }
    .overlay.hidden { display:none; }
    .overlay .lock-icon { font-size:32px; }
    .overlay code { font-size:12px; opacity:.8; }
    .overlay .btn-row { display:flex; gap:8px; margin-top:4px; }
    .overlay .oc-icon {
      display:flex; align-items:center; justify-content:center; opacity:.5;
      margin-bottom:8px;
    }
    .overlay .spinner {
      width:24px; height:24px; border:3px solid var(--muted-foreground);
      border-top-color:transparent; border-radius:50%;
      animation:spin .8s linear infinite;
    }
    @keyframes spin { to { transform:rotate(360deg); } }

    .server-selector {
      width:100%; height:100%; overflow-y:auto; padding:12px;
      display:flex; flex-direction:column; gap:8px;
    }

    .card {
      display:flex; flex-direction:column; gap:12px;
      border-radius:var(--radius); padding:12px 0;
      background:var(--card); color:var(--card-foreground);
      border:1px solid var(--border); overflow:hidden;
    }
    .card:has(.card-footer) { padding-bottom:0; }
    .card-header {
      display:grid; gap:4px; padding:0 12px;
      align-items:start; grid-auto-rows:min-content;
    }
    .card-header:has(.card-title) { grid-template-columns:1fr auto; }
    .card-title {
      font-size:13px; font-weight:500; line-height:1.3;
      display:flex; align-items:center; gap:6px;
    }
    .card-title .status-dot { margin-top:4px; }
    .card-description {
      font-size:11px; color:var(--muted-foreground); word-break:break-all;
    }
    .card-action {
      grid-column:2; grid-row:1/span 2; justify-self:end; align-self:start;
      display:flex; align-items:center; gap:4px;
    }
    .card-action .status-dot { margin-top:2px; }
    .card-content {
      padding:0 12px; display:flex; flex-direction:column; gap:4px;
    }
    .card-footer {
      display:flex; align-items:center; gap:4px; padding:8px 12px; margin:0;
      background:color-mix(in srgb,var(--muted) 50%,transparent);
      border-top:1px solid var(--border);
      border-radius:0 0 var(--radius) var(--radius);
      flex-wrap:wrap;
    }

    .btn {
      display:inline-flex; align-items:center; justify-content:center;
      border-radius:12px; font-size:12px; font-weight:500; line-height:1;
      white-space:nowrap; transition:all .15s; cursor:pointer;
      border:1px solid transparent; font-family:inherit; outline:none;
      height:28px; padding:0 10px; gap:4px;
    }
    .btn:hover { opacity:.9; }
    .btn:active { transform:translateY(1px); }
    .btn-default {
      background:var(--primary); color:var(--primary-foreground);
    }
    .btn-outline {
      background:transparent; color:var(--foreground);
      border-color:var(--border);
    }
    .btn-outline:hover { background:var(--muted); }
    .btn-ghost {
      background:transparent; color:var(--foreground);
    }
    .btn-ghost:hover { background:var(--muted); }
    .btn-destructive {
      background:color-mix(in srgb,var(--destructive) 10%,transparent);
      color:var(--destructive);
    }
    .btn-destructive:hover {
      background:color-mix(in srgb,var(--destructive) 20%,transparent);
    }
    .btn-xs { height:24px; padding:0 8px; font-size:11px; border-radius:10px; }
    .btn-icon { width:28px; height:28px; padding:0; }
    .btn-row { display:flex; gap:6px; align-items:center; }

    .badge {
      display:inline-flex; align-items:center; justify-content:center;
      height:20px; padding:0 8px; border-radius:9999px;
      font-size:11px; font-weight:500; white-space:nowrap;
      border:1px solid transparent; line-height:1;
    }
    .badge-active {
      background:var(--vscode-inputValidation-infoBackground,#063b6d);
      color:var(--vscode-inputValidation-infoBorder,#3794ff);
      border-color:var(--vscode-inputValidation-infoBorder,#3794ff);
    }
    .badge-outline {
      background:transparent; color:var(--foreground);
      border-color:var(--border);
    }
    .badge-secondary {
      background:var(--secondary); color:var(--secondary-foreground);
    }

    .input {
      width:100%; height:32px; padding:4px 10px;
      border-radius:8px; border:1px solid var(--input);
      background:transparent; color:var(--foreground);
      font-family:var(--vscode-font-family,sans-serif); font-size:13px;
      transition:border-color .15s,box-shadow .15s;
      outline:none; min-width:0; display:block;
    }
    .input:focus {
      border-color:var(--ring);
      box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 50%,transparent);
    }
    .input::placeholder { color:var(--muted-foreground); opacity:1; }
    .input-sm { height:28px; padding:2px 8px; font-size:12px; border-radius:6px; }
    .input-title {
      width:100%; font-size:13px; font-weight:500; line-height:1.3;
      background:transparent; border:none; color:var(--card-foreground);
      font-family:var(--vscode-font-family,sans-serif); outline:none; padding:0; margin:0;
    }
    .input-title::placeholder { color:var(--muted-foreground); opacity:.5; }
    .field-row { display:flex; gap:4px; }
    .field-row > .input { flex:1; min-width:0; }

    .toggle-row {
      display:flex; align-items:center; gap:12px; flex-wrap:wrap;
    }
    .switch-label {
      display:inline-flex; align-items:center; gap:6px;
      cursor:pointer; font-size:11px; user-select:none;
    }
    .switch-input {
      appearance:none; -webkit-appearance:none;
      width:32px; height:18.4px; border-radius:9999px;
      background:var(--input); cursor:pointer; transition:background .2s;
      flex-shrink:0; position:relative; border:1px solid transparent; margin:0;
    }
    .switch-input::after {
      content:''; position:absolute; top:1.2px; left:1.2px;
      width:14px; height:14px; border-radius:50%;
      background:var(--card-foreground); transition:transform .2s;
    }
    .switch-input:checked { background:var(--primary); }
    .switch-input:checked::after { transform:translateX(13.6px); }

    .status-dot {
      display:inline-block; width:10px; height:10px; border-radius:50%;
      flex-shrink:0; background:var(--muted);
    }
    .status-dot.connected { background:#4ec94e; }
    .status-dot.disconnected { background:var(--destructive); }
    .status-dot.auth { background:var(--muted-foreground); }
    .status-dot.muted { background:var(--muted); opacity:.5; }
    .status-dot.pulse { animation:pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.5; } }

    .local-section {
      margin-top:16px; padding-top:12px;
      border-top:1px solid var(--border);
    }
    .section-title {
      text-align:center; font-size:12px; font-weight:600; text-transform:uppercase;
      color:var(--muted-foreground); margin-bottom:8px; letter-spacing:.5px;
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
          if (msg.showIframe && msg.iframeUrl && iframe.src !== msg.iframeUrl) {
            iframe.src = msg.iframeUrl;
          } else if (!msg.showIframe) {
            iframe.removeAttribute('src');
          }
          iframe.style.display = msg.showIframe ? 'block' : 'none';
        }
      } else if (msg.type === 'ocFrameUrlChanged') {
        vscode.postMessage({ type: 'ocFrameUrlChanged', path: msg.path });
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

    function selectServer() {
      vscode.postMessage({ type: 'selectServer' });
    }

    function connectToServer(serverId) {
      vscode.postMessage({ type: 'connectToServer', serverId });
    }

    function startAndConnect(serverId) {
      vscode.postMessage({ type: 'startAndConnect', serverId });
    }

    function pendingChange(serverId, key, value) {
      vscode.postMessage({ type: 'pendingChange', serverId, key, value });
    }

    function commitServerChanges(serverId) {
      vscode.postMessage({ type: 'commitServerChanges', serverId });
    }

    function removeServer(serverId) {
      vscode.postMessage({ type: 'removeServer', serverId });
    }

    function setDefaultServer(serverId) {
      vscode.postMessage({ type: 'setDefaultServer', serverId });
    }

    function addServer() {
      vscode.postMessage({ type: 'addServer', config: { url: 'http://localhost:4096', label: '' } });
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

  private renderServerSelector(): string {
    const regularServers = this._servers.filter(s => s.id !== 'default');
    const localServer = this._servers.find(s => s.id === 'default');

    const regularHtml = regularServers.map(s => this.renderServerRow(s, false)).join('\n');
    const localHtml = localServer ? this.renderServerRow(localServer, true) : '';

    const regularSection = regularHtml || regularServers.length > 0
      ? `<div class="section-title" style="margin-top:8px">Servers</div>${regularHtml}` : '';

    return `<div class="server-selector">
      <button class="btn btn-ghost btn-xs" onclick="selectServer()" style="margin-bottom:4px;flex-shrink:0">&larr; Back</button>
      ${regularSection}
      <div class="local-section">
        <div class="section-title">Local Server</div>
        ${localHtml || '<span style="font-size:12px;opacity:.5">No local server configured</span>'}
      </div>
      <div class="btn-row" style="justify-content:center;margin-top:4px">
        <button class="btn btn-outline" style="height:32px;padding:0 16px;border-radius:8px" onclick="addServer()">+ Add Server</button>
      </div>
    </div>`;
  }
}
