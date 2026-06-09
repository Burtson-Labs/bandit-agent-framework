/**
 * Bandit Agent Framework — minimal Node host.
 *
 * A complete agent in a handful of lines. `createNodeAdapter()` wires the
 * tool-use loop to your Node environment (filesystem + shell); then
 * plan → execute → report runs one turn against a goal.
 *
 *   pnpm -C examples/agent-node-demo build
 *   node dist/index.js "add error handling to src/db.ts"
 *
 * To customize the provider, model, or tools, drop down to
 * createStealthRuntime / createAgentRuntime — see the "Build your own host"
 * guide at https://docs.burtson.ai/build-your-own-host.html.
 */
import { createNodeAdapter } from "@burtson-labs/agent-adapters-node";

// Goal from the CLI arg, or a default for a zero-config first run.
const goal =
  process.argv.slice(2).join(" ") ||
  "Demonstrate the Bandit agent runtime in a Node environment.";

const run = async () => {
  // The adapter hands the agent a provider, the tool registry, and a
  // Node filesystem + shell to act through.
  const adapter = createNodeAdapter();

  // 1. Plan — the model turns the goal into discrete, ordered steps.
  console.log(`\nPlanning: ${goal}\n`);
  const plan = await adapter.plan(goal);
  plan.steps.forEach((step) => console.log(`  - [${step.id}] ${step.title}`));

  // 2. Execute — each step runs as tool calls (read_file, run_command, …).
  console.log("\nExecuting…\n");
  const results = await adapter.execute();
  results.forEach((result) => console.log(`  ${result.stepId} → ${result.status}`));

  // 3. Report — a human-readable summary of what the turn did.
  const report = await adapter.report();
  console.log(`\nSummary:\n${report.summary}\n`);
};

run().catch((error) => {
  console.error("Agent demo failed:", error);
  process.exitCode = 1;
});
