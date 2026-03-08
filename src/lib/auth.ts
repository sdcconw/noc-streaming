// JWTとセッション情報を使った認可・認証ヘルパーを提供する共通モジュール。
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

import { prisma } from './prisma.js';

// JWT署名検証に必要なシークレットを環境変数から取得する。
function requireJwtSecret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error('JWT_SECRET is required');
  }
  return value;
}
const JWT_SECRET = requireJwtSecret();
export type AuthRole = 'admin' | 'operator' | 'viewer';
const ACCESS_TOKEN_COOKIE = 'noc_access_token';

// AuthorizationヘッダーからBearerトークン文字列を抽出する。
function parseBearerToken(rawHeader: string | undefined): string {
  if (!rawHeader) {
    throw new Error('authorization header is required');
  }

  const [scheme, token] = rawHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new Error('authorization header must be Bearer token');
  }

  return token;
}

// Cookieヘッダーから指定キーの値を取得する。
function parseCookieValue(rawCookie: string | undefined, key: string): string | null {
  if (!rawCookie) return null;
  const parts = rawCookie.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (k === key) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

// AuthorizationヘッダーまたはCookieからアクセストークンを解決する。
function resolveToken(req: Request): string {
  const rawHeader = req.header('authorization');
  if (rawHeader) {
    return parseBearerToken(rawHeader);
  }
  const tokenFromCookie = parseCookieValue(req.headers.cookie, ACCESS_TOKEN_COOKIE);
  if (!tokenFromCookie) {
    throw new Error('authorization token is required');
  }
  return tokenFromCookie;
}

// トークン検証とDBセッション照合を行い、認証コンテキストを返す。
export async function loadSessionContext(req: Request) {
  const token = resolveToken(req);
  const payload = jwt.verify(token, JWT_SECRET) as {
    sub: string;
    sid: string;
    role: string;
  };

  const userId = BigInt(payload.sub);
  const session = await prisma.session.findUnique({
    where: { tokenId: payload.sid },
    include: { user: true }
  });

  if (!session || session.userId !== userId) {
    throw new Error('invalid token');
  }
  if (session.revokedAt) {
    throw new Error('token revoked');
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw new Error('token expired');
  }
  if (!session.user.isActive) {
    throw new Error('user is inactive');
  }

  return { session, user: session.user };
}

// 未認証アクセスを401で遮断し、認証ユーザー情報を`res.locals`に格納する。
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = await loadSessionContext(req);
    res.locals.authUser = {
      id: ctx.user.id,
      username: ctx.user.username,
      role: ctx.user.role
    };
    next();
  } catch {
    res.status(401).json({ message: 'unauthorized' });
  }
}

// 指定ロール以外のアクセスを403で遮断する認可ミドルウェアを生成する。
export function requireRole(roles: AuthRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authUser = res.locals.authUser as { role?: AuthRole } | undefined;
    if (!authUser?.role) {
      res.status(401).json({ message: 'unauthorized' });
      return;
    }
    if (!roles.includes(authUser.role)) {
      res.status(403).json({ message: 'forbidden' });
      return;
    }

    next();
  };
}
