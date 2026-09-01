import { execFileSync } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sha256, type SyncBundleV3, validateSyncBundle } from './codex-sync.js';

const DEVICE_MARKER = 'move-agent-chat-device-v1';
const TRANSFER_MARKER = 'move-agent-chat-transfer-v3';
const ENVELOPE_INFO = Buffer.from('move-agent-chat-transfer-v3', 'utf8');
const MAX_ENVELOPE_BYTES = 260 * 1024 * 1024;
const MAX_DECOMPRESSED_BUNDLE_BYTES = 300 * 1024 * 1024;

export interface DeviceCard {
  schemaVersion: 1;
  deviceId: string;
  name: string;
  publicKey: string;
  createdAt: string;
  gistId?: string;
}

export interface DeviceIdentity extends DeviceCard {
  privateKey: string;
}

export interface TransferEnvelopeV1 {
  schemaVersion: 1;
  kind: 'move-agent-chat-encrypted-transfer';
  sourceDeviceId: string;
  targetDeviceId: string;
  threadId: string;
  createdAt: string;
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  plaintextSha256: string;
}

export interface InboxItem {
  uploadId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  threadId: string;
  createdAt: string;
  description: string;
}

export interface StoredObjectSummary {
  id: string;
  description: string;
  createdAt: string;
}

export interface TransferStore {
  list(): StoredObjectSummary[];
  create(filename: string, description: string, content: string): string;
  read(id: string, filename: string): string;
  delete(id: string): void;
}

export class GitHubGistStore implements TransferStore {
  list(): StoredObjectSummary[] {
    const output = execFileSync('gh', ['api', '--paginate', '--slurp', '/gists?per_page=100'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 20 * 1024 * 1024,
    });
    const pages = JSON.parse(output) as Array<Array<{ id: string; description?: string; created_at?: string }>>;
    const rows = pages.flat();
    return rows.map(row => ({ id: row.id, description: row.description || '', createdAt: row.created_at || '' }));
  }

  create(filename: string, description: string, content: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'move-agent-chat-gist-'));
    const path = join(directory, filename);
    writeFileSync(path, content, { mode: 0o600 });
    try {
      const output = execFileSync('gh', ['gist', 'create', path, '--desc', description], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      }).trim();
      const parts = output.split('/');
      const id = parts[parts.length - 1];
      if (!id) throw new Error('GitHub did not return a Gist ID');
      return id;
    } finally {
      try { unlinkSync(path); } catch { /* ignore temporary cleanup failure */ }
      try { rmdirSync(directory); } catch { /* ignore temporary cleanup failure */ }
    }
  }

  read(id: string, filename: string): string {
    return execFileSync('gh', ['gist', 'view', id, '--raw', '--filename', filename], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: MAX_ENVELOPE_BYTES,
    });
  }

  delete(id: string): void {
    execFileSync('gh', ['gist', 'delete', id, '--yes'], { encoding: 'utf8', timeout: 15_000 });
  }
}

export class MemoryTransferStore implements TransferStore {
  private readonly objects = new Map<string, { filename: string; description: string; content: string; createdAt: string }>();

  list(): StoredObjectSummary[] {
    return [...this.objects].map(([id, object]) => ({ id, description: object.description, createdAt: object.createdAt }));
  }

  create(filename: string, description: string, content: string): string {
    const id = sha256(`${filename}\0${description}\0${content}\0${this.objects.size}`).slice(0, 32);
    this.objects.set(id, { filename, description, content, createdAt: new Date().toISOString() });
    return id;
  }

  read(id: string, filename: string): string {
    const object = this.objects.get(id);
    if (!object || object.filename !== filename) throw new Error(`Stored object not found: ${id}/${filename}`);
    return object.content;
  }

  delete(id: string): void {
    if (!this.objects.delete(id)) throw new Error(`Stored object not found: ${id}`);
  }
}

export function defaultIdentityPath(): string {
  return join(homedir(), '.move-agent-chat', 'device.json');
}

export function registerDevice(
  name: string,
  options: { identityPath?: string; store?: TransferStore } = {},
): DeviceCard {
  const normalizedName = validateDeviceName(name);
  const identityPath = resolve(options.identityPath || defaultIdentityPath());
  const store = options.store || new GitHubGistStore();
  const cards = listDevices(store);
  let identity: DeviceIdentity;
  if (existsSync(identityPath)) {
    identity = readIdentity(identityPath);
    if (identity.name !== normalizedName) {
      throw new Error(`This device is already registered as ${identity.name}; device names are immutable`);
    }
  } else {
    if (cards.some(card => card.name === normalizedName)) {
      throw new Error(`Another device already uses the name ${normalizedName}; its private key is not available on this machine`);
    }
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const publicDer = publicKey.export({ format: 'der', type: 'spki' });
    const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
    identity = {
      schemaVersion: 1,
      deviceId: sha256(publicDer).slice(0, 32),
      name: normalizedName,
      publicKey: publicDer.toString('base64'),
      privateKey: privateDer.toString('base64'),
      createdAt: new Date().toISOString(),
    };
    mkdirSync(dirname(identityPath), { recursive: true });
    writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try { chmodSync(identityPath, 0o600); } catch { /* Windows does not expose POSIX modes */ }
  }

  const conflictingName = cards.find(card => card.name === identity.name && card.deviceId !== identity.deviceId);
  if (conflictingName) throw new Error(`Another device already uses the name ${identity.name}`);
  if (!cards.some(card => card.deviceId === identity.deviceId)) {
    const card: DeviceCard = {
      schemaVersion: 1,
      deviceId: identity.deviceId,
      name: identity.name,
      publicKey: identity.publicKey,
      createdAt: identity.createdAt,
    };
    const description = `${DEVICE_MARKER} id:${card.deviceId} name:${encodeURIComponent(card.name)}`;
    store.create('device.json', description, `${JSON.stringify(card)}\n`);
  }
  return toCard(identity);
}

export function listDevices(store: TransferStore = new GitHubGistStore()): DeviceCard[] {
  const cards: DeviceCard[] = [];
  for (const summary of store.list().filter(item => item.description.startsWith(DEVICE_MARKER))) {
    try {
      const card = JSON.parse(store.read(summary.id, 'device.json')) as DeviceCard;
      validateDeviceCard(card);
      cards.push({ ...card, gistId: summary.id });
    } catch {
      // A malformed card is ignored rather than becoming an encryption target.
    }
  }
  return cards.sort((a, b) => a.name.localeCompare(b.name));
}

export function uploadForDevice(
  bundle: SyncBundleV3,
  target: DeviceCard,
  options: { identityPath?: string; store?: TransferStore } = {},
): InboxItem {
  validateDeviceCard(target);
  const identity = readIdentity(resolve(options.identityPath || defaultIdentityPath()));
  if (bundle.manifest.sourceDeviceId !== identity.deviceId) throw new Error('Bundle source does not match this device');
  if (bundle.manifest.targetDeviceId !== target.deviceId) throw new Error('Bundle target does not match selected device');
  validateSyncBundle(bundle);
  const envelope = encryptBundle(bundle, identity.deviceId, target);
  const description = [
    TRANSFER_MARKER,
    `to:${target.deviceId}`,
    `from:${identity.deviceId}`,
    `thread:${bundle.manifest.rollout.threadId}`,
    `created:${encodeURIComponent(envelope.createdAt)}`,
  ].join(' ');
  const store = options.store || new GitHubGistStore();
  const serializedEnvelope = JSON.stringify(envelope);
  if (Buffer.byteLength(serializedEnvelope) > MAX_ENVELOPE_BYTES) throw new Error('Transfer envelope exceeds size limit');
  const uploadId = store.create('transfer.json', description, serializedEnvelope);
  return {
    uploadId,
    sourceDeviceId: identity.deviceId,
    targetDeviceId: target.deviceId,
    threadId: envelope.threadId,
    createdAt: envelope.createdAt,
    description,
  };
}

export function listInbox(options: { identityPath?: string; store?: TransferStore } = {}): InboxItem[] {
  const identity = readIdentity(resolve(options.identityPath || defaultIdentityPath()));
  const store = options.store || new GitHubGistStore();
  const prefix = `${TRANSFER_MARKER} to:${identity.deviceId} `;
  const items: InboxItem[] = [];
  for (const summary of store.list().filter(item => item.description.startsWith(prefix))) {
    const fields = parseDescription(summary.description);
    const sourceDeviceId = fields.from;
    const threadId = fields.thread;
    if (!sourceDeviceId || !threadId) continue;
    items.push({
      uploadId: summary.id,
      sourceDeviceId,
      targetDeviceId: identity.deviceId,
      threadId,
      createdAt: fields.created ? decodeURIComponent(fields.created) : summary.createdAt,
      description: summary.description,
    });
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function downloadInboxBundle(
  uploadId: string,
  options: { identityPath?: string; store?: TransferStore } = {},
): SyncBundleV3 {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(uploadId)) throw new Error('Invalid upload ID');
  const identity = readIdentity(resolve(options.identityPath || defaultIdentityPath()));
  const store = options.store || new GitHubGistStore();
  const raw = store.read(uploadId, 'transfer.json');
  if (Buffer.byteLength(raw) > MAX_ENVELOPE_BYTES) throw new Error('Transfer envelope exceeds size limit');
  const envelope = JSON.parse(raw) as TransferEnvelopeV1;
  const bundle = decryptBundle(envelope, identity);
  validateSyncBundle(bundle);
  if (bundle.manifest.targetDeviceId !== identity.deviceId) throw new Error('Transfer is not addressed to this device');
  return bundle;
}

export function deleteInboxUpload(uploadId: string, store: TransferStore = new GitHubGistStore()): void {
  store.delete(uploadId);
}

export function readIdentity(path = defaultIdentityPath()): DeviceIdentity {
  if (!existsSync(path)) throw new Error('This device is not registered');
  const identity = JSON.parse(readFileSync(path, 'utf8')) as DeviceIdentity;
  validateDeviceCard(identity);
  if (!identity.privateKey) throw new Error('Device identity is missing its private key');
  const privateKey = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const derivedPublic = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (sha256(derivedPublic).slice(0, 32) !== identity.deviceId) throw new Error('Device identity key mismatch');
  return identity;
}

function encryptBundle(bundle: SyncBundleV3, sourceDeviceId: string, target: DeviceCard): TransferEnvelopeV1 {
  const plaintext = gzipSync(Buffer.from(JSON.stringify(bundle)));
  const recipient = createPublicKey({ key: Buffer.from(target.publicKey, 'base64'), format: 'der', type: 'spki' });
  const ephemeral = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const salt = randomBytes(32);
  const key = Buffer.from(hkdfSync('sha256', shared, salt, ENVELOPE_INFO, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schemaVersion: 1,
    kind: 'move-agent-chat-encrypted-transfer',
    sourceDeviceId,
    targetDeviceId: target.deviceId,
    threadId: bundle.manifest.rollout.threadId,
    createdAt: new Date().toISOString(),
    ephemeralPublicKey: ephemeral.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    plaintextSha256: sha256(plaintext),
  };
}

function decryptBundle(envelope: TransferEnvelopeV1, identity: DeviceIdentity): SyncBundleV3 {
  if (envelope.schemaVersion !== 1 || envelope.kind !== 'move-agent-chat-encrypted-transfer') {
    throw new Error('Unsupported transfer envelope');
  }
  if (envelope.targetDeviceId !== identity.deviceId) throw new Error('Transfer is addressed to another device');
  const privateKey = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const ephemeral = createPublicKey({ key: Buffer.from(envelope.ephemeralPublicKey, 'base64'), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(envelope.salt, 'base64'), ENVELOPE_INFO, 32));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  if (sha256(plaintext) !== envelope.plaintextSha256) throw new Error('Transfer plaintext integrity check failed');
  const parsed = JSON.parse(gunzipSync(plaintext, { maxOutputLength: MAX_DECOMPRESSED_BUNDLE_BYTES }).toString('utf8')) as SyncBundleV3;
  if (parsed.manifest.sourceDeviceId !== envelope.sourceDeviceId || parsed.manifest.rollout.threadId !== envelope.threadId) {
    throw new Error('Transfer envelope metadata does not match bundle');
  }
  return parsed;
}

function validateDeviceCard(card: DeviceCard): void {
  if (card.schemaVersion !== 1) throw new Error('Unsupported device card');
  if (!/^[0-9a-f]{32}$/.test(card.deviceId)) throw new Error('Invalid device ID');
  validateDeviceName(card.name);
  const publicKey = createPublicKey({ key: Buffer.from(card.publicKey, 'base64'), format: 'der', type: 'spki' });
  const exported = publicKey.export({ format: 'der', type: 'spki' });
  if (sha256(exported).slice(0, 32) !== card.deviceId) throw new Error('Device public key does not match device ID');
}

function validateDeviceName(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error('Device name must be 1-64 characters using letters, digits, dot, underscore, or hyphen');
  }
  return normalized;
}

function toCard(identity: DeviceIdentity): DeviceCard {
  return {
    schemaVersion: 1,
    deviceId: identity.deviceId,
    name: identity.name,
    publicKey: identity.publicKey,
    createdAt: identity.createdAt,
  };
}

function parseDescription(description: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const part of description.split(' ')) {
    const separator = part.indexOf(':');
    if (separator > 0) output[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return output;
}
