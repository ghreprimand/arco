import http from 'http';
import { randomUUID } from 'crypto';
import { readZaiApiKey } from '../providerSecrets.js';
import { acquireZaiSlot, isRetryableZai429, maxZaiRetries, recordZai429, zaiErrorCode } from './zai-native/rateLimit.js';

const ZAI_CODING_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';

let serverPromise: Promise<string> | null = null;

type ResponsesRequest = {
  model?: string;
  instructions?: string;
  input?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
};

type NamespacedToolName = {
  namespace: string;
  name: string;
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

type ChatTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
  };
};

type ChatStreamEvent = {
  choices?: Array<{
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
};

type ResponseOutputItem =
  | {
      id: string;
      type: 'message';
      status: 'completed' | 'in_progress';
      role: 'assistant';
      content: Array<{ type: 'output_text'; text: string; annotations: unknown[] }>;
    }
  | {
      id: string;
      type: 'function_call';
      status: 'completed' | 'in_progress';
      call_id: string;
      namespace?: string;
      name: string;
      arguments: string;
    };

type ResponseMessageItem = Extract<ResponseOutputItem, { type: 'message' }>;
type ResponseFunctionCallItem = Extract<ResponseOutputItem, { type: 'function_call' }>;

type Usage = {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
};

type ZaiStreamResponse = Response & { body: NonNullable<Response['body']> };

type ZaiUpstreamResult =
  | { ok: true; response: ZaiStreamResponse; retryCount: number; releaseSlot: () => void }
  | { ok: false; status: number; detail: string; retryAfter: string | null; type?: string };

function json(res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) });
  res.end(JSON.stringify(body));
}

function sse(res: http.ServerResponse, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    const text = p.text ?? p.output_text ?? p.output;
    if (typeof text === 'string') {
      out.push(text);
    } else if (p.type === 'input_image' || p.type === 'image_url') {
      out.push('[image input omitted by Z.ai Responses proxy]');
    }
  }
  return out.join('\n');
}

function mapRole(role: unknown): ChatMessage['role'] {
  if (role === 'assistant' || role === 'tool' || role === 'user') return role;
  return 'system';
}

function flattenNamespacedName(namespace: string, name: string): string {
  if (!namespace) return name;
  return namespace.endsWith('__') ? `${namespace}${name}` : `${namespace}__${name}`;
}

function responsesInputToChatMessages(req: ResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (typeof req.instructions === 'string' && req.instructions.trim()) {
    messages.push({ role: 'system', content: req.instructions });
  }
  const input = Array.isArray(req.input) ? req.input : [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const type = obj.type;
    if (type === 'message') {
      messages.push({
        role: mapRole(obj.role),
        content: extractText(obj.content),
      });
      continue;
    }
    if (type === 'function_call') {
      const callId = typeof obj.call_id === 'string' ? obj.call_id : typeof obj.id === 'string' ? obj.id : `call_${randomUUID()}`;
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: callId,
          type: 'function',
          function: {
            name: typeof obj.namespace === 'string' && typeof obj.name === 'string'
              ? flattenNamespacedName(obj.namespace, obj.name)
              : typeof obj.name === 'string'
                ? obj.name
                : '',
            arguments: typeof obj.arguments === 'string' ? obj.arguments : '',
          },
        }],
      });
      continue;
    }
    if (type === 'function_call_output') {
      const callId = typeof obj.call_id === 'string'
        ? obj.call_id
        : typeof obj.id === 'string'
          ? obj.id.replace(/:output$/, '')
          : `call_${randomUUID()}`;
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: extractText(obj.output ?? obj.content),
      });
    }
  }
  return messages;
}

function responsesToolsToChatTools(tools: unknown): { tools?: ChatTool[]; namespaceByFlatName: Map<string, NamespacedToolName> } {
  const namespaceByFlatName = new Map<string, NamespacedToolName>();
  if (!Array.isArray(tools)) return { namespaceByFlatName };
  const out: ChatTool[] = [];
  const seen = new Set<string>();
  const pushFunction = (name: string, description: unknown, parameters: unknown, strict: unknown): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({
      type: 'function',
      function: {
        name,
        description: typeof description === 'string' ? description : undefined,
        parameters: parameters ?? {},
        strict: typeof strict === 'boolean' ? strict : undefined,
      },
    });
  };
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const t = tool as Record<string, unknown>;
    if (t.type === 'function') {
      const nested = t.function && typeof t.function === 'object' ? t.function as Record<string, unknown> : {};
      const name = typeof t.name === 'string'
        ? t.name
        : typeof nested.name === 'string'
          ? nested.name
          : '';
      pushFunction(
        name,
        typeof t.description === 'string' ? t.description : nested.description,
        t.parameters ?? nested.parameters ?? {},
        typeof t.strict === 'boolean' ? t.strict : nested.strict,
      );
      continue;
    }

    if (t.type === 'namespace') {
      const namespace = typeof t.name === 'string' ? t.name : '';
      const children = Array.isArray(t.tools)
        ? t.tools
        : Array.isArray(t.functions)
          ? t.functions
          : [];
      if (!namespace || children.length === 0) continue;
      for (const child of children) {
        if (!child || typeof child !== 'object') continue;
        const c = child as Record<string, unknown>;
        const nested = c.function && typeof c.function === 'object' ? c.function as Record<string, unknown> : {};
        const childName = typeof c.name === 'string'
          ? c.name
          : typeof nested.name === 'string'
            ? nested.name
            : '';
        if (!childName) continue;
        const flatName = childName.startsWith(`${namespace}__`) || childName.startsWith(namespace)
          ? childName
          : flattenNamespacedName(namespace, childName);
        namespaceByFlatName.set(flatName, { namespace, name: childName });
        pushFunction(
          flatName,
          typeof c.description === 'string' ? c.description : nested.description,
          c.parameters ?? nested.parameters ?? c.input_schema ?? nested.input_schema ?? {},
          typeof c.strict === 'boolean' ? c.strict : nested.strict,
        );
      }
    }
  }
  return { tools: out.length > 0 ? out : undefined, namespaceByFlatName };
}

function summarizeToolsForLog(tools: unknown, mapped: ChatTool[] | undefined): void {
  if (!Array.isArray(tools)) return;
  const typeCounts = new Map<string, number>();
  const rawNames: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const t = tool as Record<string, unknown>;
    const type = typeof t.type === 'string' ? t.type : '(missing)';
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    const nested = t.function && typeof t.function === 'object' ? t.function as Record<string, unknown> : {};
    const name = typeof t.name === 'string' ? t.name : typeof nested.name === 'string' ? nested.name : undefined;
    if (name) rawNames.push(name);
  }
  const mappedNames = (mapped ?? []).map((tool) => tool.function.name);
  const peerNames = mappedNames.filter((name) => /peer_|cluster_|arco/i.test(name));
  console.log(
    `[zai-proxy] tools received=${tools.length} mapped=${mappedNames.length} ` +
    `types=${JSON.stringify(Object.fromEntries(typeCounts))} ` +
    `sample=${JSON.stringify(mappedNames.slice(0, 12))} ` +
    `cluster=${JSON.stringify(peerNames.slice(0, 16))}`,
  );
}

function responseEnvelope(
  req: ResponsesRequest,
  id: string,
  createdAt: number,
  status: 'in_progress' | 'completed' | 'failed',
  output: ResponseOutputItem[],
  usage: Usage,
): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    instructions: req.instructions ?? null,
    max_output_tokens: req.max_output_tokens ?? null,
    model: req.model ?? '',
    output,
    parallel_tool_calls: req.parallel_tool_calls ?? false,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: req.temperature ?? null,
    text: null,
    tool_choice: req.tool_choice ?? 'auto',
    tools: Array.isArray(req.tools) ? req.tools : [],
    top_p: req.top_p ?? null,
    truncation: null,
    usage,
  };
}

function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0,
  };
}

function usageFromChat(evt: ChatStreamEvent, current: Usage): Usage {
  const prompt = evt.usage?.prompt_tokens;
  const completion = evt.usage?.completion_tokens;
  const total = evt.usage?.total_tokens;
  const cached = evt.usage?.prompt_tokens_details?.cached_tokens;
  if (typeof prompt !== 'number' && typeof completion !== 'number' && typeof total !== 'number') return current;
  return {
    input_tokens: typeof prompt === 'number' ? prompt : current.input_tokens,
    input_tokens_details: { cached_tokens: typeof cached === 'number' ? cached : current.input_tokens_details.cached_tokens },
    output_tokens: typeof completion === 'number' ? completion : current.output_tokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: typeof total === 'number'
      ? total
      : (typeof prompt === 'number' ? prompt : current.input_tokens) + (typeof completion === 'number' ? completion : current.output_tokens),
  };
}

async function fetchZaiChatCompletion(key: string, chatBody: Record<string, unknown>, signal: AbortSignal): Promise<ZaiUpstreamResult> {
  let retryCount = 0;
  for (let attempt = 0; ; attempt += 1) {
    const slot = await acquireZaiSlot();
    try {
      signal.throwIfAborted();
      const upstream = await fetch(`${ZAI_CODING_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(chatBody),
        signal,
      });
      if (upstream.ok && upstream.body) {
        if (retryCount > 0) {
          console.log(`[zai-proxy] upstream recovered after ${retryCount} 429 ${retryCount === 1 ? 'retry' : 'retries'}`);
        }
        return { ok: true, response: upstream as ZaiStreamResponse, retryCount, releaseSlot: slot.release };
      }

      const detail = await upstream.text().catch(() => '');
      const retryAfter = upstream.headers.get('retry-after');
      if (upstream.status !== 429 || !isRetryableZai429(detail) || attempt >= maxZaiRetries()) {
        slot.release();
        return {
          ok: false,
          status: upstream.status,
          detail,
          retryAfter,
          ...(upstream.status === 429 ? { type: 'rate_limit_error' } : {}),
        };
      }

      const backoff = recordZai429(retryAfter, attempt);
      retryCount += 1;
      const code = zaiErrorCode(detail);
      console.warn(
        `[zai-proxy] upstream 429${code ? ` code=${code}` : ''}; ` +
        `retry ${retryCount}/${maxZaiRetries()} after ${Math.ceil(backoff / 1000)}s`,
      );
      slot.release();
    } catch (err) {
      slot.release();
      throw err;
    }
  }
}

async function handleResponses(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await new Promise<string>((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

  let body: ResponsesRequest;
  try {
    body = JSON.parse(raw) as ResponsesRequest;
  } catch {
    json(res, 400, { error: { message: 'Invalid JSON body' } });
    return;
  }

  const key = await readZaiApiKey();
  if (!key) {
    json(res, 401, { error: { message: 'ZAI_API_KEY is not configured in Arco' } });
    return;
  }

  const chatBody: Record<string, unknown> = {
    model: body.model,
    messages: responsesInputToChatMessages(body),
    stream: true,
    stream_options: { include_usage: true },
  };
  const toolConversion = responsesToolsToChatTools(body.tools);
  const chatTools = toolConversion.tools;
  if (chatTools) chatBody.tools = chatTools;
  if (chatTools) chatBody.tool_stream = true;
  summarizeToolsForLog(body.tools, chatTools);
  if (typeof body.temperature === 'number') chatBody.temperature = body.temperature;
  if (typeof body.top_p === 'number') chatBody.top_p = body.top_p;
  if (typeof body.max_output_tokens === 'number') chatBody.max_tokens = body.max_output_tokens;
  if (body.tool_choice === 'none' || body.tool_choice === 'auto' || body.tool_choice === 'required') {
    chatBody.tool_choice = body.tool_choice;
  }

  // Codex app-server drops the connection on interrupt. Without this abort the
  // upstream generation kept streaming into a dead socket and held one of the
  // process-wide Z.ai slots until GLM finished on its own. 'close' on res (not
  // req — req closes once its body is consumed) with an unfinished response
  // means the client went away.
  const upstreamAbort = new AbortController();
  const onClientClose = (): void => {
    if (!res.writableFinished) upstreamAbort.abort();
  };
  res.on('close', onClientClose);
  const clientGone = (): boolean => upstreamAbort.signal.aborted;

  let upstreamResult: ZaiUpstreamResult;
  try {
    upstreamResult = await fetchZaiChatCompletion(key, chatBody, upstreamAbort.signal);
  } catch (err) {
    if (clientGone()) return;
    json(res, 502, { error: { message: `Z.ai request failed: ${err instanceof Error ? err.message : String(err)}` } });
    return;
  }

  if (!upstreamResult.ok) {
    if (clientGone()) return;
    json(
      res,
      upstreamResult.status,
      {
        error: {
          message: upstreamResult.detail || `Z.ai HTTP ${upstreamResult.status}`,
          ...(upstreamResult.type ? { type: upstreamResult.type } : {}),
        },
      },
      upstreamResult.retryAfter ? { 'retry-after': upstreamResult.retryAfter } : undefined,
    );
    return;
  }

  const upstream = upstreamResult.response;
  const releaseSlot = upstreamResult.releaseSlot;
  const responseId = `resp_${randomUUID().replace(/-/g, '')}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let usage = emptyUsage();
  const output: ResponseOutputItem[] = [];

  try {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });

    let nextOutputIndex = 0;
    const textState: { item: ResponseMessageItem | null; outputIndex: number; text: string } = {
      item: null,
      outputIndex: -1,
      text: '',
    };
    const toolCalls = new Map<number, {
      outputIndex: number;
      item: ResponseFunctionCallItem;
    }>();

    sse(res, 'response.created', {
      response: responseEnvelope(body, responseId, createdAt, 'in_progress', [], usage),
    });
    sse(res, 'response.in_progress', {
      response: responseEnvelope(body, responseId, createdAt, 'in_progress', [], usage),
    });

    const openTextItem = (): void => {
      if (textState.item) return;
      textState.outputIndex = nextOutputIndex++;
      textState.item = {
        id: `msg_${randomUUID().replace(/-/g, '')}`,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      };
      sse(res, 'response.output_item.added', { output_index: textState.outputIndex, item: textState.item });
      sse(res, 'response.content_part.added', {
        item_id: textState.item.id,
        output_index: textState.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    };

    const openToolCall = (index: number, callId: string, name: string): ResponseFunctionCallItem => {
      const namespaced = toolConversion.namespaceByFlatName.get(name);
      const responseName = namespaced?.name ?? name;
      const existing = toolCalls.get(index);
      if (existing) {
        if (responseName && !existing.item.name) existing.item.name = responseName;
        if (namespaced && !existing.item.namespace) existing.item.namespace = namespaced.namespace;
        return existing.item;
      }
      const item: ResponseFunctionCallItem = {
        id: `fc_${randomUUID().replace(/-/g, '')}`,
        type: 'function_call',
        status: 'in_progress',
        call_id: callId,
        ...(namespaced ? { namespace: namespaced.namespace } : {}),
        name: responseName,
        arguments: '',
      };
      const outputIndex = nextOutputIndex++;
      toolCalls.set(index, { outputIndex, item });
      sse(res, 'response.output_item.added', { output_index: outputIndex, item });
      return item;
    };

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt: ChatStreamEvent;
        try {
          evt = JSON.parse(payload) as ChatStreamEvent;
        } catch {
          continue;
        }
        usage = usageFromChat(evt, usage);
        const delta = evt.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          openTextItem();
          textState.text += delta.content;
          sse(res, 'response.output_text.delta', {
            item_id: textState.item!.id,
            output_index: textState.outputIndex,
            content_index: 0,
            delta: delta.content,
            logprobs: [],
          });
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const rawCall of delta.tool_calls) {
            if (!rawCall || typeof rawCall !== 'object') continue;
            const call = rawCall as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
            const index = typeof call.index === 'number' ? call.index : 0;
            const item = openToolCall(index, call.id ?? `call_${randomUUID().replace(/-/g, '')}`, call.function?.name ?? '');
            const argDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
            if (argDelta) {
              item.arguments += argDelta;
              sse(res, 'response.function_call_arguments.delta', {
                item_id: item.id,
                output_index: toolCalls.get(index)!.outputIndex,
                delta: argDelta,
              });
            }
          }
        }
      }
    }

    if (textState.item) {
      textState.item.status = 'completed';
      textState.item.content = [{ type: 'output_text', text: textState.text, annotations: [] }];
      output.push(textState.item);
      sse(res, 'response.output_text.done', {
        item_id: textState.item.id,
        output_index: textState.outputIndex,
        content_index: 0,
        text: textState.text,
        logprobs: [],
      });
      sse(res, 'response.content_part.done', {
        item_id: textState.item.id,
        output_index: textState.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: textState.text, annotations: [] },
      });
      sse(res, 'response.output_item.done', { output_index: textState.outputIndex, item: textState.item });
    }

    for (const { outputIndex, item } of [...toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      item.status = 'completed';
      output.push(item);
      sse(res, 'response.function_call_arguments.done', {
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
      sse(res, 'response.output_item.done', { output_index: outputIndex, item });
    }

    sse(res, 'response.completed', {
      response: responseEnvelope(body, responseId, createdAt, 'completed', output, usage),
    });
    res.end();
  } catch (err) {
    if (clientGone()) return;
    sse(res, 'response.failed', {
      response: {
        ...responseEnvelope(body, responseId, createdAt, 'failed', output, usage),
        error: { message: err instanceof Error ? err.message : String(err) },
      },
    });
    res.end();
  } finally {
    res.off('close', onClientClose);
    releaseSlot();
  }
}

async function startProxy(): Promise<string> {
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method === 'POST' && (req.url === '/responses' || req.url === '/v1/responses')) {
        await handleResponses(req, res);
        return;
      }
      json(res, 404, { error: { message: 'Not found' } });
    })().catch((err) => {
      if (!res.headersSent) {
        json(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Z.ai Responses proxy failed to bind a TCP port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`[zai-proxy] listening on ${baseUrl}`);
  return baseUrl;
}

export function getZaiResponsesProxyBaseUrl(): Promise<string> {
  if (!serverPromise) serverPromise = startProxy();
  return serverPromise;
}
