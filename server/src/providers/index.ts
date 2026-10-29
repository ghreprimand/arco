import { retiredProviderReason } from '@arco/shared';
import type { ProviderName, WorkerConfig } from '@arco/shared';
import { EventEmitter } from 'events';
import type { Provider, ProviderProcess } from './types.js';
import { ClaudeProvider } from './claude.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';
import { CodexProvider } from './codex.js';
import { CodexAppServerProvider, disposeCodexAppServerWorker } from './codex-appserver/index.js';
import { ClaudeNativeProvider, disposeClaudeNativeWorker } from './claude-native/index.js';
import { LlamacppProvider } from './llamacpp.js';
import { isLocalModelProvider, localModelsUnloading, localModelBusyMessage } from './localModelControl.js';
import { DeepSeekProvider } from './deepseek.js';
import { StrataProvider } from './strata.js';
import { LmstudioProvider } from './lmstudio.js';
import { CursorProvider, disposeCursorWorker } from './cursor/index.js';
import { CursorPrintProvider } from './cursor/print.js';

export type { Provider, ProviderProcess } from './types.js';

const PROVIDERS: Record<ProviderName, Provider> = {
  claude: ClaudeProvider,
  gemini: GeminiProvider,
  ollama: OllamaProvider,
  codex: CodexProvider,

  llamacpp: LlamacppProvider,
  lmstudio: LmstudioProvider,
  strata: StrataProvider,
  deepseek: DeepSeekProvider,
  cursor: CursorProvider,
};

// M13 — LM Studio joins ollama/llamacpp on the serial local queue. LM Studio's
// app typically serves one loaded model at a time on the configured endpoint,
// so running multiple Arco turns against it concurrently would contend on the
// same backend; serializing matches the local-runtime pattern. (Override the
// serial behavior via ARCO_LOCAL_PROVIDER_SERIAL_QUEUE=0, except Strata:
// its profile manager requires the slot for the entire tool loop.)
type LocalProviderName = 'ollama' | 'llamacpp' | 'lmstudio' | 'strata' | 'deepseek';

const localQueues: Record<LocalProviderName, Promise<void>> = {
  ollama: Promise.resolve(),
  llamacpp: Promise.resolve(),
  lmstudio: Promise.resolve(),
  strata: Promise.resolve(),
  deepseek: Promise.resolve(),
};

class QueuedLocalProcess extends EventEmitter implements ProviderProcess {
  private inner: ProviderProcess | null = null;
  private killed = false;
  private _status: ProviderProcess['status'] = 'spawning';
  private _output = '';

  constructor(
    readonly id: string,
    private readonly providerName: LocalProviderName,
    private readonly config: WorkerConfig,
  ) {
    super();
  }

  get status(): ProviderProcess['status'] {
    return this.inner?.status ?? this._status;
  }

  get output(): string {
    return this.inner?.output ?? this._output;
  }

  get pid(): number | undefined {
    return this.inner?.pid;
  }

  spawn(prompt: string): void {
    const run = async (): Promise<void> => {
      if (localModelsUnloading()) {
        this._status = 'failed';
        this.emit('error', localModelBusyMessage());
        return;
      }
      if (this.killed) {
        this._status = 'failed';
        this.emit('error', `${this.providerName} worker was cancelled before its local-provider slot became available`);
        return;
      }
      this.emit('system_notice', `${this.providerName} local slot acquired`);
      const inner = PROVIDERS[this.providerName].create(this.id, this.config);
      this.inner = inner;
      inner.on('init', (data) => this.emit('init', data));
      inner.on('text', (text) => { this._output += text; this.emit('text', text); });
      inner.on('thinking', (text) => this.emit('thinking', text));
      inner.on('tool_use', (data) => this.emit('tool_use', data));
      inner.on('system_notice', (notice) => this.emit('system_notice', notice));
      await new Promise<void>((resolve) => {
        inner.once('result', (data) => { this._status = 'completed'; this.emit('result', data); resolve(); });
        inner.once('error', (error) => { this._status = 'failed'; this.emit('error', error); resolve(); });
        inner.spawn(prompt);
        if (this.killed) inner.kill();
      });
    };

    const prior = localQueues[this.providerName];
    let release!: () => void;
    localQueues[this.providerName] = new Promise<void>((resolve) => { release = resolve; });
    void prior
      .then(run, run)
      .finally(() => release());
    this.emit('system_notice', `${this.providerName} local slot queued; Arco runs one ${this.providerName} worker at a time`);
  }

  kill(): void {
    this.killed = true;
    this.inner?.kill();
  }
}

export function createProviderProcess(id: string, config: WorkerConfig): ProviderProcess {
  const name: ProviderName = config.provider ?? 'claude';
  if (isLocalModelProvider(name) && localModelsUnloading()) {
    const refused = new EventEmitter() as ProviderProcess;
    Object.assign(refused, { id, status: 'failed', output: '', kill() {},
      spawn() { refused.emit('error', localModelBusyMessage()); } });
    return refused;
  }
  if (name === 'cursor' && config.interactionMode === 'chat') {
    return CursorPrintProvider.create(id, config);
  }

  // Phase 6 — Codex `app-server` transport. Opt-in per tab via the
  // `codex.transport` setting (cascade); reviewer paths never set
  // `codexTransport: 'appserver'` so they always fall through to exec.
  if (name === 'codex' && config.codexTransport === 'appserver') {
    return CodexAppServerProvider.create(id, config);
  }
  // Phase 7a — Claude Native transport. Per-tab opt-in via `claude.transport`
  // (cascade) or per-tab override; reviewer / handoff seed paths leave
  // `claudeTransport` unset so they always fall through to the CLI provider.
  if (name === 'claude' && config.claudeTransport === 'native') {
    return ClaudeNativeProvider.create(id, config);
  }
  // Phase 5 — read-only Cursor primitives (reviewer / fresh-summarizer / DOCS /
  // research / compare) run as a stateless `cursor-agent -p --mode ask` one-shot,
  // NOT through the long-lived ACP worker cache. A primitive carries the
  // initiating tab's workflowId, so reusing the cache would hijack the operator's
  // live session (transcript pollution, primary model, read-write). `sandbox:
  // 'read-only'` is the exclusive one-shot signal — primary turns never set it
  // (they use `efficiencySandbox`). Task-child / spawn-from-here tabs carry their
  // OWN workflowId and no read-only sandbox, so they keep the full ACP worker.
  if (name === 'cursor' && config.sandbox === 'read-only') {
    return CursorPrintProvider.create(id, config);
  }
  if (name === 'strata' || name === 'deepseek' || ((name === 'ollama' || name === 'llamacpp' || name === 'lmstudio') && process.env.ARCO_LOCAL_PROVIDER_SERIAL_QUEUE !== '0')) {
    return new QueuedLocalProcess(id, name, config);
  }
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(retiredProviderReason(name) ?? `Unknown provider: ${name}`);
  }
  return provider.create(id, config);
}

// Workflow tab close — tear down the long-lived `codex app-server` child
// or Claude Native worker if one was spawned for this tab. Both are
// no-ops when the tab never used the corresponding transport. Also
// invoked from `handleHandoffRequest` after `handoff_complete` so the
// next operator turn rebuilds against the fresh post-handoff transcript.
export function disposeProviderResources(workflowId: string): void {
  disposeCodexAppServerWorker(workflowId);
  disposeClaudeNativeWorker(workflowId);
  disposeCursorWorker(workflowId);
}

export function isKnownProvider(name: string): name is ProviderName {
  return name === 'claude' || name === 'gemini' || name === 'ollama' || name === 'codex' || name === 'llamacpp' || name === 'lmstudio' || name === 'strata' || name === 'deepseek' || name === 'cursor';
}
