// ユーザー管理・LDAP設定・監査ログなど管理者向けAPIを提供するルーター。
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { requireAuth, requireRole } from '../lib/auth.js';
import { writeAudit } from '../lib/audit.js';
import { testLdapConnection } from '../lib/ldap.js';
import { prisma } from '../lib/prisma.js';
import { decryptSecret, encryptSecret } from '../lib/secrets.js';

const adminRouter = Router();
adminRouter.use('/api/admin', requireAuth, requireRole(['admin']));

// 入力値がLDAP/LDAPSスキームかどうかを判定する。
function isLdapUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'ldap:' || u.protocol === 'ldaps:';
  } catch {
    return false;
  }
}

const ldapSchema = z.object({
  enabled: z.boolean(),
  server_url: z.string().trim().min(1).max(2048).refine(isLdapUrl, 'server_url must be ldap:// or ldaps://'),
  bind_dn: z.string().trim().min(1).max(1024),
  bind_password: z.string().max(1024).optional().default(''),
  base_dn: z.string().trim().min(1).max(1024),
  user_filter: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((v) => v.includes('{username}'), 'user_filter must include {username}'),
  group_dn: z.string().trim().max(1024).optional().default('')
});

const createUserSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(4),
  role: z.enum(['admin', 'operator', 'viewer']),
  is_active: z.boolean().default(true)
});

const updateUserSchema = z
  .object({
    password: z.string().min(4).optional(),
    role: z.enum(['admin', 'operator', 'viewer']).optional(),
    is_active: z.boolean().optional()
  })
  .refine((v) => Object.keys(v).length > 0, 'request body must include at least one updatable field');

// URLパラメータIDを`bigint`に変換する。
function parseId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) throw new Error('invalid id');
  return BigInt(raw);
}

adminRouter.get('/api/admin/ldap-config', async (_req, res) => {
  const conf = await prisma.ldapConfig.findFirst({ orderBy: { id: 'asc' } });
  if (!conf) {
    res.json(null);
    return;
  }

  res.json({
    id: Number(conf.id),
    enabled: conf.enabled,
    server_url: conf.serverUrl,
    bind_dn: conf.bindDn,
    has_bind_password: Boolean(conf.bindPasswordEnc),
    base_dn: conf.baseDn,
    user_filter: conf.userFilter,
    group_dn: conf.groupDn
  });
});

adminRouter.put('/api/admin/ldap-config', async (req, res, next) => {
  try {
    const body = ldapSchema.parse(req.body);
    const existing = await prisma.ldapConfig.findFirst({ orderBy: { id: 'asc' } });
    const bindPasswordEnc =
      body.bind_password.trim().length > 0
        ? encryptSecret(body.bind_password)
        : existing?.bindPasswordEnc ?? '';

    const payload = {
      enabled: body.enabled,
      serverUrl: body.server_url,
      bindDn: body.bind_dn,
      bindPasswordEnc,
      baseDn: body.base_dn,
      userFilter: body.user_filter,
      groupDn: body.group_dn
    };

    const saved = existing
      ? await prisma.ldapConfig.update({ where: { id: existing.id }, data: payload })
      : await prisma.ldapConfig.create({ data: payload });

    await writeAudit(req, res, 'ldap_config.upsert', 'ldap_config', String(saved.id), {
      enabled: saved.enabled,
      server_url: saved.serverUrl,
      bind_dn: saved.bindDn,
      base_dn: saved.baseDn,
      user_filter: saved.userFilter,
      group_dn: saved.groupDn
    });

    res.json({
      id: Number(saved.id),
      enabled: saved.enabled,
      server_url: saved.serverUrl,
      bind_dn: saved.bindDn,
      has_bind_password: Boolean(saved.bindPasswordEnc),
      base_dn: saved.baseDn,
      user_filter: saved.userFilter,
      group_dn: saved.groupDn
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/api/admin/ldap-config/test', async (req, res, next) => {
  try {
    const body = ldapSchema.parse(req.body);
    const existing = await prisma.ldapConfig.findFirst({ orderBy: { id: 'asc' } });
    const bindPassword =
      body.bind_password.trim().length > 0
        ? body.bind_password
        : existing?.bindPasswordEnc
          ? decryptSecret(existing.bindPasswordEnc)
          : '';
    if (!bindPassword) {
      res.status(400).json({ ok: false, message: 'bind_password is required for test', elapsed_ms: 0 });
      return;
    }
    const startedAt = Date.now();
    const result = await testLdapConnection({
      serverUrl: body.server_url,
      bindDn: body.bind_dn,
      bindPassword,
      baseDn: body.base_dn
    });
    const elapsedMs = Date.now() - startedAt;

    await writeAudit(req, res, 'ldap_config.test', 'ldap_config', 'runtime', {
      ok: result.ok,
      elapsed_ms: elapsedMs,
      server_url: body.server_url,
      bind_dn: body.bind_dn,
      base_dn: body.base_dn,
      user_filter: body.user_filter,
      group_dn: body.group_dn
    });

    res.status(result.ok ? 200 : 400).json({
      ok: result.ok,
      message: result.message,
      elapsed_ms: elapsedMs
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/api/admin/users', async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
  res.json(
    users.map((u) => ({
      id: Number(u.id),
      username: u.username,
      role: u.role,
      auth_source: u.authSource,
      is_active: u.isActive,
      created_at: u.createdAt.toISOString()
    }))
  );
});

adminRouter.get('/api/admin/audit-logs', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  const logs = await prisma.auditLog.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Number.isFinite(limit) && limit > 0 ? limit : 200
  });

  res.json(
    logs.map((x) => ({
      id: Number(x.id),
      actor_user_id: x.actorUserId ? Number(x.actorUserId) : null,
      actor_username: x.actorUsername,
      action: x.action,
      target_type: x.targetType,
      target_id: x.targetId,
      detail_json: x.detailJson,
      created_at: x.createdAt.toISOString()
    }))
  );
});

adminRouter.post('/api/admin/users', async (req, res, next) => {
  try {
    const body = createUserSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(body.password, 12);

    const created = await prisma.user.create({
      data: {
        username: body.username,
        passwordHash,
        role: body.role,
        authSource: 'local',
        isActive: body.is_active
      }
    });

    await writeAudit(req, res, 'user.create', 'user', String(created.id), {
      username: created.username,
      role: created.role,
      auth_source: created.authSource,
      is_active: created.isActive
    });

    res.status(201).json({
      id: Number(created.id),
      username: created.username,
      role: created.role,
      auth_source: created.authSource,
      is_active: created.isActive,
      created_at: created.createdAt.toISOString()
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/api/admin/users/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const body = updateUserSchema.parse(req.body);

    const data: {
      passwordHash?: string;
      role?: 'admin' | 'operator' | 'viewer';
      isActive?: boolean;
    } = {};

    if (body.password) data.passwordHash = await bcrypt.hash(body.password, 12);
    if (body.role) data.role = body.role;
    if (body.is_active !== undefined) data.isActive = body.is_active;

    const updated = await prisma.user.update({ where: { id }, data });

    await writeAudit(req, res, 'user.update', 'user', String(updated.id), {
      role: updated.role,
      is_active: updated.isActive,
      password_changed: Boolean(body.password)
    });

    res.json({
      id: Number(updated.id),
      username: updated.username,
      role: updated.role,
      auth_source: updated.authSource,
      is_active: updated.isActive,
      created_at: updated.createdAt.toISOString()
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/api/admin/users/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const me = res.locals.authUser as { id: bigint };
    if (id === me.id) {
      res.status(400).json({ message: 'cannot delete current user' });
      return;
    }

    await prisma.user.delete({ where: { id } });
    await writeAudit(req, res, 'user.delete', 'user', String(id));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export { adminRouter };
