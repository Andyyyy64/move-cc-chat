import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { encodeProjectPath } from './session.js';
import type { BundleManifest } from './pack.js';

interface BundleData {
  manifest: BundleManifest;
  files: Record<string, string>;
}

/**
 * Unpack a session bundle into the local ~/.claude/ directory.
 * If newCwd is provided, all paths are rewritten to point to the new location.
 */
export function unpackSession(claudeDir: string, bundle: Buffer, newCwd: string | null): { sessionId: string; cwd: string } {
  const json = gunzipSync(bundle).toString('utf-8');
  const data: BundleData = JSON.parse(json);
  const { manifest, files } = data;

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
      mkdirSync(dirname(subPath), { recursive: true });
      writeFileSync(subPath, content);
    }
  }

  return { sessionId: manifest.sessionId, cwd: effectiveCwd };
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
