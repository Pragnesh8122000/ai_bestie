import { config } from '../config/index';

/**
 * LLM service with a provider chain.
 *
 * Primary: Google Gemini (free tier) via its OpenAI-compatible endpoint.
 * Secondary: OpenRouter (OpenAI-compatible) free models.
 *
 * Both speak the OpenAI `/chat/completions` SSE format, so a single streaming
 * parser handles either. We try providers in order; within each provider we
 * try its model list with retry+backoff before moving on. Only auth errors
 * (401/403) — which are truly provider-wide — break that provider's model
 * loop; a 400/404 is often model-specific, so we continue to the next model.
 */

export interface StreamOptions {
  systemPrompt: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  onToken?: (token: string) => void;
  onEnd?: (fullText: string) => void;
  signal?: AbortSignal;
  /**
   * Interactive voice turn: use the voice model list, skip same-model retry
   * backoff, and hedge slow models (see `streamChatHedged`).
   */
  latencyMode?: boolean;
  /** Called once a model wins, with which one, how many failed, and how many requests were started. */
  onProvider?: (info: ProviderInfo) => void;
}

export interface ProviderInfo {
  provider: string;
  model: string;
  failedAttempts: number;
  /** Upstream requests started for this turn (> failedAttempts + 1 when hedging raced). */
  attempts?: number;
}

interface Provider {
  name: string;
  url: string;
  apiKey: string;
  models: string[];
  // Extra request-body fields specific to this provider and model (merged into the payload).
  extraBody?: (model: string) => Record<string, unknown>;
  // Extra HTTP headers specific to this provider.
  extraHeaders?: Record<string, string>;
}

type FailureKind =
  'rate-limit' | 'overloaded' | 'model-unavailable' | 'auth' | 'network' | 'upstream';

interface AttemptFailure {
  provider: string;
  model: string;
  status: number;
  kind: FailureKind;
}

export class LlmProviderError extends Error {
  readonly code: 'LLM_BUSY' | 'LLM_CONFIGURATION' | 'LLM_UNAVAILABLE';
  readonly internalSummary: string;

  constructor(
    code: 'LLM_BUSY' | 'LLM_CONFIGURATION' | 'LLM_UNAVAILABLE',
    message: string,
    internalSummary: string,
  ) {
    super(message);
    this.name = 'LlmProviderError';
    this.code = code;
    this.internalSummary = internalSummary;
  }
}

const RETRIES_PER_MODEL = 2;
// In-process rate-limit cooldown (free, no shared state). Maps a
// "provider/model" key to the epoch-ms when it may be retried. Lets us skip
// models the provider just told us to back off from, instead of burning more
// of the (tight, shared) free-tier quota on calls we know will 429.
const cooldownUntil = new Map<string, number>();
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

// Gemini Flash models "think" by default, delaying the first visible token;
// "none" turns that off. Flash-Lite models reject "none" with a 400 but
// accept "minimal" (verified 2026-10).
export function geminiReasoningEffort(model: string): 'none' | 'minimal' {
  return /lite/i.test(model) ? 'minimal' : 'none';
}

function buildProviders(voice = false): Provider[] {
  const providers: Provider[] = [];

  if (config.llm.geminiApiKey) {
    providers.push({
      name: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      apiKey: config.llm.geminiApiKey,
      models: uniqueModels(
        voice
          ? config.llm.geminiVoiceModels
          : [config.llm.geminiModel, ...config.llm.geminiFallbackModels],
      ),
      extraBody: (model) => ({ reasoning_effort: geminiReasoningEffort(model) }),
    });
  }

  if (config.llm.openrouterApiKey) {
    providers.push({
      name: 'openrouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: config.llm.openrouterApiKey,
      models: uniqueModels([config.llm.openrouterModel, ...config.llm.openrouterFallbackModels]),
      // OpenRouter requests attribution headers for free-model routing/ranking.
      extraHeaders: {
        'HTTP-Referer': config.client.url,
        'X-Title': 'AI Bestie',
      },
    });
  }

  return providers;
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function classifyFailure(status: number, body: string): FailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 404 || status === 400 || status === 422) return 'model-unavailable';
  if (status === 0) return 'network';

  const normalized = body.toLowerCase();
  if (
    status === 503 ||
    normalized.includes('overload') ||
    normalized.includes('high demand') ||
    normalized.includes('no endpoints found')
  ) {
    return 'overloaded';
  }
  return 'upstream';
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get('retry-after');
  if (!value) return DEFAULT_COOLDOWN_MS;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds, 5), MAX_COOLDOWN_MS / 1000) * 1000;
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) return DEFAULT_COOLDOWN_MS;
  return Math.min(Math.max(date - Date.now(), 5_000), MAX_COOLDOWN_MS);
}

function providerError(failures: AttemptFailure[]): LlmProviderError {
  const counts = failures.reduce<Record<string, number>>((summary, failure) => {
    summary[failure.kind] = (summary[failure.kind] ?? 0) + 1;
    return summary;
  }, {});
  const attempts = failures
    .map(
      ({ provider, model, status, kind }) => `${provider}/${model}=${status || 'network'}:${kind}`,
    )
    .join(', ');
  const internalSummary = `${Object.entries(counts)
    .map(([kind, count]) => `${kind}:${count}`)
    .join(' ')}; attempts: ${attempts}`;

  if (failures.length > 0 && failures.every((failure) => failure.kind === 'auth')) {
    return new LlmProviderError(
      'LLM_CONFIGURATION',
      'AI service configuration needs attention. Please contact the app owner.',
      internalSummary,
    );
  }
  if (
    failures.length > 0 &&
    failures.every((failure) => failure.kind === 'rate-limit' || failure.kind === 'overloaded')
  ) {
    return new LlmProviderError(
      'LLM_BUSY',
      'AI providers are busy right now. Please try again in a minute.',
      internalSummary,
    );
  }
  return new LlmProviderError(
    'LLM_UNAVAILABLE',
    'AI providers are temporarily unavailable. Please try again shortly.',
    internalSummary,
  );
}

async function openStream(
  url: string,
  apiKey: string,
  model: string,
  payload: Record<string, unknown>,
  extraBody?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
  attempts = RETRIES_PER_MODEL,
): Promise<{ response: Response | null; ok: boolean; error: string; status: number }> {
  let response: Response | null = null;
  let lastError = '';
  let lastStatus = 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(extraHeaders || {}),
        },
        body: JSON.stringify({ ...payload, ...extraBody, model }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      lastStatus = 0;
      lastError = error instanceof Error ? error.message : 'network error';
      if (attempt === attempts - 1) {
        return { response: null, ok: false, error: lastError, status: 0 };
      }
      await sleep(1000 * (attempt + 1), signal);
      continue;
    }

    if (response.ok && response.body) {
      return { response, ok: true, error: '', status: response.status };
    }

    lastStatus = response.status;
    lastError = await response.text().catch(() => '');
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts - 1) {
      return { response, ok: false, error: lastError, status: lastStatus };
    }
    try {
      await sleep(1000 * (attempt + 1), signal);
    } catch {
      return { response, ok: false, error: lastError, status: lastStatus };
    }
  }

  return { response, ok: false, error: lastError, status: lastStatus };
}

/**
 * Stream a chat completion, yielding tokens via onToken.
 * Tries Gemini first, then OpenRouter; within each, tries its model list.
 */
export async function streamChat(options: StreamOptions): Promise<string> {
  const { systemPrompt, messages, maxTokens = 1024, onToken, onEnd, signal, latencyMode, onProvider } =
    options;

  const providers = buildProviders(latencyMode);
  if (providers.length === 0) {
    throw new Error(
      'No LLM key set. Add GEMINI_API_KEY (primary) and/or OPENROUTER_API_KEY to /.env or /server/.env',
    );
  }

  const payload = {
    stream: true,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  };

  if (latencyMode) {
    return streamChatHedged(providers, payload, options);
  }

  const failures: AttemptFailure[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const key = `${provider.name}/${model}`;
      const cooldown = cooldownUntil.get(key);
      if (cooldown && cooldown > Date.now()) {
        failures.push({ provider: provider.name, model, status: 429, kind: 'rate-limit' });
        continue;
      }
      const { response, ok, error, status } = await openStream(
        provider.url,
        provider.apiKey,
        model,
        payload,
        provider.extraBody?.(model),
        provider.extraHeaders,
        signal,
      );
      if (ok && response) {
        onProvider?.({ provider: provider.name, model, failedAttempts: failures.length });
        return consumeStream(response, onToken, onEnd, signal);
      }
      failures.push(recordFailure(provider.name, model, status, error, response));
      // Only auth errors are truly provider-wide. A 400/404 is usually
      // model-specific (bad model id / unsupported param) — continue to the
      // next model rather than skipping the rest of this provider's list.
      if (status === 401 || status === 403) {
        break;
      }
    }
  }

  throw providerError(failures);
}

function recordFailure(
  provider: string,
  model: string,
  status: number,
  error: string,
  response: Response | null,
): AttemptFailure {
  if (status === 429) {
    cooldownUntil.set(
      `${provider}/${model}`,
      Date.now() + (response ? retryAfterMs(response) : DEFAULT_COOLDOWN_MS),
    );
  }
  return { provider, model, status, kind: classifyFailure(status, error) };
}

// At most this many upstream requests race at once, to spare free-tier quota.
const MAX_HEDGED_IN_FLIGHT = 2;

/**
 * Voice-turn variant of the provider chain. Free-tier latency is bursty
 * (the same model answers in 0.7s or 12s minutes apart), so instead of
 * waiting on one model we hedge: start the first candidate, and if it has
 * produced no token after `voiceHedgeDelayMs` (or fails), start the next one
 * alongside it. The first request to yield a token wins and the others are
 * aborted. Nothing is cut off on a timer, so a slow-but-working model still
 * answers when every candidate is slow.
 */
function streamChatHedged(
  providers: Provider[],
  payload: Record<string, unknown>,
  { onToken, onEnd, signal, onProvider }: StreamOptions,
): Promise<string> {
  const candidates = providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  const failures: AttemptFailure[] = [];
  const authFailed = new Set<string>();
  const inFlight = new Set<AbortController>();
  let started = 0;
  let next = 0;
  let winner: AbortController | null = null;
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      signal?.removeEventListener('abort', onOuterAbort);
      fn();
    };
    const onOuterAbort = () => {
      for (const controller of inFlight) controller.abort();
      // Once a winner is streaming, let it settle the same way the
      // sequential path does when its stream is aborted.
      if (!winner) finish(() => reject(new DOMException('Aborted', 'AbortError')));
    };
    if (signal?.aborted) return onOuterAbort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    const failIfExhausted = () => {
      if (!winner && inFlight.size === 0 && next >= candidates.length) {
        finish(() => reject(providerError(failures)));
      }
    };

    const launchNext = () => {
      clearTimeout(hedgeTimer);
      if (settled || winner || inFlight.size >= MAX_HEDGED_IN_FLIGHT) return;
      while (next < candidates.length) {
        const { provider, model } = candidates[next++];
        if (authFailed.has(provider.name)) continue;
        const cooldown = cooldownUntil.get(`${provider.name}/${model}`);
        if (cooldown && cooldown > Date.now()) {
          failures.push({ provider: provider.name, model, status: 429, kind: 'rate-limit' });
          continue;
        }
        void attempt(provider, model);
        if (next < candidates.length) {
          hedgeTimer = setTimeout(launchNext, config.llm.voiceHedgeDelayMs);
        }
        return;
      }
      failIfExhausted();
    };

    const attempt = async (provider: Provider, model: string) => {
      const controller = new AbortController();
      inFlight.add(controller);
      started++;
      const claim = () => {
        if (winner) return winner === controller;
        winner = controller;
        clearTimeout(hedgeTimer);
        for (const other of inFlight) if (other !== controller) other.abort();
        onProvider?.({
          provider: provider.name,
          model,
          failedAttempts: failures.length,
          attempts: started,
        });
        return true;
      };

      try {
        const { response, ok, error, status } = await openStream(
          provider.url,
          provider.apiKey,
          model,
          payload,
          provider.extraBody?.(model),
          provider.extraHeaders,
          controller.signal,
          1,
        );
        if (!ok || !response) {
          inFlight.delete(controller);
          if (winner || settled) return;
          failures.push(recordFailure(provider.name, model, status, error, response));
          if (status === 401 || status === 403) authFailed.add(provider.name);
          launchNext();
          return;
        }
        const text = await consumeStream(
          response,
          (token) => {
            if (claim()) onToken?.(token);
          },
          (fullText) => {
            // A stream that ended without any token still counts as an answer.
            if (claim()) onEnd?.(fullText);
          },
          controller.signal,
        );
        inFlight.delete(controller);
        if (winner === controller) finish(() => resolve(text));
      } catch (error) {
        inFlight.delete(controller);
        if (winner === controller) {
          finish(() => reject(error));
        } else if (!controller.signal.aborted && !winner) {
          // A stream that broke before its first token is just another failure.
          failures.push({ provider: provider.name, model, status: 0, kind: 'network' });
          launchNext();
        }
      }
    };

    launchNext();
  });
}

async function consumeStream(
  response: Response,
  onToken?: (t: string) => void,
  onEnd?: (t: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          const token = json.choices?.[0]?.delta?.content;
          if (typeof token === 'string' && token.length > 0) {
            fullText += token;
            onToken?.(token);
          }
        } catch {
          // Skip unparseable keep-alive/comment frames
        }
      }
    }
  } finally {
    // Release the upstream connection whether we finished, aborted, or errored.
    try {
      await reader.cancel();
    } catch {
      // Already released
    }
  }

  // Don't emit a partial result for an aborted stream.
  if (!signal?.aborted) {
    onEnd?.(fullText);
  }
  return fullText;
}
