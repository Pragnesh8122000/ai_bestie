/**
 * Bounded FIFO for TTS requests.
 *
 * The previous promise-chain mutex serialized synthesis but had no limit: every
 * request queued forever, including ones whose client had already hung up (the
 * abort was only checked before joining the chain and after inference). With a
 * few concurrent users that meant unbounded waiting sockets and CPU spent on
 * audio nobody would hear. This queue:
 *
 *  - runs at most `concurrency` jobs at once;
 *  - rejects immediately with `TtsBusyError` once `maxQueue` jobs are waiting
 *    (backpressure — the client retries once, then skips the chunk);
 *  - drops a waiting job the moment its AbortSignal fires (client
 *    disconnected / reply superseded), so it is never sent upstream;
 *  - gives up on a job that has waited longer than `queueTimeoutMs`.
 *
 * A job that has started holds its slot until the underlying promise settles,
 * even if the caller stopped waiting, so the concurrency bound is always
 * honest.
 */

export class TtsBusyError extends Error {
  constructor() {
    super('TTS queue full');
    this.name = 'TtsBusyError';
  }
}

export class TtsQueueTimeoutError extends Error {
  constructor() {
    super('TTS queue wait timed out');
    this.name = 'TtsQueueTimeoutError';
  }
}

export class TtsCancelledError extends Error {
  constructor() {
    super('TTS cancelled');
    this.name = 'TtsCancelledError';
  }
}

export interface TtsQueueStats {
  active: number;
  queued: number;
  concurrency: number;
  maxQueue: number;
}

interface Waiter {
  start: () => void;
  fail: (error: Error) => void;
}

export class TtsQueue {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueue: number,
    private readonly queueTimeoutMs: number,
  ) {}

  stats(): TtsQueueStats {
    return {
      active: this.active,
      queued: this.waiting.length,
      concurrency: this.concurrency,
      maxQueue: this.maxQueue,
    };
  }

  /**
   * Run `task` when a slot is free. `onStart` fires when it leaves the queue
   * (use it to start an inference timer); the result carries how long the job
   * waited.
   */
  run<T>(
    task: () => Promise<T>,
    opts: { signal?: AbortSignal; onStart?: (waitMs: number) => void } = {},
  ): Promise<{ value: T; waitMs: number }> {
    const { signal, onStart } = opts;
    if (signal?.aborted) return Promise.reject(new TtsCancelledError());
    const enqueuedAt = Date.now();

    return new Promise((resolve, reject) => {
      // Holder rather than `let`: the timer is only armed once the job queues.
      const wait: { timer?: ReturnType<typeof setTimeout> } = {};
      const cleanup = () => {
        if (wait.timer) clearTimeout(wait.timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const execute = () => {
        cleanup();
        this.active++;
        const waitMs = Date.now() - enqueuedAt;
        onStart?.(waitMs);
        let result: Promise<T>;
        try {
          result = task();
        } catch (error) {
          result = Promise.reject(error);
        }
        result
          .then((value) => resolve({ value, waitMs }), reject)
          .finally(() => {
            this.active--;
            this.next();
          });
      };
      const waiter: Waiter = {
        start: execute,
        fail: (error) => {
          cleanup();
          reject(error);
        },
      };
      const remove = (error: Error) => {
        const i = this.waiting.indexOf(waiter);
        if (i !== -1) this.waiting.splice(i, 1);
        waiter.fail(error);
      };
      const onAbort = () => remove(new TtsCancelledError());

      if (this.active < this.concurrency && this.waiting.length === 0) {
        execute();
        return;
      }
      if (this.waiting.length >= this.maxQueue) {
        reject(new TtsBusyError());
        return;
      }
      this.waiting.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      wait.timer = setTimeout(() => remove(new TtsQueueTimeoutError()), this.queueTimeoutMs);
    });
  }

  private next(): void {
    while (this.active < this.concurrency && this.waiting.length) {
      this.waiting.shift()!.start();
    }
  }
}
