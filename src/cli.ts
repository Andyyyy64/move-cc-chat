#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { listSessions, getSessionFiles, getClaudeDir } from './session.js';
import type { SessionMeta } from './session.js';
import { packSession } from './pack.js';
import { unpackSession } from './unpack.js';
import { generateTransferCode, parseTransferCode, encrypt, decrypt } from './crypto.js';
import { uploadToGist, downloadFromGist, deleteGist } from './transport.js';
import { checkCwdExists } from './unpack.js';
import {
  getCodexHome,
  getDefaultCodexProvider,
  listCodexSessions,
  packCodexSession,
  unpackCodexSession,
  type CodexProvider,
  type CodexPullMode,
} from './codex.js';
import { startUiServer } from './ui.js';

// Emacs keybind support: Ctrl+N/P/F/B → arrow key equivalents
// prependListenerでclackより先にkeypressをinterceptし、keyオブジェクトを書き換える
process.stdin.prependListener('keypress', (_str: string, key: { name: string; ctrl: boolean } | undefined) => {
  if (key?.ctrl) {
    switch (key.name) {
      case 'n': key.name = 'down'; key.ctrl = false; break;
      case 'p': key.name = 'up'; key.ctrl = false; break;
      case 'f': key.name = 'right'; key.ctrl = false; break;
      case 'b': key.name = 'left'; key.ctrl = false; break;
    }
  }
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getConversationSize(claudeDir: string, session: SessionMeta): number {
  const files = getSessionFiles(claudeDir, session);
  try {
    return statSync(files.conversationPath).size;
  } catch {
    return 0;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function compactText(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function formatSessionLabel(s: SessionMeta, claudeDir: string): string {
  const id = s.sessionId.slice(0, 8);
  const date = new Date(s.startedAt).toLocaleString();
  const project = basename(s.cwd);
  const size = formatSize(getConversationSize(claudeDir, s));
  const alive = isProcessAlive(s.pid);
  const status = alive ? ' [ACTIVE]' : '';
  return `${id}  ${date}  ${project} (${size})${status}`;
}

async function pushSession(session: SessionMeta, claudeDir: string): Promise<{ code: string; sessionId: string }> {
  const bundle = packSession(claudeDir, session);
  const key = randomBytes(32);
  const encrypted = encrypt(bundle, key);
  const gistId = uploadToGist(encrypted);
  const { code } = generateTransferCode(gistId, key);
  return { code, sessionId: session.sessionId };
}

function parseCodexProvider(value: string | undefined): CodexProvider {
  if (!value) return getDefaultCodexProvider();
  if (value === 'codex-app' || value === 'codex-cli') return value;
  throw new Error(`Invalid Codex provider: ${value}. Use codex-app or codex-cli.`);
}

function parseCodexPullMode(value: string | undefined): CodexPullMode {
  if (!value) return 'native';
  if (value === 'native' || value === 'handoff') return value;
  throw new Error(`Invalid pull mode: ${value}. Use native or handoff.`);
}

async function pushCodex(options: {
  provider?: string;
  home?: string;
  session?: string;
  current?: boolean;
  shellSnapshots?: boolean;
  generatedImages?: boolean;
}): Promise<{ code: string; threadId: string }> {
  const provider = parseCodexProvider(options.provider);
  const bundle = packCodexSession({
    provider,
    home: options.home,
    sessionId: options.session,
    current: options.current ?? (!options.session && Boolean(process.env.CODEX_THREAD_ID)),
    includeShellSnapshots: options.shellSnapshots !== false,
    includeGeneratedImages: options.generatedImages !== false,
  });
  const key = randomBytes(32);
  const encrypted = encrypt(bundle, key);
  const gistId = uploadToGist(encrypted);
  const { code } = generateTransferCode(gistId, key);
  const threadId = options.session ?? process.env.CODEX_THREAD_ID ?? 'latest';
  return { code, threadId };
}

const program = new Command();

program
  .name('move-agent-chat')
  .description('Move agent chat sessions between machines')
  .version('0.1.0');

const codex = program
  .command('codex')
  .description('Move Codex Desktop/CLI sessions between machines');

program
  .command('ui')
  .description('Start the local move-agent-chat UI')
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .option('-p, --port <port>', 'Port to bind', '17345')
  .option('--provider <provider>', 'Default provider: codex-app or codex-cli')
  .option('--home <path>', 'Override Codex home directory')
  .option('--open', 'Open the UI in your browser')
  .action(async (opts) => {
    try {
      const provider = opts.provider ? parseCodexProvider(opts.provider) : undefined;
      const port = Number.parseInt(opts.port, 10);
      const { server, url } = await startUiServer({
        host: opts.host,
        port: Number.isFinite(port) ? port : 17345,
        provider,
        home: opts.home,
        open: Boolean(opts.open),
      });
      p.log.success(`move-agent-chat UI: ${url}`);
      p.log.info('Press Ctrl+C to stop.');
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          server.close(() => resolve());
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
      });
    } catch (err) {
      p.log.error(String(err));
      process.exit(1);
    }
  });

codex
  .command('list')
  .description('List local Codex sessions')
  .option('--provider <provider>', 'codex-app or codex-cli')
  .option('--home <path>', 'Override Codex home directory')
  .option('-n, --limit <number>', 'Number of sessions to show', '30')
  .action(async (opts) => {
    try {
      const provider = parseCodexProvider(opts.provider);
      const home = opts.home ?? getCodexHome(provider);
      const limit = Number.parseInt(opts.limit, 10);
      const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 30;
      const sessions = listCodexSessions(provider, home, safeLimit);

      if (sessions.length === 0) {
        console.log(`No Codex sessions found in ${home}.`);
        return;
      }

      console.log('');
      for (const s of sessions.slice(0, safeLimit)) {
        const current = s.id === process.env.CODEX_THREAD_ID ? ' [CURRENT]' : '';
        const size = formatSize(statSync(s.sessionPath).size);
        const project = s.cwd ? basename(s.cwd) : '(unknown cwd)';
        console.log(`  ${s.id.slice(0, 8)}  ${new Date(s.updatedAt).toLocaleString()}  ${project}  ${size}${current}`);
        console.log(`    ${compactText(s.title)}`);
        console.log(`    ${s.sessionPath}`);
      }
      console.log('');
    } catch (err) {
      p.log.error(String(err));
      process.exit(1);
    }
  });

codex
  .command('push')
  .description('Send a Codex session to another machine')
  .option('-s, --session <id>', 'Codex thread ID to push')
  .option('--current', 'Push CODEX_THREAD_ID from the current Codex thread')
  .option('--provider <provider>', 'codex-app or codex-cli')
  .option('--home <path>', 'Override Codex home directory')
  .option('--no-shell-snapshots', 'Do not include shell snapshots for the thread')
  .option('--no-generated-images', 'Do not include generated images for the thread')
  .action(async (opts) => {
    p.intro('move-agent-chat codex push');
    p.log.warn('Codex sessions can contain secrets in prompts, tool calls, and command output. The bundle is encrypted before upload.');

    const spinner = p.spinner();
    try {
      spinner.start('Packing and uploading Codex session...');
      const { code } = await pushCodex(opts);
      spinner.stop('Uploaded.');

      p.log.success('Transfer code');
      console.log(`  move-agent-chat codex pull ${code}`);
      console.log('');
      console.log('  Handoff-only import:');
      console.log(`  move-agent-chat codex pull ${code} --mode handoff`);
      console.log('');
      p.outro('Done. The Gist will be auto-deleted after pull.');
    } catch (err) {
      spinner.stop('Failed.');
      p.log.error(String(err));
      process.exit(1);
    }
  });

codex
  .command('pull')
  .description('Receive a Codex session from another machine')
  .argument('<code>', 'Transfer code from codex push')
  .option('--provider <provider>', 'codex-app or codex-cli')
  .option('--home <path>', 'Override Codex home directory')
  .option('--mode <mode>', 'native or handoff', 'native')
  .option('--cwd <path>', 'Override project directory on this machine')
  .option('--force', 'Overwrite an existing native thread with the same ID')
  .option('--no-sqlite', 'Skip state_5.sqlite thread metadata update')
  .action(async (code: string, opts) => {
    p.intro('move-agent-chat codex pull');
    const spinner = p.spinner();

    try {
      spinner.start('Downloading...');
      const { key, gistId } = parseTransferCode(code);
      const encrypted = downloadFromGist(gistId);
      spinner.stop('Downloaded.');

      spinner.start('Decrypting and importing...');
      const provider = opts.provider ? parseCodexProvider(opts.provider) : undefined;
      const mode = parseCodexPullMode(opts.mode);
      const bundle = decrypt(encrypted, key);
      const result = unpackCodexSession(bundle, {
        provider,
        home: opts.home,
        mode,
        cwd: opts.cwd ?? null,
        force: Boolean(opts.force),
        updateSqlite: opts.sqlite !== false,
      });
      spinner.stop('Imported.');

      spinner.start('Cleaning up gist...');
      try {
        deleteGist(gistId);
        spinner.stop('Gist deleted.');
      } catch {
        spinner.stop(`Could not delete gist — delete it manually: https://gist.github.com/${gistId}`);
      }

      p.log.success('Codex session imported!');
      console.log(`  Thread ID: ${result.threadId}`);
      console.log(`  Project:   ${result.cwd}`);
      console.log(`  Mode:      ${result.mode}`);
      console.log(`  Path:      ${result.path}`);

      if (result.mode === 'handoff') {
        console.log('');
        console.log('  Ask Codex on this machine to continue from:');
        console.log(`  ${result.path}/handoff.md`);
      } else {
        console.log('');
        console.log('  Reopen Codex Desktop/CLI if the imported thread does not appear immediately.');
      }

      p.outro('Done!');
    } catch (err) {
      spinner.stop('Failed.');
      p.log.error(String(err));
      process.exit(1);
    }
  });

program
  .command('push')
  .description('Send a chat session to another machine')
  .option('-s, --session <id>', 'Session ID to push (default: interactive)')
  .action(async (opts) => {
    const claudeDir = getClaudeDir();
    const sessions = listSessions(claudeDir);

    if (sessions.length === 0) {
      p.log.error('No Claude Code sessions found.');
      process.exit(1);
    }

    let selectedSessions: SessionMeta[];

    if (opts.session) {
      // 直接指定
      const session = sessions.find(s => s.sessionId === opts.session || s.sessionId.startsWith(opts.session));
      if (!session) {
        p.log.error(`Session not found: ${opts.session}`);
        process.exit(1);
      }
      selectedSessions = [session];
    } else {
      // カレントプロジェクト配下のセッションを優先表示
      const cwd = process.cwd();
      const projectSessions = sessions.filter(s => s.cwd === cwd);
      const candidates = projectSessions.length > 0 ? projectSessions : sessions;

      if (candidates.length === 1) {
        selectedSessions = [candidates[0]];
      } else {
      // TUIで選択
      p.intro('move-agent-chat push');

      if (projectSessions.length === 0) {
        p.log.warn(`No sessions found for ${basename(cwd)} — showing all projects`);
      }

      const selected = await p.multiselect({
        message: 'Select sessions to push (space to select, enter to confirm)',
        options: candidates.slice(0, 30).map(s => ({
          value: s.sessionId,
          label: formatSessionLabel(s, claudeDir),
        })),
        required: true,
      });

      if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }

      selectedSessions = candidates.filter(s => (selected as string[]).includes(s.sessionId));
      }
    }

    p.log.warn('Sessions may contain secrets (API keys, passwords, tokens). Data is encrypted in transit but review before sharing.');

    // push各セッション
    const results: { session: SessionMeta; code: string }[] = [];

    const spinner = p.spinner();
    for (const session of selectedSessions) {
      const label = `${session.sessionId.slice(0, 8)} (${basename(session.cwd)})`;
      spinner.start(`Pushing ${label}...`);

      try {
        const { code } = await pushSession(session, claudeDir);
        results.push({ session, code });
        spinner.stop(`Pushed ${label}`);
      } catch (err) {
        spinner.stop(`Failed to push ${label}: ${err}`);
      }
    }

    // 結果表示
    if (results.length === 0) {
      p.log.error('No sessions were pushed.');
      process.exit(1);
    }

    console.log('');
    for (const r of results) {
      const id = r.session.sessionId.slice(0, 8);
      const project = basename(r.session.cwd);
      p.log.success(`${id} (${project})`);
      console.log(`  move-agent-chat pull ${r.code}`);
      console.log('');
    }

    p.outro(`${results.length} session(s) pushed. Gists will be auto-deleted after pull.`);
  });

program
  .command('pull')
  .description('Receive a chat session from another machine')
  .argument('<code>', 'Transfer code from push command')
  .option('--cwd <path>', 'Override project directory on this machine')
  .action(async (code: string, opts) => {
    p.intro('move-agent-chat pull');

    const spinner = p.spinner();

    try {
      spinner.start('Downloading...');
      const { key, gistId } = parseTransferCode(code);
      const encrypted = downloadFromGist(gistId);
      spinner.stop('Downloaded.');

      spinner.start('Decrypting and unpacking...');
      const bundle = decrypt(encrypted, key);
      const claudeDir = getClaudeDir();
      const { sessionId, cwd } = unpackSession(claudeDir, bundle, opts.cwd ?? null);
      spinner.stop('Unpacked.');

      spinner.start('Cleaning up gist...');
      try {
        deleteGist(gistId);
        spinner.stop('Gist deleted.');
      } catch {
        spinner.stop(`Could not delete gist — delete it manually: https://gist.github.com/${gistId}`);
      }

      p.log.success('Session imported!');
      console.log(`  Session ID: ${sessionId}`);
      console.log(`  Project:    ${cwd}`);

      if (!checkCwdExists(cwd)) {
        p.log.warn(`Directory ${cwd} does not exist on this machine. Use --cwd to specify the correct path.`);
      }

      console.log('');
      console.log('  Resume with:');
      console.log(`  cd ${cwd} && claude --resume ${sessionId}`);

      p.outro('Done!');
    } catch (err) {
      spinner.stop('Failed.');
      p.log.error(String(err));
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List local Claude Code sessions')
  .action(async () => {
    const claudeDir = getClaudeDir();
    const sessions = listSessions(claudeDir);

    if (sessions.length === 0) {
      console.log('No sessions found.');
      return;
    }

    // cwdでグルーピング
    const grouped = new Map<string, SessionMeta[]>();
    for (const s of sessions) {
      const existing = grouped.get(s.cwd) ?? [];
      existing.push(s);
      grouped.set(s.cwd, existing);
    }

    console.log('');
    for (const [cwd, cwdSessions] of grouped) {
      const project = basename(cwd);
      console.log(`  ${project} (${cwd})`);
      for (const s of cwdSessions) {
        const id = s.sessionId.slice(0, 8);
        const date = new Date(s.startedAt).toLocaleString();
        const size = formatSize(getConversationSize(claudeDir, s));
        const alive = isProcessAlive(s.pid);
        const status = alive ? ' [ACTIVE]' : '';
        console.log(`    ${id}  ${date}  ${size}${status}`);
      }
      console.log('');
    }
  });

program.parse();
