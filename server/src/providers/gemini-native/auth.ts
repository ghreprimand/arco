// Gemini Native auth — reads ~/.gemini/oauth_creds.json written by the
// Gemini CLI and refreshes the access token as needed. We never write back
// to the file; the CLI owns it.
//
// The actual generation API is cloudcode-pa.googleapis.com/v1internal, NOT
// generativelanguage.googleapis.com. The cloud-platform scope is sufficient
// for cloudcode-pa; it is NOT sufficient for the public generativelanguage
// endpoint. This is a critical distinction discovered during G1.
//
// Auth state is two-layered:
//   1. OAuth access token  — refreshed from ~/.gemini/oauth_creds.json every ~1h
//   2. Project ID          — resolved via loadCodeAssist once and cached
//
// The project ID is the user's "cloudaicompanionProject" (e.g. "verdant-archway-x6l2d"),
// returned by a POST to cloudcode-pa's loadCodeAssist endpoint. It is stable
// per Google account and does not change between sessions.

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

// Sourced from the open-source CLI bundle (bundle/chunk-DMWX7UP6.js).
// The refresh flow requires it even for "native" apps — Google's token
// endpoint enforces client_secret for this registration.
const CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const CREDS_PATH = join(homedir(), '.gemini', 'oauth_creds.json');
// Refresh 60s before expiry — access tokens last 1 hour.
const REFRESH_BUFFER_MS = 60_000;

export interface GeminiTokens {
  accessToken: string;
  expiryDate: number; // epoch ms
}

interface StoredCreds {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number; // epoch ms (CLI format)
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string;
  paidTier?: { id?: string; name?: string };
}

let cachedTokens: GeminiTokens | null = null;
let tokenInFlight: Promise<GeminiTokens> | null = null;

let cachedProjectId: string | null = null;
let projectInFlight: Promise<string> | null = null;

export async function ensureLiveTokens(): Promise<GeminiTokens> {
  const now = Date.now();
  if (cachedTokens && cachedTokens.expiryDate > now + REFRESH_BUFFER_MS) return cachedTokens;
  if (tokenInFlight) return tokenInFlight;
  tokenInFlight = doRefreshToken().finally(() => { tokenInFlight = null; });
  try {
    cachedTokens = await tokenInFlight;
    return cachedTokens;
  } catch (err) {
    cachedTokens = null;
    throw err;
  }
}

// Resolves the user's cloudaicompanionProject via a loadCodeAssist probe.
// Cached permanently for the server's lifetime — the project ID is stable
// per Google account. Call ensureLiveTokens() first if you need the token.
export async function ensureProjectId(): Promise<string> {
  if (cachedProjectId) return cachedProjectId;
  if (projectInFlight) return projectInFlight;
  projectInFlight = doResolveProject().finally(() => { projectInFlight = null; });
  try {
    cachedProjectId = await projectInFlight;
    return cachedProjectId;
  } catch (err) {
    cachedProjectId = null;
    throw err;
  }
}

async function doRefreshToken(): Promise<GeminiTokens> {
  const raw = await readFile(CREDS_PATH, 'utf8').catch(() => {
    throw new Error(
      `[AUTH:gemini] ~/.gemini/oauth_creds.json not found — run 'gemini' once to authenticate`
    );
  });

  let creds: StoredCreds;
  try {
    creds = JSON.parse(raw) as StoredCreds;
  } catch {
    throw new Error('[AUTH:gemini] ~/.gemini/oauth_creds.json is not valid JSON');
  }

  const now = Date.now();

  // Reuse the stored access_token if still fresh enough.
  if (creds.access_token && creds.expiry_date && creds.expiry_date > now + REFRESH_BUFFER_MS) {
    return { accessToken: creds.access_token, expiryDate: creds.expiry_date };
  }

  if (!creds.refresh_token) {
    throw new Error(
      '[AUTH:gemini] ~/.gemini/oauth_creds.json has no refresh_token — run gemini once to re-authenticate'
    );
  }

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 400 && text.includes('invalid_grant')) {
      throw new Error(
        '[AUTH:gemini] invalid_grant — refresh token revoked. Run gemini to re-authenticate.'
      );
    }
    throw new Error(`[AUTH:gemini] token refresh failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  const body = await resp.json() as { access_token: string; expires_in: number };
  return {
    accessToken: body.access_token,
    expiryDate: now + body.expires_in * 1000,
  };
}

async function doResolveProject(): Promise<string> {
  const tokens = await ensureLiveTokens();
  // GOOGLE_CLOUD_PROJECT env override — same logic the CLI uses.
  const envProject = process.env['GOOGLE_CLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT_ID'];
  const resp = await fetch(LOAD_CODE_ASSIST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      cloudaicompanionProject: envProject,
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
        duetProject: envProject,
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`[AUTH:gemini] loadCodeAssist failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  const body = await resp.json() as LoadCodeAssistResponse;
  const projectId = body.cloudaicompanionProject;
  if (!projectId) {
    throw new Error('[AUTH:gemini] loadCodeAssist returned no cloudaicompanionProject');
  }
  return projectId;
}
