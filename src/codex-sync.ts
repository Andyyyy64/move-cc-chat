import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ROLLOUT_BYTES = 100 * 1024 * 1024;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_000;
const MAX_HASHED_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_HASHED_BYTES = 16 * 1024 * 1024;

export type HistoryMode = 'legacy' | 'paginated';
export type LineageRelation = 'missing' | 'identical' | 'source-ahead' | 'destination-ahead' | 'diverged';

export interface GitSnapshot {
  isRepository: boolean;
  root?: string;
  head?: string;
  branch?: string;
  remotes: string[];
  remoteIdentities: string[];
  trackedTreeHash?: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface DirectoryEntrySnapshot {
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  size?: number;
  contentHash?: string;
  hashKind?: 'sha256' | 'git-object';
}

export interface DirectorySnapshot {
  path: string;
  exists: boolean;
  realPath?: string;
  inventoryHash?: string;
  entries: DirectoryEntrySnapshot[];
  truncated: boolean;
  git: GitSnapshot;
}

export interface ThreadMetadataSnapshot {
  id: string;
  title: string;
  name?: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
  source: string;
  threadSource?: string;
  modelProvider: string;
  model?: string;
  reasoningEffort?: string;
  cliVersion?: string;
  firstUserMessage?: string;
  preview?: string;
  memoryMode?: string;
  sandboxPolicy?: string;
  approvalMode?: string;
  historyMode: HistoryMode;
  git?: {
    commitHash?: string;
    branch?: string;
    repositoryUrl?: string;
  };
}

export interface RolloutSummary {
  threadId: string;
  rolloutId: string;
  path: string;
  bytes: number;
  sha256: string;
  firstOrdinal: number;
  lastOrdinal: number;
  duplicateOrdinals: number;
  rowCount: number;
  historyMode: HistoryMode;
  sessionMeta: Record<string, unknown>;
  firstUserMessage?: string;
  lastTimestamp?: string;
}

export interface SyncBundleManifestV3 {
  schemaVersion: 3;
  kind: 'codex-local-thread';
  createdAt: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  rollout: {
    threadId: string;
    rolloutId: string;
    sha256: string;
    bytes: number;
    firstOrdinal: number;
    lastOrdinal: number;
    duplicateOrdinals: number;
    rowCount: number;
    historyMode: HistoryMode;
    originalFileName: string;
    relativePath: string;
  };
  thread: ThreadMetadataSnapshot;
  project: DirectorySnapshot;
  historyDependencies: Array<{
    rolloutId: string;
    threadId: string;
    relativePath: string;
    bytes: number;
    sha256: string;
    historyMode: HistoryMode;
    requiredEndOrdinalExclusive: number;
  }>;
  assets: Array<{ path: string; bytes: number; sha256: string }>;
}

export interface SyncBundleV3 {
  manifest: SyncBundleManifestV3;
  rolloutBase64: string;
  historyBase64: Record<string, string>;
  assets: Record<string, string>;
}

export interface LineageEvidence {
  relation: LineageRelation;
  sourceBytes: number;
  destinationBytes: number;
  sourceSha256: string;
  destinationSha256?: string;
  commonBytes: number;
  firstDifference?: {
    sourceOrdinal?: number;
    destinationOrdinal?: number;
    sourceType?: string;
    destinationType?: string;
  };
}

export interface ProjectComparison {
  targetPath?: string;
  source: DirectorySnapshot;
  destination?: DirectorySnapshot;
  candidates: DirectorySnapshot[];
  repositoryIdentity: 'missing-target' | 'same' | 'different' | 'not-git' | 'ambiguous';
  requiresAgentReview: boolean;
  reasons: string[];
  inventoryDiff?: {
    onlySource: string[];
    onlyDestination: string[];
    changed: string[];
    truncated: boolean;
  };
}

export interface ImportInspection {
  bundleSha256: string;
  threadId: string;
  title: string;
  targetHome: string;
  targetRolloutPath?: string;
  destinationRolloutPath?: string;
  lineage: LineageEvidence;
  rolloutSelection: {
    sourceRolloutId: string;
    destinationRolloutId?: string;
    relation: 'missing' | 'same' | 'source-branches-from-destination' | 'different';
    requiresAgentReview: boolean;
  };
  historyDependencies: Array<{
    rolloutId: string;
    threadId: string;
    targetPath: string;
    lineage: LineageEvidence;
    writerLocked: boolean;
  }>;
  project: ProjectComparison;
  writerLocked: boolean;
  canImport: boolean;
  action: 'create' | 'append' | 'switch' | 'noop' | 'blocked';
  blockers: string[];
  inspectionToken: string;
}

interface StateThreadRow {
  id: string;
  rollout_path: string;
  created_at?: number;
  updated_at?: number;
  source?: string;
  model_provider?: string;
  cwd?: string;
  title?: string;
  sandbox_policy?: string;
  approval_mode?: string;
  git_sha?: string | null;
  git_branch?: string | null;
  git_origin_url?: string | null;
  cli_version?: string;
  first_user_message?: string;
  memory_mode?: string;
  model?: string | null;
  reasoning_effort?: string | null;
  created_at_ms?: number | null;
  updated_at_ms?: number | null;
  thread_source?: string | null;
  preview?: string;
  history_mode?: string;
  name?: string | null;
}

export interface LocalThreadSummary {
  id: string;
  title: string;
  name?: string;
  cwd: string;
  updatedAtMs: number;
  rolloutPath: string;
  archived: boolean;
  historyMode: string;
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function discoverCodexHome(override?: string): string {
  if (override) return resolve(override);
  if (process.env.CODEX_HOME) return resolve(process.env.CODEX_HOME);
  const candidates = [join(homedir(), '.codex'), join(homedir(), '.codex-app')]
    .filter(candidate => existsSync(join(candidate, 'state_5.sqlite')) || existsSync(join(candidate, 'sessions')) || existsSync(join(candidate, 'session_index.jsonl')));
  const currentId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
  if (currentId && UUID_RE.test(currentId)) {
    const currentHome = candidates.find(candidate => stateDatabaseHasThread(candidate, currentId));
    if (currentHome) return currentHome;
  }
  if (candidates.length > 0) {
    return [...candidates].sort((a, b) => codexHomeMtime(b) - codexHomeMtime(a))[0];
  }
  return join(homedir(), '.codex');
}

function stateDatabaseHasThread(home: string, threadId: string): boolean {
  const path = join(home, 'state_5.sqlite');
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Boolean(db.prepare('SELECT 1 FROM threads WHERE id = ?').get(threadId));
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function codexHomeMtime(home: string): number {
  for (const path of [join(home, 'state_5.sqlite'), join(home, 'sessions'), join(home, 'session_index.jsonl')]) {
    if (existsSync(path)) return statSync(path).mtimeMs;
  }
  return 0;
}

export function findRolloutPath(home: string, threadId: string): string | undefined {
  validateThreadId(threadId);
  const statePath = join(home, 'state_5.sqlite');
  if (existsSync(statePath)) {
    const db = new DatabaseSync(statePath, { readOnly: true });
    try {
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId) as { rollout_path?: string } | undefined;
      if (row?.rollout_path && existsSync(row.rollout_path)) return row.rollout_path;
    } finally {
      db.close();
    }
  }

  for (const root of [join(home, 'sessions'), join(home, 'archived_sessions')]) {
    const found = findNamedFile(root, threadId);
    if (found) return found;
  }
  return undefined;
}

export function listLocalThreads(home = discoverCodexHome(), limit = 50): LocalThreadSummary[] {
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const statePath = join(home, 'state_5.sqlite');
  if (!existsSync(statePath)) return [];
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT id, title, name, cwd, updated_at, updated_at_ms, rollout_path, archived, history_mode
      FROM threads
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
      LIMIT ?
    `).all(boundedLimit) as unknown as Array<StateThreadRow & { archived?: number }>;
    return rows.map(row => ({
      id: row.id,
      title: row.name || row.title || row.id,
      name: row.name || undefined,
      cwd: row.cwd || '',
      updatedAtMs: row.updated_at_ms ?? (row.updated_at ?? 0) * 1000,
      rolloutPath: row.rollout_path,
      archived: row.archived === 1,
      historyMode: row.history_mode || 'legacy',
    }));
  } finally {
    db.close();
  }
}

export function readRollout(path: string, expectedThreadId?: string, expectedRolloutId?: string): { buffer: Buffer; summary: RolloutSummary } {
  const before = statSync(path);
  if (!before.isFile()) throw new Error(`Rollout is not a file: ${path}`);
  if (before.size > MAX_ROLLOUT_BYTES) throw new Error(`Rollout exceeds ${MAX_ROLLOUT_BYTES} bytes`);
  const buffer = readFileSync(path);
  const after = statSync(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('Rollout changed while it was being read; retry after the current write completes');
  }
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    throw new Error('Rollout must end with a complete newline-delimited JSON row');
  }

  const lines = buffer.toString('utf8').trimEnd().split('\n');
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      rows.push(JSON.parse(lines[index]) as Record<string, unknown>);
    } catch {
      throw new Error(`Malformed rollout JSON at row ${index + 1}`);
    }
  }
  if (rows[0]?.type !== 'session_meta') throw new Error('Rollout must begin with session_meta');
  const sessionMeta = asRecord(rows[0].payload);
  const historyMode = sessionMeta.history_mode === 'paginated' ? 'paginated' : 'legacy';
  let firstOrdinal = -1;
  let lastOrdinal = -1;
  let firstUserMessage: string | undefined;
  let lastTimestamp: string | undefined;
  let rowsWithOrdinal = 0;
  let duplicateOrdinals = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const ordinal = row.ordinal;
    if (ordinal !== undefined) {
      rowsWithOrdinal += 1;
      if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0) {
        throw new Error(`Invalid rollout ordinal at row ${index + 1}`);
      }
      if (lastOrdinal >= 0 && (ordinal as number) < lastOrdinal) {
        throw new Error(`Non-monotonic rollout ordinal at row ${index + 1}`);
      }
      if (lastOrdinal >= 0 && (ordinal as number) === lastOrdinal) duplicateOrdinals += 1;
      if (firstOrdinal < 0) firstOrdinal = ordinal as number;
      lastOrdinal = ordinal as number;
    }
    if (typeof row.timestamp === 'string') lastTimestamp = row.timestamp;
    if (!firstUserMessage) firstUserMessage = extractUserMessage(row);
  }
  if (historyMode === 'paginated' && rowsWithOrdinal !== rows.length) {
    throw new Error('Paginated rollout has missing ordinals');
  }
  if (historyMode === 'legacy' && rowsWithOrdinal !== 0 && rowsWithOrdinal !== rows.length) {
    throw new Error('Legacy rollout mixes rows with and without ordinals');
  }
  const threadId = readString(sessionMeta.id) || readString(sessionMeta.session_id);
  validateThreadId(threadId);
  if (expectedThreadId && threadId !== expectedThreadId) {
    throw new Error(`Rollout thread ID ${threadId} does not match expected ${expectedThreadId}`);
  }
  return {
    buffer,
    summary: {
      threadId,
      rolloutId: expectedRolloutId || rolloutIdForPath(path, threadId, historyMode),
      path,
      bytes: buffer.length,
      sha256: sha256(buffer),
      firstOrdinal,
      lastOrdinal,
      duplicateOrdinals,
      rowCount: lines.length,
      historyMode,
      sessionMeta,
      firstUserMessage,
      lastTimestamp,
    },
  };
}

export function buildSyncBundle(
  home: string,
  threadId: string,
  sourceDeviceId: string,
  targetDeviceId: string,
): SyncBundleV3 {
  validateThreadId(threadId);
  const rolloutPath = findRolloutPath(home, threadId);
  if (!rolloutPath) throw new Error(`Codex thread not found: ${threadId}`);
  const rolloutRelativePath = relative(home, rolloutPath).split(sep).join('/');
  if (rolloutRelativePath.startsWith('archived_sessions/')) {
    throw new Error('Archived Codex threads must be unarchived before upload');
  }
  const { buffer, summary } = readRollout(rolloutPath, threadId);
  const stateRow = readStateThread(home, threadId);
  const cwd = stateRow?.cwd || readString(summary.sessionMeta.cwd);
  if (!cwd) throw new Error(`Thread ${threadId} has no project cwd`);
  const title = stateRow?.name || stateRow?.title || summary.firstUserMessage || threadId;
  const createdAtMs = stateRow?.created_at_ms ?? (stateRow?.created_at ?? Date.now() / 1000) * 1000;
  const updatedAtMs = stateRow?.updated_at_ms ?? (Date.parse(summary.lastTimestamp || '') || statSync(rolloutPath).mtimeMs);
  const project = inspectDirectory(cwd);
  const thread: ThreadMetadataSnapshot = {
    id: threadId,
    title,
    name: stateRow?.name || undefined,
    cwd,
    createdAtMs,
    updatedAtMs,
    source: stateRow?.source || readString(summary.sessionMeta.source) || 'unknown',
    threadSource: stateRow?.thread_source || readString(summary.sessionMeta.thread_source) || undefined,
    modelProvider: stateRow?.model_provider || readString(summary.sessionMeta.model_provider) || 'openai',
    model: stateRow?.model || undefined,
    reasoningEffort: stateRow?.reasoning_effort || undefined,
    cliVersion: stateRow?.cli_version || readString(summary.sessionMeta.cli_version) || undefined,
    firstUserMessage: stateRow?.first_user_message || summary.firstUserMessage,
    preview: stateRow?.preview || summary.firstUserMessage,
    memoryMode: stateRow?.memory_mode || undefined,
    sandboxPolicy: stateRow?.sandbox_policy || undefined,
    approvalMode: stateRow?.approval_mode || undefined,
    historyMode: summary.historyMode,
    git: {
      commitHash: stateRow?.git_sha || readNestedString(summary.sessionMeta, 'git', 'commit_hash'),
      branch: stateRow?.git_branch || readNestedString(summary.sessionMeta, 'git', 'branch'),
      repositoryUrl: stateRow?.git_origin_url || readNestedString(summary.sessionMeta, 'git', 'repository_url'),
    },
  };

  const assets: Record<string, string> = {};
  const assetMetadata: SyncBundleManifestV3['assets'] = [];
  const historyBase64: Record<string, string> = {};
  const historyDependencies = collectHistoryDependencies(home, summary.sessionMeta, historyBase64);
  collectGeneratedImages(home, threadId, assets, assetMetadata);
  return {
    manifest: {
      schemaVersion: 3,
      kind: 'codex-local-thread',
      createdAt: new Date().toISOString(),
      sourceDeviceId,
      targetDeviceId,
      rollout: {
        threadId,
        rolloutId: summary.rolloutId,
        sha256: summary.sha256,
        bytes: buffer.length,
        firstOrdinal: summary.firstOrdinal,
        lastOrdinal: summary.lastOrdinal,
        duplicateOrdinals: summary.duplicateOrdinals,
        rowCount: summary.rowCount,
        historyMode: summary.historyMode,
        originalFileName: basename(rolloutPath),
        relativePath: rolloutRelativePath,
      },
      thread,
      project,
      historyDependencies,
      assets: assetMetadata,
    },
    rolloutBase64: buffer.toString('base64'),
    historyBase64,
    assets,
  };
}

export function validateSyncBundle(bundle: SyncBundleV3): Buffer {
  if (!bundle || typeof bundle !== 'object') throw new Error('Invalid transfer bundle');
  const manifest = bundle.manifest;
  if (manifest?.schemaVersion !== 3 || manifest.kind !== 'codex-local-thread') {
    throw new Error(`Unsupported sync bundle schema: ${manifest?.schemaVersion ?? 'missing'}`);
  }
  validateThreadId(manifest.rollout.threadId);
  validateThreadId(manifest.rollout.rolloutId);
  assertSafeHistoryPath(manifest.rollout.relativePath, manifest.rollout.rolloutId);
  if (manifest.thread.id !== manifest.rollout.threadId) throw new Error('Bundle thread IDs do not match');
  if (!manifest.sourceDeviceId || !manifest.targetDeviceId) throw new Error('Bundle device IDs are missing');
  const rollout = Buffer.from(bundle.rolloutBase64, 'base64');
  if (rollout.length !== manifest.rollout.bytes || sha256(rollout) !== manifest.rollout.sha256) {
    throw new Error('Rollout integrity check failed');
  }
  if (rollout.length > MAX_ROLLOUT_BYTES) throw new Error('Rollout exceeds size limit');
  const temporaryPath = join(tmpdir(), `.move-agent-chat-validate-${randomUUID()}.jsonl`);
  writeFileSync(temporaryPath, rollout, { mode: 0o600 });
  try {
    const validated = readRollout(temporaryPath, manifest.rollout.threadId, manifest.rollout.rolloutId).summary;
    if (
      validated.sha256 !== manifest.rollout.sha256 ||
      validated.rolloutId !== manifest.rollout.rolloutId ||
      validated.firstOrdinal !== manifest.rollout.firstOrdinal ||
      validated.lastOrdinal !== manifest.rollout.lastOrdinal ||
      validated.duplicateOrdinals !== manifest.rollout.duplicateOrdinals ||
      validated.rowCount !== manifest.rollout.rowCount
    ) {
      throw new Error('Rollout lineage metadata does not match content');
    }
  } finally {
    unlinkSync(temporaryPath);
  }
  const dependencyIds = new Set<string>();
  for (const dependency of manifest.historyDependencies) {
    validateThreadId(dependency.rolloutId);
    validateThreadId(dependency.threadId);
    if (dependencyIds.has(dependency.rolloutId)) throw new Error(`Duplicate history dependency: ${dependency.rolloutId}`);
    dependencyIds.add(dependency.rolloutId);
    assertSafeHistoryPath(dependency.relativePath, dependency.rolloutId);
    const encoded = bundle.historyBase64[dependency.rolloutId];
    if (!encoded) throw new Error(`Missing history dependency: ${dependency.rolloutId}`);
    const content = Buffer.from(encoded, 'base64');
    if (content.length !== dependency.bytes || sha256(content) !== dependency.sha256) {
      throw new Error(`History dependency integrity check failed: ${dependency.rolloutId}`);
    }
    const dependencyPath = join(tmpdir(), `.move-agent-chat-history-${randomUUID()}.jsonl`);
    writeFileSync(dependencyPath, content, { mode: 0o600 });
    try {
      const summary = readRollout(dependencyPath, undefined, dependency.rolloutId).summary;
      if (summary.threadId !== dependency.threadId || summary.historyMode !== dependency.historyMode) {
        throw new Error(`History dependency metadata mismatch: ${dependency.rolloutId}`);
      }
    } finally {
      unlinkSync(dependencyPath);
    }
  }
  let totalAssetBytes = 0;
  for (const asset of manifest.assets) {
    assertSafeAssetPath(asset.path, manifest.rollout.threadId);
    const encoded = bundle.assets[asset.path];
    if (!encoded) throw new Error(`Missing asset: ${asset.path}`);
    const content = Buffer.from(encoded, 'base64');
    totalAssetBytes += content.length;
    if (content.length !== asset.bytes || sha256(content) !== asset.sha256) {
      throw new Error(`Asset integrity check failed: ${asset.path}`);
    }
  }
  if (totalAssetBytes > MAX_ASSET_BYTES) throw new Error('Assets exceed size limit');
  return rollout;
}

export function classifyLineage(source: Buffer, destination?: Buffer): LineageEvidence {
  const sourceHash = sha256(source);
  if (!destination) {
    return {
      relation: 'missing',
      sourceBytes: source.length,
      destinationBytes: 0,
      sourceSha256: sourceHash,
      commonBytes: 0,
    };
  }
  const destinationHash = sha256(destination);
  if (source.equals(destination)) {
    return {
      relation: 'identical', sourceBytes: source.length, destinationBytes: destination.length,
      sourceSha256: sourceHash, destinationSha256: destinationHash, commonBytes: source.length,
    };
  }
  if (source.length > destination.length && source.subarray(0, destination.length).equals(destination)) {
    return {
      relation: 'source-ahead', sourceBytes: source.length, destinationBytes: destination.length,
      sourceSha256: sourceHash, destinationSha256: destinationHash, commonBytes: destination.length,
    };
  }
  if (destination.length > source.length && destination.subarray(0, source.length).equals(source)) {
    return {
      relation: 'destination-ahead', sourceBytes: source.length, destinationBytes: destination.length,
      sourceSha256: sourceHash, destinationSha256: destinationHash, commonBytes: source.length,
    };
  }
  let commonBytes = 0;
  const limit = Math.min(source.length, destination.length);
  while (commonBytes < limit && source[commonBytes] === destination[commonBytes]) commonBytes += 1;
  return {
    relation: 'diverged',
    sourceBytes: source.length,
    destinationBytes: destination.length,
    sourceSha256: sourceHash,
    destinationSha256: destinationHash,
    commonBytes,
    firstDifference: firstDifference(source, destination, commonBytes),
  };
}

export function inspectImport(bundle: SyncBundleV3, options: { home?: string; targetCwd?: string }): ImportInspection {
  const rollout = validateSyncBundle(bundle);
  const home = discoverCodexHome(options.home);
  const threadId = bundle.manifest.rollout.threadId;
  const destinationPath = findRolloutPath(home, threadId);
  const historyDependencies = bundle.manifest.historyDependencies.map(dependency => {
    const targetPath = safeJoin(home, dependency.relativePath);
    const local = existsSync(targetPath) ? readFileSync(targetPath) : undefined;
    const dependencyLineage = classifyLineage(Buffer.from(bundle.historyBase64[dependency.rolloutId], 'base64'), local);
    const dependencyWriterLocked = local
      ? isWriterLockOwned(join(home, 'thread-writer-locks', `${dependency.threadId}.lock`))
      : false;
    return {
      rolloutId: dependency.rolloutId,
      threadId: dependency.threadId,
      targetPath,
      lineage: dependencyLineage,
      writerLocked: dependencyWriterLocked,
    };
  });
  const destinationSummary = destinationPath ? readRollout(destinationPath, threadId).summary : undefined;
  const sourceRolloutId = bundle.manifest.rollout.rolloutId;
  const destinationRolloutId = destinationSummary?.rolloutId;
  const selectionRelation: ImportInspection['rolloutSelection']['relation'] = !destinationRolloutId
    ? 'missing'
    : destinationRolloutId === sourceRolloutId
      ? 'same'
      : bundle.manifest.historyDependencies.some(dependency => dependency.rolloutId === destinationRolloutId)
        ? 'source-branches-from-destination'
        : 'different';
  const targetRolloutPath = selectionRelation === 'same' && destinationPath
    ? destinationPath
    : safeJoin(home, bundle.manifest.rollout.relativePath);
  const targetExisting = existsSync(targetRolloutPath) ? readFileSync(targetRolloutPath) : undefined;
  const lineage = classifyLineage(rollout, targetExisting);
  const rolloutSelection: ImportInspection['rolloutSelection'] = {
    sourceRolloutId,
    destinationRolloutId,
    relation: selectionRelation,
    requiresAgentReview: selectionRelation === 'source-branches-from-destination',
  };
  const project = compareProject(home, bundle.manifest.project, options.targetCwd);
  const writerLocked = destinationPath ? isWriterLockOwned(join(home, 'thread-writer-locks', `${threadId}.lock`)) : false;
  const blockers: string[] = [];
  if (lineage.relation === 'diverged') blockers.push('Thread histories diverged and cannot be merged automatically');
  if (selectionRelation === 'different') blockers.push('Source and destination select unrelated rollout histories');
  if (writerLocked && (selectionRelation === 'same' || selectionRelation === 'source-branches-from-destination')) {
    blockers.push('Destination thread has a writer lock');
  }
  if (!project.targetPath || !project.destination?.exists) blockers.push('A valid destination project directory is required');
  for (const dependency of historyDependencies) {
    if (dependency.lineage.relation === 'diverged') blockers.push(`History dependency diverged: ${dependency.rolloutId}`);
    if (dependency.writerLocked && (dependency.lineage.relation === 'missing' || dependency.lineage.relation === 'source-ahead')) {
      blockers.push(`History dependency has a writer lock: ${dependency.rolloutId}`);
    }
  }
  const action = blockers.length > 0
    ? 'blocked'
    : selectionRelation === 'missing'
      ? 'create'
      : selectionRelation === 'source-branches-from-destination'
        ? 'switch'
        : lineage.relation === 'source-ahead'
          ? 'append'
          : 'noop';
  const bundleSha256 = sha256(Buffer.from(JSON.stringify(bundle)));
  const stateFingerprint = inspectionStateFingerprint({ bundleSha256, lineage, rolloutSelection, historyDependencies, project, writerLocked, destinationPath, targetRolloutPath });
  return {
    bundleSha256,
    threadId,
    title: bundle.manifest.thread.name || bundle.manifest.thread.title,
    targetHome: home,
    targetRolloutPath,
    destinationRolloutPath: destinationPath,
    lineage,
    rolloutSelection,
    historyDependencies,
    project,
    writerLocked,
    canImport: action !== 'blocked',
    action,
    blockers,
    inspectionToken: sha256(stateFingerprint),
  };
}

export function importInspectedBundle(
  bundle: SyncBundleV3,
  options: {
    home?: string;
    targetCwd?: string;
    inspectionToken: string;
    acceptProjectState?: boolean;
    acceptRolloutSwitch?: boolean;
  },
): { threadId: string; action: 'created' | 'appended' | 'switched' | 'noop'; rolloutPath: string; projectCwd: string } {
  const inspection = inspectImport(bundle, options);
  if (inspection.inspectionToken !== options.inspectionToken) {
    throw new Error('Inspection token is stale; inspect the transfer again before importing');
  }
  if (!inspection.canImport) throw new Error(inspection.blockers.join('; '));
  if (inspection.project.requiresAgentReview && options.acceptProjectState !== true) {
    throw new Error('Project or Git state requires explicit agent review before import');
  }
  if (inspection.rolloutSelection.requiresAgentReview && options.acceptRolloutSwitch !== true) {
    throw new Error('Changing the selected rollout requires explicit agent review before import');
  }
  const targetCwd = inspection.project.targetPath;
  if (!targetCwd) throw new Error('Destination project directory is missing');
  const rollout = validateSyncBundle(bundle);
  if (inspection.action === 'noop') {
    return {
      threadId: inspection.threadId,
      action: 'noop',
      rolloutPath: inspection.targetRolloutPath || findRolloutPath(inspection.targetHome, inspection.threadId) || '',
      projectCwd: targetCwd,
    };
  }

  const statePath = join(inspection.targetHome, 'state_5.sqlite');
  if (!existsSync(statePath)) throw new Error(`Codex state database is missing: ${statePath}`);
  const rolloutPath = inspection.targetRolloutPath || chooseNewRolloutPath(inspection.targetHome, bundle.manifest);
  const previousRollout = existsSync(rolloutPath) ? readFileSync(rolloutPath) : undefined;
  const indexPath = join(inspection.targetHome, 'session_index.jsonl');
  const previousIndex = existsSync(indexPath) ? readFileSync(indexPath) : undefined;
  const dependencyBackups = inspection.historyDependencies.map(dependency => ({
    path: dependency.targetPath,
    previous: existsSync(dependency.targetPath) ? readFileSync(dependency.targetPath) : undefined,
  }));
  mkdirSync(dirname(rolloutPath), { recursive: true });
  try {
    for (const dependency of inspection.historyDependencies) {
      if (dependency.lineage.relation === 'missing' || dependency.lineage.relation === 'source-ahead') {
        const content = Buffer.from(bundle.historyBase64[dependency.rolloutId], 'base64');
        atomicWrite(dependency.targetPath, content);
      }
    }
    if (inspection.lineage.relation === 'missing' || inspection.lineage.relation === 'source-ahead') {
      atomicWrite(rolloutPath, rollout);
    }
    importAssets(inspection.targetHome, bundle);
    updateSessionIndex(inspection.targetHome, bundle.manifest.thread);
    upsertNativeThread(inspection.targetHome, bundle.manifest.thread, rolloutPath, targetCwd, inspection.action === 'create');
  } catch (error) {
    restoreFile(rolloutPath, previousRollout);
    restoreFile(indexPath, previousIndex);
    for (const dependency of dependencyBackups) restoreFile(dependency.path, dependency.previous);
    throw error;
  }
  return {
    threadId: inspection.threadId,
    action: inspection.action === 'create' ? 'created' : inspection.action === 'switch' ? 'switched' : 'appended',
    rolloutPath,
    projectCwd: targetCwd,
  };
}

export function inspectDirectory(path: string): DirectorySnapshot {
  if (!path || !existsSync(path)) {
    return { path, exists: false, entries: [], truncated: false, git: emptyGitSnapshot() };
  }
  const realPath = realpathSync(path);
  const git = inspectGit(realPath);
  const entries = git.isRepository ? gitInventory(realPath) : filesystemInventory(realPath);
  return {
    path,
    exists: true,
    realPath,
    inventoryHash: sha256(JSON.stringify(entries.entries)),
    entries: entries.entries,
    truncated: entries.truncated,
    git,
  };
}

function compareProject(home: string, source: DirectorySnapshot, requestedTarget?: string): ProjectComparison {
  const candidates = discoverProjectCandidates(home, source);
  const targetPath = requestedTarget
    ? resolve(requestedTarget)
    : source.path && existsSync(source.path)
      ? resolve(source.path)
      : candidates.length === 1
        ? candidates[0].realPath
        : undefined;
  const destination = targetPath ? inspectDirectory(targetPath) : undefined;
  const reasons: string[] = [];
  const inventoryDiff = destination?.exists ? compareInventory(source, destination) : undefined;
  let repositoryIdentity: ProjectComparison['repositoryIdentity'];
  if (!destination?.exists) {
    repositoryIdentity = 'missing-target';
    reasons.push('Destination project directory is missing');
  } else if (source.git.isRepository && destination.git.isRepository) {
    const intersection = source.git.remoteIdentities.filter(value => destination.git.remoteIdentities.includes(value));
    repositoryIdentity = intersection.length > 0 ? 'same' : 'different';
    if (repositoryIdentity === 'different') reasons.push('Source and destination Git remote identities differ');
    if (source.git.head !== destination.git.head) reasons.push('Git HEAD differs');
    if (source.git.branch !== destination.git.branch) reasons.push('Git branch differs');
    if (destination.git.staged.length || destination.git.unstaged.length || destination.git.untracked.length) {
      reasons.push('Destination Git worktree has local changes');
    }
    if (source.git.trackedTreeHash !== destination.git.trackedTreeHash) reasons.push('Tracked Git inventories differ');
  } else if (source.git.isRepository !== destination.git.isRepository) {
    repositoryIdentity = 'different';
    reasons.push('Only one project directory is a Git repository');
  } else {
    repositoryIdentity = candidates.length > 1 ? 'ambiguous' : 'not-git';
    if (source.inventoryHash !== destination.inventoryHash) reasons.push('Directory inventories differ');
  }
  return {
    targetPath,
    source,
    destination,
    candidates,
    repositoryIdentity,
    requiresAgentReview: reasons.length > 0,
    reasons,
    inventoryDiff,
  };
}

function discoverProjectCandidates(home: string, source: DirectorySnapshot): DirectorySnapshot[] {
  const statePath = join(home, 'state_5.sqlite');
  if (!existsSync(statePath)) return [];
  const db = new DatabaseSync(statePath, { readOnly: true });
  const paths = new Set<string>();
  try {
    if (tableExists(db, 'project_roots')) {
      for (const row of db.prepare('SELECT path FROM project_roots LIMIT 100').all() as Array<{ path: string }>) paths.add(row.path);
    }
    for (const row of db.prepare('SELECT DISTINCT cwd FROM threads WHERE cwd != ? LIMIT 100').all('') as Array<{ cwd: string }>) paths.add(row.cwd);
  } finally {
    db.close();
  }
  const snapshots: DirectorySnapshot[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    if (source.git.isRepository) {
      const git = inspectGit(realpathSync(path));
      if (git.remoteIdentities.some(value => source.git.remoteIdentities.includes(value))) snapshots.push(inspectDirectory(path));
    } else if (basename(path).toLowerCase() === basename(source.path).toLowerCase()) {
      snapshots.push(inspectDirectory(path));
    }
    if (snapshots.length >= 10) break;
  }
  return snapshots;
}

function inspectGit(cwd: string): GitSnapshot {
  const run = (args: string[], encoding: BufferEncoding = 'utf8'): string => execFileSync('git', ['-C', cwd, ...args], {
    encoding,
    timeout: 5_000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }) as string;
  try {
    const root = run(['rev-parse', '--show-toplevel']).trim();
    const head = run(['rev-parse', 'HEAD']).trim();
    const branch = run(['branch', '--show-current']).trim() || undefined;
    const remoteLines = run(['remote', '-v']).split('\n').filter(Boolean);
    const remotes = [...new Set(remoteLines.map(line => line.split(/\s+/)[1]).filter(Boolean).map(sanitizeRemoteUrl))];
    const staged = run(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
    const unstaged = run(['diff', '--name-only', '-z']).split('\0').filter(Boolean);
    const untracked = run(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    const tracked = run(['ls-files', '-s', '-z']);
    return {
      isRepository: true,
      root,
      head,
      branch,
      remotes,
      remoteIdentities: remotes.map(normalizeRemoteIdentity).filter(Boolean),
      trackedTreeHash: sha256(tracked),
      staged: staged.sort(),
      unstaged: unstaged.sort(),
      untracked: untracked.sort(),
    };
  } catch {
    return emptyGitSnapshot();
  }
}

function gitInventory(cwd: string): { entries: DirectoryEntrySnapshot[]; truncated: boolean } {
  try {
    const output = execFileSync('git', ['-C', cwd, 'ls-files', '-s', '-z'], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 10 * 1024 * 1024,
    });
    const records = output.split('\0').filter(Boolean);
    const truncated = records.length > MAX_DIRECTORY_ENTRIES;
    return {
      entries: records.slice(0, MAX_DIRECTORY_ENTRIES).map(record => {
        const match = record.match(/^(\d+) ([0-9a-f]+) \d+\t(.+)$/);
        return match
          ? { path: match[3], kind: 'file' as const, contentHash: match[2], hashKind: 'git-object' as const }
          : { path: record, kind: 'file' as const };
      }),
      truncated,
    };
  } catch {
    return filesystemInventory(cwd);
  }
}

function filesystemInventory(root: string): { entries: DirectoryEntrySnapshot[]; truncated: boolean } {
  const entries: DirectoryEntrySnapshot[] = [];
  let hashedBytes = 0;
  const queue = [''];
  while (queue.length > 0 && entries.length < MAX_DIRECTORY_ENTRIES) {
    const parent = queue.shift() || '';
    const fullParent = join(root, parent);
    for (const entry of readdirSync(fullParent, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const relPath = parent ? join(parent, entry.name) : entry.name;
      const fullPath = join(root, relPath);
      if (entry.isDirectory()) {
        entries.push({ path: relPath, kind: 'directory' });
        queue.push(relPath);
      } else if (entry.isSymbolicLink()) {
        entries.push({ path: relPath, kind: 'symlink' });
      } else if (entry.isFile()) {
        const size = lstatSync(fullPath).size;
        const snapshot: DirectoryEntrySnapshot = { path: relPath, kind: 'file', size };
        if (size <= MAX_HASHED_FILE_BYTES && hashedBytes + size <= MAX_TOTAL_HASHED_BYTES) {
          snapshot.contentHash = sha256(readFileSync(fullPath));
          snapshot.hashKind = 'sha256';
          hashedBytes += size;
        }
        entries.push(snapshot);
      }
      if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
    }
  }
  return { entries, truncated: queue.length > 0 || entries.length >= MAX_DIRECTORY_ENTRIES };
}

function upsertNativeThread(home: string, source: ThreadMetadataSnapshot, rolloutPath: string, targetCwd: string, isNew: boolean): void {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  try {
    const columns = new Set((db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map(row => row.name));
    const nowMs = Date.now();
    const projectId = resolveDestinationProjectId(db, targetCwd);
    const values: Record<string, SQLInputValue> = {
      id: source.id,
      rollout_path: rolloutPath,
      created_at: Math.floor(source.createdAtMs / 1000),
      updated_at: Math.floor(source.updatedAtMs / 1000),
      source: source.source,
      model_provider: source.modelProvider,
      cwd: targetCwd,
      title: source.title,
      sandbox_policy: source.sandboxPolicy || 'unknown',
      approval_mode: source.approvalMode || 'unknown',
      tokens_used: 0,
      has_user_event: 1,
      archived: 0,
      archived_at: null,
      git_sha: source.git?.commitHash || null,
      git_branch: source.git?.branch || null,
      git_origin_url: source.git?.repositoryUrl || null,
      cli_version: source.cliVersion || '',
      first_user_message: source.firstUserMessage || '',
      agent_nickname: null,
      agent_role: null,
      memory_mode: source.memoryMode || 'enabled',
      model: source.model || null,
      reasoning_effort: source.reasoningEffort || null,
      agent_path: null,
      created_at_ms: source.createdAtMs,
      updated_at_ms: source.updatedAtMs,
      thread_source: source.threadSource || 'imported',
      preview: source.preview || source.firstUserMessage || '',
      recency_at: Math.floor(nowMs / 1000),
      recency_at_ms: nowMs,
      history_mode: source.historyMode,
      name: source.name || null,
      is_pinned: 0,
      thread_section_id: null,
      section_position: null,
      section_entered_at_ms: null,
      project_id: projectId,
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      if (isNew) {
        const insertColumns = Object.keys(values).filter(column => columns.has(column));
        const placeholders = insertColumns.map(column => `@${column}`).join(', ');
        const insertValues = Object.fromEntries(insertColumns.map(column => [column, values[column]]));
        db.prepare(`INSERT INTO threads (${insertColumns.join(', ')}) VALUES (${placeholders})`).run(insertValues);
      } else {
        const mutable = [
          'rollout_path', 'updated_at', 'updated_at_ms', 'recency_at', 'recency_at_ms',
          'cwd', 'title', 'preview', 'first_user_message', 'git_sha', 'git_branch',
          'git_origin_url', 'cli_version', 'model', 'reasoning_effort', 'history_mode',
        ].filter(column => columns.has(column));
        const assignment = mutable.map(column => `${column}=@${column}`).join(', ');
        const updateValues = Object.fromEntries([...mutable, 'id'].map(column => [column, values[column]]));
        db.prepare(`UPDATE threads SET ${assignment} WHERE id=@id`).run(updateValues);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original SQLite error */ }
      throw error;
    }
  } finally {
    db.close();
  }
}

function updateSessionIndex(home: string, thread: ThreadMetadataSnapshot): void {
  const path = join(home, 'session_index.jsonl');
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
  const kept = existing.filter(line => {
    try { return (JSON.parse(line) as { id?: string }).id !== thread.id; } catch { return true; }
  });
  kept.push(JSON.stringify({ id: thread.id, thread_name: thread.name || thread.title, updated_at: new Date(thread.updatedAtMs).toISOString() }));
  atomicWrite(path, Buffer.from(`${kept.join('\n')}\n`));
}

function importAssets(home: string, bundle: SyncBundleV3): void {
  for (const asset of bundle.manifest.assets) {
    assertSafeAssetPath(asset.path, bundle.manifest.rollout.threadId);
    const target = safeJoin(home, asset.path);
    mkdirSync(dirname(target), { recursive: true });
    atomicWrite(target, Buffer.from(bundle.assets[asset.path], 'base64'));
  }
}

function collectGeneratedImages(
  home: string,
  threadId: string,
  assets: Record<string, string>,
  metadata: SyncBundleManifestV3['assets'],
): void {
  const root = join(home, 'generated_images', threadId);
  if (!existsSync(root)) return;
  let total = 0;
  for (const path of walkFiles(root)) {
    const size = statSync(path).size;
    if (size > MAX_ASSET_BYTES - total) throw new Error('Generated images exceed asset size limit');
    const content = readFileSync(path);
    total += content.length;
    const relPath = join('generated_images', threadId, relative(root, path)).split(sep).join('/');
    assets[relPath] = content.toString('base64');
    metadata.push({ path: relPath, bytes: content.length, sha256: sha256(content) });
  }
}

function collectHistoryDependencies(
  home: string,
  sessionMeta: Record<string, unknown>,
  encoded: Record<string, string>,
  seen = new Set<string>(),
): SyncBundleManifestV3['historyDependencies'] {
  const historyBase = asRecord(sessionMeta.history_base);
  const rolloutId = readString(historyBase.thread_id);
  if (!rolloutId) return [];
  validateThreadId(rolloutId);
  if (seen.has(rolloutId)) throw new Error(`Cyclic history dependency: ${rolloutId}`);
  seen.add(rolloutId);
  const requiredBytes = historyBase.end_byte_offset;
  const requiredOrdinal = historyBase.end_ordinal_exclusive;
  if (!Number.isSafeInteger(requiredBytes) || (requiredBytes as number) <= 0) {
    throw new Error(`Invalid history dependency byte offset: ${rolloutId}`);
  }
  if (!Number.isSafeInteger(requiredOrdinal) || (requiredOrdinal as number) < 0) {
    throw new Error(`Invalid history dependency ordinal: ${rolloutId}`);
  }
  const path = findRolloutPathByRolloutId(home, rolloutId);
  if (!path) throw new Error(`Referenced history rollout not found: ${rolloutId}`);
  const { buffer } = readRollout(path);
  if ((requiredBytes as number) > buffer.length || buffer[(requiredBytes as number) - 1] !== 0x0a) {
    throw new Error(`History dependency offset is not a complete JSONL prefix: ${rolloutId}`);
  }
  const prefix = buffer.subarray(0, requiredBytes as number);
  const temporaryPath = join(tmpdir(), `.move-agent-chat-history-pack-${randomUUID()}.jsonl`);
  writeFileSync(temporaryPath, prefix, { mode: 0o600 });
  let summary: RolloutSummary;
  try {
    summary = readRollout(temporaryPath, undefined, rolloutId).summary;
  } finally {
    unlinkSync(temporaryPath);
  }
  const relativePath = relative(home, path).split(sep).join('/');
  assertSafeHistoryPath(relativePath, rolloutId);
  encoded[rolloutId] = prefix.toString('base64');
  const dependency: SyncBundleManifestV3['historyDependencies'][number] = {
    rolloutId,
    threadId: summary.threadId,
    relativePath,
    bytes: prefix.length,
    sha256: sha256(prefix),
    historyMode: summary.historyMode,
    requiredEndOrdinalExclusive: requiredOrdinal as number,
  };
  return [
    ...collectHistoryDependencies(home, summary.sessionMeta, encoded, seen),
    dependency,
  ];
}

function findRolloutPathByRolloutId(home: string, rolloutId: string): string | undefined {
  for (const root of [join(home, 'sessions'), join(home, 'archived_sessions')]) {
    if (!existsSync(root)) continue;
    for (const path of walkFiles(root)) {
      if (!path.endsWith('.jsonl')) continue;
      const ids = basename(path).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
      if (ids?.[ids.length - 1] === rolloutId) return path;
    }
  }
  return undefined;
}

function readStateThread(home: string, threadId: string): StateThreadRow | undefined {
  const path = join(home, 'state_5.sqlite');
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as StateThreadRow | undefined;
  } finally {
    db.close();
  }
}

function resolveDestinationProjectId(db: DatabaseSync, targetCwd: string): string | null {
  if (!tableExists(db, 'project_roots')) return null;
  const row = db.prepare('SELECT project_id FROM project_roots WHERE path = ? ORDER BY position LIMIT 1').get(targetCwd) as { project_id?: string } | undefined;
  return row?.project_id || null;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function chooseNewRolloutPath(home: string, manifest: SyncBundleManifestV3): string {
  const created = new Date(manifest.thread.createdAtMs);
  const yyyy = String(created.getFullYear());
  const mm = String(created.getMonth() + 1).padStart(2, '0');
  const dd = String(created.getDate()).padStart(2, '0');
  const safeName = /^rollout-[A-Za-z0-9_.:-]+\.jsonl$/.test(manifest.rollout.originalFileName)
    ? manifest.rollout.originalFileName
    : `rollout-${created.toISOString().replaceAll(':', '-')}-${manifest.rollout.threadId}.jsonl`;
  return safeJoin(home, join('sessions', yyyy, mm, dd, safeName));
}

function atomicWrite(path: string, content: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.move-agent-chat-${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { mode: 0o600 });
  try {
    renameSync(temporary, path);
    try { chmodSync(path, 0o600); } catch { /* Windows may not expose POSIX modes */ }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* ignore cleanup failure */ }
    throw error;
  }
}

function restoreFile(path: string, previous: Buffer | undefined): void {
  if (previous) {
    atomicWrite(path, previous);
    return;
  }
  try { unlinkSync(path); } catch { /* the file may not have been created */ }
}

function inspectionStateFingerprint(value: unknown): string {
  return stableStringify(value);
}

function isWriterLockOwned(path: string): boolean {
  if (!existsSync(path)) return false;
  if (process.platform === 'win32') {
    try {
      const descriptor = openSync(path, 'r+');
      closeSync(descriptor);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM';
    }
  }
  try {
    const output = execFileSync('lsof', ['-t', '--', path], {
      encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function compareInventory(source: DirectorySnapshot, destination: DirectorySnapshot): ProjectComparison['inventoryDiff'] {
  const sourceEntries = new Map(source.entries.map(entry => [entry.path, entry]));
  const destinationEntries = new Map(destination.entries.map(entry => [entry.path, entry]));
  const onlySource: string[] = [];
  const onlyDestination: string[] = [];
  const changed: string[] = [];
  for (const [path, sourceEntry] of sourceEntries) {
    const destinationEntry = destinationEntries.get(path);
    if (!destinationEntry) {
      onlySource.push(path);
      continue;
    }
    if (
      sourceEntry.kind !== destinationEntry.kind ||
      sourceEntry.size !== destinationEntry.size ||
      sourceEntry.contentHash !== destinationEntry.contentHash ||
      sourceEntry.hashKind !== destinationEntry.hashKind
    ) {
      changed.push(path);
    }
  }
  for (const path of destinationEntries.keys()) {
    if (!sourceEntries.has(path)) onlyDestination.push(path);
  }
  const limit = 100;
  return {
    onlySource: onlySource.sort().slice(0, limit),
    onlyDestination: onlyDestination.sort().slice(0, limit),
    changed: changed.sort().slice(0, limit),
    truncated: source.truncated || destination.truncated || onlySource.length > limit || onlyDestination.length > limit || changed.length > limit,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function firstDifference(source: Buffer, destination: Buffer, commonBytes: number): LineageEvidence['firstDifference'] {
  const lineStart = Math.max(0, source.lastIndexOf(0x0a, Math.max(0, commonBytes - 1)) + 1);
  const sourceEnd = source.indexOf(0x0a, commonBytes);
  const destinationEnd = destination.indexOf(0x0a, commonBytes);
  const sourceRow = parseRowSlice(source, lineStart, sourceEnd < 0 ? source.length : sourceEnd);
  const destinationRow = parseRowSlice(destination, lineStart, destinationEnd < 0 ? destination.length : destinationEnd);
  return {
    sourceOrdinal: typeof sourceRow?.ordinal === 'number' ? sourceRow.ordinal : undefined,
    destinationOrdinal: typeof destinationRow?.ordinal === 'number' ? destinationRow.ordinal : undefined,
    sourceType: readString(sourceRow?.type),
    destinationType: readString(destinationRow?.type),
  };
}

function parseRowSlice(buffer: Buffer, start: number, end: number): Record<string, unknown> | undefined {
  try { return JSON.parse(buffer.subarray(start, end).toString('utf8')) as Record<string, unknown>; } catch { return undefined; }
}

function extractUserMessage(row: Record<string, unknown>): string | undefined {
  const payload = asRecord(row.payload);
  if (row.type === 'event_msg' && payload.type === 'user_message') return truncate(readString(payload.message));
  if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    const content = Array.isArray(payload.content) ? payload.content : [];
    const text = content.map(item => readString(asRecord(item).text)).filter(Boolean).join('\n');
    return truncate(text);
  }
  return undefined;
}

function truncate(value: string, max = 4_000): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function readNestedString(record: Record<string, unknown>, key: string, nested: string): string | undefined {
  return readString(asRecord(record[key])[nested]) || undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function validateThreadId(threadId: string): void {
  if (!UUID_RE.test(threadId)) throw new Error(`Invalid Codex thread ID: ${threadId}`);
}

function rolloutIdForPath(path: string, threadId: string, historyMode: HistoryMode): string {
  if (historyMode === 'legacy') return threadId;
  const ids = basename(path).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
  const rolloutId = ids?.[ids.length - 1];
  if (!rolloutId) throw new Error(`Paginated rollout has no immutable rollout ID in its filename: ${path}`);
  return rolloutId;
}

function findNamedFile(root: string, threadId: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findNamedFile(full, threadId);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
      try {
        const firstLine = readFirstLine(full);
        const row = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; session_id?: string } };
        if (row.type === 'session_meta' && (row.payload?.id === threadId || row.payload?.session_id === threadId)) return full;
      } catch {
        // Ignore filename collisions and malformed candidates; full validation happens after resolution.
      }
    }
  }
  return undefined;
}

function readFirstLine(path: string): string {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytes).indexOf(0x0a);
    if (newline < 0) throw new Error('session_meta exceeds first-line limit');
    return buffer.subarray(0, newline).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function walkFiles(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(full));
    else if (entry.isFile()) output.push(full);
  }
  return output;
}

function sanitizeRemoteUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return value.replace(/^[^@\s]+@/, '');
  }
}

function normalizeRemoteIdentity(value: string): string {
  const sanitized = sanitizeRemoteUrl(value).trim();
  if (!sanitized) return '';
  const scp = sanitized.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scp && !sanitized.includes('://')) return `${scp[1].toLowerCase()}/${scp[2].replace(/\.git$/, '').replace(/^\//, '')}`;
  try {
    const parsed = new URL(sanitized);
    return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\//, '').replace(/\.git$/, '')}`;
  } catch {
    return sanitized.replace(/\.git$/, '').toLowerCase();
  }
}

function emptyGitSnapshot(): GitSnapshot {
  return { isRepository: false, remotes: [], remoteIdentities: [], staged: [], unstaged: [], untracked: [] };
}

function assertSafeAssetPath(path: string, threadId: string): void {
  const normalized = path.split('\\').join('/');
  if (!normalized.startsWith(`generated_images/${threadId}/`) || normalized.includes('\0') || normalized.split('/').includes('..') || isAbsolute(path)) {
    throw new Error(`Unsafe asset path: ${path}`);
  }
}

function assertSafeHistoryPath(path: string, rolloutId: string): void {
  const normalized = path.split('\\').join('/');
  const ids = basename(normalized).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
  if (
    (!normalized.startsWith('sessions/') && !normalized.startsWith('archived_sessions/')) ||
    normalized.includes('\0') ||
    normalized.split('/').includes('..') ||
    isAbsolute(path) ||
    ids?.[ids.length - 1] !== rolloutId
  ) {
    throw new Error(`Unsafe history dependency path: ${path}`);
  }
}

function safeJoin(root: string, relPath: string): string {
  const target = resolve(root, relPath);
  const base = resolve(root);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error(`Path escapes Codex home: ${relPath}`);
  return target;
}
