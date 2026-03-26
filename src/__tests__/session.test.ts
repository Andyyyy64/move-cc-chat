import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSessions, getSessionFiles, encodeProjectPath } from '../session.js';

describe('encodeProjectPath', () => {
  it('converts absolute path to encoded directory name', () => {
    expect(encodeProjectPath('/home/andy/project/work/my-app'))
      .toBe('-home-andy-project-work-my-app');
  });

  it('handles root path', () => {
    expect(encodeProjectPath('/')).toBe('-');
  });

  it('handles Windows backslash paths', () => {
    expect(encodeProjectPath('C:\\Users\\alice\\project'))
      .toBe('C-Users-alice-project');
  });

  it('handles Windows drive colon', () => {
    expect(encodeProjectPath('C:\\dev'))
      .toBe('C-dev');
  });
});

describe('listSessions', () => {
  let claudeDir: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'move-chat-test-'));
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it('returns empty array when no sessions exist', () => {
    const result = listSessions(claudeDir);
    expect(result).toEqual([]);
  });

  it('returns sessions sorted by startedAt descending', () => {
    writeFileSync(
      join(claudeDir, 'sessions', '100.json'),
      JSON.stringify({ pid: 100, sessionId: 'aaa', cwd: '/tmp/a', startedAt: 1000, kind: 'interactive' })
    );
    writeFileSync(
      join(claudeDir, 'sessions', '200.json'),
      JSON.stringify({ pid: 200, sessionId: 'bbb', cwd: '/tmp/b', startedAt: 2000, kind: 'interactive' })
    );

    const result = listSessions(claudeDir);
    expect(result).toHaveLength(2);
    expect(result[0].sessionId).toBe('bbb');
    expect(result[1].sessionId).toBe('aaa');
  });
});

describe('getSessionFiles', () => {
  let claudeDir: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'move-chat-test-'));
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it('collects conversation jsonl and session meta', () => {
    const sessionId = 'test-session-id';
    const projectDir = join(claudeDir, 'projects', '-tmp-myproject');
    const sessionsDir = join(claudeDir, 'sessions');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(join(projectDir, `${sessionId}.jsonl`), '{"type":"user"}\n');
    writeFileSync(
      join(sessionsDir, '100.json'),
      JSON.stringify({ pid: 100, sessionId, cwd: '/tmp/myproject', startedAt: 1000 })
    );

    const files = getSessionFiles(claudeDir, {
      pid: 100, sessionId, cwd: '/tmp/myproject', startedAt: 1000, kind: 'interactive'
    });

    expect(files.conversationPath).toBe(join(projectDir, `${sessionId}.jsonl`));
    expect(files.sessionMetaPath).toBe(join(sessionsDir, '100.json'));
    expect(files.encodedProjectDir).toBe('-tmp-myproject');
  });

  it('detects subagent directory if present', () => {
    const sessionId = 'test-session-id';
    const projectDir = join(claudeDir, 'projects', '-tmp-myproject');
    const subagentDir = join(projectDir, sessionId, 'subagents');
    mkdirSync(subagentDir, { recursive: true });
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true });

    writeFileSync(join(projectDir, `${sessionId}.jsonl`), '{"type":"user"}\n');
    writeFileSync(join(subagentDir, 'agent-abc.jsonl'), '{}');
    writeFileSync(
      join(claudeDir, 'sessions', '100.json'),
      JSON.stringify({ pid: 100, sessionId, cwd: '/tmp/myproject', startedAt: 1000 })
    );

    const files = getSessionFiles(claudeDir, {
      pid: 100, sessionId, cwd: '/tmp/myproject', startedAt: 1000, kind: 'interactive'
    });

    expect(files.subagentDir).toBe(join(projectDir, sessionId));
  });
});
