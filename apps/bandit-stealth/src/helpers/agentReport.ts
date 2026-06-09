/**
 * Pure agent-report formatters extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. The agent-report family was the largest
 * cohesive cluster of pure functions left in the file (~400 lines):
 * `deriveAgentSummary` walks the report into a structured shape, the
 * formatters render it as markdown / chat headlines / payload
 * objects. None of them touched class state.
 *
 * The two diff-related callers used by `formatAgentReport` /
 * `describeAgentReport` (`truncate`, `truncateDiff`) live in
 * `helpers/formatting.ts` since they have callers outside this
 * family. `isPlaceholderCommand` is local — only this module asks
 * "is this command a no-op?".
 */
import type { AgentReport } from '@burtson-labs/stealth-core-runtime';
import { truncate, truncateDiff } from './formatting';

export interface AgentSummaryStep {
  id: string;
  title: string;
  status: 'complete' | 'error';
  command?: string;
  placeholder: boolean;
  summary?: string;
  path?: string;
}

export interface AgentSummaryFile {
  path: string;
  status: 'complete' | 'error';
  placeholder: boolean;
  diff?: string | null;
  summary?: { added: number; removed: number } | null;
  confidence?: number | null;
  backupPath?: string | null;
  review?: string | null;
}

export interface AgentSummary {
  goal: string;
  planGoal?: string;
  success: boolean;
  confidence: number | null;
  iterations: number;
  feedback?: string;
  updatedPaths: string[];
  contextPaths: string[];
  steps: AgentSummaryStep[];
  files: AgentSummaryFile[];
  diffPreview?: string;
  backupPath?: string | null;
}

/**
 * Identify "no-op" commands the agent emitted as placeholder steps —
 * `noop`, `true`, `exit 0`, plain echoes, sleeps. Used by report
 * formatters so the user can see at a glance which steps were busy
 * work vs. real changes. Empty / undefined commands are NOT
 * placeholders (a step with no command is just a planning artifact).
 */
export function isPlaceholderCommand(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  const normalized = command.trim().toLowerCase();
  if (normalized === '' || normalized === 'noop' || normalized === 'true' || normalized === 'exit 0') {
    return true;
  }
  return normalized.startsWith('echo ') || normalized.includes('echo "') || normalized.includes("echo '") || /sleep\s+\d+/u.test(normalized);
}

/**
 * Walk an AgentReport into a structured summary the formatters /
 * payload builder consume. Aggregates per-file state across multiple
 * results targeting the same path (so two `apply_edit` calls on
 * Foo.cs collapse into one `files` entry with the latest diff).
 *
 * The downgrades are intentional: `error` is sticky (a later
 * `complete` doesn't override a prior `error`), but `placeholder`
 * downgrades to false the moment any non-placeholder step lands.
 */
export function deriveAgentSummary(report: AgentReport): AgentSummary {
  const confidence = Number.isFinite(report.evaluation?.confidence) ? report.evaluation!.confidence! : null;
  const success = report.evaluation?.success ?? false;
  const iterations = report.iterations;

  const planSteps = Array.isArray(report.plan?.steps) ? report.plan.steps : [];
  const planLookup = new Map(planSteps.map((step) => [step.id, step]));

  const contextPathSet = new Set<string>();
  const steps: AgentSummaryStep[] = [];

  const filesMap = new Map<string, AgentSummaryFile>();

  const ensureFileEntry = (path: string, placeholder: boolean, status: 'complete' | 'error'): AgentSummaryFile => {
    const existing = filesMap.get(path);
    if (!existing) {
      const entry: AgentSummaryFile = {
        path,
        status,
        placeholder,
        diff: null,
        summary: null,
        confidence: null,
        backupPath: null,
        review: null
      };
      filesMap.set(path, entry);
      return entry;
    }
    if (status === 'error') {
      existing.status = 'error';
    } else if (existing.status !== 'error') {
      existing.status = status;
    }
    if (!placeholder) {
      existing.placeholder = false;
    }
    return existing;
  };

  for (const result of report.results ?? []) {
    const step = planLookup.get(result.stepId);
    const title = step?.title ?? result.stepId;
    const command = typeof step?.command === 'string' ? step.command : undefined;
    const placeholder = isPlaceholderCommand(command);
    const status: 'complete' | 'error' = result.ok ? 'complete' : 'error';
    const data = result.data as Record<string, unknown> | undefined;
    const primaryPath = typeof data?.path === 'string' ? data.path : undefined;

    const snippetSource = (result.output ?? '').toString().trim() || (result.error ?? '').toString().trim();
    let summary: string | undefined;
    if (snippetSource) {
      const firstLine = snippetSource.split(/\r?\n/).find((segment) => segment.trim().length > 0);
      if (firstLine) {
        summary = truncate(firstLine.trim(), 120);
      }
    }

    steps.push({
      id: result.stepId,
      title,
      status,
      command,
      placeholder,
      summary,
      path: primaryPath
    });

    if (primaryPath) {
      const fileEntry = ensureFileEntry(primaryPath, placeholder, status);
      const diffCandidate = typeof data?.diff === 'string' ? data.diff.trim() : '';
      if (diffCandidate && diffCandidate !== '__pending__') {
        fileEntry.diff = data?.diff as string;
      }
      if (typeof (data as { diffSummary?: { added: number; removed: number } }).diffSummary === 'object') {
        fileEntry.summary = (data as { diffSummary?: { added: number; removed: number } }).diffSummary ?? null;
      }
      const confidenceCandidate = typeof (data as { confidence?: number }).confidence === 'number'
        ? (data as { confidence?: number }).confidence
        : typeof (data as { astEdits?: { confidence?: number } }).astEdits?.confidence === 'number'
          ? ((data as { astEdits?: { confidence?: number } }).astEdits?.confidence ?? null)
          : undefined;
      if (typeof confidenceCandidate === 'number') {
        fileEntry.confidence = confidenceCandidate;
      }
      if (typeof (data as { backupPath?: string }).backupPath === 'string' && (data as { backupPath?: string }).backupPath) {
        fileEntry.backupPath = (data as { backupPath?: string }).backupPath ?? null;
      }
      if (typeof (data as { review?: string }).review === 'string' && ((data as { review?: string }).review ?? '').trim().length > 0) {
        fileEntry.review = ((data as { review?: string }).review ?? '').trim();
      }
      const sample = typeof (data as { sample?: string }).sample === 'string'
        ? ((data as { sample?: string }).sample ?? '').trim()
        : undefined;
      if (sample) {
        contextPathSet.add(primaryPath);
      }
    }

    const extraPaths = Array.isArray(data?.paths) ? data.paths : [];
    for (const entry of extraPaths) {
      if (typeof entry === 'string') {
        ensureFileEntry(entry, placeholder, status);
      }
    }
  }

  const files = Array.from(filesMap.values()).map((file) => ({
    ...file,
    diff: file.diff ?? null,
    summary: file.summary ?? null,
    confidence: typeof file.confidence === 'number' ? file.confidence : null,
    backupPath: file.backupPath ?? null,
    review: file.review ?? null
  }));

  const diffPreview = files.find((file) => typeof file.diff === 'string' && file.diff.trim().length > 0)?.diff ?? undefined;
  const updatedPaths = files.map((file) => file.path);
  const contextPaths = Array.from(contextPathSet);
  const backupPath = files.find((file) => file.backupPath)?.backupPath ?? null;

  return {
    goal: report.goal,
    planGoal: typeof report.plan?.goal === 'string' ? report.plan.goal : undefined,
    success,
    confidence,
    iterations,
    feedback: report.evaluation?.feedback ?? undefined,
    updatedPaths,
    contextPaths,
    steps,
    files,
    diffPreview,
    backupPath
  };
}

/**
 * Render the full agent-report summary as user-facing markdown for the
 * chat assistant message that closes a turn. Uses `deriveAgentSummary`
 * for structure and the existing diff/length truncation helpers for
 * the body.
 */
export function formatAgentReport(report: AgentReport): string {
  const summary = deriveAgentSummary(report);
  const lines: string[] = [];
  const confidenceLabel = summary.confidence !== null ? `${(summary.confidence * 100).toFixed(1)}%` : 'n/a';
  const statusLabel = summary.success ? '✅ Success' : '⚠️ Needs follow-up';

  lines.push('**Agent Report**');
  lines.push('');
  lines.push(`Goal: ${summary.goal}`);
  lines.push(`Status: ${statusLabel} (confidence ${confidenceLabel})`);
  lines.push(`Iterations: ${summary.iterations}`);

  if (summary.steps.length > 0) {
    lines.push('');
    lines.push('**Steps**');
    for (const step of summary.steps) {
      const statusIcon = step.status === 'complete' ? '✅' : '⚠️';
      let line = `- ${statusIcon} ${step.title}`;
      if (step.command) {
        line += ` (command: ${step.command})`;
      }
      if (step.placeholder) {
        line += ' [placeholder command – no direct code changes]';
      }
      if (step.summary) {
        line += ` — ${step.summary}`;
      }
      lines.push(line);
    }
  }

  if (summary.updatedPaths.length > 0) {
    lines.push('');
    lines.push('**Files Updated**');
    for (const filePath of summary.updatedPaths) {
      lines.push(`- ${filePath}`);
    }
  }

  if (summary.feedback) {
    lines.push('');
    lines.push(`**Feedback:** ${summary.feedback}`);
  }

  if (summary.contextPaths.length > 0) {
    lines.push('');
    lines.push('**Context Files**');
    summary.contextPaths.forEach((path) => {
      lines.push(`- ${path}`);
    });
  }

  if (summary.diffPreview) {
    lines.push('');
    lines.push('**Code Diff Preview**');
    lines.push('```diff');
    lines.push(truncateDiff(summary.diffPreview));
    lines.push('```');
  }
  if (summary.backupPath) {
    lines.push('');
    lines.push(`Backup saved at: ${summary.backupPath}`);
  }

  lines.push('');
  lines.push('Full report saved to `.bandit/agent-report.json`.');

  return lines.join('\n');
}

/** One-line success/failure headline used as the chat fallback content when no agent reply is generated. */
export function buildAgentSummaryHeadline(report: AgentReport): string {
  const confidence = Number.isFinite(report.evaluation?.confidence)
    ? `${(report.evaluation.confidence * 100).toFixed(1)}%`
    : 'n/a';
  const success = report.evaluation?.success ?? false;
  const statusLabel = success ? 'completed successfully' : 'needs follow-up';
  const prefix = success ? '✅' : '⚠️';
  return `${prefix} ${report.goal} — ${statusLabel} (confidence ${confidence}).`;
}

/** Build the structured `agent-summary` payload the webview renders as a card. */
export function buildAgentSummaryPayload(
  report: AgentReport,
  summaryMarkdown: string,
  agentReply: string | null
): unknown {
  const info = deriveAgentSummary(report);
  return {
    type: 'agent-summary',
    goal: info.goal,
    planGoal: info.planGoal ?? null,
    success: info.success,
    confidence: info.confidence,
    iterations: info.iterations,
    feedback: info.feedback ?? null,
    updatedPaths: info.updatedPaths,
    contextPaths: info.contextPaths,
    steps: info.steps,
    files: info.files,
    diffPreview: info.diffPreview ?? null,
    backupPath: info.backupPath ?? null,
    summary: summaryMarkdown,
    response: agentReply,
    completedAt: report.finishedAt ?? null
  };
}

/**
 * Render a compact, model-readable description of the agent run.
 * Used as the user-message body for `buildAgentCompletionRequest`,
 * which feeds the model the run context to compose its final reply.
 * Keeps file-context excerpts and diff previews short so the model
 * doesn't get distracted by noise.
 */
export function describeAgentReport(report: AgentReport): string {
  const lines: string[] = [];
  lines.push(`Goal: ${report.goal}`);
  lines.push(`Iterations: ${report.iterations}`);
  const evaluation = report.evaluation ?? { success: false, feedback: '', confidence: 0 };
  lines.push(`Evaluation: success=${evaluation.success ? 'true' : 'false'}, confidence=${(evaluation.confidence * 100).toFixed(1)}%, feedback=${evaluation.feedback ?? ''}`);

  const planSteps = Array.isArray(report.plan?.steps) ? report.plan.steps : [];
  const lookup = new Map(planSteps.map((step) => [step.id, step]));
  if (Array.isArray(report.results) && report.results.length > 0) {
    lines.push('Results:');
    for (const result of report.results) {
      const step = lookup.get(result.stepId);
      const title = step?.title ?? result.stepId;
      const status = result.ok ? 'ok' : 'failed';
      const command = typeof step?.command === 'string' ? step.command : undefined;
      const placeholder = isPlaceholderCommand(command);
      const snippetSource = (result.output ?? '').toString().trim() || (result.error ?? '').toString().trim();
      const snippet = snippetSource ? truncate(snippetSource.replace(/\s+/g, ' '), 200) : '';
      const meta: string[] = [];
      if (command) {
        meta.push(`command=${command}`);
      }
      if (placeholder) {
        meta.push('placeholder=true');
      }
      const metaText = meta.length > 0 ? ` [${meta.join('; ')}]` : '';
      lines.push(`- ${title}: ${status}${metaText}${snippet ? ` (${snippet})` : ''}`);
    }
  }

  const fileReads = (report.results ?? []).map((result) => {
    const data = result.data as { path?: unknown; sample?: unknown } | undefined;
    const sample = typeof data?.sample === 'string' ? data.sample.trim() : undefined;
    const path = typeof data?.path === 'string' ? data.path : undefined;
    if (!sample || !path) {
      return undefined;
    }
    return { path, sample };
  }).filter((entry): entry is { path: string; sample: string } => Boolean(entry));

  if (fileReads.length > 0) {
    lines.push('');
    lines.push('File context excerpts:');
    for (const entry of fileReads) {
      lines.push(`- ${entry.path}`);
      lines.push('```');
      lines.push(truncate(entry.sample, 360));
      lines.push('```');
    }
  }

  const diffResult = report.results.find((result) => typeof (result.data as { diff?: unknown } | undefined)?.diff === 'string');
  if (diffResult) {
    const diffText = (diffResult.data as { diff?: string }).diff ?? '';
    if (diffText.trim().length > 0) {
      lines.push('Diff preview:');
      lines.push(truncateDiff(diffText, 80));
    }
  }

  const scriptResult = report.results.find((result) => Array.isArray((result.data as { runs?: unknown[] } | undefined)?.runs));
  if (scriptResult) {
    const runs = ((scriptResult.data as { runs?: Array<Record<string, unknown>> }).runs ?? [])
      .map((run) => {
        const script = typeof run.script === 'string' ? run.script : 'unknown';
        const ok = run.ok === false ? 'failed' : 'ok';
        return `${script}:${ok}`;
      });
    if (runs.length > 0) {
      lines.push(`Script checks: ${runs.join(', ')}`);
    }
  }

  return lines.join('\n');
}
