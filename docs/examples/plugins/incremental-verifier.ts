/**
 * Example: Incremental Verification Strategy
 *
 * Only runs tests affected by the changed files, reducing verification time.
 *
 * How it works:
 * 1. Look at the worker's git porcelain changes (runtime supplies this)
 * 2. Map changed files to colocated / importing tests
 * 3. Return a narrower command list from selectCommands
 *
 * The runtime then runs those commands through verifyCommands (allowlist + shell:false).
 * `verify()` is not called.
 *
 * Usage in .pi/swarm.json:
 * {
 *   "run": {
 *     "verificationStrategy": "~/.pi/agent/plugins/incremental-verifier.js"
 *   }
 * }
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import type { VerificationStrategy } from '../../../src/plugins/interfaces.ts';
import type { Subtask, VerificationResult } from '../../../src/types.ts';

const execFileAsync = promisify(execFile);

export default class IncrementalVerifier implements VerificationStrategy {
  readonly name = 'incremental-verifier';
  readonly description = 'Only runs tests affected by changed files';
  readonly version = '1.0.0';

  private repoRoot: string = '';
  private testPattern: RegExp = /\.(test|spec)\.(ts|js|tsx|jsx)$/;
  private dependencyCache = new Map<string, Set<string>>();

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.repoRoot = (config.repoRoot as string) || process.cwd();
    if (config.testPattern) {
      this.testPattern = new RegExp(config.testPattern as string);
    }
  }

  async selectCommands(
    task: Subtask,
    worktreePath: string,
    changes: { modified: string[]; added: string[]; deleted: string[] }
  ): Promise<string[] | null> {
    // Get all changed files
    const changedFiles = [...changes.modified, ...changes.added];
    if (changedFiles.length === 0) {
      // No changes, use default commands
      return null;
    }

    // Find affected test files
    const affectedTests = await this.findAffectedTests(worktreePath, changedFiles);

    if (affectedTests.length === 0) {
      // No tests affected, skip verification
      return [];
    }

    // Build test commands based on detected framework
    const testCommands = await this.buildTestCommands(worktreePath, affectedTests);

    return testCommands;
  }

  async verify(task: Subtask, worktreePath: string, commands: string[]): Promise<VerificationResult> {
    // The runtime does not call verify(); it runs selected commands through verifyCommands.
    // Kept so the example still type-checks against the interface.
    if (!commands.length) return { ok: true, skipped: true, commands: [] };
    const results = [];

    for (const command of commands) {
      const [cmd, ...args] = command.split(' ');
      const startTime = Date.now();

      try {
        const { stdout, stderr } = await execFileAsync(cmd, args, {
          cwd: worktreePath,
          timeout: 300000,
          maxBuffer: 10 * 1024 * 1024,
        });

        results.push({
          command,
          exitCode: 0,
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
          timedOut: false,
        });
      } catch (error: unknown) {
        const err = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
        results.push({
          command,
          exitCode: err.code ?? 1,
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
          durationMs: Date.now() - startTime,
          timedOut: err.killed ?? false,
        });
      }
    }

    const ok = results.every((r) => r.exitCode === 0);
    return { ok, commands: results };
  }

  async classifyFailure(
    task: Subtask,
    error: { exitCode: number; stdout: string; stderr: string },
    attemptNumber: number
  ): Promise<{
    category: 'flaky' | 'environment' | 'timeout' | 'real-bug';
    shouldRetry: boolean;
    retryWithModifications?: {
      simplifyGoal?: string;
      reduceScope?: string[];
      additionalContext?: string;
    };
  }> {
    // Check for flaky patterns
    if (
      error.stderr.includes('ECONNREFUSED') ||
      error.stderr.includes('socket hang up') ||
      error.stdout.includes('Jest worker encountered') ||
      error.stdout.includes('Timeout - Async callback was not invoked')
    ) {
      return {
        category: 'flaky',
        shouldRetry: attemptNumber < 3,
      };
    }

    // Check for environment issues
    if (
      error.stderr.includes('ENOENT') ||
      error.stderr.includes('command not found') ||
      error.stderr.includes('MODULE_NOT_FOUND') ||
      error.stderr.includes('Cannot find module')
    ) {
      return {
        category: 'environment',
        shouldRetry: attemptNumber === 1,
        retryWithModifications: {
          additionalContext: 'Install missing dependencies first: npm install',
        },
      };
    }

    // Check for timeout
    if (error.exitCode === 124 || error.stderr.includes('ETIMEDOUT')) {
      return {
        category: 'timeout',
        shouldRetry: attemptNumber < 2,
        retryWithModifications: {
          simplifyGoal: 'Split this task into smaller subtasks with narrower scope',
        },
      };
    }

    // Real bug - don't retry
    return {
      category: 'real-bug',
      shouldRetry: false,
    };
  }

  private async findAffectedTests(worktreePath: string, changedFiles: string[]): Promise<string[]> {
    const affectedTests = new Set<string>();

    for (const file of changedFiles) {
      // If the file itself is a test, include it
      if (this.testPattern.test(file)) {
        affectedTests.add(file);
        continue;
      }

      // Find tests that import this file
      const relatedTests = await this.findTestsImporting(worktreePath, file);
      relatedTests.forEach((test) => affectedTests.add(test));

      // Find co-located tests (e.g., foo.ts -> foo.test.ts)
      const colocatedTest = this.findColocatedTest(file);
      if (colocatedTest) {
        affectedTests.add(colocatedTest);
      }
    }

    return Array.from(affectedTests);
  }

  private async findTestsImporting(worktreePath: string, targetFile: string): Promise<string[]> {
    // Simple heuristic: find test files that mention the target file name
    // In production, you'd use a proper dependency analyzer
    const tests: string[] = [];
    const fileName = relative(worktreePath, targetFile).replace(/\.(ts|js|tsx|jsx)$/, '');

    try {
      // Use git grep to find test files mentioning this file
      const { stdout } = await execFileAsync(
        'git',
        ['grep', '-l', `from.*${fileName}`, '**/*.test.*', '**/*.spec.*'],
        { cwd: worktreePath }
      );
      tests.push(...stdout.trim().split('\n').filter(Boolean));
    } catch {
      // No matches found
    }

    return tests;
  }

  private findColocatedTest(sourceFile: string): string | null {
    const ext = extname(sourceFile);
    const base = sourceFile.slice(0, -ext.length);

    // Try common test file patterns
    const patterns = [`${base}.test${ext}`, `${base}.spec${ext}`, `${base}.test.ts`, `${base}.spec.ts`];

    // In a real implementation, you'd check if these files exist
    // For now, just return the first pattern
    return patterns[0];
  }

  private async buildTestCommands(worktreePath: string, testFiles: string[]): Promise<string[]> {
    // Detect test framework
    const framework = await this.detectTestFramework(worktreePath);

    if (framework === 'jest') {
      return [`npm test -- ${testFiles.join(' ')}`];
    } else if (framework === 'vitest') {
      return [`npm test -- ${testFiles.join(' ')}`];
    } else if (framework === 'mocha') {
      return [`npx mocha ${testFiles.join(' ')}`];
    } else if (framework === 'node') {
      return [`node --test ${testFiles.join(' ')}`];
    } else {
      // Fallback to running each test individually
      return testFiles.map((file) => `npm test -- ${file}`);
    }
  }

  private async detectTestFramework(worktreePath: string): Promise<string> {
    try {
      const packageJson = await readFile(join(worktreePath, 'package.json'), 'utf-8');
      const pkg = JSON.parse(packageJson);

      if (pkg.dependencies?.jest || pkg.devDependencies?.jest) return 'jest';
      if (pkg.dependencies?.vitest || pkg.devDependencies?.vitest) return 'vitest';
      if (pkg.dependencies?.mocha || pkg.devDependencies?.mocha) return 'mocha';
    } catch {
      // package.json not found or invalid
    }

    return 'node'; // Fallback to Node.js native test runner
  }
}
