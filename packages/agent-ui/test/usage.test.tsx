import { describe, expect, it } from 'vitest';

import { TelemetryPanel } from '../src/components/TelemetryPanel';
import { ContextMeter, UsageMeter, usagePercent } from '../src/components/UsageMeter';
import { mount } from './_dom';

describe('UsageMeter', () => {
  it('shows a bar only when used and limit are both known', () => {
    const el = mount(<UsageMeter label="Session" used={50} limit={200} />);
    const bar = el.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(el.textContent).toContain('50 / 200');
  });

  it('reads Unknown, not 0, when usage was not reported', () => {
    const el = mount(<ContextMeter used={undefined} limit={128000} />);
    expect(el.textContent).toContain('Unknown');
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('does not draw a full bar when no limit was reported', () => {
    const el = mount(<UsageMeter label="Session" used={12} limit={0} />);
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
    expect(el.textContent).toContain('no limit reported');
    expect(usagePercent(12, 0)).toBeNull();
    expect(usagePercent(500, 100)).toBe(100);
  });
});

describe('TelemetryPanel', () => {
  it('marks token counts the provider never reported as Unknown', () => {
    const el = mount(
      <TelemetryPanel
        telemetry={{
          totalEvents: 3,
          tokens: { input: 0, output: 42, total: 42 },
          tokensReported: { input: false, output: true, total: true },
          completedSteps: 1,
          failedSteps: 0
        }}
      />
    );
    const metrics = Array.from(el.querySelectorAll('.agent-ui-metric')).map((m) => m.textContent);
    expect(metrics).toContain('Input TokensUnknown');
    expect(metrics).toContain('Output Tokens42');
  });

  it('keeps the old rendering for snapshots without reporting flags', () => {
    const el = mount(
      <TelemetryPanel telemetry={{ totalEvents: 0, tokens: { input: 0, output: 0, total: 0 }, completedSteps: 0, failedSteps: 0 }} />
    );
    expect(el.textContent).toContain('Input Tokens0');
  });
});
