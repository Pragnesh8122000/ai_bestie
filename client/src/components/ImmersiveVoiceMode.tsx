import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useChatStore } from '../stores/chatStore';
import { usePersonaStore } from '../stores/personaStore';
import { setTtsLevelListener, stopSpeaking } from '../utils/speech';
import { startVoiceTurn, type VoiceTurnSession, type VoiceTurnTiming } from '../utils/voiceCapture';
import { createBargeInDetector } from '../utils/bargeIn';
import { TranscriptionRequestError } from '../api/transcription';
import MessageContent from './MessageContent';
import VoiceOrb from './VoiceOrb';

interface Props {
  onExit: () => void;
}

const STATE_LABEL = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
} as const;

export default function ImmersiveVoiceMode({ onExit }: Props) {
  const activeConversation = useChatStore((state) => state.activeConversation);
  const avatarState = useChatStore((state) => state.avatarState);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const streamingContent = useChatStore((state) => state.streamingContent);
  const chatError = useChatStore((state) => state.error);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const setTtsEnabled = useChatStore((state) => state.setTtsEnabled);
  const personas = usePersonaStore((state) => state.personas);
  const [muted, setMuted] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [turnPending, setTurnPending] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [ttsLevel, setTtsLevel] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionRef = useRef<VoiceTurnSession | null>(null);
  const endProbeRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const backRef = useRef<HTMLButtonElement>(null);

  const persona = personas.find((item) => item.id === activeConversation?.personaId);
  const orbState = isListening ? 'listening' : muted ? 'idle' : avatarState;
  const level = orbState === 'speaking' ? ttsLevel : orbState === 'listening' ? micLevel : 0;

  const exit = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    stopSpeaking();
    onExit();
  }, [onExit]);

  const toggleMute = useCallback(() => {
    setMuted((value) => {
      const next = !value;
      if (next) {
        sessionRef.current?.stop();
        sessionRef.current = null;
        setIsListening(false);
        setMicLevel(0);
      } else {
        setNotice(null);
        setCycle((current) => current + 1);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setTtsEnabled(true);
    setTtsLevelListener(setTtsLevel);
    const focusTimer = setTimeout(() => backRef.current?.focus(), 50);
    return () => {
      mountedRef.current = false;
      clearTimeout(focusTimer);
      sessionRef.current?.stop();
      sessionRef.current = null;
      setTtsLevelListener(null);
      setTtsEnabled(false);
    };
  }, [setTtsEnabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exit();
      if (event.key.toLowerCase() === 'm' && !event.metaKey && !event.ctrlKey) {
        toggleMute();
      }
      if (event.key.toLowerCase() === 't' && !event.metaKey && !event.ctrlKey) {
        setShowTranscript((value) => !value);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [exit, toggleMute]);

  // A barge-in probe lives exactly as long as the persona is speaking. Other
  // store updates mid-reply (the stream's `done`, a refreshed conversation)
  // must not tear it down. Declared before the turn effect so a probe that
  // ends here frees `sessionRef` before the idle listener is considered.
  useEffect(() => {
    if (avatarState === 'speaking') return;
    const endProbe = endProbeRef.current;
    endProbeRef.current = null;
    endProbe?.();
  }, [avatarState]);

  useEffect(() => {
    if (muted || turnPending || sessionRef.current || !activeConversation) return;

    // Two ways a turn can start: the normal handoff once the persona has
    // fully finished (idle, debounced so we don't clip the tail of its own
    // audio), or a barge-in probe while it's still talking — started with no
    // debounce so an interruption is caught as early as possible. The probe
    // stays silent (orb keeps showing "speaking") until real speech is
    // detected; only then do we interrupt.
    const canStartIdle = avatarState === 'idle' && !isStreaming;
    const isBargeIn = avatarState === 'speaking';
    if (!canStartIdle && !isBargeIn) return;

    let bargeAccepted = !isBargeIn;
    const timer = setTimeout(
      () => {
        if (!mountedRef.current || sessionRef.current) return;
        let voiceTiming: VoiceTurnTiming | undefined;
        if (!isBargeIn) setIsListening(true);

        const latestAssistantText = () => {
          const state = useChatStore.getState();
          if (state.streamingContent) return state.streamingContent;
          const messages = state.activeConversation?.messages ?? [];
          return (
            [...messages].reverse().find((message) => message.role === 'assistant')?.content ?? ''
          );
        };
        const bargeIn = createBargeInDetector(latestAssistantText, () => {
          if (!mountedRef.current || sessionRef.current !== session) return;
          bargeAccepted = true;
          // Speaking always takes priority: stop the persona's own audio and
          // the reply it's still generating, then keep listening on this same
          // recognition session so the words that triggered it aren't lost.
          useChatStore.getState().abortStream();
          setIsListening(true);
        });

        const session = startVoiceTurn(
          setMicLevel,
          undefined,
          isBargeIn ? (text) => bargeIn.hear(text) : undefined,
          !isBargeIn,
          (timing) => {
            voiceTiming = timing;
          },
        );
        sessionRef.current = session;
        if (isBargeIn) {
          endProbeRef.current = () => {
            bargeIn.cancel();
            if (bargeAccepted || sessionRef.current !== session) return;
            // The user started answering just as the persona finished: keep
            // the probe listening instead of dropping their first words. It is
            // still unconfirmed, so its final transcript must pass the filter.
            if (bargeIn.hasPendingSpeech()) {
              setIsListening(true);
              return;
            }
            sessionRef.current = null;
            session.stop();
          };
        }
        session.promise
          .then(async ({ transcript, usedServerFallback }) => {
            bargeIn.cancel();
            if (!mountedRef.current || sessionRef.current !== session) return;
            const rejected =
              Boolean(transcript) && isBargeIn && !bargeAccepted && !bargeIn.hear(transcript, true);
            sessionRef.current = null;
            setIsListening(false);
            setMicLevel(0);
            setNotice(
              usedServerFallback
                ? 'Brave fallback: audio was sent to OpenAI for transcription. API usage may be billed.'
                : null,
            );
            if (rejected) {
              setCycle((value) => value + 1);
              return;
            }
            if (transcript) {
              setTurnPending(true);
              await sendMessage(transcript, { voiceMode: true, voiceTiming });
              if (mountedRef.current) setTurnPending(false);
            }
            if (mountedRef.current) setCycle((value) => value + 1);
          })
          .catch((error) => {
            bargeIn.cancel();
            if (!mountedRef.current || sessionRef.current !== session) return;
            sessionRef.current = null;
            setIsListening(false);
            setMicLevel(0);
            // A silent barge-in probe failing (e.g. permission revoked mid-call)
            // must not surface as an error while the persona is mid-reply —
            // only report it if the user had actually started talking to us.
            if (bargeAccepted || !isBargeIn) {
              setNotice(
                error instanceof Error ? error.message : 'Voice input failed. Please try again.',
              );
              // An over-long clip was rejected before any metered call, so the
              // user can simply try again. Permission, device, and other
              // external-transcription failures need a deliberate retry:
              // reopening the microphone would loop permission prompts or
              // repeated metered API calls.
              if (error instanceof TranscriptionRequestError && error.status === 413) {
                setCycle((value) => value + 1);
              } else {
                setMuted(true);
              }
            } else if (mountedRef.current) {
              setCycle((value) => value + 1);
            }
          });
      },
      isBargeIn ? 0 : 450,
    );

    return () => clearTimeout(timer);
  }, [activeConversation, avatarState, cycle, isStreaming, muted, sendMessage, turnPending]);

  return (
    <main className="relative isolate flex h-[100dvh] min-h-[32rem] overflow-hidden bg-ink text-linen">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,rgba(240,164,92,0.14),transparent_38%),radial-gradient(circle_at_50%_110%,rgba(85,66,56,0.3),transparent_45%)]"
      />

      <button
        ref={backRef}
        type="button"
        onClick={exit}
        aria-label="Back to text chat"
        className="absolute left-4 top-4 z-30 flex min-h-11 items-center gap-2 rounded-full border border-line/70 bg-ink-2/75 px-4 font-mono text-[10px] uppercase tracking-[0.15em] text-linen-dim backdrop-blur transition-colors hover:border-ember hover:text-ember sm:left-7 sm:top-7"
      >
        <span aria-hidden="true">←</span>
        Back
      </button>

      <section
        className="relative z-10 flex min-w-0 flex-1 items-center justify-center px-5 pb-24 pt-20"
        aria-label={`Voice chat with ${persona?.name || 'your bestie'}`}
      >
        <div className="flex flex-col items-center">
          <VoiceOrb
            state={orbState}
            size={290}
            level={level}
            label={persona?.name || 'Your bestie'}
            showGlow
          />
          <p className="sr-only" aria-live="polite">
            {persona?.name || 'Your bestie'} is {STATE_LABEL[orbState].toLowerCase()}.
          </p>
          {(notice || chatError) && (
            <p
              role="status"
              className="mt-8 max-w-md text-center font-sans text-xs leading-5 text-linen-dim"
            >
              {notice || chatError}
            </p>
          )}
        </div>
      </section>

      <AnimatePresence>
        {showTranscript && (
          <motion.aside
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            role="region"
            aria-label="Voice chat transcript"
            className="absolute inset-x-4 bottom-24 top-20 z-20 min-w-0 overflow-y-auto rounded-[28px] border border-line/70 bg-ink-2/95 p-5 shadow-2xl backdrop-blur sm:inset-x-auto sm:right-7 sm:top-7 sm:w-[min(26rem,40vw)]"
          >
            <h2 className="mb-5 font-display text-2xl text-linen">Transcript</h2>
            <div className="space-y-4">
              {(activeConversation?.messages || []).map((message, index) => (
                <div key={message._id || index} className="min-w-0">
                  <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-linen-dim">
                    {message.role === 'user' ? 'You' : persona?.name || 'Bestie'}
                  </p>
                  {message.role === 'assistant' ? (
                    <MessageContent content={message.content} />
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-sm leading-6 text-linen">
                      {message.content}
                    </p>
                  )}
                </div>
              ))}
              {streamingContent && <MessageContent content={streamingContent} />}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      <div className="absolute inset-x-0 bottom-5 z-30 flex items-center justify-center gap-3 px-4 sm:bottom-8">
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={muted}
          className={`flex h-12 w-12 items-center justify-center rounded-full border backdrop-blur transition-colors ${
            muted
              ? 'border-ember bg-ember text-ink'
              : 'border-line bg-ink-2/80 text-linen hover:border-ember'
          }`}
        >
          <MicIcon muted={muted} />
        </button>
        <button
          type="button"
          onClick={() => setShowTranscript((value) => !value)}
          aria-label={showTranscript ? 'Hide transcript' : 'Show transcript'}
          aria-expanded={showTranscript}
          className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-ink-2/80 text-linen backdrop-blur transition-colors hover:border-ember hover:text-ember"
        >
          <TranscriptIcon />
        </button>
        <button
          type="button"
          onClick={exit}
          aria-label="End voice chat"
          className="flex h-12 min-w-20 items-center justify-center rounded-full bg-ember px-5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink transition-all hover:bg-ember-soft active:scale-95"
        >
          End
        </button>
      </div>
    </main>
  );
}

function MicIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 12 4.9" />
      <path d="M12 18v3" />
      {muted && <path d="m4 4 16 16" />}
    </svg>
  );
}

function TranscriptIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}
