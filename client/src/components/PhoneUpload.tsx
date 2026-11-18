import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import qrcode from 'qrcode-generator';
import { useAppStore } from '../stores/appStore';
import { phoneUploadRequest } from '../utils/phoneUploadApi';
const OPEN_EVENT = 'arco:open-phone-upload';
const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|heic|heif|tiff?|bmp|ico)$/i;

interface Opening {
  workflowId: string;
  trigger: HTMLButtonElement;
}
interface Link {
  id: string;
  url: string;
  expiresAt: number;
}
interface PhoneFile {
  fileId: string;
  filename: string;
  path: string;
  expiresAt: number;
}

function qrUrl(value: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  return qr.createDataURL(4, 16);
}

export function PhoneUploadButton({ workflowId }: { workflowId: string }) {
  return <button
    type="button"
    className="display-font phone-upload-button"
    data-help="composer.upload-from-phone"
    aria-label="Upload from phone"
    title="Upload from phone"
    onClick={e => { window.dispatchEvent(new CustomEvent<Opening>(OPEN_EVENT, {
      detail: { workflowId, trigger: e.currentTarget },
    })); }}
    style={{
      flexShrink: 0, padding: '3px 8px', minHeight: '32px', whiteSpace: 'nowrap',
      background: 'transparent', border: '1px solid var(--color-border-hairline)',
      borderRadius: '3px', color: 'var(--color-accent-secondary-dim)', cursor: 'pointer', fontSize: '10px',
    }}
  >UPLOAD FROM PHONE</button>;
}

function PhoneCode({ opening, dismiss }: { opening: Opening; dismiss: () => void }) {
  const { workflowId } = opening;
  const workflowAvailable = useAppStore(s => !!s.jobs[workflowId]);
  const [link, setLink] = useState<Link | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [chosen, setChosen] = useState('');
  const [creating, setCreating] = useState(true);
  const [error, setError] = useState('');
  const [time, setTime] = useState(Date.now);
  const [closed, setClosed] = useState(false);
  const [count, setCount] = useState(0);
  const published = useRef(new Set<string>());
  const dismissButton = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    dismissButton.current?.focus();
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); dismissRef.current(); }
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
      if (opening.trigger.isConnected) opening.trigger.focus();
    };
  }, [opening]);

  useEffect(() => {
    if (!workflowAvailable) dismissRef.current();
  }, [workflowAvailable]);

  useEffect(() => {
    let cancelled = false;
    setCreating(true);
    void phoneUploadRequest('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, ...(chosen ? { origin: chosen } : {}) }),
    }).then(async response => {
      const result = await response.json();
      if (cancelled) {
        if (result.id) void phoneUploadRequest('/' + result.id, { method: 'DELETE' }).catch(() => {});
        return;
      }
      if (!response.ok) setError(result.error || 'Phone upload is unavailable.');
      else if (result.origins) setOrigins(result.origins);
      else setLink(result);
    }).catch(() => {
      if (!cancelled) setError('Phone upload is unavailable.');
    }).finally(() => {
      if (!cancelled) setCreating(false);
    });
    return () => { cancelled = true; };
  }, [workflowId, chosen]);

  useEffect(() => {
    if (!link) return;
    let inFlight = false;
    let stopped = false;

    const addFiles = (files: PhoneFile[]) => {
      for (const file of files) {
        if (published.current.has(file.fileId) || file.expiresAt <= Date.now()) continue;
        published.current.add(file.fileId);
        const isImage = IMAGE.test(file.filename);
        useAppStore.getState().addAttachment(workflowId, {
          filename: file.filename, path: file.path, isImage, phoneUpload: { id: file.fileId, expiresAt: file.expiresAt },
        });
        if (isImage) {
          void phoneUploadRequest('/draft/' + file.fileId).then(async r => {
            if (!r.ok) return;
            const { preview } = await r.json();
            if (!preview) return;
            useAppStore.setState(state => {
              const existing = state.attachments[workflowId];
              if (!existing?.some(attachment => attachment.path === file.path)) return state;
              return { attachments: { ...state.attachments, [workflowId]: existing.map(
                attachment => attachment.path === file.path ? { ...attachment, previewUrl: preview } : attachment,
              ) } };
            });
          }).catch(() => {});
        }
      }
      if (!stopped) setCount(published.current.size);
    };

    const poll = async () => {
      if (inFlight || closing.current) return;
      const now = Date.now();
      setTime(now);
      inFlight = true;
      try {
        const response = await phoneUploadRequest('/' + link.id);
        const data = await response.json();
        if (stopped) return;
        if (!response.ok) {
          setClosed(true);
          setError(data.error ?? 'Open a new code in Arco.');
          clearInterval(timer);
          return;
        }
        addFiles(data.files);
        if (data.closed) {
          setClosed(true);
          clearInterval(timer);
        }
      } catch {
        if (!stopped && now >= link.expiresAt) setClosed(true);
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => { void poll(); }, 1_000);
    void poll();
    return () => {
      stopped = true;
      closing.current = true;
      clearInterval(timer);
      // DELETE revokes the link before returning any attachments that arrived
      // since the last poll. The files still go to the opening conversation.
      void phoneUploadRequest('/' + link.id, { method: 'DELETE', keepalive: true }).then(async response => {
        if (response.ok) addFiles((await response.json()).files);
      }).catch(() => {});
    };
  }, [workflowId, link]);

  const seconds = link ? Math.max(0, Math.ceil((link.expiresAt - time) / 1000)) : 0;
  const image = useMemo(() => link ? qrUrl(link.url) : null, [link]);
  const qr = !closed && seconds > 0 && !error ? image : null;

  return createPortal(
    <section
      className="phone-upload-window"
      role="dialog"
      aria-labelledby="phone-upload-title"
      data-testid="phone-upload-window"
    >
      <h2 id="phone-upload-title">UPLOAD FROM PHONE</h2>
      <div role="status">
        {error || (creating ? 'Opening phone upload…'
          : closed || (link && seconds === 0) ? 'This code has expired. Open a new one to upload more files.'
          : qr ? 'Scan on your phone while it is on the same private network.'
          : 'Choose the private address your phone can reach.')}
      </div>
      {!creating && !link && !error && origins.map(origin =>
        <button type="button" key={origin} onClick={() => setChosen(origin)}>{origin}</button>,
      )}
      {qr && <>
        <img src={qr} alt="Scan to upload from your phone" />
        <div>Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</div>
      </>}
      {count > 0 && <div role="status">{count} added to the message box.</div>}
      <button type="button" ref={dismissButton} onClick={dismiss}>Close</button>
    </section>,
    document.body,
  );
}

export function PhoneUploadWindow() {
  const [opening, setOpening] = useState<(Opening & { key: number }) | null>(null);
  const nextKey = useRef(0);

  useEffect(() => {
    const open = (event: Event) => {
      setOpening({ ...(event as CustomEvent<Opening>).detail, key: ++nextKey.current });
    };
    window.addEventListener(OPEN_EVENT, open);
    const expiry = window.setInterval(() => {
      const store = useAppStore.getState();
      const now = Date.now();
      for (const [workflowId, files] of Object.entries(store.attachments)) {
        for (let i = files.length - 1; i >= 0; i--) {
          const upload = files[i].phoneUpload;
          if (upload && upload.expiresAt <= now) store.removeAttachment(workflowId, i);
        }
      }
    }, 10_000);
    return () => {
      window.removeEventListener(OPEN_EVENT, open);
      clearInterval(expiry);
    };
  }, []);

  return opening ? <PhoneCode key={opening.key} opening={opening} dismiss={() => setOpening(null)} /> : null;
}
