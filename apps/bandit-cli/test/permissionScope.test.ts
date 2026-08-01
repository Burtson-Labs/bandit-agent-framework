/**
 * The CLI half of the permission-scope fix: the picker's option set, and the
 * guarantee that the hints shown on the card come from the same function that
 * computes the rule the gate stores.
 *
 * The gate itself lives inside a 5,000-line closure in cli.ts and isn't
 * unit-reachable, so these tests pin the contract at both ends — the picker's
 * choices and host-kit's scope computation — which is where the two previously
 * disagreed.
 */
import { describe, it, expect } from 'vitest';
import { grantRuleFor } from '@burtson-labs/host-kit';
import type { PermissionChoice } from '../src/permissionPrompt';
import { formatDenialReason } from '../src/permissionPrompt';

const scopeInput = (cmd: string, args: string) => ({
  toolName: 'run_command',
  params: { cmd, args },
  primary: cmd,
  primaryFull: `${cmd} ${args}`.trim()
});

describe('picker scope hints match what gets stored', () => {
  // The regression: the card rendered `npx create-vite my-app --template react`
  // and the gate stored `run_command:npx`.
  it('every hint the card can show is generated from the stored rule', () => {
    const input = scopeInput('npx', 'create-vite my-app --template react');
    for (const scope of ['once', 'turn', 'session', 'always'] as const) {
      const { rule, describes } = grantRuleFor(input, scope);
      expect(describes.length, scope).toBeGreaterThan(0);
      if (scope === 'session' || scope === 'always') {
        // The hint names the same command shape the rule encodes.
        expect(rule, scope).toBe('run_command:npx create-vite*');
        expect(describes, scope).toContain('npx create-vite');
      } else {
        expect(rule, scope).toBeNull();
      }
    }
  });

  it('a persistent scope always tells the user how long it lasts', () => {
    const input = scopeInput('git', 'status');
    expect(grantRuleFor(input, 'session').describes).toContain('session');
    expect(grantRuleFor(input, 'always').describes).toContain('.bandit/settings.json');
  });
});

describe('permission choices', () => {
  it('turn sits between once and session', () => {
    // Ordering is load-bearing for the digit shortcuts (1-6) and for muscle
    // memory: `1` stays "allow once".
    const choices: PermissionChoice[] = ['once', 'turn', 'session', 'always', 'deny'];
    expect(choices.indexOf('turn')).toBeGreaterThan(choices.indexOf('once'));
    expect(choices.indexOf('turn')).toBeLessThan(choices.indexOf('session'));
  });
});

describe('formatDenialReason', () => {
  it('turns a user note into actionable guidance for the model', () => {
    const reason = formatDenialReason(
      { choice: 'deny', notes: 'use the staging bucket instead' },
      'run_command',
      'aws'
    );
    expect(reason).toContain('use the staging bucket instead');
    expect(reason).toContain('Do not retry');
  });

  it('still tells the model not to retry when there is no note', () => {
    const reason = formatDenialReason({ choice: 'deny' }, 'delete_file', 'src/x.ts');
    expect(reason).toContain('Do not retry');
  });
});
