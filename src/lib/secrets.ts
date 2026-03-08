import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENC_PREFIX = 'enc:v1:';
const ENC_ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const raw = process.env.SECRET_ENCRYPTION_KEY ?? 'dev-secret-encryption-key-change-me';
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(plainText: string): string {
  if (!plainText) return '';
  if (plainText.startsWith(ENC_PREFIX)) return plainText;

  const iv = randomBytes(12);
  const cipher = createCipheriv(ENC_ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(value: string): string {
  if (!value) return '';
  if (!value.startsWith(ENC_PREFIX)) return value;

  const rest = value.slice(ENC_PREFIX.length);
  const [ivB64, tagB64, cipherB64] = rest.split(':');
  if (!ivB64 || !tagB64 || !cipherB64) return '';

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const cipherText = Buffer.from(cipherB64, 'base64');

  const decipher = createDecipheriv(ENC_ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return decrypted.toString('utf8');
}
