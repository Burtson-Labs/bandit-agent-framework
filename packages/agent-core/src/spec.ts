/**
 * Spec-driven development — the shared core.
 *
 * A spec is a durable, human-written markdown artifact: a goal plus explicit
 * acceptance criteria. It's the most leveraged thing a person can produce when
 * an agent writes the code. This module turns that spec into a GRAPH PLAN:
 * the planner (Phase 9) proposes nodes that implement the spec, and the
 * acceptance criteria become the run's verification — the same completion-
 * contract / verification-node machinery the graph runtime already enforces.
 *
 * So spec-driven dev here is a COMPOSITION, not a new engine: spec → planner →
 * graph → contracts-as-acceptance-criteria. This file is pure (parse + prompt
 * building), mirroring the planner/suggestions/lessons split; the host reads
 * the file, runs the graph, and checks the criteria.
 */

export interface SpecDoc {
  /** Title (the `# heading`). */
  title: string;
  /** The goal paragraph(s) under `## Goal`. */
  goal: string;
  /** Acceptance criteria (bullets/checkboxes under `## Acceptance criteria`).
   *  These become the run's verification targets. */
  criteria: string[];
  /** Files/paths named under `## Context` (bias the plan toward real work). */
  context: string[];
  /** Hard constraints under `## Constraints` ("don't touch the public API"). */
  constraints: string[];
}

/** A blank spec to scaffold with `bandit spec new`. */
export function specTemplate(title: string): string {
  const t = title.trim() || 'Untitled feature';
  return [
    `# ${t}`,
    '',
    '## Goal',
    '<One short paragraph: what should be true when this is done, and why.>',
    '',
    '## Acceptance criteria',
    '- [ ] <A concrete, checkable outcome — e.g. "GET /health returns 200 with {status:\'ok\'}">',
    '- [ ] <Another — keep each one independently verifiable>',
    '',
    '## Context',
    '- <path/to/relevant/file.ts>',
    '',
    '## Constraints',
    '- <e.g. "Do not change the public API in src/index.ts">',
    ''
  ].join('\n');
}

/**
 * Parse a structured markdown spec. Lenient: a bare goal with no headings is
 * treated as the goal; missing sections yield empty arrays. Checkbox markers
 * (`- [ ]` / `- [x]`) and plain bullets both count as criteria.
 */
export function parseSpec(markdown: string): SpecDoc {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  const sections = new Map<string, string[]>();
  let current = 'goal'; // text before the first heading is the goal

  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h1 && !title) {
      title = h1[1].trim();
      continue;
    }
    if (h2) {
      current = h2[1].trim().toLowerCase();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    const bucket = sections.get(current) ?? [];
    bucket.push(line);
    sections.set(current, bucket);
  }

  const bullets = (key: string): string[] =>
    (sections.get(key) ?? [])
      .map((l) => l.trim())
      .map((l) => l.replace(/^[-*]\s+(\[[ xX]\]\s*)?/, '')) // strip bullet + optional checkbox
      .filter((l) => l.length > 0 && !/^<.*>$/.test(l)); // drop empties + template placeholders

  const paragraph = (key: string): string =>
    (sections.get(key) ?? [])
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^<.*>$/.test(l))
      .join(' ')
      .trim();

  // Accept a few heading aliases people actually type.
  const criteria = bullets('acceptance criteria').length
    ? bullets('acceptance criteria')
    : bullets('criteria').length
      ? bullets('criteria')
      : bullets('requirements');

  return {
    title: title || 'Untitled spec',
    goal: paragraph('goal'),
    criteria,
    context: bullets('context'),
    constraints: bullets('constraints')
  };
}

export interface SpecValidation {
  ok: boolean;
  errors: string[];
}

/** A spec is runnable only if it has a goal and at least one criterion. */
export function validateSpec(spec: SpecDoc): SpecValidation {
  const errors: string[] = [];
  if (!spec.goal.trim()) errors.push('spec has no ## Goal');
  if (spec.criteria.length === 0) errors.push('spec has no ## Acceptance criteria (need at least one checkable outcome)');
  return { ok: errors.length === 0, errors };
}

/**
 * Build the planner prompt for a spec. It asks for the SAME GraphProposal JSON
 * the planner already emits (so parseGraphProposal validates it), but seeded
 * with the spec: implementation nodes for the work, then a final verification
 * node whose job is to check every acceptance criterion. The host maps that
 * final node to a completion contract, so "did we meet the spec?" is enforced
 * by the graph runtime, not asserted in prose.
 */
export function buildSpecPlanPrompt(spec: SpecDoc, maxNodes = 6): string {
  const criteria = spec.criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
  const context = spec.context.length ? `\nRelevant files:\n${spec.context.map((c) => `  - ${c}`).join('\n')}` : '';
  const constraints = spec.constraints.length ? `\nConstraints (must honor):\n${spec.constraints.map((c) => `  - ${c}`).join('\n')}` : '';
  return [
    `You are planning how to implement a SPEC as a dependency graph. Output ONE JSON object in a \`\`\`json fence and nothing else.`,
    '',
    `Spec: ${spec.title}`,
    `Goal: ${spec.goal}`,
    '',
    'Acceptance criteria (the definition of done):',
    criteria,
    context,
    constraints,
    '',
    'JSON shape (same as the planner):',
    '{"kind":"graph","reason":"one sentence","nodes":[{"id":"kebab-case","label":"short","prompt":"self-contained instruction","dependsOn":["other-id"],"readOnly":false}]}',
    '',
    'Rules:',
    `- Always "kind":"graph". Use 2-${maxNodes} nodes.`,
    '- Early nodes do the implementation work, split by concern; ids kebab-case + unique; dependsOn lists only earlier ids; no cycles.',
    '- The LAST node must be a verification node that depends on the others and checks EVERY acceptance criterion is satisfied, reporting per-criterion pass/fail. Give it id "verify-spec".',
    '- Each node prompt is self-contained (its reader sees only that prompt + its dependencies\' results). Reference the specific criteria a node addresses.',
    '- Mark investigation/verification nodes "readOnly": true.'
  ].filter((l) => l !== '').join('\n');
}
