import apiClient from './client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  authProviders: Array<'password' | 'google'>;
  activePersonaId?: string;
  preferences?: Record<string, any>;
  createdAt?: string;
}

export interface AuthResponse {
  success: boolean;
  data: {
    user: AuthUser;
  };
}

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface GoogleLoginInput {
  credential: string;
}

export const authApi = {
  register: (data: RegisterInput) =>
    apiClient.post<AuthResponse>('/auth/register', data),

  login: (data: LoginInput) =>
    apiClient.post<AuthResponse>('/auth/login', data),

  googleLogin: (data: GoogleLoginInput) =>
    apiClient.post<AuthResponse>('/auth/google', data),

  logout: () =>
    apiClient.post<{ success: boolean; message: string }>('/auth/logout'),

  getMe: () =>
    apiClient.get<AuthResponse>('/auth/me'),
};
