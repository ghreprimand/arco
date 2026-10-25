import { useAppStore } from '../stores/appStore';
import type { CodexCatalogSnapshot } from '@arco/shared';

// Resolve the Codex catalog for a specific account profile (HOME / WORK).
//
// Codex model availability is entitlement-gated per account, so each profile
// is polled separately into `codexCatalogByAccount` (keyed by profile id).
// Account-aware pickers pass the workflow's / dialog's `providerAccountRef`
// here; surfaces without an account in scope keep reading the plain
// `codexCatalog` slice (the default-account fallback).
//
// Falls back to `codexCatalog` when the given ref hasn't been polled yet
// (cold start) or is undefined — never returns a wrong-account list silently,
// because the default slice is itself the default account's catalog.
export function useCodexCatalogFor(accountRef?: string | null): CodexCatalogSnapshot | null {
  return useAppStore((s) => (accountRef ? s.codexCatalogByAccount[accountRef] : undefined) ?? s.codexCatalog);
}
