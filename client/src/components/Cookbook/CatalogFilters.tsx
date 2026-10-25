import type { HardwareSimPreset } from '@archon/shared';

// Workbench Expansion G2 — the Cookbook filter bar: free-text search, task/type
// select, quant preference, and the hardware-simulation preset selector. Pure
// controlled inputs — the modal owns the state and re-queries on change.

export interface FilterState {
  text: string;
  task: string;
  quant: string;
  sim: HardwareSimPreset | '';
}

interface Props {
  value: FilterState;
  onChange: (next: FilterState) => void;
}

// Coarse HF pipeline_tag task facets relevant to local coders. Empty = all.
const TASKS: { value: string; label: string }[] = [
  { value: '', label: 'ALL TYPES' },
  { value: 'text-generation', label: 'TEXT GEN' },
  { value: 'text2text-generation', label: 'TEXT2TEXT' },
  { value: 'image-text-to-text', label: 'VISION' },
];

const QUANTS = ['', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q8', 'F16'];

// Simulation presets — score against a hypothetical rig. Empty = detected box.
const SIMS: { value: HardwareSimPreset | ''; label: string }[] = [
  { value: '', label: 'DETECTED' },
  { value: 'ram', label: 'RAM ONLY' },
  { value: 'gpu1', label: '1× GPU' },
  { value: 'gpu2', label: '2× GPU' },
  { value: 'gpu4', label: '4× GPU' },
  { value: 'gpu8', label: '8× GPU' },
];

const SELECT: React.CSSProperties = {
  background: 'rgba(0,0,0,0.4)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg-default)',
  fontSize: '10px',
  letterSpacing: '1px',
  padding: '4px 6px',
};

export function CatalogFilters({ value, onChange }: Props) {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        data-help="cookbook.filter.search"
        value={value.text}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
        placeholder="search models (e.g. qwen coder)…"
        className="display-font"
        style={{
          flex: 1, minWidth: '180px',
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '3px',
          color: 'var(--color-fg-default)',
          fontSize: '11px',
          letterSpacing: '1px',
          padding: '5px 8px',
        }}
      />
      <select
        data-help="cookbook.filter.task"
        value={value.task}
        onChange={(e) => onChange({ ...value, task: e.target.value })}
        style={SELECT}
      >
        {TASKS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>
      <select
        data-help="cookbook.filter.quant"
        value={value.quant}
        onChange={(e) => onChange({ ...value, quant: e.target.value })}
        style={SELECT}
      >
        {QUANTS.map((q) => <option key={q} value={q}>{q ? q : 'ANY QUANT'}</option>)}
      </select>
      <select
        data-help="cookbook.filter.sim"
        value={value.sim}
        onChange={(e) => onChange({ ...value, sim: e.target.value as HardwareSimPreset | '' })}
        style={SELECT}
      >
        {SIMS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
    </div>
  );
}
