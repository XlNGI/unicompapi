import { describe, expect, it, vi } from 'vitest';
import {
  ConversationWebResearchService,
  type ConversationWebResearchPort
} from '../../src/application';
import {
  createConversationWorkflow,
  toConversationId,
  toConversationWorkflowId,
  toMessageId,
  toProjectId,
  toIsoTimestamp,
  type ConversationWorkflowV1
} from '../../src/domain';

function workflow(sourcePolicy: 'web' | 'mixed' = 'web'): ConversationWorkflowV1 {
  return createConversationWorkflow({
    id: toConversationWorkflowId('workflow-web-1'),
    projectId: toProjectId('project-web-1'),
    conversationId: toConversationId('conversation-web-1'),
    sourceMessageId: toMessageId('message-web-1'),
    plan: {
      schemaVersion: 1,
      kind: 'document',
      action: 'create',
      documentKind: 'word',
      parameters: { topic: '公开政策' },
      sourcePolicy,
      missing: [],
      ambiguities: [],
      confidence: 'high',
      needsConfirmation: false
    },
    createdAt: toIsoTimestamp('2026-09-04T00:00:00.000Z')
  });
}

const emptyLocal = { retrieve: vi.fn(async () => []) };

describe('conversation web research orchestration', () => {
  it('keeps local-first mixed research offline when local evidence is sufficient', async () => {
    const search = vi.fn<ConversationWebResearchPort['search']>();
    const service = new ConversationWebResearchService(
      { search },
      {
        enabled: true,
        providerName: 'synthetic-provider',
        allowedDomains: ['example.com'],
        outboundSummary: '仅发送主题关键词',
        allowMixedQueries: true,
        localResultThreshold: 1
      }
    );
    const result = await service.preview({
      workflow: workflow('mixed'),
      conversationRevision: 1,
      query: '最新政策',
      local: {
        retrieve: vi.fn(async () => [{
          chunkId: 'chunk-1',
          sourceKind: 'brand_guideline',
          source: '本地资料',
          text: '本地命中',
          contentHash: 'a'.repeat(64),
          indexVersion: 'bm25-v1'
        }])
      }
    });
    expect(result.status).toBe('local_ready');
    expect(result.references[0]?.kind).toBe('local');
    expect(search).not.toHaveBeenCalled();
  });

  it('returns a preview and requires explicit authorization before web search', async () => {
    const search = vi.fn<ConversationWebResearchPort['search']>(async () => ({
      status: 'completed',
      evidence: [{
        citationId: 'web-1',
        title: '官方来源',
        url: 'https://example.com/policy',
        domain: 'example.com',
        summary: '公开信息',
        retrievedAt: '2026-09-04T00:00:00.000Z',
        contentHash: 'b'.repeat(64)
      }]
    }));
    const service = new ConversationWebResearchService(
      { search },
      {
        enabled: true,
        providerName: 'synthetic-provider',
        allowedDomains: ['example.com'],
        outboundSummary: '仅发送主题关键词',
        allowMixedQueries: true
      },
      () => '2026-09-04T00:00:00.000Z'
    );
    const preview = await service.preview({
      workflow: workflow(),
      conversationRevision: 1,
      query: '最新政策',
      local: emptyLocal
    });
    expect(preview.status).toBe('authorization_required');
    expect(search).not.toHaveBeenCalled();
    const authorized = await service.authorize({
      workflow: workflow(),
      conversationRevision: 1,
      planHash: preview.planHash,
      confirmed: true
    });
    expect(authorized.status).toBe('completed');
    expect(authorized.references[0]).toMatchObject({ kind: 'web', domain: 'example.com' });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the provider is not configured or the authorization does not match', async () => {
    const service = new ConversationWebResearchService(
      { search: vi.fn() },
      {
        enabled: false,
        allowedDomains: [],
        outboundSummary: '未配置',
        allowMixedQueries: false
      }
    );
    const preview = await service.preview({
      workflow: workflow(),
      conversationRevision: 1,
      query: '公开信息',
      local: emptyLocal
    });
    expect(preview.status).toBe('unavailable');
    expect(preview.failureCode).toBe('web_provider_unconfigured');

    const enabled = new ConversationWebResearchService(
      { search: vi.fn() },
      {
        enabled: true,
        providerName: 'synthetic-provider',
        allowedDomains: ['example.com'],
        outboundSummary: '仅发送主题关键词',
        allowMixedQueries: true
      }
    );
    const authorizedPreview = await enabled.preview({
      workflow: workflow(),
      conversationRevision: 1,
      query: '公开信息',
      local: emptyLocal
    });
    const mismatch = await enabled.authorize({
      workflow: workflow(),
      conversationRevision: 2,
      planHash: authorizedPreview.planHash,
      confirmed: true
    });
    expect(mismatch.failureCode).toBe('web_authorization_mismatch');
  });
});
