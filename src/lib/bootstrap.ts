import bcrypt from 'bcryptjs';
import { JobStatus } from '@prisma/client';

import { prisma } from './prisma.js';
import { encryptSecret } from './secrets.js';

function toBool(v: string | undefined, defaultValue = false): boolean {
  if (!v) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export async function bootstrapFromEnv() {
  await bootstrapAdminUser();
  await bootstrapLdapConfig();
  await bootstrapJobRuntimeStatus();
}

async function bootstrapAdminUser() {
  const username = (process.env.ADMIN_USERNAME ?? 'admin').trim();
  const password = process.env.ADMIN_PASSWORD ?? 'password';
  const forceReset = toBool(process.env.ADMIN_FORCE_RESET_PASSWORD, true);

  if (!username || !password) {
    // eslint-disable-next-line no-console
    console.warn('bootstrap admin skipped: ADMIN_USERNAME/ADMIN_PASSWORD is empty');
    return;
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  const shouldUpdatePassword = !existing || forceReset;
  const passwordHash = shouldUpdatePassword ? await bcrypt.hash(password, 12) : undefined;

  await prisma.user.upsert({
    where: { username },
    update: {
      authSource: 'local',
      role: 'admin',
      isActive: true,
      ...(passwordHash ? { passwordHash } : {})
    },
    create: {
      username,
      passwordHash: passwordHash ?? (await bcrypt.hash(password, 12)),
      authSource: 'local',
      role: 'admin',
      isActive: true
    }
  });

  // eslint-disable-next-line no-console
  console.log(`bootstrap admin ready: ${username}`);
}

async function bootstrapLdapConfig() {
  const enabled = toBool(process.env.LDAP_BOOTSTRAP_ENABLED, false);
  if (!enabled) return;

  const serverUrl = (process.env.LDAP_SERVER_URL ?? '').trim();
  const bindDn = (process.env.LDAP_BIND_DN ?? '').trim();
  const bindPassword = process.env.LDAP_BIND_PASSWORD ?? '';
  const baseDn = (process.env.LDAP_BASE_DN ?? '').trim();
  const userFilter = (process.env.LDAP_USER_FILTER ?? '(uid={username})').trim();
  const groupDn = (process.env.LDAP_GROUP_DN ?? '').trim();

  if (!serverUrl || !bindDn || !bindPassword || !baseDn) {
    // eslint-disable-next-line no-console
    console.warn('bootstrap ldap skipped: required LDAP_* env is missing');
    return;
  }

  const existing = await prisma.ldapConfig.findFirst({ orderBy: { id: 'asc' } });

  if (existing) {
    await prisma.ldapConfig.update({
      where: { id: existing.id },
      data: {
        serverUrl,
        bindDn,
        bindPasswordEnc: encryptSecret(bindPassword),
        baseDn,
        userFilter,
        groupDn,
        enabled: true
      }
    });
  } else {
    await prisma.ldapConfig.create({
      data: {
        serverUrl,
        bindDn,
        bindPasswordEnc: encryptSecret(bindPassword),
        baseDn,
        userFilter,
        groupDn,
        enabled: true
      }
    });
  }

  // eslint-disable-next-line no-console
  console.log(`bootstrap ldap config ready: ${serverUrl}`);
}

async function bootstrapJobRuntimeStatus() {
  const updated = await prisma.job.updateMany({
    where: {
      status: {
        in: [JobStatus.RUNNING, JobStatus.STARTING, JobStatus.STOPPING, JobStatus.RECONNECTING]
      }
    },
    data: {
      status: JobStatus.STOPPED
    }
  });

  if (updated.count > 0) {
    // eslint-disable-next-line no-console
    console.log(`bootstrap job status reconciled: ${updated.count} job(s) -> STOPPED`);
  }
}
