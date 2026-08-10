import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useChatStore } from '../stores/chatStore';
import { usePersonaStore } from '../stores/personaStore';
import VoiceOrb from './VoiceOrb';

const STATUS_LABEL: Record<'idle' | 'thinking' | 'speaking' | 'listening', string> = {
  idle: '· on the line ·',
  listening: '· listening ·',
  thinking: '· thinking ·',
  speaking: '· speaking ·',
};

const SUGGESTED_PROMPTS = [
  "What should I do tonight?",
  "I'm feeling stuck...",
  "Tell me something fun",
];

function clock(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

export default function ChatWindow() {
  const { activeConversation, avatarState, isStreaming, streamingContent, sendMessage } =
    useChatStore();
  const { personas } = usePersonaStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const persona = personas.find((p) => p.id === activeConversation?.personaId);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages, streamingContent]);

  if (!activeConversation) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-linen-dim">
          · connecting ·
        </p>
      </div>
    );
  }

  const messages = activeConversation.messages || [];
  const showEmpty = messages.length === 0 && !isStreaming;

  return (
    <div className="flex flex-1 flex-col">
      {/* Call stage — larger orb, more presence */}
      <div className="flex flex-col items-center gap-3 px-4 pt-6 pb-4 sm:pt-10 sm:pb-6">
        <VoiceOrb state={avatarState} size={220} showGlow />
        <div className="mt-3 text-center">
          <p className="font-display text-3xl font-semibold text-linen sm:text-4xl">
            {persona?.name || 'Sam'}
          </p>
          <p className="mt-2 font-mono text-[12px] uppercase tracking-[0.22em] text-linen-dim">
            {STATUS_LABEL[avatarState]}
          </p>
        </div>
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-8">
        {showEmpty && (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-6">
            <p className="max-w-sm text-center font-display text-lg italic text-linen-dim">
              Sam's here. Say something — out loud or typed.
            </p>
            <motion.div
              className="flex flex-wrap justify-center gap-2"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
            >
              {SUGGESTED_PROMPTS.map((s, i) => (
                <motion.button
                  key={s}
                  onClick={() => sendMessage(s)}
                  disabled={isStreaming}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: i * 0.1, duration: 0.3 }}
                  whileHover={{ scale: 1.05, borderColor: 'var(--color-ember)' }}
                  whileTap={{ scale: 0.98 }}
                  className="rounded-full border border-clay bg-clay/30 px-4 py-2 text-xs text-linen-dim transition-colors hover:text-ember disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
                >
                  {s}
                </motion.button>
              ))}
            </motion.div>
          </div>
        )}

        <div className="flex flex-1 flex-col items-center">
          <div className="w-full max-w-3xl space-y-5 px-4">
            {messages.map((msg, i) => {
              const isYou = msg.role === 'user';
              const time = clock(msg.timestamp);
              return (
                <motion.div
                  key={msg._id || i}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: 'easeOut' }}
                  className={`flex ${isYou ? 'justify-end' : 'justify-start'}`}
                >
                  {isYou ? (
                    <div className="max-w-[72%] rounded-[18px] border border-line/40 bg-clay/50 px-4 py-2.5 sm:max-w-[65%]">
                      <span className="mb-1 block font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
                        {time || 'you'}
                      </span>
                      <p className="text-[15px] leading-[1.5] text-linen">
                        {msg.content}
                      </p>
                    </div>
                  ) : (
                    <div className="max-w-[72%] border-l-2 border-ember/60 py-0.5 pl-4 sm:max-w-[65%]">
                      <div className="mb-1 flex items-baseline gap-2">
                        <span className="font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
                          {(persona?.name || 'sam').toLowerCase()}
                        </span>
                        <span className="font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
                          {time || 'now'}
                        </span>
                      </div>
                      <p className="text-[15px] leading-[1.5] text-linen">
                        {msg.content}
                      </p>
                    </div>
                  )}
                </motion.div>
              );
            })}

            {/* Live streaming turn */}
            {isStreaming && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
                className="flex justify-start"
              >
                <div className="max-w-[72%] border-l-2 border-ember/60 py-0.5 pl-4 sm:max-w-[65%]">
                  <div className="mb-1 flex items-baseline gap-2">
                    <span className="font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
                      {(persona?.name || 'sam').toLowerCase()}
                    </span>
                    <span className="font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
                      now
                    </span>
                  </div>
                  {streamingContent ? (
                    <p className="text-[15px] leading-[1.5] text-linen">
                      {streamingContent}
                      <span className="stream-caret" />
                    </p>
                  ) : (
                    <span className="typing-dots" aria-label="typing">
                      <span />
                      <span />
                      <span />
                    </span>
                  )}
                </div>
              </motion.div>
            )}
            <div ref={messagesEndRef} className="h-4" />
          </div>
        </div>
      </div>
    </div>
  );
}