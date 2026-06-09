/**
 * Contract tests for the hooks module — `.bandit/settings.json` /
 * `.bandit/settings.local.json` loading + merging, persistAllowEntry,
 * and runHooks (template expansion, regex match filter, shell escape,
 * non-zero exit propagation, timeout).
 *
 * Why pin: hooks are how users insert PreToolUse/PostToolUse gates
 * around the agent (e.g. tsc on every Edit, deny rules for kubectl).
 * A regression in:
 *   - regex match filtering would silently fire hooks on the wrong tools
 *   - placeholder expansion would leak un-escaped tool params into the shell
 *   - exit-code reporting would let denied tool calls slip through
 *   - settings merge precedence would drop user-local overrides
 * …any of which is a security or correctness footgun. Tests use a tmp
 * workspace per case so file-system state stays isolated, and shell
 * out to real /bin/sh so we test the actual spawn surface.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadHookSettings,
  persistAllowEntry,
  runHooks
} from '../src/hooks';

let tmpRoot: string;
// Isolated, empty home so loadHookSettings doesn't merge the developer's real
// ~/.bandit/settings.json into these hermetic assertions.
let tmpHome: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-kit-hooks-test-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'host-kit-hooks-home-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('loadHookSettings', () => {
  it('returns an empty merged shape when no settings files exist', async () => {
    const s = await loadHookSettings(tmpRoot, { homeDir: tmpHome });
    expect(s.hooks).toEqual({});
    expect(s.permissions).toEqual({ allow: [], deny: [], ask: [] });
  });

  it('loads .bandit/settings.json when present', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.bandit'));
    fs.writeFileSync(
      path.join(tmpRoot, '.bandit', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ match: 'write_file', command: 'echo blocked' }]
        },
        permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] }
      })
    );
    const s = await loadHookSettings(tmpRoot, { homeDir: tmpHome });
    expect(s.hooks?.PreToolUse).toHaveLength(1);
    expect(s.hooks?.PreToolUse?.[0].match).toBe('write_file');
    expect(s.permissions?.allow).toContain('Bash(ls:*)');
    expect(s.permissions?.deny).toContain('Bash(rm:*)');
  });

  it('merges settings.json and settings.local.json (rules concatenated, permissions union)', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.bandit'));
    fs.writeFileSync(
      path.join(tmpRoot, '.bandit', 'settings.json'),
      JSON.stringify({
        hooks: { PostToolUse: [{ command: 'echo shared' }] },
        permissions: { allow: ['shared-allow'] }
      })
    );
    fs.writeFileSync(
      path.join(tmpRoot, '.bandit', 'settings.local.json'),
      JSON.stringify({
        hooks: { PostToolUse: [{ command: 'echo local' }] },
        permissions: { allow: ['local-allow'], deny: ['local-deny'] }
      })
    );
    const s = await loadHookSettings(tmpRoot, { homeDir: tmpHome });
    expect(s.hooks?.PostToolUse).toHaveLength(2);
    // Order: settings.json first, then settings.local.json.
    expect(s.hooks?.PostToolUse?.[0].command).toBe('echo shared');
    expect(s.hooks?.PostToolUse?.[1].command).toBe('echo local');
    expect(s.permissions?.allow).toEqual(['shared-allow', 'local-allow']);
    expect(s.permissions?.deny).toEqual(['local-deny']);
  });

  it('silently skips invalid JSON instead of throwing', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.bandit'));
    fs.writeFileSync(path.join(tmpRoot, '.bandit', 'settings.json'), '{ not valid json');
    // Should resolve, not reject.
    const s = await loadHookSettings(tmpRoot, { homeDir: tmpHome });
    expect(s.hooks).toEqual({});
  });
});

describe('persistAllowEntry', () => {
  it('creates .bandit/settings.json with the new entry when no file exists', async () => {
    await persistAllowEntry(tmpRoot, 'Bash(ls:*)');
    const file = path.join(tmpRoot, '.bandit', 'settings.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.permissions.allow).toEqual(['Bash(ls:*)']);
  });

  it('appends to existing allow list and does not duplicate', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.bandit'));
    fs.writeFileSync(
      path.join(tmpRoot, '.bandit', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['existing'] } })
    );
    await persistAllowEntry(tmpRoot, 'new-entry');
    await persistAllowEntry(tmpRoot, 'existing'); // no-op (dedupe)
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.bandit', 'settings.json'), 'utf-8')
    );
    expect(parsed.permissions.allow).toEqual(['existing', 'new-entry']);
  });

  it('preserves unrelated settings (hooks, deny, etc.) when persisting an allow entry', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.bandit'));
    fs.writeFileSync(
      path.join(tmpRoot, '.bandit', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ match: 'x', command: 'y' }] },
        permissions: { deny: ['Bash(rm:*)'] }
      })
    );
    await persistAllowEntry(tmpRoot, 'Bash(ls:*)');
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.bandit', 'settings.json'), 'utf-8')
    );
    expect(parsed.hooks.PreToolUse[0].command).toBe('y');
    expect(parsed.permissions.deny).toEqual(['Bash(rm:*)']);
    expect(parsed.permissions.allow).toEqual(['Bash(ls:*)']);
  });
});

describe('runHooks', () => {
  it('returns [] when no rules are configured for the event', async () => {
    const r = await runHooks('PreToolUse', {}, { toolName: 'write_file' }, tmpRoot);
    expect(r).toEqual([]);
  });

  it('runs all rules whose match regex tests true against the tool name', async () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { match: 'write_file', command: 'echo writefile-fired' },
          { match: 'read_file', command: 'echo readfile-fired' },
          { match: 'write_.*', command: 'echo writeprefix-fired' }
        ]
      }
    };
    const results = await runHooks('PreToolUse', settings, { toolName: 'write_file' }, tmpRoot);
    expect(results).toHaveLength(2);
    expect(results[0].stdout).toContain('writefile-fired');
    expect(results[1].stdout).toContain('writeprefix-fired');
    // read_file rule did not match → no hit.
    for (const r of results) expect(r.stdout).not.toContain('readfile-fired');
  });

  it('runs rules with no `match` field for every tool', async () => {
    const settings = {
      hooks: { PostToolUse: [{ command: 'echo always' }] }
    };
    const r1 = await runHooks('PostToolUse', settings, { toolName: 'anything' }, tmpRoot);
    const r2 = await runHooks('PostToolUse', settings, { toolName: 'whatever' }, tmpRoot);
    expect(r1[0].stdout).toContain('always');
    expect(r2[0].stdout).toContain('always');
  });

  it('substitutes {{name}}, {{primary}}, {{duration}} placeholders', async () => {
    const settings = {
      hooks: {
        PostToolUse: [{ command: 'echo "name={{name}} primary={{primary}} duration={{duration}}"' }]
      }
    };
    const r = await runHooks(
      'PostToolUse',
      settings,
      { toolName: 'edit', primary: 'src/file.ts', durationMs: 42 },
      tmpRoot
    );
    expect(r[0].stdout).toContain('name=');
    expect(r[0].stdout).toContain('edit');
    expect(r[0].stdout).toContain('primary=');
    expect(r[0].stdout).toContain('src/file.ts');
    expect(r[0].stdout).toContain('duration=42');
  });

  it('shell-escapes placeholder values to prevent command injection', async () => {
    // Adversarial primary tries to chain commands. After expansion the
    // value is wrapped in single quotes so the inner `; rm` runs as
    // literal text, not a separate command.
    const settings = {
      hooks: {
        PreToolUse: [{ command: 'echo "got: {{primary}}"' }]
      }
    };
    const evil = `; touch ${tmpRoot}/EVIL_PWNED ;`;
    const r = await runHooks(
      'PreToolUse',
      settings,
      { toolName: 'write_file', primary: evil },
      tmpRoot
    );
    expect(r[0].exitCode).toBe(0);
    // Stdout contains the literal string, not the result of executing it.
    expect(r[0].stdout).toContain('touch');
    // The injection target file must NOT exist.
    expect(fs.existsSync(path.join(tmpRoot, 'EVIL_PWNED'))).toBe(false);
  });

  it('reports non-zero exit codes (caller decides how to react)', async () => {
    const settings = {
      hooks: { PreToolUse: [{ command: 'exit 7' }] }
    };
    const r = await runHooks('PreToolUse', settings, { toolName: 'anything' }, tmpRoot);
    expect(r).toHaveLength(1);
    expect(r[0].exitCode).toBe(7);
  });

  it('captures stderr separately from stdout', async () => {
    const settings = {
      hooks: { PostToolUse: [{ command: 'echo to-stdout; echo to-stderr 1>&2' }] }
    };
    const r = await runHooks('PostToolUse', settings, { toolName: 'x' }, tmpRoot);
    expect(r[0].stdout).toContain('to-stdout');
    expect(r[0].stderr).toContain('to-stderr');
  });

  it('terminates a hook that exceeds its timeout (does not hang the loop)', async () => {
    // Note: when SIGTERM kills the child, Node's `close` event fires with
    // exit code = null and the implementation maps `code ?? 0` → 0. So we
    // can't distinguish a timed-out hook from a clean exit by exitCode
    // alone today; the load-bearing contract here is "the timeout actually
    // fires within the budget", not the exit code value. If we ever want
    // callers to detect timeouts, the implementation needs to expose the
    // signal or set a sentinel exitCode.
    const settings = {
      hooks: { PreToolUse: [{ command: 'sleep 5', timeout: 200 }] }
    };
    const start = Date.now();
    const r = await runHooks('PreToolUse', settings, { toolName: 'x' }, tmpRoot);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000); // would be 5s+ without the SIGTERM
    expect(r).toHaveLength(1);
  });
});
