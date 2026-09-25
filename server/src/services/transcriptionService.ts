import { config } from '../config';
import { AppError } from '../utils/errors';

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/flac': 'flac',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
};

export const supportedTranscriptionMimeTypes = new Set(Object.keys(EXTENSION_BY_MIME));

export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!config.llm.openaiApiKey) {
    throw new AppError(
      'Server transcription is not configured. Ask the app owner to set OPENAI_API_KEY.',
      503,
      true,
      'TRANSCRIPTION_NOT_CONFIGURED',
    );
  }

  const extension = EXTENSION_BY_MIME[mimeType];
  if (!extension) {
    throw new AppError('Unsupported audio format.', 415, true, 'UNSUPPORTED_AUDIO');
  }

  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), `voice.${extension}`);
  form.append('model', config.transcription.model);
  form.append('language', 'en');

  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.llm.openaiApiKey}` },
      body: form,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AppError(
      'Transcription service is temporarily unavailable. Please try again.',
      502,
      true,
      'TRANSCRIPTION_UNAVAILABLE',
    );
  }

  if (!response.ok) {
    // Do not read or log the upstream body: it can contain provider internals
    // and adds no actionable information for the person speaking.
    throw new AppError(
      response.status === 429
        ? 'Transcription is busy right now. Please wait a minute and try again.'
        : 'Transcription service is temporarily unavailable. Please try again.',
      response.status === 429 ? 429 : 502,
      true,
      response.status === 429 ? 'TRANSCRIPTION_BUSY' : 'TRANSCRIPTION_UNAVAILABLE',
    );
  }

  const result = (await response.json()) as { text?: unknown };
  return typeof result.text === 'string' ? result.text.trim() : '';
}
