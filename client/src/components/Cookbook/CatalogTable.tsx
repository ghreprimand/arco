import { Fragment, useState } from 'react';
import type { CatalogRow } from '@arco/shared';
import { fmtBytes, fmtCtx, fmtTps, fmtParams, verdictColor } from './fmt';
import { DownloadActions } from './DownloadActions';

// Workbench Expansion G2 — the fit-scored catalog table. Columns from the
// Cookbook screenshots: FIT · MODEL (+MoE) · PARAM · QUANT · VRAM · CTX · SPEED
// · SCORE · MODE. Rows arrive already sorted by SCORE desc from the server.
// Expanding a row reveals the HF/Ollama link, a backend badge, and the wired
// Download action (G4 — DownloadActions: pre-flight, progress, cancel, success).

interface Props {
  rows: CatalogRow[];
}

const TH: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  fontSize: '9px',
  letterSpacing: '1.5px',
  color: 'var(--color-fg-muted)',
  borderBottom: '1px solid var(--color-border-hairline)',
  position: 'sticky',
  top: 0,
  background: 'rgba(5, 12, 8, 0.98)',
};

const TD: React.CSSProperties = {
  padding: '5px 8px',
  fontSize: '11px',
  borderBottom: '1px solid var(--color-border-hairline)',
  whiteSpace: 'nowrap',
};

function rowKey(r: CatalogRow): string {
  return `${r.source}:${r.repo}:${r.quant}`;
}

function hfUrl(repo: string): string {
  return `https://huggingface.co/${repo}`;
}

function ExpandedRow({ r }: { r: CatalogRow }) {
  const link = r.source === 'hf'
    ? hfUrl(r.repo)
    : `https://ollama.com/library/${r.name.split(':')[0]}`;
  return (
    <tr>
      <td colSpan={9} style={{ padding: '8px 16px', background: 'var(--color-bg-subtle, rgba(255,255,255,0.02))', borderBottom: '1px solid var(--color-border-hairline)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <span
            data-help="cookbook.row.backend"
            className="display-font"
            style={{
              fontSize: '9px', letterSpacing: '1px', padding: '2px 6px', borderRadius: '2px',
              border: '1px solid var(--color-accent-secondary)', color: 'var(--color-accent-secondary)',
            }}
          >
            {r.source === 'hf' ? 'llama.cpp / GGUF' : 'Ollama'}
          </span>
          <a
            data-help="cookbook.row.link"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="display-font"
            style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-accent-primary)', textDecoration: 'none' }}
          >
            {r.source === 'hf' ? 'HUGGING FACE ↗' : 'OLLAMA LIBRARY ↗'}
          </a>
          <span className="display-font" style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>
            est VRAM {fmtBytes(r.fit.estVramBytes)} · max ctx {fmtCtx(r.fit.maxContextThatFits)} · {r.fit.mode}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
            <DownloadActions row={r} />
          </span>
        </div>
      </td>
    </tr>
  );
}

export function CatalogTable({ rows }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '11px', letterSpacing: '1px', padding: '20px 0' }}>
        NO MODELS MATCH. Try a different search or quant filter.
      </div>
    );
  }

  return (
    <table data-help="cookbook.table" style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={TH}>FIT</th>
          <th style={TH}>MODEL</th>
          <th style={TH}>PARAM</th>
          <th style={TH}>QUANT</th>
          <th style={TH}>VRAM</th>
          <th style={TH}>CTX</th>
          <th style={TH}>SPEED</th>
          <th style={TH}>SCORE</th>
          <th style={TH}>MODE</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const key = rowKey(r);
          const isOpen = expanded === key;
          return (
            <Fragment key={key}>
              <tr
                data-help="cookbook.row"
                onClick={() => setExpanded(isOpen ? null : key)}
                style={{ cursor: 'pointer', background: isOpen ? 'var(--color-accent-primary-a10)' : undefined }}
              >
                <td style={{ ...TD, color: verdictColor(r.fit.verdict), fontWeight: 600 }}>{r.fit.verdict}</td>
                <td style={{ ...TD, whiteSpace: 'normal', color: 'var(--color-fg-default)' }}>
                  {r.name}
                  {r.moe && (
                    <span className="display-font" style={{ marginLeft: '6px', fontSize: '8px', letterSpacing: '1px', padding: '1px 4px', border: '1px solid var(--color-warning)', color: 'var(--color-warning)', borderRadius: '2px' }}>
                      MoE
                    </span>
                  )}
                </td>
                <td style={TD}>{fmtParams(r.params)}</td>
                <td style={TD}>{r.quant}</td>
                <td style={TD}>{fmtBytes(r.fit.estVramBytes)}</td>
                <td style={TD}>{fmtCtx(r.fit.maxContextThatFits)}</td>
                <td style={TD}>{fmtTps(r.fit.throughputTps)}</td>
                <td style={{ ...TD, color: 'var(--color-accent-primary)', fontWeight: 600 }}>{r.fit.score}</td>
                <td style={TD}>{r.fit.mode}</td>
              </tr>
              {isOpen && <ExpandedRow r={r} />}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
