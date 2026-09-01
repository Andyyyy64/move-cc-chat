#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { z } from 'zod/v4';
import {
  buildSyncBundle,
  discoverCodexHome,
  importInspectedBundle,
  inspectImport,
  listLocalThreads,
  type DirectorySnapshot,
  type ImportInspection,
} from './codex-sync.js';
import {
  deleteInboxUpload,
  downloadInboxBundle,
  listDevices,
  listInbox,
  readIdentity,
  registerDevice,
  uploadForDevice,
} from './device-inbox.js';

export function createMoveAgentChatMcpServer(): McpServer {
const server = new McpServer({ name: 'move-agent-chat', version: '0.2.0' });

server.registerTool(
  'register_device',
  {
    title: 'Register this device',
    description: 'Create this device local encryption identity and publish only its public device card to the authenticated GitHub Gist account. Use once per machine before uploads.',
    inputSchema: z.object({
      name: z.string().min(1).max(64).describe('Stable human-readable device name, for example mac or desktop'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ name }) => result(() => ({ device: registerDevice(name) })),
);

server.registerTool(
  'get_current_device',
  {
    title: 'Get current device',
    description: 'Read this machine local move-agent-chat device identity without returning its private key.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => result(() => {
    const identity = readIdentity();
    return { device: { deviceId: identity.deviceId, name: identity.name, createdAt: identity.createdAt } };
  }),
);

server.registerTool(
  'list_devices',
  {
    title: 'List transfer devices',
    description: 'List published move-agent-chat destination device cards from the authenticated GitHub Gist account.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => result(() => ({
    devices: listDevices().map(device => ({ deviceId: device.deviceId, name: device.name, createdAt: device.createdAt })),
  })),
);

server.registerTool(
  'list_local_threads',
  {
    title: 'List local Codex threads',
    description: 'List bounded native local Codex threads from the current machine. This does not read or return transcript content.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).default(50),
      includeArchived: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ limit, includeArchived }) => result(() => ({
    home: discoverCodexHome(),
    currentThreadId: currentThreadId() || null,
    threads: listLocalThreads(discoverCodexHome(), limit).filter(thread => includeArchived || !thread.archived),
  })),
);

server.registerTool(
  'upload_thread',
  {
    title: 'Upload a local Codex thread',
    description: 'Snapshot one local Codex rollout and bounded project/Git evidence, encrypt it to a named destination device, and create a pending inbox upload. This does not import or change the destination.',
    inputSchema: z.object({
      targetDevice: z.string().min(1).describe('Exact registered destination device name'),
      threadId: z.string().uuid().optional().describe('Codex thread ID. Omit to upload the current Codex thread.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ targetDevice, threadId }) => result(() => {
    const identity = readIdentity();
    const matches = listDevices().filter(device => device.name.toLowerCase() === targetDevice.toLowerCase());
    if (matches.length !== 1) throw new Error(`Expected exactly one registered device named ${targetDevice}; found ${matches.length}`);
    const selectedThreadId = threadId || currentThreadId();
    if (!selectedThreadId) throw new Error('No current Codex thread ID is available; pass threadId explicitly');
    const bundle = buildSyncBundle(discoverCodexHome(), selectedThreadId, identity.deviceId, matches[0].deviceId);
    const upload = uploadForDevice(bundle, matches[0]);
    return {
      upload,
      thread: {
        id: bundle.manifest.rollout.threadId,
        title: bundle.manifest.thread.name || bundle.manifest.thread.title,
        bytes: bundle.manifest.rollout.bytes,
        sha256: bundle.manifest.rollout.sha256,
        projectPath: bundle.manifest.thread.cwd,
        git: summarizeDirectory(bundle.manifest.project).git,
      },
      next: `On ${matches[0].name}, use list_inbox then inspect_upload for upload ${upload.uploadId}.`,
    };
  }),
);

server.registerTool(
  'list_inbox',
  {
    title: 'List pending thread uploads',
    description: 'List encrypted uploads addressed to this device. This does not download transcript content or mutate local Codex state.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => result(() => ({ uploads: listInbox() })),
);

server.registerTool(
  'inspect_upload',
  {
    title: 'Inspect a pending thread upload',
    description: 'Decrypt and validate one upload, compare exact rollout lineage and destination directory/Git state, and return a confirmation-bound inspection token. This never writes Codex state.',
    inputSchema: z.object({
      uploadId: z.string().min(8).max(128),
      targetCwd: z.string().min(1).optional().describe('Existing destination project directory. Omit to use an exact path or one unambiguous saved-project match.'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ uploadId, targetCwd }) => result(() => ({
    uploadId,
    inspection: summarizeInspection(inspectImport(downloadInboxBundle(uploadId), { targetCwd })),
  })),
);

server.registerTool(
  'import_upload',
  {
    title: 'Import an inspected thread upload',
    description: 'Import a previously inspected upload into native local Codex storage. Requires the fresh inspection token. Diverged histories are always blocked. Set acceptProjectState only after Codex inspected every reported directory/Git conflict.',
    inputSchema: z.object({
      uploadId: z.string().min(8).max(128),
      inspectionToken: z.string().regex(/^[0-9a-f]{64}$/),
      targetCwd: z.string().min(1).optional(),
      acceptProjectState: z.boolean().default(false),
      acceptRolloutSwitch: z.boolean().default(false),
      deleteUploadAfterImport: z.boolean().default(true),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ uploadId, inspectionToken, targetCwd, acceptProjectState, acceptRolloutSwitch, deleteUploadAfterImport }) => result(() => {
    const bundle = downloadInboxBundle(uploadId);
    const imported = importInspectedBundle(bundle, { targetCwd, inspectionToken, acceptProjectState, acceptRolloutSwitch });
    let uploadDeleted = false;
    let uploadDeleteError: string | null = null;
    if (deleteUploadAfterImport) {
      try {
        deleteInboxUpload(uploadId);
        uploadDeleted = true;
      } catch (error) {
        uploadDeleteError = errorMessage(error);
      }
    }
    return { imported, uploadId, uploadDeleted, uploadDeleteError };
  }),
);

return server;
}

function currentThreadId(): string | undefined {
  return process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
}

function summarizeInspection(inspection: ImportInspection): Record<string, unknown> {
  return {
    bundleSha256: inspection.bundleSha256,
    threadId: inspection.threadId,
    title: inspection.title,
    targetHome: inspection.targetHome,
    targetRolloutPath: inspection.targetRolloutPath || null,
    destinationRolloutPath: inspection.destinationRolloutPath || null,
    lineage: inspection.lineage,
    rolloutSelection: inspection.rolloutSelection,
    historyDependencies: inspection.historyDependencies,
    project: {
      targetPath: inspection.project.targetPath || null,
      repositoryIdentity: inspection.project.repositoryIdentity,
      requiresAgentReview: inspection.project.requiresAgentReview,
      reasons: inspection.project.reasons,
      inventoryDiff: inspection.project.inventoryDiff || null,
      source: summarizeDirectory(inspection.project.source),
      destination: inspection.project.destination ? summarizeDirectory(inspection.project.destination) : null,
      candidates: inspection.project.candidates.map(summarizeDirectory),
    },
    writerLocked: inspection.writerLocked,
    canImport: inspection.canImport,
    action: inspection.action,
    blockers: inspection.blockers,
    inspectionToken: inspection.inspectionToken,
  };
}

function summarizeDirectory(snapshot: DirectorySnapshot): Record<string, unknown> {
  return {
    path: snapshot.path,
    exists: snapshot.exists,
    realPath: snapshot.realPath || null,
    inventoryHash: snapshot.inventoryHash || null,
    entryCount: snapshot.entries.length,
    truncated: snapshot.truncated,
    git: {
      isRepository: snapshot.git.isRepository,
      root: snapshot.git.root || null,
      head: snapshot.git.head || null,
      branch: snapshot.git.branch || null,
      remotes: snapshot.git.remotes,
      remoteIdentities: snapshot.git.remoteIdentities,
      trackedTreeHash: snapshot.git.trackedTreeHash || null,
      staged: snapshot.git.staged.slice(0, 100),
      unstaged: snapshot.git.unstaged.slice(0, 100),
      untracked: snapshot.git.untracked.slice(0, 100),
      pathsTruncated: snapshot.git.staged.length > 100 || snapshot.git.unstaged.length > 100 || snapshot.git.untracked.length > 100,
    },
  };
}

async function result<T extends Record<string, unknown>>(operation: () => T | Promise<T>) {
  try {
    const structuredContent = await operation();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: errorMessage(error) }],
      isError: true,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = serveStdio(() => createMoveAgentChatMcpServer(), {
    onerror(error) {
      console.error(error.message);
    },
  });

  process.on('SIGINT', () => {
    void handle.close();
  });
}
