export interface TranscriptionResult {
  text: string;
}

export class TranscriptionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TranscriptionRequestError';
  }
}

export async function transcribeVoiceClip(
  audio: Blob,
  durationMs: number,
  signal?: AbortSignal,
  turnId?: string,
): Promise<TranscriptionResult> {
  const response = await fetch('/api/transcriptions', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': audio.type || 'audio/webm',
      'X-Audio-Duration-Ms': String(Math.ceil(durationMs)),
      ...(turnId ? { 'X-Voice-Turn': turnId } : {}),
    },
    body: audio,
    signal,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new TranscriptionRequestError(
      body?.message || 'Voice transcription failed. Please try again.',
      response.status,
    );
  }

  const body = (await response.json()) as {
    success: boolean;
    data: TranscriptionResult;
  };
  return body.data;
}
