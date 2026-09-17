import apiClient from './client';

export interface Avatar {
  id: string;
  name: string;
  src: string;
  category: 'mentor' | 'friend' | 'therapist' | 'coach';
}

interface AvatarsResponse {
  success: boolean;
  data: {
    avatars: Avatar[];
  };
}

export const avatarApi = {
  list: () => apiClient.get<AvatarsResponse>('/avatars'),
};
