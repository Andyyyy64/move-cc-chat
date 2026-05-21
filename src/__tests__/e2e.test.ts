import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packSession } from '../pack.js';
import { unpackSession } from '../unpack.js';
import { encrypt, decrypt, generateTransferCode, parseTransferCode } from '../crypto.js';

describe('full local round-trip (no network)', () => {
  let pcA: string;
  let pcB: string;

  beforeEach(() => {
    pcA = mkdtempSync(join(tmpdir(), 'move-agent-chat-pcA-'));
    pcB = mkdtempSync(join(tmpdir(), 'move-agent-chat-pcB-'));

    const sessionId = '11111111-2222-3333-4444-555555555555';
    const projectDir = join(pcA, 'projects', '-home-alice-work-myapp');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(pcA, 'sessions'), { recursive: true });

    const convoLines = [
      JSON.stringify({ type: 'system', message: { role: 'system', content: 'You are Claude' }, cwd: '/home/alice/work/myapp', uuid: 'sys1' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the bug in auth.ts' }, cwd: '/home/alice/work/myapp', uuid: 'u1' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'I will fix auth.ts' }, uuid: 'a1' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Now add tests' }, cwd: '/home/alice/work/myapp', uuid: 'u2' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Adding tests...' }, uuid: 'a2' }),
    ];
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), convoLines.join('\n') + '\n');

    writeFileSync(
      join(pcA, 'sessions', '1234.json'),
      JSON.stringify({ pid: 1234, sessionId, cwd: '/home/alice/work/myapp', startedAt: 10000 })
    );

    writeFileSync(
      join(pcA, 'history.jsonl'),
      JSON.stringify({ display: 'Fix the bug', sessionId, project: '/home/alice/work/myapp', timestamp: 10000 }) + '\n'
    );
  });

  afterEach(() => {
    rmSync(pcA, { recursive: true, force: true });
    rmSync(pcB, { recursive: true, force: true });
  });

  it('transfers session from PC A to PC B with path rewrite', () => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const session = { pid: 1234, sessionId, cwd: '/home/alice/work/myapp', startedAt: 10000, kind: 'interactive' as const };

    // PC A: pack + encrypt
    const bundle = packSession(pcA, session);
    const { key } = generateTransferCode('test-gist-id');
    const encrypted = encrypt(bundle, key);

    // Simulate transfer (in real flow this goes through Gist)
    // PC B: decrypt + unpack
    const decrypted = decrypt(encrypted, key);
    const newCwd = '/Users/bob/dev/myapp';
    const result = unpackSession(pcB, decrypted, newCwd);

    expect(result.sessionId).toBe(sessionId);
    expect(result.cwd).toBe(newCwd);

    // Verify conversation was placed correctly
    const convoPath = join(pcB, 'projects', '-Users-bob-dev-myapp', `${sessionId}.jsonl`);
    expect(existsSync(convoPath)).toBe(true);

    // Verify paths were rewritten
    const lines = readFileSync(convoPath, 'utf-8').trim().split('\n');
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj.cwd) {
        expect(obj.cwd).toBe(newCwd);
        expect(obj.cwd).not.toContain('alice');
      }
    }

    // Verify history was appended
    const historyPath = join(pcB, 'history.jsonl');
    expect(existsSync(historyPath)).toBe(true);
    const historyContent = readFileSync(historyPath, 'utf-8');
    expect(historyContent).toContain(newCwd);
    expect(historyContent).not.toContain('/home/alice');
  });

  it('transfer code encodes and decodes correctly', () => {
    const { code, key } = generateTransferCode('abc123');
    const parsed = parseTransferCode(code);
    expect(parsed.key).toEqual(key);
    expect(parsed.gistId).toBe('abc123');
  });
});
