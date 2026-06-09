/**
 * Test generation skill — auto-activated when the user mentions tests, specs, or coverage.
 *
 * Provides tools for discovering test frameworks and running test suites,
 * giving the model the context it needs to generate or fix tests.
 */

import type { SkillManifest } from '../skill-types';
import type { AgentTool, ToolResult, ToolExecutionContext } from '../tool-types';

const runTestsTool: AgentTool = {
  name: 'run_tests',
  description: 'Run the project test suite and return results. Auto-detects the test runner (vitest, jest, mocha, pytest, cargo test).',
  parameters: [
    { name: 'filter', description: 'Optional test name or file pattern to filter (e.g. "auth", "src/utils/*.test.ts")' },
    { name: 'runner', description: 'Override the test runner (e.g. "vitest", "jest", "pytest"). Auto-detected if omitted.' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const runner = params.runner?.trim();
    let cmd: string;
    let args: string[];

    if (runner) {
      cmd = runner;
      args = ['run'];
      if (params.filter) {args.push(params.filter);}
    } else {
      // Auto-detect: check for common test runner config files
      const detectors: Array<{ files: string[]; cmd: string; args: string[] }> = [
        { files: ['vitest.config.ts', 'vitest.config.js'], cmd: 'npx', args: ['vitest', 'run'] },
        { files: ['jest.config.ts', 'jest.config.js', 'jest.config.mjs'], cmd: 'npx', args: ['jest'] },
        { files: ['pytest.ini', 'pyproject.toml', 'setup.cfg'], cmd: 'python3', args: ['-m', 'pytest'] },
        { files: ['Cargo.toml'], cmd: 'cargo', args: ['test'] },
      ];

      let detected = false;
      for (const detector of detectors) {
        for (const file of detector.files) {
          try {
            const files = await ctx.listFiles(file);
            if (files.length > 0) {
              cmd = detector.cmd;
              args = [...detector.args];
              if (params.filter) {args.push(params.filter);}
              detected = true;
              break;
            }
          } catch {
            // file doesn't exist, try next
          }
        }
        if (detected) {break;}
      }

      if (!detected) {
        // Fallback: try npx vitest run
        cmd = 'npx';
        args = ['vitest', 'run'];
        if (params.filter) {args.push(params.filter);}
      }
    }

    try {
      const result = await ctx.runCommand(cmd!, args!, ctx.workspaceRoot);
      const combined = [
        result.stdout.trim() ? result.stdout.trim() : '',
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
        `exit code: ${result.exitCode}`
      ].filter(Boolean).join('\n\n');

      return {
        output: combined.slice(0, 16_000),
        isError: result.exitCode !== 0
      };
    } catch (err) {
      return { output: `Error running tests: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
};

const listTestFilesTool: AgentTool = {
  name: 'list_test_files',
  description: 'Find all test files in the workspace. Searches for common test file patterns (*.test.ts, *.spec.ts, test_*.py, *_test.go).',
  parameters: [
    { name: 'cwd', description: 'Subdirectory to search in (optional, defaults to whole workspace)' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const patterns = [
      '**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.test.jsx',
      '**/*.spec.ts', '**/*.spec.tsx', '**/*.spec.js', '**/*.spec.jsx',
      '**/test_*.py', '**/*_test.py', '**/*_test.go',
    ];

    const allFiles: string[] = [];
    const cwd = params.cwd
      ? `${ctx.workspaceRoot}/${params.cwd}`
      : ctx.workspaceRoot;

    for (const pattern of patterns) {
      try {
        const files = await ctx.listFiles(pattern, cwd);
        allFiles.push(...files);
      } catch {
        // pattern matched nothing
      }
    }

    const unique = [...new Set(allFiles)].sort();
    if (unique.length === 0) {
      return { output: 'No test files found.' };
    }

    return { output: `${unique.length} test file(s) found:\n\n${unique.join('\n')}` };
  }
};

export const testGenSkill: SkillManifest = {
  id: 'testing/test-gen',
  name: 'Testing',
  version: '1.0.0',
  description: 'Run tests, find test files, and assist with test generation.',
  instructions: 'When writing tests, first use list_test_files to understand existing test patterns. Use run_tests to verify your changes. Match the existing test style and framework.',
  activation: 'auto',
  triggerPatterns: [/\btest/i, /\bspec\b/i, /\bcoverage\b/i, /\bunit\s+test/i],
  tools: [runTestsTool, listTestFilesTool]
};
