import apiClient from './client';

export interface Conversation {
  id: string;
  title: string;
  personaId: string;
  avatarId: string;
  lastMessageAt: string;
  createdAt: string;
}

export interface Message {
  _id?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ConversationsResponse {
  success: boolean;
  data: { conversations: Conversation[] };
}

interface ConversationDetailResponse {
  success: boolean;
  data: {
    conversation: Conversation & { messages: Message[] };
  };
}

interface DefaultConversationResponse {
  success: boolean;
  data: {
    conversation: Conversation & { messages: Message[] };
    persona: {
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
    };
  };
}

interface CreateConversationInput {
  personaId: string;
  avatarId: string;
  title?: string;
}

export const conversationApi = {
  list: () =>
    apiClient.get<ConversationsResponse>('/conversations'),

  getDefault: () =>
    apiClient.get<DefaultConversationResponse>('/conversations/default'),

  get: (id: string) =>
    apiClient.get<ConversationDetailResponse>(`/conversations/${id}`),

  create: (data: CreateConversationInput) =>
    apiClient.post<{ success: boolean; data: { conversation: Conversation } }>('/conversations', data),

  delete: (id: string) =>
    apiClient.delete<{ success: boolean; message: string }>(`/conversations/${id}`),

  /**
   * POST the message and return a fetch Response whose body is a ReadableStream
   * of SSE-formatted chunks (`data: { type, ... }`). Not an EventSource — there
   * is no auto-reconnect; the caller must parse the stream and abort it (via
   * `signal`) on unmount or when starting a new message.
   */
  streamMessage: (conversationId: string, message: string, signal?: AbortSignal) => {
    return fetch(`/api/conversations/${conversationId}/messages/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ message }),
      signal,
    });
  },
};