/**
 * Request-input policy (SEC-002) — the containment tests.
 *
 * `workspacePath` picks the jail root for an autonomous agent's file
 * writes, so every known way to point it somewhere else gets a case here:
 * a `..` traversal, a plain absolute path, and the one that survives a
 * lexical check — a symlink INSIDE the root pointing outside it. If a
 * refactor ever reopens one of these, this file is what fails.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContractError } from '../src/contract';
import { resolveWorkspacePath, validateProvider } from '../src/policy';

let tmp: string;
let root: string;
let outside: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-policy-'));
  root = path.join(tmp, 'root');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(root, 'task-1'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof ContractError ? err.code : `unexpected:${String(err)}`;
  }
  return 'no-throw';
};

describe('resolveWorkspacePath', () => {
  it('accepts a path inside the root and returns its canonical form', () => {
    const resolved = resolveWorkspacePath(path.join(root, 'task-1'), root);
    expect(resolved).toBe(fs.realpathSync(path.join(root, 'task-1')));
  });

  it('rejects a `..` traversal out of the root', () => {
    expect(codeOf(() => resolveWorkspacePath(path.join(root, 'task-1', '..', '..', 'outside'), root))).toBe(
      'BAD_REQUEST',
    );
  });

  it('rejects an absolute path outside the root', () => {
    expect(codeOf(() => resolveWorkspacePath('/etc', root))).toBe('BAD_REQUEST');
    expect(codeOf(() => resolveWorkspacePath(outside, root))).toBe('BAD_REQUEST');
  });

  it('rejects a symlink inside the root that resolves outside it', () => {
    fs.symlinkSync(outside, path.join(root, 'escape-link'), 'dir');

    expect(() => resolveWorkspacePath(path.join(root, 'escape-link'), root)).toThrow(/via symlink/);
    expect(codeOf(() => resolveWorkspacePath(path.join(root, 'escape-link'), root))).toBe('BAD_REQUEST');
  });

  it('accepts a symlink that stays inside the root', () => {
    fs.symlinkSync(path.join(root, 'task-1'), path.join(root, 'inside-link'), 'dir');

    expect(resolveWorkspacePath(path.join(root, 'inside-link'), root)).toBe(
      fs.realpathSync(path.join(root, 'task-1')),
    );
  });

  it('rejects a path that does not exist — the workspace is prepared before the turn', () => {
    expect(codeOf(() => resolveWorkspacePath(path.join(root, 'never-made'), root))).toBe('BAD_REQUEST');
  });

  it('refuses every turn when no containment root is configured', () => {
    expect(codeOf(() => resolveWorkspacePath(path.join(root, 'task-1'), undefined))).toBe(
      'RUNNER_MISCONFIGURED',
    );
    expect(codeOf(() => resolveWorkspacePath(path.join(root, 'task-1'), path.join(tmp, 'missing')))).toBe(
      'RUNNER_MISCONFIGURED',
    );
  });
});

describe('validateProvider', () => {
  it('has nothing to check for the deterministic provider', () => {
    expect(() => validateProvider({ kind: 'deterministic' }, ['models.example.com'])).not.toThrow();
  });

  it('rejects non-http(s) and malformed base URLs', () => {
    const ollama = (baseUrl: string) => ({ kind: 'ollama', baseUrl, model: 'm' }) as const;
    expect(() => validateProvider(ollama('file:///etc/passwd'), undefined)).toThrow(/must be http\(s\)/);
    expect(() => validateProvider(ollama('not a url'), undefined)).toThrow(/not a valid URL/);
  });

  it('enforces the host allowlist, case-insensitively', () => {
    const spec = { kind: 'ollama', baseUrl: 'http://Models.Example.com:11434', model: 'm' } as const;
    expect(() => validateProvider(spec, ['models.example.com'])).not.toThrow();
    expect(() => validateProvider(spec, ['other.example'])).toThrow(/not in AGENT_RUNNER_ALLOWED_PROVIDER_HOSTS/);
    expect(() => validateProvider({ ...spec, baseUrl: 'http://169.254.169.254/latest' }, ['models.example.com'])).toThrow(
      /not in AGENT_RUNNER_ALLOWED_PROVIDER_HOSTS/,
    );
  });

  it('matches host:port entries on the port too', () => {
    const spec = (port: number) =>
      ({ kind: 'openai-compat', baseUrl: `http://gateway.internal:${port}/v1`, apiKey: 'k', model: 'm' }) as const;
    expect(() => validateProvider(spec(8080), ['gateway.internal:8080'])).not.toThrow();
    expect(() => validateProvider(spec(9090), ['gateway.internal:8080'])).toThrow(/not in/);
  });

  it('allows any http(s) host when no allowlist is configured', () => {
    expect(() =>
      validateProvider({ kind: 'ollama', baseUrl: 'https://anything.example', model: 'm' }, undefined),
    ).not.toThrow();
  });
});
