import { afterEach, describe, expect, it } from 'vitest';
import { logMetric, setMetricSink } from './metricsLog';

describe('logMetric', () => {
  afterEach(() => setMetricSink(null));

  it('emits one JSON line with an ISO timestamp, the event name and the fields', () => {
    const lines: string[] = [];
    setMetricSink((l) => lines.push(l));

    logMetric('chat.turn', { totalMs: 1234, outcome: 'ok' });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ evt: 'chat.turn', totalMs: 1234, outcome: 'ok' });
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  it('writes nothing by default under test', () => {
    // No sink installed: must be a silent no-op (no stdout, no file).
    expect(() => logMetric('chat.turn', { totalMs: 1 })).not.toThrow();
  });
});
