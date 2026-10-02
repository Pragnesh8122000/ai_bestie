import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({
  llm: {
    geminiApiKey: 'gemini-key',
    geminiModel: 'gemini-primary',
    geminiFallbackModels: [] as string[],
    geminiVoiceModels: ['gemini-voice-lite'] as string[],
    voiceHedgeDelayMs: 2000,
    openrouterApiKey: 'openrouter-key',
    openrouterModel: 'openrouter/free',
    openrouterFallbackModels: [] as string[],
  },
  client: { url: 'http://localhost:5173' },
}));

vi.mock('../config/index', () => ({ config: configMock }));

import { LlmProviderError, streamChat } from './llmService';

function sse(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` + 'data: [DONE]\n\n',
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function failure(status: number, message: string, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers });
}

function requestedModel(call: unknown[]): string {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)).model;
}

describe('LLM provider recovery', () => {
  beforeEach(() => {
    configMock.llm.geminiApiKey = 'gemini-key';
    configMock.llm.geminiModel = 'gemini-primary';
    configMock.llm.geminiFallbackModels = [];
    configMock.llm.geminiVoiceModels = ['gemini-voice-lite'];
    configMock.llm.voiceHedgeDelayMs = 2000;
    configMock.llm.openrouterApiKey = 'openrouter-key';
    configMock.llm.openrouterModel = 'openrouter/free';
    configMock.llm.openrouterFallbackModels = [];
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('de-duplicates configured models and falls through a retired Gemini model', async () => {
    configMock.llm.geminiModel = 'gemini-retired-a';
    configMock.llm.geminiFallbackModels = ['gemini-retired-a', 'gemini-current-a'];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failure(404, 'model has been retired'))
      .mockResolvedValueOnce(sse('hello'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      streamChat({ systemPrompt: 'system', messages: [{ role: 'user', content: 'hi' }] }),
    ).resolves.toBe('hello');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(requestedModel)).toEqual([
      'gemini-retired-a',
      'gemini-current-a',
    ]);
  });

  it('continues to OpenRouter after a provider-wide Gemini auth failure', async () => {
    configMock.llm.geminiModel = 'gemini-auth-a';
    configMock.llm.geminiFallbackModels = ['gemini-never-called-a'];
    configMock.llm.openrouterModel = 'openrouter/router-a';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failure(403, 'invalid credential'))
      .mockResolvedValueOnce(sse('fallback works'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      streamChat({ systemPrompt: 'system', messages: [{ role: 'user', content: 'hi' }] }),
    ).resolves.toBe('fallback works');

    expect(fetchMock.mock.calls.map(requestedModel)).toEqual([
      'gemini-auth-a',
      'openrouter/router-a',
    ]);
  });

  it('recovers from network failures by trying the next provider', async () => {
    vi.useFakeTimers();
    configMock.llm.geminiModel = 'gemini-network-a';
    configMock.llm.openrouterModel = 'openrouter/router-network-a';
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('socket closed with a very long internal trace'))
      .mockRejectedValueOnce(new TypeError('socket closed again'))
      .mockResolvedValueOnce(sse('recovered'));
    vi.stubGlobal('fetch', fetchMock);

    const result = streamChat({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('recovered');
    expect(fetchMock.mock.calls.map(requestedModel)).toEqual([
      'gemini-network-a',
      'gemini-network-a',
      'openrouter/router-network-a',
    ]);
  });

  it('fails over without a retry backoff for latency-sensitive voice replies', async () => {
    configMock.llm.geminiVoiceModels = ['gemini-network-a'];
    configMock.llm.openrouterModel = 'openrouter/router-network-a';
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('socket closed'))
      .mockResolvedValueOnce(sse('recovered quickly'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      streamChat({
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        latencyMode: true,
      }),
    ).resolves.toBe('recovered quickly');
    expect(fetchMock.mock.calls.map(requestedModel)).toEqual([
      'gemini-network-a',
      'openrouter/router-network-a',
    ]);
  });

  it('sends a reasoning value each Gemini model accepts', async () => {
    configMock.llm.geminiModel = 'gemini-3.8-flash';
    configMock.llm.geminiFallbackModels = ['gemini-3.5-flash-lite'];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failure(503, 'High demand'))
      .mockResolvedValueOnce(failure(503, 'High demand'))
      .mockResolvedValueOnce(sse('ok'));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const result = streamChat({ systemPrompt: 'system', messages: [{ role: 'user', content: 'hi' }] });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe('ok');

    const efforts = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call[1] as RequestInit).body)).reasoning_effort,
    );
    expect(efforts).toEqual(['none', 'none', 'minimal']);
  });

  it('uses the voice model list for latency-sensitive replies', async () => {
    configMock.llm.geminiModel = 'gemini-text-flash';
    configMock.llm.geminiVoiceModels = ['gemini-voice-lite'];
    const fetchMock = vi.fn().mockResolvedValueOnce(sse('quick'));
    vi.stubGlobal('fetch', fetchMock);
    const onProvider = vi.fn();

    await expect(
      streamChat({
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        latencyMode: true,
        onProvider,
      }),
    ).resolves.toBe('quick');
    expect(fetchMock.mock.calls.map(requestedModel)).toEqual(['gemini-voice-lite']);
    expect(onProvider).toHaveBeenCalledWith({
      provider: 'gemini',
      model: 'gemini-voice-lite',
      failedAttempts: 0,
      attempts: 1,
    });
  });

  describe('voice hedging', () => {
    // A fetch that stays pending until its request is aborted, or until
    // `release(model)` answers it.
    function controllableFetch() {
      const pending = new Map<string, (response: Response) => void>();
      const aborted: string[] = [];
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        const model = JSON.parse(String(init.body)).model as string;
        return new Promise<Response>((resolve, reject) => {
          pending.set(model, resolve);
          init.signal?.addEventListener('abort', () => {
            aborted.push(model);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      });
      const release = (model: string, response: Response) => pending.get(model)?.(response);
      return { fetchMock, release, aborted };
    }

    beforeEach(() => {
      vi.useFakeTimers();
      configMock.llm.geminiVoiceModels = ['lite-a', 'lite-b'];
      configMock.llm.openrouterModel = 'router-c';
    });

    it('starts the next model after the hedge delay and lets the first answer win', async () => {
      const { fetchMock, release, aborted } = controllableFetch();
      vi.stubGlobal('fetch', fetchMock);
      const tokens: string[] = [];
      const onProvider = vi.fn();

      const result = streamChat({
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        latencyMode: true,
        onToken: (token) => tokens.push(token),
        onProvider,
      });

      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock.mock.calls.map(requestedModel)).toEqual(['lite-a']);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock.mock.calls.map(requestedModel)).toEqual(['lite-a', 'lite-b']);

      release('lite-b', sse('from b'));
      await expect(result).resolves.toBe('from b');
      expect(tokens).toEqual(['from b']);
      expect(aborted).toEqual(['lite-a']);
      expect(onProvider).toHaveBeenCalledWith({
        provider: 'gemini',
        model: 'lite-b',
        failedAttempts: 0,
        attempts: 2,
      });

      // The in-flight cap held: the third candidate never started.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps waiting on a slow model rather than failing the turn', async () => {
      const { fetchMock, release, aborted } = controllableFetch();
      vi.stubGlobal('fetch', fetchMock);

      const result = streamChat({
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        latencyMode: true,
      });

      await vi.advanceTimersByTimeAsync(12_000);
      release('lite-a', sse('slow but fine'));
      await expect(result).resolves.toBe('slow but fine');
      expect(aborted).toEqual(['lite-b']);
    });

    it('starts the next model immediately when one fails', async () => {
      const { fetchMock, release } = controllableFetch();
      vi.stubGlobal('fetch', fetchMock);

      const result = streamChat({
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        latencyMode: true,
      });

      await vi.advanceTimersByTimeAsync(0);
      release('lite-a', failure(400, 'invalid argument'));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock.mock.calls.map(requestedModel)).toEqual(['lite-a', 'lite-b']);

      release('lite-b', sse('b answered'));
      await expect(result).resolves.toBe('b answered');
    });

    it('reports busy providers once every candidate has failed', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(failure(503, 'High demand'))
        .mockResolvedValueOnce(failure(503, 'overloaded'))
        .mockResolvedValueOnce(failure(429, 'slow down', { 'retry-after': '30' }));
      vi.stubGlobal('fetch', fetchMock);

      const result = streamChat({
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        latencyMode: true,
      });
      const caught = result.catch((error) => error);
      await vi.runAllTimersAsync();

      const error = await caught;
      expect(error).toBeInstanceOf(LlmProviderError);
      expect(error.code).toBe('LLM_BUSY');
      expect(fetchMock.mock.calls.map(requestedModel)).toEqual(['lite-a', 'lite-b', 'router-c']);
    });

    it('aborts every in-flight request when the caller aborts', async () => {
      const { fetchMock, aborted } = controllableFetch();
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();

      const result = streamChat({
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        latencyMode: true,
        signal: controller.signal,
      });
      const caught = result.catch((error) => error);
      await vi.advanceTimersByTimeAsync(2000);
      controller.abort();

      const error = await caught;
      expect(error.name).toBe('AbortError');
      expect(aborted.sort()).toEqual(['lite-a', 'lite-b']);
    });
  });

  it('summarizes overload and rate limits without exposing provider payloads', async () => {
    vi.useFakeTimers();
    configMock.llm.geminiModel = 'gemini-busy-a';
    configMock.llm.openrouterModel = 'openrouter/busy-a';
    const opaque = `upstream stack ${'x'.repeat(10_000)}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failure(503, `High demand. ${opaque}`))
      .mockResolvedValueOnce(failure(503, `High demand. ${opaque}`))
      .mockResolvedValueOnce(failure(429, opaque, { 'retry-after': '60' }))
      .mockResolvedValueOnce(failure(429, opaque, { 'retry-after': '60' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = streamChat({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const caught = result.catch((error) => error);
    await vi.runAllTimersAsync();

    const error = await caught;
    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error.code).toBe('LLM_BUSY');
    expect(error.message).toBe('AI providers are busy right now. Please try again in a minute.');
    expect(error.message).not.toContain('upstream stack');
    expect(error.internalSummary.length).toBeLessThan(250);
  });
});
