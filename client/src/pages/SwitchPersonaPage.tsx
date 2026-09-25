import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chatStore';
import { usePersonaStore } from '../stores/personaStore';
import { getArchetypeDisplayName } from '../utils/persona';

export default function SwitchPersonaPage() {
  const navigate = useNavigate();
  const personas = usePersonaStore((state) => state.personas);
  const archetypes = usePersonaStore((state) => state.archetypes);
  const isLoading = usePersonaStore((state) => state.isLoading);
  const loadError = usePersonaStore((state) => state.error);
  const fetchPersonas = usePersonaStore((state) => state.fetchPersonas);
  const fetchArchetypes = usePersonaStore((state) => state.fetchArchetypes);
  const openPersonaConversation = useChatStore((state) => state.openPersonaConversation);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([fetchPersonas(), fetchArchetypes()]);
  }, [fetchArchetypes, fetchPersonas]);

  const selectPersona = async (personaId: string) => {
    if (selectingId) return;
    setSelectingId(personaId);
    setSelectError(null);
    const conversationId = await openPersonaConversation(personaId);
    if (conversationId) {
      navigate('/', { replace: true });
      return;
    }
    setSelectError('Could not switch persona. Check your connection and try again.');
    setSelectingId(null);
  };

  return (
    <main className="min-h-screen bg-ink px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        <button
          type="button"
          onClick={() => navigate('/', { replace: true })}
          className="mb-10 min-h-11 rounded-full border border-line px-5 font-mono text-[11px] uppercase tracking-[0.16em] text-linen-dim transition-colors hover:border-ember hover:text-ember"
        >
          Back to chat
        </button>

        <header className="mb-9">
          <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-ember">
            Your besties
          </p>
          <h1 className="font-display text-4xl tracking-tight text-linen sm:text-5xl">
            Switch persona
          </h1>
          <p className="mt-3 max-w-xl font-sans text-sm leading-6 text-linen-dim sm:text-base">
            Pick one of your existing personas. We’ll return to their latest conversation, or open
            their first chat if you haven’t spoken yet.
          </p>
        </header>

        {(selectError || loadError) && (
          <p
            role="alert"
            className="mb-5 rounded-2xl border border-ember/40 bg-ember/10 px-5 py-4 text-sm text-ember-soft"
          >
            {selectError || loadError}
          </p>
        )}

        {isLoading && personas.length === 0 ? (
          <div className="grid gap-4 sm:grid-cols-2" aria-label="Loading personas">
            {[0, 1, 2, 3].map((item) => (
              <div key={item} className="h-32 animate-pulse rounded-[28px] bg-clay/25" />
            ))}
          </div>
        ) : personas.length === 0 ? (
          <section className="rounded-[28px] border border-line/70 bg-clay/20 p-8 text-center">
            <h2 className="font-display text-2xl text-linen">No personas available</h2>
            <p className="mt-2 text-sm leading-6 text-linen-dim">
              Persona creation is paused for this release. Your existing saved personas will appear
              here when available.
            </p>
          </section>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2" aria-label="Existing personas">
            {personas.map((persona, index) => {
              const isSelecting = selectingId === persona.id;
              return (
                <motion.button
                  key={persona.id}
                  type="button"
                  onClick={() => selectPersona(persona.id)}
                  disabled={selectingId !== null}
                  aria-label={`Switch to ${persona.name}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04, duration: 0.2 }}
                  className="group flex min-w-0 items-center gap-4 rounded-[28px] border border-line/70 bg-clay/20 p-4 text-left transition-all hover:border-ember/70 hover:bg-clay/35 disabled:cursor-wait disabled:opacity-50"
                >
                  <span className="h-24 w-24 shrink-0 overflow-hidden rounded-[22px] bg-clay/50">
                    <img
                      src={`/avatars/${persona.avatarId}.svg`}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-2xl text-linen group-hover:text-ember-soft">
                      {persona.name}
                    </span>
                    <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.16em] text-linen-dim">
                      {getArchetypeDisplayName(persona.archetype, archetypes)}
                    </span>
                    <span className="mt-4 block font-sans text-sm font-medium text-ember">
                      {isSelecting ? 'Opening…' : 'Continue conversation'}
                    </span>
                  </span>
                </motion.button>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
