const SUSTAINED_SINGLE_WORD_MS = 300;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

export interface BargeInDetector {
  /** Feed the probe's latest transcript; returns true once barge-in is accepted. */
  hear: (text: string, final?: boolean) => boolean;
  /** True when the last text heard was user speech still waiting to persist. */
  hasPendingSpeech: () => boolean;
  /** Cancel the pending single-word re-check. */
  cancel: () => void;
}

/**
 * Filters the two common false-positive barge-ins: a single unstable interim
 * token, and the recognizer transcribing the persona's own speaker output.
 * Short words count as echo only when they end the reply, where the tail of
 * the persona's audio overlaps the user's turn.
 * A lone word is re-checked on a timer, so it is accepted once it persists
 * even when the recognizer emits no further results.
 */
export function createBargeInDetector(
  assistantText: () => string,
  onAccept: () => void,
  now: () => number = () => performance.now(),
): BargeInDetector {
  let firstCandidateAt: number | null = null;
  let accepted = false;
  let recheck: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (recheck) clearTimeout(recheck);
    recheck = null;
  };

  const accept = () => {
    accepted = true;
    firstCandidateAt = null;
    onAccept();
    return true;
  };

  const hear = (text: string, final = false): boolean => {
    if (accepted) return true;
    cancel();
    const candidate = normalize(text);
    if (!candidate) {
      firstCandidateAt = null;
      return false;
    }

    const spokenByAssistant = ` ${normalize(assistantText())} `;
    const isEcho =
      spokenByAssistant.includes(` ${candidate} `) &&
      (candidate.length >= 4 || spokenByAssistant.endsWith(` ${candidate} `));
    if (isEcho) {
      firstCandidateAt = null;
      return false;
    }

    const words = candidate.split(/\s+/).filter(Boolean);
    if (final || words.length >= 2) return accept();

    firstCandidateAt ??= now();
    const heldMs = now() - firstCandidateAt;
    if (heldMs >= SUSTAINED_SINGLE_WORD_MS) return accept();
    recheck = setTimeout(() => hear(text), SUSTAINED_SINGLE_WORD_MS - heldMs);
    return false;
  };

  return {
    hear,
    hasPendingSpeech: () => !accepted && firstCandidateAt !== null,
    cancel,
  };
}
