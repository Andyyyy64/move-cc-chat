import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export type CodexProvider = 'codex-app' | 'codex-cli';
export type CodexPullMode = 'native' | 'handoff';

export interface CodexSessionMeta {
  provider: CodexProvider;
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  sessionPath: string;
  source?: string;
  threadSource?: string;
  cliVersion?: string;
  model?: string;
  reasoningEffort?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
    repository_url?: string;
  };
}

export interface CodexPackOptions {
  provider?: CodexProvider;
  home?: string;
  sessionId?: string;
  current?: boolean;
  includeShellSnapshots?: boolean;
  includeGeneratedImages?: boolean;
}

export interface CodexUnpackOptions {
  provider?: CodexProvider;
  home?: string;
  mode?: CodexPullMode;
  cwd?: string | null;
  force?: boolean;
  updateSqlite?: boolean;
}

export interface CodexBundleManifest {
  version: 2;
  kind: 'codex-session';
  provider: CodexProvider;
  threadId: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  sourceHome: string;
  originalSessionRelPath: string;
  source?: string;
  threadSource?: string;
  cliVersion?: string;
  model?: string;
  reasoningEffort?: string;
  firstUserMessage?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
    repository_url?: string;
  };
}

export interface CodexBundlePreview {
  provider: CodexProvider;
  threadId: string;
  title: string;
  cwd: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: string;
  source?: string;
  threadSource?: string;
  cliVersion?: string;
  firstUserMessage?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
    repository_url?: string;
  };
  files: {
    totalBytes: number;
    sessionBytes: number;
    shellSnapshots: number;
    generatedImages: number;
    indexEntries: boolean;
    paths: string[];
  };
}

interface CodexBundleData {
  manifest: CodexBundleManifest;
  files: Record<string, string>;
}

interface ThreadRow {
  id: string;
  title: string;
  rollout_path?: string;
  cwd?: string;
  updated_at?: number;
  source?: string;
  thread_source?: string;
  cli_version?: string;
  model?: string;
  reasoning_effort?: string;
  git_branch?: string;
  git_origin_url?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function getDefaultCodexProvider(): CodexProvider {
  const envHome = process.env.CODEX_HOME;
  if (envHome && basename(envHome) === '.codex') return 'codex-cli';
  return 'codex-app';
}

export function getCodexHome(provider: CodexProvider = getDefaultCodexProvider()): string {
  const envHome = process.env.CODEX_HOME;
  if (envHome) {
    const envBase = basename(envHome);
    if (provider === 'codex-app' && envBase === '.codex-app') return envHome;
    if (provider === 'codex-cli' && envBase === '.codex') return envHome;
  }

  return join(homedir(), provider === 'codex-app' ? '.codex-app' : '.codex');
}

export function listCodexSessions(provider: CodexProvider = getDefaultCodexProvider(), home = getCodexHome(provider), limit?: number): CodexSessionMeta[] {
  const sqliteRows = readThreadRows(home, limit);
  const indexRows = readSessionIndex(home);
  let sessionPaths: Map<string, string> | null = null;
  const getSessionPaths = (): Map<string, string> => {
    sessionPaths ??= findCodexSessionFiles(home);
    return sessionPaths;
  };
  const byId = new Map<string, CodexSessionMeta>();

  for (const [id, row] of sqliteRows) {
    const sessionPath = row.rollout_path && existsSync(row.rollout_path)
      ? row.rollout_path
      : getSessionPaths().get(id);
    if (!sessionPath) continue;

    const fileMeta = (!row.title || !row.cwd) ? readSessionMetadata(sessionPath) : {};
    byId.set(id, {
      provider,
      id,
      title: row.title || indexRows.get(id)?.thread_name || fileMeta.title || id,
      cwd: row.cwd || fileMeta.cwd || '',
      updatedAt: row.updated_at ? new Date(row.updated_at * 1000).toISOString() : indexRows.get(id)?.updated_at || fileMeta.updatedAt || new Date(statSync(sessionPath).mtimeMs).toISOString(),
      sessionPath,
      source: row.source || fileMeta.source,
      threadSource: row.thread_source || fileMeta.threadSource,
      cliVersion: row.cli_version || fileMeta.cliVersion,
      model: row.model || fileMeta.model,
      reasoningEffort: row.reasoning_effort || fileMeta.reasoningEffort,
      git: {
        branch: row.git_branch || fileMeta.git?.branch,
        repository_url: row.git_origin_url || fileMeta.git?.repository_url,
        commit_hash: fileMeta.git?.commit_hash,
      },
    });
  }

  if (sqliteRows.size === 0) {
    for (const [id, index] of indexRows) {
      if (byId.has(id)) continue;
      const sessionPath = getSessionPaths().get(id);
      if (!sessionPath) continue;
      const fileMeta = readSessionMetadata(sessionPath);
      byId.set(id, {
        provider,
        id,
        title: index.thread_name || fileMeta.title || id,
        cwd: fileMeta.cwd || '',
        updatedAt: index.updated_at || fileMeta.updatedAt || new Date(statSync(sessionPath).mtimeMs).toISOString(),
        sessionPath,
        source: fileMeta.source,
        threadSource: fileMeta.threadSource,
        cliVersion: fileMeta.cliVersion,
        model: fileMeta.model,
        reasoningEffort: fileMeta.reasoningEffort,
        git: fileMeta.git,
      });
    }

    for (const [id, sessionPath] of getSessionPaths()) {
      if (byId.has(id)) continue;
      const fileMeta = readSessionMetadata(sessionPath);
      byId.set(id, {
        provider,
        id,
        title: fileMeta.title || id,
        cwd: fileMeta.cwd || '',
        updatedAt: fileMeta.updatedAt || new Date(statSync(sessionPath).mtimeMs).toISOString(),
        sessionPath,
        source: fileMeta.source,
        threadSource: fileMeta.threadSource,
        cliVersion: fileMeta.cliVersion,
        model: fileMeta.model,
        reasoningEffort: fileMeta.reasoningEffort,
        git: fileMeta.git,
      });
    }
  }

  return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function resolveCodexSession(options: CodexPackOptions = {}): CodexSessionMeta {
  const provider = options.provider ?? getDefaultCodexProvider();
  const home = options.home ?? getCodexHome(provider);
  const requestedId = options.current ? process.env.CODEX_THREAD_ID : options.sessionId;

  const sessions = listCodexSessions(provider, home);
  if (requestedId) {
    const match = sessions.find(s => s.id === requestedId || s.id.startsWith(requestedId));
    if (!match) throw new Error(`Codex session not found: ${requestedId}`);
    return match;
  }

  if (sessions.length === 0) {
    throw new Error(`No Codex sessions found in ${home}`);
  }

  return sessions[0];
}

export function packCodexSession(options: CodexPackOptions = {}): Buffer {
  const provider = options.provider ?? getDefaultCodexProvider();
  const home = options.home ?? getCodexHome(provider);
  const session = resolveCodexSession({ ...options, provider, home });
  const fileMeta = readSessionMetadata(session.sessionPath);
  const firstUserMessage = extractFirstUserMessage(session.sessionPath);
  const files: Record<string, string> = {};

  files['session.jsonl'] = readFileSync(session.sessionPath).toString('base64');

  const indexEntries = readSessionIndexLines(home, session.id);
  if (indexEntries.length > 0) {
    files['session_index.jsonl'] = Buffer.from(indexEntries.join('\n') + '\n').toString('base64');
  }

  if (options.includeShellSnapshots ?? true) {
    collectCodexShellSnapshots(home, session.id, files);
  }

  if ((options.includeGeneratedImages ?? true) && provider === 'codex-app') {
    const imageDir = join(home, 'generated_images', session.id);
    if (existsSync(imageDir) && statSync(imageDir).isDirectory()) {
      collectDir(imageDir, imageDir, files, `generated_images/${session.id}`);
    }
  }

  const manifest: CodexBundleManifest = {
    version: 2,
    kind: 'codex-session',
    provider,
    threadId: session.id,
    title: session.title,
    cwd: session.cwd || fileMeta.cwd || '',
    createdAt: new Date().toISOString(),
    updatedAt: session.updatedAt,
    sourceHome: home,
    originalSessionRelPath: relative(home, session.sessionPath),
    source: session.source || fileMeta.source,
    threadSource: session.threadSource || fileMeta.threadSource,
    cliVersion: session.cliVersion || fileMeta.cliVersion,
    model: session.model || fileMeta.model,
    reasoningEffort: session.reasoningEffort || fileMeta.reasoningEffort,
    firstUserMessage,
    git: session.git ?? fileMeta.git,
  };

  const bundleData: CodexBundleData = { manifest, files };
  return gzipSync(Buffer.from(JSON.stringify(bundleData)));
}

export function unpackCodexSession(bundle: Buffer, options: CodexUnpackOptions = {}): { threadId: string; cwd: string; path: string; mode: CodexPullMode } {
  const data = parseCodexBundle(bundle);
  const provider = options.provider ?? data.manifest.provider;
  const home = options.home ?? getCodexHome(provider);
  const mode = options.mode ?? 'native';
  const effectiveCwd = options.cwd ?? data.manifest.cwd;

  if (mode === 'handoff') {
    return unpackCodexHandoff(home, data, effectiveCwd);
  }

  return unpackCodexNative(home, data, effectiveCwd, options);
}

export function previewCodexBundle(bundle: Buffer): CodexBundlePreview {
  const data = parseCodexBundle(bundle);
  const { manifest, files } = data;
  const paths = Object.keys(files).sort();
  const byteLength = (relPath: string): number => Buffer.from(files[relPath], 'base64').length;

  return {
    provider: manifest.provider,
    threadId: manifest.threadId,
    title: manifest.title,
    cwd: manifest.cwd,
    updatedAt: manifest.updatedAt,
    model: manifest.model,
    reasoningEffort: manifest.reasoningEffort,
    source: manifest.source,
    threadSource: manifest.threadSource,
    cliVersion: manifest.cliVersion,
    firstUserMessage: manifest.firstUserMessage,
    git: manifest.git,
    files: {
      totalBytes: paths.reduce((sum, relPath) => sum + byteLength(relPath), 0),
      sessionBytes: files['session.jsonl'] ? byteLength('session.jsonl') : 0,
      shellSnapshots: paths.filter(relPath => relPath.startsWith('shell_snapshots/')).length,
      generatedImages: paths.filter(relPath => relPath.startsWith('generated_images/')).length,
      indexEntries: Boolean(files['session_index.jsonl']),
      paths,
    },
  };
}

function parseCodexBundle(bundle: Buffer): CodexBundleData {
  const data: CodexBundleData = JSON.parse(gunzipSync(bundle).toString('utf-8'));
  validateManifest(data.manifest);

  if (!data.files['session.jsonl']) {
    throw new Error('Invalid Codex bundle: missing session.jsonl');
  }

  for (const relPath of Object.keys(data.files)) {
    assertSafeRelativePath(relPath);
  }

  return data;
}

function unpackCodexNative(home: string, data: CodexBundleData, effectiveCwd: string, options: CodexUnpackOptions): { threadId: string; cwd: string; path: string; mode: CodexPullMode } {
  const { manifest, files } = data;
  const sessionRelPath = chooseSessionRelPath(manifest);
  const sessionPath = safeJoin(home, sessionRelPath);

  if (existsSync(sessionPath) && !options.force) {
    throw new Error(`Codex session already exists: ${sessionPath}. Re-run with --force to overwrite.`);
  }

  mkdirSync(dirname(sessionPath), { recursive: true });
  const sessionText = rewritePaths(Buffer.from(files['session.jsonl'], 'base64').toString('utf-8'), manifest.cwd, effectiveCwd);
  writeFileSync(sessionPath, sessionText);

  for (const [relPath, base64Content] of Object.entries(files)) {
    if (relPath === 'session.jsonl' || relPath === 'session_index.jsonl') continue;
    const content = Buffer.from(base64Content, 'base64');

    if (relPath.startsWith('shell_snapshots/')) {
      const targetPath = safeJoin(home, relPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, rewritePaths(content.toString('utf-8'), manifest.cwd, effectiveCwd));
    } else if (relPath.startsWith('generated_images/')) {
      const targetPath = safeJoin(home, relPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, content);
    }
  }

  appendSessionIndex(home, manifest, effectiveCwd);

  if (options.updateSqlite ?? true) {
    upsertThreadRow(home, manifest, sessionPath, effectiveCwd, Boolean(options.force));
  }

  return { threadId: manifest.threadId, cwd: effectiveCwd, path: sessionPath, mode: 'native' };
}

function unpackCodexHandoff(home: string, data: CodexBundleData, effectiveCwd: string): { threadId: string; cwd: string; path: string; mode: CodexPullMode } {
  const { manifest, files } = data;
  const importDir = join(home, 'imports', manifest.threadId);
  mkdirSync(importDir, { recursive: true });

  const sessionText = rewritePaths(Buffer.from(files['session.jsonl'], 'base64').toString('utf-8'), manifest.cwd, effectiveCwd);
  writeFileSync(join(importDir, 'session.jsonl'), sessionText);
  writeFileSync(join(importDir, 'handoff.md'), buildHandoffMarkdown(manifest, effectiveCwd, importDir));

  return { threadId: manifest.threadId, cwd: effectiveCwd, path: importDir, mode: 'handoff' };
}

function buildHandoffMarkdown(manifest: CodexBundleManifest, effectiveCwd: string, importDir: string): string {
  return [
    `# move-agent-chat handoff: ${manifest.title}`,
    '',
    `Thread ID: ${manifest.threadId}`,
    `Original cwd: ${manifest.cwd}`,
    `Target cwd: ${effectiveCwd}`,
    `Provider: ${manifest.provider}`,
    `Model: ${manifest.model ?? 'unknown'}`,
    '',
    'Open `session.jsonl` in this directory if you need the raw transcript, tool calls, and tool outputs.',
    '',
    'Suggested prompt for Codex:',
    '',
    '```text',
    `Continue this work from the transferred Codex session at this path: ${join(importDir, 'session.jsonl')}`,
    `The target project directory is: ${effectiveCwd}`,
    'Read the transcript and continue from the latest user request.',
    '```',
    '',
  ].join('\n');
}

function validateManifest(manifest: CodexBundleManifest): void {
  if (manifest.version !== 2) throw new Error(`Unsupported Codex bundle version: ${manifest.version}`);
  if (manifest.kind !== 'codex-session') throw new Error(`Unsupported Codex bundle kind: ${manifest.kind}`);
  if (!UUID_RE.test(manifest.threadId)) throw new Error(`Invalid Codex thread ID: ${manifest.threadId}`);
  if (manifest.provider !== 'codex-app' && manifest.provider !== 'codex-cli') {
    throw new Error(`Unsupported Codex provider: ${manifest.provider}`);
  }
  if (!manifest.cwd || typeof manifest.cwd !== 'string') throw new Error('Invalid Codex bundle cwd');
}

function readSessionIndex(home: string): Map<string, { thread_name?: string; updated_at?: string }> {
  const index = new Map<string, { thread_name?: string; updated_at?: string }>();
  const indexPath = join(home, 'session_index.jsonl');
  if (!existsSync(indexPath)) return index;

  for (const line of readFileSync(indexPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry.id) continue;
      const existing = index.get(entry.id);
      if (!existing || Date.parse(entry.updated_at ?? '') >= Date.parse(existing.updated_at ?? '')) {
        index.set(entry.id, { thread_name: entry.thread_name, updated_at: entry.updated_at });
      }
    } catch {
      // Ignore malformed index rows.
    }
  }

  return index;
}

function readSessionIndexLines(home: string, threadId: string): string[] {
  const indexPath = join(home, 'session_index.jsonl');
  if (!existsSync(indexPath)) return [];

  return readFileSync(indexPath, 'utf-8')
    .split('\n')
    .filter(line => {
      if (!line.trim()) return false;
      try {
        return JSON.parse(line).id === threadId;
      } catch {
        return false;
      }
    });
}

function appendSessionIndex(home: string, manifest: CodexBundleManifest, effectiveCwd: string): void {
  mkdirSync(home, { recursive: true });
  const indexPath = join(home, 'session_index.jsonl');
  const updatedAt = new Date().toISOString();
  appendFileSync(indexPath, JSON.stringify({
    id: manifest.threadId,
    thread_name: manifest.title,
    updated_at: updatedAt,
    cwd: effectiveCwd,
  }) + '\n');
}

function readThreadRows(home: string, limit?: number): Map<string, ThreadRow> {
  const dbPath = join(home, 'state_5.sqlite');
  if (!existsSync(dbPath) || !hasCommand('sqlite3')) return new Map();

  try {
    const columns = getSqliteColumns(dbPath, 'threads');
    const wanted = [
      'id',
      'title',
      'rollout_path',
      'cwd',
      'updated_at',
      'source',
      'thread_source',
      'cli_version',
      'model',
      'reasoning_effort',
      'git_branch',
      'git_origin_url',
    ];
    const selected = wanted.map(col => columns.includes(col) ? col : `NULL as ${col}`).join(', ');
    const limitClause = limit && Number.isFinite(limit) && limit > 0 ? ` order by updated_at desc limit ${Math.floor(limit)}` : '';
    const output = execFileSync('sqlite3', ['-json', dbPath, `select ${selected} from threads${limitClause};`], {
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const rows = JSON.parse(output || '[]') as ThreadRow[];
    return new Map(rows.filter(row => row.id).map(row => [row.id, row]));
  } catch {
    return new Map();
  }
}

function upsertThreadRow(home: string, manifest: CodexBundleManifest, sessionPath: string, effectiveCwd: string, force: boolean): void {
  const dbPath = join(home, 'state_5.sqlite');
  if (!existsSync(dbPath) || !hasCommand('sqlite3')) return;

  const columns = getSqliteColumns(dbPath, 'threads');
  if (columns.length === 0) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const existing = threadExists(dbPath, manifest.threadId);
  if (existing && !force) return;

  const values = new Map<string, string | number | null>([
    ['id', manifest.threadId],
    ['rollout_path', sessionPath],
    ['created_at', Math.floor(Date.parse(manifest.updatedAt) / 1000) || nowSec],
    ['updated_at', nowSec],
    ['source', manifest.source ?? 'vscode'],
    ['model_provider', 'openai'],
    ['cwd', effectiveCwd],
    ['title', manifest.title],
    ['sandbox_policy', 'unknown'],
    ['approval_mode', 'unknown'],
    ['tokens_used', 0],
    ['has_user_event', 1],
    ['archived', 0],
    ['archived_at', null],
    ['git_sha', manifest.git?.commit_hash ?? null],
    ['git_branch', manifest.git?.branch ?? null],
    ['git_origin_url', manifest.git?.repository_url ?? null],
    ['cli_version', manifest.cliVersion ?? ''],
    ['first_user_message', manifest.firstUserMessage ?? ''],
    ['agent_nickname', null],
    ['agent_role', null],
    ['memory_mode', 'enabled'],
    ['model', manifest.model ?? null],
    ['reasoning_effort', manifest.reasoningEffort ?? null],
    ['agent_path', null],
    ['created_at_ms', nowMs],
    ['updated_at_ms', nowMs],
    ['thread_source', manifest.threadSource ?? 'imported'],
    ['preview', manifest.firstUserMessage ?? ''],
  ]);

  const insertColumns = columns.filter(col => values.has(col));
  const insertValues = insertColumns.map(col => sqlLiteral(values.get(col) ?? null));
  const sql = `${force ? 'insert or replace' : 'insert or ignore'} into threads (${insertColumns.join(',')}) values (${insertValues.join(',')});`;

  try {
    execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf-8', timeout: 5000 });
  } catch {
    // A failed DB metadata update should not make a safely imported transcript unusable.
  }
}

function threadExists(dbPath: string, threadId: string): boolean {
  try {
    const output = execFileSync('sqlite3', [dbPath, `select count(*) from threads where id=${sqlLiteral(threadId)};`], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return output !== '0';
  } catch {
    return false;
  }
}

function getSqliteColumns(dbPath: string, table: string): string[] {
  try {
    const output = execFileSync('sqlite3', [dbPath, `pragma table_info(${table});`], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output.split('\n').filter(Boolean).map(line => line.split('|')[1]).filter(Boolean);
  } catch {
    return [];
  }
}

function sqlLiteral(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${value.replaceAll("'", "''")}'`;
}

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { encoding: 'utf-8', timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findCodexSessionFiles(home: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const dir of [join(home, 'sessions'), join(home, 'archived_sessions')]) {
    if (!existsSync(dir)) continue;
    for (const filePath of walkFiles(dir)) {
      if (!filePath.endsWith('.jsonl')) continue;
      const match = basename(filePath).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      if (match) files.set(match[0], filePath);
    }
  }
  return files;
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function readSessionMetadata(sessionPath: string): Partial<CodexSessionMeta> {
  const result: Partial<CodexSessionMeta> = {};
  let latestTimestamp = '';

  for (const line of readFileSync(sessionPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.timestamp) latestTimestamp = row.timestamp;
      if (row.type === 'session_meta') {
        const payload = row.payload ?? {};
        result.id = payload.id ?? result.id;
        result.cwd = payload.cwd ?? result.cwd;
        result.source = payload.source ?? result.source;
        result.threadSource = payload.thread_source ?? result.threadSource;
        result.cliVersion = payload.cli_version ?? result.cliVersion;
        result.git = payload.git ?? result.git;
      } else if (row.type === 'turn_context') {
        const payload = row.payload ?? {};
        result.cwd = payload.cwd ?? result.cwd;
        result.model = payload.model ?? result.model;
        result.reasoningEffort = payload.effort ?? result.reasoningEffort;
      }
    } catch {
      // Ignore malformed transcript rows.
    }
  }

  if (latestTimestamp) result.updatedAt = latestTimestamp;
  return result;
}

function extractFirstUserMessage(sessionPath: string): string | undefined {
  for (const line of readFileSync(sessionPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === 'event_msg' && row.payload?.type === 'user_message' && typeof row.payload.message === 'string') {
        return truncate(row.payload.message);
      }
      if (row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user') {
        const text = extractContentText(row.payload.content);
        if (text) return truncate(text);
      }
    } catch {
      // Ignore malformed transcript rows.
    }
  }
  return undefined;
}

function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map(item => {
      if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
        return item.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function truncate(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function collectCodexShellSnapshots(home: string, threadId: string, files: Record<string, string>): void {
  const dir = join(home, 'shell_snapshots');
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(`${threadId}.`)) continue;
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isFile()) {
      files[`shell_snapshots/${entry}`] = readFileSync(fullPath).toString('base64');
    }
  }
}

function collectDir(baseDir: string, currentDir: string, files: Record<string, string>, prefix: string): void {
  for (const entry of readdirSync(currentDir)) {
    const fullPath = join(currentDir, entry);
    const relPath = `${prefix}/${relative(baseDir, fullPath)}`;

    if (statSync(fullPath).isDirectory()) {
      collectDir(baseDir, fullPath, files, prefix);
    } else {
      files[relPath] = readFileSync(fullPath).toString('base64');
    }
  }
}

function chooseSessionRelPath(manifest: CodexBundleManifest): string {
  const rel = manifest.originalSessionRelPath;
  if (rel.startsWith(`sessions${sep}`) || rel.startsWith('sessions/')) {
    return rel;
  }

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return join('sessions', yyyy, mm, dd, `rollout-${now.toISOString().replaceAll(':', '-')}-${manifest.threadId}.jsonl`);
}

function assertSafeRelativePath(relPath: string): void {
  if (!relPath || relPath.includes('\0') || isAbsolute(relPath)) {
    throw new Error(`Unsafe bundle path: ${relPath}`);
  }

  const normalized = normalize(relPath);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`Path traversal detected in bundle: ${relPath}`);
  }
}

function safeJoin(baseDir: string, relPath: string): string {
  assertSafeRelativePath(relPath);
  const targetPath = join(baseDir, relPath);
  const resolved = normalize(targetPath);
  const resolvedBase = normalize(baseDir);
  if (!resolved.startsWith(resolvedBase + sep) && resolved !== resolvedBase) {
    throw new Error(`Path traversal detected: ${relPath}`);
  }
  return targetPath;
}

function rewritePaths(text: string, oldCwd: string, newCwd: string): string {
  if (!oldCwd || oldCwd === newCwd) return text;
  return text.replaceAll(oldCwd, newCwd);
}
