import { useAppStore } from '../../stores/appStore';

// WORKBENCH_EXPANSION §J3 — reusable in-modal Help affordance for the "full
// tool" modals (Media studio, Cookbook, …). Click → opens the movable, filterable
// HelpCard floating ABOVE the modal, scoped to the tool's snippets. Previously
// this jumped to the User Manual, which opened the whole manual *behind* the
// modal (greyed out / unreadable). The card carries an "open full manual" escape
// hatch for the long-form guide.
//
// Deliberately NOT the global floating HelpButton (that toggles help-MODE for
// the whole app); this is a per-tool button styled to match the modal header
// buttons (CLOSE / RESCAN / …). Each tool passes its own manual section id
// (which doubles as the manualSection filter) + a human title for the card head.
interface Props {
  section: string;
  title?: string;
  label?: string;
}

export function ModalHelpButton({ section, title, label = 'HELP' }: Props) {
  const setActiveHelpCard = useAppStore((s) => s.setActiveHelpCard);
  // Derive a heading from the section id when no explicit title is given
  // ("media-studio" → "Media Studio").
  const heading = title ?? section.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return (
    <button
      onClick={() => setActiveHelpCard({ section, title: heading })}
      className="display-font"
      title="Open this tool's help"
      style={{
        background: 'transparent',
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '3px',
        color: 'var(--color-accent-primary-dim)',
        cursor: 'pointer',
        fontSize: '10px',
        letterSpacing: '1px',
        padding: '3px 8px',
      }}
    >
      ? {label}
    </button>
  );
}
