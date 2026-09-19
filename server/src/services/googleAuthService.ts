import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { config } from '../config';
import { AuthProvider, IUser, User } from '../models/User';
import { AppError } from '../utils/errors';

export interface GoogleIdentityVerifier {
  verify(credential: string, audience: string): Promise<TokenPayload | undefined>;
}

export interface GoogleUserRepository {
  findBySubject(subject: string): Promise<IUser | null>;
  findByEmail(email: string): Promise<IUser | null>;
  link(userId: string, subject: string, providers: AuthProvider[]): Promise<IUser | null>;
  create(input: {
    email: string;
    name: string;
    googleSubject: string;
    authProviders: AuthProvider[];
  }): Promise<IUser>;
  touch(userId: string): Promise<IUser | null>;
}

const oauthClient = new OAuth2Client();

const verifier: GoogleIdentityVerifier = {
  async verify(credential, audience) {
    const ticket = await oauthClient.verifyIdToken({ idToken: credential, audience });
    return ticket.getPayload();
  },
};

const repository: GoogleUserRepository = {
  findBySubject: (subject) => User.findOne({ googleSubject: subject }),
  findByEmail: (email) => User.findOne({ email }),
  link: (userId, subject, providers) =>
    User.findOneAndUpdate(
      {
        _id: userId,
        $or: [
          { googleSubject: { $exists: false } },
          { googleSubject: null },
          { googleSubject: subject },
        ],
      },
      {
        $set: {
          googleSubject: subject,
          authProviders: providers,
          lastLoginAt: new Date(),
        },
      },
      { new: true, runValidators: true },
    ),
  create: (input) => User.create(input),
  touch: (userId) =>
    User.findByIdAndUpdate(userId, { $set: { lastLoginAt: new Date() } }, { new: true }),
};

/**
 * Google is authoritative for Gmail and verified Workspace (`hd`) addresses.
 * For third-party addresses Google may have verified a former owner only, so
 * an email collision must keep using the existing password account.
 */
export function isGoogleAuthoritative(payload: TokenPayload): boolean {
  const email = payload.email?.toLowerCase() ?? '';
  return email.endsWith('@gmail.com') || (payload.email_verified === true && Boolean(payload.hd));
}

function conflict(message: string, code: string): AppError {
  return new AppError(message, 409, true, code);
}

export async function authenticateGoogleCredential(
  credential: string,
  deps: {
    clientId?: string;
    verifier?: GoogleIdentityVerifier;
    repository?: GoogleUserRepository;
  } = {},
): Promise<IUser> {
  const clientId = deps.clientId ?? config.google.clientId;
  const tokenVerifier = deps.verifier ?? verifier;
  const users = deps.repository ?? repository;

  if (!clientId) {
    throw new AppError(
      'Google sign-in is not configured',
      503,
      true,
      'GOOGLE_AUTH_UNAVAILABLE',
    );
  }

  let payload: TokenPayload | undefined;
  try {
    payload = await tokenVerifier.verify(credential, clientId);
  } catch {
    throw new AppError('Invalid Google credential', 401, true, 'INVALID_GOOGLE_CREDENTIAL');
  }

  const subject = payload?.sub?.trim();
  const email = payload?.email?.trim().toLowerCase();
  if (!subject || !email || payload?.email_verified !== true) {
    throw new AppError(
      'Google account must have a verified email',
      401,
      true,
      'UNVERIFIED_GOOGLE_EMAIL',
    );
  }

  const returningUser = await users.findBySubject(subject);
  if (returningUser) {
    return (await users.touch(returningUser.id)) ?? returningUser;
  }

  const emailOwner = await users.findByEmail(email);
  if (emailOwner) {
    if (emailOwner.googleSubject && emailOwner.googleSubject !== subject) {
      throw conflict('Unable to use this Google account', 'GOOGLE_IDENTITY_CONFLICT');
    }

    if (!isGoogleAuthoritative(payload)) {
      throw conflict(
        'An account already exists with this email. Sign in with your password instead.',
        'ACCOUNT_LINK_REQUIRED',
      );
    }

    const currentProviders = emailOwner.authProviders?.length
      ? emailOwner.authProviders
      : (['password'] as AuthProvider[]);
    const providers = Array.from(new Set<AuthProvider>([...currentProviders, 'google']));

    try {
      const linked = await users.link(emailOwner.id, subject, providers);
      if (!linked) {
        throw conflict('Unable to use this Google account', 'GOOGLE_IDENTITY_CONFLICT');
      }
      return linked;
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      if (error?.code === 11000) {
        throw conflict('Unable to use this Google account', 'GOOGLE_IDENTITY_CONFLICT');
      }
      throw error;
    }
  }

  const name = payload.name?.trim().slice(0, 50) || email.split('@')[0].slice(0, 50);
  try {
    return await users.create({
      email,
      name,
      googleSubject: subject,
      authProviders: ['google'],
    });
  } catch (error: any) {
    if (error?.code !== 11000) throw error;

    // A concurrent request may have created the same Google identity after
    // our lookups. Only the stable subject may win this race.
    const racedUser = await users.findBySubject(subject);
    if (racedUser) return (await users.touch(racedUser.id)) ?? racedUser;
    throw conflict('Unable to use this Google account', 'GOOGLE_IDENTITY_CONFLICT');
  }
}
