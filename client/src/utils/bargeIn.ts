const SUSTAINED_SINGLE_WORD_MS = 300;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

/**
 * Filters the two common false-positive barge-ins: a single unstable interim
 * token, and the recognizer transcribing the persona's own speaker output.
 */
export function createBargeInDetector(
  assistantText: () => string,
  now: () => number = () => performance.now(),
) {
  let firstCandidateAt: number | null = null;

  return (text: string, final = false): boolean => {
    const candidate = normalize(text);
    if (!candidate) {
      firstCandidateAt = null;
      return false;
    }

    const spokenByAssistant = normalize(assistantText());
    if (candidate.length >= 4 && spokenByAssistant.includes(candidate)) {
      firstCandidateAt = null;
      return false;
    }

    const words = candidate.split(/\s+/).filter(Boolean);
    if (final || words.length >= 2) return true;

    firstCandidateAt ??= now();
    return now() - firstCandidateAt >= SUSTAINED_SINGLE_WORD_MS;
  };
}
