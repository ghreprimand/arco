import { IncomingMessage, ServerResponse } from 'http';
import { PORT } from '../server/constants.js';
import { probeHardware, rescanHardware, simulatedProfile } from '../cookbook/hardware.js';
import { searchCatalog } from '../cookbook/catalog.js';
import {
  HARDWARE_SIM_PRESETS,
  type CatalogQuery,
  type CatalogResponse,
  type HardwareProfile,
  type HardwareSimPreset,
} from '@archon/shared';

// Workbench Expansion G2 — Cookbook catalog + hardware endpoints.
//
//   GET  /api/cookbook/catalog?q=&quant=&task=&sim=   → CatalogResponse
//   GET  /api/cookbook/hardware                        → HardwareProfile
//   POST /api/cookbook/hardware/rescan                 → HardwareProfile
//
// READ-ONLY SEARCH (G2). The catalog endpoint fetches the public, keyless HF Hub
// + Ollama-library sources (HTTP only — no shelling out, no path use), scores
// every variant against the detected hardware (or a simulated rig when ?sim= is
// set) via G1's pure scoreFit, and answers HTTP 200 with a structured body. A
// down/slow source degrades to sources.<src>=false + a note — NEVER a 500. No
// download / pull / disk write / registration lives here (that is G4).
//
// /hardware exposes the cached G1 probe for the table header; /hardware/rescan
// clears the cache + re-probes (the RESCAN button). The probe is the only exec
// path and it's reused unchanged from G1 — this file never spawns anything.
//
// Wired AFTER the existing routes in router.ts (distinct /api/cookbook/ prefix,
// so no collision).

// Query-param whitelist. `quant` accepts a quant family token (letters, digits,
// underscores — the GGUF tag shape); anything else is dropped. `task` is a HF
// pipeline_tag (lowercase + hyphens). Both bounded in length. NO path use, NO
// interpolation into a command — these only flow into URLSearchParams / string
// compares downstream.
const QUANT_RE = /^[A-Za-z0-9_]{1,16}$/;
const TASK_RE = /^[a-z0-9-]{1,40}$/;

function parseSim(raw: string | null): HardwareSimPreset | undefined {
  if (!raw) return undefined;
  return (HARDWARE_SIM_PRESETS as readonly string[]).includes(raw)
    ? (raw as HardwareSimPreset)
    : undefined;
}

function parseQuery(url: URL): CatalogQuery {
  const text = (url.searchParams.get('q') || '').slice(0, 120).trim() || undefined;
  const quantRaw = (url.searchParams.get('quant') || '').trim();
  const taskRaw = (url.searchParams.get('task') || '').trim().toLowerCase();
  return {
    text,
    quant: QUANT_RE.test(quantRaw) ? quantRaw : undefined,
    task: TASK_RE.test(taskRaw) ? taskRaw : undefined,
    sim: parseSim(url.searchParams.get('sim')),
  };
}

export async function tryHandleCookbookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url || '';
  const send = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };

  // POST /api/cookbook/hardware/rescan — clear the cache + re-probe.
  if (url.startsWith('/api/cookbook/hardware/rescan') && req.method === 'POST') {
    try {
      const hw = await rescanHardware();
      return send(200, hw);
    } catch (err) {
      console.error('[archon] cookbook hardware rescan failed:', err);
      // Probe never throws by contract, but stay defensive.
      const hw = await probeHardware();
      return send(200, hw);
    }
  }

  // GET /api/cookbook/hardware — the detected/cached profile for the header.
  if (url.startsWith('/api/cookbook/hardware') && req.method === 'GET') {
    try {
      const hw = await probeHardware();
      return send(200, hw);
    } catch (err) {
      console.error('[archon] cookbook hardware probe failed:', err);
      return send(200, { gpus: [], totalVramBytes: 0, systemRamBytes: 0, cores: 0, backend: 'cpu', note: 'probe error' } satisfies HardwareProfile);
    }
  }

  // GET /api/cookbook/catalog — the fit-scored search table.
  if (url.startsWith('/api/cookbook/catalog') && req.method === 'GET') {
    try {
      const parsed = new URL(url, `http://localhost:${PORT}`);
      const query = parseQuery(parsed);
      const hw: HardwareProfile = query.sim ? simulatedProfile(query.sim) : await probeHardware();
      const body = await searchCatalog(query, hw);
      return send(200, body);
    } catch (err) {
      // searchCatalog is designed never to throw; this is the last-resort net.
      console.error('[archon] cookbook catalog search failed:', err);
      const hw = await probeHardware().catch(() => ({
        gpus: [], totalVramBytes: 0, systemRamBytes: 0, cores: 0, backend: 'cpu' as const,
      }));
      const body: CatalogResponse = {
        rows: [],
        hardware: hw,
        sources: { hf: false, ollama: false },
        note: 'Catalog search failed unexpectedly; no results.',
      };
      return send(200, body);
    }
  }

  return false;
}
