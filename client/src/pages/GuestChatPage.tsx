import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuthStore } from '../stores/authStore';
import { usePersonaStore } from '../stores/personaStore';
import VoiceOrb from '../components/VoiceOrb';
import { GUEST_SAMPLE_MESSAGES, GUEST_SAMPLE_PERSONA_NAME } from '../data/guestSample';

/**
 * Read-only preview shown to guests (no login). This page never calls any
 * write endpoint — the transcript is a frozen local sample, not live data,
 * and the only network call it makes is the public archetypes list. Chat
 * input, voice, and persona editing are all disabled here; even if a guest
 * bypassed this UI and hit the real APIs directly, every write route still
 * requires a `requireAuth` cookie server-side (see server/src/middleware/auth.ts),
 * so there is nothing this screen can do that the backend wouldn't already reject.
 */
export default function GuestChatPage() {
  const exitGuest = useAuthStore((s) => s.exitGuest);
  const { archetypes, fetchArchetypes } = usePersonaStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchArchetypes();
  }, [fetchArchetypes]);

  const handleLogin = () => {
    exitGuest();
    navigate('/login');
  };

  return (
    <div className="flex h-screen flex-col bg-ink">
      <header className="flex items-center justify-between gap-2 px-4 py-3 sm:px-8 sm:py-4">
        <div className="flex items-center gap-2.5">
          <VoiceOrb state="idle" size={28} />
          <span className="font-display text-lg tracking-tight text-linen">AI Bestie</span>
          <span className="rounded-full border border-line/70 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-linen-dim">
            Guest preview
          </span>
        </div>
        <button
          onClick={handleLogin}
          className="flex min-h-10 items-center rounded-full bg-gradient-to-br from-ember to-ember-soft px-5 font-mono text-[11px] uppercase tracking-[0.18em] text-ink transition-all duration-150 hover:brightness-105 active:scale-95"
        >
          Log in
        </button>
      </header>

      <main className="flex flex-1 flex-col overflow-y-auto px-4 pb-6 sm:px-8">
        <div className="flex flex-col items-center gap-3 pt-4 pb-6">
          <VoiceOrb state="idle" size={160} showGlow />
          <p className="font-display text-2xl font-semibold text-linen sm:text-3xl">
            {GUEST_SAMPLE_PERSONA_NAME}
          </p>
          <p className="max-w-sm text-center font-sans text-sm text-linen-dim">
            This is a sample conversation so you can see what talking to your bestie feels like.
          </p>
        </div>

        <div className="mx-auto w-full max-w-3xl space-y-5">
          {GUEST_SAMPLE_MESSAGES.map((msg, i) => {
            const isYou = msg.role === 'user';
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.04, ease: 'easeOut' }}
                className={`flex ${isYou ? 'justify-end' : 'justify-start'}`}
              >
                {isYou ? (
                  <div className="max-w-[72%] rounded-[18px] border border-line/40 bg-clay/50 px-4 py-2.5 sm:max-w-[65%]">
                    <span className="mb-1 block font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
                      {msg.time}
                    </span>
                    <p className="text-[15px] leading-[1.5] text-linen">{msg.content}</p>
                  </div>
                ) : (
                  <div className="max-w-[72%] border-l-2 border-ember/60 py-0.5 pl-4 sm:max-w-[65%]">
                    <div className="mb-1 flex items-baseline gap-2">
                      <span className="font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
                        {GUEST_SAMPLE_PERSONA_NAME.toLowerCase()}
                      </span>
                      <span className="font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
                        {msg.time}
                      </span>
                    </div>
                    <p className="text-[15px] leading-[1.5] text-linen">{msg.content}</p>
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>

        {archetypes.length > 0 && (
          <div className="mx-auto mt-10 w-full max-w-3xl">
            <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-linen-dim">
              Bestie personalities you can choose after signing in
            </p>
            <div className="flex flex-wrap gap-2">
              {archetypes.map((a) => (
                <span
                  key={a.type}
                  title={a.corePurpose}
                  className="rounded-full border border-line/60 bg-clay/20 px-4 py-2 font-sans text-sm text-linen-dim"
                >
                  {a.displayName}
                </span>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Disabled chat input — guests can look, not touch */}
      <div className="border-t border-line/60 px-4 py-4 sm:px-8">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
          <input
            type="text"
            disabled
            placeholder="Log in to chat with your bestie"
            className="h-14 flex-1 cursor-not-allowed rounded-2xl border border-line/60 bg-ink-2/50 px-5 text-base text-linen-dim/50 placeholder-linen-dim/50"
          />
          <button
            onClick={handleLogin}
            className="flex h-14 shrink-0 items-center rounded-full bg-gradient-to-br from-ember to-ember-soft px-6 font-sans text-base font-semibold text-ink shadow-xl shadow-ember/25 transition-all duration-150 hover:brightness-105 active:scale-95"
          >
            Log in to chat
          </button>
        </div>
        <p className="mx-auto mt-2 w-full max-w-3xl font-mono text-[10px] uppercase tracking-[0.14em] text-linen-dim/60">
          Voice replies are also log-in only
        </p>
      </div>
    </div>
  );
}
