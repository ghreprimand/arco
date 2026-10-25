import { useEffect, useState } from 'react';

// App-wide drag-and-drop overlay. Listens at the window level so users can
// drop files anywhere in Arco, not just on the terminal input. On drop,
// dispatches `arco:attach-files` on window with the File[] payload —
// TerminalInput listens for this event and uploads + appends to the active
// workflow's attachment list.
export function DragOverlay() {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let counter = 0;

    const hasFiles = (e: DragEvent) => {
      if (!e.dataTransfer) return false;
      const types = Array.from(e.dataTransfer.types);
      return types.includes('Files');
    };

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      counter += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      counter = Math.max(0, counter - 1);
      if (counter === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      counter = 0;
      setDragging(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      window.dispatchEvent(new CustomEvent('arco:attach-files', { detail: { files } }));
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!dragging) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 8, 4, 0.78)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        pointerEvents: 'none',
        border: '3px dashed var(--color-accent-secondary)',
        boxShadow: 'inset 0 0 80px var(--color-accent-secondary-glow)',
      }}
    >
      <div className="display-font glow-text-bright" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '36px', letterSpacing: '8px', color: 'var(--color-accent-secondary)' }}>
          ◆ DROP TO ATTACH ◆
        </div>
        <div style={{ marginTop: '14px', fontSize: '12px', letterSpacing: '3px', color: 'var(--color-accent-secondary-dim)' }}>
          FILES WILL ATTACH TO THE ACTIVE WORKFLOW
        </div>
      </div>
    </div>
  );
}
