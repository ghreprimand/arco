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
} else for (const input of controls) input.addEventListener('change', async () => {
  const files = [...input.files];
  input.value = '';
  if (uploading || !files.length) return;
  uploading = true;
  disable(true);
  errors.length = 0;
  for (const file of files) {
    status.textContent = 'Uploading ' + file.name + '…';
    progress.hidden = false;
    progress.value = 0;
    const result = file.size > 20 * 1024 * 1024
      ? { error: 'This file is over 20 MiB.' } : await upload(file);
    if (result.expired) {
      status.textContent = result.error;
      progress.hidden = true;
      return;
    }
    if (result.ok) finished++;
    else errors.push(file.name + ': ' + result.error);
  }
  progress.hidden = true;
  status.textContent = [finished + ' uploaded. Review and send from Arco.', ...errors].join(' ');
  uploading = false;
  disable(false);
});
`;

export const PHONE_PAGE_CSP = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
export const PHONE_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload to Arco</title>
<style>
  body { font: 1rem system-ui,sans-serif; margin: 2rem auto; padding: 0 1rem; max-width: 30rem; color-scheme: light dark; }
  label { display: block; margin: 1rem 0; font-weight: 600; }
  input { display: block; width: 100%; margin-top: .5rem; min-height: 2.75rem; }
  progress { width: 100%; }
  #status { overflow-wrap: anywhere; }
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
