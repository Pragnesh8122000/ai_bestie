/**
 * Last-line text normalization before Kokoro. The client already turns the
 * reply's Markdown into speakable text (client/src/utils/speechText.ts); this
 * repeats only the two fixes whose absence is audible and that any caller of
 * /api/tts could trip over. Both were measured against the real model:
 *
 *   "I'm here 😊"                          2.4s of audio (emoji name read out)
 *   "I'm here"                             0.8s
 *   "Check https://example.com/some/long/path?x=1 for details."   7.2s
 *   "Check the link for details."          1.5s
 *
 * Currency, percentages, times, "&" and "e.g." measured the same length as
 * their spelled-out forms, so they are left to the model rather than risk
 * changing meaning.
 */

const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/gi;
const EMOJI =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{200D}|\u{20E3}/gu;

function spokenHost(url: string): string {
  const host = url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#:]/)[0];
  return host || 'the link';
}

export function speakableText(text: string): string {
  return text
    .replace(BARE_URL, (url) => spokenHost(url))
    .replace(EMOJI, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
