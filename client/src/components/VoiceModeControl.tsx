import { useChatStore } from '../stores/chatStore';

interface Props {
  compact?: boolean;
  className?: string;
}

/**
 * One accessible visual contract for voice replies everywhere it appears.
 * State is conveyed by words, icon treatment, and switch position—not color.
 */
export default function VoiceModeControl({ compact = false, className = '' }: Props) {
  const enabled = useChatStore((state) => state.ttsEnabled);
  const toggle = useChatStore((state) => state.toggleTts);
  const stateLabel = enabled ? 'On' : 'Off';

  if (compact) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`Voice replies ${stateLabel.toLowerCase()}`}
        data-state={enabled ? 'on' : 'off'}
        onClick={toggle}
        className={`flex min-h-10 items-center gap-2 rounded-full border px-3 font-mono text-[10px] uppercase tracking-[0.15em] transition-all duration-150 active:scale-95 ${
          enabled
            ? 'border-ember/60 bg-ember/12 text-ember'
            : 'border-line bg-transparent text-linen-dim hover:text-linen'
        } ${className}`}
      >
        <VoiceIcon enabled={enabled} size={14} />
        <span>Voice · {stateLabel}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`Voice replies ${stateLabel.toLowerCase()}`}
      data-state={enabled ? 'on' : 'off'}
      onClick={toggle}
      className={`flex w-full items-center justify-between gap-3 rounded-2xl border px-3 py-3 text-left transition-all duration-150 active:scale-[0.99] ${
        enabled
          ? 'border-ember/60 bg-ember/10'
          : 'border-line/60 bg-transparent hover:border-line'
      } ${className}`}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${
            enabled
              ? 'border-ember/60 bg-ember/15 text-ember'
              : 'border-line bg-ink-2 text-linen-dim/60'
          }`}
        >
          <VoiceIcon enabled={enabled} size={17} />
        </span>
        <span className="min-w-0">
          <span className="block font-sans text-sm font-medium text-linen">Voice replies</span>
          <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-[0.12em] text-linen-dim">
            {enabled ? 'On · Replies play aloud' : 'Off · Replies are silent'}
          </span>
        </span>
      </span>

      <span
        aria-hidden="true"
        className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors duration-150 ${
          enabled ? 'border-ember bg-ember' : 'border-line bg-ink-2'
        }`}
      >
        <span
          data-testid="voice-switch-thumb"
          className={`absolute top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-linen text-[8px] font-bold text-ink shadow transition-transform duration-150 ${
            enabled ? 'translate-x-6' : 'translate-x-0.5'
          }`}
        >
          {enabled ? '✓' : '×'}
        </span>
      </span>
    </button>
  );
}

function VoiceIcon({ enabled, size }: { enabled: boolean; size: number }) {
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
      {enabled ? (
        <>
          <path d="M15 9.5a4 4 0 0 1 0 5" />
          <path d="M18 7a7 7 0 0 1 0 10" />
        </>
      ) : (
        <>
          <path d="m16 9 5 5" />
          <path d="m21 9-5 5" />
        </>
      )}
    </svg>
  );
}
