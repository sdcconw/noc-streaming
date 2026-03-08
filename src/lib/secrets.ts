// 機密情報をAES-GCMで暗号化・復号するヘルパー関数群。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENC_PREFIX = 'enc:v1:';
const ENC_ALGO = 'aes-256-gcm';

// 環境変数の秘密鍵文字列から暗号化に使う固定長キーを生成する。
function getKey(): Buffer {
  const raw = process.env.SECRET_ENCRYPTION_KEY ?? 'dev-secret-encryption-key-change-me';
  return createHash('sha256').update(raw).digest();
}

// 平文を暗号化し、保存用のプレフィックス付き文字列へ変換する。
export function encryptSecret(plainText: string): string {
  if (!plainText) return '';
  if (plainText.startsWith(ENC_PREFIX)) return plainText;

  const iv = randomBytes(12);
  const cipher = createCipheriv(ENC_ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

// 保存済み文字列を復号して平文へ戻す（未暗号化値はそのまま返す）。
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
