import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PlumbScanner } from '@plumb/scanner';
import type { PlumbReport } from '@plumb/scanner';
import { getWebviewContent } from './webview/template';

// ─────────────────────────────────────────────────────────────────────────────
// Message types passed between extension host and webview
// ─────────────────────────────────────────────────────────────────────────────

type ToWebview =
  | { type: 'idle' }
  | { type: 'scanning'; step: string }
  | { type: 'report'; report: PlumbReport }
  | { type: 'error'; message: string };

type FromWebview =
  | { type: 'scan' }
  | { type: 'openRepo'; url: string }
  | { type: 'copyMarkdown' };

// ─────────────────────────────────────────────────────────────────────────────
// PlumbPanel
// ─────────────────────────────────────────────────────────────────────────────

export class PlumbPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private lastReport?: PlumbReport;
  private scanning = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'assets'),
      ],
    };

    webviewView.webview.html = getWebviewContent(webviewView.webview, this.context.extensionUri);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message: FromWebview) => {
      switch (message.type) {
        case 'scan':
          this.triggerScan();
          break;
        case 'openRepo':
          vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
        case 'copyMarkdown':
          if (this.lastReport) {
            this.copyMarkdownReport(this.lastReport);
          }
          break;
      }
    });

    // If we already have a report, restore it
    if (this.lastReport) {
      this.post({ type: 'report', report: this.lastReport });
    } else {
      this.post({ type: 'idle' });
    }
  }

  // ── Trigger a scan ──────────────────────────────────────────────────────

  async triggerScan(): Promise<void> {
    if (this.scanning) return;

    const repoUrl = await this.resolveRepoUrl();
    if (!repoUrl) return;

    this.scanning = true;
    this.post({ type: 'scanning', step: 'Initializing...' });

    try {
      const token = await this.resolveToken();
      const config = vscode.workspace.getConfiguration('plumb');

      const registryDir = path.join(
        this.context.extensionPath, '..', '..', 'registry', 'entries'
      );

      const scanner = new PlumbScanner({
        githubToken: token,
        apiOnly: config.get<boolean>('apiOnly') ?? false,
        orgId: config.get<string>('orgId') || undefined,
        registryDir: fs.existsSync(registryDir) ? registryDir : undefined,
        onProgress: (step) => {
          this.post({ type: 'scanning', step });
        },
      });

      const report = await scanner.scan({ input: repoUrl });
      this.lastReport = report;
      this.post({ type: 'report', report });

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', message });
      vscode.window.showErrorMessage(`Plumb scan failed: ${message}`);
    } finally {
      this.scanning = false;
    }
  }

  // ── Resolve the target repo URL ─────────────────────────────────────────
  //
  // Priority:
  //   1. Git remote URL from the workspace (via git extension)
  //   2. User input via quick pick / input box

  private async resolveRepoUrl(): Promise<string | undefined> {
    // Try to get URL from git extension
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension) {
      const git = gitExtension.exports.getAPI(1);
      const repos = git.repositories;
      if (repos.length > 0) {
        const remotes = repos[0].state.remotes;
        const origin = remotes.find((r: { name: string; fetchUrl?: string }) => r.name === 'origin');
        if (origin?.fetchUrl) {
          const url = origin.fetchUrl
            .replace('git@github.com:', 'https://github.com/')
            .replace(/\.git$/, '');
          if (url.includes('github.com')) return url;
        }
      }
    }

    // Fall back to user input
    const input = await vscode.window.showInputBox({
      prompt: 'Enter the GitHub repository URL or owner/repo',
      placeHolder: 'https://github.com/owner/repo',
      ignoreFocusOut: true,
    });
    return input?.trim() || undefined;
  }

  // ── Resolve GitHub token ────────────────────────────────────────────────
  //
  // Priority: secrets store → settings → environment variable

  private async resolveToken(): Promise<string | undefined> {
    const stored = await this.context.secrets.get('plumb.githubToken');
    if (stored) return stored;

    const config = vscode.workspace.getConfiguration('plumb');
    const setting = config.get<string>('githubToken');
    if (setting) return setting;

    return process.env.GITHUB_TOKEN;
  }

  // ── Copy markdown report to clipboard ──────────────────────────────────

  private async copyMarkdownReport(report: PlumbReport): Promise<void> {
    const lines: string[] = [];
    const fp = report.fingerprint;

    lines.push(`# Plumb Report: \`${fp.meta.fullName}\``);
    lines.push('');
    lines.push(`> Assay v1.0 · commit \`${fp.meta.commit.slice(0, 7)}\` · ${report.generatedAt}`);
    lines.push('');
    lines.push(`**${report.totalGaps} gaps · ${report.totalRecommendations} recommendations · ${report.totalCovered} covered**`);
    lines.push('');

    for (const cat of report.categories) {
      if (cat.recommendations.length === 0 && !cat.isCovered) continue;
      lines.push(`## ${cat.label}`);
      lines.push('');
      if (cat.isCovered && cat.recommendations.length === 0) {
        lines.push(`✓ ${cat.coverageNote ?? 'Covered.'}`);
        lines.push('');
        continue;
      }
      for (const rec of cat.recommendations) {
        lines.push(`### [${rec.entry.name}](${rec.entry.repo}) — Assay ${rec.entry.assay.assay_score}`);
        lines.push('');
        lines.push(rec.entry.problem_solved);
        lines.push('');
        lines.push(`> ${rec.renderedNote}`);
        lines.push('');
      }
    }

    await vscode.env.clipboard.writeText(lines.join('\n'));
    vscode.window.showInformationMessage('Plumb: Markdown report copied to clipboard.');
  }

  // ── Post message to webview ─────────────────────────────────────────────

  private post(message: ToWebview): void {
    this.view?.webview.postMessage(message);
  }
}
