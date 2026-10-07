import type { ControlledProviderToolBridge, ControlledProviderToolRoundResponse } from './provider-tool-calling';
import { emitProductionEvent } from '../conversation-production-trace';

/** A Host receipt, never a Provider request parameter or model-controlled state. */
export interface DocumentGenerationFinalizationState {
  readonly phase: 'readback' | 'final';
  readonly readBackConfirmed: boolean;
  readonly actualTotalPages?: number;
  readonly planningTotalPages?: number;
}

export interface DocumentFinalizationToolBridge extends ControlledProviderToolBridge {
  readonly finalizationState?: () => DocumentGenerationFinalizationState | undefined;
}

export function documentGenerationFinalization(bridge?: ControlledProviderToolBridge): DocumentGenerationFinalizationState | undefined {
  return (bridge as DocumentFinalizationToolBridge | undefined)?.finalizationState?.();
}

/** One read-back followed by one tool-free answer. It cannot generate or edit. */
export function createDocumentGenerationFinalizer(bridge?: ControlledProviderToolBridge) {
  let redirected = false;
  let hostExplanationNeeded = false;
  return {
    async normalize<T extends ControlledProviderToolRoundResponse>(response: T, modelRound: number): Promise<T> {
      const state = documentGenerationFinalization(bridge);
      if (!state) return response;
      if (state.phase === 'readback' && !redirected) {
        redirected = true;
        const proposed = response.toolCalls ?? [];
        const alreadyReading = response.finishReason === 'tool_calls' && proposed.length === 1 &&
          proposed[0].name === 'read_document_structure' && proposed[0].arguments.scope === 'document' &&
          Object.keys(proposed[0].arguments).length === 1;
        if (alreadyReading) return response;
        await emitProductionEvent({ code: 'tool_authorization', status: 'completed',
          operationId: 'generation_redirect_readback', facts: { tool: 'read_sources', purpose: 'tool', count: 1 } });
        // Preserve the original model-result hash in the caller. This is an
        // explicit Host decision; the durable tool boundary records this read.
        return { ...response, finishReason: 'tool_calls', toolCalls: [{
          id: `host-generated-readback-${modelRound}`, name: 'read_document_structure', arguments: { scope: 'document' }
        }] } as T;
      }
      if (state.phase === 'final' && response.finishReason === 'tool_calls') {
        hostExplanationNeeded = true;
        await emitProductionEvent({ code: 'tool_authorization', status: 'completed',
          operationId: 'generation_final_tool_proposal_rejected', facts: { tool: 'read_sources', purpose: 'tool', count: response.toolCalls?.length ?? 0 } });
        return { ...response, finishReason: 'stop', toolCalls: undefined } as T;
      }
      return response;
    },
    finalExplanation(): string | undefined {
      const state = documentGenerationFinalization(bridge);
      if (!state || state.phase !== 'final') return undefined;
      if (!state.readBackConfirmed || !Number.isSafeInteger(state.actualTotalPages) || state.actualTotalPages! < 1) {
        return '\n\n系统交付记录：PPT 已生成并登记，但当前文件读回未确认；请核对文件后再继续修改。';
      }
      if (!hostExplanationNeeded && (state.planningTotalPages === undefined || state.planningTotalPages === state.actualTotalPages)) return undefined;
      return '\n\n系统文件核验：PPT 已生成并登记，实际 ' + state.actualTotalPages + ' 页。' +
        (state.planningTotalPages !== undefined && state.planningTotalPages !== state.actualTotalPages
          ? '原规划目标为 ' + state.planningTotalPages + ' 页，当前文件尚未达到该目标。' : '重复工具请求已停止。');
    }
  };
}
