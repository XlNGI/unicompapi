import { describe, expect, it } from 'vitest';
import { PlatformDocumentDraftCompiler } from '../../src/platform/documents/document-generation-application-adapters';
import { parseDocumentContent } from '../../src/platform/documents/document-outline-parser';

describe('document IR compilation bridge', () => {
  it('compiles a Word outline into stable IR for a revision', () => {
    const outline = parseDocumentContent('# 项目方案\n\n## 背景\n\n第一版内容。\n\n## 风险\n\n新增风险说明。', 'word');
    const compiler = new PlatformDocumentDraftCompiler();
    const ir = compiler.compileIR!({
      outline,
      operation: 'edit',
      attachmentRefs: ['work-1'],
      revision: { baseWorkId: 'work-1', expectedRevision: 2 }
    });
    expect(ir).toMatchObject({ operation: 'edit', attachmentRefs: ['work-1'], revision: { baseWorkId: 'work-1' } });
    expect(ir.content?.sections).toHaveLength(2);
  });
});
