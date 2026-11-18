import { createHash } from 'node:crypto';

const script = String.raw`
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const status = document.querySelector('#status');
const controls = [...document.querySelectorAll('input')];
const progress = document.querySelector('progress');
const errors = [];
let uploading = false;
let finished = 0;

// The look of Arco on the computer when the code was opened: checked theme
// values and, when the theme uses one, a font bundled with Arco. Read with
// the token from the same path; a failure leaves the plain page.
function read(headers, type) {
  return new Promise(resolve => {
    const req = new XMLHttpRequest();
    req.open('GET', '/phone-upload');
    req.responseType = type;
    req.timeout = 15000;
    for (const [name, value] of Object.entries(headers)) req.setRequestHeader(name, value);
    req.onload = () => resolve(req.status === 200 ? req.response : null);
    req.onerror = req.ontimeout = () => resolve(null);
    req.send();
  });
}

async function applyTheme() {
  const reply = await read({ 'X-Arco-Phone-Upload': token }, 'json');
  const theme = reply && reply.theme;
  if (!theme) return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.vars || {})) {
    if (/^[a-z-]+$/.test(name) && typeof value === 'string') root.style.setProperty('--' + name, value);
  }
  if (theme.scheme === 'light' || theme.scheme === 'dark') root.style.colorScheme = theme.scheme;
  if (!document.fonts || typeof FontFace !== 'function') return;
  for (const font of theme.fonts || []) {
    const bytes = await read({ 'X-Arco-Phone-Upload': token, 'X-Arco-Phone-Font': font.id }, 'arraybuffer');
    if (!bytes) continue;
    try { document.fonts.add(await new FontFace(font.family, bytes, { weight: font.weight }).load()); } catch {}
  }
}

function disable(value) {
  for (const input of controls) input.disabled = value;
}

function upload(file) {
  return new Promise(resolve => {
    const req = new XMLHttpRequest();
    req.open('POST', '/phone-upload');
    req.timeout = 5 * 60 * 1000;
    req.setRequestHeader('X-Arco-Phone-Upload', token);
    req.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    req.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    req.upload.onprogress = event => {
      if (event.lengthComputable) progress.value = event.loaded / event.total;
    };
    req.onload = () => {
      if (req.status === 201) return resolve({ ok: true });
      try { resolve({ error: JSON.parse(req.responseText).error, expired: req.status === 410 }); }
      catch { resolve({ error: 'Upload failed.' }); }
    };
    req.onerror = req.ontimeout = () => resolve({ error: 'Connection lost. Try again on the same private network.' });
    req.send(file);
  });
}

if (!/^[\w-]{43}$/.test(token)) {
  disable(true);
  status.textContent = 'Scan a new code from Arco to upload.';
} else {
  void applyTheme();
  for (const input of controls) input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (uploading || !files.length) return;
    uploading = true;
    disable(true);
    errors.length = 0;
    for (const file of files) {
      status.textContent = 'Uploading ' + file.name + '…';
      delete status.dataset.state;
      progress.hidden = false;
      progress.value = 0;
      const result = file.size > 20 * 1024 * 1024
        ? { error: 'This file is over 20 MiB.' } : await upload(file);
      if (result.expired) {
        status.textContent = result.error;
        status.dataset.state = 'error';
        progress.hidden = true;
        return;
      }
      if (result.ok) finished++;
      else errors.push(file.name + ': ' + result.error);
    }
    progress.hidden = true;
    status.textContent = [finished + ' uploaded. Review and send from Arco.', ...errors].join(' ');
    status.dataset.state = errors.length ? 'error' : 'done';
    uploading = false;
    disable(false);
  });
}
`;

export const PHONE_PAGE_CSP = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
export const PHONE_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload to Arco</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 2rem 1rem; font: 1rem/1.45 var(--font-body, system-ui, sans-serif); color: var(--color-fg, CanvasText); background: var(--color-bg, Canvas); }
  main { max-width: 30rem; margin: 0 auto; }
  h1 { margin: 0 0 1rem; font: 700 1.25rem/1.2 var(--font-display, var(--font-body, system-ui, sans-serif)); letter-spacing: .05em; color: var(--color-accent-primary, inherit); }
  label { display: block; margin: 1rem 0; padding: .75rem; font-family: var(--font-display, inherit); font-weight: 600; background: var(--color-bg-dialog, transparent); border: var(--border-width, 1px) solid var(--color-border, GrayText); border-radius: var(--radius-sm, .3rem); }
  input { display: block; box-sizing: border-box; width: 100%; margin-top: .5rem; min-height: 2.75rem; font: 400 .9rem var(--font-body, inherit); color: var(--color-control-fg, inherit); }
  input::file-selector-button { min-height: 2.75rem; margin-right: .75rem; padding: .35rem .75rem; font: 600 .9rem var(--font-display, inherit); color: var(--color-accent-primary, ButtonText); background: var(--color-bg, ButtonFace); border: var(--border-width, 1px) solid var(--color-accent-primary, ButtonBorder); border-radius: var(--radius-sm, .3rem); }
  input:focus-visible { outline: 2px solid var(--color-accent-primary, Highlight); outline-offset: 2px; }
  input:disabled { opacity: .6; }
  progress { width: 100%; accent-color: var(--color-accent-primary, auto); }
  #status { overflow-wrap: anywhere; color: var(--color-fg-muted, inherit); }
  #status[data-state="done"] { color: var(--color-success, inherit); }
  #status[data-state="error"] { color: var(--color-error, inherit); }
</style>
<main>
  <h1>Upload to Arco</h1>
  <label>Take Photo <input type="file" accept="image/*" capture="environment"></label>
  <label>Choose Files <input type="file" multiple accept="image/*,.pdf,.txt,.md,.csv,.rtf,.docx,.xlsx,.pptx,.odt,.ods,.odp"></label>
  <p role="status" id="status">Up to 20 MiB per file.</p>
  <progress hidden value="0" max="1" aria-label="Upload progress"></progress>
</main>
<script>${script}</script>
</html>`;
