/**
 * OpenAI Responses API translator ("codex" provider).
 *
 * Handles Gemini ↔ Responses API mapping for endpoints that speak
 * `POST /responses` rather than `/chat/completions` or `/v1/messages` —
 * kie.ai's Codex gateway (https://api.kie.ai/codex/v1/responses) and OpenAI's
 * own Responses endpoint among them.
 *
 * ## Why this is not the openai translator with a different URL
 *
 * The three shapes differ everywhere that matters:
 *
 *   chat/completions   { messages: [{role, content}] }        → choices[].message
 *   Responses          { instructions, input: [...] }         → output[]
 *
 * The system prompt is a top-level `instructions` string rather than a message.
 * Tool definitions are flat (`{type, name, parameters}`) rather than nested
 * under `function`. Tool calls and their results are top-level items in the same
 * `input` array as messages, not separate roles. Pointing the openai translator
 * at a /responses URL produces a body the endpoint rejects with a 500.
 */

import * as path from 'path';

import log from '../../logger';
import {
  fixParamTypes,
  translateToolCallToNative,
  formatTranslatedResponse,
  normalizeToolArgs,
  ToolCallArgs,
} from './utils';
import {
  modelToolCallIds,
  modelReasoningContent,
  activeStreamContexts,
  translatedToolCalls,
  stateTimestamps,
  touchStateTimestamp,
} from '../shared';

// ─── Types ────────────────────────────────────────────────────────────────

interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: { type: string; properties?: Record<string, unknown> };
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: unknown; id?: string };
  fileData?: { mimeType: string; fileUri: string };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

interface GeminiRequestBody {
  systemInstruction?: { parts: GeminiPart[] };
  contents?: GeminiContent[];
  tools?: GeminiTool[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    thinkingConfig?: { thinkingBudget?: number };
  };
}

type CodexInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'output_text'; text: string };

/** A message, a tool call, or a tool result — all three share the input array. */
type CodexInputItem =
  | { role: 'user' | 'assistant'; content: CodexInputContent[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

interface CodexTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface CodexRequestBody {
  model: string;
  input: CodexInputItem[];
  instructions?: string;
  tools?: CodexTool[];
  tool_choice?: string;
  reasoning?: { effort: string };
  stream?: boolean;
}

interface CodexOutputItem {
  type: string;
  role?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
  summary?: { type: string; text?: string }[];
}

interface CodexResponse {
  id?: string;
  status?: string;
  output?: CodexOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

/** One SSE `data:` payload. Every event carries its name in `type`. */
interface CodexStreamEvent {
  type?: string;
  delta?: string;
  text?: string;
  arguments?: string;
  item_id?: string;
  output_index?: number;
  item?: CodexOutputItem;
  response?: CodexResponse;
}

interface GeminiCandidate {
  content: { parts: GeminiPart[]; role: string };
  finishReason: string;
  index: number;
}

interface GeminiGenerateContentResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

// ─── Reasoning effort ─────────────────────────────────────────────────────

/**
 * Maps Gemini's thinking budget onto the four effort levels the API accepts.
 *
 * The IDE does not always send a budget. Defaulting to 'medium' rather than the
 * API's own 'low' keeps an agentic coding turn usable — 'low' visibly degrades
 * multi-step tool use, which is the only thing this gateway is used for.
 */
function reasoningEffort(geminiBody: GeminiRequestBody): string {
  const budget = geminiBody.generationConfig?.thinkingConfig?.thinkingBudget;
  if (typeof budget !== 'number' || budget <= 0) return 'medium';
  if (budget <= 4096) return 'low';
  if (budget <= 16384) return 'medium';
  if (budget <= 32768) return 'high';
  return 'xhigh';
}

// ─── REQUEST: Gemini → Responses ──────────────────────────────────────────

/**
 * Flat tool schema. The chat/completions shape — `{type, function: {...}}` —
 * is rejected here, so the nesting is deliberately absent.
 */
function mapGeminiToolsToCodex(geminiTools: GeminiTool[]): CodexTool[] {
  if (!geminiTools || !Array.isArray(geminiTools)) return [];
  const tools: CodexTool[] = [];

  for (const toolGroup of geminiTools) {
    if (!toolGroup.functionDeclarations || !Array.isArray(toolGroup.functionDeclarations)) continue;
    for (const func of toolGroup.functionDeclarations) {
      const params = func.parameters
        ? (JSON.parse(JSON.stringify(func.parameters)) as Record<string, unknown>)
        : { type: 'object', properties: {} };
      if (typeof params.type === 'string') {
        (params as Record<string, string>).type = (params.type as string).toLowerCase();
      }
      if (params.properties) {
        fixParamTypes(params.properties as Record<string, unknown>);
      }
      tools.push({
        type: 'function',
        name: func.name,
        description: func.description || '',
        parameters: params,
      });
    }
  }
  return tools;
}

/** Reads a file:// part inline; anything else stays a reference. */
function describeFileData(fd: { mimeType: string; fileUri: string }): string {
  try {
    const url = new URL(fd.fileUri);
    if (url.protocol === 'file:') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs');
      const filePath = url.pathname.replace(/^\//, '').replace(/\//g, path.sep);
      return `[File content from ${fd.fileUri}]:\n${fs.readFileSync(filePath, 'utf-8')}`;
    }
  } catch {
    /* fall through to a reference */
  }
  return `[File reference: ${fd.fileUri} (${fd.mimeType})]`;
}

export function mapGeminiToCodex(geminiBody: GeminiRequestBody, modelName: string): CodexRequestBody {
  const input: CodexInputItem[] = [];

  for (const item of geminiBody.contents || []) {
    const parts = item.parts || [];
    if (parts.length === 0) continue;

    const hasFunctionCall = parts.some((p) => p.functionCall);
    const hasFunctionResponse = parts.some((p) => p.functionResponse);

    // A model turn that called tools. Sent back under the name the model itself
    // used: run_command rewritten to list_dir would otherwise reappear as a call
    // it never made, and the model re-issues it.
    if (hasFunctionCall && item.role === 'model') {
      for (const p of parts) {
        if (!p.functionCall) continue;
        const callId = p.functionCall.id || 'call_' + Math.random().toString(36).slice(2, 10);
        let originalName = p.functionCall.name;
        let originalArgs: unknown = p.functionCall.args;

        const translatedInfo = translatedToolCalls.get(callId);
        if (translatedInfo) {
          originalName = translatedInfo.originalName;
          originalArgs = { CommandLine: translatedInfo.cmd, Cwd: translatedInfo.cwd };
        }

        input.push({
          type: 'function_call',
          call_id: callId,
          name: originalName,
          arguments: typeof originalArgs === 'string' ? originalArgs : JSON.stringify(originalArgs || {}),
        });
      }
      continue;
    }

    if (hasFunctionResponse) {
      for (const p of parts) {
        if (!p.functionResponse) continue;
        const funcName = p.functionResponse.name || '';
        const modelTCIds = modelToolCallIds.get(modelName) || {};
        const callId = p.functionResponse.id || modelTCIds[funcName] || 'call_' + funcName;
        const responseData = p.functionResponse.response;

        const translatedInfo = translatedToolCalls.get(callId);
        const output = translatedInfo
          ? formatTranslatedResponse(translatedInfo, responseData)
          : typeof responseData === 'string'
            ? responseData
            : JSON.stringify(responseData || {});

        input.push({ type: 'function_call_output', call_id: callId, output });
      }
      continue;
    }

    if (item.role === 'model') {
      // Thought parts are dropped: the API has no input field for another
      // model's reasoning, and replaying it as assistant text makes the model
      // treat its own scratchpad as a committed answer.
      const text = parts
        .filter((p) => !p.thought)
        .map((p) => p.text || '')
        .join('');
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      continue;
    }

    // User turn: text and images each become their own content part. A data URI
    // inlined into text arrives as literal characters, which is why a model then
    // reports it cannot see the image.
    const content: CodexInputContent[] = [];
    const textChunks: string[] = [];
    const images: CodexInputContent[] = [];

    for (const p of parts) {
      if (p.text) {
        textChunks.push(p.text);
      } else if (p.fileData) {
        textChunks.push(describeFileData(p.fileData));
      } else if (p.inlineData) {
        const data = p.inlineData;
        if (data.mimeType && data.mimeType.startsWith('image/')) {
          log.info(`[Codex] image part -> ${data.mimeType}, base64 ${(data.data || '').length} chars`);
          images.push({ type: 'input_image', image_url: `data:${data.mimeType};base64,${data.data}` });
        } else {
          textChunks.push(`[Inline data: ${data.mimeType}, length: ${(data.data || '').length} chars]`);
        }
      }
    }

    const text = textChunks.join('\n');
    if (text) content.push({ type: 'input_text', text });
    content.push(...images);
    if (content.length > 0) input.push({ role: 'user', content });
  }

  const payload: CodexRequestBody = {
    model: modelName,
    input,
    reasoning: { effort: reasoningEffort(geminiBody) },
  };

  const instructions = (geminiBody.systemInstruction?.parts || []).map((p) => p.text || '').join('');
  if (instructions) payload.instructions = instructions;

  if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
    const tools = mapGeminiToolsToCodex(geminiBody.tools);
    if (tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }
  }

  return payload;
}

// ─── Tool call bookkeeping ────────────────────────────────────────────────

/**
 * Turns one `function_call` item into a Gemini functionCall part, recording the
 * id mapping and any native rewrite so the next turn can reverse both.
 */
function toFunctionCallPart(item: CodexOutputItem, modelName: string): GeminiPart {
  const callId = item.call_id || item.id || 'call_' + Math.random().toString(36).slice(2, 10);
  const name = item.name || '';

  let args: ToolCallArgs = {};
  try {
    args = item.arguments ? (JSON.parse(item.arguments) as ToolCallArgs) : {};
  } catch (e) {
    log.debug('[Codex] Tool call args parse fallback:', (e as Error).message);
    args = {};
  }
  args = normalizeToolArgs(name, args) as ToolCallArgs;

  const modelTCIds = modelToolCallIds.get(modelName) || {};
  modelTCIds[name] = callId;
  modelToolCallIds.set(modelName, modelTCIds);
  touchStateTimestamp(stateTimestamps.toolCallIds, modelName);

  const translated = translateToolCallToNative(name, args);
  if (translated.name !== name) {
    translated.args = normalizeToolArgs(translated.name, translated.args) as Record<string, unknown>;
    translatedToolCalls.set(callId, {
      originalName: name,
      translatedName: translated.name,
      cmd: args.CommandLine || '',
      cwd: args.Cwd || '',
    });
    touchStateTimestamp(stateTimestamps.translatedCalls, callId);
  }

  return { functionCall: { name: translated.name, args: translated.args as Record<string, unknown>, id: callId } };
}

// ─── RESPONSE: Responses → Gemini ─────────────────────────────────────────

export function mapCodexToGemini(codexRes: CodexResponse, modelName: string): GeminiGenerateContentResponse {
  const parts: GeminiPart[] = [];
  let sawToolCall = false;
  let reasoningText = '';

  for (const item of codexRes.output || []) {
    if (item.type === 'reasoning') {
      const summary = (item.summary || []).map((s) => s.text || '').join('');
      if (summary) {
        reasoningText += summary;
        parts.push({ text: summary, thought: true });
      }
    } else if (item.type === 'message') {
      const text = (item.content || [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text || '')
        .join('');
      if (text) parts.push({ text });
    } else if (item.type === 'function_call') {
      sawToolCall = true;
      parts.push(toFunctionCallPart(item, modelName));
    }
  }

  if (reasoningText) {
    modelReasoningContent.set(modelName, reasoningText);
    touchStateTimestamp(stateTimestamps.reasoning, modelName);
  }

  return {
    candidates: [
      {
        content: { parts, role: 'model' },
        finishReason: sawToolCall ? 'TOOL_CALL' : 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: codexRes.usage?.input_tokens || 0,
      candidatesTokenCount: codexRes.usage?.output_tokens || 0,
      totalTokenCount: codexRes.usage?.total_tokens || 0,
    },
  };
}

// ─── STREAM CHUNK: Responses → Gemini ─────────────────────────────────────

/**
 * Each SSE frame names itself in `type`, so this dispatches on that rather than
 * on position. The proxy's SSE reader only forwards `data:` lines — the
 * accompanying `event:` line is dropped before we see it, which is why the
 * `type` field is the only thing worth keying on.
 *
 * Tool calls are emitted from `response.output_item.done` rather than assembled
 * from the argument deltas: that event carries the complete arguments string and
 * the real `call_id` (the deltas carry only an internal `item_id`, which is a
 * different value and cannot be echoed back as a call_id).
 */
export function mapCodexChunkToGemini(chunk: CodexStreamEvent, modelName: string): GeminiCandidate | null {
  const type = chunk.type;
  if (!type) return null;

  switch (type) {
    case 'response.output_text.delta': {
      const text = chunk.delta || '';
      if (!text) return null;
      return { content: { parts: [{ text }], role: 'model' }, finishReason: 'OTHER', index: 0 };
    }

    // Reasoning summaries arrive under two names depending on how the upstream
    // model was configured. Both are the model thinking out loud.
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      const text = chunk.delta || '';
      if (!text) return null;
      const streamId = chunk.item_id || 'default_stream';
      if (!activeStreamContexts.has(streamId)) {
        activeStreamContexts.set(streamId, { accumulatedText: '', accumulatedReasoning: '', toolCalls: {} });
        touchStateTimestamp(stateTimestamps.streamCtx, streamId);
      }
      activeStreamContexts.get(streamId)!.accumulatedReasoning += text;
      return { content: { parts: [{ text, thought: true }], role: 'model' }, finishReason: 'OTHER', index: 0 };
    }

    case 'response.output_item.done': {
      const item = chunk.item;
      if (!item || item.type !== 'function_call') return null;
      return {
        content: { parts: [toFunctionCallPart(item, modelName)], role: 'model' },
        finishReason: 'TOOL_CALL',
        index: 0,
      };
    }

    case 'response.completed': {
      // The proxy writes its own terminal STOP frame once the socket ends, so
      // nothing is emitted here — this only releases the per-stream state.
      const reasoning = activeStreamContexts.get(chunk.response?.id || '')?.accumulatedReasoning;
      if (reasoning) {
        modelReasoningContent.set(modelName, reasoning);
        touchStateTimestamp(stateTimestamps.reasoning, modelName);
      }
      if (chunk.response?.id) {
        activeStreamContexts.delete(chunk.response.id);
        stateTimestamps.streamCtx.delete(chunk.response.id);
      }
      return null;
    }

    case 'response.failed':
    case 'response.incomplete': {
      log.warn(`[Codex] Upstream reported ${type} for ${modelName}`);
      return null;
    }

    // created / in_progress / content_part.* / function_call_arguments.delta —
    // all superseded by the events above.
    default:
      return null;
  }
}

export { mapGeminiToolsToCodex };
