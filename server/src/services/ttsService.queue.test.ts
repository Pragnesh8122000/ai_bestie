import { describe, it, expect, beforeEach, vi } from 'vitest';

const native = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('sherpa-onnx-node', () => ({
  OfflineTts: { createAsync: async () => ({ generateAsync: native.generate, sampleRate: 24000 }) },
  GenerationConfig: class {
    constructor(public config: unknown) {}
  },
}));
vi.mock('node:fs', () => ({ default: { existsSync: () => true } }));
vi.mock('../config', () => ({
  config: { tts: { enabled: true, modelDir: '/test', modelVersion: 'v1_0', speed: 0.95, sid: 3 } },
}));
vi.mock('../config/index', () => ({
  config: {
    nodeEnv: 'test',
    tts: { enabled: true, modelDir: '/test', modelVersion: 'v1_0', speed: 0.95, sid: 3 },
  },
}));

const audio = { samples: new Float32Array([0, 0.5, -0.5]), sampleRate: 24000 };
beforeEach(() => {
  vi.resetModules();
  native.generate.mockReset();
});

describe('bounded neural synthesis', () => {
  it('skips canceled queued work and permits the following request', async () => {
    let resolve!: (value: typeof audio) => void;
    native.generate
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue(audio);
    const { synthesize } = await import('./ttsService');
    const first = synthesize('First.', new AbortController().signal);
    await vi.waitFor(() => expect(native.generate).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const obsolete = synthesize('Obsolete.', controller.signal);
    const rejected = expect(obsolete).rejects.toMatchObject({ statusCode: 499 });
    const last = synthesize('Last.', new AbortController().signal);
    controller.abort();
    resolve(audio);
    await first;
    await rejected;
    expect((await last).toString('ascii', 0, 4)).toBe('RIFF');
    expect(native.generate.mock.calls.map(([request]) => request.text)).toEqual([
      'First.',
      'Last.',
    ]);
  });

  it('rejects overload rather than growing an unbounded queue', async () => {
    let release!: (value: typeof audio) => void;
    native.generate
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            release = r;
          }),
      )
      .mockResolvedValue(audio);
    const { synthesize } = await import('./ttsService');
    const first = synthesize('First.', new AbortController().signal);
    await vi.waitFor(() => expect(native.generate).toHaveBeenCalledTimes(1));
    const queued = Array.from({ length: 7 }, () =>
      synthesize('Queued.', new AbortController().signal),
    );
    await expect(synthesize('Overflow.', new AbortController().signal)).rejects.toMatchObject({
      statusCode: 503,
    });
    release(audio);
    await Promise.all([first, ...queued]);
    await expect(synthesize('After.', new AbortController().signal)).resolves.toBeInstanceOf(
      Buffer,
    );
  });
});
