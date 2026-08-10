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
}

interface Provider {
  name: string;
  url: string;
  apiKey: string;
  models: string[];
  // Extra request-body fields specific to this provider (merged into the payload).
  extraBody?: Record<string, unknown>;
  // Extra HTTP headers specific to this provider.
  extraHeaders?: Record<string, string>;
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

function buildProviders(): Provider[] {
  const providers: Provider[] = [];

  if (config.llm.geminiApiKey) {
    providers.push({
      name: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      apiKey: config.llm.geminiApiKey,
      models: [config.llm.geminiModel, ...config.llm.geminiFallbackModels],
      // Gemini 2.5/Flash are "thinking" models — without this they spend the token
      // budget on internal reasoning and the first visible token is delayed. "none"
      // gives direct, fast replies (ideal for simple chat).
      extraBody: { reasoning_effort: 'none' },
    });
  }

  if (config.llm.openrouterApiKey) {
    providers.push({
      name: 'openrouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: config.llm.openrouterApiKey,
      models: [config.llm.openrouterModel, ...config.llm.openrouterFallbackModels],
      // OpenRouter requests attribution headers for free-model routing/ranking.
      extraHeaders: {
        'HTTP-Referer': config.client.url,
        'X-Title': 'AI Bestie',
      },
    });
  }

  return providers;
}

async function openStream(
  url: string,
  apiKey: string,
  model: string,
  payload: Record<string, unknown>,
  extraBody?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ response: Response; ok: boolean; error: string; status: number }> {
  let response: Response | null = null;
  let lastError = '';
  let lastStatus = 0;

  for (let attempt = 0; attempt < RETRIES_PER_MODEL; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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

    if (response.ok && response.body) {
      return { response, ok: true, error: '', status: response.status };
    }

    lastStatus = response.status;
    lastError = await response.text().catch(() => '');
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === RETRIES_PER_MODEL - 1) {
      return { response: response!, ok: false, error: lastError, status: lastStatus };
    }
    try {
      await sleep(1000 * (attempt + 1), signal);
    } catch {
      return { response: response!, ok: false, error: lastError, status: lastStatus };
    }
  }

  return { response: response!, ok: false, error: lastError, status: lastStatus };
}

/**
 * Stream a chat completion, yielding tokens via onToken.
 * Tries Gemini first, then OpenRouter; within each, tries its model list.
 */
export async function streamChat(options: StreamOptions): Promise<string> {
  const { systemPrompt, messages, maxTokens = 1024, onToken, onEnd, signal } = options;

  const providers = buildProviders();
  if (providers.length === 0) {
    throw new Error(
      'No LLM key set. Add GEMINI_API_KEY (primary) and/or OPENROUTER_API_KEY to /.env or /server/.env',
    );
  }

  const payload = {
    stream: true,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  };

  const errors: string[] = [];
  let rateLimited = 0;
  for (const provider of providers) {
    for (const model of provider.models) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const key = `${provider.name}/${model}`;
      const cooldown = cooldownUntil.get(key);
      if (cooldown && cooldown > Date.now()) {
        rateLimited++;
        errors.push(`${key}: cooling down (rate-limited)`);
        continue;
      }
      const { response, ok, error, status } = await openStream(
        provider.url,
        provider.apiKey,
        model,
        payload,
        provider.extraBody,
        provider.extraHeaders,
        signal,
      );
      if (ok) {
        return consumeStream(response, onToken, onEnd, signal);
      }
      errors.push(`${key}: ${status} ${error.slice(0, 160)}`);
      if (status === 429) {
        rateLimited++;
        const retryAfter = response.headers.get('retry-after');
        let ms = DEFAULT_COOLDOWN_MS;
        if (retryAfter) {
          const secs = parseInt(retryAfter, 10);
          if (!Number.isNaN(secs)) ms = Math.min(Math.max(secs, 5), MAX_COOLDOWN_MS / 1000) * 1000;
        }
        cooldownUntil.set(key, Date.now() + ms);
      }
      // Only auth errors are truly provider-wide. A 400/404 is usually
      // model-specific (bad model id / unsupported param) — continue to the
      // next model rather than skipping the rest of this provider's list.
      if (status === 401 || status === 403) {
        break;
      }
    }
  }

  // If every attempt was a rate-limit (or cooldown skip), the shared free-tier
  // quota is exhausted — surface that distinctly so the caller can tell.
  if (rateLimited === errors.length && errors.length > 0) {
    throw new Error(`All LLM providers rate-limited. ${errors.join(' | ')}`);
  }
  throw new Error(`All LLM providers failed. ${errors.join(' | ')}`);
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