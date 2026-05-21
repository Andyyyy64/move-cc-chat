import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { URL } from 'node:url';
import {
  getCodexHome,
  getDefaultCodexProvider,
  listCodexSessions,
  packCodexSession,
  previewCodexBundle,
  unpackCodexSession,
  type CodexProvider,
  type CodexPullMode,
} from './codex.js';
import { decrypt, encrypt, generateTransferCode, parseTransferCode } from './crypto.js';
import { deleteGist, downloadFromGist, uploadToGist } from './transport.js';

export interface UiServerOptions {
  host?: string;
  port?: number;
  provider?: CodexProvider;
  home?: string;
  open?: boolean;
}

interface JsonResponse {
  ok: boolean;
  [key: string]: unknown;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 17345;
const MAX_BODY_BYTES = 1_000_000;

export function createUiServer(options: UiServerOptions = {}): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);

      if (req.method === 'GET' && url.pathname === '/') {
        sendHtml(res, renderAppHtml());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, {
          ok: true,
          provider: options.provider ?? getDefaultCodexProvider(),
          home: options.home ?? getCodexHome(options.provider ?? getDefaultCodexProvider()),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const provider = parseProvider(url.searchParams.get('provider') ?? undefined, options.provider);
        const home = url.searchParams.get('home') || options.home || getCodexHome(provider);
        const limit = parsePositiveInt(url.searchParams.get('limit'), 30);
        const sessions = listCodexSessions(provider, home, limit).slice(0, limit).map(session => ({
          ...session,
          size: statSync(session.sessionPath).size,
          current: session.id === process.env.CODEX_THREAD_ID,
        }));
        sendJson(res, { ok: true, provider, home, sessions });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/push') {
        const body = await readJsonBody(req);
        const provider = parseProvider(readString(body.provider), options.provider);
        const home = readString(body.home) || options.home || getCodexHome(provider);
        const sessionId = readString(body.sessionId) || undefined;
        const current = body.current === true;
        const includeShellSnapshots = body.includeShellSnapshots !== false;
        const includeGeneratedImages = body.includeGeneratedImages !== false;
        const bundle = packCodexSession({
          provider,
          home,
          sessionId,
          current,
          includeShellSnapshots,
          includeGeneratedImages,
        });
        const preview = previewCodexBundle(bundle);
        const key = randomBytes(32);
        const encrypted = encrypt(bundle, key);
        const gistId = uploadToGist(encrypted);
        const { code } = generateTransferCode(gistId, key);
        sendJson(res, {
          ok: true,
          code,
          command: `move-agent-chat codex pull ${code}`,
          gistId,
          preview,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/preview') {
        const body = await readJsonBody(req);
        const code = requireString(body.code, 'code');
        const { bundle, gistId } = downloadBundleFromCode(code);
        const preview = previewCodexBundle(bundle);
        sendJson(res, { ok: true, gistId, preview });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/import') {
        const body = await readJsonBody(req);
        const code = requireString(body.code, 'code');
        const provider = readString(body.provider) ? parseProvider(readString(body.provider), options.provider) : undefined;
        const home = readString(body.home) || options.home;
        const mode = parseMode(readString(body.mode));
        const cwd = readString(body.cwd) || null;
        const force = body.force === true;
        const updateSqlite = body.updateSqlite !== false;
        const deleteAfterImport = body.deleteAfterImport !== false;
        const { bundle, gistId } = downloadBundleFromCode(code);
        const result = unpackCodexSession(bundle, {
          provider,
          home,
          mode,
          cwd,
          force,
          updateSqlite,
        });

        let gistDeleted = false;
        let gistDeleteError: string | null = null;
        if (deleteAfterImport) {
          try {
            deleteGist(gistId);
            gistDeleted = true;
          } catch (err) {
            gistDeleteError = String(err);
          }
        }

        sendJson(res, { ok: true, result, gistId, gistDeleted, gistDeleteError });
        return;
      }

      sendJson(res, { ok: false, error: 'Not found' }, 404);
    } catch (err) {
      sendJson(res, { ok: false, error: toErrorMessage(err) }, 500);
    }
  });
}

export async function startUiServer(options: UiServerOptions = {}): Promise<{ server: Server; url: string }> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const server = createUiServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;

  if (options.open) {
    openBrowser(url);
  }

  return { server, url };
}

function downloadBundleFromCode(code: string): { bundle: Buffer; gistId: string } {
  const { key, gistId } = parseTransferCode(code);
  const encrypted = downloadFromGist(gistId);
  return { bundle: decrypt(encrypted, key), gistId };
}

function parseProvider(value: string | undefined, fallback?: CodexProvider): CodexProvider {
  if (!value) return fallback ?? getDefaultCodexProvider();
  if (value === 'codex-app' || value === 'codex-cli') return value;
  throw new Error(`Invalid provider: ${value}`);
}

function parseMode(value: string | undefined): CodexPullMode {
  if (!value) return 'native';
  if (value === 'native' || value === 'handoff') return value;
  throw new Error(`Invalid import mode: ${value}`);
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object body');
  }
  return parsed as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  const stringValue = readString(value);
  if (!stringValue) throw new Error(`Missing required field: ${name}`);
  return stringValue;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

function sendJson(res: ServerResponse, body: JsonResponse, statusCode = body.ok ? 200 : 400): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin'
    ? 'open'
    : platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 3000 });
  } catch {
    // Opening the browser is best-effort; the CLI still prints the URL.
  }
}

function renderAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>move-agent-chat</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f7f4;
      --panel: #ffffff;
      --text: #18191b;
      --muted: #656b73;
      --line: #d9ddd6;
      --accent: #0f766e;
      --accent-dark: #115e59;
      --danger: #b42318;
      --ok: #166534;
      --code: #eef2f1;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111314;
        --panel: #1a1d1f;
        --text: #f2f3f0;
        --muted: #a6adb5;
        --line: #34393d;
        --accent: #2dd4bf;
        --accent-dark: #5eead4;
        --danger: #f97066;
        --ok: #86efac;
        --code: #252a2d;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, select {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      min-height: 34px;
      padding: 0 12px;
      cursor: pointer;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: .55;
    }
    input, select {
      width: 100%;
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      padding: 0 10px;
    }
    code, textarea {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .app {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: 22px;
      letter-spacing: 0;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 15px;
      letter-spacing: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(360px, .85fr);
      gap: 16px;
      align-items: start;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }
    .toolbar, .row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .toolbar {
      margin-bottom: 12px;
    }
    .stack {
      display: grid;
      gap: 12px;
    }
    .sessions {
      display: grid;
      gap: 8px;
      max-height: 620px;
      overflow: auto;
      padding-right: 2px;
    }
    .session {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .session.active {
      outline: 2px solid color-mix(in srgb, var(--accent), transparent 60%);
    }
    .title {
      font-weight: 650;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
    }
    .path {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 4px;
    }
    .field {
      display: grid;
      gap: 6px;
    }
    .field label {
      color: var(--muted);
      font-size: 12px;
    }
    .copybox {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
    }
    textarea {
      width: 100%;
      min-height: 76px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--code);
      color: var(--text);
      padding: 10px;
    }
    .preview {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .kv {
      display: grid;
      grid-template-columns: 110px minmax(0, 1fr);
      gap: 8px;
      font-size: 13px;
    }
    .kv span:first-child {
      color: var(--muted);
    }
    .status {
      min-height: 20px;
      color: var(--muted);
    }
    .status.error { color: var(--danger); }
    .status.ok { color: var(--ok); }
    .checkbox {
      display: flex;
      gap: 8px;
      align-items: center;
      color: var(--muted);
    }
    .checkbox input {
      width: 16px;
      min-height: 16px;
    }
    @media (max-width: 820px) {
      .grid { grid-template-columns: 1fr; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .session { grid-template-columns: 1fr; }
      .toolbar, .row { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <main class="app">
    <div class="topbar">
      <h1>move-agent-chat</h1>
      <div class="row">
        <select id="provider" aria-label="Provider">
          <option value="codex-app">Codex Desktop</option>
          <option value="codex-cli">Codex CLI</option>
        </select>
        <button id="refresh">Refresh</button>
      </div>
    </div>
    <div class="grid">
      <section class="panel">
        <div class="toolbar">
          <button id="push-current" class="primary">Push Current</button>
          <button id="push-selected">Push Selected</button>
          <span id="list-status" class="status"></span>
        </div>
        <div id="sessions" class="sessions"></div>
      </section>
      <section class="stack">
        <div class="panel stack">
          <h2>Transfer</h2>
          <div class="field">
            <label for="code">Code</label>
            <textarea id="code" spellcheck="false"></textarea>
          </div>
          <div class="copybox">
            <input id="command" readonly aria-label="Pull command">
            <button id="copy-command">Copy</button>
          </div>
          <div class="row">
            <button id="preview-code">Preview</button>
            <button id="import-code" class="primary">Import</button>
          </div>
          <div class="row">
            <select id="mode" aria-label="Import mode">
              <option value="native">Native</option>
              <option value="handoff">Handoff</option>
            </select>
            <input id="cwd" placeholder="Override cwd" aria-label="Override cwd">
          </div>
          <label class="checkbox">
            <input id="force" type="checkbox">
            <span>Overwrite existing native thread</span>
          </label>
          <div id="transfer-status" class="status"></div>
        </div>
        <div class="panel stack">
          <h2>Preview</h2>
          <div id="preview" class="preview"></div>
        </div>
      </section>
    </div>
  </main>
  <script>
    const state = { sessions: [], selectedId: null, provider: 'codex-app' };
    const $ = (id) => document.getElementById(id);
    const fmtBytes = (n) => n < 1024 ? n + 'B' : n < 1048576 ? Math.round(n / 1024) + 'KB' : (n / 1048576).toFixed(1) + 'MB';
    const compact = (text, max = 120) => {
      const s = String(text || '').replace(/\\s+/g, ' ').trim();
      return s.length > max ? s.slice(0, max - 3) + '...' : s;
    };

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    function setStatus(id, message, kind = '') {
      const el = $(id);
      el.textContent = message;
      el.className = 'status' + (kind ? ' ' + kind : '');
    }

    function renderSessions() {
      const root = $('sessions');
      root.innerHTML = '';
      for (const session of state.sessions) {
        const item = document.createElement('div');
        item.className = 'session' + (session.id === state.selectedId ? ' active' : '');
        item.innerHTML =
          '<div>' +
          '<div class="title"></div>' +
          '<div class="meta"></div>' +
          '<div class="path"></div>' +
          '</div>' +
          '<button>Select</button>';
        item.querySelector('.title').textContent = compact(session.title, 140);
        item.querySelector('.meta').textContent = [
          session.id.slice(0, 8),
          new Date(session.updatedAt).toLocaleString(),
          session.cwd ? session.cwd.split('/').filter(Boolean).at(-1) : 'unknown',
          fmtBytes(session.size || 0),
          session.current ? 'CURRENT' : ''
        ].filter(Boolean).join('  ');
        item.querySelector('.path').textContent = session.sessionPath;
        item.querySelector('button').onclick = () => {
          state.selectedId = session.id;
          renderSessions();
        };
        root.appendChild(item);
      }
    }

    function renderPreview(preview) {
      const root = $('preview');
      if (!preview) {
        root.innerHTML = '<span class="status">No preview loaded.</span>';
        return;
      }
      root.innerHTML = [
        ['Thread', preview.threadId],
        ['Title', preview.title],
        ['Project', preview.cwd],
        ['Provider', preview.provider],
        ['Model', [preview.model, preview.reasoningEffort].filter(Boolean).join(' / ')],
        ['Git', preview.git ? [preview.git.branch, preview.git.repository_url].filter(Boolean).join('  ') : ''],
        ['Files', fmtBytes(preview.files.totalBytes) + '  transcript ' + fmtBytes(preview.files.sessionBytes)],
        ['Assets', preview.files.shellSnapshots + ' shell snapshots, ' + preview.files.generatedImages + ' images'],
      ].map(([k, v]) => '<div class="kv"><span>' + escapeHtml(k) + '</span><span>' + escapeHtml(v || '-') + '</span></div>').join('');
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    async function refreshSessions() {
      state.provider = $('provider').value;
      setStatus('list-status', 'Loading...');
      try {
        const data = await api('/api/sessions?provider=' + encodeURIComponent(state.provider) + '&limit=30');
        state.sessions = data.sessions;
        if (!state.selectedId && state.sessions[0]) state.selectedId = state.sessions[0].id;
        renderSessions();
        setStatus('list-status', state.sessions.length + ' sessions', 'ok');
      } catch (err) {
        setStatus('list-status', err.message, 'error');
      }
    }

    async function pushSession(current) {
      setStatus('transfer-status', 'Pushing...');
      try {
        const data = await api('/api/push', {
          method: 'POST',
          body: JSON.stringify({
            provider: $('provider').value,
            current,
            sessionId: current ? undefined : state.selectedId,
          }),
        });
        $('code').value = data.code;
        $('command').value = data.command;
        renderPreview(data.preview);
        setStatus('transfer-status', 'Uploaded encrypted bundle.', 'ok');
      } catch (err) {
        setStatus('transfer-status', err.message, 'error');
      }
    }

    async function previewCode() {
      setStatus('transfer-status', 'Previewing...');
      try {
        const data = await api('/api/preview', {
          method: 'POST',
          body: JSON.stringify({ code: $('code').value }),
        });
        renderPreview(data.preview);
        setStatus('transfer-status', 'Preview loaded.', 'ok');
      } catch (err) {
        setStatus('transfer-status', err.message, 'error');
      }
    }

    async function importCode() {
      setStatus('transfer-status', 'Importing...');
      try {
        const data = await api('/api/import', {
          method: 'POST',
          body: JSON.stringify({
            code: $('code').value,
            provider: $('provider').value,
            mode: $('mode').value,
            cwd: $('cwd').value,
            force: $('force').checked,
          }),
        });
        setStatus('transfer-status', 'Imported to ' + data.result.path + (data.gistDeleted ? ' and deleted gist.' : '.'), 'ok');
        await refreshSessions();
      } catch (err) {
        setStatus('transfer-status', err.message, 'error');
      }
    }

    $('provider').onchange = refreshSessions;
    $('refresh').onclick = refreshSessions;
    $('push-current').onclick = () => pushSession(true);
    $('push-selected').onclick = () => pushSession(false);
    $('preview-code').onclick = previewCode;
    $('import-code').onclick = importCode;
    $('copy-command').onclick = async () => {
      await navigator.clipboard.writeText($('command').value || $('code').value);
      setStatus('transfer-status', 'Copied.', 'ok');
    };

    renderPreview(null);
    refreshSessions();
  </script>
</body>
</html>`;
}
