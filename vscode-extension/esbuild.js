// Builds the VS Code extension into a single self-contained bundle.
//
// The extension depends on @plumb/scanner, whose transitive deps are hoisted to
// the monorepo root — `vsce package` can't collect those. esbuild inlines the
// scanner and its dependencies into one dist/extension.js so the .vsix is
// self-contained. It also snapshots the public registry alongside the bundle so
// a packaged extension can score without the monorepo tree.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { parse } = require('yaml');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// ── Ship a registry snapshot inside the extension ────────────────────────────
function bundleRegistry() {
  const entriesDir = path.resolve(__dirname, '..', 'registry', 'entries');
  const TEMPLATES = new Set(['examples.yaml', 'examples.yml']);
  const seen = new Set();
  const entries = [];
  for (const file of fs.readdirSync(entriesDir)) {
    if (!/\.(ya?ml)$/.test(file) || TEMPLATES.has(file)) continue;
    const parsed = parse(fs.readFileSync(path.join(entriesDir, file), 'utf8'));
    for (const e of (Array.isArray(parsed) ? parsed : [parsed])) {
      if (!e || typeof e.id !== 'string' || e.meta?.visibility === 'org' || seen.has(e.id)) continue;
      seen.add(e.id);
      entries.push(e);
    }
  }
  const snapshot = { commit: `bundled-${new Date().toISOString().slice(0, 10)}`, entries };
  fs.writeFileSync(path.resolve(__dirname, 'registry.bundled.json'), JSON.stringify(snapshot));
  console.log(`bundled ${entries.length} registry entries`);
}

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],       // provided by the VS Code runtime
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function main() {
  fs.rmSync(path.resolve(__dirname, 'dist'), { recursive: true, force: true }); // drop stale tsc output
  bundleRegistry();
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('esbuild watching…');
  } else {
    await esbuild.build(options);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
