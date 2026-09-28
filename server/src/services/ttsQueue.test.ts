import { describe, expect, it } from 'vitest';
import { TtsBusyError, TtsCancelledError, TtsQueue, TtsQueueTimeoutError } from './ttsQueue';

/** A task that finishes when the test says so. */
function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('TtsQueue', () => {
  it('runs one job at a time, in arrival order', async () => {
    const q = new TtsQueue(1, 8, 10_000);
    const order: string[] = [];
    const a = deferred();
    const b = deferred();
    const pa = q.run(() => (order.push('a'), a.promise));
    const pb = q.run(() => (order.push('b'), b.promise));
    await tick();
    expect(order).toEqual(['a']);
    expect(q.stats()).toMatchObject({ active: 1, queued: 1 });
    a.resolve('A');
    await pa;
    await tick();
    expect(order).toEqual(['a', 'b']);
    b.resolve('B');
    expect((await pb).value).toBe('B');
    await tick(); // the slot is released as the job's promise settles
    expect(q.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('applies backpressure: rejects at once when the wait list is full', async () => {
    const q = new TtsQueue(1, 2, 10_000);
    const hold = deferred();
    void q.run(() => hold.promise);
    void q.run(() => Promise.resolve('x')).catch(() => {});
    void q.run(() => Promise.resolve('y')).catch(() => {});
    await expect(q.run(() => Promise.resolve('z'))).rejects.toBeInstanceOf(TtsBusyError);
    hold.resolve('done');
  });

  it('drops a waiting job whose client disconnected, without ever running it', async () => {
    const q = new TtsQueue(1, 8, 10_000);
    const hold = deferred();
    void q.run(() => hold.promise);
    const ac = new AbortController();
    let ran = false;
    const waiting = q.run(() => ((ran = true), Promise.resolve('late')), { signal: ac.signal });
    ac.abort();
    await expect(waiting).rejects.toBeInstanceOf(TtsCancelledError);
    expect(q.stats().queued).toBe(0);
    hold.resolve('done');
    await tick();
    expect(ran).toBe(false);
  });

  it('rejects an already-cancelled request immediately', async () => {
    const q = new TtsQueue(1, 8, 10_000);
    const ac = new AbortController();
    ac.abort();
    await expect(q.run(() => Promise.resolve('x'), { signal: ac.signal })).rejects.toBeInstanceOf(
      TtsCancelledError,
    );
  });

  it('gives up on a job that waited too long', async () => {
    const q = new TtsQueue(1, 8, 30);
    const hold = deferred();
    void q.run(() => hold.promise);
    await expect(q.run(() => Promise.resolve('x'))).rejects.toBeInstanceOf(TtsQueueTimeoutError);
    hold.resolve('done');
  });

  it('holds the slot until a started job settles, even if it fails', async () => {
    const q = new TtsQueue(1, 8, 10_000);
    const first = deferred();
    const p1 = q.run(() => first.promise);
    let secondStarted = false;
    const p2 = q.run(() => ((secondStarted = true), Promise.resolve('ok')));
    await tick();
    expect(secondStarted).toBe(false);
    first.reject(new Error('inference failed'));
    await expect(p1).rejects.toThrow('inference failed');
    expect((await p2).value).toBe('ok');
  });

  it('reports queue wait to onStart and in the result', async () => {
    const q = new TtsQueue(1, 8, 10_000);
    const hold = deferred();
    void q.run(() => hold.promise);
    let started = -1;
    const p = q.run(() => Promise.resolve('x'), { onStart: (w) => (started = w) });
    await new Promise((r) => setTimeout(r, 25));
    hold.resolve('done');
    const { waitMs } = await p;
    expect(started).toBe(waitMs);
    expect(waitMs).toBeGreaterThanOrEqual(20);
  });

  it('serves many concurrent users without exceeding its concurrency', async () => {
    const q = new TtsQueue(2, 50, 10_000);
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 20 }, () =>
      q.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 2));
        running--;
        return 'ok';
      }),
    );
    await Promise.all(jobs);
    expect(peak).toBe(2);
  });
});
