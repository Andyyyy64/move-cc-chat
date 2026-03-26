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

const program = new Command();

program
  .name('move-chat')
  .description('Move Claude Code chat sessions between machines')
  .version('0.1.0');

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
      p.intro('move-chat push');

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
      console.log(`  move-chat pull ${r.code}`);
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
    p.intro('move-chat pull');

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
        spinner.stop('Could not delete gist — delete it manually.');
      }

      p.log.success('Session imported!');
      console.log(`  Session ID: ${sessionId}`);
      console.log(`  Project:    ${cwd}`);
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
