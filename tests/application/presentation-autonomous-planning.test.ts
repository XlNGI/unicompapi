import { describe, expect, it, vi } from 'vitest';
import { planPresentationArtDirection, type PresentationArtDirectionRequest } from '../../src/application/presentation-art-direction';
import { planExecutablePresentationDesign, requestPresentationDesignCorrection } from '../../src/platform/documents/presentation-design-planning';
import { resolvePresentationTemplate } from '../../src/platform/documents/presentation-template';
import { buildFallbackPresentationDesignIR, buildPresentationArtDirectionInput, buildPresentationArtDirectionPrompt, buildPresentationDesignIRJsonSchema } from '../../src/domain/entities/presentation-design-contract';
import { authoredFixtureDesign, autonomousOutline, splitTree } from '../fixtures/presentation-autonomous-design';

const base = { outline: autonomousOutline, userRequirement: '自主设计，左侧65%，右侧35%', signal: new AbortController().signal,
  tokens: resolvePresentationTemplate('business_minimal').tokens, assets: [], availableAssets: [], requireDesignTree: true };
describe('bounded autonomous design planning and correction', () => {
  it('requires executable trees for new autonomous requests while preserving explicit v2 compatibility', async () => {
    const request = vi.fn(async () => buildFallbackPresentationDesignIR(autonomousOutline));
    expect((await planPresentationArtDirection({ ...base, request })).diagnostics).toEqual([{ code: 'design_tree_missing' }]);
    expect((await planPresentationArtDirection({ ...base, requireDesignTree: false, request })).designIR).toBeDefined();
  });
  it('advertises supported autonomous grammar and excludes non-executable enum choices', () => {
    const input = buildPresentationArtDirectionInput(base);
    const prompt = buildPresentationArtDirectionPrompt(input);
    expect(prompt).toContain('Author designTree'); expect(prompt).toContain('UTF-16');
    expect(prompt).not.toMatch(/Allowed composition principle:[^\n]*(?:full-bleed|radial)/u);
    expect(buildPresentationDesignIRJsonSchema()).toHaveProperty('$defs.designNode');
  });
  it('projects only local semantic asset aliases and rejects unknown image bindings', async () => {
    const tree = splitTree();
    const design = authoredFixtureDesign(autonomousOutline, { ...tree, root: { nodeId: 'row', type: 'row', children: [
      { ...tree.root, nodeId: 'copy' }, { nodeId: 'photo', type: 'image', assetKey: 'image-1', imageFit: 'cover' }
    ] } });
    const result = await planPresentationArtDirection({ ...base, request: async () => design });
    expect(result.diagnostics).toEqual([{ code: 'design_asset_unavailable' }]);
    const allowed = await planPresentationArtDirection({ ...base, availableAssets: [{ assetKey: 'image-1', aspectRatio: 1.5 }], request: async () => design });
    expect(allowed.designIR).toEqual(design);
  });
  it('returns concrete failed node diagnostics to the planner and preserves unaffected pages', async () => {
    const original = authoredFixtureDesign(autonomousOutline, splitTree());
    const bad = { ...original, pages: original.pages.map(page => page.pageNumber !== 2 ? page : { ...page,
      designTree: { ...page.designTree!, root: { ...page.designTree!.root, children: page.designTree!.root.children!.map(node => node.nodeId !== 'main' ? node : {
        ...node, children: node.children!.map(child => ({ ...child, style: { fontSize: 96 } })) }) } } }) };
    const request = vi.fn(async ({ input }: PresentationArtDirectionRequest) => input.designFeedback ? original : bad);
    const result = await planExecutablePresentationDesign({ ...base, request });
    expect(result.designIR).toEqual(original); expect(result.correctionCount).toBe(1); expect(request).toHaveBeenCalledTimes(2);
    const feedback = request.mock.calls[1][0].input.designFeedback!;
    expect(feedback.targetPages).toEqual([2]); expect(feedback.diagnostics.some(item => item.code === 'font_below_minimum' && item.nodeId)).toBe(true);
  });
  it('stops after two corrections for an unchanged infeasible design', async () => {
    const design = authoredFixtureDesign(autonomousOutline, { schemaVersion: 1, root: { nodeId: 'bad', type: 'overlay', children: [
      { ...splitTree().root, nodeId: 'copy', anchor: 'center', widthFraction: 0.05, heightFraction: 0.05 }
    ] } });
    const request = vi.fn(async () => design);
    const result = await planExecutablePresentationDesign({ ...base, request });
    expect(result.designIR).toBeUndefined(); expect(result.diagnostics[0].code).toBe('design_execution_failed');
    expect(request).toHaveBeenCalledTimes(3);
  });
  it.each(['global', 'non-target'] as const)('rejects %s edits in a target-page correction', async mode => {
    const previousDesign = authoredFixtureDesign();
    const changed = mode === 'global' ? { ...previousDesign, globalDesign: { ...previousDesign.globalDesign, visualTone: 'bold' as const } }
      : { ...previousDesign, pages: previousDesign.pages.map(page => page.pageNumber !== 1 ? page : { ...page, pageIntent: 'Changed outside target' }) };
    const result = await requestPresentationDesignCorrection({ ...base, previousDesign, targetPages: [2],
      diagnostics: [{ code: 'text_overflow', pageNumber: 2 }], request: async () => changed });
    expect(result.diagnostics).toEqual([{ code: 'design_repair_scope_violation' }]);
  });
  it('does not execute a planner after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const request = vi.fn(async () => authoredFixtureDesign());
    await expect(planExecutablePresentationDesign({ ...base, signal: controller.signal, request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
