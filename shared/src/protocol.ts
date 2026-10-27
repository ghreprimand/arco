// Thin barrel. The protocol type surface was split into per-domain files under
// ./protocol/ (docs/ARCHITECTURE.md); this file is kept so the
// long-standing `./protocol.js` import in shared/src/index.ts (and any other
// consumer that resolved the old path) still points at the full flat surface.
export * from './protocol/index.js';
