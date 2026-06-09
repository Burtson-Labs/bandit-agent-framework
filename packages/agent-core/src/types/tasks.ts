import type { AgentStepStatus } from "./agent";

export type TaskStatus = AgentStepStatus;

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  goalId?: string;
  files?: string[];
  metadata?: Record<string, unknown>;
}

export interface Goal {
  id: string;
  title: string;
  summary?: string;
  tasks: Task[];
  createdAt: number;
  updatedAt: number;
  runId?: string;
  metadata?: Record<string, unknown>;
}
