import * as vscode from 'vscode';
import type { PlumbReport, CategoryResult, RecommendationResult } from '@plumb/scanner';

// ─────────────────────────────────────────────────────────────────────────────
// Webview template
//
// Generates the full HTML for the Plumb sidebar panel.
// Uses VS Code CSS variables for theming so it adapts to any color theme.
// The report data is injected at runtime via postMessage from the extension host.
// ─────────────────────────────────────────────────────────────────────────────

export function getWebviewContent(
  webview: vscode.Webview,
  _extensionUri: vscode.Uri,
): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Plumb</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --gold:      #C8B560;
    --gold-dim:  #5a5030;
    --green:     #4A9E6B;
    --red:       #c0392b;
    --amber:     #D4834A;
  }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 0;
    overflow-x: hidden;
  }

  /* ── States ── */
  .state { display: none; }
  .state.active { display: block; }

  /* ── Idle ── */
  .idle-wrap {
    padding: 24px 16px;
    text-align: center;
  }
  .plumb-wordmark {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
    letter-spacing: 0.12em;
    color: var(--gold);
    font-weight: 600;
    margin-bottom: 8px;
  }
  .idle-desc {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
    margin-bottom: 16px;
  }
  .scan-btn {
    display: inline-block;
    padding: 5px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    font-size: 12px;
    cursor: pointer;
    font-family: var(--vscode-font-family);
  }
  .scan-btn:hover { background: var(--vscode-button-hoverBackground); }

  /* ── Scanning ── */
  .scanning-wrap {
    padding: 24px 16px;
    text-align: center;
  }
  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--vscode-widget-border);
    border-top-color: var(--gold);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 12px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .scan-step {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  /* ── Error ── */
  .error-wrap {
    padding: 16px;
    margin: 12px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    border-radius: 3px;
    font-size: 11px;
    line-height: 1.5;
  }
  .error-wrap .retry-btn {
    margin-top: 10px;
    display: block;
    color: var(--vscode-textLink-foreground);
    background: none;
    border: none;
    cursor: pointer;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    padding: 0;
    text-align: left;
  }

  /* ── Report header ── */
  .report-header {
    padding: 12px 12px 8px;
    border-bottom: 1px solid var(--vscode-widget-border);
  }
  .repo-name {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--gold);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 4px;
  }
  .report-meta {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .report-counts {
    display: flex;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-widget-border);
    font-size: 10px;
  }
  .count-item { display: flex; align-items: center; gap: 4px; }
  .count-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .dot-gap   { background: var(--red); }
  .dot-rec   { background: var(--gold); }
  .dot-ok    { background: var(--green); }

  /* ── Category list ── */
  .cat-list { padding: 4px 0; }
  .cat-header {
    padding: 6px 12px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    user-select: none;
  }
  .cat-header:hover { background: var(--vscode-list-hoverBackground); }
  .cat-header.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .cat-label-row { display: flex; align-items: center; gap: 6px; }
  .cat-status-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
  .cat-count {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 1px 5px;
    border-radius: 8px;
  }
  .cat-count.gap { background: rgba(192,57,43,0.2); color: var(--red); }
  .cat-count.ok  { background: rgba(74,158,107,0.15); color: var(--green); }

  /* ── Recommendations ── */
  .cat-recs { display: none; padding: 0 8px 8px; }
  .cat-recs.open { display: block; }

  .rec-card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 3px;
    padding: 10px;
    margin-top: 6px;
  }
  .rec-card.gap-card { border-left: 2px solid var(--red); }

  .rec-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }
  .rec-name {
    font-size: 11px;
    font-weight: 600;
    line-height: 1.3;
  }
  .assay-badge {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 9px;
    color: var(--gold);
    background: rgba(200, 181, 96, 0.1);
    border: 1px solid var(--gold-dim);
    padding: 1px 5px;
    border-radius: 3px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .rec-problem {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
    margin-bottom: 6px;
  }
  .rec-note {
    font-size: 10px;
    color: var(--vscode-foreground);
    background: rgba(200, 181, 96, 0.06);
    border-left: 2px solid var(--gold-dim);
    padding: 4px 6px;
    border-radius: 0 2px 2px 0;
    line-height: 1.4;
    margin-bottom: 6px;
    font-style: italic;
  }
  .rec-note code {
    font-style: normal;
    color: var(--gold);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 9px;
  }
  .rec-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }
  .signal-pills { display: flex; gap: 3px; flex-wrap: wrap; }
  .pill {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 2px;
    border: 1px solid var(--vscode-widget-border);
    color: var(--vscode-descriptionForeground);
  }
  .pill.match { color: var(--gold); border-color: var(--gold-dim); background: rgba(200,181,96,0.07); }
  .pill.score { color: var(--green); border-color: rgba(74,158,107,0.3); background: rgba(74,158,107,0.07); }

  .open-link {
    font-size: 10px;
    color: var(--vscode-textLink-foreground);
    background: none;
    border: none;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    padding: 0;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .open-link:hover { text-decoration: underline; }

  /* ── Coverage card ── */
  .coverage-note {
    padding: 0 12px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }

  /* ── Footer ── */
  .panel-footer {
    padding: 8px 12px;
    border-top: 1px solid var(--vscode-widget-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: sticky;
    bottom: 0;
    background: var(--vscode-sideBar-background);
  }
  .footer-btn {
    font-size: 10px;
    color: var(--vscode-textLink-foreground);
    background: none;
    border: none;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    padding: 0;
  }
  .footer-btn:hover { text-decoration: underline; }
  .footer-registry {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
  }
</style>
</head>
<body>

<!-- IDLE STATE -->
<div id="state-idle" class="state active">
  <div class="idle-wrap">
    <div class="plumb-wordmark">PLUMB</div>
    <div class="idle-desc">
      Scan your repository against the Assay registry of AI engineering best practices.
    </div>
    <button class="scan-btn" onclick="sendMessage('scan')">Scan Repository</button>
  </div>
</div>

<!-- SCANNING STATE -->
<div id="state-scanning" class="state">
  <div class="scanning-wrap">
    <div class="spinner"></div>
    <div class="scan-step" id="scan-step">Initializing...</div>
  </div>
</div>

<!-- ERROR STATE -->
<div id="state-error" class="state">
  <div class="error-wrap">
    <div id="error-message"></div>
    <button class="retry-btn" onclick="sendMessage('scan')">Retry scan →</button>
  </div>
</div>

<!-- REPORT STATE -->
<div id="state-report" class="state">
  <div class="report-header">
    <div class="repo-name" id="repo-name"></div>
    <div class="report-meta">
      <span id="report-commit"></span>
      <span id="report-scan-type"></span>
    </div>
  </div>
  <div class="report-counts" id="report-counts"></div>
  <div class="cat-list" id="cat-list"></div>
  <div class="panel-footer">
    <button class="footer-btn" onclick="sendMessage('scan')">Rescan</button>
    <button class="footer-btn" onclick="sendMessage('copyMarkdown')">Copy as Markdown</button>
    <span class="footer-registry" id="registry-commit"></span>
  </div>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  function sendMessage(type, payload) {
    vscode.postMessage({ type, ...payload });
  }

  function setState(name) {
    document.querySelectorAll('.state').forEach(el => el.classList.remove('active'));
    document.getElementById('state-' + name).classList.add('active');
  }

  // ── Message handler ─────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'idle':
        setState('idle');
        break;

      case 'scanning':
        setState('scanning');
        document.getElementById('scan-step').textContent = msg.step;
        break;

      case 'error':
        setState('error');
        document.getElementById('error-message').textContent = msg.message;
        break;

      case 'report':
        renderReport(msg.report);
        setState('report');
        break;
    }
  });

  // ── Report renderer ─────────────────────────────────────────────────────

  function renderReport(report) {
    const fp = report.fingerprint;

    document.getElementById('repo-name').textContent = fp.meta.fullName;
    document.getElementById('report-commit').textContent = 'commit ' + fp.meta.commit.slice(0, 7);
    document.getElementById('report-scan-type').textContent = fp.deepScan ? 'deep scan' : 'api scan';
    document.getElementById('registry-commit').textContent = report.registryCommit;

    // Counts
    const countsEl = document.getElementById('report-counts');
    countsEl.innerHTML = [
      countItem('dot-gap', report.totalGaps + ' gaps'),
      countItem('dot-rec', report.totalRecommendations + ' recommendations'),
      countItem('dot-ok',  report.totalCovered + ' covered'),
    ].join('');

    // Categories
    const catList = document.getElementById('cat-list');
    catList.innerHTML = '';
    let firstOpen = true;

    for (const cat of report.categories) {
      const hasRecs = cat.recommendations.length > 0;
      const isCovered = cat.isCovered && !hasRecs;
      const isGap = !cat.isCovered && !hasRecs;

      if (isGap) continue; // category not relevant to this stack

      const catId = 'cat-' + cat.category;
      const dotColor = isCovered ? 'var(--green)' : hasRecs ? 'var(--gold)' : 'var(--vscode-descriptionForeground)';
      const countClass = isCovered ? 'ok' : hasRecs && !cat.isCovered ? 'gap' : '';
      const countLabel = isCovered ? 'ok' : hasRecs ? cat.recommendations.length + ' recs' : '';

      const header = document.createElement('div');
      header.className = 'cat-header' + (firstOpen ? ' active' : '');
      header.setAttribute('onclick', "toggleCat('" + catId + "', this)");
      header.innerHTML = \`
        <div class="cat-label-row">
          <div class="cat-status-dot" style="background:\${dotColor}"></div>
          \${esc(cat.label)}
        </div>
        \${countLabel ? \`<span class="cat-count \${countClass}">\${countLabel}</span>\` : ''}
      \`;

      const recsEl = document.createElement('div');
      recsEl.className = 'cat-recs' + (firstOpen ? ' open' : '');
      recsEl.id = catId;

      if (isCovered) {
        recsEl.innerHTML = \`
          <div class="coverage-note">
            <span style="color:var(--green)">✓</span>
            \${esc(cat.coverageNote ?? 'Covered.')}
          </div>
        \`;
      } else {
        for (const rec of cat.recommendations) {
          recsEl.appendChild(renderRecCard(rec, cat));
        }
      }

      catList.appendChild(header);
      catList.appendChild(recsEl);
      firstOpen = false;
    }
  }

  function renderRecCard(rec, cat) {
    const isGap = !cat.isCovered;
    const card = document.createElement('div');
    card.className = 'rec-card' + (isGap ? ' gap-card' : '');

    const topSignals = rec.matchedSignals.slice(0, 3);
    const pillsHtml = topSignals
      .map(s => \`<span class="pill match">\${esc(s.value)}</span>\`)
      .join('') +
      \`<span class="pill score">assay \${rec.entry.assay.assay_score}</span>\`;

    // Highlight {signal} references in the rendered note
    const noteHtml = esc(rec.renderedNote).replace(
      /\`([^']+)\`/g,
      '<code>$1</code>'
    );

    card.innerHTML = \`
      <div class="rec-top">
        <div class="rec-name">\${esc(rec.entry.name)}</div>
        <span class="assay-badge">\${rec.entry.assay.assay_score}</span>
      </div>
      <div class="rec-problem">\${esc(rec.entry.problem_solved)}</div>
      <div class="rec-note">\${noteHtml}</div>
      <div class="rec-footer">
        <div class="signal-pills">\${pillsHtml}</div>
        <button class="open-link" onclick="sendMessage('openRepo', {url: '\${esc(rec.entry.repo)}'})">
          View on GitHub ↗
        </button>
      </div>
    \`;
    return card;
  }

  function toggleCat(id, headerEl) {
    const el = document.getElementById(id);
    const isOpen = el.classList.contains('open');
    document.querySelectorAll('.cat-recs').forEach(e => e.classList.remove('open'));
    document.querySelectorAll('.cat-header').forEach(e => e.classList.remove('active'));
    if (!isOpen) {
      el.classList.add('open');
      headerEl.classList.add('active');
    }
  }

  function countItem(dotClass, label) {
    return \`<div class="count-item"><div class="count-dot \${dotClass}"></div><span>\${label}</span></div>\`;
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
</script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
