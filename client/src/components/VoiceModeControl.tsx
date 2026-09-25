interface Props {
  compact?: boolean;
  className?: string;
  onStart: () => void;
}

/** Entry point into the immersive, orb-first voice conversation. */
export default function VoiceModeControl({ compact = false, className = '', onStart }: Props) {
  if (compact) {
    return (
      <button
        type="button"
        onClick={onStart}
        aria-label="Start voice chat"
        className={`flex min-h-10 items-center gap-2 rounded-full border border-ember/50 bg-ember/10 px-3 font-mono text-[10px] uppercase tracking-[0.15em] text-ember transition-all hover:bg-ember/15 active:scale-95 ${className}`}
      >
        <VoiceIcon size={14} />
        <span>Voice chat</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onStart}
      aria-label="Start voice chat"
      className={`flex w-full items-center justify-between gap-3 rounded-2xl border border-ember/40 bg-ember/8 px-3 py-3 text-left transition-all hover:border-ember/70 hover:bg-ember/12 active:scale-[0.99] ${className}`}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-ember/50 bg-ember/15 text-ember">
          <VoiceIcon size={17} />
        </span>
        <span className="min-w-0">
          <span className="block font-sans text-sm font-medium text-linen">Voice chat</span>
          <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-[0.12em] text-linen-dim">
            Open immersive conversation
          </span>
        </span>
      </span>
      <span aria-hidden="true" className="pr-1 font-sans text-lg text-ember">
        →
      </span>
    </button>
  );
}

function VoiceIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M15 9.5a4 4 0 0 1 0 5" />
      <path d="M18 7a7 7 0 0 1 0 10" />
    </svg>
  );
}
