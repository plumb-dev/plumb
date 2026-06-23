#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import { PlumbScanner } from './scanner';
import type { PlumbReport, CategoryResult } from './types';

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
      spinner.stop();

      switch (options.format) {
        case 'json':
          outputJson(report, options.output);
          break;
        case 'markdown':
          outputMarkdown(report, options.output);
          break;
        default:
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

program.parse();

// ─────────────────────────────────────────────────────────────────────────────
// Output formatters
// ─────────────────────────────────────────────────────────────────────────────

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
