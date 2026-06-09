/**
 * Bandit Gateway API
 *
 * Provides the HTTP endpoints consumed by the bandit-stealth-web UI:
 * - POST /api/stealth/tasks/:taskId/run                  — execute an agent goal
 * - GET  /api/stealth/models                             — list available models with capabilities
 * - GET  /api/stealth/skills                             — list registered skills
 * - GET  /api/stealth/health                             — provider health check
 * - GET  /api/stealth/github/repos/:repoId/tree          — indexed file tree (Phase 2)
 * - GET  /api/stealth/github/repos/:repoId/contents      — single file content (Phase 2)
 *
 * The deployed gateway is a separate Express/Fastify project that wires
 * these contracts to HTTP routes. This file is the canonical TypeScript
 * contract — adding a new endpoint here is the signal that the deployed
 * gateway should mirror it.
 */

import type {
  AgentReport,
  AgentExecutionResult,
  AgentPlan,
  PlanOptions} from "@burtson-labs/agent-core";
import {
  createAgentRuntime,
  createDefaultSkillRegistry,
  type SkillManifest
} from "@burtson-labs/agent-core";
import { createBanditGatewayProvider } from "@burtson-labs/agent-adapters-provider";
import { getModelCapabilities } from "@burtson-labs/stealth-core-runtime";

// ── Skill Registry (singleton) ──────────────────────────────────────────────

const skillRegistry = createDefaultSkillRegistry();

// ── Types ────────────────────────────────────────────────────────────────────

export interface GatewayRequest {
  goal: string;
  planOptions?: PlanOptions;
  modelId?: string;
  activeSkillIds?: string[];
  /**
   * When true, the runtime skips per-tool permission prompts and runs
   * all write tools (write_file, run_terminal, git commands) to
   * completion, producing a draft PR as the output. Required for
   * non-interactive contexts (web cockpit, scheduled routines, CI) where
   * surfacing a permission card per write would block the run forever.
   *
   * Default: false. Hosts that want the legacy "ask before each write"
   * behaviour (VS Code extension, CLI REPL) leave this unset.
   */
  autoApprove?: boolean;
}

// ── GitHub repo browsing (Phase 2 — file tree + viewer) ─────────────────────

/**
 * A node in a repo's file tree. The tree endpoint returns either a flat
 * list scoped to one directory (when `path` is provided) or a flat list
 * of the whole indexed corpus (when omitted). Hierarchy is derived
 * client-side from the slash-separated paths.
 */
export interface GithubRepoTreeEntry {
  /** Path relative to the repo root, e.g. "src/components/Foo.tsx". */
  path: string;
  kind: "file" | "dir";
  /** Byte size for files; absent for dirs. */
  size?: number;
  /** Inferred language (lowercased extension or null). */
  language?: string | null;
}

export interface GithubRepoTreeRequest {
  /** Numeric GitHub repo id (the same value workspace.repo.repoId surfaces). */
  repoId: string | number;
  /** Optional branch or commit SHA. Default: repo's default branch. */
  ref?: string;
  /** Optional directory path to list. Empty / undefined returns the root. */
  path?: string;
  /** Optional GitHub App installation id when the gateway proxies. */
  installationId?: number;
}

export interface GithubRepoTreeResponse {
  repoFullName: string;
  ref: string;
  path: string;
  /** Tree entries. Use kind + path to build the hierarchy client-side. */
  entries: GithubRepoTreeEntry[];
  /** True if the response was truncated (over the gateway's per-request cap). */
  truncated?: boolean;
}

export interface GithubFileContentRequest {
  repoId: string | number;
  path: string;
  ref?: string;
  installationId?: number;
  /**
   * Optional upper bound the gateway should respect. If the file exceeds
   * this, the response should set `truncated: true` and return a prefix.
   * Default: 1 MiB.
   */
  maxBytes?: number;
}

export interface GithubFileContentResponse {
  repoFullName: string;
  ref: string;
  path: string;
  /** UTF-8 file content. Binary files should return null + base64 in `binary`. */
  content: string | null;
  /** Optional base64 for binary files when content is null. */
  binary?: string;
  size: number;
  /** True if the gateway clipped the response at maxBytes. */
  truncated?: boolean;
  /** Inferred language for syntax highlighting. */
  language?: string | null;
}

export interface GatewayResponse {
  plan: AgentPlan;
  results: AgentExecutionResult[];
  report: AgentReport;
  skills: Array<{ id: string; name: string }>;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  tier: string;
  available: boolean;
  unavailableReason?: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  version: string;
  activation: string;
  toolCount: number;
  description: string;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  providers: Record<string, { reachable: boolean; latencyMs?: number; reason?: string }>;
  version: string;
  skillCount: number;
}

// ── Agent execution ─────────────────────────────────────────────────────────

export type AgentEventHandler = (event: {
  type: string;
  timestamp: number;
  payload?: unknown;
}) => void;

export const handleGatewayRequest = async (
  request: GatewayRequest,
  onEvent?: AgentEventHandler
): Promise<GatewayResponse> => {
  // Resolve active skills for this request
  const activeSkills = skillRegistry.resolveActiveSkills(
    request.goal,
    request.activeSkillIds
  );
  skillRegistry.buildToolRegistry(activeSkills);

  // Emit skill activation event
  onEvent?.({
    type: "skill:activate",
    timestamp: Date.now(),
    payload: {
      skills: activeSkills.map((s) => ({
        id: s.id,
        name: s.name,
        toolCount: s.tools.length
      }))
    }
  });

  const runtime = createAgentRuntime({
    provider: createBanditGatewayProvider({
      model: request.modelId
    })
  });

  // Forward agent events to the caller (for SSE streaming)
  if (onEvent) {
    runtime.on("plan:start", (e) => onEvent(e));
    runtime.on("plan:complete", (e) => onEvent(e));
    runtime.on("plan:chunk", (e) => onEvent(e));
    runtime.on("step:start", (e) => onEvent(e));
    runtime.on("step:complete", (e) => onEvent(e));
    runtime.on("diff:apply", (e) => onEvent(e));
    runtime.on("report:complete", (e) => onEvent(e));
  }

  const plan = await runtime.plan(request.goal, request.planOptions);
  const results = await runtime.execute();
  const report = await runtime.report();

  return {
    plan,
    results,
    report,
    skills: activeSkills.map((s) => ({ id: s.id, name: s.name }))
  };
};

// ── Models endpoint ─────────────────────────────────────────────────────────

const KNOWN_MODELS: ModelInfo[] = [
  {
    id: "bandit-core-1",
    displayName: "Bandit Core 31B (RTX 5090)",
    provider: "ollama",
    ...capFields("bandit-core-1"),
    available: true
  },
  {
    id: "bandit-core-2",
    displayName: "Bandit Core 2 (RunPod 70B)",
    provider: "runpod",
    ...capFields("bandit-core-2"),
    available: false,
    unavailableReason: "RunPod instance is offline. An admin must start it."
  },
  {
    id: "bandit-core",
    displayName: "Bandit Core (default)",
    provider: "bandit",
    ...capFields("bandit-core"),
    available: true
  }
];

function capFields(modelId: string): { contextWindow: number; tier: string } {
  const caps = getModelCapabilities(modelId);
  return { contextWindow: caps.contextWindow, tier: caps.tier };
}

export function getAvailableModels(): ModelInfo[] {
  return KNOWN_MODELS;
}

// ── Skills endpoint ─────────────────────────────────────────────────────────

export function getAvailableSkills(): SkillInfo[] {
  return skillRegistry.getAll().map((skill: SkillManifest) => ({
    id: skill.id,
    name: skill.name,
    version: skill.version,
    activation: skill.activation,
    toolCount: skill.tools.length,
    description: skill.description
  }));
}

// ── Health endpoint ─────────────────────────────────────────────────────────

export async function checkHealth(): Promise<HealthStatus> {
  const providers: HealthStatus["providers"] = {};

  // Check Bandit API
  try {
    const start = Date.now();
    const res = await fetch("https://api.burtson.ai/health", {
      signal: AbortSignal.timeout(5000)
    });
    providers.bandit = {
      reachable: res.ok,
      latencyMs: Date.now() - start,
      ...(res.ok ? {} : { reason: `Status ${res.status}` })
    };
  } catch {
    providers.bandit = { reachable: false, reason: "Connection failed" };
  }

  return {
    status: providers.bandit?.reachable ? "ok" : "degraded",
    providers,
    version: "1.1.0",
    skillCount: skillRegistry.size
  };
}

// ── Convenience: register custom skills ─────────────────────────────────────

export function registerSkill(skill: SkillManifest): void {
  skillRegistry.register(skill);
}

export { skillRegistry };

// ── GitHub repo browsing — contract notes for the deployed gateway ──────────
//
// The web IDE (bandit-stealth-web /ide/:workspaceId) needs a file tree and
// per-file content endpoint so users can browse the indexed repo and view
// files in the editor pane. These haven't been wired into the deployed
// gateway yet — the contracts above are the canonical shape the gateway
// should mirror.
//
// Suggested HTTP routes (the deployed gateway should match these):
//
//   GET  /api/stealth/github/repos/:repoId/tree?ref=&path=&installationId=
//        Returns GithubRepoTreeResponse. Implementation options:
//        (a) Pull from the RAG index — the repo-indexer in
//            packages/stealth-core-runtime already walks the repo and
//            knows every file path; surfacing them here is mostly a
//            select-and-map.
//        (b) Proxy GitHub's `GET /repos/{owner}/{repo}/git/trees/{ref}`
//            (recursive=1) using the workspace's installation token.
//            Higher latency but no dependency on the RAG index being
//            present; fine for unindexed repos.
//        Either approach should respect the per-request cap and set
//        `truncated: true` when clipping (matches GitHub's behaviour).
//
//   GET  /api/stealth/github/repos/:repoId/contents?path=&ref=&maxBytes=&installationId=
//        Returns GithubFileContentResponse. Easiest path: proxy GitHub's
//        `GET /repos/{owner}/{repo}/contents/{path}` and base64-decode
//        the response. Treat text/* (and the common code mime types)
//        as `content`; everything else as `binary`.
//
// The web client (bandit-stealth-web/src/api/stealthApi.ts) will degrade
// gracefully on 404 so deploys without these endpoints don't break — the
// FilesSidebar will keep showing its "File tree arrives next" placeholder
// until the gateway catches up.

// ── autoApprove flag — contract notes for the deployed gateway ──────────────
//
// GatewayRequest now carries `autoApprove?: boolean`. The deployed gateway
// should forward this into the AgentRuntime / StepExecutor so the tool
// loop knows whether to surface a PermissionCard or run writes directly.
//
// Existing hosts that don't set the flag get the current behaviour
// (permission gating where it's already wired). The web cockpit will
// always set autoApprove=true when promoting a chat conversation into a
// task — the design intent is "the user already approved this run when
// they clicked Run as agent task; don't make them approve each write
// individually."
