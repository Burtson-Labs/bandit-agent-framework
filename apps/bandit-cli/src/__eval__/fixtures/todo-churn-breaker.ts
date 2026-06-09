import type { Fixture } from '../types';

/**
 * Pins the repeated-todo-write circuit breaker added to tool-use-loop.ts
 * in response to pburg-bowl 2026-04-21: the model emitted `todo_write` as
 * the ONLY tool in iterations 0, 1, and 2, revising its plan each time
 * instead of executing any step. After two consecutive todo-only
 * iterations the loop now drops further `todo_write` calls and injects
 * a nudge telling the model to execute a concrete tool.
 *
 * The fixture prompt is a bite-size task that a well-behaved agent
 * resolves in one or two tool calls. A failing model (stuck in plan
 * churn) would hit the breaker and still produce a valid final answer
 * — the assertion is simply that iterations stay bounded and at least
 * one non-planning tool is invoked.
 *
 * @type {import('@burtson-labs/bandit-stealth-cli').Fixture}
 */
export const fixture: Fixture = {
  id: 'loop.todo_churn_breaker',
  description: 'Repeated todo_write must be short-circuited; a real tool call must land',
  prompt: 'Read src/demo.ts and tell me what the greet function returns for the input "world".',
  setup: {
    files: {
      'src/demo.ts': [
        'export function greet(name: string): string {',
        '  return `hello, ${name}`;',
        '}',
        ''
      ].join('\n')
    }
  },
  assertions: {
    // A concrete tool must land. We allow list_files for exploration,
    // but at minimum the model should read_file or search_code to
    // answer the question — if it only calls todo_write, the breaker
    // should have fired and the run fails by definition (no real tool
    // call happened).
    mustCallAnyOf: ['read_file', 'search_code', 'list_files'],
    // Keep the iteration budget tight so a model that churns on
    // todo_write would blow past it and fail loudly. The breaker's
    // job is to prevent exactly that.
    maxIterations: 6
  },
  runs: 3,
  passThreshold: 2,
  maxIterations: 8
};
