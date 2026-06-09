import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile } from "fs/promises";
import type {
  AgentPlan,
  AgentReport,
  AgentRuntime,
  AgentExecutionResult,
  PlanOptions,
  ExecuteOptions,
  StepExecutor,
  StepExecutorContext,
  StepExecutorOutput,
  CreateAgentRuntimeOptions
} from "@burtson-labs/agent-core";
import {
  createAgentRuntime
} from "@burtson-labs/agent-core";

const execAsync = promisify(exec);

export interface CommandRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export interface NodeAdapter {
  runtime: AgentRuntime;
  runCommand(command: string, options?: CommandRunOptions): Promise<CommandRunResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  plan(goal: string, options?: PlanOptions): Promise<AgentPlan>;
  execute(options?: ExecuteOptions): Promise<AgentExecutionResult[]>;
  report(metadata?: Record<string, unknown>): Promise<AgentReport>;
}

export interface NodeAdapterOptions extends CreateAgentRuntimeOptions {
  stepExecutor?: StepExecutor;
}

export const createNodeAdapter = (options: NodeAdapterOptions = {}): NodeAdapter => {
  const { stepExecutor, ...runtimeOptions } = options;

  const commandRunner = async (command: string, runOptions: CommandRunOptions = {}): Promise<CommandRunResult> => {
    const start = Date.now();
    const cwd = runOptions.cwd ?? process.cwd();
    const env = { ...process.env, ...(runOptions.env ?? {}) };

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        env,
        timeout: runOptions.timeoutMs
      });

      return {
        stdout,
        stderr,
        exitCode: 0,
        durationMs: Date.now() - start
      };
    } catch (error: unknown) {
      const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? String(execError),
        exitCode: typeof execError.code === "number" ? execError.code : null,
        durationMs: Date.now() - start
      };
    }
  };

  const defaultExecutor: StepExecutor =
    stepExecutor ??
    (async ({ step, logger }: StepExecutorContext): Promise<StepExecutorOutput> => {
      if (!step.command) {
        logger.debug(`Skipping step ${step.id} because no command is defined.`);
        return {
          status: "completed",
          logs: [`No command provided for step "${step.title}".`]
        };
      }

      const result = await commandRunner(step.command, {
        cwd: step.metadata?.cwd as string | undefined
      });

      return {
        status: result.exitCode === 0 ? "completed" : "failed",
        logs: [
          `command: ${step.command}`,
          result.stdout,
          result.stderr
        ].filter(Boolean),
        metadata: {
          exitCode: result.exitCode,
          durationMs: result.durationMs
        }
      };
    });

  const runtime = createAgentRuntime({
    ...runtimeOptions,
    stepExecutor: defaultExecutor
  });

  return {
    runtime,
    runCommand: commandRunner,
    readFile: async (path: string) => {
      const content = await readFile(path, "utf8");
      return content;
    },
    writeFile: (path: string, content: string) => writeFile(path, content, "utf8"),
    plan: (goal: string, planOptions?: PlanOptions) => runtime.plan(goal, planOptions),
    execute: (executeOptions?: ExecuteOptions) => runtime.execute(executeOptions),
    report: (metadata?: Record<string, unknown>) => runtime.report(metadata)
  };
};
