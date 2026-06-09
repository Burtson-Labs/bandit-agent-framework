import { createWebAdapter } from "@burtson-labs/agent-adapters-web";

const adapter = createWebAdapter(
  typeof window !== "undefined"
    ? { target: window }
    : {}
);

export const runDemo = async (goal: string) => {
  const plan = await adapter.plan(goal);
  await adapter.execute();
  const report = await adapter.report();
  return {
    plan,
    report
  };
};

if (typeof window === "undefined") {
  runDemo("Summarize how the Bandit web adapter works.").then(({ report }) => {
    console.log(report.summary);
  });
}
