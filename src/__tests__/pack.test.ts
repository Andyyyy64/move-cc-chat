import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packSession } from '../pack.js';
import { unpackSession } from '../unpack.js';

describe('pack and unpack round-trip', () => {
  let srcClaudeDir: string;
  let dstClaudeDir: string;

  beforeEach(() => {
    srcClaudeDir = mkdtempSync(join(tmpdir(), 'move-chat-src-'));
    dstClaudeDir = mkdtempSync(join(tmpdir(), 'move-chat-dst-'));

    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const projectDir = join(srcClaudeDir, 'projects', '-home-alice-myproject');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(srcClaudeDir, 'sessions'), { recursive: true });

    const convoLines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, cwd: '/home/alice/myproject', uuid: '1' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' }, uuid: '2' }),
    ];
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), convoLines.join('\n') + '\n');

    writeFileSync(
      join(srcClaudeDir, 'sessions', '999.json'),
      JSON.stringify({ pid: 999, sessionId, cwd: '/home/alice/myproject', startedAt: 5000 })
    );

    writeFileSync(
      join(srcClaudeDir, 'history.jsonl'),
      [
        JSON.stringify({ display: 'hello', sessionId, project: '/home/alice/myproject', timestamp: 5000 }),
        JSON.stringify({ display: 'other', sessionId: 'other-session', project: '/tmp', timestamp: 6000 }),
      ].join('\n') + '\n'
    );
  });

  afterEach(() => {
    rmSync(srcClaudeDir, { recursive: true, force: true });
    rmSync(dstClaudeDir, { recursive: true, force: true });
  });

  it('packs session into a bundle and unpacks to new location', () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const session = { pid: 999, sessionId, cwd: '/home/alice/myproject', startedAt: 5000, kind: 'interactive' as const };

    const bundle = packSession(srcClaudeDir, session);
    expect(bundle.length).toBeGreaterThan(0);

    const newCwd = '/home/bob/projects/myproject';
    unpackSession(dstClaudeDir, bundle, newCwd);

    const newProjectDir = join(dstClaudeDir, 'projects', '-home-bob-projects-myproject');
    const convoPath = join(newProjectDir, `${sessionId}.jsonl`);
    expect(existsSync(convoPath)).toBe(true);

    const lines = readFileSync(convoPath, 'utf-8').trim().split('\n');
    const firstLine = JSON.parse(lines[0]);
    expect(firstLine.cwd).toBe(newCwd);

    const sessionFiles = join(dstClaudeDir, 'sessions');
    expect(existsSync(sessionFiles)).toBe(true);
  });

  it('packs and unpacks without cwd override (same path)', () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const session = { pid: 999, sessionId, cwd: '/home/alice/myproject', startedAt: 5000, kind: 'interactive' as const };

    const bundle = packSession(srcClaudeDir, session);
    unpackSession(dstClaudeDir, bundle, null);

    const projectDir = join(dstClaudeDir, 'projects', '-home-alice-myproject');
    expect(existsSync(join(projectDir, `${sessionId}.jsonl`))).toBe(true);
  });

  it('rejects bundles with path traversal in subagent paths', () => {
    const maliciousBundle = gzipSync(Buffer.from(JSON.stringify({
      manifest: {
        version: 1,
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        projectPath: '/tmp/evil',
        encodedProjectDir: '-tmp-evil',
        cwd: '/tmp/evil',
        pid: 1,
        startedAt: 1000,
        createdAt: new Date().toISOString(),
      },
      files: {
        'conversation.jsonl': Buffer.from('{}').toString('base64'),
        'subagents/../../../etc/evil.txt': Buffer.from('pwned').toString('base64'),
      },
    })));

    expect(() => unpackSession(dstClaudeDir, maliciousBundle, '/tmp/safe')).toThrow('Path traversal');
  });

  it('rejects bundles with invalid sessionId', () => {
    const maliciousBundle = gzipSync(Buffer.from(JSON.stringify({
      manifest: {
        version: 1,
        sessionId: '../../.ssh',
        projectPath: '/tmp/evil',
        encodedProjectDir: '-tmp-evil',
        cwd: '/tmp/evil',
        pid: 1,
        startedAt: 1000,
        createdAt: new Date().toISOString(),
      },
      files: {
        'conversation.jsonl': Buffer.from('{}').toString('base64'),
      },
    })));

    expect(() => unpackSession(dstClaudeDir, maliciousBundle, '/tmp/safe')).toThrow('Invalid sessionId');
  });
});
