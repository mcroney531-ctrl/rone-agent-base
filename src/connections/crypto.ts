import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// CONNECTION_KEY: 32 random bytes, base64. Generate with `openssl rand -base64 32`.
// key_version is stored per secret so the key can be rotated without a flag day.
export const KEY_VERSION = 1;

function key(): Buffer {
  const raw = process.env.CONNECTION_KEY;
  if (!raw) throw new Error('CONNECTION_KEY is not set; it encrypts integration credentials at rest');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('CONNECTION_KEY must be 32 bytes, base64-encoded');
  return k;
}

export type Sealed = { iv: Buffer; tag: Buffer; ciphertext: Buffer; keyVersion: number };

export function seal(plaintext: string, aad: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { iv, tag: c.getAuthTag(), ciphertext, keyVersion: KEY_VERSION };
}

// aad = the connection ID: a secret copied onto another connection's row fails to decrypt.
export function open(s: Sealed, aad: string): string {
  const d = createDecipheriv('aes-256-gcm', key(), s.iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(s.tag);
  return Buffer.concat([d.update(s.ciphertext), d.final()]).toString('utf8');
}
