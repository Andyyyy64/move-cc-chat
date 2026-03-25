#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { Command } from 'commander';
import { listSessions, getSessionFiles, getClaudeDir } from './session.js';
import { packSession } from './pack.js';
import { unpackSession } from './unpack.js';
import { generateTransferCode, parseTransferCode, encrypt, decrypt } from './crypto.js';
import { uploadToGist, downloadFromGist, deleteGist } from './transport.js';

const program = new Command();

program
  .name('move-chat')
  .description('Move Claude Code chat sessions between machines')
  .version('0.1.0');

program
  .command('push')
  .description('Send a chat session to another machine')
  .option('-s, --session <id>', 'Session ID to push (default: most recent)')
  .action(async (opts) => {
    const claudeDir = getClaudeDir();
    const sessions = listSessions(claudeDir);

    if (sessions.length === 0) {
      console.error('No Claude Code sessions found.');
      process.exit(1);
    }

    let session;
    if (opts.session) {
      session = sessions.find(s => s.sessionId === opts.session || s.sessionId.startsWith(opts.session));
      if (!session) {
        console.error(`Session not found: ${opts.session}`);
        process.exit(1);
      }
    } else {
      session = sessions[0];
    }

    console.log(`Packing session ${session.sessionId.slice(0, 8)}...`);
    console.log(`  Project: ${session.cwd}`);
    console.log(`  Started: ${new Date(session.startedAt).toLocaleString()}`);

    // 1. Pack
    const bundle = packSession(claudeDir, session);
    console.log(`  Bundle size: ${(bundle.length / 1024).toFixed(1)} KB`);

    // 2. Generate key
    const key = randomBytes(32);

    // 3. Encrypt
    console.log('Encrypting...');
    const encrypted = encrypt(bundle, key);

    // 4. Upload
    console.log('Uploading to GitHub Gist...');
    const gistId = uploadToGist(encrypted);

    // 5. Build transfer code: words + keyHex + gistId
    const { code } = generateTransferCode(gistId, key);

    console.log('');
    console.log('='.repeat(50));
    console.log('  Transfer code:');
    console.log('');
    console.log(`    ${code}`);
    console.log('');
    console.log('  On the other machine, run:');
    console.log(`    move-chat pull ${code}`);
    console.log('='.repeat(50));
    console.log('');
    console.log('The gist will be auto-deleted after pull.');
  });

program
  .command('pull')
  .description('Receive a chat session from another machine')
  .argument('<code>', 'Transfer code from push command')
  .option('--cwd <path>', 'Override project directory on this machine')
  .action(async (code: string, opts) => {
    console.log('Parsing transfer code...');
    const { key, gistId } = parseTransferCode(code);

    console.log('Downloading from GitHub Gist...');
    const encrypted = downloadFromGist(gistId);

    console.log('Decrypting...');
    const bundle = decrypt(encrypted, key);

    const claudeDir = getClaudeDir();
    console.log('Unpacking session...');
    const { sessionId, cwd } = unpackSession(claudeDir, bundle, opts.cwd ?? null);

    console.log('Cleaning up gist...');
    try {
      deleteGist(gistId);
    } catch {
      console.log('  (Could not delete gist — you may want to delete it manually)');
    }

    console.log('');
    console.log('Session imported successfully!');
    console.log(`  Session ID: ${sessionId}`);
    console.log(`  Project: ${cwd}`);
    console.log('');
    console.log('Resume with:');
    console.log(`  claude --resume ${sessionId}`);
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

    console.log('Recent Claude Code sessions:\n');
    for (const s of sessions.slice(0, 20)) {
      const date = new Date(s.startedAt).toLocaleString();
      console.log(`  ${s.sessionId.slice(0, 8)}  ${date}  ${s.cwd}`);
    }
  });

program.parse();
