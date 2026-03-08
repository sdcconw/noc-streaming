// ログイン・ログアウト・セッション確認など認証系APIを提供するルーター。
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import bcrypt from 'bcryptjs';

import { authenticateWithLdap } from '../lib/ldap.js';
import { writeAudit } from '../lib/audit.js';
import { prisma } from '../lib/prisma.js';
import { loadSessionContext } from '../lib/auth.js';

const authRouter = Router();
const TOKEN_TTL_SECONDS = Number(process.env.AUTH_TOKEN_TTL_SECONDS ?? 3600);
const ACCESS_TOKEN_COOKIE = 'noc_access_token';
const CSRF_COOKIE = 'noc_csrf';
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'false').toLowerCase() === 'true';

// JWT署名に使う必須シークレットを取得する。
function requireJwtSecret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error('JWT_SECRET is required');
  }
  return value;
}
const JWT_SECRET = requireJwtSecret();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

authRouter.post('/api/auth/login', async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { username: body.username }
    });

    let currentUser = user;
    let authOk = false;
    let ldapTried = false;
    let ldapSuccess = false;

    if (currentUser && currentUser.authSource === 'local' && currentUser.isActive) {
      authOk = await bcrypt.compare(body.password, currentUser.passwordHash);
    } else {
      ldapTried = true;
      const ldapOk = await authenticateWithLdap(body.username, body.password);
      if (ldapOk) {
        ldapSuccess = true;
        currentUser = await prisma.user.upsert({
          where: { username: body.username },
          update: { authSource: 'ldap', role: 'admin', isActive: true },
          create: {
            username: body.username,
            passwordHash: '',
            authSource: 'ldap',
            role: 'admin',
            isActive: true
          }
        });
        authOk = true;
      }
    }

    if (!currentUser || !currentUser.isActive || !authOk) {
      await writeAudit(req, res, 'auth.login.failure', 'user', body.username, {
        ldap_tried: ldapTried,
        ldap_success: ldapSuccess,
        has_local_user: Boolean(user),
        local_active: Boolean(user?.isActive)
      });
      res.status(401).json({ message: 'invalid username or password' });
      return;
    }

    const tokenId = randomUUID();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

    await prisma.session.create({
      data: {
        userId: currentUser.id,
        tokenId,
        expiresAt
      }
    });

    const accessToken = jwt.sign(
      {
        sub: currentUser.id.toString(),
        sid: tokenId,
        role: currentUser.role
      },
      JWT_SECRET,
      { expiresIn: TOKEN_TTL_SECONDS }
    );

    res.locals.authUser = { id: currentUser.id, username: currentUser.username };
    await writeAudit(req, res, 'auth.login.success', 'user', currentUser.username, {
      auth_source: currentUser.authSource,
      role: currentUser.role,
      ldap_tried: ldapTried,
      ldap_success: ldapSuccess
    });

    const csrfToken = randomBytes(24).toString('base64url');
    const cookieOptions = {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'strict' as const,
      maxAge: TOKEN_TTL_SECONDS * 1000,
      path: '/'
    };
    const csrfCookieOptions = {
      httpOnly: false,
      secure: COOKIE_SECURE,
      sameSite: 'strict' as const,
      maxAge: TOKEN_TTL_SECONDS * 1000,
      path: '/'
    };
    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, cookieOptions);
    res.cookie(CSRF_COOKIE, csrfToken, csrfCookieOptions);

    res.json({
      expires_in: TOKEN_TTL_SECONDS,
      user: {
        id: Number(currentUser.id),
        username: currentUser.username,
        role: currentUser.role
      }
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/api/auth/logout', async (req, res, next) => {
  try {
    const { session, user } = await loadSessionContext(req);
    res.locals.authUser = { id: user.id, username: user.username };
    await writeAudit(req, res, 'auth.logout', 'session', session.id.toString());
    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() }
    });
    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
    res.status(204).send();
  } catch (err) {
    if (err instanceof Error) {
      res.status(401).json({ message: 'unauthorized' });
      return;
    }
    next(err);
  }
});

authRouter.get('/api/auth/me', async (req, res, next) => {
  try {
    const { user } = await loadSessionContext(req);
    res.json({ id: Number(user.id), username: user.username, role: user.role });
  } catch (err) {
    if (err instanceof Error) {
      res.status(401).json({ message: 'unauthorized' });
      return;
    }
    next(err);
  }
});

export { authRouter };
