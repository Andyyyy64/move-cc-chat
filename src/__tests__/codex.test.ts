import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listCodexSessions, packCodexSession, unpackCodexSession } from '../codex.js';

describe('Codex session transfer', () => {
  let srcHome: string;
  let dstHome: string;
  const threadId = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    srcHome = mkdtempSync(join(tmpdir(), 'move-agent-chat-codex-src-'));
    dstHome = mkdtempSync(join(tmpdir(), 'move-agent-chat-codex-dst-'));

    const sessionDir = join(srcHome, 'sessions', '2026', '05', '22');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(srcHome, 'shell_snapshots'), { recursive: true });
    mkdirSync(join(srcHome, 'generated_images', threadId), { recursive: true });

    const sessionPath = join(sessionDir, `rollout-2026-05-22T03-12-39-${threadId}.jsonl`);
    const rows = [
      {
        timestamp: '2026-05-22T03:12:39.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          cwd: '/home/alice/project',
          originator: 'Codex Desktop',
          cli_version: '0.131.0-alpha.9',
          source: 'vscode',
          thread_source: 'user',
          model_provider: 'openai',
          git: {
            commit_hash: 'abc123',
            branch: 'main',
            repository_url: 'git@example.com:repo.git',
          },
        },
      },
      {
        timestamp: '2026-05-22T03:13:00.000Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-1',
          cwd: '/home/alice/project',
          model: 'gpt-5.5',
          effort: 'xhigh',
        },
      },
      {
        timestamp: '2026-05-22T03:13:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue this project' }],
        },
      },
    ];
    writeFileSync(sessionPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');

    writeFileSync(
      join(srcHome, 'session_index.jsonl'),
      JSON.stringify({ id: threadId, thread_name: 'Move this Codex thread', updated_at: '2026-05-22T03:13:01.000Z' }) + '\n'
    );
    writeFileSync(join(srcHome, 'shell_snapshots', `${threadId}.123.sh`), 'cd /home/alice/project\n');
    writeFileSync(join(srcHome, 'generated_images', threadId, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterEach(() => {
    rmSync(srcHome, { recursive: true, force: true });
    rmSync(dstHome, { recursive: true, force: true });
  });

  it('lists Codex sessions from session_index and transcript files', () => {
    const sessions = listCodexSessions('codex-app', srcHome);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(threadId);
    expect(sessions[0].title).toBe('Move this Codex thread');
    expect(sessions[0].cwd).toBe('/home/alice/project');
    expect(sessions[0].model).toBe('gpt-5.5');
  });

  it('packs and natively unpacks a Codex session with cwd rewrite and assets', () => {
    const bundle = packCodexSession({
      provider: 'codex-app',
      home: srcHome,
      sessionId: threadId,
    });

    const result = unpackCodexSession(bundle, {
      provider: 'codex-app',
      home: dstHome,
      cwd: '/Users/bob/project',
      updateSqlite: false,
    });

    expect(result.threadId).toBe(threadId);
    expect(result.cwd).toBe('/Users/bob/project');

    const importedSession = join(dstHome, 'sessions', '2026', '05', '22', `rollout-2026-05-22T03-12-39-${threadId}.jsonl`);
    expect(existsSync(importedSession)).toBe(true);
    expect(readFileSync(importedSession, 'utf-8')).toContain('/Users/bob/project');
    expect(readFileSync(importedSession, 'utf-8')).not.toContain('/home/alice/project');

    const importedShell = join(dstHome, 'shell_snapshots', `${threadId}.123.sh`);
    expect(readFileSync(importedShell, 'utf-8')).toContain('/Users/bob/project');
    expect(existsSync(join(dstHome, 'generated_images', threadId, 'image.png'))).toBe(true);
    expect(readFileSync(join(dstHome, 'session_index.jsonl'), 'utf-8')).toContain('Move this Codex thread');
  });

  it('protects existing native threads unless force is set', () => {
    const bundle = packCodexSession({
      provider: 'codex-app',
      home: srcHome,
      sessionId: threadId,
    });

    unpackCodexSession(bundle, {
      provider: 'codex-app',
      home: dstHome,
      updateSqlite: false,
    });

    expect(() => unpackCodexSession(bundle, {
      provider: 'codex-app',
      home: dstHome,
      updateSqlite: false,
    })).toThrow('already exists');

    expect(() => unpackCodexSession(bundle, {
      provider: 'codex-app',
      home: dstHome,
      updateSqlite: false,
      force: true,
    })).not.toThrow();
  });

  it('can unpack in handoff mode without touching native session paths', () => {
    const bundle = packCodexSession({
      provider: 'codex-app',
      home: srcHome,
      sessionId: threadId,
    });

    const result = unpackCodexSession(bundle, {
      provider: 'codex-app',
      home: dstHome,
      mode: 'handoff',
      cwd: '/Users/bob/project',
    });

    expect(result.mode).toBe('handoff');
    expect(existsSync(join(result.path, 'session.jsonl'))).toBe(true);
    expect(readFileSync(join(result.path, 'handoff.md'), 'utf-8')).toContain('/Users/bob/project');
    expect(existsSync(join(dstHome, 'sessions'))).toBe(false);
  });

  it('rejects path traversal entries in Codex bundles', () => {
    const malicious = gzipSync(Buffer.from(JSON.stringify({
      manifest: {
        version: 2,
        kind: 'codex-session',
        provider: 'codex-app',
        threadId,
        title: 'bad',
        cwd: '/tmp/source',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceHome: '/tmp/source-home',
        originalSessionRelPath: 'sessions/2026/05/22/good.jsonl',
      },
      files: {
        'session.jsonl': Buffer.from('{}\n').toString('base64'),
        '../evil.txt': Buffer.from('owned').toString('base64'),
      },
    })));

    expect(() => unpackCodexSession(malicious, {
      provider: 'codex-app',
      home: dstHome,
      updateSqlite: false,
    })).toThrow('Path traversal');
  });
});
