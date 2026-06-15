/**
 * Contract: when the model claims a tool is unavailable but the tool
 * IS registered, the detector fires AND surfaces the correct name.
 *
 * Pin the failure mode captured 2026-05-25 — model said it couldn't
 * trash messages even though `burtson-labs.trashMessage` was registered
 * with 119 other MCP tools.
 */
import { describe, expect, it } from 'vitest';
import { detectFalseToolAbsence, buildToolAvailabilityNudge } from '../src/tools/toolAvailabilityDetector';

describe('detectFalseToolAbsence', () => {
  const REGISTERED = [
    'burtson-labs.trashMessage',
    'burtson-labs.archiveMessage',
    'burtson-labs.createFilter',
    'burtson-labs.listMessages',
    'burtson-labs.sendMessage',
    'read_file',
    'write_file',
    'apply_edit',
  ];

  it('fires when model claims trashMessage is unavailable (exact bare name)', () => {
    const response = 'I don\'t have access to the trashMessage tool, so I cannot remove these emails.';
    const result = detectFalseToolAbsence(response, REGISTERED);
    expect(result.detected).toBe(true);
    expect(result.matchedToolNames).toContain('burtson-labs.trashMessage');
  });

  it('fires on camelCase → space variant ("trash message")', () => {
    const response = 'It looks like there is no trash message tool available in this session.';
    const result = detectFalseToolAbsence(response, REGISTERED);
    expect(result.detected).toBe(true);
    expect(result.matchedToolNames).toContain('burtson-labs.trashMessage');
  });

  it('fires on action-verb fallback when no exact name match', () => {
    // Model says "I don't have a trash tool" — no exact name but trashMessage exists
    const response = 'I do not have a trash tool to remove these messages.';
    const result = detectFalseToolAbsence(response, REGISTERED);
    expect(result.detected).toBe(true);
    expect(result.suggestedTools).toContain('burtson-labs.trashMessage');
  });

  it('does NOT fire when the response is normal narration', () => {
    const response = 'I read the file and found three matches. Here is the summary.';
    const result = detectFalseToolAbsence(response, REGISTERED);
    expect(result.detected).toBe(false);
  });

  it('does NOT fire when the claimed-missing tool is genuinely absent', () => {
    const response = 'I do not have access to the makeCoffee tool.';
    const result = detectFalseToolAbsence(response, REGISTERED);
    expect(result.detected).toBe(false);
  });

  it('does NOT fire when the registry is empty', () => {
    const response = 'I do not have access to the trashMessage tool.';
    const result = detectFalseToolAbsence(response, []);
    expect(result.detected).toBe(false);
  });

  it('handles mcp__server__tool naming variant', () => {
    const registered = ['mcp__google__sendEmail', 'mcp__google__listMessages'];
    const response = 'I am unable to find a sendEmail tool here.';
    const result = detectFalseToolAbsence(response, registered);
    expect(result.detected).toBe(true);
    expect(result.matchedToolNames).toContain('mcp__google__sendEmail');
  });

  it('matches "X tool is not available" phrasing', () => {
    const response = 'The trashMessage tool is not available right now.';
    const result = detectFalseToolAbsence(response, REGISTERED);
    expect(result.detected).toBe(true);
    expect(result.matchedToolNames).toContain('burtson-labs.trashMessage');
  });
});

describe('buildToolAvailabilityNudge', () => {
  it('lists the matched tool names in the corrective message', () => {
    const nudge = buildToolAvailabilityNudge({
      detected: true,
      matchedToolNames: ['burtson-labs.trashMessage'],
      suggestedTools: ['burtson-labs.trashMessage'],
    });
    expect(nudge).toContain('burtson-labs.trashMessage');
    expect(nudge).toMatch(/ARE registered/);
    expect(nudge).toMatch(/Re-attempt/);
  });

  it('falls back to suggestedTools when matchedToolNames is empty', () => {
    const nudge = buildToolAvailabilityNudge({
      detected: true,
      matchedToolNames: [],
      suggestedTools: ['burtson-labs.trashMessage', 'burtson-labs.archiveMessage'],
    });
    expect(nudge).toContain('burtson-labs.trashMessage');
    expect(nudge).toContain('burtson-labs.archiveMessage');
  });
});

describe('false-positive guards (2026-06-12 local-repo regression)', () => {
  // The reasoning closer "No further tool calls are needed" plus an
  // in-text mention of a registered tool fired the detector and
  // replaced a fully-formed final answer with meta-commentary about
  // tool availability. Completion statements about tool CALLS must
  // never read as absence claims.
  const REGISTERED = ['read_file', 'list_files', 'list_tasks', 'todo_write'];

  it('does not fire on "No further tool calls are needed"', () => {
    const text = 'I have used read_file to gather everything. No further tool calls are needed.';
    expect(detectFalseToolAbsence(text, REGISTERED).detected).toBe(false);
  });

  it('does not fire on "no additional tool calls required"', () => {
    const text = 'The overview is complete from list_files output; no additional tool calls required.';
    expect(detectFalseToolAbsence(text, REGISTERED).detected).toBe(false);
  });

  it('still fires on a genuine absence claim naming a registered tool', () => {
    const text = 'I cannot complete this: there is no read_file tool available to me.';
    expect(detectFalseToolAbsence(text, REGISTERED).detected).toBe(true);
  });

  it('nudge identifies itself as an automated check', () => {
    const result = detectFalseToolAbsence('there is no read_file tool available', REGISTERED);
    expect(buildToolAvailabilityNudge(result)).toMatch(/^AUTOMATED HARNESS CHECK/);
  });
});
