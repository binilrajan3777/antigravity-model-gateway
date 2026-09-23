/**
 * Unit tests for the Responses API translator (codex.ts).
 *
 * The request/response shapes asserted here were captured from live calls to
 * https://api.kie.ai/codex/v1/responses with model gpt-6-astra.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as shared from '../proxy/shared';
import { mapGeminiToCodex, mapCodexToGemini, mapCodexChunkToGemini } from '../proxy/translators/codex';

beforeEach(() => {
  shared.modelToolCallIds.clear();
  shared.modelReasoningContent.clear();
  shared.activeStreamContexts.clear();
  shared.translatedToolCalls.clear();
  shared.stateTimestamps.toolCallIds.clear();
  shared.stateTimestamps.reasoning.clear();
  shared.stateTimestamps.streamCtx.clear();
  shared.stateTimestamps.translatedCalls.clear();
});

// ─── mapGeminiToCodex ──────────────────────────────────────────────────────

describe('mapGeminiToCodex', () => {
  it('sends the system prompt as top-level instructions, not a message', () => {
    const result = mapGeminiToCodex(
      { systemInstruction: { parts: [{ text: 'You are helpful.' }] }, contents: [] },
      'gpt-6-astra',
    );
    expect(result.instructions).toBe('You are helpful.');
    expect(result.input).toEqual([]);
  });

  it('omits instructions entirely when there is no system prompt', () => {
    const result = mapGeminiToCodex({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, 'gpt-6-astra');
    expect(result).not.toHaveProperty('instructions');
  });

  it('wraps user text in an input_text content part', () => {
    const result = mapGeminiToCodex({ contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] }, 'gpt-6-astra');
    expect(result.input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] });
  });

  it('maps a model turn to an assistant turn using output_text', () => {
    const result = mapGeminiToCodex({ contents: [{ role: 'model', parts: [{ text: 'Hi there' }] }] }, 'gpt-6-astra');
    expect(result.input[0]).toEqual({ role: 'assistant', content: [{ type: 'output_text', text: 'Hi there' }] });
  });

  it('drops thought parts from assistant history', () => {
    const result = mapGeminiToCodex(
      { contents: [{ role: 'model', parts: [{ text: 'reasoning...', thought: true }, { text: 'answer' }] }] },
      'gpt-6-astra',
    );
    expect(result.input[0]).toEqual({ role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] });
  });

  it('emits images as their own input_image part alongside the text', () => {
    const result = mapGeminiToCodex(
      {
        contents: [
          { role: 'user', parts: [{ text: 'What is this?' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
        ],
      },
      'gpt-6-astra',
    );
    expect(result.input[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'What is this?' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ],
    });
  });

  it('emits function calls as top-level items, not assistant messages', () => {
    const result = mapGeminiToCodex(
      {
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'view_file', args: { AbsolutePath: '/a.ts' }, id: 'call_1' } }] },
        ],
      },
      'gpt-6-astra',
    );
    expect(result.input[0]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'view_file',
      arguments: '{"AbsolutePath":"/a.ts"}',
    });
  });

  it('emits tool results as function_call_output keyed by call_id', () => {
    const result = mapGeminiToCodex(
      {
        contents: [
          { role: 'user', parts: [{ functionResponse: { name: 'view_file', response: 'file body', id: 'call_1' } }] },
        ],
      },
      'gpt-6-astra',
    );
    expect(result.input[0]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'file body' });
  });

  it('recovers a missing call_id from the recorded tool-call ids', () => {
    shared.modelToolCallIds.set('gpt-6-astra', { view_file: 'call_remembered' });
    const result = mapGeminiToCodex(
      { contents: [{ role: 'user', parts: [{ functionResponse: { name: 'view_file', response: 'x' } }] }] },
      'gpt-6-astra',
    );
    expect((result.input[0] as { call_id: string }).call_id).toBe('call_remembered');
  });

  it('replays a natively-rewritten call under the name the model actually used', () => {
    // run_command → list_dir is rewritten on the way out; sending the rewritten
    // name back would show the model a call it never made.
    shared.translatedToolCalls.set('call_9', {
      originalName: 'run_command',
      translatedName: 'list_dir',
      cmd: 'ls /tmp',
      cwd: '/tmp',
    });
    const result = mapGeminiToCodex(
      {
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'list_dir', args: { DirectoryPath: '/tmp' }, id: 'call_9' } }] },
        ],
      },
      'gpt-6-astra',
    );
    expect(result.input[0]).toEqual({
      type: 'function_call',
      call_id: 'call_9',
      name: 'run_command',
      arguments: '{"CommandLine":"ls /tmp","Cwd":"/tmp"}',
    });
  });

  it('uses the flat tool schema the endpoint requires, not the nested one', () => {
    const result = mapGeminiToCodex(
      {
        contents: [],
        tools: [
          {
            functionDeclarations: [
              { name: 'get_weather', description: 'Get weather', parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } } } },
            ],
          },
        ],
      },
      'gpt-6-astra',
    );
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
    expect(result.tools![0]).not.toHaveProperty('function');
    expect(result.tool_choice).toBe('auto');
  });

  it('omits tools and tool_choice when none are declared', () => {
    const result = mapGeminiToCodex({ contents: [] }, 'gpt-6-astra');
    expect(result).not.toHaveProperty('tools');
    expect(result).not.toHaveProperty('tool_choice');
  });

  it('defaults reasoning effort to medium and scales it with the thinking budget', () => {
    expect(mapGeminiToCodex({ contents: [] }, 'm').reasoning).toEqual({ effort: 'medium' });
    const withBudget = (thinkingBudget: number): string =>
      mapGeminiToCodex({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget } } }, 'm').reasoning!.effort;
    expect(withBudget(1024)).toBe('low');
    expect(withBudget(8192)).toBe('medium');
    expect(withBudget(32768)).toBe('high');
    expect(withBudget(100000)).toBe('xhigh');
  });
});

// ─── mapCodexToGemini ──────────────────────────────────────────────────────

describe('mapCodexToGemini', () => {
  it('reads assistant text out of the output array', () => {
    const result = mapCodexToGemini(
      {
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      'models/gpt-6-astra',
    );
    expect(result.candidates[0].content.parts).toEqual([{ text: 'OK' }]);
    expect(result.candidates[0].finishReason).toBe('STOP');
    expect(result.usageMetadata).toEqual({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 });
  });

  it('maps a function_call item to a Gemini functionCall with TOOL_CALL', () => {
    const result = mapCodexToGemini(
      {
        output: [
          { type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
      },
      'models/gpt-6-astra',
    );
    expect(result.candidates[0].finishReason).toBe('TOOL_CALL');
    expect(result.candidates[0].content.parts[0].functionCall).toEqual({
      name: 'get_weather',
      args: { city: 'Paris' },
      id: 'call_abc',
    });
  });

  it('records the call id so the next turn can pair the tool result', () => {
    mapCodexToGemini(
      { output: [{ type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '{}' }] },
      'models/gpt-6-astra',
    );
    expect(shared.modelToolCallIds.get('models/gpt-6-astra')).toEqual({ get_weather: 'call_abc' });
  });

  it('surfaces reasoning summaries as thought parts', () => {
    const result = mapCodexToGemini(
      {
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
        ],
      },
      'models/gpt-6-astra',
    );
    expect(result.candidates[0].content.parts).toEqual([{ text: 'thinking', thought: true }, { text: 'done' }]);
    expect(shared.modelReasoningContent.get('models/gpt-6-astra')).toBe('thinking');
  });

  it('survives malformed tool arguments rather than throwing', () => {
    const result = mapCodexToGemini(
      { output: [{ type: 'function_call', call_id: 'c1', name: 'noop', arguments: '{not json' }] },
      'models/gpt-6-astra',
    );
    expect(result.candidates[0].content.parts[0].functionCall!.args).toEqual({});
  });

  it('returns an empty candidate for an empty output array', () => {
    const result = mapCodexToGemini({ output: [] }, 'models/gpt-6-astra');
    expect(result.candidates[0].content.parts).toEqual([]);
    expect(result.candidates[0].finishReason).toBe('STOP');
  });
});

// ─── mapCodexChunkToGemini ─────────────────────────────────────────────────

describe('mapCodexChunkToGemini', () => {
  it('maps a text delta to a text part', () => {
    const result = mapCodexChunkToGemini(
      { type: 'response.output_text.delta', delta: 'Hello', item_id: 'msg_1' },
      'models/gpt-6-astra',
    );
    expect(result).toEqual({ content: { parts: [{ text: 'Hello' }], role: 'model' }, finishReason: 'OTHER', index: 0 });
  });

  it('maps a reasoning delta to a thought part', () => {
    const result = mapCodexChunkToGemini(
      { type: 'response.reasoning_summary_text.delta', delta: 'hmm', item_id: 'rs_1' },
      'models/gpt-6-astra',
    );
    expect(result!.content.parts).toEqual([{ text: 'hmm', thought: true }]);
  });

  it('ignores argument deltas — the completed item carries the real call_id', () => {
    const result = mapCodexChunkToGemini(
      { type: 'response.function_call_arguments.delta', delta: '{"ci', item_id: 'fc_1' },
      'models/gpt-6-astra',
    );
    expect(result).toBeNull();
  });

  it('emits the tool call from output_item.done using call_id, not item_id', () => {
    const result = mapCodexChunkToGemini(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_internal',
          type: 'function_call',
          call_id: 'call_real',
          name: 'get_weather',
          arguments: '{"city":"Paris"}',
        },
      },
      'models/gpt-6-astra',
    );
    expect(result!.finishReason).toBe('TOOL_CALL');
    expect(result!.content.parts[0].functionCall).toEqual({
      name: 'get_weather',
      args: { city: 'Paris' },
      id: 'call_real',
    });
  });

  it('ignores output_item.done for a plain message (text already streamed)', () => {
    const result = mapCodexChunkToGemini(
      {
        type: 'response.output_item.done',
        item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'full text' }] },
      },
      'models/gpt-6-astra',
    );
    expect(result).toBeNull();
  });

  it('ignores lifecycle events the proxy already handles', () => {
    for (const type of ['response.created', 'response.in_progress', 'response.content_part.added']) {
      expect(mapCodexChunkToGemini({ type }, 'models/gpt-6-astra')).toBeNull();
    }
  });

  it('releases per-stream state on response.completed', () => {
    mapCodexChunkToGemini(
      { type: 'response.reasoning_summary_text.delta', delta: 'abc', item_id: 'resp_1' },
      'models/gpt-6-astra',
    );
    expect(shared.activeStreamContexts.has('resp_1')).toBe(true);

    const result = mapCodexChunkToGemini(
      { type: 'response.completed', response: { id: 'resp_1', usage: { total_tokens: 5 } } },
      'models/gpt-6-astra',
    );
    expect(result).toBeNull();
    expect(shared.activeStreamContexts.has('resp_1')).toBe(false);
    expect(shared.modelReasoningContent.get('models/gpt-6-astra')).toBe('abc');
  });

  it('returns null for an event with no type', () => {
    expect(mapCodexChunkToGemini({ delta: 'x' }, 'models/gpt-6-astra')).toBeNull();
  });
});
