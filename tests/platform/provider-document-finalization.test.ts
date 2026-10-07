import { describe, expect, it, vi } from 'vitest';
import { createDocumentGenerationFinalizer, type DocumentFinalizationToolBridge,
  type DocumentGenerationFinalizationState } from '../../src/platform/providers/provider-document-finalization';

function fixture(initial?: DocumentGenerationFinalizationState) {
  let state = initial;
  const bridge: DocumentFinalizationToolBridge = { execute: vi.fn(), finalizationState: () => state };
  return { finalizer: createDocumentGenerationFinalizer(bridge), setState: (next?: DocumentGenerationFinalizationState) => { state = next; }, bridge };
}

describe('Host-owned ordinary document finalization', () => {
  it('does not change combined generation/mutation or non-document responses without a Host receipt', async () => {
    const data = fixture();
    const response = { finishReason: 'tool_calls', toolCalls: [{ id: 'mutation', name: 'update_element', arguments: {} }] };
    expect(await data.finalizer.normalize(response, 0)).toBe(response);
    expect(data.finalizer.finalExplanation()).toBeUndefined();
  });

  it.each(['stop', 'tool_calls'])('redirects a %s proposal to one full read without changing its original object', async finishReason => {
    const data = fixture({ phase: 'readback', readBackConfirmed: false });
    const response = { content: 'Model proposal', finishReason, toolCalls: [{ id: 'stale', name: 'generate_pptx', arguments: { title: 'Title', content: 'Body' } }] };
    const before = JSON.stringify(response);
    const normalized = await data.finalizer.normalize(response, 2);
    expect(JSON.stringify(response)).toBe(before);
    expect(normalized).toMatchObject({ finishReason: 'tool_calls', toolCalls: [{ id: 'host-generated-readback-2', name: 'read_document_structure', arguments: { scope: 'document' } }] });
    expect(data.bridge.execute).not.toHaveBeenCalled();
  });

  it('replaces an invalid document read proposal with the permitted complete read', async () => {
    const data = fixture({ phase: 'readback', readBackConfirmed: false });
    const normalized = await data.finalizer.normalize({ finishReason: 'tool_calls', toolCalls: [{ id: 'bad-read', name: 'read_document_structure', arguments: { scope: 'document', ordinal: 3 } }] }, 1);
    expect(normalized.toolCalls?.[0].arguments).toEqual({ scope: 'document' });
  });

  it('keeps known failed readback separate from a successful file read', async () => {
    const data = fixture({ phase: 'final', readBackConfirmed: false });
    const normalized = await data.finalizer.normalize({ finishReason: 'tool_calls', toolCalls: [{ id: 'extra', name: 'generate_pptx', arguments: {} }] }, 2);
    expect(normalized).toMatchObject({ finishReason: 'stop', toolCalls: undefined });
    expect(data.finalizer.finalExplanation()).toContain('当前文件读回未确认');
    expect(data.finalizer.finalExplanation()).not.toContain('系统文件核验');
  });

  it('cannot print a verified page count from a missing Host count or withdrawn unknown/cancelled receipt', async () => {
    const data = fixture({ phase: 'final', readBackConfirmed: true, planningTotalPages: 12 });
    expect(data.finalizer.finalExplanation()).toContain('当前文件读回未确认');
    expect(data.finalizer.finalExplanation()).not.toContain('undefined');
    data.setState(undefined);
    const response = { finishReason: 'tool_calls', toolCalls: [{ id: 'still-proposed', name: 'generate_pptx', arguments: {} }] };
    expect(await data.finalizer.normalize(response, 2)).toBe(response);
    expect(data.finalizer.finalExplanation()).toBeUndefined();
  });
});
