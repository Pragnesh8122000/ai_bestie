import type { IUser } from '../models/User';

/** The single public user contract returned by every authentication endpoint. */
export function serializeAuthUser(user: IUser | Record<string, any>) {
  const raw = typeof (user as any).toObject === 'function'
    ? (user as any).toObject()
    : user;

  return {
    id: raw._id?.toString?.() ?? raw.id,
    email: raw.email,
    name: raw.name,
    authProviders: raw.authProviders ?? ['password'],
    activePersonaId: raw.activePersonaId?.toString?.() ?? raw.activePersonaId,
    preferences: raw.preferences,
    createdAt: raw.createdAt,
  };
}
