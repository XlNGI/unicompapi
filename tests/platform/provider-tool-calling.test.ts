import { describe, expect, it } from 'vitest';
import {
  canonicalToolInputSchema,
  createCanonicalToolRegistry,
  deriveAvailableToolSet
} from '../../src/domain/entities/canonical-tool-contract';
import {
  assembleControlledToolCalls,
  parseControlledProviderTools,
  parseControlledToolCallDeltas,
  providerToolsFromContracts,
  runControlledProviderToolLoop,
  sanitizeControlledToolResult
} from '../../src/platform/providers/provider-tool-calling';

const registry = createCanonicalToolRegistry();
const readContract = registry.get('read_document_structure')!;
const readParameters = canonicalToolInputSchema(readContract);
const readTool = () => providerToolsFromContracts([readContract])[0]!;

describe('controlled provider tool calling', () => {
  it('projects the canonical definition and rejects duplicate or unsafe names', () => {
    const tools = parseControlledProviderTools([readTool()]);
    expect(tools?.[0]?.function.name).toBe(readContract.toolId);
    expect(tools?.[0]?.function.requiresExistingDocument).toBe(true);
    expect(tools?.[0]?.function.description).toBe(readContract.description);
    expect(tools?.[0]?.function.parameters).toEqual(readParameters);
    expect(() => parseControlledProviderTools([readTool(), readTool()])).toThrow();
    expect(() => parseControlledProviderTools([{ type: 'function', function: { name: 'run_shell', parameters: {} } }])).toThrow();
    expect(() => providerToolsFromContracts([readContract, readContract])).toThrow();
  });

  it('projects only the Runtime-selected Available Tool Set, not all registered tools', () => {
    const context = {
      operation: 'analyze' as const,
      currentDocumentIR: { operation: 'analyze' as const, attachmentRefs: [] },
      revision: 1,
      capabilities: [readContract.toolId],
      implementedToolIds: [readContract.toolId],
      authorization: { canRead: true, canWrite: false, allowedToolIds: [readContract.toolId] }
    };
    expect(registry.has(readContract.toolId)).toBe(true);
    expect(providerToolsFromContracts(deriveAvailableToolSet(registry, context))).toEqual([]);
    expect(parseControlledProviderTools(providerToolsFromContracts(deriveAvailableToolSet(registry, context)))).toBeUndefined();
    expect(providerToolsFromContracts(deriveAvailableToolSet(registry, {
      ...context, currentDocumentId: 'current-presentation'
    }))).toEqual([readTool()]);
    expect(providerToolsFromContracts(deriveAvailableToolSet(registry, {
      ...context, currentDocumentId: 'current-presentation',
      authorization: { ...context.authorization, allowedToolIds: [] }
    }))).toEqual([]);
  });

  it('does not expose contracts with no migrated provider argument schema', () => {
    const internalContract = registry.get('apply_document_patch')!;
    expect(internalContract.exposure).toBe('internal');
    expect(() => providerToolsFromContracts([internalContract])).toThrow();
    expect(() => parseControlledProviderTools([{
      type: 'function', function: {
        name: internalContract.toolId, parameters: canonicalToolInputSchema(internalContract)
      }
    }])).toThrow();
  });

  it.each([
    ['field name', (parameters: Record<string, unknown>) => ({
      ...parameters, properties: { documentRef: { type: 'string' } }
    })],
    ['type', (parameters: Record<string, unknown>) => ({
      ...parameters, properties: { ...(parameters.properties as Record<string, unknown>), scope: { type: 'integer' } }
    })],
    ['required', (parameters: Record<string, unknown>) => ({ ...parameters, required: ['scope'] })],
    ['enum', (parameters: Record<string, unknown>) => ({
      ...parameters, properties: { ...(parameters.properties as Record<string, unknown>), scope: { type: 'string', enum: ['sheet'] } }
    })],
    ['default', (parameters: Record<string, unknown>) => ({
      ...parameters, properties: {
        ...(parameters.properties as Record<string, unknown>),
        scope: { ...((parameters.properties as Record<string, unknown>).scope as Record<string, unknown>), default: 'section' }
      }
    })],
    ['additional properties', (parameters: Record<string, unknown>) => ({ ...parameters, additionalProperties: true })],
    ['conditional required', (parameters: Record<string, unknown>) => ({ ...parameters, allOf: [] })]
  ])('rejects %s schema drift before a provider request', (_label, change) => {
    const canonical = readTool();
    expect(() => parseControlledProviderTools([{
      ...canonical, function: { ...canonical.function, parameters: change(structuredClone(readParameters)) }
    }])).toThrow('parameters');
  });

  it('rejects metadata drift and derives omitted metadata from the contract', () => {
    const canonical = readTool();
    expect(() => parseControlledProviderTools([{
      ...canonical, function: { ...canonical.function, requiresExistingDocument: false }
    }])).toThrow('prerequisite');
    expect(() => parseControlledProviderTools([{
      ...canonical, function: { ...canonical.function, description: 'Free-form replacement description' }
    }])).toThrow('description');
    expect(parseControlledProviderTools([{
      type: 'function', function: { name: readContract.toolId, parameters: readParameters }
    }])).toEqual([canonical]);
  });

  it('compares JSON objects independently of property order and excludes Runtime context', () => {
    const canonical = readTool();
    const reversed = Object.fromEntries(Object.entries(readParameters).reverse());
    expect(parseControlledProviderTools([{
      ...canonical, function: { ...canonical.function, parameters: reversed }
    }])).toEqual([canonical]);
    for (const key of ['currentDocumentId', 'documentRef', 'relativePath', 'rootDirectory', 'revision', 'authorization', 'abortSignal', 'taskContext']) {
      expect(readParameters.properties).not.toHaveProperty(key);
    }
    expect(() => parseControlledProviderTools([{
      ...canonical, function: { ...canonical.function, rootDirectory: 'private' }
    }])).toThrow();
  });

  it('preserves canonical document sections, nested blocks and text through the Provider result boundary', () => {
    const text = 'A'.repeat(1_200);
    const sections = Array.from({ length: 65 }, (_, index) => ({
      sectionId: `section-${index + 1}`, heading: 'Heading', blockCount: 1,
      blocks: [{ blockId: `block-${index + 1}`, kind: 'text', text: index === 0 ? text : 'Content' }]
    }));
    const result = {
      schemaVersion: 1, status: 'success', observation: { scope: 'document', sections },
      metadata: { toolId: readContract.toolId, toolVersion: readContract.version }
    };
    expect(sanitizeControlledToolResult(result)).toEqual(result);
  });

  it('redacts Runtime context, paths and credentials from validated nested document observations', () => {
    const result = sanitizeControlledToolResult({
      schemaVersion: 1, status: 'success', metadata: { toolId: readContract.toolId },
      observation: {
        currentDocumentId: 'host-document', currentDocumentIR: { title: 'host-state' },
        projectContext: { projectId: 'host-project' }, authorization: { canRead: true },
        taskContext: { taskId: 'host-task' }, rootDirectory: 'C:\\private', revision: 3,
        sections: [{ sectionId: 'section-1', blocks: [{
          blockId: 'block-1', filePath: 'C:\\private\\document.pptx', apiKey: 'synthetic-credential',
          text: 'Read C:\\private\\document.pptx with password=synthetic-password'
        }] }]
      }
    });
    expect(result).toEqual({
      schemaVersion: 1, status: 'success', metadata: { toolId: readContract.toolId },
      observation: { revision: 3, sections: [{ sectionId: 'section-1', blocks: [{
        blockId: 'block-1', text: 'Read [redacted] with [redacted]'
      }] }] }
    });
  });

  it('rejects invalid canonical envelopes and payload limits instead of silently trimming them', () => {
    const canonical = { schemaVersion: 1, status: 'success', metadata: { toolId: readContract.toolId } };
    expect(() => sanitizeControlledToolResult({ ...canonical, status: 'unrecognized' })).toThrow('invalid_tool_result');
    expect(() => sanitizeControlledToolResult({ ...canonical, extra: true })).toThrow('invalid_tool_result');
    expect(() => sanitizeControlledToolResult({ ...canonical, observation: { sections: Array(129).fill({}) } })).toThrow('invalid_tool_result');
    expect(() => sanitizeControlledToolResult({ ...canonical, observation: { text: 'A'.repeat(8_001) } })).toThrow('invalid_tool_result');
    const nested = Array.from({ length: 9 }).reduce<unknown>(value => ({ nested: value }), 'text');
    expect(() => sanitizeControlledToolResult({ ...canonical, observation: { nested } })).toThrow('invalid_tool_result');
    expect(() => sanitizeControlledToolResult({ ...canonical, observation: { text: 'A'.repeat(32_000) } })).toThrow('too large');
  });

  it('keeps the previous limits for generic results without a canonical tool identity', () => {
    const result = sanitizeControlledToolResult({
      observation: { text: 'A'.repeat(1_200), sections: Array.from({ length: 65 }, () => ({ blocks: [{ text: 'Content' }] })) }
    });
    expect(result).toEqual({
      observation: { text: 'A'.repeat(1_000), sections: Array.from({ length: 64 }, () => ({ blocks: [] })) }
    });
  });

  it('validates tool-call deltas without exposing arbitrary payloads', () => {
    expect(parseControlledToolCallDeltas([{
      index: 0,
      id: 'call-1',
      function: { name: 'apply_document_patch', arguments: '{"operation":"clear_section"}' }
    }])).toEqual([{
      index: 0,
      id: 'call-1',
      name: 'apply_document_patch',
      argumentsDelta: '{"operation":"clear_section"}'
    }]);
    expect(() => parseControlledToolCallDeltas([{
      index: 0,
      function: { name: 'run_shell', arguments: '{}' }
    }])).toThrow();
  });

  it('rejects duplicate call IDs across different indexes in one assistant message', () => {
    expect(() => assembleControlledToolCalls([
      { index: 0, id: 'duplicated-call', name: readContract.toolId, argumentsDelta: '{"scope":"page","ordinal":1}' },
      { index: 1, id: 'duplicated-call', name: readContract.toolId, argumentsDelta: '{"scope":"page","ordinal":2}' }
    ])).toThrow('IDs are not unique');
    const call = [{ index: 0, id: 'replay-across-messages', name: readContract.toolId, argumentsDelta: '{}' }];
    expect(assembleControlledToolCalls(call)).toEqual(assembleControlledToolCalls(call));
  });

  it('accepts an empty streamed arguments delta before the JSON chunks', () => {
    expect(assembleControlledToolCalls([
      ...parseControlledToolCallDeltas([{ index: 0, id: 'empty-arguments-prefix', type: 'function',
        function: { name: readContract.toolId, arguments: '' } }]),
      ...parseControlledToolCallDeltas([{ index: 0, function: { arguments: '{"scope":"page","ordinal":2}' } }])
    ])).toEqual([{
      id: 'empty-arguments-prefix',
      name: readContract.toolId,
      arguments: { scope: 'page', ordinal: 2 }
    }]);
    expect(() => assembleControlledToolCalls([
      { index: 0, id: 'empty-arguments-only', name: readContract.toolId, argumentsDelta: '' }
    ])).toThrow();
    for (const argumentsDelta of [null, 2, {}, String.fromCharCode(0), 'x'.repeat(8001)]) {
      expect(() => parseControlledToolCallDeltas([{ index: 0, function: { arguments: argumentsDelta } }])).toThrow();
    }
  });

  it('assembles streamed deltas and performs one bounded tool round', async () => {
    const calls = assembleControlledToolCalls([
      { index: 0, id: 'call-1', name: 'inspect_layout', argumentsDelta: '{"kind":"ppt"}' }
    ]);
    expect(calls[0]).toMatchObject({ id: 'call-1', name: 'inspect_layout', arguments: { kind: 'ppt' } });
    let round = 0;
    const result = await runControlledProviderToolLoop({
      messages: [{ role: 'user', content: 'inspect' }],
      request: async () => {
        round += 1;
        return round === 1
          ? { finishReason: 'tool_calls' as const, toolCalls: calls }
          : { finishReason: 'stop' as const, content: 'done' };
      },
      bridge: { execute: async ({ call }) => ({ schemaVersion: 1, status: 'success', observation: { operation: call.name } }) }
    });
    expect(result.content).toBe('done');
    expect(result.messages.at(-2)).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'call-1', name: 'inspect_layout' }]
    });
    expect(result.messages.at(-1)?.role).toBe('tool');
  });
});
