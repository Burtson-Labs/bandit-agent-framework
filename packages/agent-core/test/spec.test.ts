/**
 * Spec-driven development core. Properties: a structured markdown spec parses
 * into title/goal/criteria/context/constraints (tolerating checkboxes,
 * aliases, and template placeholders), validation catches unrunnable specs,
 * and the plan prompt seeds the planner's GraphProposal shape with the spec +
 * a mandated final verification node covering every criterion.
 */
import { describe, it, expect } from 'vitest';
import { parseSpec, validateSpec, buildSpecPlanPrompt, specTemplate, type SpecDoc } from '../src/spec';
import { parseGraphProposal } from '../src/graph';

const SPEC_MD = `# Add a health endpoint

## Goal
Expose a health check so the load balancer can tell if the service is up.

## Acceptance criteria
- [ ] GET /health returns 200 with {status:"ok"}
- [ ] the route is registered in the main router
- [x] a test covers the 200 response

## Context
- src/server.ts
- src/routes/index.ts

## Constraints
- Do not change the existing /status route
`;

describe('parseSpec', () => {
  it('extracts title, goal, criteria (checkbox-agnostic), context, constraints', () => {
    const s = parseSpec(SPEC_MD);
    expect(s.title).toBe('Add a health endpoint');
    expect(s.goal).toMatch(/load balancer/);
    expect(s.criteria).toEqual([
      'GET /health returns 200 with {status:"ok"}',
      'the route is registered in the main router',
      'a test covers the 200 response',
    ]);
    expect(s.context).toEqual(['src/server.ts', 'src/routes/index.ts']);
    expect(s.constraints).toEqual(['Do not change the existing /status route']);
  });

  it('drops template placeholders and empty bullets', () => {
    const s = parseSpec(specTemplate('My feature'));
    expect(s.title).toBe('My feature');
    expect(s.criteria).toEqual([]); // all placeholders → nothing real yet
  });

  it('accepts heading aliases (requirements) and a bare goal', () => {
    const s = parseSpec('# T\n\n## Goal\nDo the thing.\n\n## Requirements\n- it works\n');
    expect(s.criteria).toEqual(['it works']);
  });
});

describe('validateSpec', () => {
  it('passes a complete spec, fails on missing goal or criteria', () => {
    expect(validateSpec(parseSpec(SPEC_MD)).ok).toBe(true);
    const noGoal: SpecDoc = { title: 't', goal: '', criteria: ['x'], context: [], constraints: [] };
    expect(validateSpec(noGoal).errors[0]).toMatch(/no ## Goal/);
    const noCriteria: SpecDoc = { title: 't', goal: 'g', criteria: [], context: [], constraints: [] };
    expect(validateSpec(noCriteria).errors[0]).toMatch(/Acceptance criteria/);
  });
});

describe('buildSpecPlanPrompt', () => {
  it('seeds goal + numbered criteria + constraints + the mandated verify node', () => {
    const p = buildSpecPlanPrompt(parseSpec(SPEC_MD));
    expect(p).toContain('Add a health endpoint');
    expect(p).toMatch(/1\. GET \/health returns 200/);
    expect(p).toContain('Do not change the existing /status route');
    expect(p).toContain('verify-spec');
    expect(p).toMatch(/EVERY acceptance criterion/);
  });

  it('produces a prompt whose expected JSON validates as a graph proposal', () => {
    // Simulate the model answering the spec-plan prompt with a valid graph.
    const modelReply = '```json\n' + JSON.stringify({
      kind: 'graph',
      reason: 'implement then verify the health endpoint',
      nodes: [
        { id: 'add-route', prompt: 'Add the /health route returning 200 {status:"ok"} in src/server.ts.' },
        { id: 'add-test', prompt: 'Add a test for the /health 200 response.', dependsOn: ['add-route'] },
        { id: 'verify-spec', prompt: 'Verify each acceptance criterion is met.', dependsOn: ['add-route', 'add-test'], readOnly: true },
      ],
    }) + '\n```';
    const parsed = parseGraphProposal(modelReply);
    expect(parsed.ok).toBe(true);
    expect(parsed.proposal?.nodes?.some((n) => n.id === 'verify-spec')).toBe(true);
  });
});
