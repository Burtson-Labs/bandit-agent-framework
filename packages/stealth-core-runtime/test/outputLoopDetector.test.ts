import { describe, expect, it } from 'vitest';
import {
  findPeriodicTail,
  isModelOutputLoopError,
  ModelOutputLoopError,
  OutputLoopDetector,
  THINKING_LOOP_MIN_RUN
} from '../src';

/** Feed text through the detector in uneven chunk sizes, the way a stream arrives. */
function feed(detector: OutputLoopDetector, channel: 'thinking' | 'content', text: string): ReturnType<OutputLoopDetector['push']> {
  const sizes = [1, 3, 7, 2, 11, 5, 17, 4];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const n = sizes[k++ % sizes.length];
    const hit = detector.push(channel, text.slice(i, i + n));
    if (hit) {return hit;}
    i += n;
  }
  return null;
}

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

describe('findPeriodicTail', () => {
  it('finds the smallest repeating unit at the end', () => {
    const m = findPeriodicTail('intro text ' + 'ab'.repeat(3000), 4000);
    expect(m?.unit).toBe('ab');
  });
  it('needs the whole window to be periodic', () => {
    expect(findPeriodicTail('x' + 'ab'.repeat(1999), 4000)).toBeNull();
    expect(findPeriodicTail('ab'.repeat(1000), 4000)).toBeNull();
  });
  it('ignores units longer than maxUnit', () => {
    const unit = 'z'.repeat(90) + '\n';
    expect(findPeriodicTail(unit.repeat(100), 4000)).toBeNull();
  });
});

describe('OutputLoopDetector — positive', () => {
  it('trips on the gemma4 `<|channel>thought ` thinking loop (real 2026-10-19 trace)', () => {
    const d = new OutputLoopDetector();
    const stream = 'The user wants me to rename CalcRate. Let me look at rates.go first.\n' + '<|channel>thought '.repeat(2000);
    const hit = feed(d, 'thinking', stream);
    // The unit is reported as it ends the tail, so it may be a rotation.
    expect(hit?.unit.length).toBe('<|channel>thought '.length);
    expect((hit!.unit + hit!.unit).includes('<|channel>thought ')).toBe(true);
  });
  it('trips within ~one check interval of crossing the threshold', () => {
    const d = new OutputLoopDetector();
    const unit = '<|channel>thought ';
    let pushed = 0;
    let hit = null;
    while (!hit && pushed < 30_000) {
      hit = d.push('thinking', unit);
      pushed += unit.length;
    }
    expect(hit).not.toBeNull();
    expect(pushed).toBeLessThan(THINKING_LOOP_MIN_RUN + 400);
  });
  it('trips on single-token loops (a run of one character)', () => {
    expect(feed(new OutputLoopDetector(), 'thinking', '\n'.repeat(5000))?.unit).toBe('\n');
  });
  it('builds a recognisable error', () => {
    const err = new ModelOutputLoopError('thinking', { unit: '<|channel>thought ', run: 4000 });
    expect(err.message.startsWith('Model output loop detected')).toBe(true);
    expect(err.code).toBe('MODEL_OUTPUT_LOOP');
    expect(isModelOutputLoopError(err)).toBe(true);
    // Survives a host re-wrapping it as a plain object / error with the same message.
    expect(isModelOutputLoopError({ message: err.message })).toBe(true);
    expect(isModelOutputLoopError(new Error('Ollama stream stalled'))).toBe(false);
  });
});

describe('OutputLoopDetector — legitimate repetitive output never trips', () => {
  const legit: Array<[string, string]> = [
    ['table of numbers', '| run | ms | pass |\n|---|---|---|\n' + lines(400, (i) => `| ${i} | ${(i * 37) % 1000} | ${i % 3 ? 'yes' : 'no'} |`)],
    ['table of identical-looking rows with a counter', lines(500, (i) => `| row ${i} | 0 | 0 | 0 |`)],
    ['repeated test cases', lines(150, (i) => `  it('parses case ${i}', () => {\n    expect(parse('${i}.00')).toBe(${i * 100});\n  });`)],
    ['ASCII separators between sections', lines(60, (i) => `${'='.repeat(78)}\nSection ${i}\n${'-'.repeat(78)}\nbody text for section ${i}`)],
    ['a long `0, 0, 0` array broken into rows', '[\n' + lines(64, () => '  ' + Array(64).fill('0').join(', ') + ',') + '\n]'],
    ['similar import lines', lines(300, (i) => `import { handler${i} } from './handlers/handler${i}';`)],
    ['long realistic code', lines(400, (i) => `export function fn${i}(a: number, b: number): number {\n  const t = a * ${i} + b;\n  return t > ${i} ? t - ${i} : t + ${i};\n}`)],
    ['long markdown', lines(200, (i) => `## Step ${i}\n\nRun \`pnpm test\` and check that item ${i} passes. If it fails, re-read the error.\n\n- [ ] item ${i}a\n- [ ] item ${i}b`)],
    ['hex dump', lines(300, (i) => `${(i * 16).toString(16).padStart(8, '0')}  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 ${(i % 256).toString(16).padStart(2, '0')}`)],
    ['a short run of separators (3000 chars)', 'Results:\n' + '-'.repeat(3000) + '\nDone.'],
  ];
  it.each(legit)('%s (thinking channel, default threshold)', (_name, text) => {
    expect(text.length).toBeGreaterThan(3000);
    expect(feed(new OutputLoopDetector(), 'thinking', text)).toBeNull();
  });
  it.each(legit)('%s (content channel is off by default)', (_name, text) => {
    expect(feed(new OutputLoopDetector(), 'content', text)).toBeNull();
  });
  it('content channel stays off even for a degenerate run unless enabled', () => {
    expect(feed(new OutputLoopDetector(), 'content', 'ab'.repeat(20_000))).toBeNull();
    expect(feed(new OutputLoopDetector({ minRun: { content: 12_000 } }), 'content', 'ab'.repeat(20_000))?.unit).toBe('ab');
  });
});
