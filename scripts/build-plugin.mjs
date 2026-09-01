import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(repositoryRoot, 'plugins/move-agent-chat/mcp/server.mjs');

await mkdir(dirname(output), { recursive: true });
await build({
  entryPoints: [resolve(repositoryRoot, 'src/mcp.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  sourcemap: false,
  legalComments: 'none',
  minifyWhitespace: true,
});

const bundled = await readFile(output, 'utf8');
await writeFile(output, bundled.replace(/^[\t ]+$/gm, ''), { mode: 0o755 });
