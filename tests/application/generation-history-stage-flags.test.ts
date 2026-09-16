import { describe, expect, it } from 'vitest';
import { resolveHistoryStageFlags } from '../../src/components/GenerationHistory';

function flags(input: Partial<Parameters<typeof resolveHistoryStageFlags>[0]> = {}) {
  return resolveHistoryStageFlags({
    livePhase: 'idle',
    ...input
  });
}

describe('generation history stage flags', () => {
  it('shows the in-flight preview when nothing is selected and a generation is running', () => {
    const result = flags({ livePhase: 'waiting' });
    expect(result.generationInFlight).toBe(true);
    expect(result.showLoadingPreview).toBe(true);
    expect(result.generationFailed).toBe(false);
    expect(result.generationUncertain).toBe(false);
  });

  it('prefers the uncertain status node the user selected over the running generation', () => {
    const result = flags({ livePhase: 'waiting', selectedStatusKind: 'uncertain' });
    expect(result.showLoadingPreview).toBe(false);
    expect(result.generationUncertain).toBe(true);
    expect(result.generationFailed).toBe(false);
  });

  it('prefers the failed status node the user selected over the running generation', () => {
    const result = flags({ livePhase: 'waiting', selectedStatusKind: 'failed' });
    expect(result.showLoadingPreview).toBe(false);
    expect(result.generationFailed).toBe(true);
    expect(result.generationUncertain).toBe(false);
  });

  it('keeps the running preview when the selected node is itself still in progress', () => {
    for (const kind of ['pending', 'awaiting_receipt', 'receiving'] as const) {
      const result = flags({ livePhase: 'idle', selectedStatusKind: kind });
      expect(result.isSelectedStatusActive).toBe(true);
      expect(result.showLoadingPreview).toBe(true);
    }
  });

  it('does not mix live failure into the selected uncertain node headline', () => {
    const result = flags({ livePhase: 'failed', selectedStatusKind: 'uncertain' });
    expect(result.generationFailed).toBe(false);
    expect(result.generationUncertain).toBe(true);
    expect(result.showLoadingPreview).toBe(false);
  });

  it('keeps a real preview work visible while another generation runs', () => {
    const result = flags({ livePhase: 'waiting', previewWorkId: 'work-1' });
    expect(result.generationInFlight).toBe(true);
    expect(result.showLoadingPreview).toBe(false);
  });

  it('falls back to the live submission state when no status node is selected', () => {
    expect(flags({ livePhase: 'failed' }).generationFailed).toBe(true);
    expect(flags({ livePhase: 'uncertain' }).generationUncertain).toBe(true);
    expect(flags({ livePhase: 'submission_uncertain' }).generationUncertain).toBe(true);
    const idle = flags();
    expect(idle.showLoadingPreview).toBe(false);
    expect(idle.generationFailed).toBe(false);
    expect(idle.generationUncertain).toBe(false);
  });

  // 调用点在 completed 窗口必定用 expectedWorkId 兜底 previewWorkId，因此“已完成但尚无
  // previewWorkId”这一组合在生产路径不可达；此断言只用于防止再次加入不会生效的进行中条件。
  it('does not treat a completed submission as in-flight before the work reaches the list', () => {
    const withoutPreviewWork = flags({ livePhase: 'completed' });
    expect(withoutPreviewWork.generationInFlight).toBe(false);
    expect(withoutPreviewWork.showLoadingPreview).toBe(false);
  });

  it('keeps the registered work visible after completion instead of a loading state', () => {
    const result = flags({ livePhase: 'completed', previewWorkId: 'work-1' });
    expect(result.generationInFlight).toBe(false);
    expect(result.showLoadingPreview).toBe(false);
  });
});
