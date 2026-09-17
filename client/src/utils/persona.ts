import type { Archetype, Persona } from '../api/persona';

export function getArchetypeDisplayName(
  archetype: Persona['archetype'],
  archetypes: Archetype[],
): string {
  return archetypes.find((candidate) => candidate.type === archetype)?.displayName
    ?? `The ${archetype.charAt(0).toUpperCase()}${archetype.slice(1)}`;
}
