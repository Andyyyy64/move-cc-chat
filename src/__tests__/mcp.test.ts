import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createMoveAgentChatMcpServer } from '../mcp.js';

const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe('move-agent-chat MCP', () => {
  it('lists the bounded tool surface and reads local threads through stdio-compatible MCP', async () => {
    const home = mkdtempSync(join(tmpdir(), 'move-agent-chat-mcp-'));
    mkdirSync(join(home, 'sessions'));
    const db = new DatabaseSync(join(home, 'state_5.sqlite'));
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, name TEXT, cwd TEXT NOT NULL,
        updated_at INTEGER NOT NULL, updated_at_ms INTEGER, rollout_path TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0, history_mode TEXT NOT NULL DEFAULT 'paginated'
      );
      INSERT INTO threads VALUES (
        '00000000-0000-0000-0000-000000000123', 'Fixture', NULL, '/tmp/project',
        1, 1000, '/tmp/rollout.jsonl', 0, 'paginated'
      );
    `);
    db.close();
    process.env.CODEX_HOME = home;

    const server = createMoveAgentChatMcpServer();
    const client = new Client({ name: 'move-agent-chat-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual([
        'register_device',
        'get_current_device',
        'list_devices',
        'list_local_threads',
        'upload_thread',
        'list_inbox',
        'inspect_upload',
        'import_upload',
      ]);
      const response = await client.callTool({ name: 'list_local_threads', arguments: { limit: 10, includeArchived: false } });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toEqual(expect.objectContaining({
        home,
        threads: [expect.objectContaining({ id: '00000000-0000-0000-0000-000000000123' })],
      }));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
