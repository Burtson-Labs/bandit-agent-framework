import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { openTurnLog, previewText } from '../src/turnLog';

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const GHP = `ghp_${'a1B2'.repeat(9)}`;

describe('turn log redaction', () => {
  it('redacts secrets in every string field written to .bandit/turns', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bandit-turnlog-'));
    try {
      const log = await openTurnLog(root);
      await log.append({ type: 'user-prompt', prompt: `use ${GHP} to push` });
      await log.append({ type: 'tool-execute', iteration: 1, name: 'run_command', params: { command: `export GH=${GHP}`, nested: [{ key: AWS }] } });
      await log.append({
        type: 'tool-result',
        iteration: 1,
        name: 'read_file',
        isError: false,
        outputPreview: previewText(`AWS_ACCESS_KEY_ID=${AWS}\ntoken ${GHP}\n`)
      });
      await log.append({ type: 'final-response', iterations: 1, hitLimit: false, finalPreview: `done with ${AWS}` });

      const raw = readFileSync(log.filePath, 'utf-8');
      expect(raw).not.toContain(AWS);
      expect(raw).not.toContain(GHP);
      expect(raw).toContain('<REDACTED:aws-access-key>');
      expect(raw).toContain('<REDACTED:github-pat>');
      // Structure and non-string fields survive.
      const events = raw.trim().split('\n').map((l) => JSON.parse(l));
      expect(events.map((e) => e.type)).toEqual(['user-prompt', 'tool-execute', 'tool-result', 'final-response']);
      expect(events[1].iteration).toBe(1);
      expect(events[2].isError).toBe(false);
      expect(events[1].params.nested[0].key).toBe('<REDACTED:aws-access-key>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
