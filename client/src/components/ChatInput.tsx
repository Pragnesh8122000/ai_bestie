import { useState, FormEvent, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useChatStore } from '../stores/chatStore';
import { usePersonaStore } from '../stores/personaStore';
import { listenOnce, isSTTSupported, stopSpeaking } from '../utils/speech';

export default function ChatInput() {
  const [message, setMessage] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [interim, setInterim] = useState('');
  const [micError, setMicError] = useState<string | null>(null);
  const { sendMessage, isStreaming, activeConversation, isLoadingConversation } = useChatStore();
  // Switching conversations tears down `activeConversation` while the next one
  // loads — block input rather than let a send silently no-op.
  const isBusy = isStreaming || isLoadingConversation || !activeConversation;
  const { personas } = usePersonaStore();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sttSupported = isSTTSupported();
  const bestieName = personas.find((p) => p.id === activeConversation?.personaId)?.name || 'your bestie';

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
    }
  }, [message]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!message.trim() || isBusy) return;
    const msg = message;
    setMessage('');
    await sendMessage(msg);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleMic = async () => {
    if (isRecording || isBusy || !sttSupported) return;
    // Stop any in-progress TTS first so Sam's synthesized voice doesn't feed
    // back into the mic (echo loop).
    stopSpeaking();
    setInterim('');
    setMicError(null);
    setIsRecording(true);
    try {
      const transcript = await listenOnce('en-US', (text) => setInterim(text));
      if (transcript) {
        setMessage((prev) => (prev ? `${prev} ${transcript}` : transcript));
        inputRef.current?.focus();
      }
    } catch (err) {
      console.error('Speech recognition failed:', err);
      const code = err instanceof Error ? err.message : '';
      // Brave ships the webkitSpeechRecognition constructor but disables the
      // Google backend that powers it, so every attempt fails with a
      // "network" error even with mic permission granted and online. Chrome
      // and Edge use the same backend and work fine; Safari uses its own.
      if (code === 'network') {
        setMicError(
          'Voice typing isn\u2019t available in this browser (it blocks the speech service). Try Chrome, Edge, or Safari \u2014 or just type.'
        );
      } else if (code === 'not-allowed' || code === 'service-not-allowed') {
        setMicError('Mic access is blocked. Allow microphone access for this site and try again.');
      } else if (code === 'no-speech') {
        setMicError('Didn\u2019t catch that \u2014 try again.');
      } else {
        setMicError('Voice typing failed. Try again or type instead.');
      }
    } finally {
      setInterim('');
      setIsRecording(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="sticky bottom-4 z-20 px-3 sm:bottom-6 sm:px-8"
    >
      <div className="mx-auto flex w-full max-w-2xl items-end gap-2 rounded-[32px] border border-ember/25 bg-ink-2/90 p-2 shadow-2xl backdrop-blur-md transition-shadow duration-200 focus-within:border-ember/50 focus-within:shadow-[0_0_0_1px_var(--color-ember-glow),0_20px_50px_-15px_rgba(0,0,0,0.6)] sm:gap-3 sm:p-2.5">
        {/* Talk — larger, more prominent */}
        {sttSupported && (
          <motion.button
            type="button"
            onClick={handleMic}
            disabled={isBusy || isRecording}
            title={isRecording ? 'Listening…' : `Talk to ${bestieName}`}
            aria-label={isRecording ? 'Listening' : `Talk to ${bestieName}`}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full border transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 sm:h-14 sm:w-14 ${
              isRecording
                ? 'talk-pulse border-ember bg-ember/15 text-ember'
                : 'border-line bg-clay/60 text-ember hover:border-ember hover:bg-clay-2 active:bg-clay-2'
            }`}
          >
            <MicIcon active={isRecording} />
          </motion.button>
        )}

        {/* Type */}
        <textarea
          ref={inputRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isLoadingConversation
              ? 'Loading…'
              : isRecording
                ? interim || 'Listening…'
                : `or type to ${bestieName}…`
          }
          disabled={isBusy}
          rows={1}
          className="flex-1 resize-none rounded-[20px] border border-line bg-clay/40 px-4 py-3 text-[15px] leading-snug text-linen placeholder-linen-dim/60 transition-colors duration-150 focus:border-ember focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />

        {/* Send — gradient, bold */}
        <motion.button
          type="submit"
          disabled={!message.trim() || isBusy}
          whileHover={{ scale: 1.05, y: -2 }}
          whileTap={{ scale: 0.95 }}
          className="flex h-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-ember to-ember-soft px-6 font-sans text-sm font-semibold text-ink transition-all duration-150 hover:brightness-105 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
        >
          {isStreaming ? (
            <motion.span
              className="h-4 w-4 rounded-full border-2 border-ink border-t-transparent"
              animate={{ rotate: 360 }}
              transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
            />
          ) : (
            'Send'
          )}
        </motion.button>
      </div>
      {!sttSupported && (
        <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-linen-dim/70">
          voice needs chrome or safari · typing works everywhere
        </p>
      )}
      {sttSupported && micError && (
        <p className="mx-auto mt-2 max-w-2xl px-1 text-center font-sans text-xs text-ember-soft">
          {micError}
        </p>
      )}
    </form>
  );
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2.5 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  );
}