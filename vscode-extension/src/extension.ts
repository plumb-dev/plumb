import * as vscode from 'vscode';
import { PlumbPanel } from './PlumbPanel';

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Register the sidebar webview
  const provider = new PlumbPanel(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('plumb.reportView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ── Commands ───────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('plumb.scan', () => {
      provider.triggerScan();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('plumb.openPanel', () => {
      vscode.commands.executeCommand('plumb.reportView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('plumb.setToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your GitHub personal access token',
        password: true,
        placeHolder: 'ghp_...',
        ignoreFocusOut: true,
      });
      if (token) {
        await context.secrets.store('plumb.githubToken', token);
        vscode.window.showInformationMessage(
          'Plumb: GitHub token saved. Rate limit raised to 5,000 requests/hr.'
        );
      }
    })
  );

  // ── Auto-scan on open ──────────────────────────────────────────────────

  const config = vscode.workspace.getConfiguration('plumb');
  if (config.get<boolean>('autoScanOnOpen') && vscode.workspace.workspaceFolders?.length) {
    // Defer slightly so the panel has time to initialize
    setTimeout(() => provider.triggerScan(), 2000);
  }
}

export function deactivate(): void {}
