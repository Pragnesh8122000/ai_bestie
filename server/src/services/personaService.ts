import { Persona, IPersona } from '../models/Persona';
import { archetypeConfigs } from '../data/archetypes';

/**
 * The single hard-coded character for the simple phase — a warm "Friend".
 * Find-or-create one for each user so the app opens straight into a chat.
 */
const DEFAULT_PERSONA = {
  name: 'Sam',
  archetype: 'friend' as const,
  avatarId: 'friend-male-01',
};

export async function ensureDefaultPersona(userId: string): Promise<IPersona> {
  const existing = await Persona.findOne({ userId, archetype: DEFAULT_PERSONA.archetype });
  if (existing) return existing;

  const friend = archetypeConfigs.friend;
  return Persona.create({
    userId,
    name: DEFAULT_PERSONA.name,
    archetype: DEFAULT_PERSONA.archetype,
    avatarId: DEFAULT_PERSONA.avatarId,
    traits: friend.defaultTraits,
  });
}

/**
 * Assemble the full 5-layer system prompt for a persona.
 *
 * Session context (the last 20 messages) is passed to the LLM via the
 * conversation messages array in chatService — not via the prompt — so there
 * is no separate memory-retrieval step here. The semantic/episodic memory
 * layers from an earlier design were removed; only session memory remains.
 */
export function assembleSystemPrompt(persona: IPersona): string {
  return persona.getSystemPrompt();
}

/**
 * Get archetype configuration
 */
export function getArchetypeConfig(archetype: string) {
  return archetypeConfigs[archetype as keyof typeof archetypeConfigs] ?? null;
}

/**
 * Get all available archetypes
 */
export function getArchetypes() {
  return Object.entries(archetypeConfigs).map(([key, config]) => ({
    type: key,
    displayName: config.displayName,
    corePurpose: config.corePurpose,
    defaultTraits: config.defaultTraits,
    traitRanges: config.traitRanges,
  }));
}