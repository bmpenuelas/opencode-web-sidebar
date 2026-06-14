import * as vscode from 'vscode';
import { OpenCodePanel } from './OpenCodePanel';

let panel: OpenCodePanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  panel = new OpenCodePanel(context.extensionUri, context.secrets);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OpenCodePanel.viewType, panel)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web-sidebar.openPanel', async () => {
      if (panel!.isVisible) {
        await panel!.close();
        await context.globalState.update('opencode-web-sidebar.panelOpen', false);
        return;
      }
      await panel!.show();
      await context.globalState.update('opencode-web-sidebar.panelOpen', true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web-sidebar.focusPanel', async () => {
      await panel!.show();
      await context.globalState.update('opencode-web-sidebar.panelOpen', true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web-sidebar.closePanel', async () => {
      await panel!.close();
      await context.globalState.update('opencode-web-sidebar.panelOpen', false);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web-sidebar.openFile', async (uri: vscode.Uri | string) => {
      const fileUri = typeof uri === 'string' ? vscode.Uri.parse(uri) : uri;
      await vscode.commands.executeCommand('vscode.open', fileUri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web-sidebar.setPassword', async () => {
      const username = await vscode.window.showInputBox({
        prompt: 'Enter username for the OpenCode server',
        value: panel!.cachedUsername || 'opencode',
        ignoreFocusOut: true,
      });
      if (username === undefined) {return;}

      const password = await vscode.window.showInputBox({
        prompt: 'Enter password for the OpenCode server',
        password: true,
        ignoreFocusOut: true,
      });
      if (password === undefined) {return;}

      await panel!.saveCredentials(username || 'opencode', password);
      panel!.render();
      vscode.window.showInformationMessage('OpenCode credentials saved.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web-sidebar.clearPassword', async () => {
      await panel!.clearCredentials();
      panel!.render();
      vscode.window.showInformationMessage('OpenCode credentials cleared.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web-sidebar.startServer', () => {
      panel!.startServer();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web-sidebar.stopServer', () => {
      panel!.stopServer();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web-sidebar.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'opencode-web-sidebar');
    })
  );

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('opencode-web-sidebar.url')) {
      panel?.onUrlChanged();
    }
  });

  const hasFolder = !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
  const panelWasOpen = context.globalState.get<boolean>('opencode-web-sidebar.panelOpen', true);

  if (hasFolder && panelWasOpen) {
    setTimeout(() => {
      vscode.commands.executeCommand('workbench.view.extension.opencode-web-sidebar');
    }, 500);
  } else if (!hasFolder) {
    setTimeout(() => {
      if (panel?.isVisible) {
        panel.close();
      }
    }, 500);
  }

  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    const hasFolderNow = !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
    if (hasFolderNow && context.globalState.get<boolean>('opencode-web-sidebar.panelOpen', true)) {
      panel?.show();
    } else if (!hasFolderNow && panel?.isVisible) {
      panel?.close();
    }
  });
}

export function deactivate() {
  panel?.dispose();
  panel = undefined;
}
