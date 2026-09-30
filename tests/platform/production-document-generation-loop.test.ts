import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectConversation, createProvider, createProviderConnection, createProviderModel, createProviderProtocolBinding,
  toConnectionId, toConversationId, toIsoTimestamp, toModelId, toProjectId, toProtocolBindingId, toProviderId
} from '../../src/domain';
import { canonicalToolInputSchema, createCanonicalToolRegistry } from '../../src/domain/entities/canonical-tool-contract';
import {
  createChatContextRuntime, createOpenAiCompatibleDefaultTextDefinition, DeepSeekSharedRuntime, NewApiSharedRuntime,
  JsonProviderRegistryStore, RuntimeAuthorizationLedger, JsonRuntimeAuthorizationLedgerStore, SecureCredentialVault,
  NodeProjectStorage, JsonFileReferenceRepository, JsonWorkRepository, JsonProjectConversationRepository,
  JsonDocumentTaskRuntimeRepository, DocumentGenerationRunner, NEWAPI_PROVIDER_PACKAGE_ID, NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_COMPATIBLE_TEMPLATE_ID, NEWAPI_CREDENTIAL_SCHEMA_ID, NEWAPI_ENDPOINT_POLICY_ID, NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_ADAPTER_VERSION, NEWAPI_CHAT_PROTOCOL_ID, NEWAPI_PROTOCOL_VERSION, type NewApiHttpTransportResponse
} from '../../src/platform';
import { ConversationProductionTraceStore } from '../../src/platform/conversation-production-trace';
import { PlatformDocumentDraftCompiler, PlatformDocumentGenerationExecutor } from '../../src/platform/documents/document-generation-application-adapters';
import { buildFallbackPresentationDesignIR, parseArtDirection } from '../../src/domain/entities/presentation-design-contract';
import { generateTemporaryDocumentFile, type GenerateDocumentFileInput } from '../../src/platform/documents/office-document-generator';
import type { PresentationDesignCompilationSnapshot } from '../../src/platform/documents/presentation-design-compiler';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { readPptxDocument } from '../../src/platform/documents/pptx-page-reader';
import { DocumentTaskRuntimeService } from '../../src/application/document-task-runtime-service';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const projectId = toProjectId('project-generation-read-loop');
const now = toIsoTimestamp('2026-09-28T12:00:00.000Z');
const registry = createCanonicalToolRegistry();
const generation = registry.get('generate_pptx')!;
const reading = registry.get('read_document_structure')!;
const markers = ['GENERATED-PHYSICAL-731', 'GENERATED-CONTINUATION-862'];
const content = ['# 合成生成读取闭环', '## 状态验证', markers[0], '## 交接验证', markers[1]].join('\n\n');

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
});

interface WireCall { readonly id: string; readonly type: string; readonly function: { readonly name: string; readonly arguments: string } }
interface WireMessage { readonly role: string; readonly content: string; readonly tool_call_id?: string; readonly tool_calls?: readonly WireCall[] }
interface WireRequest { readonly model: string; readonly messages: readonly WireMessage[]; readonly tools?: readonly {
  readonly type: string; readonly function: { readonly name: string; readonly parameters: Record<string, unknown> }
}[] }
interface ReadResult { readonly status: string; readonly observation?: { readonly pageCount: number; readonly totalSections: number;
  readonly revision: number; readonly sections: readonly { readonly blocks: readonly { readonly text: string }[] }[] } }

async function fixture(revokeAfterAdvertisingRead = false, invalidArtDirection = false, agentChatOnly = false, agentConversation = false) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-generation-read-loop-'));
  roots.push(rootDirectory);
  const userDataDirectory = path.join(rootDirectory, 'test-profile');
  await mkdir(userDataDirectory);
  const storage = new NodeProjectStorage(rootDirectory);
  const conversations = new JsonProjectConversationRepository(storage, projectId, () => now);
  const files = new JsonFileReferenceRepository(storage, projectId);
  const works = new JsonWorkRepository(storage, projectId);
  const conversation = createProjectConversation({ id: toConversationId('conversation-generation-read'),
    projectId, title: '生成后真实文件读回', createdAt: now });
  await conversations.create(conversation);
  expect(await works.list(projectId)).toEqual([]);
  expect(conversation.messages).toEqual([]);
  const provider = await providerFixture(userDataDirectory);
  const requests: WireRequest[] = [];
  const artRequests: WireRequest[] = [];
  const writes: GenerateDocumentFileInput[] = [];
  const designSnapshots: PresentationDesignCompilationSnapshot[] = [];
  const errors: unknown[] = [];
  const readSpy = vi.spyOn(RegisteredPresentationReader.prototype, 'read');
  const beginSpy = vi.spyOn(DocumentTaskRuntimeService.prototype, 'beginToolCall');
  const render = vi.fn(async (temporaryPath: string) => ({
    previewCount: (await readPptxDocument(await readFile(temporaryPath))).length, diagnostics: []
  }));
  // Keep the production executor, writer, structure QA, hashes and Work
  // registration real. Only the external Office renderer is an offline adapter.
  const execute = PlatformDocumentGenerationExecutor.prototype.run;
  const executor = new PlatformDocumentGenerationExecutor(new DocumentGenerationRunner({
    rootDirectory, projectId, renderPreview: render, requireRenderForPpt: true,
    generateTemporaryFile: async input => {
      writes.push(input);
      return generateTemporaryDocumentFile({ ...input, onDesignCompiled: async snapshot => {
        designSnapshots.push(snapshot);
        await input.onDesignCompiled?.(snapshot);
      } });
    }
  }));
  const generationSpy = vi.spyOn(PlatformDocumentGenerationExecutor.prototype, 'run').mockImplementation(input => execute.call(executor, input));
  const generationCall: WireCall = { id: 'generated-call-original-1', type: 'function', function: { name: generation.toolId,
    arguments: JSON.stringify({ title: '合成生成读取闭环', content, presentationTemplate: 'business_minimal' }) } };
  const readCall: WireCall = { id: 'read-generated-original-2', type: 'function', function: { name: reading.toolId,
    arguments: JSON.stringify({ scope: 'document' }) } };
  const transport = { send: async (request: { readonly body?: Uint8Array }): Promise<NewApiHttpTransportResponse> => {
    const payload = JSON.parse(Buffer.from(request.body!).toString('utf8')) as WireRequest;
    if (!payload.tools && payload.messages.some(message => message.role === 'system' && message.content.includes('Art Direction'))) {
      artRequests.push(payload);
      const outline = new PlatformDocumentDraftCompiler().compile({ content, kind: 'ppt', operation: 'create' });
      const initial = buildFallbackPresentationDesignIR(outline);
      const direction = parseArtDirection({ ...initial, globalDesign: { ...initial.globalDesign,
        visualTone: 'editorial', density: 'sparse', whitespace: 'generous', typographyDirection: 'display-led' },
        pages: initial.pages.map(page => page.pageNumber > 1 && page.pageNumber < initial.pages.length ? { ...page,
          pageRole: 'evidence', pageIntent: 'SENSITIVE-PAGE-INTENT-9001: Present the verified marker as the single focus',
          hierarchy: { primary: [`outline.sections[${page.pageNumber - 2}].blocks[0]`],
            secondary: [`outline.sections[${page.pageNumber - 2}].heading`], supporting: [] },
          composition: { principle: 'evidence-led', focalArea: 'right', balance: 'asymmetric-right', flow: 'left-to-right' },
          density: 'sparse', whitespace: 'generous',
          emphasis: { target: `outline.sections[${page.pageNumber - 2}].blocks[0]`, strength: 'dominant' }
        } : page) }, { outline });
      return stream(provider.modelKey, { content: invalidArtDirection ? '{"schemaVersion":' : JSON.stringify(direction) }, 'stop');
    }
    requests.push(payload);
    if (agentChatOnly) return stream(provider.modelKey, { content: '可以把冲突提前，让场景一更有张力。' }, 'stop');
    if (agentConversation) {
      if (requests.length <= 3) return stream(provider.modelKey, { content: '这个方向已经清楚了，我们继续细化人物和冲突。' }, 'stop');
      if (requests.length === 4) return stream(provider.modelKey, { tool_calls: [{ index: 0, ...generationCall }] }, 'tool_calls');
      if (requests.length === 5) return stream(provider.modelKey, { tool_calls: [{ index: 0, ...readCall }] }, 'tool_calls');
      if (requests.length === 6) return stream(provider.modelKey, { content: '已根据上下文生成并读取真实 PPT。' }, 'stop');
      throw new Error('Unexpected Agent conversation request');
    }
    if (requests.length === 1) return stream(provider.modelKey, { tool_calls: [{ index: 0, ...generationCall }] }, 'tool_calls');
    if (requests.length === 2) {
      const generatedWorks = await works.list(projectId);
      expect(generatedWorks).toHaveLength(1);
      const result = payload.messages.find(message => message.role === 'tool' && message.tool_call_id === generationCall.id)!;
      expect(JSON.parse(result.content)).toMatchObject({ status: 'success', observation: { generated: true } });
      if (revokeAfterAdvertisingRead) {
        const file = (await files.get(generatedWorks[0].fileId))!;
        await files.save({ ...file, state: 'missing', updatedAt: toIsoTimestamp('2026-09-28T12:00:01.000Z') });
      }
      return stream(provider.modelKey, { tool_calls: [{ index: 0, ...readCall }] }, 'tool_calls');
    }
    if (requests.length !== 3) throw new Error('Unexpected extra synthetic provider request');
    const result = JSON.parse(payload.messages.find(message => message.role === 'tool' && message.tool_call_id === readCall.id)!.content) as ReadResult;
    const answer = result.status === 'success'
      ? '真实物理页数：' + result.observation!.pageCount + '；' + result.observation!.sections.flatMap(section => section.blocks.map(block => block.text)).join('；')
      : '生成已完成，但当前文件读取被拒绝。';
    return stream(provider.modelKey, { content: answer }, 'stop');
  } };
  const newApiRuntime = new NewApiSharedRuntime({ transport });
  const deepSeekRuntime = new DeepSeekSharedRuntime({ transport: { send: async () => { throw new Error('Unexpected provider'); } } });
  const runtime = createChatContextRuntime({ userDataDirectory, providerRegistry: provider.registry, runtimeAuthorization: provider.authorization,
    getSession: () => ({ projectId, projectName: 'Synthetic generation/read test', rootDirectory }),
    textSubmission: { credentialVault: provider.vault, deepSeekRuntime, newApiRuntime }, now: () => now, onError: error => errors.push(error) });
  cleanups.push(async () => {
    await runtime.interruptActiveResponses();
    await runtime.waitForMutations();
    deepSeekRuntime.dispose();
    newApiRuntime.dispose();
  });
  async function run(agentNative = false, contentOverride?: string) {
    const candidates = await runtime.responses.listTextCandidates({ productFeature: 'text_chat' });
    if (!candidates.ok) throw new Error('Candidates failed: ' + candidates.error.code);
    const candidate = candidates.value.find(item => item.available);
    if (!candidate) throw new Error('No candidate: ' + JSON.stringify(candidates.value));
    const request = { clientCommandId: agentNative ? 'start-agent-generation-read' : 'start-generation-read',
      conversation: { conversationId: conversation.id, expectedRevision: conversation.revision, editedMessageId: null },
      title: conversation.title, content: contentOverride ?? '直接生成一个测试 PPT，然后读取刚生成文件的整篇结构，告诉我真实物理页数。',
      productFeature: 'text_chat' as const, candidateId: candidate.candidateId, contextSelections: [], parameterValues: {} };
    const started = agentNative
      ? await runtime.responses.startAgent(request)
      : await runtime.responses.start({ ...request, confirmed: true });
    if (!started.ok) throw new Error('Start failed: ' + started.error.code);
    const executionId = started.value.execution.responseExecutionId;
    await vi.waitFor(async () => {
      const current = await runtime.responses.getExecution({ responseExecutionId: executionId });
      expect(current).toMatchObject({ ok: true, value: { state: 'completed' } });
    }, { timeout: 10_000, interval: 25 });
    await runtime.waitForMutations();
    const current = await runtime.responses.getExecution({ responseExecutionId: executionId });
    if (!current.ok) throw new Error('Missing execution: ' + current.error.code);
    return { execution: current.value,
      traces: await new ConversationProductionTraceStore(storage, projectId).list({ conversationId: conversation.id }),
      runtimes: await new JsonDocumentTaskRuntimeRepository(storage, projectId).list() };
  }
  async function runAgentConversation() {
    const candidates = await runtime.responses.listTextCandidates({ productFeature: 'text_chat' });
    if (!candidates.ok) throw new Error('Candidates failed: ' + candidates.error.code);
    const candidate = candidates.value.find(item => item.available);
    if (!candidate) throw new Error('No candidate: ' + JSON.stringify(candidates.value));
    const turns = [
      '我想做一个《交换A》的 PPT。',
      '主要讲两个家庭交换身份以后发生的冲突。',
      '人物关系和冲突重点一点。',
      '可以'
    ];
    let currentConversation = await conversations.get(conversation.id);
    if (!currentConversation) throw new Error('Conversation unavailable');
    let finalExecution: Awaited<ReturnType<typeof runtime.responses.getExecution>> | undefined;
    for (const [index, content] of turns.entries()) {
      const started = await runtime.responses.startAgent({
        clientCommandId: `start-agent-conversation-${index}`,
        conversation: { conversationId: currentConversation.id, expectedRevision: currentConversation.revision, editedMessageId: null },
        title: currentConversation.title,
        content,
        productFeature: 'text_chat',
        candidateId: candidate.candidateId,
        contextSelections: [],
        parameterValues: {}
      });
      if (!started.ok) throw new Error('Agent start failed: ' + started.error.code);
      const executionId = started.value.execution.responseExecutionId;
      await vi.waitFor(async () => {
        const execution = await runtime.responses.getExecution({ responseExecutionId: executionId });
        if (!execution.ok) throw new Error('Missing execution: ' + execution.error.code);
        expect(['completed', 'failed', 'cancelled']).toContain(execution.value.state);
        if (index === turns.length - 1) finalExecution = execution;
      }, { timeout: 10_000, interval: 25 });
      currentConversation = await conversations.get(conversation.id);
      if (!currentConversation) throw new Error('Conversation disappeared');
    }
    await runtime.waitForMutations();
    if (!finalExecution?.ok) throw new Error('Missing final execution');
    return { execution: finalExecution.value, conversation: currentConversation,
      traces: await new ConversationProductionTraceStore(storage, projectId).list({ conversationId: conversation.id }),
      runtimes: await new JsonDocumentTaskRuntimeRepository(storage, projectId).list() };
  }
  return { run, runAgentConversation, rootDirectory, files, works, requests, artRequests, writes, designSnapshots, errors, render, generationSpy, readSpy, beginSpy, generationCall, readCall };
}

describe('production NewAPI generation to verified-file read continuation', () => {
  it('generates once, refreshes Canonical tools, reads physical PPT pages and returns the final model answer', async () => {
    const data = await fixture();
    const { execution, traces, runtimes } = await data.run();
    expect(data.errors).toEqual([]);
    expect(data.requests).toHaveLength(3);
    expect(data.artRequests).toHaveLength(1);
    expect(data.artRequests[0].tools).toBeUndefined();
    expect(data.artRequests[0].messages.map(message => message.content).join('\n')).toContain(markers[0]);
    expect(data.writes).toHaveLength(1);
    expect(data.writes[0].designIR?.schemaVersion).toBe(2);
    expect(data.designSnapshots).toHaveLength(1);
    expect(data.designSnapshots[0].strategies.find(page => page.pageNumber === 2)?.strategy).toBe('evidence');
    expect(data.designSnapshots[0].designIR?.pages[1].composition.focalArea).toBe('right');
    expect(data.designSnapshots[0]).toMatchObject({ designPath: 'design-aware', layoutStatus: 'success', renderPlanStatus: 'valid' });
    expect(data.designSnapshots[0].pages?.every(page => page.geometrySignature !== undefined)).toBe(true);
    expect(traces.some(trace => trace.operationId === 'presentation-layout-summary' && trace.status === 'completed')).toBe(true);
    const pageTrace = traces.find(trace => trace.operationId === 'presentation-layout-page-2' && trace.status === 'completed');
    expect(pageTrace?.facts?.pageIntentDigest).toBe('sha256:' + createHash('sha256')
      .update('SENSITIVE-PAGE-INTENT-9001: Present the verified marker as the single focus').digest('hex').slice(0, 20));
    expect(JSON.stringify(traces)).not.toContain('SENSITIVE-PAGE-INTENT-9001');
    expect(traces.some(trace => trace.operationId === 'presentation-design-validated' && trace.status === 'completed')).toBe(true);
    expect(data.generationSpy).toHaveBeenCalledTimes(1);
    expect(data.generationSpy.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(data.render).toHaveBeenCalledTimes(1);
    const [work] = await data.works.list(projectId);
    expect(await data.works.list(projectId)).toHaveLength(1);
    const file = (await data.files.get(work.fileId))!;
    expect(file.state).toBe('available');
    if (file.locator.kind !== 'project') throw new Error('Expected registered project file');
    const buffer = await readFile(path.join(data.rootDirectory, file.locator.relativePath));
    expect(createHash('sha256').update(buffer).digest('hex')).toBe(file.checksumSha256);
    expect(buffer.length).toBe(file.sizeBytes);
    const physicalPages = await readPptxDocument(buffer);
    expect(physicalPages.length).toBeGreaterThan(data.generationSpy.mock.calls[0][0].outline.sections.length);
    expect(data.readSpy.mock.calls.length).toBeGreaterThan(0);
    for (const [workId] of data.readSpy.mock.calls) expect(workId).toBe(work.id);
    for (const result of data.readSpy.mock.results) {
      const read = await result.value as Awaited<ReturnType<RegisteredPresentationReader['read']>>;
      expect(read.work.id).toBe(work.id);
      expect(read.file.id).toBe(file.id);
      expect(read.file.checksumSha256).toBe(file.checksumSha256);
      expect(read.pages).toHaveLength(physicalPages.length);
    }
    for (const [index, contract] of [generation, reading, reading].entries()) {
      expect(data.requests[index].tools).toEqual([{ type: 'function', function: {
        name: contract.toolId, description: contract.description, parameters: canonicalToolInputSchema(contract)
      } }]);
    }
    expect(data.requests[1].messages.filter(message => message.role === 'assistant').at(-1)?.tool_calls).toEqual([data.generationCall]);
    const final = data.requests[2];
    expect(final.messages.filter(message => message.role === 'assistant' && message.tool_calls).map(message => message.tool_calls))
      .toEqual([[data.generationCall], [data.readCall]]);
    expect(final.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id))
      .toEqual([data.generationCall.id, data.readCall.id]);
    expect(final.messages.slice(-4).map(message => message.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
    const readResult = JSON.parse(final.messages.find(message => message.tool_call_id === data.readCall.id)!.content) as ReadResult;
    expect(readResult).toMatchObject({ status: 'success', observation: { pageCount: physicalPages.length, totalSections: physicalPages.length } });
    const generationContext = data.beginSpy.mock.calls.find(([, call]) => call.toolId === generation.toolId)![2]!;
    const readContext = data.beginSpy.mock.calls.find(([, call]) => call.toolId === reading.toolId)![2]!;
    expect(generationContext.currentDocumentId).toBeUndefined();
    expect(readContext.currentDocumentId).toBe(work.id);
    expect(readContext.currentDocumentIR?.documentRef).toBe(work.id);
    expect(readContext.projectContext).toMatchObject({ projectId, workId: work.id });
    expect(readContext.taskContext.taskId).toBe(generationContext.taskContext.taskId);
    expect(readContext.revision).toBe(readResult.observation!.revision);
    expect(readContext.revision).toBe(Number.parseInt(createHash('sha256').update(JSON.stringify([
      work.id, file.id, work.sourceExecutionId, file.checksumSha256, file.updatedAt
    ])).digest('hex').slice(0, 12), 16));
    expect(readContext.currentDocumentIR?.content?.pageCount).toBe(physicalPages.length);
    expect(readContext.authorization).toMatchObject({ canRead: true, canWrite: false });
    expect(execution.content).toContain('真实物理页数：' + physicalPages.length);
    for (const marker of markers) expect(execution.content).toContain(marker);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].toolCalls).toMatchObject([
      { id: data.generationCall.id, toolId: generation.toolId, status: 'completed' },
      { id: data.readCall.id, toolId: reading.toolId, status: 'completed' }
    ]);
    for (const contract of [generation, reading]) {
      expect(traces.filter(trace => trace.facts?.tool === contract.diagnostics.traceType && trace.code === 'tool_result')
        .some(trace => trace.status === 'completed')).toBe(true);
    }
    for (const stage of ['document-output-structure', 'document-render-diagnostics', 'document-published-hash', 'document-work-register']) {
      expect(traces.some(trace => trace.operationId === stage && trace.status === 'completed')).toBe(true);
    }
    const outgoing = [JSON.stringify([...data.requests, ...data.artRequests]), ...data.requests.flatMap(request => request.messages
      .filter(message => message.role === 'tool').map(message => message.content))].join('\n');
    for (const hidden of [data.rootDirectory, work.id, file.id, file.checksumSha256, '"rootDirectory"', '"relativePath"',
      '"currentDocumentId"', '"currentDocumentIR"', '"authorization"', '"abortSignal"', '"projectContext"', '"taskContext"']) {
      expect(outgoing).not.toContain(hidden);
    }
  });

  it('runs the same verified generation/read loop through the Agent-native entry', async () => {
    const data = await fixture();
    const { execution, traces, runtimes } = await data.run(true);
    expect(data.errors).toEqual([]);
    await vi.waitFor(async () => {
      const agentRunDocument = JSON.parse(await readFile(path.join(data.rootDirectory, 'entities/conversation-agent-runs.json'), 'utf8')) as {
        readonly runs: readonly { readonly conversationId: string; readonly responseExecutionId?: string; readonly status: string }[]
      };
      expect(agentRunDocument.runs).toHaveLength(1);
      expect(agentRunDocument.runs[0]).toMatchObject({
        conversationId: 'conversation-generation-read',
        responseExecutionId: execution.responseExecutionId,
        status: 'completed'
      });
    }, { timeout: 2_000, interval: 25 });
    expect(data.requests).toHaveLength(3);
    expect(data.requests.map(request => request.tools?.[0]?.function.name)).toEqual([
      generation.toolId,
      reading.toolId,
      reading.toolId
    ]);
    expect(execution.content).toContain('真实物理页数：');
    expect(await data.works.list(projectId)).toHaveLength(1);
    expect(runtimes[0].toolCalls).toMatchObject([
      { id: data.generationCall.id, toolId: generation.toolId, status: 'completed' },
      { id: data.readCall.id, toolId: reading.toolId, status: 'completed' }
    ]);
    expect(traces.some(trace => trace.code === 'tool_result' && trace.status === 'completed')).toBe(true);
  });

  it('keeps a discussion-only Agent-native turn as assistant text with no tool calls', async () => {
    const data = await fixture(false, false, true);
    const { execution } = await data.run(true, '场景一我觉得不够激烈。');
    expect(execution.state).toBe('completed');
    expect(execution.content).toContain('场景一');
    expect(data.requests).toHaveLength(1);
    expect(data.requests[0].messages.some(message => message.role === 'assistant' && message.tool_calls)).toBe(false);
    expect(await data.works.list(projectId)).toHaveLength(0);
    expect(data.generationSpy).not.toHaveBeenCalled();
  });

  it('uses full conversation history when the final Agent-native turn is only “可以”', async () => {
    const data = await fixture(false, false, false, true);
    const { execution, conversation, runtimes } = await data.runAgentConversation();
    expect(data.errors).toEqual([]);
    expect(execution.state).toBe('completed');
    expect(data.requests).toHaveLength(6);
    expect(data.requests[3].messages.some(message => message.role === 'user' && message.content === '可以')).toBe(true);
    expect(data.requests[3].messages.some(message => message.role === 'user' && message.content.includes('交换A'))).toBe(true);
    expect(data.requests[3].messages.some(message => message.role === 'assistant' && message.content.includes('人物和冲突'))).toBe(true);
    expect(data.requests[3].messages.filter(message => message.role === 'assistant' && message.tool_calls).map(message => message.tool_calls)).toEqual([]);
    expect(data.requests[4].messages.at(-2)?.tool_calls?.[0]?.function.name).toBe('generate_pptx');
    expect(data.requests[5].messages.at(-2)?.tool_calls?.[0]?.function.name).toBe('read_document_structure');
    expect(execution.content).toContain('生成并读取真实 PPT');
    expect(await data.works.list(projectId)).toHaveLength(1);
    expect(runtimes[0].toolCalls).toMatchObject([
      { toolId: 'generate_pptx', status: 'completed' },
      { toolId: 'read_document_structure', status: 'completed' }
    ]);
    expect(conversation.messages.some(message => message.role === 'user' && message.content === '可以')).toBe(true);
  }, 15_000);

  it('falls back to the stable template after malformed Art Direction and still registers and reads the real file', async () => {
    const data = await fixture(false, true);
    const { execution, traces } = await data.run();
    expect(data.artRequests).toHaveLength(1);
    expect(data.requests).toHaveLength(3);
    expect(data.writes).toHaveLength(1);
    expect(data.writes[0].designIR).toBeUndefined();
    expect(data.designSnapshots).toHaveLength(1);
    expect(data.designSnapshots[0]).toMatchObject({ designPath: 'legacy-fallback', fallbackReason: 'art_direction_invalid', artDirectionStatus: 'invalid', designIrStatus: 'invalid' });
    expect(traces.some(trace => trace.operationId === 'presentation-layout-summary' && trace.status === 'completed')).toBe(true);
    expect(traces.some(trace => trace.operationId === 'presentation-design-fallback')).toBe(true);
    const [work] = await data.works.list(projectId);
    expect(work).toBeDefined();
    const file = (await data.files.get(work.fileId))!;
    expect(file.state).toBe('available');
    expect(file.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    for (const marker of markers) expect(execution.content).toContain(marker);
    expect(data.errors).toEqual([]);
  });

  it('refuses a generated file revoked after read was advertised and preserves the actual completed Work', async () => {
    const data = await fixture(true);
    const { execution, traces } = await data.run();
    expect(data.requests).toHaveLength(3);
    expect(data.generationSpy).toHaveBeenCalledTimes(1);
    expect(await data.works.list(projectId)).toHaveLength(1);
    expect(data.requests[1].tools?.map(tool => tool.function.name)).toEqual([reading.toolId]);
    expect(data.requests[2].tools).toBeUndefined();
    const resultMessage = data.requests[2].messages.find(message => message.tool_call_id === data.readCall.id)!;
    expect(JSON.parse(resultMessage.content)).toMatchObject({ status: 'failed' });
    for (const marker of markers) expect(resultMessage.content).not.toContain(marker);
    expect(traces.some(trace => trace.code === 'tool_call' && trace.operationId === data.readCall.id && trace.status === 'started')).toBe(false);
    expect(execution.content).toBe('生成已完成，但当前文件读取被拒绝。');
  });
});

function stream(model: string, delta: Record<string, unknown>, finishReason: 'stop' | 'tool_calls'): NewApiHttpTransportResponse {
  const body = 'data: ' + JSON.stringify({ id: 'synthetic-generation-read', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\ndata: [DONE]\n\n';
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, stream: (async function* () { yield Buffer.from(body); })() };
}

async function providerFixture(directory: string) {
  const providerId = toProviderId('provider-generation-loop');
  const connectionId = toConnectionId('connection-generation-loop');
  const bindingId = toProtocolBindingId('binding-generation-loop');
  const modelId = toModelId('model-generation-loop');
  const modelKey = 'synthetic-newapi-text';
  const definition = createOpenAiCompatibleDefaultTextDefinition({ packageId: NEWAPI_PROVIDER_PACKAGE_ID,
    packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION, providerModelKey: modelKey, features: ['text_chat'] });
  const template = definition.profileTemplates[0]!;
  const providerRegistry = new JsonProviderRegistryStore(path.join(directory, 'provider-registry.json'));
  await providerRegistry.mutate(snapshot => ({ result: undefined, snapshot: { ...snapshot,
    providers: [createProvider({ id: providerId, name: 'Synthetic NewAPI', packageId: NEWAPI_PROVIDER_PACKAGE_ID,
      packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION, accessCategory: 'online', identityState: 'verified', createdAt: now, updatedAt: now })],
    connections: [createProviderConnection({ id: connectionId, providerId, name: 'Synthetic connection', endpoint: 'https://gateway.example.test/v1',
      packageId: NEWAPI_PROVIDER_PACKAGE_ID, packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION, templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID,
      templateKind: 'compatible_custom', credentialSchemaId: NEWAPI_CREDENTIAL_SCHEMA_ID, credentialSchemaVersion: 1,
      credentialVersionId: 'credential-version-generation-loop', credentialReference: 'synthetic-generation-reference',
      connectionPolicyId: 'connection.newapi.compatible', connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.newapi.models', discoveryPolicyRevision: 1,
      endpointPolicyId: NEWAPI_ENDPOINT_POLICY_ID, endpointPolicyRevision: 1,
      connectionConfigVersionId: 'connection-config-generation-loop', connectionRevision: 1,
      adapterBindings: [{ adapterId: NEWAPI_CHAT_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION,
        protocolId: NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: NEWAPI_PROTOCOL_VERSION }],
      state: 'available', identityState: 'verified', credentialState: 'valid', createdAt: now, updatedAt: now })],
    protocolBindings: [createProviderProtocolBinding({ id: bindingId, providerId, connectionId,
      protocolId: NEWAPI_CHAT_PROTOCOL_ID, protocolVersion: NEWAPI_PROTOCOL_VERSION, adapterKind: NEWAPI_CHAT_ADAPTER_ID,
      mediaKind: 'unknown', authScheme: 'bearer', executionLifecycle: 'synchronous_completed', supportedPurposes: [], createdAt: now, updatedAt: now })],
    models: [createProviderModel({ id: modelId, providerId, connectionId, protocolBindingId: bindingId,
      providerModelKey: modelKey, mediaKind: 'unknown', revision: 1, displayName: 'Synthetic model',
      activeProfileId: 'profile-generation-loop', catalogState: 'present', enabled: true, createdAt: now, updatedAt: now })],
    modelDefinitions: [definition], modelProfiles: [{ schemaVersion: 1, profileId: 'profile-generation-loop', revision: 1,
      packageId: definition.packageId, sourceTemplateId: template.templateId, adapterKey: template.adapterKey,
      modelId, modelRevision: 1, protocolBindingId: bindingId, status: 'verified', features: template.features, evidenceIds: [], recordedAt: now }]
  } }));
  const authorization = new RuntimeAuthorizationLedger(new JsonRuntimeAuthorizationLedgerStore(path.join(directory, 'authorization.json')), () => now);
  await authorization.upsertPolicy({ policyId: 'policy-generation-loop', providerPackageId: NEWAPI_PROVIDER_PACKAGE_ID,
    connectionId, adapterKey: NEWAPI_CHAT_ADAPTER_ID, state: 'interactive_allowed', revision: 1,
    allowedOperations: ['submit', 'query', 'cancel', 'receive_result'] });
  const vault = new SecureCredentialVault(path.join(directory, 'synthetic-credentials.json'), {
    isAvailable: () => true, protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString('utf8')
  });
  await vault.saveRecord('synthetic-generation-reference', { schemaId: NEWAPI_CREDENTIAL_SCHEMA_ID, schemaVersion: 1,
    values: { api_key: 'synthetic-offline-unit-test-key' } });
  return { registry: providerRegistry, authorization, vault, modelKey };
}
