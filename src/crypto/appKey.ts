import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AppKey {
  key: Buffer;
  fingerprint: string;
  version: number;
  source: 'env' | 'file';
}

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const candidates = [Buffer.from(trimmed, 'base64'), Buffer.from(trimmed, 'hex')];
  const found = candidates.find((buffer) => buffer.length === 32);
  if (!found) throw new Error('APP_KEY must be 32 bytes, base64 or hex encoded');
  return found;
}

export function loadAppKey(dataDir: string, envKey?: string): AppKey {
  if (envKey && envKey.trim()) {
    const key = decodeKey(envKey);
    return { key, fingerprint: fingerprint(key), version: 1, source: 'env' };
  }

  const file = path.join(dataDir, 'app.key');
  if (fs.existsSync(file)) {
    const key = decodeKey(fs.readFileSync(file, 'utf8'));
    return { key, fingerprint: fingerprint(key), version: 1, source: 'file' };
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600 });
  return { key, fingerprint: fingerprint(key), version: 1, source: 'file' };
}

export function fingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}
