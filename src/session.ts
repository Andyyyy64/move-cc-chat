import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface SessionMeta {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind?: string;
}

export interface SessionFiles {
  conversationPath: string;
  sessionMetaPath: string;
  encodedProjectDir: string;
  subagentDir: string | null;
  historyEntries: string[];
}

export function getClaudeDir(): string {
  return join(homedir(), '.claude');
}

export function encodeProjectPath(absolutePath: string): string {
  return absolutePath.replace(/\//g, '-') || '-';
}

export function listSessions(claudeDir?: string): SessionMeta[] {
  const dir = claudeDir ?? getClaudeDir();
  const sessionsDir = join(dir, 'sessions');

  if (!existsSync(sessionsDir)) return [];

  const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
  const sessions: SessionMeta[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(sessionsDir, file), 'utf-8');
      const meta: SessionMeta = JSON.parse(content);
      sessions.push(meta);
    } catch {
      // skip malformed files
    }
  }

  // sessionIdで重複除去（最新のstartedAtを優先）
  const deduped = new Map<string, SessionMeta>();
  for (const s of sessions) {
    const existing = deduped.get(s.sessionId);
    if (!existing || s.startedAt > existing.startedAt) {
      deduped.set(s.sessionId, s);
    }
  }

  return [...deduped.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getSessionFiles(claudeDir: string, session: SessionMeta): SessionFiles {
  const encodedProjectDir = encodeProjectPath(session.cwd);
  const projectDir = join(claudeDir, 'projects', encodedProjectDir);
  const conversationPath = join(projectDir, `${session.sessionId}.jsonl`);
  const sessionMetaPath = join(claudeDir, 'sessions', `${session.pid}.json`);

  const subagentCandidate = join(projectDir, session.sessionId);
  const subagentDir = existsSync(subagentCandidate) && statSync(subagentCandidate).isDirectory()
    ? subagentCandidate
    : null;

  const historyPath = join(claudeDir, 'history.jsonl');
  const historyEntries: string[] = [];
  if (existsSync(historyPath)) {
    const lines = readFileSync(historyPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId === session.sessionId) {
          historyEntries.push(line);
        }
      } catch {
        // skip malformed
      }
    }
  }

  return {
    conversationPath,
    sessionMetaPath,
    encodedProjectDir,
    subagentDir,
    historyEntries,
  };
}
