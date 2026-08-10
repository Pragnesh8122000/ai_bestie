import apiClient from './client';

export interface Persona {
  id: string;
  name: string;
  archetype: 'mentor' | 'friend' | 'therapist' | 'coach';
  avatarId: string;
  traits: {
    directness: number;
    warmth: number;
    proactivity: number;
    depth: number;
    accountability: number;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface Archetype {
  type: string;
  displayName: string;
  corePurpose: string;
  defaultTraits: Record<string, number>;
  traitRanges: Record<string, { min: number; max: number }>;
}

interface PersonaResponse {
  success: boolean;
  data: {
    persona: Persona;
  };
}

interface PersonasResponse {
  success: boolean;
  data: {
    personas: Persona[];
  };
}

interface ArchetypesResponse {
  success: boolean;
  data: {
    archetypes: Archetype[];
  };
}

export interface CreatePersonaInput {
  name: string;
  archetype: 'mentor' | 'friend' | 'therapist' | 'coach';
  avatarId: string;
  traits?: Partial<Record<'directness' | 'warmth' | 'proactivity' | 'depth' | 'accountability', number>>;
}

export interface UpdatePersonaInput {
  name?: string;
  avatarId?: string;
  traits?: Partial<Record<'directness' | 'warmth' | 'proactivity' | 'depth' | 'accountability', number>>;
}

export const personaApi = {
  getArchetypes: () =>
    apiClient.get<ArchetypesResponse>('/personas/archetypes'),

  list: () =>
    apiClient.get<PersonasResponse>('/personas'),

  get: (id: string) =>
    apiClient.get<PersonaResponse>(`/personas/${id}`),

  create: (data: CreatePersonaInput) =>
    apiClient.post<PersonaResponse>('/personas', data),

  update: (id: string, data: UpdatePersonaInput) =>
    apiClient.patch<PersonaResponse>(`/personas/${id}`, data),

  delete: (id: string) =>
    apiClient.delete<{ success: boolean; message: string }>(`/personas/${id}`),
};