import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { avatarApi, Avatar } from '../api/avatar';
import { usePersonaStore } from '../stores/personaStore';
import { getArchetypeDisplayName } from '../utils/persona';

export default function CreatePersonaPage() {
  const navigate = useNavigate();
  const createPersona = usePersonaStore((s) => s.createPersona);
  const archetypes = usePersonaStore((s) => s.archetypes);
  const fetchArchetypes = usePersonaStore((s) => s.fetchArchetypes);

  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [isLoadingAvatars, setIsLoadingAvatars] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedAvatarId, setSelectedAvatarId] = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    avatarApi
      .list()
      .then((response) => {
        if (cancelled) return;
        setAvatars(response.data.data.avatars);
        setIsLoadingAvatars(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError('Could not load avatars. Please reload.');
        setIsLoadingAvatars(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    fetchArchetypes();
  }, [fetchArchetypes]);

  const getArchetypeLabel = (category: Avatar['category']) =>
    getArchetypeDisplayName(category, archetypes);

  const categoryOrder = Array.from(new Set(avatars.map((a) => a.category)));
  const avatarsByCategory = categoryOrder.map((category) => ({
    category,
    label: getArchetypeLabel(category),
    avatars: avatars.filter((a) => a.category === category),
  }));

  const selectedAvatar = avatars.find((a) => a.id === selectedAvatarId) ?? null;

  const handleSelect = (avatar: Avatar) => {
    setSelectedAvatarId(avatar.id);
    setIsDrawerOpen(false);
    setName(avatar.name);
    setCreateError(null);
  };

  const handleCreate = async () => {
    if (!selectedAvatar || isCreating) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      await createPersona({
        name: name.trim() || selectedAvatar.name,
        archetype: selectedAvatar.category,
        avatarId: selectedAvatar.id,
      });
      navigate('/');
    } catch (error: any) {
      setCreateError(error.response?.data?.message || 'Failed to create persona');
      setIsCreating(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center px-6 py-12 sm:py-16">
      <div className="mb-10 flex flex-col items-center gap-3 text-center">
        <h1 className="font-display text-3xl tracking-tight text-linen sm:text-4xl">
          Meet your bestie
        </h1>
        <p className="font-mono text-[12px] uppercase tracking-[0.2em] text-linen-dim/70">
          · pick a face to get started ·
        </p>
      </div>

      <div className="w-full max-w-2xl">
        {isLoadingAvatars && (
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4" aria-hidden="true">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="aspect-square animate-pulse rounded-3xl bg-clay/30" />
            ))}
          </div>
        )}

        {loadError && (
          <p className="rounded-2xl border border-ember/40 bg-ember/10 px-5 py-4 text-center font-sans text-sm text-ember-soft">
            {loadError}
          </p>
        )}

        {!isLoadingAvatars && !loadError && (
          <div role="radiogroup" aria-label="Choose an avatar" className="space-y-8">
            {avatarsByCategory.map(({ category, label, avatars: categoryAvatars }) => (
              <div key={category}>
                <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-linen-dim">
                  {label}
                </h2>
                <div className="grid grid-cols-3 gap-4 sm:grid-cols-4">
                  {categoryAvatars.map((avatar) => {
                    const isSelected = avatar.id === selectedAvatarId;
                    return (
                      <button
                        key={avatar.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => handleSelect(avatar)}
                        className={`group flex flex-col items-center gap-2 rounded-3xl border p-3 transition-all duration-150 active:scale-95 ${
                          isSelected
                            ? 'border-ember bg-ember/10 shadow-lg shadow-ember/10'
                            : 'border-line/60 hover:border-line hover:bg-clay/20'
                        }`}
                      >
                        <span className="aspect-square w-full overflow-hidden rounded-2xl bg-clay/40">
                          <img
                            src={avatar.src}
                            alt=""
                            className="h-full w-full object-cover"
                            draggable={false}
                          />
                        </span>
                        <span
                          className={`truncate font-sans text-xs font-medium ${
                            isSelected ? 'text-ember' : 'text-linen-dim'
                          }`}
                        >
                          {avatar.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {selectedAvatar && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="mt-8 rounded-[32px] border border-line/70 bg-clay/25 p-6 backdrop-blur-sm"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="font-sans text-sm text-linen-dim">Creating</p>
                <p className="truncate font-display text-xl text-linen">
                  {name || selectedAvatar.name}
                </p>
                <span className="mt-1 inline-block rounded-full border border-line/60 bg-clay/20 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-linen-dim">
                  {getArchetypeLabel(selectedAvatar.category)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsDrawerOpen((open) => !open)}
                aria-expanded={isDrawerOpen}
                className="shrink-0 font-mono text-[11px] uppercase tracking-[0.16em] text-linen-dim transition-colors duration-150 hover:text-ember"
              >
                {isDrawerOpen ? 'Cancel' : 'Rename'}
              </button>
            </div>

            {isDrawerOpen && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                transition={{ duration: 0.15 }}
                className="mt-5"
              >
                <label htmlFor="persona-name" className="mb-2 block font-sans text-sm text-linen">
                  Name
                </label>
                <input
                  id="persona-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={30}
                  autoFocus
                  placeholder={selectedAvatar.name}
                  className="w-full rounded-2xl border border-line/70 bg-ink-2/80 px-5 py-3.5 text-[16px] text-linen placeholder-linen-dim/40 transition-colors duration-150 hover:border-line focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/30"
                />
              </motion.div>
            )}

            {createError && (
              <p className="mt-4 rounded-xl border border-ember/40 bg-ember/10 px-4 py-3 font-sans text-sm text-ember-soft">
                {createError}
              </p>
            )}

            <motion.button
              type="button"
              onClick={handleCreate}
              disabled={isCreating}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.98 }}
              className="mt-6 w-full rounded-full bg-gradient-to-br from-ember to-ember-soft px-6 py-4 font-sans text-[15px] font-semibold text-ink shadow-xl shadow-ember/25 transition-all duration-150 hover:brightness-105 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreating ? 'Creating…' : 'Create'}
            </motion.button>
          </motion.div>
        )}
      </div>
    </div>
  );
}
