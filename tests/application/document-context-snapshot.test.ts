import { describe, expect, it } from 'vitest';
import { buildDocumentContextSnapshot } from '../../src/application';
import { parseDocumentContextSnapshot } from '../../src/domain';

describe('document context snapshot', () => {
  it('builds a bounded snapshot with a stable request hash', async () => {
    const snapshot = await buildDocumentContextSnapshot({
      projectId: 'project-1',
      conversationId: 'conversation-1',
      sourceMessageId: 'message-1',
      requestText: '制作季度经营汇报 PPT',
      attachments: [{ fileId: 'file-1', contentHash: 'A'.repeat(64) }],
      existingDocuments: [{ documentRef: 'message-old', kind: 'ppt', fileName: 'old.pptx' }],
      styleConstraints: ['简洁商务风格']
    });
    expect(snapshot.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.sourcePolicy).toBe('internal_only');
    expect(parseDocumentContextSnapshot(snapshot)).toEqual(snapshot);
  });

  it('rejects unsupported fields, paths and protected values', () => {
    expect(() => parseDocumentContextSnapshot({
      schemaVersion: 1,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      sourceMessageId: 'message-1',
      requestText: '制作 PPT',
      requestHash: 'a'.repeat(64),
      attachments: [],
      existingDocuments: [],
      references: [{ sourceId: 'brand-1', sourceKind: 'brand', contentHash: 'b'.repeat(64), excerpt: 'C:\\secret\\brand.md' }],
      styleConstraints: [],
      sourcePolicy: 'internal_only',
      truncated: false
    })).toThrow();
    expect(() => parseDocumentContextSnapshot({
      schemaVersion: 1,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      sourceMessageId: 'message-1',
      requestText: 'api_key: sk-test',
      requestHash: 'a'.repeat(64),
      attachments: [],
      existingDocuments: [],
      references: [],
      styleConstraints: [],
      sourcePolicy: 'internal_only',
      truncated: false
    })).toThrow();
  });
});
