import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const sourceDir = join(repoRoot, 'codex-plusplus', 'move-agent-chat');

function candidateDirs() {
  const home = homedir();
  const candidates = [
    process.env.CODEX_PLUSPLUS_TWEAKS_DIR,
    join(home, '.local', 'share', 'codex-plusplus', 'tweaks'),
    join(home, '.config', 'codex-plusplus', 'tweaks'),
    join(home, '.codex-plusplus', 'tweaks'),
  ].filter(Boolean);

  if (platform() === 'darwin') {
    candidates.push(join(home, 'Library', 'Application Support', 'codex-plusplus', 'tweaks'));
  }

  if (platform() === 'win32' && process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'codex-plusplus', 'tweaks'));
  }

  return [...new Set(candidates)];
}

const explicitTarget = process.argv[2];
const targetRoot = explicitTarget
  ? resolve(explicitTarget)
  : candidateDirs().find(dir => existsSync(dirname(dir)) || existsSync(dir)) ?? candidateDirs()[0];
const targetDir = join(targetRoot, 'move-agent-chat');

if (!existsSync(sourceDir)) {
  throw new Error(`Missing tweak source: ${sourceDir}`);
}

mkdirSync(targetRoot, { recursive: true });
rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log(`Installed Move Agent Chat Codex++ tweak to ${targetDir}`);
console.log('Restart Codex Desktop, then open Settings -> Tweaks -> Move Agent Chat.');
