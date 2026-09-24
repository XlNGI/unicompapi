import type { DocumentToolId, WorkId } from '../domain';
import type {
  DocumentGenerationProgressEvent,
  DocumentGenerationRuntimeSession
} from './document-generation-service';
import type { DocumentTaskRuntimeService, DocumentTaskRuntimeScope } from './document-task-runtime-service';

/**
 * Bridges the existing deterministic document runner lifecycle into the
 * durable Task Runtime. Progress is reduced to the allow-listed tool set;
 * raw content, paths and model details never enter an Observation.
 */
export class DocumentGenerationRuntimeBridge implements DocumentGenerationRuntimeSession {
  readonly executionId: string;
  private readonly active = new Map<string, ActiveCall>();
  private sequence = 0;

  constructor(
    private readonly service: DocumentTaskRuntimeService,
    private readonly scope: DocumentTaskRuntimeScope,
    executionId: string
  ) {
    this.executionId = executionId;
  }

  async start(): Promise<void> {
    await this.service.start(this.scope);
  }

  async progress(event: DocumentGenerationProgressEvent): Promise<void> {
    const toolId = toolForEvent(event.code);
    if (!toolId || event.status === 'progress') return;
    const key = operationKey(event);
    if (event.status === 'started') {
      if (this.active.has(key)) return;
      const inputHash = await sha256Hex(JSON.stringify([
        toolId,
        event.operationId ?? event.code,
        event.facts ?? null
      ]));
      const callId = `generation-${this.sequence + 1}`;
      const { runtime } = await this.service.beginToolCall(this.scope, { callId, toolId, inputHash });
      this.sequence += 1;
      const call = runtime.toolCalls?.find((item) => item.id === callId);
      this.active.set(key, {
        callId,
        toolId,
        step: call?.step ?? runtime.checkpoint.step
      });
      return;
    }
    const active = this.active.get(key);
    // A late/duplicate terminal event is harmless. If the start was never
    // durably recorded, executing a guessed observation would be unsafe.
    if (!active) return;
    await this.service.recordObservation(this.scope, active.callId, {
      step: active.step,
      toolId: active.toolId,
      ok: event.status === 'completed',
      data: {
        status: event.status,
        code: event.code,
        ...(event.facts ?? {})
      },
      ...(event.status === 'completed' ? {} : { diagnostic: safeDiagnostic(event.code) })
    });
    this.active.delete(key);
  }

  async complete(workId: WorkId | string): Promise<void> {
    const runtime = await this.service.require(this.scope);
    if (runtime.status === 'completed') {
      await this.service.complete(this.scope, String(workId));
      return;
    }
    if (this.active.size > 0) {
      // A runner cannot publish a completed Work while a progress operation
      // is still unsettled. Reconcile instead of guessing its side effect.
      await this.service.setStatus(this.scope, 'failed');
      return;
    }
    await this.service.complete(this.scope, String(workId));
  }

  async fail(status: 'failed' | 'cancelled'): Promise<void> {
    const runtime = await this.service.require(this.scope);
    if (['completed', 'failed', 'cancelled', 'needs_reconciliation'].includes(runtime.status)) return;
    await this.service.setStatus(this.scope, status);
  }

  async runtime() {
    return this.service.require(this.scope);
  }
}

async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('runtime_hash_unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

interface ActiveCall {
  readonly callId: string;
  readonly toolId: DocumentToolId;
  readonly step: number;
}

function operationKey(event: DocumentGenerationProgressEvent): string {
  const code = event.code === 'tool_result' ? 'tool_call' : event.code;
  return `${code}:${event.operationId ?? code}`;
}

function toolForEvent(code: DocumentGenerationProgressEvent['code']): DocumentToolId | undefined {
  switch (code) {
    case 'plan_validation':
    case 'document_structure_check':
    case 'document_hash_check':
      return 'read_document_structure';
    case 'tool_call':
    case 'tool_result':
    case 'document_compile':
    case 'document_publish':
    case 'document_register':
      return 'apply_document_patch';
    case 'document_render':
      return 'render_preview';
    case 'document_check':
      return 'inspect_layout';
    default:
      return undefined;
  }
}

function safeDiagnostic(code: string): string {
  return `document_${code}_failed`;
}
