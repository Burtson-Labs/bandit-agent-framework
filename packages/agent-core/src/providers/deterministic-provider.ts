import type { ProviderChatOptions, ProviderClient } from "./provider-client";

export interface DeterministicProviderConfig {
  /**
   * Optional seed to influence deterministic outputs.
   */
  seed?: number;
}

/**
 * A lightweight provider implementation that produces deterministic,
 * heuristic outputs for planning and execution without invoking a model.
 */
export class DeterministicProviderClient implements ProviderClient {
  readonly name = "deterministic-provider";

  constructor(private readonly config: DeterministicProviderConfig = {}) {}

  async *chat(prompt: string, options?: ProviderChatOptions): AsyncIterable<string> {
    const mode = options?.mode ?? "plan";

    if (mode === "plan") {
      yield this.generatePlan(prompt);
      return;
    }

    if (mode === "report") {
      yield this.generateReport(prompt, options);
      return;
    }

    yield this.generateEcho(prompt, options);
  }

  private generatePlan(prompt: string): string {
    const goal = extractGoal(prompt);
    const steps = heuristicallyBreakGoal(goal);

    return JSON.stringify(
      {
        goal,
        summary: `Plan generated from goal: ${goal}`,
        steps: steps.map((text, index) => ({
          id: `step-${index + 1}`,
          title: titleCase(text),
          description: text
        }))
      },
      null,
      2
    );
  }

  private generateReport(prompt: string, options?: ProviderChatOptions): string {
    return JSON.stringify(
      {
        summary: "Execution completed using deterministic provider.",
        prompt,
        metadata: options?.metadata ?? {}
      },
      null,
      2
    );
  }

  private generateEcho(prompt: string, options?: ProviderChatOptions): string {
    return JSON.stringify(
      {
        prompt,
        options: options ?? {}
      },
      null,
      2
    );
  }
}

function extractGoal(prompt: string): string {
  const cleaned = prompt.trim();
  const match = cleaned.match(/goal:(.*)/i);
  if (match) {
    return match[1].trim();
  }
  return cleaned;
}

function heuristicallyBreakGoal(goal: string): string[] {
  const delimiters = [/ and /i, / then /i, /, /];

  for (const delimiter of delimiters) {
    if (delimiter.test(goal)) {
      return goal.split(delimiter).map((part) => part.trim()).filter(Boolean);
    }
  }

  if (goal.length < 80) {
    return [goal];
  }

  const midpoint = Math.floor(goal.length / 2);
  return [goal.slice(0, midpoint).trim(), goal.slice(midpoint).trim()];
}

function titleCase(input: string): string {
  return input
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
