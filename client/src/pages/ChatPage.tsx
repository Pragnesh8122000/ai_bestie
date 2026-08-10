import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import ChatWindow from '../components/ChatWindow';
import ChatInput from '../components/ChatInput';
import VoiceOrb from '../components/VoiceOrb';

export default function ChatPage() {
  const { user, logout } = useAuthStore();
  const openDefaultConversation = useChatStore((s) => s.openDefaultConversation);
  const abortStream = useChatStore((s) => s.abortStream);
  const hasConversation = useChatStore((s) => s.activeConversation !== null);
  const ttsEnabled = useChatStore((s) => s.ttsEnabled);
  const toggleTts = useChatStore((s) => s.toggleTts);

  // Only auto-open if there's no conversation yet (avoids refetch + the
  // "connecting" flash on every route-away-and-back).
  useEffect(() => {
    if (!hasConversation) openDefaultConversation();
  }, [openDefaultConversation, hasConversation]);

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

        <div className="px-4">
          <button
            type="button"
            onClick={() => openDefaultConversation()}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-ember/40 px-4 py-3 font-sans text-sm font-medium text-ember transition-colors duration-150 hover:bg-ember/10 active:scale-[0.98]"
          >
            <PlusIcon />
            New Chat
          </button>
        </div>

        <nav className="mt-6 flex flex-col gap-1 px-3">
          <NavItem icon={<ChatIcon />} label="Chats" active />
          <NavItem icon={<HeartIcon />} label="Memory" />
          <NavItem icon={<UserIcon />} label="Profile" />
          <NavItem icon={<GearIcon />} label="Settings" />
        </nav>

        <div className="mt-auto flex flex-col gap-3 border-t border-line/60 px-4 py-4">
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

      {/* Main column */}
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-end gap-2 px-4 py-3 sm:px-8 sm:py-4">
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
        </header>

        <main className="flex flex-1 flex-col overflow-hidden">
          <ChatWindow />
          <ChatInput />
        </main>
      </div>
    </div>
  );
}

function NavItem({ icon, label, active }: { icon: React.ReactNode; label: string; active?: boolean }) {
  return (
    <button
      type="button"
      disabled={!active}
      title={active ? undefined : `${label} — coming soon`}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 font-sans text-sm transition-colors duration-150 ${
        active
          ? 'bg-ember/10 text-ember'
          : 'text-linen-dim opacity-60'
      }`}
    >
      {icon}
      {label}
    </button>
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

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
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
