import { describe, it, expect } from 'vitest';
import { Persona } from './Persona';
import { archetypeConfigs, ArchetypeType } from '../data/archetypes';

/**
 * The system prompt is assembled from five layers and is never exercised by a
 * route test, so a change to one layer can silently reshape every reply.
 *
 * These pin the parts that have downstream consequences — in particular the
 * formatting guidance, which exists because the client renders Markdown and
 * speaks replies aloud. Without it the model drifts into writing documentation
 * (headings, bullet walls) instead of talking, which reads badly on screen and
 * worse as speech.
 */
function promptFor(archetype: ArchetypeType): string {
  const persona = new Persona({
    userId: '000000000000000000000000',
    name: 'Sam',
    archetype,
    avatarId: 'a',
    traits: archetypeConfigs[archetype].defaultTraits,
  });
  return persona.getSystemPrompt();
}

const ARCHETYPES = Object.keys(archetypeConfigs) as ArchetypeType[];

describe('persona system prompt', () => {
  it.each(ARCHETYPES)('includes formatting guidance for %s', (archetype) => {
    const prompt = promptFor(archetype);
    expect(prompt).toContain('FORMATTING:');
  });

  it.each(ARCHETYPES)('keeps the archetype voice for %s', (archetype) => {
    // Formatting is appended to the voice layer; it must not replace it.
    const prompt = promptFor(archetype);
    expect(prompt).toContain(archetypeConfigs[archetype].voiceStyle);
  });

  it('tells the model to write like a person, not documentation', () => {
    const prompt = promptFor('friend');
    expect(prompt).toMatch(/like a person talking/i);
    expect(prompt).toMatch(/short conversational paragraphs/i);
  });

  it('restricts lists and headings rather than banning them', () => {
    // Lists still need to work — the renderer supports them, and a genuine
    // enumeration should use one. The guidance is about defaulting to prose.
    const prompt = promptFor('friend');
    expect(prompt).toMatch(/list only when/i);
    expect(prompt).toMatch(/headings unless/i);
  });

  it('tells the model not to open with a heading or list', () => {
    expect(promptFor('friend')).toMatch(/Never open with a heading or a list/i);
  });

  it('still contains the other prompt layers', () => {
    const prompt = promptFor('friend');
    expect(prompt).toContain('You are Sam');
    expect(prompt).toContain('RULE 1');
    expect(prompt).toContain('Directness');
    expect(prompt).toMatch(/Before responding/);
  });

  it('orders identity before voice before rules', () => {
    const prompt = promptFor('friend');
    expect(prompt.indexOf('You are Sam')).toBeLessThan(prompt.indexOf('FORMATTING:'));
    expect(prompt.indexOf('FORMATTING:')).toBeLessThan(prompt.indexOf('RULE 1'));
  });
});
