import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  buildSyncBundle,
  classifyLineage,
  findRolloutPath,
  importInspectedBundle,
  inspectImport,
  listLocalThreads,
  readRollout,
  validateSyncBundle,
  type SyncBundleV3,
} from '../codex-sync.js';
import {
  MemoryTransferStore,
  downloadInboxBundle,
  listDevices,
  listInbox,
  registerDevice,
  uploadForDevice,
} from '../device-inbox.js';

const SOURCE_DEVICE = 'a'.repeat(32);
const TARGET_DEVICE = 'b'.repeat(32);

describe('Codex v3 local thread transfer', () => {
  it('imports a missing thread, rereads it, and makes re-import idempotent', () => {
    const fixture = createFixture();
    const bundle = buildSyncBundle(fixture.sourceHome, fixture.threadId, SOURCE_DEVICE, TARGET_DEVICE);
    const inspection = inspectImport(bundle, { home: fixture.destinationHome, targetCwd: fixture.destinationProject });

    expect(inspection.lineage.relation).toBe('missing');
    expect(inspection.action).toBe('create');
    expect(inspection.canImport).toBe(true);

    const imported = importInspectedBundle(bundle, {
      home: fixture.destinationHome,
      targetCwd: fixture.destinationProject,
      inspectionToken: inspection.inspectionToken,
    });
    expect(imported.action).toBe('created');
    expect(readFileSync(imported.rolloutPath)).toEqual(readFileSync(fixture.sourceRollout));
    expect(listLocalThreads(fixture.destinationHome)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.threadId, cwd: fixture.destinationProject }),
    ]));

    const secondInspection = inspectImport(bundle, { home: fixture.destinationHome, targetCwd: fixture.destinationProject });
    expect(secondInspection.lineage.relation).toBe('identical');
    const secondImport = importInspectedBundle(bundle, {
      home: fixture.destinationHome,
      targetCwd: fixture.destinationProject,
      inspectionToken: secondInspection.inspectionToken,
    });
    expect(secondImport.action).toBe('noop');
  });

  it('appends only exact source-ahead lineage and preserves destination organization', () => {
    const fixture = createFixture();
    const initial = buildSyncBundle(fixture.sourceHome, fixture.threadId, SOURCE_DEVICE, TARGET_DEVICE);
    const initialInspection = inspectImport(initial, { home: fixture.destinationHome, targetCwd: fixture.destinationProject });
    importInspectedBundle(initial, {
      home: fixture.destinationHome,
      targetCwd: fixture.destinationProject,
      inspectionToken: initialInspection.inspectionToken,
    });
    const destinationRollout = findDestinationRollout(fixture.destinationHome, fixture.threadId);
    const db = new DatabaseSync(join(fixture.destinationHome, 'state_5.sqlite'));
    db.prepare(`UPDATE threads SET project_id='destination-project', is_pinned=1, thread_section_id='section-a', section_position=7, name='Destination name', archived=1 WHERE id=?`).run(fixture.threadId);
    db.close();
    writeFileSync(fixture.sourceRollout, rollout(fixture.threadId, fixture.sourceProject, ['source suffix']));
    const ahead = buildSyncBundle(fixture.sourceHome, fixture.threadId, SOURCE_DEVICE, TARGET_DEVICE);
    const inspection = inspectImport(ahead, { home: fixture.destinationHome, targetCwd: fixture.destinationProject });
    expect(inspection.lineage.relation).toBe('source-ahead');
    expect(inspection.action).toBe('append');
    importInspectedBundle(ahead, {
      home: fixture.destinationHome,
      targetCwd: fixture.destinationProject,
      inspectionToken: inspection.inspectionToken,
    });
    expect(readFileSync(destinationRollout)).toEqual(Buffer.from(ahead.rolloutBase64, 'base64'));
    const verify = new DatabaseSync(join(fixture.destinationHome, 'state_5.sqlite'), { readOnly: true });
    const organization = verify.prepare('SELECT project_id,is_pinned,thread_section_id,section_position,name,archived FROM threads WHERE id=?').get(fixture.threadId);
    verify.close();
    expect(organization).toEqual({
      project_id: 'destination-project',
      is_pinned: 1,
      thread_section_id: 'section-a',
      section_position: 7,
      name: 'Destination name',
      archived: 1,
    });
  });

  it('classifies destination-ahead and diverged histories without overwriting', () => {
    const fixture = createFixture();
    const source = readFileSync(fixture.sourceRollout);
    const destinationAhead = rollout(fixture.threadId, fixture.sourceProject, ['destination suffix']);
    expect(classifyLineage(source, destinationAhead).relation).toBe('destination-ahead');

    const sourceDiverged = rollout(fixture.threadId, fixture.sourceProject, ['source suffix']);
    expect(classifyLineage(sourceDiverged, destinationAhead)).toEqual(expect.objectContaining({
      relation: 'diverged',
      firstDifference: expect.objectContaining({ sourceType: 'event_msg', destinationType: 'event_msg' }),
    }));
  });

  it('blocks a same-ID writer lock and a stale inspection token', () => {
    const fixture = createFixture();
    const initial = buildSyncBundle(fixture.sourceHome, fixture.threadId, SOURCE_DEVICE, TARGET_DEVICE);
    const first = inspectImport(initial, { home: fixture.destinationHome, targetCwd: fixture.destinationProject });
    importInspectedBundle(initial, {
      home: fixture.destinationHome,
      targetCwd: fixture.destinationProject,
      inspectionToken: first.inspectionToken,
    });
    writeFileSync(fixture.sourceRollout, rollout(fixture.threadId, fixture.sourceProject, ['source suffix']));
    const ahead = buildSyncBundle(fixture.sourceHome, fixture.threadId, SOURCE_DEVICE, TARGET_DEVICE);
    const inspection = inspectImport(ahead, { home: fixture.destinationHome, targetCwd: fixture.destinationProject });
    mkdirSync(join(fixture.destinationHome, 'thread-writer-locks'), { recursive: true });
    const lockPath = join(fixture.destinationHome, 'thread-writer-locks', `${fixture.threadId}.lock`);
    writeFileSync(lockPath, '');
    const lockDescriptor = openSync(lockPath, 'r+');
    try {
      expect(() => importInspectedBundle(ahead, {
        home: fixture.destinationHome,
        targetCwd: fixture.destinationProject,
        inspectionToken: inspection.inspectionToken,
      })).toThrow('Inspection token is stale');
      const locked = inspectImport(ahead, { home: fixture.destinationHome, targetCwd: fixture.destinationProject });
      expect(locked.blockers).toContain('Destination thread has a writer lock');
    } finally {
      closeSync(lockDescriptor);
    }
  });

  it('rolls back new rollout and index files when native SQLite registration fails', () => {
    const fixture = createFixture();
    const db = new DatabaseSync(join(fixture.destinationHome, 'state_5.sqlite'));
    db.exec(`CREATE TRIGGER reject_thread_insert BEFORE INSERT ON threads BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END;`);
    db.close();
    const indexPath = join(fixture.destinationHome, 'session_index.jsonl');
    writeFileSync(indexPath, '{"id":"existing","thread_name":"Existing","updated_at":"2026-01-01T00:00:00Z"}\n');
    const beforeIndex = readFileSync(indexPath);
    const bundle = buildSyncBundle(fixture.sourceHome, fixture.threadId, SOURCE_DEVICE, TARGET_DEVICE);
    const inspection = inspectImport(bundle, { home: fixture.destinationHome, targetCwd: fixture.destinationProject });

    expect(() => importInspectedBundle(bundle, {
      home: fixture.destinationHome,
      targetCwd: fixture.destinationProject,
      inspectionToken: inspection.inspectionToken,
    })).toThrow('fixture rejection');
    expect(findRolloutPath(fixture.destinationHome, fixture.threadId)).toBeUndefined();
    expect(readFileSync(indexPath)).toEqual(beforeIndex);
  });

  it('packs, inspects, and restores the exact history-base rollout prefix', () => {
    const fixture = createFixture();
    const historyThreadId = randomUUID();
    const historyRolloutId = randomUUID();
    const requiredPrefix = rollout(historyThreadId, fixture.sourceProject);
    const fullHistory = rollout(historyThreadId, fixture.sourceProject, ['not part of the child history']);
    const historyRelativePath = join('sessions', '2026', '08', '31', `rollout-2026-08-31T00-00-00-${historyThreadId}_${historyRolloutId}.jsonl`);
    const historyPath = join(fixture.sourceHome, historyRelativePath);
    mkdirSync(join(historyPath, '..'), { recursive: true });
    writeFileSync(historyPath, fullHistory);
    writeFileSync(fixture.sourceRollout, rolloutWithHistoryBase(
      fixture.threadId,
      fixture.sourceProject,
      historyRolloutId,
      requiredPrefix.length,
      3,
    ));

    const bundle = buildSyncBundle(fixture.sourceHome, fixture.threadId, SOURCE_DEVICE, TARGET_DEVICE);
    expect(bundle.manifest.historyDependencies).toEqual([
      expect.objectContaining({
        rolloutId: historyRolloutId,
        threadId: historyThreadId,
        bytes: requiredPrefix.length,
      }),
    ]);
    const inspection = inspectImport(bundle, { home: fixture.destinationHome, targetCwd: fixture.destinationProject });
    expect(inspection.historyDependencies).toEqual([
      expect.objectContaining({ rolloutId: historyRolloutId, lineage: expect.objectContaining({ relation: 'missing' }) }),
    ]);
    importInspectedBundle(bundle, {
      home: fixture.destinationHome,
      targetCwd: fixture.destinationProject,
      inspectionToken: inspection.inspectionToken,
    });
    expect(readFileSync(join(fixture.destinationHome, historyRelativePath))).toEqual(requiredPrefix);
  });

  it('preserves the old rollout and explicitly switches a reverted thread to its descendant rollout', () => {
    const fixture = createFixture();
    const baseRolloutId = randomUUID();
    const selectedRolloutId = randomUUID();
    const basePrefix = rollout(fixture.threadId, fixture.sourceProject);
    const baseRelativePath = join('sessions', '2026', '08', '31', `rollout-2026-08-31T00-00-00-${fixture.threadId}_${baseRolloutId}.jsonl`);
    const sourceBasePath = join(fixture.sourceHome, baseRelativePath);
    const destinationBasePath = join(fixture.destinationHome, baseRelativePath);
    mkdirSync(join(sourceBasePath, '..'), { recursive: true });
    mkdirSync(join(destinationBasePath, '..'), { recursive: true });
    writeFileSync(sourceBasePath, basePrefix);
    writeFileSync(destinationBasePath, basePrefix);
    const selectedRelativePath = join('sessions', '2026', '09', '01', `rollout-2026-09-01T00-00-00-${fixture.threadId}_${selectedRolloutId}.jsonl`);
    const selectedPath = join(fixture.sourceHome, selectedRelativePath);
    mkdirSync(join(selectedPath, '..'), { recursive: true });
    writeFileSync(selectedPath, rolloutWithHistoryBase(
      fixture.threadId,
      fixture.sourceProject,
      baseRolloutId,
      basePrefix.length,
      3,
    ));
    const sourceDb = new DatabaseSync(join(fixture.sourceHome, 'state_5.sqlite'));
    sourceDb.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(selectedPath, fixture.threadId);
    sourceDb.close();
    insertThread(fixture.destinationHome, fixture.threadId, destinationBasePath, fixture.destinationProject);

    const bundle = buildSyncBundle(fixture.sourceHome, fixture.threadId, SOURCE_DEVICE, TARGET_DEVICE);
    const inspection = inspectImport(bundle, { home: fixture.destinationHome, targetCwd: fixture.destinationProject });
    expect(inspection.rolloutSelection).toEqual(expect.objectContaining({
      sourceRolloutId: selectedRolloutId,
      destinationRolloutId: baseRolloutId,
      relation: 'source-branches-from-destination',
      requiresAgentReview: true,
    }));
    expect(inspection.action).toBe('switch');
    expect(() => importInspectedBundle(bundle, {
      home: fixture.destinationHome,
      targetCwd: fixture.destinationProject,
      inspectionToken: inspection.inspectionToken,
    })).toThrow('Changing the selected rollout requires explicit agent review');
    const imported = importInspectedBundle(bundle, {
      home: fixture.destinationHome,
      targetCwd: fixture.destinationProject,
      inspectionToken: inspection.inspectionToken,
      acceptRolloutSwitch: true,
    });
    expect(imported.action).toBe('switched');
    expect(readFileSync(destinationBasePath)).toEqual(basePrefix);
    expect(findDestinationRollout(fixture.destinationHome, fixture.threadId)).toBe(imported.rolloutPath);
  });

  it('requires agent review when the destination repository state differs', () => {
    const fixture = createGitFixture();
    const bundle = buildSyncBundle(fixture.sourceHome, fixture.threadId, SOURCE_DEVICE, TARGET_DEVICE);
    writeFileSync(join(fixture.destinationProject, 'local-only.txt'), 'dirty');
    execFileSync('git', ['-C', fixture.destinationProject, 'mv', 'same.txt', 'renamed.txt']);
    const inspection = inspectImport(bundle, { home: fixture.destinationHome, targetCwd: fixture.destinationProject });
    expect(inspection.project.repositoryIdentity).toBe('same');
    expect(inspection.project.requiresAgentReview).toBe(true);
    expect(inspection.project.reasons).toContain('Destination Git worktree has local changes');
    expect(inspection.project.destination?.git.staged).toContain('renamed.txt');
    expect(() => importInspectedBundle(bundle, {
      home: fixture.destinationHome,
      targetCwd: fixture.destinationProject,
      inspectionToken: inspection.inspectionToken,
    })).toThrow('requires explicit agent review');
    expect(importInspectedBundle(bundle, {
      home: fixture.destinationHome,
      targetCwd: fixture.destinationProject,
      inspectionToken: inspection.inspectionToken,
      acceptProjectState: true,
    }).action).toBe('created');
  });

  it('rejects malformed lineage, integrity changes, and traversal assets before writes', () => {
    const fixture = createFixture();
    const bundle = buildSyncBundle(fixture.sourceHome, fixture.threadId, SOURCE_DEVICE, TARGET_DEVICE);
    const corrupt = structuredClone(bundle);
    corrupt.rolloutBase64 = Buffer.from('not a rollout\n').toString('base64');
    expect(() => validateSyncBundle(corrupt)).toThrow('integrity');

    const traversal = structuredClone(bundle);
    traversal.manifest.assets.push({ path: `generated_images/${fixture.threadId}/../escape`, bytes: 1, sha256: '00' });
    traversal.assets[`generated_images/${fixture.threadId}/../escape`] = Buffer.from('x').toString('base64');
    expect(() => validateSyncBundle(traversal)).toThrow('Unsafe asset path');

    const malformedPath = join(fixture.sourceHome, 'bad.jsonl');
    writeFileSync(malformedPath, [
      JSON.stringify({ ordinal: 2, type: 'session_meta', payload: { id: fixture.threadId, history_mode: 'paginated' } }),
      JSON.stringify({ ordinal: 1, type: 'event_msg', payload: { type: 'user_message', message: 'bad' } }),
      '',
    ].join('\n'));
    expect(() => readRollout(malformedPath)).toThrow('Non-monotonic');
  });

  it('treats current legacy no-ordinal rollouts as a first-class history mode', () => {
    const fixture = createFixture();
    const legacyPath = join(fixture.sourceHome, 'legacy.jsonl');
    writeFileSync(legacyPath, [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id: fixture.threadId, cwd: fixture.sourceProject } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'legacy' } }),
      '',
    ].join('\n'));
    expect(readRollout(legacyPath).summary).toEqual(expect.objectContaining({
      historyMode: 'legacy',
      firstOrdinal: -1,
      lastOrdinal: -1,
      rowCount: 2,
    }));
  });
});

describe('recipient-key inbox', () => {
  it('discovers a named upload without a transfer code and rejects a non-recipient', () => {
    const store = new MemoryTransferStore();
    const root = mkdtempSync(join(tmpdir(), 'move-agent-chat-devices-'));
    const sourceIdentity = join(root, 'source.json');
    const targetIdentity = join(root, 'target.json');
    const thirdIdentity = join(root, 'third.json');
    const source = registerDevice('mac', { identityPath: sourceIdentity, store });
    const target = registerDevice('desktop', { identityPath: targetIdentity, store });
    registerDevice('third', { identityPath: thirdIdentity, store });
    expect(listDevices(store).map(device => device.name)).toEqual(['desktop', 'mac', 'third']);

    const fixture = createFixture();
    const bundle = buildSyncBundle(fixture.sourceHome, fixture.threadId, source.deviceId, target.deviceId);
    const upload = uploadForDevice(bundle, target, { identityPath: sourceIdentity, store });
    expect(listInbox({ identityPath: targetIdentity, store })).toEqual([
      expect.objectContaining({ uploadId: upload.uploadId, threadId: fixture.threadId }),
    ]);
    expect(downloadInboxBundle(upload.uploadId, { identityPath: targetIdentity, store }).manifest.rollout.threadId).toBe(fixture.threadId);
    expect(() => downloadInboxBundle(upload.uploadId, { identityPath: thirdIdentity, store })).toThrow('another device');
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'move-agent-chat-v3-'));
  const sourceHome = join(root, 'source-home');
  const destinationHome = join(root, 'destination-home');
  const sourceProject = join(root, 'source-project');
  const destinationProject = join(root, 'destination-project');
  mkdirSync(sourceProject, { recursive: true });
  mkdirSync(destinationProject, { recursive: true });
  writeFileSync(join(sourceProject, 'same.txt'), 'same');
  writeFileSync(join(destinationProject, 'same.txt'), 'same');
  createStateDatabase(sourceHome);
  createStateDatabase(destinationHome);
  const threadId = randomUUID();
  const sourceRollout = join(sourceHome, 'sessions', '2026', '09', '01', `rollout-2026-09-01T00-00-00-${threadId}.jsonl`);
  mkdirSync(join(sourceRollout, '..'), { recursive: true });
  writeFileSync(sourceRollout, rollout(threadId, sourceProject));
  insertThread(sourceHome, threadId, sourceRollout, sourceProject);
  return { root, sourceHome, destinationHome, sourceProject, destinationProject, threadId, sourceRollout };
}

function createGitFixture() {
  const fixture = createFixture();
  for (const project of [fixture.sourceProject, fixture.destinationProject]) {
    execFileSync('git', ['-C', project, 'init', '-q']);
    execFileSync('git', ['-C', project, 'config', 'user.email', 'fixture@example.invalid']);
    execFileSync('git', ['-C', project, 'config', 'user.name', 'Fixture']);
    execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'git@github.com:example/project.git']);
    execFileSync('git', ['-C', project, 'add', 'same.txt']);
    execFileSync('git', ['-C', project, 'commit', '-qm', 'fixture']);
  }
  return fixture;
}

function rollout(threadId: string, cwd: string, suffix: string[] = []): Buffer {
  const rows: Array<Record<string, unknown>> = [
    {
      ordinal: 0,
      timestamp: '2026-09-01T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        session_id: threadId,
        cwd,
        source: 'app',
        thread_source: 'local',
        model_provider: 'openai',
        cli_version: '0.147.0',
        history_mode: 'paginated',
      },
    },
    {
      ordinal: 1,
      timestamp: '2026-09-01T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'fixture request' },
    },
    {
      ordinal: 2,
      timestamp: '2026-09-01T00:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture response' }] },
    },
  ];
  suffix.forEach((message, index) => rows.push({
    ordinal: 3 + index,
    timestamp: `2026-09-01T00:00:${String(3 + index).padStart(2, '0')}.000Z`,
    type: 'event_msg',
    payload: { type: 'user_message', message },
  }));
  return Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

function rolloutWithHistoryBase(
  threadId: string,
  cwd: string,
  historyRolloutId: string,
  endByteOffset: number,
  endOrdinalExclusive: number,
): Buffer {
  const rows = rollout(threadId, cwd).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  rows[0].payload.history_base = {
    thread_id: historyRolloutId,
    end_byte_offset: endByteOffset,
    end_ordinal_exclusive: endOrdinalExclusive,
  };
  return Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

function createStateDatabase(home: string): void {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT NOT NULL, appearance TEXT);
    INSERT INTO thread_sections (id,name) VALUES ('section-a','Section A');
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
    INSERT INTO projects VALUES ('destination-project','Destination','{}',0,1,1);
    CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY(project_id,position));
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER,
      git_sha TEXT, git_branch TEXT, git_origin_url TEXT, cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '', agent_nickname TEXT, agent_role TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled', model TEXT, reasoning_effort TEXT, agent_path TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '',
      recency_at INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0,
      history_mode TEXT NOT NULL DEFAULT 'legacy', name TEXT, is_pinned INTEGER NOT NULL DEFAULT 0,
      thread_section_id TEXT, section_position INTEGER, section_entered_at_ms INTEGER, project_id TEXT
    );
  `);
  db.close();
}

function insertThread(home: string, threadId: string, rolloutPath: string, cwd: string): void {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.prepare(`
    INSERT INTO threads (
      id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,
      created_at_ms,updated_at_ms,thread_source,preview,recency_at,recency_at_ms,history_mode,name
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    threadId, rolloutPath, 1_788_220_800, 1_788_220_802, 'app', 'openai', cwd, 'Fixture thread',
    'workspace-write', 'never', 1_788_220_800_000, 1_788_220_802_000, 'local', 'fixture request',
    1_788_220_802, 1_788_220_802_000, 'paginated', null,
  );
  db.close();
}

function findDestinationRollout(home: string, threadId: string): string {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  const row = db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(threadId) as { rollout_path: string };
  db.close();
  return row.rollout_path;
}
