import jwt from 'jsonwebtoken';
import { config } from '../config/index';
import { Response } from 'express';

export const generateToken = (userId: string): string => {
  return jwt.sign({ id: userId }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);
};

export const verifyToken = (token: string): { id: string } | null => {
  try {
    return jwt.verify(token, config.jwt.secret) as { id: string };
  } catch {
    return null;
  }
};

export const setTokenCookie = (res: Response, token: string): void => {
  const isProduction = config.nodeEnv === 'production';

  res.cookie('token', token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });
};

export const clearTokenCookie = (res: Response): void => {
  const isProduction = config.nodeEnv === 'production';
  res.cookie('token', '', {
    httpOnly: true,
    secure: isProduction,
    // Must match setTokenCookie's sameSite or a stale token cookie can linger.
    sameSite: isProduction ? 'strict' : 'lax',
    maxAge: 0,
    path: '/',
  });
};