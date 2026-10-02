/**
 * Where Bandit's data lives on this machine, and readers for each shape.
 *
 *   ~/.bandit/sessions/<local-stamp>.jsonl   CLI REPL sessions: {role, content} per line
 *   <root>/.bandit/turns/turn-<ISO>-<r>.jsonl host-kit turn logs (CLI + VS Code extension)
 *   <root>/.bandit/turns/<ISO>-<r5>.jsonl     Stealth web / Tauri IDE turn logs (meta/message/tool_call/end)
 *   <dir>/*.json[l]                           BanditBench traces written by `eval --trace-out`
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseTurnLog, summarizeTurnTrace, type TurnLogEvent, type TurnTraceSummary } from '@burtson-labs/host-kit';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', 'target', 'bin', 'obj', '.turbo', '.cache']);

export function banditHome(): string {
  return process.env.BANDIT_HOME ?? path.join(os.homedir(), '.bandit');
}

export function defaultWorkspaceRoots(): string[] {
  return [path.join(os.homedir(), 'Documents', 'GitHub')];
}

/** Find `.bandit/turns` dirs under each root (bounded depth; skips build/vendor dirs). */
export async function findTurnDirs(roots: string[], maxDepth = 4): Promise<string[]> {
  const found = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const abs = path.join(dir, e.name);
      if (e.name === '.bandit') {
        // .bandit/turns and the occasional nested .bandit/.bandit/turns
        for (const cand of [path.join(abs, 'turns'), path.join(abs, '.bandit', 'turns')]) {
          try {
            if ((await fs.promises.stat(cand)).isDirectory()) found.add(cand);
          } catch { /* absent */ }
        }
        continue;
      }
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.bandit')) continue;
      if (depth < maxDepth) await walk(abs, depth + 1);
    }
  };
  for (const root of roots) {
    const r = root.replace(/^~(?=$|\/)/, os.homedir());
    const direct = path.join(r, '.bandit', 'turns');
    try {
      if ((await fs.promises.stat(direct)).isDirectory()) found.add(direct);
    } catch { /* absent */ }
    await walk(r, 0);
  }
  return [...found].sort();
}

export interface DiscoveredFile {
  path: string;
  name: string;
  hash: string;
  text: string;
  mtimeMs: number;
}

/** Read every *.jsonl in the dirs, dropping exact duplicates (same name + same bytes). */
export async function readUniqueJsonl(dirs: string[]): Promise<{ files: DiscoveredFile[]; duplicates: number }> {
  const seen = new Set<string>();
  const files: DiscoveredFile[] = [];
  let duplicates = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = (await fs.promises.readdir(dir)).filter(n => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      let text: string;
      let stat: fs.Stats;
      try {
        [text, stat] = await Promise.all([fs.promises.readFile(abs, 'utf8'), fs.promises.stat(abs)]);
      } catch {
        continue;
      }
      const hash = crypto.createHash('sha1').update(text).digest('hex');
      const key = `${name}:${hash}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      files.push({ path: abs, name, hash, text, mtimeMs: stat.mtimeMs });
    }
  }
  return { files, duplicates };
}

// ---- CLI sessions ------------------------------------------------------------------------

export interface CliSession {
  id: string;
  path: string;
  startedAt: Date | null;
  endedAt: Date;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  badLines: number;
}

/** Session ids are local-time stamps: YYYYMMDD-HHMMSS-rand (see session.ts). */
export function parseSessionStamp(id: string): Date | null {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  return new Date(y, mo - 1, d, h, mi, s);
}

export function parseSession(file: DiscoveredFile): CliSession {
  const messages: CliSession['messages'] = [];
  let badLines = 0;
  for (const line of file.text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { role?: unknown; content?: unknown };
      if ((o.role === 'user' || o.role === 'assistant') && typeof o.content === 'string') {
        messages.push({ role: o.role, content: o.content });
      } else {
        badLines++;
      }
    } catch {
      badLines++;
    }
  }
  const id = file.name.replace(/\.jsonl$/, '');
  return { id, path: file.path, startedAt: parseSessionStamp(id), endedAt: new Date(file.mtimeMs), messages, badLines };
}

// ---- host-kit turn logs ------------------------------------------------------------------

export interface HostTurn {
  id: string;
  path: string;
  startedAt: Date | null;
  prompt: string;
  model: string | null;
  summary: TurnTraceSummary;
  toolErrors: number;
  events: TurnLogEvent[];
}

export function isHostKitTurnFile(name: string): boolean {
  return name.startsWith('turn-');
}

export function parseHostTurn(file: DiscoveredFile): HostTurn | null {
  const events = parseTurnLog(file.text);
  if (events.length === 0) return null;
  const id = file.name.replace(/\.jsonl$/, '');
  const summary = summarizeTurnTrace(id, file.path, events, { workspaceRoot: path.dirname(path.dirname(path.dirname(file.path))) });
  const llmStart = events.find(e => e.type === 'llm-start' && typeof e.model === 'string');
  const toolErrors = events.filter(e => e.type === 'tool-result' && (e.isError === true || e.status === 'error')).length
    + events.filter(e => e.type === 'tool-error').length;
  const t = summary.startedAt ? new Date(summary.startedAt) : null;
  return {
    id,
    path: file.path,
    startedAt: t && !Number.isNaN(t.getTime()) ? t : null,
    prompt: summary.prompt ?? '',
    model: typeof llmStart?.model === 'string' ? normalizeModel(llmStart.model) : null,
    summary,
    toolErrors,
    events
  };
}

// ---- Stealth web / Tauri IDE turn logs ---------------------------------------------------

/** "Bandit Cloud · bandit-logic-2" → "bandit-logic-2": display prefixes are not model ids. */
export function normalizeModel(model: string): string {
  const parts = model.split(/\s+[·|]\s+/);
  return parts[parts.length - 1].trim();
}

export interface StealthWebTurn {
  id: string;
  path: string;
  startedAt: Date | null;
  model: string | null;
  provider: string | null;
  goal: string;
  events: Array<Record<string, unknown> & { type: string }>;
  end: { hitLimit?: boolean; cancelled?: boolean; finalResponse?: string } | null;
}

export function parseStealthWebTurn(file: DiscoveredFile): StealthWebTurn | null {
  const events: StealthWebTurn['events'] = [];
  for (const line of file.text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (typeof o.type === 'string') events.push(o as StealthWebTurn['events'][number]);
    } catch { /* tolerate partial lines */ }
  }
  const meta = events.find(e => e.type === 'meta');
  if (!meta) return null;
  const end = events.find(e => e.type === 'end') as StealthWebTurn['end'] | undefined;
  const started = typeof meta.startedAt === 'string' ? new Date(meta.startedAt) : null;
  return {
    id: file.name.replace(/\.jsonl$/, ''),
    path: file.path,
    startedAt: started && !Number.isNaN(started.getTime()) ? started : null,
    model: typeof meta.model === 'string' ? normalizeModel(meta.model) : null,
    provider: typeof meta.provider === 'string' ? meta.provider : null,
    goal: typeof meta.goal === 'string' ? meta.goal : '',
    events,
    end: end ?? null
  };
}
