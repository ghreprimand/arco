import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { unzipSync } from 'fflate';
import * as clusterStore from '../clusterStore.js';
import { fileHeaderKind } from '../fileContent/detect.js';
import { awaitModelImage } from '../providers/attachments.js';
import { PORT, UUID_PATTERN } from '../server/constants.js';
import { workflows } from '../server/state.js';
import type { WorkflowState } from '../workflows/types.js';
import { managedUploadPath } from '../uploadImages.js';
import { readAttachmentBody, storeAttachment, UploadTooLarge } from './attachmentUpload.js';
import { readFileForExplorer } from './fileRead.js';
import { discardPhoneDraft, phoneDraftForOwner, phoneFilename, rememberPhoneDraft, PHONE_DRAFT_TTL_MS, type PhoneDraft } from './phoneUploadDrafts.js';
import { phoneListenerAddresses, phoneUploadOrigins, privatePhoneOrigin } from './phoneUploadNetwork.js';
import { startPhoneListener, type PhoneListener } from './phoneUploadListener.js';
import { checkRequestOrigin } from './originGuard.js';
import { PHONE_PAGE, PHONE_PAGE_CSP } from './phoneUploadPage.js';
import { readCookie, SESSION_COOKIE, verifyToken } from './wsAuth.js';

const PHONE_PATH = '/phone-upload';
const API_PATH = '/api/phone-upload';
const UNAVAILABLE = 'Phone upload is unavailable. Open Arco on your private network first.';
const NO_PRIVATE_ADDRESS = 'Phone upload is unavailable. This computer has no private network or tailnet address a phone can reach. Connect it to Wi-Fi, a wired network or Tailscale, then try again.';
const NOT_LISTENING = 'Phone upload is unavailable. Arco could not accept connections on this computer\'s private network address. Try again; if it keeps failing, the Arco log has a line with the error code.';
const CLOSED = 'This link is closed or expired. Open a new code in Arco.';
const MIB = 1024 * 1024;
const FILE_LIMIT = 20 * MIB;
const LINK_LIMIT = 100 * MIB;
const COUNT_LIMIT = 10;
const LINK_TTL_MS = 5 * 60_000;
const MAX_OPEN_LINKS = 8;
const MAX_TRANSFERS = 2;
// The temporary phone listener stays open this long after the last request
// for a code, so a choice between several addresses finds it still there.
const LISTENER_GRACE_MS = 60_000;

interface UploadLink {
  id: string;
  key: string;
  owner: string;
  workflowId: string;
  workflow: WorkflowState;
  cwd: string;
  origin: string;
  expiresAt: number;
  files: PhoneDraft[];
  receivedBytes: number;
  closed: boolean;
  transferring: boolean;
}

const links = new Map<string, UploadLink>();
const tokens = new Map<string, UploadLink>();
let transfers = 0;
let phoneListener: Promise<PhoneListener> | null = null;
let openingCodes = 0;
let listenerGraceUntil = 0;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: message });
}

function targetAvailable(id: string, wf: WorkflowState | undefined): wf is WorkflowState {
  if (!wf?.config.workingDirectory || wf.config.incognito) return false;
  const cluster = clusterStore.getClusterIdForWorkflow(id);
  return !cluster || clusterStore.getMemberAccessMode(cluster, id) !== 'isolated';
}

function closeLink(link: UploadLink): void {
  link.closed = true;
  tokens.delete(link.key);
}

function active(link: UploadLink): boolean {
  const wf = workflows.get(link.workflowId);
  if (link.closed || link.expiresAt <= Date.now() || wf !== link.workflow
    || !targetAvailable(link.workflowId, wf) || wf.config.workingDirectory !== link.cwd) {
    closeLink(link);
    return false;
  }
  return true;
}

function purgeLinks(): void {
  const now = Date.now();
  for (const [id, link] of links) {
    active(link);
    if (!link.transferring && link.expiresAt + 60_000 <= now) links.delete(id);
  }
}

// The temporary listener closes only when no code is being opened, no upload
// is in progress, no link is still open and the grace time has passed.
function releasePhoneListener(): void {
  if (!phoneListener || openingCodes > 0 || transfers > 0 || Date.now() < listenerGraceUntil) return;
  if ([...tokens.values()].some(link => active(link))) return;
  const closing = phoneListener;
  phoneListener = null;
  void closing.then(listener => listener.close());
}

setInterval(() => { purgeLinks(); releasePhoneListener(); }, 30_000).unref();

export async function _closePhoneListenerForTest(): Promise<void> {
  const closing = phoneListener;
  phoneListener = null;
  (await closing)?.close();
}

// The temporary listener's only route: the same Host and Origin precheck as
// the main router, then the phone page and its upload endpoint.
async function phoneOnly(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkRequestOrigin(req).ok) return error(res, 403, 'Forbidden origin');
  await tryHandlePhonePage(req, res);
}

// When the main server serves no private address (the default loopback
// bind), open the temporary phone listener on this machine's private network
// and tailnet addresses, or reuse the one already open.
async function temporaryOrigins(port: number): Promise<{ origins: string[]; error?: string }> {
  listenerGraceUntil = Date.now() + LISTENER_GRACE_MS;
  if (!phoneListener) {
    const addresses = phoneListenerAddresses();
    if (!addresses.length) return { origins: [], error: NO_PRIVATE_ADDRESS };
    phoneListener = startPhoneListener(addresses, port, phoneOnly);
  }
  const current = phoneListener;
  const { origins } = await current;
  if (origins.length) return { origins };
  if (phoneListener === current) phoneListener = null;
  return { origins, error: NOT_LISTENING };
}

const imageExtensions: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/heic': '.heic', 'image/tiff': '.tiff', 'image/bmp': '.bmp', 'image/x-icon': '.ico',
};

function officeDocument(ext: string, bytes: Buffer): boolean {
  const required: Record<string, string> = {
    '.docx': 'word/document.xml', '.xlsx': 'xl/workbook.xml', '.pptx': 'ppt/presentation.xml',
    '.odt': 'content.xml', '.ods': 'content.xml', '.odp': 'content.xml',
  };
  if (!required[ext]) return false;
  let containsDocument = false;
  let containsActivePart = false;
  try {
    const parts = unzipSync(bytes, { filter: (file) => {
      if (file.name === required[ext]) containsDocument = true;
      if (/vbaProject|^Scripts\/|^Basic\//i.test(file.name)) containsActivePart = true;
      return file.name === 'mimetype' && file.originalSize <= 128 && /^\.od/.test(ext);
    } });
    if (!containsDocument || containsActivePart) return false;
    if (!/^\.od/.test(ext)) return true;
    const kind: Record<string, string> = { '.odt': 'text', '.ods': 'spreadsheet', '.odp': 'presentation' };
    return !!parts.mimetype && Buffer.from(parts.mimetype).toString() === 'application/vnd.oasis.opendocument.' + kind[ext];
  } catch {
    return false;
  }
}

function checkedFilename(req: IncomingMessage, bytes: Buffer): string | null {
  const supplied = req.headers['x-filename'];
  if (typeof supplied !== 'string' || supplied.length > 1024) return null;
  let filename: string;
  try { filename = phoneFilename(decodeURIComponent(supplied)); }
  catch { return null; }
  if (!filename) return null;
  const ext = extname(filename).toLowerCase();
  const content = fileHeaderKind(bytes);
  const detectedExtension = imageExtensions[content];
  if (detectedExtension) {
    const alternates = detectedExtension === '.jpg' ? ['.jpeg'] : detectedExtension === '.heic' ? ['.heif']
      : detectedExtension === '.tiff' ? ['.tif'] : [];
    if (!ext) filename += detectedExtension;
    else if (ext !== detectedExtension && !alternates.includes(ext)) return null;
    return phoneFilename(filename) || null;
  }
  if ((ext === '.pdf' && content === 'application/pdf') || (ext === '.rtf' && content === 'application/rtf')
    || (['.txt', '.md', '.csv'].includes(ext) && content === 'text/plain')
    || (content === 'application/zip' && officeDocument(ext, bytes))) {
    return filename;
  }
  return null;
}

async function uploadFromPhone(req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
  const token = req.headers['x-arco-phone-upload'];
  if (req.headers.origin !== origin || typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) {
    return error(res, 403, 'Open the upload page from the QR code.');
  }
  const link = tokens.get(digest(token));
  if (!link || !active(link)) return error(res, 410, CLOSED);
  if (link.origin !== origin) return error(res, 403, UNAVAILABLE);
  if (link.transferring || transfers >= MAX_TRANSFERS) return error(res, 429, 'Another upload is in progress. Try again shortly.');
  if (link.files.length >= COUNT_LIMIT || link.receivedBytes >= LINK_LIMIT) {
    return error(res, 413, 'This link has reached its file limit. Open a new code for more files.');
  }
  const limit = Math.min(FILE_LIMIT, LINK_LIMIT - link.receivedBytes);
  const remaining = link.expiresAt - Date.now();
  const timer = setTimeout(() => req.destroy(), remaining);
  timer.unref();
  link.transferring = true;
  transfers++;
  let draft: PhoneDraft | undefined;
  try {
    if (Number(req.headers['content-length']) > limit) throw new UploadTooLarge();
    const body = await readAttachmentBody(req, limit);
    if (!active(link)) return error(res, 410, CLOSED);
    if (!body.length) return error(res, 400, 'The file is empty.');
    link.receivedBytes += body.length;
    const checked = checkedFilename(req, body);
    if (!checked) return error(res, 415, 'Choose a supported photo, PDF, text or office document.');
    const fileId = randomUUID();
    await storeAttachment(body, checked, '', {
      fileId,
      beforeWrite: async (file) => {
        draft = { ...file, workflowId: link.workflowId, owner: link.owner, expiresAt: Date.now() + PHONE_DRAFT_TTL_MS };
        await rememberPhoneDraft(draft);
      },
    });
    if (!draft) throw new Error('Missing draft receipt');
    if (!active(link)) {
      await discardPhoneDraft(draft);
      return error(res, 410, CLOSED);
    }
    link.files.push(draft);
    json(res, 201, { ok: true });
  } catch (e) {
    if (draft) await discardPhoneDraft(draft).catch(() => {});
    if (res.destroyed) return;
    if (e instanceof UploadTooLarge) {
      res.setHeader('Connection', 'close');
      error(res, 413, 'This file is too large for the remaining upload allowance.');
    } else {
      error(res, 500, 'Upload failed. Try again from the phone.');
    }
  } finally {
    clearTimeout(timer);
    link.transferring = false;
    transfers--;
  }
}

// Opens one upload link on a chosen address, or lists the addresses to
// choose from when there are several. Synchronous, so a temporary listener
// cannot close between its origins being read and the link being recorded.
function createLink(res: ServerResponse, body: { workflowId: string; origin?: string }, workflow: WorkflowState,
  owner: string, origins: string[]): true {
  const origin = body.origin ?? (origins.length === 1 ? origins[0] : undefined);
  if (!origin) {
    json(res, 200, { origins });
    return true;
  }
  if (!origins.includes(origin)) {
    error(res, 403, UNAVAILABLE);
    return true;
  }
  if (tokens.size >= MAX_OPEN_LINKS || links.size >= 4 * MAX_OPEN_LINKS) {
    error(res, 429, 'Too many phone upload links. Wait for one to expire.');
    return true;
  }
  const token = randomBytes(32).toString('base64url');
  const link: UploadLink = {
    id: randomUUID(), key: digest(token), owner, workflowId: body.workflowId, workflow,
    cwd: workflow.config.workingDirectory!, origin, expiresAt: Date.now() + LINK_TTL_MS,
    files: [], receivedBytes: 0, closed: false, transferring: false,
  };
  links.set(link.id, link);
  tokens.set(link.key, link);
  json(res, 201, { id: link.id, url: origin + PHONE_PATH + '#' + token, expiresAt: link.expiresAt });
  return true;
}

// This exact path has upload authority only. It is deliberately handled
// before operator session auth, with the same router Host/Origin precheck.
export async function tryHandlePhonePage(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.url !== PHONE_PATH) return false;
  const origin = privatePhoneOrigin(req);
  if (!origin) error(res, 403, UNAVAILABLE);
  else if (req.method === 'POST') await uploadFromPhone(req, res, origin);
  else if (req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PHONE_PAGE_CSP,
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    });
    res.end(PHONE_PAGE);
  } else error(res, 405, 'Method not allowed.');
  return true;
}

export async function tryHandlePhoneOperator(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = req.url ?? '';
  if (path !== API_PATH && !path.startsWith(API_PATH + '/')) return false;
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie || !verifyToken(cookie)) {
    error(res, 401, 'Session required.');
    return true;
  }
  const ownerKey = req.headers['x-arco-phone-owner'];
  if (typeof ownerKey !== 'string' || !/^[0-9a-f]{64}$/.test(ownerKey)) {
    error(res, 403, 'Phone upload must be opened from the message box.');
    return true;
  }
  const owner = digest(ownerKey);
  try {
    if (path === API_PATH && req.method === 'POST') {
      purgeLinks();
      const body = JSON.parse((await readAttachmentBody(req, 4096)).toString()) as { workflowId?: string; origin?: string };
      const workflow = typeof body?.workflowId === 'string' ? workflows.get(body.workflowId) : undefined;
      if (!body?.workflowId || !targetAvailable(body.workflowId, workflow)) {
        error(res, 409, 'This conversation does not accept attachments.');
        return true;
      }
      let origins = phoneUploadOrigins(req);
      if (!origins.length) {
        openingCodes++;
        try {
          const opened = await temporaryOrigins(req.socket.localPort || PORT);
          if (opened.error) {
            error(res, 503, opened.error);
            return true;
          }
          origins = opened.origins;
          return createLink(res, { workflowId: body.workflowId, origin: body.origin }, workflow, owner, origins);
        } finally {
          openingCodes--;
        }
      }
      return createLink(res, { workflowId: body.workflowId, origin: body.origin }, workflow, owner, origins);
    }
    const id = path.slice(path.lastIndexOf('/') + 1);
    if (!UUID_PATTERN.test(id)) {
      error(res, 404, 'Phone upload not found.');
      return true;
    }
    if (path === API_PATH + '/draft/' + id) {
      const draft = phoneDraftForOwner(id, owner);
      if (!draft) error(res, 404, 'Phone attachment has expired.');
      else if (req.method === 'DELETE') {
        await discardPhoneDraft(draft);
        json(res, 200, { ok: true });
      } else if (req.method === 'GET') {
        const image = managedUploadPath(await awaitModelImage(draft.path));
        const preview = image ? await readFileForExplorer(image) : null;
        json(res, 200, { preview: preview?.type === 'image' ? preview.dataUrl : undefined });
      } else error(res, 405, 'Method not allowed.');
      return true;
    }
    const link = path === API_PATH + '/' + id ? links.get(id) : undefined;
    if (!link || link.owner !== owner) error(res, 404, 'Phone upload link not found.');
    else if (req.method === 'GET' || req.method === 'DELETE') {
      if (req.method === 'DELETE') closeLink(link);
      const closed = !active(link);
      const files = link.files.filter(file => phoneDraftForOwner(file.fileId, owner))
        .map(({ fileId, filename, path, expiresAt }) => ({ fileId, filename, path, expiresAt }));
      if (req.method === 'DELETE') links.delete(id);
      json(res, 200, { files, closed });
    } else error(res, 405, 'Method not allowed.');
  } catch (e) {
    if (e instanceof UploadTooLarge || e instanceof SyntaxError) error(res, 400, 'Invalid phone upload request.');
    else error(res, 500, 'Phone upload failed.');
  }
  return true;
}
