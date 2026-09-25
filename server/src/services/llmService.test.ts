import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({
  llm: {
    geminiApiKey: 'gemini-key',
    geminiModel: 'gemini-primary',
    geminiFallbackModels: [] as string[],
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
