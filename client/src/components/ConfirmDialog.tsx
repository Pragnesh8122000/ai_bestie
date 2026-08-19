import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Small destructive-action modal. Focus starts on Cancel (the safe choice),
 * Escape cancels, and Tab is trapped between the two buttons.
 */
export default function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;

      // Two focusable elements — cycle between them manually.
      const active = document.activeElement;
      e.preventDefault();
      if (e.shiftKey) {
        (active === cancelRef.current ? confirmRef : cancelRef).current?.focus();
      } else {
        (active === confirmRef.current ? cancelRef : confirmRef).current?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="absolute inset-0 bg-ink/80 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <motion.div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="relative w-full max-w-sm rounded-2xl border border-line bg-ink-2 p-6 shadow-2xl"
      >
        <h2 id="confirm-title" className="font-display text-lg text-linen">
          {title}
        </h2>
        <p id="confirm-body" className="mt-2 font-sans text-sm leading-relaxed text-linen-dim">
          {body}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="min-h-10 rounded-full border border-line px-4 font-sans text-sm text-linen-dim transition-colors duration-150 hover:text-linen focus:outline-none focus-visible:ring-2 focus-visible:ring-ember/60"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="min-h-10 rounded-full border border-red-500/50 bg-red-500/10 px-4 font-sans text-sm font-medium text-red-300 transition-colors duration-150 hover:bg-red-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
