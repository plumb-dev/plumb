#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import { parse, stringify } from 'yaml';
import { PlumbScanner } from './scanner';
import { AssayEngine, writeScores, ingestRepos } from './assay';
import { ApplicabilityFilter } from './applicability';
import type { PlumbReport, CategoryResult, RegistryEntry, RecommendationResult } from './types';
import type { AssayRunResult, IngestResult } from './assay';

// ─────────────────────────────────────────────────────────────────────────────
// Plumb CLI
//
// Usage:
//   plumb scan <github-url-or-owner/repo>
//   plumb scan https://github.com/acme/my-ai-app --token ghp_xxx
//   plumb scan acme/my-ai-app --api-only --format json
// ─────────────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('plumb')
  .description('Scan a codebase against the Assay registry of AI engineering best practices')
  .version('0.1.0');

program
  .command('scan <target>')
  .description('Scan a GitHub repository. Target can be a full URL or owner/repo.')
  .option('-t, --token <token>', 'GitHub personal access token (raises rate limits to 5,000/hr)')
  .option('--api-only', 'Skip the clone pass. Faster but misses code-level patterns.', false)
  .option('--deep', 'Force a full clone scan even if the API pass is sufficient.', false)
  .option('-f, --format <format>', 'Output format: terminal | json | markdown', 'terminal')
  .option('-o, --output <file>', 'Write output to a file instead of stdout')
  .option('--registry <dir>', 'Path to a local registry directory (default: bundled)')
  .option('--triage', 'Filter recommendations by architecture fit via Claude (needs ANTHROPIC_API_KEY)', false)
  .action(async (target: string, options) => {
    const spinner = ora({ color: 'yellow' });

    try {
      const registryDir = options.registry ??
        path.join(__dirname, '..', '..', 'registry', 'entries');

      const scanner = new PlumbScanner({
        githubToken: options.token ?? process.env.GITHUB_TOKEN,
        apiOnly: options.apiOnly,
        forceDeepScan: options.deep,
        registryDir: fs.existsSync(registryDir) ? registryDir : undefined,
        onProgress: (step) => {
          spinner.text = chalk.dim(step);
          if (!spinner.isSpinning) spinner.start();
        },
      });

      const report = await scanner.scan({ input: target });

      if (options.triage) {
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) { spinner.stop(); throw new Error('--triage needs an Anthropic API key. Set ANTHROPIC_API_KEY.'); }
        spinner.text = chalk.dim('triaging recommendations by architecture fit…');
        if (!spinner.isSpinning) spinner.start();
        await new ApplicabilityFilter({ anthropicApiKey: key }).triage(report);
      }
      spinner.stop();

      const triaged = report.categories.some(c => c.recommendations.some(r => r.applicability));

      switch (options.format) {
        case 'json':
          outputJson(report, options.output);
          break;
        case 'markdown':
          (triaged ? outputMarkdownTriaged : outputMarkdown)(report, options.output);
          break;
        default:
          if (triaged) { outputTerminalTriaged(report); break; }
          outputTerminal(report);
      }

    } catch (err: unknown) {
      spinner.stop();
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red('\n  Error: ') + message);

      if (message.includes('rate limit')) {
        console.error(chalk.dim('\n  Tip: Pass --token with a GitHub PAT to raise the rate limit to 5,000 req/hr'));
        console.error(chalk.dim('       export GITHUB_TOKEN=ghp_... or use --token ghp_...'));
      }
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// assay — re-score registry entries from live data
//
//   plumb assay                       # dry-run against the seed registry
//   plumb assay --write --token ghp_x # recompute and write scores back
//   plumb assay --id langfuse-langfuse
// ─────────────────────────────────────────────────────────────────────────────

program
  .command('assay')
  .description('Re-score registry entries from live GitHub + package-registry data.')
  .option('-f, --file <path>', 'Registry YAML file to score',
    path.join(__dirname, '..', '..', 'registry', 'entries', 'seed.yaml'))
  .option('-t, --token <token>', 'GitHub PAT (raises rate limits; recommended for a full run)')
  .option('--id <id>', 'Only score the entry with this id')
  .option('--write', 'Write recomputed scores back into the file (default: dry-run)', false)
  .option('-c, --concurrency <n>', 'Number of entries to collect in parallel', '5')
  .option('--issues', 'Recompute issue quality via Claude (needs ANTHROPIC_API_KEY)', false)
  .option('--issue-model <id>', 'Model for issue-quality scoring', 'claude-haiku-4-5')
  .action(async (options) => {
    const spinner = ora({ color: 'yellow' });
    const token = options.token ?? process.env.GITHUB_TOKEN;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    try {
      const text = fs.readFileSync(options.file, 'utf-8');
      const parsed = parse(text);
      let entries: RegistryEntry[] = Array.isArray(parsed) ? parsed : [parsed];
      if (options.id) entries = entries.filter(e => e.id === options.id);

      if (entries.length === 0) {
        throw new Error(options.id ? `No entry with id "${options.id}"` : 'No entries found in file');
      }
      if (!token) {
        console.error(chalk.yellow(
          `\n  ⚠  No GitHub token — unauthenticated API is capped at 60 req/hr.\n` +
          `     Scoring ${entries.length} entries needs ~${entries.length * 4} calls. ` +
          `Pass --token or set GITHUB_TOKEN.\n`));
      }
      if (options.issues && !anthropicKey) {
        throw new Error('--issues needs an Anthropic API key. Set ANTHROPIC_API_KEY.');
      }

      const engine = new AssayEngine({
        githubToken: token,
        concurrency: parseInt(options.concurrency, 10) || 5,
        scoreIssues: options.issues,
        anthropicApiKey: anthropicKey,
        issueModel: options.issueModel,
        onProgress: (done, total, id) => {
          spinner.text = chalk.dim(`scoring ${done}/${total} · ${id}`);
          if (!spinner.isSpinning) spinner.start();
        },
      });

      const result = await engine.scoreAll(entries);
      spinner.stop();

      outputAssay(result, options.write);

      if (options.write) {
        const n = writeScores(options.file, result.scores, result.scoredAt);
        console.log(chalk.green(`\n  ✓ Wrote ${n} updated scores to ${path.relative(process.cwd(), options.file)}\n`));
      } else {
        console.log(chalk.dim('\n  Dry run. Re-run with --write to persist these scores.\n'));
      }
    } catch (err: unknown) {
      spinner.stop();
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red('\n  Error: ') + message);
      if (message.includes('rate limit')) {
        console.error(chalk.dim('\n  Tip: pass --token with a GitHub PAT to raise the limit to 5,000 req/hr'));
      }
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// ingest — turn bare repo URLs into complete, scored registry entries
//
//   plumb ingest https://github.com/owner/repo                  # dry-run
//   plumb ingest owner/repo --write                             # admit to public registry
//   plumb ingest owner/repo --org-id acme_co --write            # private enterprise entry
//   plumb ingest a/b c/d --threshold 70 --issues --write
// ─────────────────────────────────────────────────────────────────────────────

program
  .command('ingest <targets...>')
  .description('Generate + score full registry entries from repo URLs; admit those above the threshold.')
  .option('-t, --token <token>', 'GitHub PAT (recommended)')
  .option('--threshold <n>', 'Minimum assay_score to admit', '60')
  .option('--org-id <id>', 'Mint private enterprise entries (visibility: org) under this org id')
  .option('--gen-model <id>', 'Model for entry generation', 'claude-sonnet-4-6')
  .option('--write', 'Append admitted entries to the registry file (default: dry-run)', false)
  .option('-o, --output <file>', 'Registry file to append to')
  .action(async (targets: string[], options) => {
    const spinner = ora({ color: 'yellow' });
    const token = options.token ?? process.env.GITHUB_TOKEN;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    try {
      if (!anthropicKey) throw new Error('ingest needs an Anthropic API key. Set ANTHROPIC_API_KEY.');
      const orgId = options.orgId as string | undefined;

      spinner.text = chalk.dim(`ingesting ${targets.length} repos…`);
      spinner.start();
      const results = await ingestRepos(targets, {
        githubToken: token,
        anthropicApiKey: anthropicKey,
        threshold: parseInt(options.threshold, 10) || 60,
        visibility: orgId ? 'org' : 'public',
        orgId,
        genModel: options.genModel,
        scoreIssues: true, // the key is already required for generation; score all six
      });
      spinner.stop();

      outputIngest(results, orgId);

      const admitted = results.filter(r => r.admitted && r.entry).map(r => r.entry!);
      if (options.write && admitted.length > 0) {
        const outFile = options.output ?? path.join(
          __dirname, '..', '..', 'registry', 'entries',
          orgId ? `ingested.${orgId}.yaml` : 'ingested.yaml',
        );
        const existing: RegistryEntry[] = fs.existsSync(outFile)
          ? (parse(fs.readFileSync(outFile, 'utf-8')) ?? [])
          : [];
        const ids = new Set(existing.map(e => e.id));
        const fresh = admitted.filter(e => !ids.has(e.id));
        fs.writeFileSync(outFile, stringify([...existing, ...fresh]), 'utf-8');
        console.log(chalk.green(`\n  ✓ Wrote ${fresh.length} new entries to ${path.relative(process.cwd(), outFile)}` +
          (admitted.length - fresh.length ? chalk.dim(` (${admitted.length - fresh.length} already present)`) : '') + '\n'));
      } else if (admitted.length > 0) {
        console.log(chalk.dim(`\n  Dry run. Re-run with --write to add ${admitted.length} admitted entr${admitted.length === 1 ? 'y' : 'ies'}.\n`));
      } else {
        console.log(chalk.dim('\n  Nothing cleared the threshold.\n'));
      }
    } catch (err: unknown) {
      spinner.stop();
      console.error(chalk.red('\n  Error: ') + (err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program.parse();

// ─────────────────────────────────────────────────────────────────────────────
// Output formatters
// ─────────────────────────────────────────────────────────────────────────────

function outputIngest(results: IngestResult[], orgId?: string): void {
  const gold = chalk.hex('#C8B560');
  const dim = chalk.dim;
  console.log('');
  console.log(gold.bold('  PLUMB') + dim(` · ingest · ${results.length} repos · `) +
    (orgId ? chalk.magenta(`enterprise (${orgId})`) : chalk.cyan('public')));
  console.log('');
  for (const r of results) {
    const slug = r.url.replace('https://github.com/', '');
    if (r.error) { console.log('  ' + chalk.red('✗ ') + slug + dim(` — ${r.error}`)); continue; }
    const mark = r.admitted ? chalk.green('✓ ') : chalk.yellow('· ');
    console.log('  ' + mark + chalk.bold(r.entry!.name) + dim(` (${slug})`) +
      dim(' · assay ') + gold.bold(String(r.score)) +
      dim(` · ${r.entry!.category}${r.admitted ? '' : ' — below threshold'}`));
  }
}

function outputAssay(result: AssayRunResult, willWrite: boolean): void {
  const gold = chalk.hex('#C8B560');
  const dim = chalk.dim;

  console.log('');
  console.log(gold.bold('  PLUMB') + dim(` · Assay re-score · ${result.scores.length} entries · `) +
    (willWrite ? chalk.green('write') : chalk.cyan('dry-run')));
  console.log('');
  console.log(dim(
    '  ' + 'entry'.padEnd(28) + 'score'.padEnd(13) + 'forks/stars'.padEnd(15) +
    'cntrb'.padEnd(7) + 'weekly dl'.padEnd(12) + 'commit'));
  console.log(dim('  ' + '─'.repeat(82)));

  for (const s of [...result.scores].sort((a, b) => b.assayScore - a.assayScore)) {
    const delta = s.assayScore - s.previousScore;
    const arrow = delta > 0 ? chalk.green(`▲${delta}`) : delta < 0 ? chalk.red(`▼${-delta}`) : dim('  =');
    const scoreCol = `${s.previousScore}→${gold.bold(String(s.assayScore))} ${arrow}`;
    const dl = s.raw.downloadVelocity == null ? dim('—') : human(s.raw.downloadVelocity);
    console.log(
      '  ' + s.id.slice(0, 27).padEnd(28) +
      padVisible(scoreCol, 13) +
      `${s.raw.forks}/${s.raw.stars}`.padEnd(15) +
      String(s.raw.monthlyActiveContributors).padEnd(7) +
      padVisible(dl, 12) +
      `${s.raw.lastCommitDaysAgo}d`);
  }

  const recomputed = result.scores.filter(s => s.issueQualityRecomputed).length;
  if (recomputed > 0) {
    console.log('');
    console.log(dim(`  issue quality recomputed via Claude for ${recomputed}/${result.scores.length} entries`));
  }

  if (result.errors.length) {
    console.log('');
    console.log(chalk.red(`  ${result.errors.length} entries could not be scored:`));
    for (const e of result.errors) console.log(dim(`    - ${e.id}: ${e.error}`));
  }
  if (result.issueErrors.length) {
    console.log('');
    console.log(chalk.yellow(`  ${result.issueErrors.length} issue-quality scorings failed (kept prior rating):`));
    for (const e of result.issueErrors) console.log(dim(`    - ${e.id}: ${e.error}`));
  }
}

function human(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
}

/** padEnd that ignores ANSI colour codes when measuring width. */
function padVisible(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + ' '.repeat(Math.max(0, width - visible));
}

function outputTerminal(report: PlumbReport): void {
  const { fingerprint: fp, categories } = report;
  const gold = chalk.hex('#C8B560');
  const dim = chalk.dim;
  const red = chalk.red;
  const green = chalk.green;

  console.log('');
  console.log(gold.bold('  PLUMB') + dim(' · Assay v1.0'));
  console.log('');
  console.log('  ' + chalk.bold(fp.meta.fullName));
  if (fp.meta.description) {
    console.log('  ' + dim(fp.meta.description));
  }
  console.log('  ' + dim(`commit ${fp.meta.commit.slice(0, 7)} · ${fp.deepScan ? 'deep scan' : 'api scan'}`));
  console.log('');
  console.log(
    `  ${red.bold(report.totalGaps + ' gaps')}  ` +
    `${gold(report.totalRecommendations + ' recommendations')}  ` +
    `${green(report.totalCovered + ' covered')}`
  );
  console.log('');
  console.log(dim('  ' + '─'.repeat(60)));

  for (const cat of categories) {
    if (cat.recommendations.length === 0 && !cat.isCovered) continue;

    console.log('');

    if (cat.isCovered && cat.recommendations.length === 0) {
      console.log('  ' + green('✓ ') + chalk.bold(cat.label));
      if (cat.coverageNote) console.log('    ' + dim(cat.coverageNote));
      continue;
    }

    const gapMarker = cat.recommendations.length > 0 && !cat.isCovered
      ? red('✗ ')
      : gold('· ');

    console.log('  ' + gapMarker + chalk.bold(cat.label));

    for (const rec of cat.recommendations) {
      console.log('');
      console.log(
        '    ' + chalk.bold(rec.entry.name) +
        dim(' · assay ') + gold.bold(String(rec.entry.assay.assay_score)) +
        dim(' · ' + rec.entry.repo.replace('https://github.com/', ''))
      );
      console.log('    ' + dim(rec.entry.problem_solved));
      console.log('');
      console.log('    ' + chalk.italic(rec.renderedNote));
      console.log('');
      const pills = rec.matchedSignals
        .slice(0, 3)
        .map(s => dim('[' + s.value + ']'))
        .join(' ');
      console.log('    ' + pills);
    }
  }

  console.log('');
  console.log(dim('  ' + '─'.repeat(60)));
  console.log('  ' + dim(`Registry: ${report.registryCommit} · ${report.generatedAt}`));
  console.log('');
}

function outputJson(report: PlumbReport, outputFile?: string): void {
  const json = JSON.stringify(report, null, 2);
  if (outputFile) {
    fs.writeFileSync(outputFile, json, 'utf-8');
    console.log(`Written to ${outputFile}`);
  } else {
    console.log(json);
  }
}

function outputMarkdown(report: PlumbReport, outputFile?: string): void {
  const { fingerprint: fp, categories } = report;
  const lines: string[] = [];

  lines.push(`# Plumb Report: \`${fp.meta.fullName}\``);
  lines.push('');
  lines.push(`> Scanned by [Plumb](https://plumb.dev) · Assay v1.0 · commit \`${fp.meta.commit.slice(0, 7)}\``);
  lines.push('');
  lines.push(`**${report.totalGaps} gaps · ${report.totalRecommendations} recommendations · ${report.totalCovered} covered**`);
  lines.push('');

  for (const cat of categories) {
    if (cat.recommendations.length === 0 && !cat.isCovered) continue;

    lines.push(`## ${cat.label}`);
    lines.push('');

    if (cat.isCovered && cat.recommendations.length === 0) {
      lines.push(`✓ ${cat.coverageNote ?? 'Covered.'}`);
      lines.push('');
      continue;
    }

    for (const rec of cat.recommendations) {
      lines.push(`### [${rec.entry.name}](${rec.entry.repo})`);
      lines.push('');
      lines.push(`**Assay score:** ${rec.entry.assay.assay_score}/100`);
      lines.push('');
      lines.push(rec.entry.problem_solved);
      lines.push('');
      lines.push(`> ${rec.renderedNote}`);
      lines.push('');
      lines.push(
        '**Matched signals:** ' +
        rec.matchedSignals.map(s => `\`${s.value}\``).join(', ')
      );
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`*Registry: ${report.registryCommit} · Generated: ${report.generatedAt}*`);

  const md = lines.join('\n');
  if (outputFile) {
    fs.writeFileSync(outputFile, md, 'utf-8');
    console.log(`Written to ${outputFile}`);
  } else {
    console.log(md);
  }
}

// ── Triaged output (scan --triage) ───────────────────────────────────────────

const byVerdict = (recs: RecommendationResult[], v: string) =>
  recs.filter(r => r.applicability?.verdict === v);

function outputTerminalTriaged(report: PlumbReport): void {
  const { fingerprint: fp, categories } = report;
  const gold = chalk.hex('#C8B560');
  const dim = chalk.dim;
  const green = chalk.green;

  const all = categories.flatMap(c => c.recommendations);
  const apply = byVerdict(all, 'apply');
  const covered = byVerdict(all, 'covered');
  const skip = byVerdict(all, 'skip');

  console.log('');
  console.log(gold.bold('  PLUMB') + dim(' · Assay v1.0 · triaged for your architecture'));
  console.log('');
  console.log('  ' + chalk.bold(fp.meta.fullName));
  if (fp.meta.description) console.log('  ' + dim(fp.meta.description));
  console.log('  ' + dim(`commit ${fp.meta.commit.slice(0, 7)} · ${fp.deepScan ? 'deep scan' : 'api scan'}`));
  console.log('');
  console.log(
    `  ${green.bold(apply.length + ' worth adopting')}  ` +
    `${dim(covered.length + ' already covered')}  ` +
    `${dim(skip.length + ' not applicable')}`);
  console.log('');
  console.log(dim('  ' + '─'.repeat(60)));

  for (const cat of categories) {
    const recs = byVerdict(cat.recommendations, 'apply');
    if (recs.length === 0) continue;
    console.log('');
    console.log('  ' + green('● ') + chalk.bold(cat.label));
    for (const rec of recs) {
      console.log('');
      console.log(
        '    ' + chalk.bold(rec.entry.name) +
        dim(' · assay ') + gold.bold(String(rec.entry.assay.assay_score)) +
        dim(' · ' + rec.entry.repo.replace('https://github.com/', '')));
      console.log('    ' + chalk.italic(rec.applicability?.reason || rec.renderedNote));
    }
  }

  if (covered.length) {
    console.log('');
    console.log(dim('  ' + '─'.repeat(60)));
    console.log('');
    console.log('  ' + chalk.bold('Already covered'));
    for (const r of covered) {
      console.log('    ' + green('✓ ') + r.entry.name + dim(` — ${r.applicability?.reason ?? ''}`));
    }
  }
  if (skip.length) {
    console.log('');
    console.log('  ' + chalk.bold('Not applicable'));
    for (const r of skip) {
      console.log('    ' + dim('· ' + r.entry.name + ` — ${r.applicability?.reason ?? ''}`));
    }
  }

  console.log('');
  console.log(dim('  ' + '─'.repeat(60)));
  console.log('  ' + dim(`Registry: ${report.registryCommit} · ${report.generatedAt}`));
  console.log('');
}

function outputMarkdownTriaged(report: PlumbReport, outputFile?: string): void {
  const { fingerprint: fp, categories } = report;
  const all = categories.flatMap(c => c.recommendations);
  const apply = byVerdict(all, 'apply');
  const covered = byVerdict(all, 'covered');
  const skip = byVerdict(all, 'skip');

  const lines: string[] = [];
  lines.push(`# Plumb Report: \`${fp.meta.fullName}\``);
  lines.push('');
  lines.push(`> Scanned by [Plumb](https://plumb.dev) · Assay v1.0 · triaged for architecture fit · commit \`${fp.meta.commit.slice(0, 7)}\``);
  lines.push('');
  lines.push(`**${apply.length} worth adopting · ${covered.length} already covered · ${skip.length} not applicable**`);
  lines.push('');

  lines.push('## Recommended for your stack');
  lines.push('');
  for (const cat of categories) {
    const recs = byVerdict(cat.recommendations, 'apply');
    if (recs.length === 0) continue;
    lines.push(`### ${cat.label}`);
    lines.push('');
    for (const rec of recs) {
      lines.push(`- **[${rec.entry.name}](${rec.entry.repo})** · assay ${rec.entry.assay.assay_score} — ${rec.applicability?.reason || rec.renderedNote}`);
    }
    lines.push('');
  }
  if (apply.length === 0) { lines.push('_Nothing flagged as a clear fit._', ''); }

  if (covered.length) {
    lines.push('## Already covered');
    lines.push('');
    for (const r of covered) lines.push(`- **${r.entry.name}** — ${r.applicability?.reason ?? ''}`);
    lines.push('');
  }
  if (skip.length) {
    lines.push('## Not applicable');
    lines.push('');
    for (const r of skip) lines.push(`- ${r.entry.name} — ${r.applicability?.reason ?? ''}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Registry: ${report.registryCommit} · Generated: ${report.generatedAt}*`);

  const md = lines.join('\n');
  if (outputFile) {
    fs.writeFileSync(outputFile, md, 'utf-8');
    console.log(`Written to ${outputFile}`);
  } else {
    console.log(md);
  }
}
