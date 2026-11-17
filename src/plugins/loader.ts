import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Adapter, Manifest, PluginRecord } from '../types.js';
import { AdapterSchema, ManifestSchema } from './schema.js';

const cache = new Map<string, PluginRecord>();

function sha256(...parts: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

function assertSafeUrl(raw: string, baseOrigin: string, label: string): URL {
  const url = new URL(raw);
  if (url.origin !== baseOrigin) {
    throw new Error(`${label} must stay on ${baseOrigin}`);
  }
  return url;
}

export function loadBuiltinPlugins(): PluginRecord[] {
  cache.clear();
  if (!fs.existsSync(config.pluginDir)) return [];

  const entries = fs.readdirSync(config.pluginDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const loaded: PluginRecord[] = [];

  for (const entry of entries) {
    const dir = path.join(config.pluginDir, entry.name);
    const manifestPath = path.join(dir, 'manifest.json');
    const adapterPath = path.join(dir, 'adapter.json');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(adapterPath)) continue;

    const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    const adapterRaw = fs.readFileSync(adapterPath, 'utf8');
    const manifest = ManifestSchema.parse(JSON.parse(manifestRaw)) as Manifest;
    const adapter = AdapterSchema.parse(JSON.parse(adapterRaw)) as Adapter;

    if (manifest.id !== entry.name) {
      throw new Error(`Plugin directory ${entry.name} does not match manifest id ${manifest.id}`);
    }

    const base = new URL(adapter.baseUrl);
    const allowedOrigins = new Set(manifest.permissions.network.map((item) => new URL(item).origin));
    if (!allowedOrigins.has(base.origin)) {
      throw new Error(`${manifest.id}: baseUrl is not in permissions.network`);
    }

    if (adapter.defaultHeaders.origin) {
      assertSafeUrl(adapter.defaultHeaders.origin, base.origin, `${manifest.id}: origin header`);
    }
    if (adapter.defaultHeaders.referer) {
      assertSafeUrl(adapter.defaultHeaders.referer, base.origin, `${manifest.id}: referer header`);
    }

    for (const [name, request] of Object.entries(adapter.requests)) {
      if (request.path.includes('..') || request.path.startsWith('//')) {
        throw new Error(`${manifest.id}: unsafe path in ${name}`);
      }
      const resolved = new URL(request.path, adapter.baseUrl);
      if (resolved.origin !== base.origin) {
        throw new Error(`${manifest.id}: ${name} leaves the declared origin`);
      }
    }

    const plugin: PluginRecord = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      manifest,
      adapter,
      checksum: sha256(manifestRaw, adapterRaw),
      enabled: true,
      source: 'builtin',
    };

    cache.set(plugin.id, plugin);
    loaded.push(plugin);
  }

  return loaded;
}

export function getLoadedPlugin(id: string): PluginRecord | undefined {
  return cache.get(id);
}

export function listLoadedPlugins(): PluginRecord[] {
  return [...cache.values()];
}
