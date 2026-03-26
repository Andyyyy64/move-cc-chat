import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function buildUploadArgs(filePath: string, description: string): string[] {
  return ['gist', 'create', filePath, '--desc', description];
}

export function buildDownloadArgs(gistId: string): string[] {
  return ['gist', 'view', gistId, '--raw', '--filename', 'session.bin'];
}

export function parseGistUrl(urlOrId: string): string {
  if (urlOrId.includes('/')) {
    const parts = urlOrId.split('/');
    return parts[parts.length - 1];
  }
  return urlOrId;
}

/**
 * Upload encrypted bundle to a private GitHub Gist.
 * Returns the gist ID.
 */
export function uploadToGist(encryptedData: Buffer): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'move-chat-'));
  const filePath = join(tmpDir, 'session.bin');

  writeFileSync(filePath, encryptedData.toString('base64'));

  try {
    const result = execFileSync('gh', buildUploadArgs(filePath, 'move-chat session transfer'), {
      encoding: 'utf-8',
      timeout: 30000,
    });

    const url = result.trim();
    return parseGistUrl(url);
  } finally {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}

/**
 * Download encrypted bundle from a GitHub Gist.
 * Returns the encrypted data as Buffer.
 */
export function downloadFromGist(gistId: string): Buffer {
  const result = execFileSync('gh', buildDownloadArgs(gistId), {
    encoding: 'utf-8',
    timeout: 30000,
    maxBuffer: 50 * 1024 * 1024,
  });

  return Buffer.from(result.trim(), 'base64');
}

/**
 * Delete a gist after successful transfer.
 */
export function deleteGist(gistId: string): void {
  execFileSync('gh', ['gist', 'delete', gistId, '--yes'], {
    encoding: 'utf-8',
    timeout: 15000,
  });
}
