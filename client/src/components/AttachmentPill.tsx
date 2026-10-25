import { useState } from 'react';
import { FileViewerModal } from './FileViewerModal';

interface Props {
  path: string;
}

// Clickable operator-attachment chip. Opens the uploaded file in
// FileViewerModal (markdown/code/image/binary renderers already covered
// by the modal's file classifier) so the operator can verify what they
// attached without leaving the chat.
export function AttachmentPill({ path }: Props) {
  const [open, setOpen] = useState(false);
  const name = path.split('/').pop() || path;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Open ${path}`}
        className="display-font"
        style={{
          padding: '1px 6px',
          border: '1px solid var(--color-accent-secondary-dim)',
          color: 'var(--color-accent-secondary-dim)',
          background: 'transparent',
          cursor: 'pointer',
          fontSize: '11px',
          letterSpacing: '0.5px',
          fontFamily: 'var(--font-display)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-accent-secondary)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-accent-secondary-dim)'; }}
      >
        📎 {name}
      </button>
      {open && <FileViewerModal path={path} onClose={() => setOpen(false)} />}
    </>
  );
}
