import { z } from 'zod';

const traitSchema = z.object({
  directness: z.number().int().min(1).max(10).optional(),
  warmth: z.number().int().min(1).max(10).optional(),
  proactivity: z.number().int().min(1).max(10).optional(),
  depth: z.number().int().min(1).max(10).optional(),
  accountability: z.number().int().min(1).max(10).optional(),
});

export const updatePersonaSchema = z.object({
  name: z.string().min(1).max(30).trim().optional(),
  avatarId: z.string().min(1).optional(),
  traits: traitSchema.optional(),
});

export type UpdatePersonaInput = z.infer<typeof updatePersonaSchema>;
