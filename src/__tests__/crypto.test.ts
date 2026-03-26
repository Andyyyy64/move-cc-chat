import { describe, it, expect } from 'vitest';
import { generateTransferCode, parseTransferCode, encrypt, decrypt } from '../crypto.js';

describe('transfer code', () => {
  it('round-trips hex gist ID (compact format)', () => {
    const gistId = 'abc123def456abc123def456abc123de';  // 30 hex chars (even length)
    const { code, key } = generateTransferCode(gistId);

    expect(code).toMatch(/^mc_[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(80);

    const parsed = parseTransferCode(code);
    expect(parsed.key).toEqual(key);
    expect(parsed.gistId).toBe(gistId);
  });

  it('round-trips 32-char hex gist ID (typical GitHub gist)', () => {
    const gistId = '3f3a44896962ac3e669d2212b736e8b3';
    const { code, key } = generateTransferCode(gistId);

    expect(code.startsWith('mc_')).toBe(true);
    expect(code.length).toBeLessThan(75);

    const parsed = parseTransferCode(code);
    expect(parsed.key).toEqual(key);
    expect(parsed.gistId).toBe(gistId);
  });

  it('round-trips non-hex gist ID (fallback format)', () => {
    const gistId = 'some-weird-gist-id';
    const { code, key } = generateTransferCode(gistId);

    expect(code).toContain('.');
    const parsed = parseTransferCode(code);
    expect(parsed.key).toEqual(key);
    expect(parsed.gistId).toBe(gistId);
  });

  it('different calls produce different codes', () => {
    const { code: code1 } = generateTransferCode('aabbccdd');
    const { code: code2 } = generateTransferCode('11223344');
    expect(code1).not.toBe(code2);
  });

  it('accepts an existing key', () => {
    const key = Buffer.alloc(32, 0xab);
    const gistId = 'aabbccddeeff00112233445566778899';
    const { code, key: returnedKey } = generateTransferCode(gistId, key);
    expect(returnedKey).toEqual(key);
    const parsed = parseTransferCode(code);
    expect(parsed.key).toEqual(key);
    expect(parsed.gistId).toBe(gistId);
  });

  it('throws on invalid format', () => {
    expect(() => parseTransferCode('invalid')).toThrow();
    expect(() => parseTransferCode('mc_short')).toThrow();
  });
});

describe('encrypt/decrypt', () => {
  it('round-trips data correctly', () => {
    const key = Buffer.alloc(32, 0xab);
    const data = Buffer.from('hello world this is session data');

    const encrypted = encrypt(data, key);
    expect(encrypted).not.toEqual(data);

    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toEqual(data);
  });

  it('fails with wrong key', () => {
    const key1 = Buffer.alloc(32, 0xab);
    const key2 = Buffer.alloc(32, 0xcd);
    const data = Buffer.from('secret');

    const encrypted = encrypt(data, key1);
    expect(() => decrypt(encrypted, key2)).toThrow();
  });

  it('handles empty data', () => {
    const key = Buffer.alloc(32, 0x01);
    const data = Buffer.from('');
    const encrypted = encrypt(data, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toEqual(data);
  });
});
