import { useEffect, useRef, useState } from 'react';
import { useCookbookStore } from '../../stores/cookbookStore';
import { CatalogFilters, type FilterState } from './CatalogFilters';
import { CatalogTable } from './CatalogTable';
import { RecommendDialog } from './RecommendDialog';
import { ModalHelpButton } from '../help/ModalHelpButton';
import { fmtBytes } from './fmt';
import type { HardwareSimPreset } from '@arco/shared';

// Workbench Expansion G2 — Cookbook catalog modal. The fit-scored "what can I
// run?" table: a header strip showing the detected rig + RESCAN, a filter bar
// (search / task / quant / hardware-sim preset), and the SCORE-sorted table.
//
// READ-ONLY (G2): everything here is a GET against /api/cookbook (or the
// explicit RESCAN POST). The expand-row Download / Run / Configure buttons are
// inert placeholders (wired in G4). Nothing pulls / downloads / writes here.
//
// Trigger: useCookbookStore().setOpen(true) (the header COOKBOOK button). On
// open it fetches the detected hardware + runs an empty search (the
// trending-that-fits feed). Filter changes re-query (text debounced 350ms).

const DEBOUNCE_MS = 350;

export function CookbookModal() {
  const open = useCookbookStore((s) => s.open);
  const setOpen = useCookbookStore((s) => s.setOpen);
  const hardware = useCookbookStore((s) => s.hardware);
  const rescanning = useCookbookStore((s) => s.rescanning);
  const rows = useCookbookStore((s) => s.rows);
  const trending = useCookbookStore((s) => s.trending);
  const sources = useCookbookStore((s) => s.sources);
  const note = useCookbookStore((s) => s.note);
  const loading = useCookbookStore((s) => s.loading);
  const error = useCookbookStore((s) => s.error);
  const search = useCookbookStore((s) => s.search);
  const rescan = useCookbookStore((s) => s.rescanHardware);
  const fetchHardware = useCookbookStore((s) => s.fetchHardware);

  const [filters, setFilters] = useState<FilterState>({ text: '', task: '', quant: '', sim: '' });
  const [showRecommend, setShowRecommend] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // On first open: fetch the detected profile + run the default (empty) search.
  useEffect(() => {
    if (!open) return;
    fetchHardware();
    search({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-query when filters change (text debounced; selects fire immediately).
  useEffect(() => {
    if (!open) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      search({
        text: filters.text || undefined,
        task: filters.task || undefined,
        quant: filters.quant || undefined,
        sim: (filters.sim || undefined) as HardwareSimPreset | undefined,
      });
    }, DEBOUNCE_MS);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, open]);

  if (!open) return null;

  // Show the trending feed when the operator hasn't typed a query yet.
  const showTrending = !filters.text.trim() && trending.length > 0;
  const tableRows = showTrending ? trending : rows;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9500, backdropFilter: 'blur(3px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        style={{
          background: 'rgba(5, 12, 8, 0.98)',
          border: '1px solid var(--color-accent-secondary)',
          borderRadius: '6px',
          width: 'min(1080px, calc(94vw / var(--ui-scale, 1)))',
          maxHeight: 'calc(90vh / var(--ui-scale, 1))',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 0 36px var(--color-accent-secondary-a30)',
        }}
      >
        {/* Title bar */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="display-font" style={{ fontSize: '10px', padding: '2px 6px', border: '1px solid var(--color-accent-secondary)', color: 'var(--color-accent-secondary)', letterSpacing: '2px', borderRadius: '2px' }}>
            COOKBOOK
          </span>
          <span className="display-font glow-text" style={{ flex: 1, fontSize: '13px', letterSpacing: '2px', color: 'var(--color-accent-primary)' }}>
            MODEL CATALOG
          </span>
          <button
            data-help="cookbook.recommend"
            onClick={() => setShowRecommend(true)}
            className="display-font"
            title="Have an agent recommend the best model for a task from the fit-scored candidates"
            style={{ background: 'var(--color-accent-primary-a10)', border: '1px solid var(--color-accent-primary)', borderRadius: '3px', color: 'var(--color-accent-primary)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px', padding: '3px 10px' }}
          >
            ✦ RECOMMEND
          </button>
          {/* §J3 — in-modal scoped Help → movable HelpCard with the cookbook snippets */}
          <ModalHelpButton section="cookbook-catalog" title="Cookbook" />
          <button
            data-help="cookbook.close"
            onClick={() => setOpen(false)}
            className="display-font"
            style={{ background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px', padding: '3px 8px' }}
          >
            CLOSE
          </button>
        </div>

        {/* Hardware strip */}
        <div data-help="cookbook.hardware" style={{ padding: '8px 14px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: '12px', fontSize: '10px', letterSpacing: '1px' }} className="display-font">
          <span style={{ color: 'var(--color-fg-muted)' }}>RIG</span>
          <span style={{ color: 'var(--color-fg-default)' }}>
            {hardware
              ? hardware.gpus.length
                ? `${hardware.gpus.map((g) => g.name).join(', ')} · ${fmtBytes(hardware.totalVramBytes)} VRAM`
                : `${hardware.backend.toUpperCase()} · ${fmtBytes(hardware.systemRamBytes)} RAM${hardware.note ? ` (${hardware.note})` : ''}`
              : 'detecting…'}
          </span>
          {filters.sim && (
            <span style={{ color: 'var(--color-warning)' }}>[SIM: {filters.sim.toUpperCase()}]</span>
          )}
          <button
            data-help="cookbook.rescan"
            onClick={() => rescan()}
            disabled={rescanning}
            className="display-font"
            title="Re-probe the serving box's GPU / VRAM / RAM"
            style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-primary-dim)', cursor: rescanning ? 'wait' : 'pointer', fontSize: '9px', letterSpacing: '1px', padding: '3px 8px' }}
          >
            {rescanning ? 'RESCANNING…' : '↻ RESCAN'}
          </button>
        </div>

        {/* Filters */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-hairline)' }}>
          <CatalogFilters value={filters} onChange={setFilters} />
        </div>

        {/* Source / note strip */}
        {(note || !sources.hf || !sources.ollama) && (
          <div className="display-font" style={{ padding: '6px 14px', fontSize: '9px', letterSpacing: '1px', color: 'var(--color-warning)', borderBottom: '1px solid var(--color-border-hairline)' }}>
            {note || `Sources — HF: ${sources.hf ? 'ok' : 'down'}, Ollama: ${sources.ollama ? 'ok' : 'down'}`}
          </div>
        )}

        {/* Table */}
        <div style={{ padding: '8px 14px', overflowY: 'auto', flex: 1 }}>
          {showTrending && (
            <div className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', marginBottom: '6px' }}>
              TRENDING MODELS THAT FIT YOUR HARDWARE
            </div>
          )}
          {loading && (
            <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '11px', letterSpacing: '1px' }}>LOADING…</div>
          )}
          {error && (
            <div className="display-font" style={{ color: 'var(--color-warning)', fontSize: '11px', letterSpacing: '1px' }}>FAILED: {error}</div>
          )}
          {!loading && !error && <CatalogTable rows={tableRows} />}
        </div>
      </div>

      {showRecommend && (
        <RecommendDialog
          query={filters.text || undefined}
          sim={(filters.sim || undefined) as HardwareSimPreset | undefined}
          onClose={() => setShowRecommend(false)}
        />
      )}
    </div>
  );
}
