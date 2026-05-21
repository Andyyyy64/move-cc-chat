import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUiServer } from '../ui.js';
import type { Server } from 'node:http';

describe('move-agent-chat UI server', () => {
  let codexHome: string;
  let server: Server;
  let baseUrl: string;
  const threadId = '22222222-3333-4444-5555-666666666666';

  beforeEach(async () => {
    codexHome = mkdtempSync(join(tmpdir(), 'move-agent-chat-ui-'));
    const sessionDir = join(codexHome, 'sessions', '2026', '05', '22');
    mkdirSync(sessionDir, { recursive: true });

    const sessionPath = join(sessionDir, `rollout-2026-05-22T04-00-00-${threadId}.jsonl`);
    writeFileSync(sessionPath, [
      JSON.stringify({
        timestamp: '2026-05-22T04:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          cwd: '/tmp/source',
          source: 'vscode',
          thread_source: 'user',
          cli_version: '0.131.0-alpha.9',
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-22T04:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'ship the UI' }],
        },
      }),
    ].join('\n') + '\n');
    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: threadId, thread_name: 'UI smoke thread', updated_at: '2026-05-22T04:00:01.000Z' }) + '\n'
    );

    server = createUiServer({ provider: 'codex-app', home: codexHome });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') reject(new Error('Unexpected server address'));
        else {
          baseUrl = `http://127.0.0.1:${address.port}`;
          resolve();
        }
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('serves the UI shell', async () => {
    const response = await fetch(baseUrl);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('move-agent-chat');
    expect(html).toContain('Push Current');
  });

  it('lists Codex sessions through the JSON API', async () => {
    const response = await fetch(`${baseUrl}/api/sessions?provider=codex-app&limit=5`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe(threadId);
    expect(body.sessions[0].title).toBe('UI smoke thread');
  });

  it('returns JSON errors for invalid preview requests', async () => {
    const response = await fetch(`${baseUrl}/api/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'bad' }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Invalid transfer code');
  });
});
