import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config/index', () => ({
  config: {
    llm: {
      geminiApiKey: 'test-key',
      geminiModel: 'primary',
      geminiFallbackModels: ['secondary'],
      openrouterApiKey: '',
      openrouterFallbackModels: [],
    },
    client: { url: 'http://localhost' },
    nodeEnv: 'test',
  },
}));

import { streamChat } from './llmService';

const token = (content: string) => ({ choices: [{ delta: { content } }] });
const finish = { choices: [{ delta: {}, finish_reason: 'stop' }] };
function response(frames: unknown[], crlf = false) {
  const newline = crlf ? '\r\n' : '\n';
  const text = frames
    .map(
      (frame) =>
        `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}${newline}${newline}`,
    )
    .join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}
const options = () => ({ systemPrompt: 'test', messages: [], onToken: vi.fn(), onEnd: vi.fn() });
beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('provider streaming reliability', () => {
  it('cancels a provider that never sends its first token and uses a fallback', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    vi.mocked(fetch).mockResolvedValueOnce(response([token('recovered'), finish]));
    const pending = streamChat(options());
    const result = expect(pending).resolves.toBe('recovered');
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(cancel).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts a connection that never returns headers before using a fallback', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.mocked(fetch).mockResolvedValueOnce(response([token('recovered'), finish]));
    const pending = streamChat(options());
    const result = expect(pending).resolves.toBe('recovered');
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('streams CRLF frames and commits the complete text once', async () => {
    vi.mocked(fetch).mockResolvedValue(response([token('Hello'), token(' world.'), finish], true));
    const callbacks = options();
    expect(await streamChat(callbacks)).toBe('Hello world.');
    expect(callbacks.onEnd).toHaveBeenCalledExactlyOnceWith('Hello world.');
  });

  it('accepts a DONE marker and cancels the upstream connection', async () => {
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n',
              ),
            );
          },
          cancel,
        }),
      ),
    );
    expect(await streamChat(options())).toBe('Hello');
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    [token('partial')],
    [token('partial'), { error: { message: 'upstream failed' } }],
    [finish],
    ['{broken}'],
  ])('never commits an interrupted, empty, or corrupt response: %j', async (frame) => {
    const callbacks = options();
    vi.mocked(fetch).mockResolvedValue(response(Array.isArray(frame) ? frame : [frame]));
    await expect(streamChat(callbacks)).rejects.toThrow();
    expect(callbacks.onEnd).not.toHaveBeenCalled();
  });

  it('advances to a fallback model when the first connection fails before output', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network'));
    vi.mocked(fetch).mockResolvedValueOnce(response([token('recovered'), finish]));
    expect(await streamChat(options())).toBe('recovered');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not splice a fallback response into an already streamed partial reply', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response([token('partial')]));
    await expect(streamChat(options())).rejects.toThrow(/interrupted/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws on cancellation instead of returning a partial result', async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockResolvedValue(response([token('partial'), finish]));
    const callbacks = options();
    callbacks.onToken.mockImplementation(() => controller.abort());
    await expect(streamChat({ ...callbacks, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(callbacks.onEnd).not.toHaveBeenCalled();
  });
});
