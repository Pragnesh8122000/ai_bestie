import { z } from 'zod';

const traitSchema = z.object({
  directness: z.number().int().min(1).max(10).optional(),
  warmth: z.number().int().min(1).max(10).optional(),
  proactivity: z.number().int().min(1).max(10).optional(),
  depth: z.number().int().min(1).max(10).optional(),
  accountability: z.number().int().min(1).max(10).optional(),
});

export const createPersonaSchema = z.object({
  name: z.string().min(1, 'Name is required').max(30, 'Name must be 30 characters or less').trim(),
  archetype: z.enum(['mentor', 'friend', 'therapist', 'coach'], {
    errorMap: () => ({ message: 'Invalid archetype. Must be mentor, friend, therapist, or coach' }),
  }),
  avatarId: z.string().min(1, 'Avatar is required'),
  traits: traitSchema.optional(),
});

export const updatePersonaSchema = z.object({
  name: z.string().min(1).max(30).trim().optional(),
  avatarId: z.string().min(1).optional(),
  traits: traitSchema.optional(),
});

export type CreatePersonaInput = z.infer<typeof createPersonaSchema>;
export type UpdatePersonaInput = z.infer<typeof updatePersonaSchema>;