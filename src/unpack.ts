import { existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { encodeProjectPath } from './session.js';
import type { BundleManifest } from './pack.js';

interface BundleData {
  manifest: BundleManifest;
  files: Record<string, string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validateManifest(manifest: BundleManifest): void {
  if (manifest.version !== 1) throw new Error(`Unsupported bundle version: ${manifest.version}`);
  if (!manifest.sessionId || !UUID_RE.test(manifest.sessionId)) {
    throw new Error(`Invalid sessionId in bundle: ${manifest.sessionId}`);
  }
  if (!manifest.cwd || typeof manifest.cwd !== 'string') {
    throw new Error('Invalid cwd in bundle');
  }
}

function assertNoPathTraversal(targetPath: string, baseDir: string): void {
  const resolved = resolve(targetPath);
  const resolvedBase = resolve(baseDir);
  if (!resolved.startsWith(resolvedBase + sep) && resolved !== resolvedBase) {
    throw new Error(`Path traversal detected: ${targetPath} escapes ${baseDir}`);
  }
}

/**
 * Unpack a session bundle into the local ~/.claude/ directory.
 * If newCwd is provided, all paths are rewritten to point to the new location.
 */
export function unpackSession(claudeDir: string, bundle: Buffer, newCwd: string | null): { sessionId: string; cwd: string } {
  const json = gunzipSync(bundle).toString('utf-8');
  const data: BundleData = JSON.parse(json);
  const { manifest, files } = data;

  validateManifest(manifest);

  const effectiveCwd = newCwd ?? manifest.cwd;
  const newEncodedDir = encodeProjectPath(effectiveCwd);
  const projectDir = join(claudeDir, 'projects', newEncodedDir);

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });

  for (const [relPath, base64Content] of Object.entries(files)) {
    const content = Buffer.from(base64Content, 'base64');

    if (relPath === 'conversation.jsonl') {
      const rewritten = rewritePaths(content.toString('utf-8'), manifest.cwd, effectiveCwd);
      writeFileSync(join(projectDir, `${manifest.sessionId}.jsonl`), rewritten);

    } else if (relPath === 'session.json') {
      const meta = JSON.parse(content.toString('utf-8'));
      meta.cwd = effectiveCwd;
      meta.pid = 0;
      // sessionIdベースのファイル名で保存（重複回避）
      writeFileSync(join(claudeDir, 'sessions', `imported-${manifest.sessionId}.json`), JSON.stringify(meta));

    } else if (relPath === 'history.jsonl') {
      const rewritten = rewritePaths(content.toString('utf-8'), manifest.cwd, effectiveCwd);
      const historyPath = join(claudeDir, 'history.jsonl');
      appendFileSync(historyPath, rewritten);

    } else if (relPath.startsWith('subagents/')) {
      const subPath = join(projectDir, manifest.sessionId, relPath.replace('subagents/', ''));
      // パストラバーサル防止
      assertNoPathTraversal(subPath, join(projectDir, manifest.sessionId));
      mkdirSync(dirname(subPath), { recursive: true });
      writeFileSync(subPath, content);
    }
  }

  return { sessionId: manifest.sessionId, cwd: effectiveCwd };
}

/**
 * Check if the target cwd exists on this machine.
 */
export function checkCwdExists(cwd: string): boolean {
  return existsSync(cwd);
}

/**
 * Replace all occurrences of oldCwd with newCwd in a text.
 * Also handles the encoded project dir format.
 */
function rewritePaths(text: string, oldCwd: string, newCwd: string): string {
  if (oldCwd === newCwd) return text;

  let result = text.replaceAll(oldCwd, newCwd);

  const oldEncoded = encodeProjectPath(oldCwd);
  const newEncoded = encodeProjectPath(newCwd);
  result = result.replaceAll(oldEncoded, newEncoded);

  return result;
}
