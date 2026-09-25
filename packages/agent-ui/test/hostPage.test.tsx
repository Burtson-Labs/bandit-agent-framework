/**
 * agent-ui renders inside other people's pages (the Stealth webview, but also
 * marketing sites and host apps). Two things it must not do there: scroll the
 * host page when a card mounts, and fail to load because a runtime import is
 * missing from `dependencies` or does not resolve for a consumer.
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderMarkdownToHtml } from '../src/components/MarkdownMessage';
import { PermissionCard, type BanditPermissionPayload } from '../src/components/PermissionCard';
import { QuestionCard, type QuestionPayload } from '../src/components/QuestionCard';
import { mount } from './_dom';

const questions: QuestionPayload[] = [
  { id: 'lang', question: 'Which language?', options: [{ label: 'TypeScript' }, { label: 'Go' }] }
];
const permission: BanditPermissionPayload = {
  type: 'bandit:permission',
  id: 'perm-1',
  tool: 'run_command',
  primary: 'npm test',
  description: 'Run the tests',
  command: 'npm test',
  risk: 'Runs a shell command'
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auto-focus never scrolls the host page', () => {
  it('QuestionCard focuses itself with preventScroll', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const el = mount(<QuestionCard id="q" questions={questions} onSubmit={() => {}} />);
    const card = el.querySelector('.question-card');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focus.mock.contexts).toContain(card);
    for (const args of focus.mock.calls) expect(args[0]).toEqual({ preventScroll: true });
  });

  it('QuestionCard autoFocus={false} leaves focus where it was', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    mount(<QuestionCard id="q" questions={questions} onSubmit={() => {}} autoFocus={false} />);
    expect(focus).not.toHaveBeenCalled();
  });

  it('PermissionCard focuses itself with preventScroll, or not at all', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    mount(<PermissionCard payload={permission} onChoice={() => {}} />);
    expect(focus).toHaveBeenCalled();
    for (const args of focus.mock.calls) expect(args[0]).toEqual({ preventScroll: true });
    focus.mockClear();
    mount(<PermissionCard payload={{ ...permission, id: 'perm-2' }} onChoice={() => {}} autoFocus={false} />);
    expect(focus).not.toHaveBeenCalled();
  });

  it('no component calls focus() without preventScroll or uses the autoFocus attribute', () => {
    const dir = join(__dirname, '../src');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk(dir);
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          // Roving focus inside a tab list follows a key press and may scroll.
          if (/tabRefs\.current\[[^\]]+\]\?\.focus\(\)/.test(line)) return;
          // The JSX autoFocus attribute focuses without preventScroll.
          const jsxAutoFocus = /^\s*autoFocus(=\{[^}]*\})?\s*\/?>?$/.test(line) || /<\w[^>]*\sautoFocus\b/.test(line);
          if (/\.focus\(\s*\)/.test(line) || jsxAutoFocus)
            offenders.push(`${file.slice(dir.length + 1)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('runtime imports', () => {
  const root = join(__dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
  };

  const specifiers = (): string[] => {
    const found = new Set<string>();
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) {
          const src = readFileSync(p, 'utf8');
          for (const m of src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"'.][^"']*)["']/gm)) found.add(m[1]);
          for (const m of src.matchAll(/^import\s+["']([^"'.][^"']*)["']/gm)) found.add(m[1]);
        }
      }
    };
    walk(join(root, 'src'));
    return [...found];
  };

  it('every runtime import is a dependency or a peer', () => {
    const declared = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)]);
    const name = (s: string): string => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
    const missing = specifiers().filter((s) => !s.startsWith('node:') && !declared.has(name(s)));
    expect(missing).toEqual([]);
  });

  it('every deep import resolves the way a consumer resolves it', () => {
    const require = createRequire(join(root, 'package.json'));
    const deep = specifiers().filter((s) => (s.startsWith('@') ? s.split('/').length > 2 : s.includes('/')));
    const unresolved = deep.filter((s) => {
      try {
        require.resolve(s);
        return false;
      } catch {
        return true;
      }
    });
    expect(unresolved).toEqual([]);
  });

  it('file references still render as links', () => {
    const html = renderMarkdownToHtml('See src/components/Card.tsx:12 for details.');
    expect(html).toContain('data-file-ref="src/components/Card.tsx:12"');
    expect(html).toContain('>src/components/Card.tsx:12</a>');
  });
});
