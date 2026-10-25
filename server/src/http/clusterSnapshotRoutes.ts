// Portable cluster snapshot file + encrypted cloud-vault HTTP surface.
// Large binary payloads stay off the WebSocket protocol.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import {
  importSnapshotFiles,
  listSnapshots,
  readSnapshotFiles,
  SnapshotValidationError,
} from '../clusterSnapshots.js';
import {
  MAX_CLUSTER_BUNDLE_BYTES,
  readClusterBundle,
  writeClusterBundle,
} from '../clusterSnapshotBundle.js';
import {
  decryptVaultBlob,
  encryptVaultBlob,
  exportVaultKey,
  importVaultKey,
  readVaultKey,
} from '../clusterVaultCrypto.js';

const MAX_HTTP_BYTES = MAX_CLUSTER_BUNDLE_BYTES + 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function readRaw(req: IncomingMessage, cap = MAX_HTTP_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function hubBase(): URL | null {
  const raw = process.env.ARCHON_HUB_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function hubUrl(pathname: string): URL {
  const base = hubBase();
  if (!base) throw new Error('management hub is not configured');
  return new URL(pathname, base);
}

async function hubJson(pathname: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(hubUrl(pathname), init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `cloud vault request failed (${response.status})`);
  return body;
}

function safeDownloadName(name: string): string {
  const base = name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'cluster';
  return `${base.slice(0, 80)}.archoncluster`;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser operator tooling
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export async function tryHandleClusterSnapshotRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/cluster-snapshots')) return false;

  try {
    if (req.method === 'GET' && url.pathname === '/api/cluster-snapshots') {
      return json(res, 200, { snapshots: await listSnapshots() });
    }

    if (req.method === 'GET' && url.pathname === '/api/cluster-snapshots/vault/status') {
      return json(res, 200, {
        hubConfigured: hubBase() !== null,
        keyConfigured: (await readVaultKey(false)) !== null,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/cluster-snapshots/vault/key') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'same-origin request required' });
      return json(res, 200, { key: await exportVaultKey() });
    }

    if (req.method === 'POST' && url.pathname === '/api/cluster-snapshots/vault/key') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'same-origin request required' });
      try {
        const body = JSON.parse((await readRaw(req, 4096)).toString('utf8')) as { key?: string };
        if (!body.key) return json(res, 400, { error: 'missing key' });
        await importVaultKey(body.key);
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/cluster-snapshots/import') {
      try {
        const summary = await importSnapshotFiles(readClusterBundle(await readRaw(req)));
        return json(res, 201, { snapshot: summary });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/cluster-snapshots/cloud') {
      const body = await hubJson('/api/cluster-vault');
      return json(res, 200, body);
    }

    const exportMatch = url.pathname.match(/^\/api\/cluster-snapshots\/([^/]+)\/export$/);
    if (req.method === 'GET' && exportMatch) {
      const id = decodeURIComponent(exportMatch[1]);
      const summaries = await listSnapshots();
      const summary = summaries.find((s) => s.id === id);
      if (!summary) return json(res, 404, { error: 'snapshot not found' });
      const bundle = writeClusterBundle(await readSnapshotFiles(id));
      res.writeHead(200, {
        'Content-Type': 'application/vnd.archon.cluster+gzip',
        'Content-Disposition': `attachment; filename="${safeDownloadName(summary.name)}"`,
        'Content-Length': String(bundle.length),
        'Cache-Control': 'no-store',
      });
      res.end(bundle);
      return true;
    }

    const uploadMatch = url.pathname.match(/^\/api\/cluster-snapshots\/([^/]+)\/cloud$/);
    if (req.method === 'POST' && uploadMatch) {
      const id = decodeURIComponent(uploadMatch[1]);
      const summary = (await listSnapshots()).find((s) => s.id === id);
      if (!summary) return json(res, 404, { error: 'snapshot not found' });
      const cloudList = await hubJson('/api/cluster-vault') as { snapshots?: Array<{
        id: string;
        name: string;
        uploadedAt: string;
      }> };
      const existing = cloudList.snapshots?.find(
        (row) => row.name.trim().toLowerCase() === summary.name.trim().toLowerCase(),
      );
      const replaceSnapshotId = url.searchParams.get('replaceSnapshotId')?.trim();
      if (existing && replaceSnapshotId !== existing.id) {
        return json(res, 409, {
          error: `cloud snapshot named "${existing.name}" already exists`,
          code: 'duplicate_name',
          existing,
        });
      }
      if (!existing && replaceSnapshotId) {
        return json(res, 409, {
          error: 'the cloud snapshot selected for replacement no longer exists under that name',
          code: 'replace_target_missing',
        });
      }
      const key = await readVaultKey(true);
      const encrypted = encryptVaultBlob(writeClusterBundle(await readSnapshotFiles(id)), key!);
      const metadata = {
        name: summary.name,
        createdAt: summary.createdAt,
        memberCount: summary.memberCount,
        sourceDevice: hostname(),
        sourcePlatform: process.platform,
        bytes: encrypted.length,
        sha256: createHash('sha256').update(encrypted).digest('hex'),
      };
      const body = await hubJson('/api/cluster-vault', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Archon-Vault-Meta': Buffer.from(JSON.stringify(metadata)).toString('base64url'),
          ...(replaceSnapshotId ? { 'X-Archon-Vault-Replace-Id': replaceSnapshotId } : {}),
        },
        body: Uint8Array.from(encrypted).buffer,
      });
      return json(res, 201, body);
    }

    const cloudMatch = url.pathname.match(/^\/api\/cluster-snapshots\/cloud\/([^/]+)$/);
    if (cloudMatch && req.method === 'POST') {
      const key = await readVaultKey(false);
      if (!key) return json(res, 409, { error: 'no vault key configured on this machine' });
      const response = await fetch(hubUrl(`/api/cluster-vault/${encodeURIComponent(cloudMatch[1])}`));
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        return json(res, response.status, { error: body.error ?? 'cloud snapshot download failed' });
      }
      const encrypted = Buffer.from(await response.arrayBuffer());
      try {
        const summary = await importSnapshotFiles(readClusterBundle(decryptVaultBlob(encrypted, key)));
        return json(res, 201, { snapshot: summary });
      } catch (err) {
        return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (cloudMatch && req.method === 'DELETE') {
      const body = await hubJson(`/api/cluster-vault/${encodeURIComponent(cloudMatch[1])}`, { method: 'DELETE' });
      return json(res, 200, body);
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof SnapshotValidationError ? 400 : 500;
    return json(res, status, { error: message });
  }
}
