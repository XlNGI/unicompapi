import type {
  ViduLiveValidationIpcErrorCode,
  ViduLiveValidationIpcResult,
  ViduLiveValidationStatusDto
} from '../../../shared/provider-ipc';
import {
  ViduLiveValidationApplicationError,
  type ViduLiveValidationApplicationService
} from './vidu-live-validation-service';
import type { ViduLiveValidationRecord } from './vidu-live-validation';

export class ViduLiveValidationController {
  constructor(
    private readonly service: ViduLiveValidationApplicationService
  ) {}

  async getStatus(): Promise<ViduLiveValidationIpcResult> {
    try {
      return {
        ok: true,
        value: toStatusDto(await this.service.load())
      };
    } catch {
      return failure('validation_operation_failed');
    }
  }

  async start(input: unknown): Promise<ViduLiveValidationIpcResult> {
    try {
      return {
        ok: true,
        value: toStatusDto(await this.service.start(input))
      };
    } catch (error) {
      return failure(mapError(error));
    }
  }
}

function toStatusDto(
  record: ViduLiveValidationRecord | undefined
): ViduLiveValidationStatusDto {
  if (!record) {
    return {
      status: 'not_started',
      budget: {
        image: { claimState: 'not_available', billingFact: 'not_attempted' },
        video: { claimState: 'not_available', billingFact: 'not_attempted' }
      },
      events: []
    };
  }
  return {
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    stopCode: record.stopCode ?? undefined,
    budget: {
      image: {
        claimState: record.budget.image.claimState,
        billingFact: record.budget.image.billingFact
      },
      video: {
        claimState: record.budget.video.claimState,
        billingFact: record.budget.video.billingFact
      }
    },
    events: record.events.map((event) => ({
      sequence: event.sequence,
      stage: event.stage,
      state: event.state,
      recordedAt: event.recordedAt,
      errorCode: event.errorCode ?? undefined,
      providerState: event.providerState ?? undefined
    }))
  };
}

function mapError(error: unknown): ViduLiveValidationIpcErrorCode {
  if (!(error instanceof ViduLiveValidationApplicationError)) {
    return 'validation_operation_failed';
  }
  if (
    error.code === 'invalid_request' ||
    error.code === 'already_started' ||
    error.code === 'connection_not_ready'
  ) {
    return error.code;
  }
  return 'validation_operation_failed';
}

function failure(code: ViduLiveValidationIpcErrorCode): ViduLiveValidationIpcResult {
  const messages: Record<ViduLiveValidationIpcErrorCode, string> = {
    invalid_request: 'Every live validation approval must be confirmed',
    already_started: 'The approved Vidu live validation has already started',
    connection_not_ready: 'The Vidu credential or credits validation is unavailable',
    validation_operation_failed: 'The Vidu live validation operation failed safely'
  };
  return { ok: false, error: { code, message: messages[code] } };
}
