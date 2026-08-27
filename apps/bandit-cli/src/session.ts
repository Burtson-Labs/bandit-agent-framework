/**
 * Session persistence — JSONL files under ~/.bandit/sessions/.
 *
 * Each line in a session file is one ToolLoopMessage so the log can be tailed
 * while the agent is running. `currentId` points at the active session; set it
 * with startNew() (fresh id) or resume() (existing id).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolLoopMessage } from '@burtson-labs/agent-core';

const SESSIONS_DIR = path.join(os.homedir(), '.bandit', 'sessions');

export interface SessionSummary {
  id: string;
  /** Last-modified epoch ms. 0 when the file couldn't be stat'd. */
  mtime: number;
  /** First user prompt in the session, whitespace-collapsed. Empty if none. */
  preview: string;
  /** Number of stored lines (rough proxy for conversation length). */
  messageCount: number;
}

export class SessionStore {
  public currentId: string | null = null;

  async init(): Promise<void> {
    await fs.promises.mkdir(SESSIONS_DIR, { recursive: true });
  }

  async list(): Promise<string[]> {
    // Sort by file mtime descending so recently-USED sessions float to
    // the top regardless of their filename. The previous implementation
    // sorted alphabetically + reversed, which worked for timestamp-style
    // ids (`YYYYMMDD-HHMMSS-xxxx`) but pinned named sessions
    // (`dogfood-test`, etc.) at the top forever — they always sort
    // after a number, so reverse put them first regardless of when they
    // were last touched. in the recent-activity
    // list. Stat-each-file is fine at our session counts (typically
    // <100); switch to a single readdir-with-stat when we have a few
    // thousand to worry about.
    try {
      const files = await fs.promises.readdir(SESSIONS_DIR);
      const jsonl = files.filter(f => f.endsWith('.jsonl'));
      const stamped = await Promise.all(jsonl.map(async (f) => {
        try {
          const stat = await fs.promises.stat(path.join(SESSIONS_DIR, f));
          return { id: f.replace(/\.jsonl$/, ''), mtime: stat.mtimeMs };
        } catch {
          return { id: f.replace(/\.jsonl$/, ''), mtime: 0 };
        }
      }));
      stamped.sort((a, b) => b.mtime - a.mtime);
      return stamped.map((s) => s.id);
    } catch {
      return [];
    }
  }

  /**
   * Recent sessions with enough metadata to choose between them: the first
   * user prompt (so the session is recognizable), a rough turn count, and the
   * last-modified time. Powers the `--resume` picker.
   *
   * Reads at most `limit` files, newest first — bounded work even with
   * thousands of sessions.
   */
  async listWithPreviews(limit = 20): Promise<SessionSummary[]> {
    const ids = await this.list();
    const out: SessionSummary[] = [];
    for (const id of ids.slice(0, limit)) {
      try {
        const p = this.pathFor(id);
        const [stat, text] = await Promise.all([
          fs.promises.stat(p),
          fs.promises.readFile(p, 'utf-8'),
        ]);
        const messages = text.split('\n').filter(Boolean);
        let preview = '';
        for (const line of messages) {
          try {
            const m = JSON.parse(line) as ToolLoopMessage;
            if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
              preview = m.content.trim().replace(/\s+/g, ' ');
              break;
            }
          } catch { /* skip unparseable line */ }
        }
        out.push({
          id,
          mtime: stat.mtimeMs,
          preview,
          messageCount: messages.length,
        });
      } catch {
        out.push({ id, mtime: 0, preview: '', messageCount: 0 });
      }
    }
    return out;
  }

  async startNew(): Promise<string> {
    await this.init();
    const id = newId();
    this.currentId = id;
    await fs.promises.writeFile(this.pathFor(id), '');
    return id;
  }

  async resume(id: string): Promise<boolean> {
    const p = this.pathFor(id);
    try {
      await fs.promises.access(p, fs.constants.R_OK);
      this.currentId = id;
      return true;
    } catch {
      return false;
    }
  }

  async readConversation(): Promise<ToolLoopMessage[]> {
    if (!this.currentId) return [];
    try {
      const text = await fs.promises.readFile(this.pathFor(this.currentId), 'utf-8');
      return text
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line) as ToolLoopMessage; } catch { return null; }
        })
        .filter((x): x is ToolLoopMessage => x !== null);
    } catch {
      return [];
    }
  }

  async append(messages: ToolLoopMessage[]): Promise<void> {
    if (!this.currentId || messages.length === 0) return;
    const body = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    await fs.promises.appendFile(this.pathFor(this.currentId), body);
  }

  /** Replace the entire conversation file (used after in-memory mutations). */
  async replace(messages: ToolLoopMessage[]): Promise<void> {
    if (!this.currentId) return;
    const body = messages.map(m => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
    await fs.promises.writeFile(this.pathFor(this.currentId), body);
  }

  /** Absolute path of the active session file, or null if none is active.
   *  Used by the crash guard to tell the user where their work lives. */
  pathForCurrent(): string | null {
    return this.currentId ? this.pathFor(this.currentId) : null;
  }

  /**
   * Snapshot the in-progress conversation to disk MID-turn.
   *
   * The normal persistence path only rewrites the session file after a turn
   * completes, so killing the process during a long agent run (a 40-iteration
   * task) loses the whole turn. This writes the current message set atomically —
   * temp file + rename — so a crash mid-write can't corrupt the session either.
   *
   * Best-effort and never throws: a failed snapshot must not take down a turn
   * that is otherwise fine. The next successful snapshot (or the turn-end
   * replace) supersedes it.
   */
  async snapshot(messages: ToolLoopMessage[]): Promise<void> {
    if (!this.currentId) {return;}
    try {
      const finalPath = this.pathFor(this.currentId);
      const tmpPath = `${finalPath}.tmp`;
      const body = messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
      await fs.promises.writeFile(tmpPath, body);
      await fs.promises.rename(tmpPath, finalPath);
    } catch {
      // Disk full, permissions, race with another writer — the turn continues;
      // the completed turn will be persisted normally at the boundary.
    }
  }

  private pathFor(id: string): string {
    return path.join(SESSIONS_DIR, `${id}.jsonl`);
  }
}

function newId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}
