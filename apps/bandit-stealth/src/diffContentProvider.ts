import * as vscode from 'vscode';

interface DiffEntry {
  readonly label: string;
  readonly diff: string;
  readonly added: number;
  readonly removed: number;
  readonly createdAt: number;
}

function countDiffLines(diff: string): { added: number; removed: number } {
  const lines = diff.split(/\r?\n/);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      removed += 1;
    }
  }
  return { added, removed };
}

export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  public static readonly scheme = 'bandit-diff';

  private readonly entries = new Map<string, DiffEntry>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();

  public readonly onDidChange = this.changeEmitter.event;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const entry = this.entries.get(uri.toString());
    if (!entry) {
      return ['# Diff expired', '', 'The requested diff preview is no longer available.'].join('\n');
    }

    const header = `# ${entry.label}`;
    const summary = `> Lines added: ${entry.added} · Lines removed: ${entry.removed}`;
    const timestamp = new Date(entry.createdAt).toLocaleString();
    const meta = `> Generated ${timestamp}`;

    return [header, summary, meta, '', '```diff', entry.diff, '```'].join('\n');
  }

  public registerDiff(label: string, diff: string): vscode.Uri {
    const id = Buffer.from(`${label}:${Date.now()}:${Math.random().toString(16).slice(2)}`).toString('base64url');
    const uri = vscode.Uri.parse(`${DiffContentProvider.scheme}:${encodeURIComponent(label)}?id=${id}`);
    const { added, removed } = countDiffLines(diff);
    this.entries.set(uri.toString(), { label, diff, added, removed, createdAt: Date.now() });
    this.changeEmitter.fire(uri);
    return uri;
  }

  public release(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.entries.delete(key)) {
      this.changeEmitter.fire(uri);
    }
  }

  public dispose(): void {
    this.entries.clear();
    this.changeEmitter.dispose();
  }
}
