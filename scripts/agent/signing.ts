// archon-agent §13.2 — Ed25519 signing/verification for lifecycle commands.
//
// PURE module (node:crypto only, no filesystem, no network) so the smoke
// (scripts/smoke/archon-agent.ts) imports and exercises it without a hub. The
// hub holds the private key and SIGNS; each agent is provisioned the hub's
// PUBLIC key and VERIFIES. Tailnet already authenticates transport — this
// signature adds command authenticity + replay protection on top, so even a
// compromised tailnet peer cannot forge a lifecycle command.
//
// Import path for scripts/smoke: '../agent/signing.js'

import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from 'node:crypto';
import type {
  LifecycleCommandPayload,
  LifecycleRejection,
  SignedLifecycleCommand,
} from '../../shared/src/protocol/remoteManagement.js';
import { isLifecycleCommand } from '../../shared/src/protocol/remoteManagement.js';

// Canonical serialization — a FIXED field order so the signer and verifier
// always hash byte-identical input regardless of object key ordering. Never
// JSON.stringify the payload object directly (key order is not guaranteed).
export function canonicalizePayload(p: LifecycleCommandPayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      cmd: p.cmd,
      instanceId: p.instanceId,
      nonce: p.nonce,
      issuedAt: p.issuedAt,
    }),
    'utf8',
  );
}

export interface HubKeypairPem {
  publicKey: string; // SPKI PEM — provisioned to every agent (~/.archon/agent/hub.pub)
  privateKey: string; // PKCS8 PEM — lives ONLY on the hub, never committed
}

// Generate a fresh hub keypair. Run on the hub at provisioning time; distribute
// the public half to each agent. (The smoke generates an ephemeral pair.)
export function generateHubKeypair(): HubKeypairPem {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

// Hub side: wrap a payload in a detached Ed25519 signature.
export function signCommand(
  privateKeyPem: string,
  payload: LifecycleCommandPayload,
): SignedLifecycleCommand {
  const key = createPrivateKey(privateKeyPem);
  const signature = edSign(null, canonicalizePayload(payload), key).toString('base64');
  return { payload, signature };
}

export interface VerifyOptions {
  publicKeyPem: string;
  expectInstanceId: string;
  now: number; // injectable clock (ms epoch) so tests are deterministic
  skewMs?: number; // accepted +/- window around issuedAt; default 60s
  // Replay guard: returns true if this nonce was already consumed. The verifier
  // is pure — it never records; the caller records after a successful handle.
  seenNonce: (nonce: string) => boolean;
}

export interface VerifyResult {
  ok: boolean;
  failure?: LifecycleRejection;
}

const DEFAULT_SKEW_MS = 60_000;

// Verify, in order: well-formedness → allowlisted command → signature →
// instance match → freshness → replay. Returns the FIRST failure reason. The
// order is deliberate: cheap structural checks before the crypto, then identity,
// then freshness/replay (so a forged signature never reaches the nonce store).
export function verifyCommand(signed: unknown, opts: VerifyOptions): VerifyResult {
  // ── structural ──
  if (
    !signed ||
    typeof signed !== 'object' ||
    typeof (signed as SignedLifecycleCommand).signature !== 'string' ||
    typeof (signed as SignedLifecycleCommand).payload !== 'object' ||
    (signed as SignedLifecycleCommand).payload === null
  ) {
    return { ok: false, failure: 'malformed' };
  }
  const { payload, signature } = signed as SignedLifecycleCommand;
  if (
    !isLifecycleCommand(payload.cmd) ||
    typeof payload.instanceId !== 'string' ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length === 0 ||
    typeof payload.issuedAt !== 'number' ||
    !Number.isFinite(payload.issuedAt)
  ) {
    // A cmd that fails isLifecycleCommand but is otherwise a string is reported
    // as not-allowlisted (more actionable than "malformed").
    if (typeof payload.cmd === 'string' && payload.instanceId && payload.nonce) {
      return { ok: false, failure: 'not-allowlisted' };
    }
    return { ok: false, failure: 'malformed' };
  }

  // ── signature ──
  let sigOk = false;
  try {
    sigOk = edVerify(
      null,
      canonicalizePayload(payload),
      createPublicKey(opts.publicKeyPem),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, failure: 'bad-signature' };

  // ── identity ──
  if (payload.instanceId !== opts.expectInstanceId) {
    return { ok: false, failure: 'wrong-instance' };
  }

  // ── freshness ──
  const skew = opts.skewMs ?? DEFAULT_SKEW_MS;
  const delta = opts.now - payload.issuedAt;
  if (delta > skew) return { ok: false, failure: 'stale' };
  if (delta < -skew) return { ok: false, failure: 'future' };

  // ── replay ──
  if (opts.seenNonce(payload.nonce)) return { ok: false, failure: 'replay' };

  return { ok: true };
}
