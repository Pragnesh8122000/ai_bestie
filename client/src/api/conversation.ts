import apiClient from './client';

export interface Conversation {
  id: string;
  title: string;
  personaId: string;
  avatarId: string;
  lastMessageAt: string;
  createdAt: string;
  // Added alongside multi-conversation support. Optional so responses that
  // predate the backend deploy still typecheck.
  titleIsCustom?: boolean;
  messageCount?: number;
  lastMessagePreview?: string;
}

export interface Message {
  _id?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ConversationsResponse {
  success: boolean;
  data: { conversations: Conversation[]; hasMore: boolean };
}

interface ListParams {
  limit?: number;
  /** ISO timestamp cursor — returns conversations older than this. */
  before?: string;
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
  list: (params?: ListParams) =>
    apiClient.get<ConversationsResponse>('/conversations', { params }),

  getDefault: () =>
    apiClient.get<DefaultConversationResponse>('/conversations/default'),

  get: (id: string) =>
    apiClient.get<ConversationDetailResponse>(`/conversations/${id}`),

  create: (data: CreateConversationInput) =>
    apiClient.post<{ success: boolean; data: { conversation: Conversation & { messages: Message[] } } }>(
      '/conversations',
      data,
    ),

  rename: (id: string, title: string) =>
    apiClient.patch<{ success: boolean; data: { conversation: Conversation } }>(
      `/conversations/${id}`,
      { title },
    ),

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