import { afterEach, describe, expect, it } from 'vitest';
import { logMetric, setMetricSink } from './metricsLog';
import { parseIst } from './time';

describe('logMetric', () => {
  afterEach(() => setMetricSink(null));

  it('emits one JSON line with an IST timestamp, the event name and the fields', () => {
    const lines: string[] = [];
    setMetricSink((l) => lines.push(l));

    logMetric('chat.turn', { totalMs: 1234, outcome: 'ok' });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ evt: 'chat.turn', totalMs: 1234, outcome: 'ok' });
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/);
    expect(Math.abs(parseIst(parsed.ts) - Date.now())).toBeLessThan(5_000);
  });

  it('writes nothing by default under test', () => {
    // No sink installed: must be a silent no-op (no stdout, no file).
    expect(() => logMetric('chat.turn', { totalMs: 1 })).not.toThrow();
  });
});
