/**
 * Contract: the TypeScript adapter must accept valid TSX.
 *
 * Regression for the 2026-06-12 TSX refactor wall: transpileModule
 * with no fileName/jsx option parses everything as plain .ts, where JSX
 * is a syntax error ("'>' expected", "Unterminated regular expression
 * literal" from `</header>` reading as a regex). Every valid .tsx
 * write_file was rejected, and the model — correctly! — concluded the
 * tool environment could not write TSX.
 *
 * These tests run the adapter's real node -e validation script, so they
 * also pin that `typescript` resolves from the package (the
 * broken-input cases prove the validator actually engaged rather than
 * silently skipping).
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { TypeScriptAdapter } from '../src/tools/language-adapters';
import type { ToolExecutionContext } from '../src/index';
import { testCtx } from './_helpers';

const pexec = promisify(execFile);

const realRunCtx: ToolExecutionContext = {
  ...testCtx,
  async runCommand(cmd: string, args: string[]) {
    try {
      const { stdout, stderr } = await pexec(cmd, args, { cwd: process.cwd() });
      return { stdout, stderr, exitCode: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.code ?? 1 };
    }
  }
};

const VALID_TSX = [
  "import React from 'react';",
  'type HeaderProps = { title: string };',
  'const Header: React.FC<HeaderProps> = ({ title }) => (',
  '  <header className="header"><h1>{title}</h1><nav><a href="#about">About</a></nav></header>',
  ');',
  'export default Header;'
].join('\n');

describe('TypeScriptAdapter — TSX support', () => {
  const adapter = new TypeScriptAdapter();

  it('accepts valid TSX with JSX markup', async () => {
    const result = await adapter.validate('src/components/Header.tsx', VALID_TSX, realRunCtx);
    expect(result).toEqual({ ok: true });
  });

  it('still rejects genuinely broken TSX (proves the validator engaged)', async () => {
    const broken = VALID_TSX.replace('</header>', '<header>');
    const result = await adapter.validate('src/components/Header.tsx', broken, realRunCtx);
    expect(result.ok).toBe(false);
  });

  it('still rejects broken plain TS', async () => {
    const result = await adapter.validate('src/util.ts', 'const x: = 5;;;function {', realRunCtx);
    expect(result.ok).toBe(false);
  });

  it('keeps accepting valid plain TS', async () => {
    const result = await adapter.validate('src/util.ts', 'export const add = (a: number, b: number): number => a + b;', realRunCtx);
    expect(result).toEqual({ ok: true });
  });
});
