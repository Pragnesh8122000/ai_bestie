import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import ChatWindow from '../components/ChatWindow';
import ChatInput from '../components/ChatInput';
import ConversationList from '../components/ConversationList';
import VoiceOrb from '../components/VoiceOrb';

const DESKTOP_QUERY = '(min-width: 640px)';

export default function ChatPage() {
  const { user, logout } = useAuthStore();
  const openDefaultConversation = useChatStore((s) => s.openDefaultConversation);
  const abortStream = useChatStore((s) => s.abortStream);
  const hasConversation = useChatStore((s) => s.activeConversation !== null);
  const activeTitle = useChatStore((s) => s.activeConversation?.title);
  const ttsEnabled = useChatStore((s) => s.ttsEnabled);
  const toggleTts = useChatStore((s) => s.toggleTts);
  const isSidebarOpen = useChatStore((s) => s.isSidebarOpen);
  const setSidebarOpen = useChatStore((s) => s.setSidebarOpen);
  const error = useChatStore((s) => s.error);
  const clearError = useChatStore((s) => s.clearError);

  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Only auto-open if there's no conversation yet (avoids refetch + the
  // "connecting" flash on every route-away-and-back).
  useEffect(() => {
    if (!hasConversation) openDefaultConversation();
  }, [openDefaultConversation, hasConversation]);

  // Close the mobile drawer when the viewport crosses into desktop, otherwise
  // the body scroll lock below would survive with no visible way to release it.
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setSidebarOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [setSidebarOpen]);

  // Lock body scroll and wire Escape while the drawer is open.
  useEffect(() => {
    if (!isSidebarOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isSidebarOpen, setSidebarOpen]);

  // Move focus into the drawer on open and hand it back to the trigger on
  // close, so keyboard users aren't dropped at the top of the document.
  useEffect(() => {
    if (isSidebarOpen) {
      const timer = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
    // Only steal focus back if it's still loose in the body.
    if (document.activeElement === document.body) menuButtonRef.current?.focus();
  }, [isSidebarOpen]);

  // Auto-dismiss transient errors so the toast can't stack up or linger.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clearError, 5000);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  // Abort any in-flight stream when the page unmounts (navigation/logout) so
  // the server stops burning the free-tier LLM quota into a dead connection.
  useEffect(() => {
    return () => abortStream();
  }, [abortStream]);

  const handleLogout = () => {
    abortStream();
    logout();
  };

  const initial = (user?.name || 'T').charAt(0).toUpperCase();

  return (
    <div className="flex h-screen bg-ink">
      {/* Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line/60 bg-ink-2/60 sm:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <VoiceOrb state="idle" size={28} />
          <span className="font-display text-lg tracking-tight text-linen">AI Bestie</span>
        </div>

        <ConversationList />

        <div className="flex flex-col gap-3 border-t border-line/60 px-4 py-4">
          <div className="flex items-center justify-between rounded-2xl border border-line/60 bg-clay/20 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <WaveIcon active={ttsEnabled} />
              <div>
                <p className="font-sans text-sm text-linen">Voice mode</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-linen-dim">
                  {ttsEnabled ? 'On' : 'Off'}
                </p>
              </div>
            </div>
            <Switch checked={ttsEnabled} onChange={toggleTts} label="Toggle voice mode" />
          </div>

          <div className="flex items-center gap-3 rounded-2xl border border-line/60 px-3 py-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-ember to-ember-dim font-sans text-sm font-semibold text-ink">
              {initial}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-sans text-sm text-linen">{user?.name || 'Test User'}</p>
              <p className="truncate font-mono text-[10px] text-linen-dim">{user?.email}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile drawer — same list, slid over the page */}
      <AnimatePresence>
        {isSidebarOpen && (
          <>
            <motion.div
              key="scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setSidebarOpen(false)}
              className="fixed inset-0 z-40 bg-ink/70 backdrop-blur-sm sm:hidden"
              aria-hidden="true"
            />
            <motion.aside
              key="drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Conversations"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="fixed inset-y-0 left-0 z-50 flex w-[82vw] max-w-xs flex-col border-r border-line/60 bg-ink-2 sm:hidden"
            >
              <div className="flex items-center justify-between px-4 py-4">
                <div className="flex items-center gap-2.5">
                  <VoiceOrb state="idle" size={24} />
                  <span className="font-display text-base tracking-tight text-linen">AI Bestie</span>
                </div>
                <button
                  type="button"
                  ref={closeButtonRef}
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Close conversations"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-linen-dim transition-colors duration-150 hover:text-linen"
                >
                  <CloseIcon />
                </button>
              </div>

              <ConversationList />

              <div className="flex items-center gap-3 border-t border-line/60 px-4 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-ember to-ember-dim font-sans text-sm font-semibold text-ink">
                  {initial}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-sans text-sm text-linen">{user?.name || 'Test User'}</p>
                  <p className="truncate font-mono text-[10px] text-linen-dim">{user?.email}</p>
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Main column */}
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between gap-2 px-4 py-3 sm:px-8 sm:py-4">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              ref={menuButtonRef}
              onClick={() => setSidebarOpen(true)}
              aria-label="Open conversations"
              aria-expanded={isSidebarOpen}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-linen-dim transition-colors duration-150 hover:border-ember hover:text-ember sm:hidden"
            >
              <MenuIcon />
            </button>
            <h1 className="min-w-0 truncate font-display text-base text-linen" title={activeTitle}>
              {activeTitle || 'AI Bestie'}
            </h1>
          </div>

          <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={toggleTts}
            aria-pressed={ttsEnabled}
            className={`flex min-h-10 items-center gap-2 rounded-full border px-4 font-mono text-[11px] uppercase tracking-[0.18em] transition-all duration-150 active:scale-95 ${
              ttsEnabled
                ? 'border-ember/50 bg-ember/10 text-ember'
                : 'border-line text-linen-dim hover:text-linen'
            }`}
          >
            <WaveIcon active={ttsEnabled} small />
            Voice
          </button>

          <button
            type="button"
            disabled
            title="Personas — coming soon"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-line text-linen-dim opacity-50"
          >
            <PeopleIcon />
          </button>

          <button
            onClick={handleLogout}
            className="flex min-h-10 items-center rounded-full border border-line px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-linen-dim transition-all duration-150 hover:border-ember hover:text-ember active:scale-95"
          >
            Sign out
          </button>
          </div>
        </header>

        <main className="flex flex-1 flex-col overflow-hidden">
          <ChatWindow />
          <ChatInput />
        </main>
      </div>

      {/* Transient errors — the store sets these from every failed action */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            role="status"
            aria-live="polite"
            className="pointer-events-none fixed inset-x-0 bottom-28 z-[70] flex justify-center px-4 sm:bottom-32"
          >
            <button
              type="button"
              onClick={clearError}
              className="pointer-events-auto max-w-md rounded-2xl border border-ember/50 bg-ink-2/95 px-4 py-3 text-left font-sans text-sm text-linen shadow-2xl backdrop-blur-md transition-colors duration-150 hover:border-ember"
            >
              {error}
              <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em] text-linen-dim">
                dismiss
              </span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150 ${
        checked ? 'bg-ember' : 'bg-clay-2'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-linen transition-transform duration-150 ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function PeopleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function WaveIcon({ active, small }: { active: boolean; small?: boolean }) {
  const s = small ? 14 : 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" className={active ? 'text-ember' : ''}>
      <line x1="4" y1="9" x2="4" y2="15" />
      <line x1="9" y1="6" x2="9" y2="18" />
      <line x1="14" y1="3" x2="14" y2="21" />
      <line x1="19" y1="7" x2="19" y2="17" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}
