/**
 * Shared types for the conversation system.
 * Extracted from extension.ts so both the ConversationService and
 * the BanditStealthViewProvider can reference them.
 */

import type { Plan as RuntimePlan } from '@burtson-labs/stealth-core-runtime';
import type { Task as AgentTask } from '@burtson-labs/agent-core';

export type Plan = RuntimePlan;
export type Task = AgentTask;

export type ConversationRole = 'user' | 'assistant';

export type FeedbackRating = 'up' | 'down';

export interface ConversationFeedback {
  rating?: FeedbackRating;
  submitted: boolean;
  submittedAt?: number;
  note?: string;
}

export interface IntentInsight {
  action: string;
  target?: string;
  intent?: string;
  summary?: string;
  confidence?: number;
  rationale?: string;
  raw?: Record<string, unknown>;
}

export interface ConversationEntry {
  id: string;
  role: ConversationRole;
  content: string;
  timestamp: number;
  images?: string[];
  intent?: IntentInsight;
  feedback?: ConversationFeedback;
  payload?: string;
  contextFiles?: string[];
  contextSource?: 'manual' | 'auto';
}

export interface ConversationPlanStepState {
  state?: string;
  summary?: string;
  durationMs?: number;
  tokens?: number;
  updatedAt?: number;
}

export interface ConversationPlanRun {
  id: string;
  goal: string;
  plan: Plan;
  createdAt: number;
  updatedAt: number;
  updates: Record<string, ConversationPlanStepState>;
  completedAt?: number;
  evaluation?: {
    success?: boolean;
    confidence?: number;
    feedback?: string;
  };
  artifactsPath?: string;
}

export interface ConversationRecord {
  id: string;
  name: string;
  messages: ConversationEntry[];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  planRuns: ConversationPlanRun[];
}

export interface StoredConversationHistory {
  currentId?: string;
  conversations: ConversationRecord[];
}

export interface ConversationSummary {
  id: string;
  name: string;
  updatedAt: number;
  archived: boolean;
}

export interface SerializedPlanRun {
  id: string;
  goal: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
  evaluation?: {
    success?: boolean;
    confidence?: number;
    feedback?: string;
  } | null;
  artifactsPath?: string | null;
  plan: Plan;
  updates: Record<string, ConversationPlanStepState>;
}

export type ModeKind = 'ask' | 'agent';
