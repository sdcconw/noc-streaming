import { Client } from 'ldapts';

import { prisma } from './prisma.js';
import { decryptSecret } from './secrets.js';

type LdapTestConfig = {
  serverUrl: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
};

export async function authenticateWithLdap(username: string, password: string): Promise<boolean> {
  if (!username || !password) return false;

  const conf = await prisma.ldapConfig.findFirst({ orderBy: { id: 'asc' } });
  if (!conf || !conf.enabled) return false;

  const client = new Client({ url: conf.serverUrl });
  try {
    await client.bind(conf.bindDn, decryptSecret(conf.bindPasswordEnc));

    const filter = conf.userFilter.replaceAll('{username}', escapeLdapValue(username));
    const { searchEntries } = await client.search(conf.baseDn, {
      scope: 'sub',
      filter,
      attributes: ['dn', 'memberOf']
    });

    if (!searchEntries.length) return false;

    const entry = searchEntries[0] as { dn?: string; memberOf?: string | string[] };
    const userDn = entry.dn ?? '';
    if (!userDn) return false;

    if (conf.groupDn) {
      const required = conf.groupDn.toLowerCase();
      const memberOf = Array.isArray(entry.memberOf) ? entry.memberOf : entry.memberOf ? [entry.memberOf] : [];
      const inGroup = memberOf.some((x) => String(x).toLowerCase() === required);
      if (!inGroup) return false;
    }

    await client.bind(userDn, password);
    return true;
  } catch {
    return false;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export async function testLdapConnection(config: LdapTestConfig): Promise<{ ok: boolean; message: string }> {
  const client = new Client({ url: config.serverUrl });
  try {
    await client.bind(config.bindDn, config.bindPassword);
    await client.search(config.baseDn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['dn']
    });
    return { ok: true, message: 'LDAP接続確認に成功しました' };
  } catch (err) {
    const msg = err instanceof Error && err.message ? err.message : 'unknown ldap error';
    return { ok: false, message: `LDAP接続確認に失敗しました: ${msg}` };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

function escapeLdapValue(value: string): string {
  return value
    .replaceAll('\\', '\\5c')
    .replaceAll('*', '\\2a')
    .replaceAll('(', '\\28')
    .replaceAll(')', '\\29')
    .replaceAll('\u0000', '\\00');
}
