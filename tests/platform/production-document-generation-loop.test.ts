import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectConversation, createProvider, createProviderConnection, createProviderModel, createProviderProtocolBinding,
  toConnectionId, toConversationId, toIsoTimestamp, toModelId, toProjectId, toProtocolBindingId, toProviderId,
  parseConversationAgentRuntimeSnapshot, type ConversationAgentRuntimeSnapshotV1, type ConversationResponseExecutionId
} from '../../src/domain';
import { canonicalToolInputSchema, createCanonicalToolRegistry } from '../../src/domain/entities/canonical-tool-contract';
import {
  createChatContextRuntime, createOpenAiCompatibleDefaultTextDefinition, DeepSeekSharedRuntime, NewApiSharedRuntime,
  JsonProviderRegistryStore, RuntimeAuthorizationLedger, JsonRuntimeAuthorizationLedgerStore, SecureCredentialVault,
  NodeProjectStorage, JsonFileReferenceRepository, JsonWorkRepository, JsonProjectConversationRepository,
  JsonDocumentTaskRuntimeRepository, DocumentGenerationRunner, NEWAPI_PROVIDER_PACKAGE_ID, NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_COMPATIBLE_TEMPLATE_ID, NEWAPI_CREDENTIAL_SCHEMA_ID, NEWAPI_ENDPOINT_POLICY_ID, NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_ADAPTER_VERSION, NEWAPI_CHAT_PROTOCOL_ID, NEWAPI_PROTOCOL_VERSION, NewApiTransportFailure, type NewApiHttpTransportResponse
} from '../../src/platform';
import { ConversationProductionTraceStore } from '../../src/platform/conversation-production-trace';
import { PlatformDocumentDraftCompiler, PlatformDocumentGenerationExecutor } from '../../src/platform/documents/document-generation-application-adapters';
import { buildFallbackPresentationDesignIR, parseArtDirection } from '../../src/domain/entities/presentation-design-contract';
import { generateTemporaryDocumentFile, type GenerateDocumentFileInput } from '../../src/platform/documents/office-document-generator';
import type { PresentationDesignCompilationSnapshot } from '../../src/platform/documents/presentation-design-compiler';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { readPptxDocument } from '../../src/platform/documents/pptx-page-reader';
import { DocumentTaskRuntimeService } from '../../src/application/document-task-runtime-service';
import { JsonConversationAgentRuntimeRepository } from '../../src/platform/repositories/json-conversation-agent-runtime-repository';
import { JsonConversationCompletionJournal } from '../../src/platform/repositories/json-conversation-completion-journal';
import { JsonConversationAgentSessionRepository } from '../../src/platform/repositories/json-conversation-agent-session-repository';
import { ConversationAgentRuntimeService } from '../../src/application/conversation-agent-runtime-service';
import { ConversationDocumentToolSessionService } from '../../src/platform/documents/conversation-document-tool-session';
import { ProjectSubmissionAcceptanceStore } from '../../src/platform/storage';

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
interface WireRequest { readonly model: string; readonly messages: readonly WireMessage[]; readonly tool_choice?: string; readonly tools?: readonly {
  readonly type: string; readonly function: { readonly name: string; readonly parameters: Record<string, unknown> }
}[] }
interface ReadResult { readonly status: string; readonly observation?: { readonly pageCount: number; readonly totalSections: number;
  readonly revision: number; readonly sections: readonly { readonly blocks: readonly { readonly text: string }[] }[] } }

async function fixture(revokeAfterAdvertisingRead = false, invalidArtDirection = false, agentChatOnly = false, agentConversation = false,
  planningPageGoal?: number, holdProviderResponse = false, flowOptions?: {
    readonly staleAfterKnownFailure?: boolean;
    readonly terminalAfterGeneration?: 'failed' | 'cancelled' | 'unknown';
  }) {
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
  const providerSignals: AbortSignal[] = [];
  const artRequests: WireRequest[] = [];
  const writes: GenerateDocumentFileInput[] = [];
  const designSnapshots: PresentationDesignCompilationSnapshot[] = [];
  const errors: unknown[] = [];
  let activeResponseId: string | undefined;
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
  if (flowOptions?.staleAfterKnownFailure) generationSpy.mockRejectedValueOnce(new Error('Synthetic known generation failure'));
  const generatedContent = flowOptions?.staleAfterKnownFailure
    ? content + '\n\n## 第三个结构页\n有界离线生成验证\n\n## 第四个结构页\n文件读回交付验证' : content;
  const generationCall: WireCall = { id: 'generated-call-original-1', type: 'function', function: { name: generation.toolId,
    arguments: JSON.stringify({ title: '合成生成读取闭环', content: generatedContent, presentationTemplate: 'business_minimal',
      ...(planningPageGoal === undefined ? {} : { requestedTotalPages: planningPageGoal }) }) } };
  const readCall: WireCall = { id: 'read-generated-original-2', type: 'function', function: { name: reading.toolId,
    arguments: JSON.stringify({ scope: 'document' }) } };
  const transport = { send: async (request: { readonly body?: Uint8Array; readonly signal?: AbortSignal }): Promise<NewApiHttpTransportResponse> => {
    const payload = JSON.parse(Buffer.from(request.body!).toString('utf8')) as WireRequest;
    if (!payload.tools && payload.messages.some(message => message.role === 'system' && message.content.includes('Art Direction'))) {
      artRequests.push(payload);
      const outline = new PlatformDocumentDraftCompiler().compile({ content: generatedContent, kind: 'ppt', operation: 'create' });
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
    if (holdProviderResponse) {
      if (!request.signal) throw new Error('Expected cancellable Provider transport');
      providerSignals.push(request.signal);
      const stopped = new Promise<never>((_resolve, reject) => {
        const cancel = () => reject(Object.assign(new Error('Synthetic transport cancelled'), { name: 'AbortError' }));
        request.signal!.addEventListener('abort', cancel, { once: true });
        if (request.signal!.aborted) cancel();
      });
      void stopped.catch(() => undefined);
      return { status: 200, headers: { 'content-type': 'text/event-stream' },
        stream: (async function* () { yield await stopped; })() };
    }
    if (agentChatOnly) return stream(provider.modelKey, { content: '可以把冲突提前，让场景一更有张力。' }, 'stop');
    if (agentConversation) {
      if (requests.length <= 3) return stream(provider.modelKey, { content: '这个方向已经清楚了，我们继续细化人物和冲突。' }, 'stop');
      if (requests.length === 4) return stream(provider.modelKey, { tool_calls: [{ index: 0, ...generationCall }] }, 'tool_calls');
      if (requests.length === 5) return stream(provider.modelKey, { tool_calls: [{ index: 0, ...readCall }] }, 'tool_calls');
      if (requests.length === 6) return stream(provider.modelKey, { content: '已根据上下文生成并读取真实 PPT。' }, 'stop');
      throw new Error('Unexpected Agent conversation request');
    }
    const lastToolMessage = payload.messages.filter(message => message.role === 'tool').at(-1);
    if (!lastToolMessage) return stream(provider.modelKey, { tool_calls: [{ index: 0, ...generationCall }] }, 'tool_calls');
    const lastToolResult = JSON.parse(lastToolMessage.content) as ReadResult;
    if (lastToolMessage.tool_call_id?.startsWith('generated-call-')) {
      if (lastToolResult.status === 'failed') return stream(provider.modelKey, { tool_calls: [{ index: 0,
        ...generationCall, id: `generated-call-retry-${requests.length}` }] }, 'tool_calls');
      const generatedWorks = await works.list(projectId);
      expect(generatedWorks).toHaveLength(1);
      expect(lastToolResult).toMatchObject({ status: 'success', observation: { generated: true } });
      if (revokeAfterAdvertisingRead) {
        const file = (await files.get(generatedWorks[0].fileId))!;
        await files.save({ ...file, state: 'missing', updatedAt: toIsoTimestamp('2026-09-28T12:00:01.000Z') });
      }
      return stream(provider.modelKey, { tool_calls: [{ index: 0, ...(flowOptions?.staleAfterKnownFailure
        ? { ...generationCall, id: 'generated-call-stale-after-success' } : readCall) }] }, 'tool_calls');
    }
    if (flowOptions?.terminalAfterGeneration === 'failed') return { status: 401, headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ error: { code: 'authentication_failed', message: 'Synthetic known rejection' } })) };
    if (flowOptions?.terminalAfterGeneration === 'unknown') throw new NewApiTransportFailure('network');
    if (flowOptions?.terminalAfterGeneration === 'cancelled') {
      if (!activeResponseId) throw new Error('Expected active response before cancellation');
      void runtime.responses.cancelExecution({ responseExecutionId: activeResponseId });
      const stopped = new Promise<never>((_resolve, reject) => {
        const cancel = () => reject(new NewApiTransportFailure('cancelled'));
        request.signal!.addEventListener('abort', cancel, { once: true });
        if (request.signal!.aborted) cancel();
      });
      void stopped.catch(() => undefined);
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, stream: (async function* () { yield await stopped; })() };
    }
    const result = lastToolResult;
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
  async function start(agentNative = false, contentOverride?: string, clientCommandId?: string) {
    const candidates = await runtime.responses.listTextCandidates({ productFeature: 'text_chat' });
    if (!candidates.ok) throw new Error('Candidates failed: ' + candidates.error.code);
    const candidate = candidates.value.find(item => item.available);
    if (!candidate) throw new Error('No candidate: ' + JSON.stringify(candidates.value));
    const request = { clientCommandId: clientCommandId ?? (agentNative ? 'start-agent-generation-read' : 'start-generation-read'),
      conversation: { conversationId: conversation.id, expectedRevision: conversation.revision, editedMessageId: null },
      title: conversation.title, content: contentOverride ?? (planningPageGoal === undefined
        ? '直接生成一个测试 PPT，然后读取刚生成文件的整篇结构，告诉我真实物理页数。'
        : `直接生成一个 ${planningPageGoal} 页的测试 PPT，然后读取刚生成文件的整篇结构，告诉我真实物理页数。`),
      productFeature: 'text_chat' as const, candidateId: candidate.candidateId, contextSelections: [], parameterValues: {} };
    const result = agentNative
      ? await runtime.responses.startAgent(request)
      : await runtime.responses.start({ ...request, confirmed: true });
    if (result.ok && 'execution' in result.value) activeResponseId = result.value.execution.responseExecutionId;
    return result;
  }
  async function run(agentNative = false, contentOverride?: string) {
    const started = await start(agentNative, contentOverride);
    if (!started.ok) throw new Error('Start failed: ' + started.error.code);
    if (!('execution' in started.value)) throw new Error('Expected an executable generation response');
    const executionId = started.value.execution.responseExecutionId;
    await vi.waitFor(async () => {
      const current = await runtime.responses.getExecution({ responseExecutionId: executionId });
      expect(current).toMatchObject({ ok: true, value: { state: flowOptions?.terminalAfterGeneration === 'cancelled' ? 'cancelled'
        : flowOptions?.terminalAfterGeneration ? 'failed' : 'completed' } });
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
      if (!started.ok) {
        const parentTasks = await new JsonConversationAgentSessionRepository(storage, projectId).list();
        throw new Error('Agent start failed at turn ' + index + ': ' + started.error.code + '; parent tasks: ' +
          JSON.stringify(parentTasks.map(task => ({ id: task.id, state: task.status, revision: task.revision,
            segments: task.childSegments.map(child => ({ runId: child.runId, responseExecutionId: child.responseExecutionId, state: child.status })) }))) +
          '; host errors: ' + errors.map(error => error instanceof Error ? `${error.name}:${error.message}` : 'unknown').join(';'));
      }
      if (!('execution' in started.value)) throw new Error('Expected an executable Agent response');
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
  return { start, run, runAgentConversation, runtime, userDataDirectory, rootDirectory, files, works, requests, providerSignals, artRequests, writes, designSnapshots, errors, render, generationSpy, readSpy, beginSpy, generationCall, readCall };
}

describe('production NewAPI generation to verified-file read continuation', () => {
  it('settles and revokes the owned document session when startup is cancelled after durable Run creation', async () => {
    const data = await fixture(false, false, true);
    const open = ConversationAgentRuntimeService.prototype.open;
    const lookup = vi.spyOn(ConversationDocumentToolSessionService.prototype, 'forExecution');
    vi.spyOn(ConversationAgentRuntimeService.prototype, 'open').mockImplementation(async function (this: ConversationAgentRuntimeService, run, policy) {
      const opened = await open.call(this, run, policy);
      expect(await data.runtime.responses.cancelResponseStart({ projectId, clientCommandId: 'start-agent-generation-read' }))
        .toMatchObject({ ok: true, value: { cancelled: true } });
      return opened;
    });
    expect(await data.start(true)).toMatchObject({ ok: false });
    const repository = new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(data.rootDirectory), projectId);
    await vi.waitFor(async () => {
      expect((await repository.list()).map(snapshot => snapshot.runtime)).toMatchObject([
        { status: 'settled', stopReason: 'cancelled', modelCalls: [], toolCalls: [] }
      ]);
    }, { timeout: 2_000, interval: 25 });
    await data.runtime.waitForMutations();
    const [{ runtime: canonical }] = await repository.list();
    expect(await data.runtime.responses.getExecution({ responseExecutionId: canonical.responseExecutionId }))
      .toMatchObject({ ok: true, value: { state: 'cancelled', parentRun: { state: 'cancelled' } } });
    const toolSessions = lookup.mock.contexts.at(-1) as ConversationDocumentToolSessionService;
    expect(await toolSessions.forExecution({ responseExecutionId: canonical.responseExecutionId })).toBeUndefined();
    expect(data.requests).toHaveLength(0);
    expect(data.writes).toHaveLength(0);
    expect(await data.works.list(projectId)).toHaveLength(0);
  });

  it('settles and revokes the owned document session when authorization fails before Provider dispatch', async () => {
    const data = await fixture(false, false, true);
    const lookup = vi.spyOn(ConversationDocumentToolSessionService.prototype, 'forExecution');
    vi.spyOn(RuntimeAuthorizationLedger.prototype, 'claimSubmission').mockRejectedValue(new Error('Synthetic authorization refusal'));
    const started = await data.start(true);
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) throw new Error('Expected locally accepted execution');
    if (!('execution' in started.value)) throw new Error('Expected an executable locally accepted response');
    const executionId = started.value.execution.responseExecutionId;
    await vi.waitFor(async () => {
      expect(await data.runtime.responses.getExecution({ responseExecutionId: executionId }))
        .toMatchObject({ ok: true, value: { state: 'failed', parentRun: { state: 'failed' } } });
    }, { timeout: 2_000, interval: 25 });
    await data.runtime.waitForMutations();
    const canonical = await new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(data.rootDirectory), projectId)
      .findByResponseExecutionId(executionId as ConversationResponseExecutionId);
    expect(canonical?.runtime).toMatchObject({ status: 'settled', modelCalls: [], toolCalls: [], registeredWorkIds: [] });
    const toolSessions = lookup.mock.contexts.at(-1) as ConversationDocumentToolSessionService;
    expect(await toolSessions.forExecution({ responseExecutionId: executionId })).toBeUndefined();
    expect(data.requests).toHaveLength(0);
    expect(data.writes).toHaveLength(0);
    expect(await data.works.list(projectId)).toHaveLength(0);
  });

  it('freezes the durable parent when the pre-dispatch session close confirmation is lost', async () => {
    const data = await fixture(false, false, true);
    const lookup = ConversationDocumentToolSessionService.prototype.forExecution;
    vi.spyOn(ConversationDocumentToolSessionService.prototype, 'forExecution').mockImplementation(async function (this: ConversationDocumentToolSessionService, input) {
      const session = await lookup.call(this, input);
      return session ? { ...session, close: async () => {
        await session.close();
        throw new Error('Synthetic missing close acknowledgement');
      } } : undefined;
    });
    vi.spyOn(RuntimeAuthorizationLedger.prototype, 'claimSubmission').mockRejectedValue(new Error('Synthetic authorization refusal'));
    const started = await data.start(true);
    if (!started.ok) throw new Error('Expected locally accepted execution');
    if (!('execution' in started.value)) throw new Error('Expected an executable locally accepted response');
    const executionId = started.value.execution.responseExecutionId;
    await vi.waitFor(async () => {
      expect(await data.runtime.responses.getExecution({ responseExecutionId: executionId }))
        .toMatchObject({ ok: true, value: { state: 'failed', parentRun: { state: 'needs_reconciliation' } } });
    }, { timeout: 2_000, interval: 25 });
    await data.runtime.waitForMutations();
    const canonical = await new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(data.rootDirectory), projectId)
      .findByResponseExecutionId(executionId as ConversationResponseExecutionId);
    expect(canonical?.runtime).toMatchObject({ status: 'needs_reconciliation', stopReason: 'unknown_result', modelCalls: [], toolCalls: [] });
    expect((await new JsonConversationCompletionJournal(new NodeProjectStorage(data.rootDirectory), projectId)
      .get(executionId as ConversationResponseExecutionId))?.decision.canReplay).toBe(false);
    expect(await data.start(true, undefined, 'another-start-after-uncertain-close')).toMatchObject({ ok: false });
    expect(data.requests).toHaveLength(0);
    expect(data.writes).toHaveLength(0);
    expect(await data.works.list(projectId)).toHaveLength(0);
  });

  it('cancels an already opened Provider without a document session when acceptance persistence fails', async () => {
    const data = await fixture(false, false, false, false, undefined, true);
    vi.spyOn(ConversationDocumentToolSessionService.prototype, 'prepare').mockResolvedValue(undefined);
    const advance = ProjectSubmissionAcceptanceStore.prototype.advance;
    vi.spyOn(ProjectSubmissionAcceptanceStore.prototype, 'advance').mockImplementation(function (this: ProjectSubmissionAcceptanceStore, input) {
      if (input.intent.status === 'provider_accepted') return Promise.reject(new Error('Synthetic acceptance persistence failure'));
      return advance.call(this, input);
    });
    const started = await data.start(true, '普通问答');
    if (!started.ok) throw new Error('Expected locally accepted execution');
    if (!('execution' in started.value)) throw new Error('Expected an executable locally accepted response');
    const executionId = started.value.execution.responseExecutionId;
    await vi.waitFor(async () => {
      expect(data.providerSignals).toHaveLength(1);
      expect(data.providerSignals[0].aborted).toBe(true);
      expect(await data.runtime.responses.getExecution({ responseExecutionId: executionId }))
        .toMatchObject({ ok: true, value: { state: 'failed', parentRun: { state: 'needs_reconciliation' } } });
    }, { timeout: 2_000, interval: 25 });
    await data.runtime.waitForMutations();
    const canonical = await new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(data.rootDirectory), projectId)
      .findByResponseExecutionId(executionId as ConversationResponseExecutionId);
    expect(canonical?.runtime).toMatchObject({ status: 'needs_reconciliation', modelCalls: [{ status: 'unknown' }], toolCalls: [] });
    expect(data.requests).toHaveLength(1);
    expect(data.writes).toHaveLength(0);
    expect(await data.works.list(projectId)).toHaveLength(0);
  });

  it('refuses parent completion when an explicitly requested document only receives a text answer with no file', async () => {
    const data = await fixture(false, false, true);
    const { execution } = await data.run(true);
    const settled = await data.runtime.responses.getExecution({ responseExecutionId: execution.responseExecutionId });
    expect(settled).toMatchObject({ ok: true, value: { state: 'completed', parentRun: { state: 'failed', registeredWorkCount: 0 } } });
    expect(data.requests).toHaveLength(1);
    expect(data.writes).toHaveLength(0);
    expect(await data.works.list(projectId)).toHaveLength(0);
  });
  it('settles persisted document completion after restart at the response-completed / session-close boundary without replaying generation', async () => {
    const data = await fixture();
    const { execution } = await data.run(true);
    await data.runtime.interruptActiveResponses();
    await data.runtime.waitForMutations();
    const storage = new NodeProjectStorage(data.rootDirectory);
    const runtimeRepository = new JsonConversationAgentRuntimeRepository(storage, projectId);
    const completedRuntime = await runtimeRepository.findByResponseExecutionId(execution.responseExecutionId as ConversationResponseExecutionId);
    if (!completedRuntime) throw new Error('Expected canonical production runtime');
    expect(completedRuntime.events.slice(-2).map(event => event.kind)).toEqual(['run_stopped', 'run_settled']);
    const beforeStopEvents = completedRuntime.events.slice(0, -2);
    const lastCommitted = beforeStopEvents.at(-1)!;
    const beforeStopRuntime = parseConversationAgentRuntimeSnapshot({
      runtime: { ...completedRuntime.runtime, status: 'running', revision: beforeStopEvents.length - 1,
        checkpoint: { ...completedRuntime.runtime.checkpoint, sequence: lastCommitted.sequence, stage: 'model' },
        updatedAt: lastCommitted.at },
      events: beforeStopEvents,
      outbox: completedRuntime.outbox.filter(event => event.sequence <= lastCommitted.sequence)
    });
    const taskPath = (await import('../../src/platform/storage/project-paths')).projectStoragePaths.entities.documentTaskRuntimes;
    const runPath = (await import('../../src/platform/storage/project-paths')).projectStoragePaths.entities.conversationAgentRuns;
    const metadataPath = (await import('../../src/platform/storage/project-paths')).projectStoragePaths.entities.metadataUnit;
    const runDocument = JSON.parse(await readFile(path.join(data.rootDirectory, runPath), 'utf8'));
    const responseRun = runDocument.runs.find((run: { readonly responseExecutionId?: string }) => run.responseExecutionId === execution.responseExecutionId);
    expect(responseRun).toBeDefined();
    const beforeCloseRun = { ...responseRun, status: 'executing_tool' };
    await storage.mutateJsonAtomically(runPath, current => ({ ...current as object, revision: runDocument.revision + 1,
      runs: runDocument.runs.map((run: { readonly id: string }) => run.id === beforeCloseRun.id ? beforeCloseRun : run) }));
    await storage.mutateJsonAtomically(taskPath, current => {
      const document = current as { revision: number; runtimes: Array<{ executionId: string; checkpoint: object }> };
      return { ...document, revision: document.revision + 1, runtimes: document.runtimes.map(runtime => runtime.executionId === execution.responseExecutionId
        ? { ...runtime, status: 'running', checkpoint: { ...runtime.checkpoint, stage: 'tool' } } : runtime) };
    });
    await storage.mutateJsonAtomically(metadataPath, current => {
      const document = current as { revision: number; entries: Array<{ key: string; value: Record<string, unknown> }> };
      return { ...document, revision: document.revision + 1, entries: document.entries.map(entry => {
        if (entry.key === 'conversation-agent-runtimes-v1') return { ...entry, value: { ...entry.value,
          snapshots: (entry.value.snapshots as ConversationAgentRuntimeSnapshotV1[]).map(snapshot =>
            snapshot.runtime.responseExecutionId === execution.responseExecutionId ? beforeStopRuntime : snapshot) } };
        return entry.key.startsWith('conversation.completion.') && entry.value.responseExecutionId === execution.responseExecutionId
          ? { ...entry, value: { ...entry.value, stage: 'applied', targetRun: beforeCloseRun, expectedRunRevision: beforeCloseRun.revision,
            decision: { ...entry.value.decision as object, status: 'executing_tool', reason: 'document_pending', executionOwner: 'document_task', documentCompleted: false } } }
          : entry;
      }) };
    });
    const restartErrors: unknown[] = [];
    const reopened = createChatContextRuntime({ userDataDirectory: data.userDataDirectory,
      getSession: () => ({ projectId, projectName: 'Restart closure', rootDirectory: data.rootDirectory }), now: () => now, onError: error => restartErrors.push(error) });
    const recovered = await reopened.responses.getExecution({ responseExecutionId: execution.responseExecutionId });
    if (!recovered.ok) throw new Error(`${recovered.error.code}: ${restartErrors.map(error => error instanceof Error ? `${error.name}:${error.message}` : 'unknown').join(';')}`);
    expect(recovered).toMatchObject({ ok: true, value: { state: 'completed', parentRun: { state: 'completed', registeredWorkCount: 1 } } });
    expect(await data.works.list(projectId)).toHaveLength(1);
    expect(data.requests).toHaveLength(3);
    expect((await new JsonDocumentTaskRuntimeRepository(storage, projectId).list()).every(runtime => runtime.status === 'completed')).toBe(true);
    await reopened.waitForMutations();
    const recoveredRuntime = await runtimeRepository.findByResponseExecutionId(execution.responseExecutionId as ConversationResponseExecutionId);
    expect(recoveredRuntime?.runtime).toMatchObject({ status: 'settled', budget: { deadlineAt: completedRuntime.runtime.budget.deadlineAt },
      modelCalls: completedRuntime.runtime.modelCalls, toolCalls: completedRuntime.runtime.toolCalls,
      registeredWorkIds: completedRuntime.runtime.registeredWorkIds });
    expect(recoveredRuntime?.events.slice(-2).map(event => event.kind)).toEqual(['run_stopped', 'run_settled']);
    expect(data.generationSpy).toHaveBeenCalledTimes(1);
  });
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
    for (const [index, contract] of [generation, reading].entries()) {
      expect(data.requests[index].tools).toEqual([{ type: 'function', function: {
        name: contract.toolId, description: contract.description, parameters: canonicalToolInputSchema(contract)
      } }]);
    }
    expect(data.requests[1].messages.filter(message => message.role === 'assistant').at(-1)?.tool_calls).toEqual([data.generationCall]);
    const final = data.requests[2];
    expect(final.tools).toBeUndefined();
    expect(final.tool_choice).toBe('none');
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
        readonly runs: readonly { readonly id: string; readonly parentRunId?: string; readonly conversationId: string; readonly responseExecutionId?: string; readonly status: string }[]
      };
      expect(agentRunDocument.runs).toHaveLength(2);
      const responseRuns = agentRunDocument.runs.filter(run => run.responseExecutionId !== undefined);
      expect(responseRuns).toHaveLength(1);
      const root = agentRunDocument.runs.find(run => run.responseExecutionId === undefined)!;
      expect(root).toMatchObject({ conversationId: 'conversation-generation-read' });
      expect(responseRuns[0]).toMatchObject({
        parentRunId: root.id,
        conversationId: 'conversation-generation-read',
        responseExecutionId: execution.responseExecutionId,
        status: 'completed'
      });
    }, { timeout: 2_000, interval: 25 });
    expect(data.requests).toHaveLength(3);
    const session = (await new JsonConversationAgentSessionRepository(new NodeProjectStorage(data.rootDirectory), projectId)
      .list()).find(item => item.childSegments.some(child => child.responseExecutionId === execution.responseExecutionId));
    expect(session).toMatchObject({ status: 'closed', closedReason: 'completed',
      budget: { maxToolCalls: 8, budgetUnits: 24, toolCallsUsed: 2, costUnitsUsed: 9, toolAttemptsUsed: 2 } });
    expect(session?.childSegments).toMatchObject([
      { runId: session?.id, toolCallsUsed: 0, costUnitsUsed: 0, toolAttemptsUsed: 0 },
      { responseExecutionId: execution.responseExecutionId, toolCallsUsed: 2, costUnitsUsed: 9, toolAttemptsUsed: 2 }
    ]);
    const canonical = await new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(data.rootDirectory), projectId)
      .findByResponseExecutionId(execution.responseExecutionId as ConversationResponseExecutionId);
    expect(canonical?.runtime.budget).toMatchObject({ startedAt: session?.budget.startedAt, deadlineAt: session?.budget.deadlineAt,
      maxToolCalls: session?.budget.maxToolCalls, budgetUnits: session?.budget.budgetUnits });
    expect(session?.registeredWorkIds).toEqual((await data.works.list(projectId)).map(work => work.id));
    expect(data.requests.map(request => request.tools?.[0]?.function.name)).toEqual([
      generation.toolId,
      reading.toolId,
      undefined
    ]);
    expect(execution.content).toContain('真实物理页数：');
    expect(await data.works.list(projectId)).toHaveLength(1);
    expect(runtimes[0].toolCalls).toMatchObject([
      { id: data.generationCall.id, toolId: generation.toolId, status: 'completed' },
      { id: data.readCall.id, toolId: reading.toolId, status: 'completed' }
    ]);
    expect(traces.some(trace => trace.code === 'tool_result' && trace.status === 'completed')).toBe(true);
  });

  it('delivers an ordinary ten-page planning target once and preserves its actual count and warning through the native tool wire', async () => {
    const goal = 10;
    const data = await fixture(false, true, false, false, goal);
    const { execution, traces, runtimes } = await data.run(true);
    expect(data.errors).toEqual([]);
    expect(execution.state).toBe('completed');
    expect(data.requests).toHaveLength(4);
    const canonical = await new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(data.rootDirectory), projectId)
      .findByResponseExecutionId(execution.responseExecutionId as ConversationResponseExecutionId);
    expect(canonical?.runtime.status).toBe('settled');
    expect(canonical?.runtime.modelCalls.map(call => [call.round, call.status])).toEqual([[0, 'completed'], [1, 'completed'], [2, 'completed'], [3, 'completed']]);
    expect(canonical?.runtime.toolCalls.map(call => call.status)).toEqual(['observed', 'observed', 'observed']);
    expect(canonical?.runtime.budget.costUnitsUsed).toBe(9);
    expect(canonical?.runtime.toolCalls.every(call => call.resultHash && call.observationHash)).toBe(true);
    expect(canonical?.runtime.registeredWorkIds).toHaveLength(1);
    expect(canonical?.events.map(event => event.sequence)).toEqual(canonical?.events.map((_, index) => index + 1));
    expect(canonical?.outbox.every(event => event.projected)).toBe(true);
    expect(traces.filter(trace => trace.runId === canonical?.runtime.runId).length).toBeGreaterThan(0);
    const publicTrace = JSON.stringify(traces);
    expect(publicTrace).not.toContain(canonical!.runtime.modelCalls[0].requestHash);
    expect(publicTrace).not.toContain(data.rootDirectory);
    expect(data.requests.map(request => request.tools?.[0]?.function.name)).toEqual([
      generation.toolId, generation.toolId, reading.toolId, undefined
    ]);
    expect(data.generationSpy).toHaveBeenCalledTimes(1);
    expect(data.writes).toHaveLength(1);
    expect(data.render).toHaveBeenCalledTimes(1);
    expect(data.generationSpy.mock.calls[0][0]).toMatchObject({ requestedTotalPages: goal,
      pageRequirement: { mode: 'target', targetPages: goal, countBasis: 'total' } });
    const [work] = await data.works.list(projectId);
    expect(await data.works.list(projectId)).toHaveLength(1);
    const file = (await data.files.get(work.fileId))!;
    expect(file.state).toBe('available');
    if (file.locator.kind !== 'project') throw new Error('Expected registered project file');
    const bytes = await readFile(path.join(data.rootDirectory, file.locator.relativePath));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.checksumSha256);
    expect(bytes.length).toBe(file.sizeBytes);
    const actualPages = (await readPptxDocument(bytes)).length;
    expect(actualPages).toBeGreaterThanOrEqual(3);
    expect(actualPages).toBeLessThan(goal);
    const assessment = { actualPages, actualTotalPages: actualPages, targetPages: goal,
      countBasis: 'total', mode: 'target', satisfied: false, blocking: false };
    expect(await data.generationSpy.mock.results[0].value).toMatchObject({ pageCountAssessment: assessment });
    const feedbackWire = JSON.parse(data.requests[1].messages.find(message => message.tool_call_id === data.generationCall.id)!.content);
    expect(feedbackWire).toMatchObject({ status: 'failed', observation: { planningTargetTotalPages: goal,
      planningTargetIsBlocking: false }, diagnostics: [{ code: 'page_plan_incomplete' }] });
    const generatedMessage = data.requests[2].messages.filter(message => message.role === 'tool').at(-1)!;
    const generatedWire = JSON.parse(generatedMessage.content);
    expect(generatedWire).toMatchObject({ status: 'success', observation: { generated: true,
      pageCount: actualPages, pageCountAssessment: assessment },
      diagnostics: [{ code: 'page_count_deviation', severity: 'warning', message: 'page_count_deviation' }] });
    expect(generatedWire.artifactRefs).toEqual([{ kind: 'work' }]);
    const finalWire = data.requests[3];
    expect(finalWire.tool_choice).toBe('none');
    const repeatedGenerationWire = JSON.parse(finalWire.messages.find(message => message.tool_call_id === generatedMessage.tool_call_id)!.content);
    expect(repeatedGenerationWire).toEqual(generatedWire);
    const readWire = JSON.parse(finalWire.messages.find(message => message.tool_call_id === data.readCall.id)!.content) as ReadResult;
    expect(readWire).toMatchObject({ status: 'success', observation: { pageCount: actualPages, totalSections: actualPages } });
    expect(execution.content).toContain('真实物理页数：' + actualPages);
    for (const marker of markers) expect(execution.content).toContain(marker);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].toolCalls).toMatchObject([
      { id: generatedMessage.tool_call_id, toolId: generation.toolId, status: 'completed' },
      { id: data.readCall.id, toolId: reading.toolId, status: 'completed' }
    ]);
    expect(traces).toContainEqual(expect.objectContaining({ operationId: 'presentation-page-count', status: 'completed',
      facts: expect.objectContaining({ totalPages: actualPages, requestedPages: goal, pageCountMode: 'target',
        pageCountBasis: 'total', diagnosticCode: 'page_count_deviation' }) }));
    for (const stage of ['document-output-structure', 'document-render-diagnostics', 'document-published-hash', 'document-work-register']) {
      expect(traces.some(trace => trace.operationId === stage && trace.status === 'completed')).toBe(true);
    }
    const outgoing = JSON.stringify(data.requests);
    for (const hidden of [data.rootDirectory, work.id, file.id, file.checksumSha256, work.sourceTaskId, work.sourceExecutionId,
      '"rootDirectory"', '"relativePath"', '"currentDocumentId"', '"currentDocumentIR"', '"authorization"', '"abortSignal"',
      '"projectContext"', '"taskContext"']) expect(outgoing).not.toContain(hidden);
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

  it('recovers a known generation failure, redirects a stale generation proposal to one readback and finalizes the existing six-page Work', async () => {
    const data = await fixture(false, true, false, false, 12, false, { staleAfterKnownFailure: true });
    const { execution, runtimes, traces } = await data.run(true);
    expect(execution.state).toBe('completed');
    expect(await data.works.list(projectId)).toHaveLength(1);
    expect(data.generationSpy).toHaveBeenCalledTimes(2);
    expect(data.writes).toHaveLength(1);
    const snapshot = await new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(data.rootDirectory), projectId)
      .findByResponseExecutionId(execution.responseExecutionId as ConversationResponseExecutionId);
    expect(snapshot?.runtime.status).toBe('settled');
    expect(snapshot?.runtime.budget.costUnitsUsed).toBe(17);
    expect(runtimes[0].checkpoint.costUnits).toBe(17);
    expect(runtimes[0].toolCalls.filter(call => call.toolId === generation.toolId)).toHaveLength(2);
    expect(runtimes[0].toolCalls.filter(call => call.toolId === reading.toolId)).toHaveLength(1);
    const finalRequest = data.requests.at(-1)!;
    expect(finalRequest.tools).toBeUndefined();
    expect(finalRequest.tool_choice).toBe('none');
    const readMessage = finalRequest.messages.filter(message => message.role === 'tool').at(-1)!;
    expect(readMessage.tool_call_id).toMatch(/^host-generated-readback-/u);
    expect(JSON.parse(readMessage.content)).toMatchObject({ status: 'success', observation: { pageCount: 6 } });
    expect(execution.content).toContain('实际 6 页');
    expect(execution.content).toContain('原规划目标为 12 页');
    expect(execution.content).toContain('尚未达到该目标');
    expect(traces.some(trace => trace.operationId === 'generation_redirect_readback' && trace.status === 'completed')).toBe(true);
    expect(traces.some(trace => trace.operationId === 'execution_budget' && trace.status === 'failed')).toBe(false);
  });

  it.each(['failed', 'cancelled', 'unknown'] as const)('preserves a verified registered file without changing the %s final-answer outcome', async terminalAfterGeneration => {
    const data = await fixture(false, false, false, false, undefined, false, { terminalAfterGeneration });
    const { execution } = await data.run(true);
    expect(execution.state).toBe(terminalAfterGeneration === 'cancelled' ? 'cancelled' : 'failed');
    const conversation = await new JsonProjectConversationRepository(new NodeProjectStorage(data.rootDirectory), projectId).get(toConversationId('conversation-generation-read'));
    const assistant = conversation?.messages.find(message => message.id === execution.assistantMessageId);
    expect(assistant?.documentResult).toBeUndefined();
    expect(assistant?.retainedDocumentResult).toMatchObject({ kind: 'ppt', actualPageCount: expect.any(Number), workId: expect.any(String) });
    expect(data.requests.at(-1)?.tool_choice).toBe('none');
    expect(data.generationSpy).toHaveBeenCalledTimes(1);
    expect(await data.works.list(projectId)).toHaveLength(1);
    const snapshot = await new JsonConversationAgentRuntimeRepository(new NodeProjectStorage(data.rootDirectory), projectId)
      .findByResponseExecutionId(execution.responseExecutionId as ConversationResponseExecutionId);
    expect(snapshot?.runtime.status).toBe(terminalAfterGeneration === 'failed' ? 'settled' : 'needs_reconciliation');
    expect(execution.parentRun?.state).toBe(terminalAfterGeneration === 'failed' ? 'failed'
      : terminalAfterGeneration === 'cancelled' ? 'cancelled' : 'needs_reconciliation');
    expect(execution.content).not.toContain('系统文件核验');
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
    expect(execution.content).toContain('生成已完成，但当前文件读取被拒绝。');
    expect(execution.content).toContain('当前文件读回未确认');
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
