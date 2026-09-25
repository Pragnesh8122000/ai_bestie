export interface TranscriptionResult {
  text: string;
}

export async function transcribeVoiceClip(
  audio: Blob,
  durationMs: number,
  signal?: AbortSignal,
): Promise<TranscriptionResult> {
  const response = await fetch('/api/transcriptions', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': audio.type || 'audio/webm',
      'X-Audio-Duration-Ms': String(Math.ceil(durationMs)),
    },
    body: audio,
    signal,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message || 'Voice transcription failed. Please try again.');
  }

  const body = (await response.json()) as {
    success: boolean;
    data: TranscriptionResult;
  };
  return body.data;
}
