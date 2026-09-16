import { create } from 'zustand';
import {
  personaApi,
  Persona,
  Archetype,
  CreatePersonaInput,
  UpdatePersonaInput,
} from '../api/persona';

interface PersonaState {
  personas: Persona[];
  activePersonaId: string | null;
  archetypes: Archetype[];
  isLoading: boolean;
  error: string | null;

  fetchArchetypes: () => Promise<void>;
  fetchPersonas: () => Promise<void>;
  createPersona: (data: CreatePersonaInput) => Promise<Persona>;
  updatePersona: (id: string, data: UpdatePersonaInput) => Promise<Persona>;
  deletePersona: (id: string) => Promise<void>;
  setActivePersona: (id: string) => void;
  upsertPersona: (persona: Persona) => void;
  clearError: () => void;
}

let personaSessionId = 0;

export const usePersonaStore = create<PersonaState>((set) => ({
  personas: [],
  activePersonaId: null,
  archetypes: [],
  isLoading: false,
  error: null,

  fetchArchetypes: async () => {
    try {
      const response = await personaApi.getArchetypes();
      set({ archetypes: response.data.data.archetypes });
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to fetch archetypes' });
    }
  },

  fetchPersonas: async () => {
    const session = personaSessionId;
    try {
      set({ isLoading: true, error: null });
      const response = await personaApi.list();
      if (session !== personaSessionId) return;
      const personas = response.data.data.personas;
      set((state) => ({
        personas,
        isLoading: false,
        activePersonaId: state.activePersonaId || personas[0]?.id || null,
      }));
    } catch (error: any) {
      if (session !== personaSessionId) return;
      set({ error: error.response?.data?.message || 'Failed to fetch personas', isLoading: false });
    }
  },

  createPersona: async (data: CreatePersonaInput) => {
    const session = personaSessionId;
    try {
      set({ isLoading: true, error: null });
      const response = await personaApi.create(data);
      const persona = response.data.data.persona;
      if (session !== personaSessionId) return persona;
      set((state) => ({
        personas: [...state.personas, persona],
        activePersonaId: persona.id,
        isLoading: false,
      }));
      return persona;
    } catch (error: any) {
      if (session !== personaSessionId) throw error;
      set({ error: error.response?.data?.message || 'Failed to create persona', isLoading: false });
      throw error;
    }
  },

  updatePersona: async (id: string, data: UpdatePersonaInput) => {
    const session = personaSessionId;
    try {
      set({ error: null });
      const response = await personaApi.update(id, data);
      const updated = response.data.data.persona;
      if (session !== personaSessionId) return updated;
      set((state) => ({
        personas: state.personas.map((p) => (p.id === id ? updated : p)),
      }));
      return updated;
    } catch (error: any) {
      if (session !== personaSessionId) throw error;
      set({ error: error.response?.data?.message || 'Failed to update persona' });
      throw error;
    }
  },

  deletePersona: async (id: string) => {
    const session = personaSessionId;
    try {
      await personaApi.delete(id);
      if (session !== personaSessionId) return;
      set((state) => ({
        personas: state.personas.filter((p) => p.id !== id),
        activePersonaId:
          state.activePersonaId === id
            ? state.personas.find((p) => p.id !== id)?.id || null
            : state.activePersonaId,
      }));
    } catch (error: any) {
      if (session !== personaSessionId) throw error;
      set({ error: error.response?.data?.message || 'Failed to delete persona' });
      throw error;
    }
  },

  setActivePersona: (id: string) => {
    set({ activePersonaId: id });
  },

  upsertPersona: (persona) => {
    set((state) => {
      const exists = state.personas.some((p) => p.id === persona.id);
      const personas = exists
        ? state.personas.map((p) => (p.id === persona.id ? persona : p))
        : [...state.personas, persona];
      return { personas, activePersonaId: state.activePersonaId || persona.id };
    });
  },

  clearError: () => set({ error: null }),
}));

export function resetPersonaSession(): void {
  ++personaSessionId;
  usePersonaStore.setState({ personas: [], activePersonaId: null, isLoading: false, error: null });
}
