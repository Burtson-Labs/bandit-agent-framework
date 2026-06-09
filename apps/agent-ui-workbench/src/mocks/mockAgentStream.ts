import type {
  AgentContext,
  AgentDiff,
  AgentEvent,
  AgentExecutionResult,
  AgentPlan,
  AgentStep
} from "@burtson-labs/agent-core";
import type { AgentEventSource } from "@burtson-labs/agent-ui";

const mockContext: AgentContext = {
  files: ["apps/agent-ui-workbench/src/App.tsx", "packages/agent-ui/src/components/PlanTree.tsx"],
  goals: ["Prototype Agent UI workbench"],
  repository: "bandit-agent-framework",
  metadata: {
    branch: "feature/agent-ui-workbench",
    author: "Workbench Bot"
  }
};

const mockPlan: AgentPlan = {
  id: "plan-ui-workbench",
  goal: "Prototype Agent UI workbench",
  summary: "Build a mock IDE shell that streams events into @burtson-labs/agent-ui components.",
  createdAt: Date.now(),
  version: "1.0.0",
  steps: [
    {
      id: "step-1",
      title: "Bootstrap Vite shell",
      description: "Create a lightweight React container that mimics the VS Code sidebar.",
      status: "pending",
      metadata: {
        command: "pnpm create vite agent-ui-workbench"
      }
    },
    {
      id: "step-2",
      title: "Wire mock runtime",
      description: "Emit plan, telemetry, and diff events without calling the real runtime.",
      status: "pending",
      metadata: {
        command: "node scripts/mock-agent-run.mjs"
      }
    },
    {
      id: "step-3",
      title: "Render shared components",
      description: "Render PlanTree, DiffStream, TelemetryPanel, and AgentConsole side by side.",
      status: "pending",
      metadata: {
        command: "pnpm --filter agent-ui-workbench dev"
      }
    }
  ]
};

interface ListenerMap {
  [event: string]: Set<(event: AgentEvent) => void>;
}

interface ScheduledEvent {
  delay: number;
  type: string;
  payload?: unknown;
}

const createDiffs = (stepId: string): AgentDiff[] => {
  switch (stepId) {
    case "step-1":
      return [
        {
          path: "apps/agent-ui-workbench/vite.config.ts",
          type: "create",
          preview: "export default defineConfig({ ...viteDefaults })"
        }
      ];
    case "step-2":
      return [
        {
          path: "packages/agent-ui/src/hooks/useAgentEvents.ts",
          type: "update",
          preview: "source.on(type, handler)"
        }
      ];
    case "step-3":
      return [
        {
          path: "apps/agent-ui-workbench/src/App.tsx",
          type: "update",
          preview: "<PlanTree events={events} />"
        }
      ];
    default:
      return [];
  }
};

const buildExecutionResult = (step: AgentStep, success = true): AgentExecutionResult => ({
  stepId: step.id,
  status: success ? "completed" : "failed",
  diff: createDiffs(step.id),
  logs: success
    ? [`${step.title} finished without errors.`, `Touched ${createDiffs(step.id).length} files.`]
    : ["Runtime reported a failure"],
  metadata: {
    durationMs: 400 + Math.floor(Math.random() * 300)
  }
});

export class MockAgentEventStream implements AgentEventSource {
  private listeners: ListenerMap = {};
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private history: AgentEvent[] = [];
  private latestPlan: AgentPlan | null = null;
  private running = false;

  on(event: string, listener: (event: AgentEvent) => void): void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event].add(listener);
  }

  off(event: string, listener: (event: AgentEvent) => void): void {
    this.listeners[event]?.delete(listener);
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.history = [];
    this.latestPlan = null;
    this.playback();
  }

  restart(): void {
    this.stop();
    this.start();
  }

  stop(): void {
    this.running = false;
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers = [];
  }

  dispose(): void {
    this.stop();
    this.listeners = {};
  }

  getSnapshot(): AgentEvent[] {
    return [...this.history];
  }

  getPlan(): AgentPlan | null {
    return this.latestPlan;
  }

  private emit(type: string, payload?: unknown): void {
    const event: AgentEvent = {
      type,
      payload,
      timestamp: Date.now()
    };

    if (type === "plan:complete") {
      this.latestPlan = (payload as { plan?: AgentPlan } | undefined)?.plan ?? null;
    }

    this.history.push(event);
    this.listeners[type]?.forEach((listener) => listener(event));
  }

  private schedule(events: ScheduledEvent[]): void {
    let elapsed = 0;
    for (const entry of events) {
      elapsed += entry.delay;
      const handle = setTimeout(() => {
        this.emit(entry.type, entry.payload);
        if (entry.type === "report:complete") {
          this.running = false;
        }
      }, elapsed);
      this.timers.push(handle);
    }
  }

  private playback(): void {
    const events: ScheduledEvent[] = [
      { delay: 250, type: "plan:start", payload: { goal: mockPlan.goal, context: mockContext } },
      {
        delay: 400,
        type: "plan:chunk",
        payload: { chunk: "Scanning repository and previous agent runs..." }
      },
      {
        delay: 400,
        type: "plan:chunk",
        payload: { chunk: "Composing execution plan with 3 steps." }
      },
      { delay: 500, type: "plan:complete", payload: { plan: mockPlan } },
      {
        delay: 350,
        type: "telemetry",
        payload: {
          tokens: { input: 850, output: 320, total: 1170 },
          latencyMs: 1200,
          provider: "mock-bandit-ai",
          model: "bandit-core-1"
        }
      }
    ];

    mockPlan.steps.forEach((step, index) => {
      events.push({ delay: 450, type: "step:start", payload: { step } });
      events.push({
        delay: 200,
        type: "log",
        payload: {
          level: "info",
          message: `${step.title} running...`
        }
      });

      const diffs = createDiffs(step.id);
      if (diffs.length) {
        events.push({ delay: 250, type: "diff:apply", payload: { step, diff: diffs } });
      }

      events.push({
        delay: 200,
        type: "telemetry",
        payload: {
          tokens: { input: 200 + index * 50, output: 120 + index * 30, total: 320 + index * 80 },
          latencyMs: 600 + index * 150,
          provider: "mock-bandit-ai",
          model: "bandit-core-1"
        }
      });

      events.push({
        delay: 350,
        type: "step:complete",
        payload: {
          step,
          result: buildExecutionResult(step)
        }
      });
    });

    events.push({
      delay: 400,
      type: "report:chunk",
      payload: { chunk: "Workbench ready for interactive development." }
    });

    events.push({
      delay: 300,
      type: "report:complete",
      payload: {
        report: {
          goal: mockPlan.goal,
          summary: "Mock execution finished successfully.",
          steps: mockPlan.steps.map((step) => buildExecutionResult(step)),
          startedAt: mockPlan.createdAt,
          completedAt: Date.now(),
          metadata: { provider: "mock-openai" }
        }
      }
    });

    this.schedule(events);
  }
}
