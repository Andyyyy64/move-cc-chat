const DEFAULT_PORT = 17345;
const DEFAULT_HOST = '127.0.0.1';

let childProcess = null;
let serverUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

function isMainProcess(api) {
  return api?.process === 'main' || api?.process?.type === 'main' || api?.process?.isMain === true;
}

function isRendererProcess(api) {
  return api?.process === 'renderer' || api?.process?.type === 'renderer' || api?.process?.isRenderer === true || typeof document !== 'undefined';
}

function readConfig(api) {
  const stored = api?.storage?.get?.('move-agent-chat.config') || {};
  return {
    command: typeof stored.command === 'string' && stored.command.trim() ? stored.command.trim() : 'move-agent-chat',
    host: typeof stored.host === 'string' && stored.host.trim() ? stored.host.trim() : DEFAULT_HOST,
    port: Number.isFinite(Number(stored.port)) ? Number(stored.port) : DEFAULT_PORT,
  };
}

function writeConfig(api, config) {
  api?.storage?.set?.('move-agent-chat.config', config);
}

async function ping(url) {
  try {
    const response = await fetch(`${url}/api/health`, { cache: 'no-store' });
    if (!response.ok) return { ok: false };
    return await response.json();
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function registerMain(api) {
  let childProcessModule = null;

  try {
    childProcessModule = require('node:child_process');
  } catch (error) {
    api.log?.error?.(`Move Agent Chat tweak could not load child_process: ${error}`);
  }

  api.ipc.handle('status', async () => {
    const status = await ping(serverUrl);
    return {
      ok: true,
      running: Boolean(status.ok),
      url: serverUrl,
      childPid: childProcess?.pid ?? null,
      health: status,
    };
  });

  api.ipc.handle('start', async (input = {}) => {
    const config = {
      ...readConfig(api),
      ...input,
    };
    const port = Number.isFinite(Number(config.port)) ? Number(config.port) : DEFAULT_PORT;
    const host = config.host || DEFAULT_HOST;
    const command = config.command || 'move-agent-chat';
    serverUrl = `http://${host}:${port}`;
    writeConfig(api, { command, host, port });

    const existing = await ping(serverUrl);
    if (existing.ok) {
      return { ok: true, running: true, url: serverUrl, reused: true };
    }

    if (!childProcessModule) {
      return { ok: false, error: 'child_process is unavailable in this Codex++ runtime.' };
    }

    const child = childProcessModule.spawn(command, ['ui', '--host', host, '--port', String(port)], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        MOVE_AGENT_CHAT_UI_CHILD: '1',
      },
    });
    child.unref();
    childProcess = child;

    for (let i = 0; i < 20; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 150));
      const health = await ping(serverUrl);
      if (health.ok) {
        return { ok: true, running: true, url: serverUrl, pid: child.pid };
      }
    }

    return { ok: false, error: `Started ${command}, but ${serverUrl} did not become ready.` };
  });

  api.ipc.handle('stop', async () => {
    const pid = childProcess?.pid ?? null;
    if (childProcess) {
      try {
        process.kill(-childProcess.pid, 'SIGTERM');
      } catch {
        try {
          childProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      childProcess = null;
    }
    return { ok: true, stoppedPid: pid };
  });
}

function createRenderer(api) {
  api.settings.registerSection({
    id: 'move-agent-chat',
    title: 'Move Agent Chat',
    order: 80,
    render(container) {
      const config = readConfig(api);
      container.innerHTML = `
        <div class="mac-panel">
          <div class="mac-header">
            <div>
              <h2>Move Agent Chat</h2>
              <p>Move Codex conversations between machines without copying auth tokens.</p>
            </div>
            <span id="mac-state" class="mac-state">Checking...</span>
          </div>
          <div class="mac-grid">
            <label>
              Helper command
              <input id="mac-command" value="${escapeHtml(config.command)}" />
            </label>
            <label>
              Port
              <input id="mac-port" value="${escapeHtml(String(config.port))}" inputmode="numeric" />
            </label>
          </div>
          <div class="mac-actions">
            <button id="mac-start">Start UI</button>
            <button id="mac-open">Open Panel</button>
            <button id="mac-stop">Stop Helper</button>
          </div>
          <div id="mac-url" class="mac-url"></div>
          <iframe id="mac-frame" title="Move Agent Chat UI"></iframe>
          <p class="mac-note">The embedded panel talks to a localhost helper. Gist contents stay encrypted until this machine decrypts them locally.</p>
        </div>
        <style>
          .mac-panel {
            display: grid;
            gap: 14px;
            color: var(--text-primary, inherit);
          }
          .mac-header {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            align-items: start;
          }
          .mac-header h2 {
            margin: 0 0 4px;
            font-size: 18px;
          }
          .mac-header p, .mac-note {
            margin: 0;
            color: var(--text-secondary, #69707a);
            font-size: 13px;
          }
          .mac-state {
            border: 1px solid rgba(127,127,127,.35);
            border-radius: 999px;
            padding: 4px 10px;
            font-size: 12px;
            white-space: nowrap;
          }
          .mac-state.ok { color: #0f766e; }
          .mac-state.error { color: #b42318; }
          .mac-grid {
            display: grid;
            grid-template-columns: minmax(0, 1fr) 120px;
            gap: 10px;
          }
          .mac-grid label {
            display: grid;
            gap: 6px;
            font-size: 12px;
            color: var(--text-secondary, #69707a);
          }
          .mac-grid input {
            min-height: 32px;
            border: 1px solid rgba(127,127,127,.35);
            border-radius: 6px;
            padding: 0 10px;
            background: transparent;
            color: inherit;
          }
          .mac-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
          }
          .mac-actions button {
            min-height: 32px;
            border: 1px solid rgba(127,127,127,.35);
            border-radius: 6px;
            padding: 0 12px;
            background: transparent;
            color: inherit;
            cursor: pointer;
          }
          .mac-url {
            min-height: 18px;
            font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            color: var(--text-secondary, #69707a);
          }
          #mac-frame {
            width: 100%;
            min-height: 680px;
            border: 1px solid rgba(127,127,127,.35);
            border-radius: 8px;
            background: white;
          }
          @media (max-width: 720px) {
            .mac-grid { grid-template-columns: 1fr; }
            #mac-frame { min-height: 560px; }
          }
        </style>
      `;

      const state = container.querySelector('#mac-state');
      const frame = container.querySelector('#mac-frame');
      const url = container.querySelector('#mac-url');
      const command = container.querySelector('#mac-command');
      const port = container.querySelector('#mac-port');

      const setState = (message, kind = '') => {
        state.textContent = message;
        state.className = `mac-state ${kind}`.trim();
      };

      const readInput = () => ({
        command: command.value.trim() || 'move-agent-chat',
        host: DEFAULT_HOST,
        port: Number(port.value) || DEFAULT_PORT,
      });

      const refresh = async () => {
        try {
          const result = await api.ipc.invoke('status');
          if (result.running) {
            setState('Running', 'ok');
            url.textContent = result.url;
            frame.src = result.url;
          } else {
            setState('Stopped');
            url.textContent = result.url || '';
          }
        } catch (error) {
          setState(String(error), 'error');
        }
      };

      container.querySelector('#mac-start').addEventListener('click', async () => {
        setState('Starting...');
        try {
          const result = await api.ipc.invoke('start', readInput());
          if (!result.ok) throw new Error(result.error || 'Could not start helper');
          setState('Running', 'ok');
          url.textContent = result.url;
          frame.src = result.url;
        } catch (error) {
          setState(String(error), 'error');
        }
      });

      container.querySelector('#mac-open').addEventListener('click', async () => {
        const target = frame.src || `http://${DEFAULT_HOST}:${Number(port.value) || DEFAULT_PORT}`;
        window.open(target, '_blank', 'noopener,noreferrer');
      });

      container.querySelector('#mac-stop').addEventListener('click', async () => {
        await api.ipc.invoke('stop');
        setState('Stopped');
      });

      refresh();
    },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

module.exports = {
  async activate(api) {
    if (isMainProcess(api)) {
      await registerMain(api);
    }

    if (isRendererProcess(api)) {
      createRenderer(api);
    }
  },
};
