#!/usr/bin/env node
// PKCE OAuth flow using Antigravity's client credentials.
// Saves tokens to ~/.arco/gemini-antigravity-tokens.json and
// immediately tests streamGenerateChat with project=aipp-internal-testing.

import { createServer } from 'http';
import { createHash, randomBytes } from 'crypto';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';

// Arco home: ARCO_HOME, else ~/.arco.
const ARCO_HOME = (process.env.ARCO_HOME || '').trim()
  ? resolve(process.env.ARCO_HOME.trim())
  : join(homedir(), '.arco');

// Gemini CLI client — registered for broader scopes than the Antigravity client
const CLIENT_ID   = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_PORT = 37679;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/generative-language',
].join(' ');

const TOKEN_PATH = join(ARCO_HOME, 'gemini-antigravity-tokens.json');

// ── PKCE helpers ────────────────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
const verifier  = base64url(randomBytes(32));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const state     = randomBytes(16).toString('hex');

// ── Auth URL ─────────────────────────────────────────────────────────────────
const params = new URLSearchParams({
  client_id:             CLIENT_ID,
  redirect_uri:          REDIRECT_URI,
  response_type:         'code',
  scope:                 SCOPES,
  state,
  code_challenge:        challenge,
  code_challenge_method: 'S256',
  access_type:           'offline',
  prompt:                'consent',
});
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

// ── Callback server ───────────────────────────────────────────────────────────
await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404); res.end('not found'); return;
    }

    const code     = url.searchParams.get('code');
    const gotState = url.searchParams.get('state');
    const error    = url.searchParams.get('error');

    if (error) {
      res.writeHead(400); res.end(`OAuth error: ${error}`);
      server.close(() => reject(new Error(`OAuth error: ${error}`)));
      return;
    }
    if (gotState !== state) {
      res.writeHead(400); res.end('state mismatch');
      server.close(() => reject(new Error('state mismatch')));
      return;
    }
    if (!code) {
      res.writeHead(400); res.end('no code');
      server.close(() => reject(new Error('no code in callback')));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Auth complete — you can close this tab.</h1>');

    // Close the server BEFORE doing the async exchange so we don't hold the port.
    server.close(() => {
      exchangeCode(code).then(resolve).catch(reject);
    });
  });

  server.listen(REDIRECT_PORT, '127.0.0.1', () => {
    console.log(`\nCallback server listening on port ${REDIRECT_PORT}`);
    console.log('\nOpen this URL in your browser:\n');
    console.log(authUrl);
    console.log('\nWaiting for redirect...\n');
  });

  server.on('error', reject);
});

async function exchangeCode(code) {
  console.log('Exchanging code for tokens...');
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code_verifier: verifier,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed (${resp.status}): ${txt.slice(0, 300)}`);
  }

  const body = await resp.json();
  console.log('Token exchange OK. expires_in:', body.expires_in);
  console.log('Scopes:', body.scope);

  const tokens = {
    access_token:  body.access_token,
    refresh_token: body.refresh_token,
    expiry_date:   Date.now() + body.expires_in * 1000,
    scope:         body.scope,
    obtained_via:  CLIENT_ID,
    saved_at:      new Date().toISOString(),
  };

  await mkdir(ARCO_HOME, { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
  console.log(`\nTokens saved to ${TOKEN_PATH}`);

  await testGenerativeLang(tokens.access_token);
  await testStreamGenerateChat(tokens.access_token);
}

async function testGenerativeLang(accessToken) {
  const models = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];
  console.log('\n── generativelanguage.googleapis.com ──');
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say "hello" in one word.' }] }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) {
      const body = await r.json();
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? JSON.stringify(body).slice(0, 100);
      console.log(`  OK ${model}: "${text.trim()}"`);
    } else {
      const txt = await r.text().catch(() => '');
      const reason = txt.includes('SCOPE') ? 'SCOPE_INSUFFICIENT' : txt.includes('not found') ? 'MODEL_NOT_FOUND' : txt.slice(0, 120).replace(/\s+/g, ' ');
      console.log(`  ${r.status} ${model}: ${reason}`);
    }
  }
}

async function testStreamGenerateChat(accessToken) {
  const projects = ['aipp-internal-testing', 'verdant-archway-x6l2d'];

  for (const project of projects) {
    console.log(`\n── Testing project: ${project} ──`);
    const url = 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateChat?alt=sse';
    const body = {
      project,
      userMessage: 'Say "hello" in one word.',
      history: [],
      modelConfigId: 'chat-gemini-3-5-flash-paid-tier',
    };

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      console.log(`  HTTP ${resp.status} ${resp.statusText}`);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        console.log(`  Body: ${txt.slice(0, 400)}`);
        continue;
      }

      // Read first few SSE lines
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let received = '';
      let chunks = 0;
      while (chunks < 5) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
        chunks++;
      }
      reader.cancel();
      console.log(`  SSE preview:\n${received.slice(0, 600)}`);
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
  }

  // Also try listing available model configs if there's an endpoint
  console.log('\n── Probing listModelConfigs ──');
  await probeListConfigs(accessToken);
}

async function probeListConfigs(accessToken) {
  const candidates = [
    'https://cloudcode-pa.googleapis.com/v1internal/modelConfigs',
    'https://cloudcode-pa.googleapis.com/v1internal:listModelConfigs',
    'https://cloudcode-pa.googleapis.com/v1internal/projects/aipp-internal-testing/modelConfigs',
  ];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000),
      });
      console.log(`  ${resp.status} ${url.split('/').slice(-1)[0]}`);
      if (resp.ok) {
        const txt = await resp.text().catch(() => '');
        console.log(`  Body: ${txt.slice(0, 400)}`);
      }
    } catch (err) {
      console.log(`  Error ${url.split('/').slice(-1)[0]}: ${err.message}`);
    }
  }
}
