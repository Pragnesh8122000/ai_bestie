import { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useChatStore } from '../stores/chatStore';
import { Conversation } from '../api/conversation';
import { formatRelative, DEFAULT_TITLE } from '../utils/conversation';
import ConfirmDialog from './ConfirmDialog';

export default function ConversationList() {
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const isLoadingList = useChatStore((s) => s.isLoadingList);
  const hasMore = useChatStore((s) => s.hasMoreConversations);
  const fetchConversations = useChatStore((s) => s.fetchConversations);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const setSidebarOpen = useChatStore((s) => s.setSidebarOpen);

  const [menuId, setMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // The list re-sorts whenever a reply lands, which would leave an open menu
  // floating over the wrong row. Close it on any change to the ordering.
  const order = conversations.map((c) => c.id).join(',');
  useEffect(() => {
    setMenuId(null);
  }, [order]);

  const handleNew = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      await startNewConversation();
    } finally {
      setIsCreating(false);
    }
  };

  const handleSelect = (id: string) => {
    switchConversation(id);
    setSidebarOpen(false);
  };

  const showSkeleton = isLoadingList && conversations.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4">
        <button
          type="button"
          onClick={handleNew}
          disabled={isCreating}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-ember/40 px-4 py-3 font-sans text-sm font-medium text-ember transition-colors duration-150 hover:bg-ember/10 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlusIcon />
          New Chat
        </button>
      </div>

      <p className="px-5 pt-5 pb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-linen-dim/60">
        Recent
      </p>

      <nav aria-label="Recent conversations" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {showSkeleton && (
          <div className="space-y-1.5 px-1" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-clay/30" />
            ))}
          </div>
        )}

        {!showSkeleton && conversations.length === 0 && (
          <p className="px-3 py-6 text-center font-sans text-xs leading-relaxed text-linen-dim/70">
            No conversations yet.
            <br />
            Start one above.
          </p>
        )}

        {conversations.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            isActive={conversation.id === activeConversationId}
            isEditing={editingId === conversation.id}
            isMenuOpen={menuId === conversation.id}
            onSelect={() => handleSelect(conversation.id)}
            onToggleMenu={() => setMenuId((id) => (id === conversation.id ? null : conversation.id))}
            onCloseMenu={() => setMenuId(null)}
            onStartRename={() => {
              setMenuId(null);
              setEditingId(conversation.id);
            }}
            onSubmitRename={(title) => {
              setEditingId(null);
              renameConversation(conversation.id, title);
            }}
            onCancelRename={() => setEditingId(null)}
            onRequestDelete={() => {
              setMenuId(null);
              setPendingDelete(conversation);
            }}
          />
        ))}

        {hasMore && !showSkeleton && (
          <button
            type="button"
            onClick={() => fetchConversations({ append: true })}
            disabled={isLoadingList}
            className="mt-2 w-full rounded-xl px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-linen-dim transition-colors duration-150 hover:text-ember disabled:opacity-50"
          >
            {isLoadingList ? 'Loading…' : 'Load more'}
          </button>
        )}
      </nav>

      <AnimatePresence>
        {pendingDelete && (
          <ConfirmDialog
            title="Delete conversation?"
            body={`"${truncate(pendingDelete.title, 40)}" and its messages will be removed. This can't be undone.`}
            onConfirm={() => {
              const id = pendingDelete.id;
              setPendingDelete(null);
              deleteConversation(id);
            }}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

interface RowProps {
  conversation: Conversation;
  isActive: boolean;
  isEditing: boolean;
  isMenuOpen: boolean;
  onSelect: () => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onStartRename: () => void;
  onSubmitRename: (title: string) => void;
  onCancelRename: () => void;
  onRequestDelete: () => void;
}

function ConversationRow({
  conversation,
  isActive,
  isEditing,
  isMenuOpen,
  onSelect,
  onToggleMenu,
  onCloseMenu,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onRequestDelete,
}: RowProps) {
  const isUntitled = conversation.title === DEFAULT_TITLE;
  const timestamp = formatRelative(conversation.lastMessageAt);

  if (isEditing) {
    return (
      <div className="px-1 py-0.5">
        <RenameInput
          initialValue={conversation.title}
          onSubmit={onSubmitRename}
          onCancel={onCancelRename}
        />
      </div>
    );
  }

  return (
    <div className="group relative px-1 py-0.5">
      <button
        type="button"
        onClick={onSelect}
        aria-current={isActive ? 'page' : undefined}
        title={conversation.title}
        className={`flex w-full items-start gap-2 rounded-xl border-l-2 py-2.5 pl-3 pr-9 text-left transition-colors duration-150 ${
          isActive
            ? 'border-ember bg-ember/10'
            : 'border-transparent hover:bg-clay/30'
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={`min-w-0 flex-1 truncate font-sans text-sm ${
                isActive ? 'text-ember' : 'text-linen'
              } ${isUntitled ? 'italic opacity-70' : ''}`}
            >
              {conversation.title}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-linen-dim/60">{timestamp}</span>
          </span>
          <span className="mt-0.5 block truncate font-sans text-xs text-linen-dim/70">
            {conversation.lastMessagePreview || 'No messages yet'}
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleMenu();
        }}
        aria-label={`Options for ${conversation.title}`}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        className={`absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-linen-dim transition-all duration-150 hover:bg-clay hover:text-linen focus:outline-none focus-visible:ring-2 focus-visible:ring-ember/60 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 ${
          isMenuOpen ? 'sm:opacity-100' : ''
        }`}
      >
        <DotsIcon />
      </button>

      {isMenuOpen && (
        <RowMenu onClose={onCloseMenu} onRename={onStartRename} onDelete={onRequestDelete} />
      )}
    </div>
  );
}

function RowMenu({
  onClose,
  onRename,
  onDelete,
}: {
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="absolute right-2 top-[calc(100%-6px)] z-30 w-36 overflow-hidden rounded-xl border border-line bg-ink-2 py-1 shadow-2xl"
    >
      <button
        type="button"
        role="menuitem"
        onClick={onRename}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left font-sans text-sm text-linen transition-colors duration-150 hover:bg-clay/50"
      >
        <PencilIcon />
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left font-sans text-sm text-red-300 transition-colors duration-150 hover:bg-red-500/10"
      >
        <TrashIcon />
        Delete
      </button>
    </div>
  );
}

function RenameInput({
  initialValue,
  onSubmit,
  onCancel,
}: {
  initialValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);
  // Escape must not also fire the blur handler's submit.
  const cancelled = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const submit = () => {
    if (cancelled.current) return;
    const next = value.trim();
    if (!next || next === initialValue) {
      onCancel();
      return;
    }
    onSubmit(next);
  };

  return (
    <input
      ref={ref}
      value={value}
      maxLength={100}
      onChange={(e) => setValue(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelled.current = true;
          onCancel();
        }
      }}
      aria-label="Conversation title"
      className="w-full rounded-xl border border-ember/50 bg-clay/40 px-3 py-2.5 font-sans text-sm text-linen focus:border-ember focus:outline-none"
    />
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

function DotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}
