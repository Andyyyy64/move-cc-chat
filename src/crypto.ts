import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Generate a transfer code that encodes both the encryption key and gist ID.
 *
 * Format: mc_{base64url(key(32 bytes) + gistIdBytes(16 bytes))}
 * Total: 3 + 64 = 67 chars (gist IDが32 hex charsの場合)
 *
 * gist IDが非hex or 奇数長の場合はフォールバック:
 * mc_{base64url(key(32 bytes))}.{gistId}
 */
export function generateTransferCode(gistId: string, existingKey?: Buffer): { code: string; key: Buffer } {
  const key = existingKey ?? randomBytes(32);

  // gist IDが32 hex charsならバイナリに圧縮して1つのbase64urlに
  if (/^[0-9a-f]+$/.test(gistId) && gistId.length % 2 === 0) {
    const gistBytes = Buffer.from(gistId, 'hex');
    const payload = Buffer.concat([key, Buffer.from([gistBytes.length]), gistBytes]);
    const code = `mc_${payload.toString('base64url')}`;
    return { code, key };
  }

  // フォールバック: dot区切り
  const code = `mc_${key.toString('base64url')}.${gistId}`;
  return { code, key };
}

/**
 * Parse a transfer code back into key + gistId.
 */
export function parseTransferCode(code: string): { key: Buffer; gistId: string } {
  if (!code.startsWith('mc_')) {
    throw new Error('Invalid transfer code format');
  }

  const body = code.slice(3); // strip mc_

  if (body.includes('.')) {
    // フォールバック形式: base64url_key.gistId
    const dotIndex = body.indexOf('.');
    const key = Buffer.from(body.slice(0, dotIndex), 'base64url');
    const gistId = body.slice(dotIndex + 1);
    if (key.length !== 32) throw new Error('Invalid transfer code: bad key');
    return { key, gistId };
  }

  // コンパクト形式: base64url(key + lengthByte + gistIdBytes)
  const payload = Buffer.from(body, 'base64url');
  if (payload.length < 33) throw new Error('Invalid transfer code: too short');

  const key = payload.subarray(0, 32);
  const gistIdLen = payload[32];
  const gistBytes = payload.subarray(33, 33 + gistIdLen);

  if (gistBytes.length !== gistIdLen) throw new Error('Invalid transfer code: truncated gist ID');

  const gistId = gistBytes.toString('hex');
  return { key, gistId };
}

/**
 * Encrypt data with AES-256-GCM.
 * Output format: [12 bytes IV][16 bytes auth tag][...ciphertext]
 */
export function encrypt(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt AES-256-GCM encrypted data.
 */
export function decrypt(data: Buffer, key: Buffer): Buffer {
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
