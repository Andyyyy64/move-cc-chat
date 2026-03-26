import { describe, it, expect } from 'vitest';
import { buildUploadArgs, buildDownloadArgs, parseGistUrl } from '../transport.js';

describe('buildUploadArgs', () => {
  it('constructs gh gist create command args', () => {
    const args = buildUploadArgs('/tmp/bundle.enc', 'move-chat transfer');
    expect(args).toEqual([
      'gist', 'create', '/tmp/bundle.enc',
      '--desc', 'move-chat transfer',
    ]);
  });
});

describe('buildDownloadArgs', () => {
  it('constructs gh gist view command args for raw content', () => {
    const args = buildDownloadArgs('abc123');
    expect(args).toEqual([
      'gist', 'view', 'abc123', '--raw', '--filename', 'session.bin',
    ]);
  });
});

describe('parseGistUrl', () => {
  it('extracts gist ID from URL', () => {
    expect(parseGistUrl('https://gist.github.com/user/abc123def456')).toBe('abc123def456');
  });

  it('returns raw ID if not a URL', () => {
    expect(parseGistUrl('abc123def456')).toBe('abc123def456');
  });
});
