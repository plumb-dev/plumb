import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import type { CodePatterns } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Clone Reader
//
// Used when registry entries have code_patterns that require reading source
// files directly — things like `openai.chat.completions.create` or
// `anthropic.messages.create` that won't appear in a manifest.
//
// Clones to a temp directory, scans, then cleans up.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = [
  '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs',
  '*.py',
  '*.rs',
  '*.go',
  '*.java',
  '*.rb',
  '*.ex', '*.exs',
];

const IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', '.nuxt', 'coverage', 'vendor', 'target',
];

export class CloneReader {
  private tmpDir: string | null = null;

  // ── Clone repo to temp dir ──────────────────────────────────────────────

  async clone(repoUrl: string, ref?: string): Promise<string> {
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumb-'));

    const cloneCmd = `git clone --depth 1 ${ref ? `--branch ${ref}` : ''} "${repoUrl}" "${this.tmpDir}" 2>&1`;
    execSync(cloneCmd, { timeout: 60_000 });

    return this.tmpDir;
  }

  // ── Scan code patterns across all source files ──────────────────────────

  async scanCodePatterns(
    repoPath: string,
    patterns: string[],
  ): Promise<CodePatterns> {
    if (!patterns.length) return { matches: {} };

    // Collect all source files, respecting ignore list
    const sourceFiles = await this.collectSourceFiles(repoPath);
    const results: Record<string, string[]> = {};

    for (const pattern of patterns) {
      results[pattern] = [];
      const regex = this.buildRegex(pattern);

      for (const filePath of sourceFiles) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              const relative = path.relative(repoPath, filePath);
              results[pattern].push(`${relative}:${i + 1}`);
              // Cap at 10 locations per pattern — we care about presence, not exhaustion
              if (results[pattern].length >= 10) break;
            }
          }
        } catch {
          // Binary file or permission issue — skip
        }
      }
    }

    return { matches: results };
  }

  // ── Source file collection ──────────────────────────────────────────────

  private async collectSourceFiles(repoPath: string): Promise<string[]> {
    const allFiles: string[] = [];

    for (const ext of SOURCE_EXTENSIONS) {
      const found = await glob(ext, {
        cwd: repoPath,
        absolute: true,
        ignore: IGNORE_DIRS.map(d => `**/${d}/**`),
        nodir: true,
      });
      allFiles.push(...found);
    }

    return allFiles;
  }

  // ── Pattern compiler ────────────────────────────────────────────────────
  //
  // Registry code_patterns can be:
  //   - Plain strings:    "ChatCompletion.create"  → literal match
  //   - Regex strings:    "/anthropic\\.messages/"  → compiled as regex
  //
  private buildRegex(pattern: string): RegExp {
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      // It's a regex literal like "/pattern/flags"
      const lastSlash = pattern.lastIndexOf('/');
      const body = pattern.slice(1, lastSlash);
      const flags = pattern.slice(lastSlash + 1);
      return new RegExp(body, flags || 'i');
    }
    // Plain string — escape and match literally
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  cleanup(): void {
    if (this.tmpDir && fs.existsSync(this.tmpDir)) {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
      this.tmpDir = null;
    }
  }
}
