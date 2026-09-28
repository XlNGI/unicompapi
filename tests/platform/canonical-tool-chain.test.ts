import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCanonicalToolRegistry, canonicalToolInputSchema, validateCanonicalToolArguments,
  type ToolExecutionContext } from '../../src/domain/entities/canonical-tool-contract';
import { createDocumentToolRegistry, type DocumentIR } from '../../src/domain/entities/document-agent';
import { createReadDocumentStructureBinding } from '../../src/application/read-document-structure-tool';
import { createDocumentToolCallingBridge } from '../../src/platform/providers/document-tool-bridge';
import { parseControlledProviderTools, runControlledProviderToolLoop } from '../../src/platform/providers/provider-tool-calling';
import { DocumentTaskRuntimeService } from '../../src/application/document-task-runtime-service';
import { JsonDocumentTaskRuntimeRepository } from '../../src/platform/repositories/json-document-task-runtime-repository';
import { NodeProjectStorage } from '../../src/platform/storage/node-project-storage';
import { getProductionTraceStore, withProductionTrace } from '../../src/platform/conversation-production-trace';
import { toProjectId, toConversationId, toDocumentTaskRuntimeId, toMessageId } from '../../src/domain/ids';
import { readDocumentToolContext } from '../fixtures/document-tool-context';

const registry = createCanonicalToolRegistry();
const contract = registry.get('read_document_structure')!;
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function context(): ToolExecutionContext {
  return { ...readDocumentToolContext(), currentDocumentIR: {
    operation: 'analyze', attachmentRefs: [], documentRef: 'document-current',
    content: { title: '季度汇报', sourceRefs: [], styleConstraints: [], pageCount: 5,
      sections: [
        { sectionId: 'overview', heading: '本季度结论', preserve: [], blocks: [
          { blockId: 'result', kind: 'text', content: '样例结论，仅用于本地合同验证。', sourceRefs: [] }
        ] },
        { sectionId: 'next', heading: '下季度计划', preserve: [], blocks: [] }
      ] }
  } };
}
function bridge(host: ToolExecutionContext, readPage?: NonNullable<Parameters<typeof createReadDocumentStructureBinding>[0]>['readPage']) {
  return createDocumentToolCallingBridge({ bindings: [createReadDocumentStructureBinding({ registry, readPage })],
    registry, getExecutionContext: () => host, budgetUnits: 16, maxCalls: 8, timeoutMs: 30_000 });
}

describe('canonical read tool chain', () => {
  it.each(['analyze', 'create'] as const)('uses one contract through Registry, schema, real binding, checkpoint and Trace for %s', async operation => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-canonical-chain-'));
    roots.push(rootDirectory);
    const projectId = toProjectId('project-current');
    const conversationId = toConversationId('conversation-chain');
    const storage = new NodeProjectStorage(rootDirectory);
    const repository = new JsonDocumentTaskRuntimeRepository(storage, projectId);
    const service = new DocumentTaskRuntimeService(repository, { validateBindings: async () => true });
    const runtime = await service.create({ id: toDocumentTaskRuntimeId('runtime-chain'), projectId, conversationId,
      sourceMessageId: toMessageId('message-chain'), executionId: 'execution-chain', documentKind: 'ppt',
      operation, budget: { maxSteps: 8, budgetUnits: 16, timeoutMs: 120_000 } });
    const original = context();
    const host = { ...original, operation, currentDocumentIR: { operation, attachmentRefs: [], content: original.currentDocumentIR!.content } };
    const before = JSON.stringify(host.currentDocumentIR);
    const bound = createReadDocumentStructureBinding({ registry });
    const execute = vi.fn(bound.execute);
    const current = createDocumentToolCallingBridge({ bindings: [{ ...bound, execute }], registry,
      getExecutionContext: () => host, budgetUnits: 16, maxCalls: 8, timeoutMs: 30_000,
      runtime: { service, scope: runtime } });
    expect(current.tools).toHaveLength(1);
    expect(parseControlledProviderTools(current.tools)?.[0].function.parameters).toEqual(canonicalToolInputSchema(contract));
    expect(validateCanonicalToolArguments(contract, {})).toEqual({ scope: 'document' });
    expect(createDocumentToolRegistry().get(contract.toolId)).toMatchObject({ id: contract.toolId,
      version: contract.version, maxCostUnits: contract.execution.budgetUnits, requiresWrite: contract.preconditions.requiresWrite });
    const traceScope = { rootDirectory, projectId, conversationId, sourceMessageId: 'message-chain', traceId: 'message-chain' };
    let step = 0;
    const request = vi.fn(async (messages: Parameters<Parameters<typeof runControlledProviderToolLoop>[0]['request']>[0]) => {
      if (step++ === 0) return { finishReason: 'tool_calls' as const, toolCalls: [
        { id: 'read-current', name: contract.toolId, arguments: {} }
      ] };
      const returned = JSON.parse(messages.at(-1)!.content);
      expect(returned).toMatchObject({ status: 'success', observation: { title: '季度汇报', totalSections: 2,
        sections: [{ heading: '本季度结论', blocks: [{ blockId: 'result', text: '样例结论，仅用于本地合同验证。' }] }, { heading: '下季度计划' }] } });
      expect(messages.at(-1)?.toolCallId).toBe('read-current');
      expect(messages.at(-1)!.content).not.toContain('document-current');
      return { finishReason: 'stop' as const, content: '结构已读取' };
    });
    await withProductionTrace(traceScope, () => runControlledProviderToolLoop({ messages: [
      { role: 'user', content: '查询当前文档结构' }
    ], request, bridge: current.bridge }));
    expect(execute).toHaveBeenCalledWith({ scope: 'document' }, expect.objectContaining({
      currentDocumentId: host.currentDocumentId, revision: host.revision, currentDocumentIR: host.currentDocumentIR
    }));
    expect(JSON.stringify(host.currentDocumentIR)).toBe(before);
    const persisted = await repository.get(runtime.id);
    expect(persisted).toMatchObject({ checkpoint: { step: 1, costUnits: contract.execution.budgetUnits },
      toolCalls: [{ toolId: contract.toolId, status: 'completed' }], observations: [{ ok: true, data: { totalSections: 2 } }] });
    expect(JSON.stringify(persisted)).not.toContain('样例结论');
    const events = await getProductionTraceStore(traceScope).list({ conversationId });
    expect(events.map(event => [event.code, event.status, event.facts?.tool])).toEqual([
      ['tool_authorization', 'completed', contract.diagnostics.traceType],
      ['tool_call', 'started', contract.diagnostics.traceType],
      ['tool_result', 'completed', contract.diagnostics.traceType]
    ]);
    expect(JSON.stringify(events)).not.toContain(rootDirectory);
  });

  it('reads a section of the Runtime-selected IR and rejects a nonexistent target', async () => {
    const current = bridge(context());
    expect(await current.bridge.execute({ call: { id: 'section', name: contract.toolId, arguments: { scope: 'section', ordinal: 2 } },
      signal: new AbortController().signal })).toMatchObject({ status: 'success', observation: { sections: [{ sectionId: 'next' }] } });
    expect(await current.bridge.execute({ call: { id: 'missing', name: contract.toolId, arguments: { scope: 'section', ordinal: 3 } },
      signal: new AbortController().signal })).toMatchObject({ status: 'failed', diagnostics: [{ code: 'target_not_found' }] });
  });

  it('never invents physical pages from section numbers', async () => {
    const host = context();
    const args = { scope: 'page', ordinal: 3 };
    expect(await bridge(host).bridge.execute({ call: { id: 'page', name: contract.toolId, arguments: args }, signal: host.abortSignal }))
      .toMatchObject({ status: 'failed', diagnostics: [{ code: 'page_scope_unavailable' }] });
    const readPage = vi.fn(async () => ({ pageNumber: 3, heading: '真实第3页' }));
    expect(await bridge(host, readPage).bridge.execute({ call: { id: 'page', name: contract.toolId, arguments: args }, signal: host.abortSignal }))
      .toMatchObject({ status: 'success', observation: { page: { pageNumber: 3, heading: '真实第3页' } } });
    expect(readPage).toHaveBeenCalledWith(3, expect.objectContaining({ currentDocumentId: host.currentDocumentId }));
  });

  it('supports a bound new empty IR without opening any file', async () => {
    const ir: DocumentIR = { operation: 'create', attachmentRefs: [] };
    const host = { ...context(), operation: 'create' as const, currentDocumentIR: ir };
    expect(await bridge(host).bridge.execute({ call: { id: 'empty', name: contract.toolId, arguments: {} }, signal: host.abortSignal }))
      .toMatchObject({ status: 'success', observation: { totalSections: 0, sections: [] } });
  });

  it('honors the absolute task deadline even when per-tool timeout has time left', async () => {
    vi.useFakeTimers();
    const host = context();
    const controller = new AbortController();
    const bound = createReadDocumentStructureBinding();
    const current = createDocumentToolCallingBridge({
      bindings: [{ ...bound, execute: () => new Promise(() => undefined) }],
      getExecutionContext: () => ({ ...host, taskContext: { ...host.taskContext, deadlineAt: Date.now() + 10 } }),
      budgetUnits: 16, maxCalls: 8, timeoutMs: 30_000
    });
    const result = current.bridge.execute({ call: { id: 'deadline', name: contract.toolId, arguments: {} }, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toMatchObject({ status: 'failed', diagnostics: [{ code: 'tool_timeout' }] });
    expect(current.tools).toEqual([]);
  });
});
