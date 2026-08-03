import {
  ViduLiveValidationApplicationError,
  type ViduLiveValidationApplicationService
} from './vidu-live-validation-service';
import type { ViduLiveValidationRecord } from './vidu-live-validation';
import {
  denyViduRuntimeAuthorization,
  ViduRuntimeAuthorizationClosedError
} from './vidu-runtime-authorization-closure';

type ViduLiveValidationIpcErrorCode =
  | 'invalid_request'
  | 'already_started'
  | 'connection_not_ready'
  | 'runtime_authorization_closed'
  | 'validation_operation_failed';

interface ViduLiveValidationStatusDto {
  readonly status: 'not_started' | 'active' | 'passed' | 'failed' | 'blocked';
  readonly startedAt?: string;
  readonly updatedAt?: string;
  readonly stopCode?: string;
  readonly budget: {
    readonly image: ViduLiveValidationBudgetStatusDto;
    readonly video: ViduLiveValidationBudgetStatusDto;
  };
  readonly events: readonly ViduLiveValidationEventStatusDto[];
}

interface ViduLiveValidationBudgetStatusDto {
  readonly claimState: 'available' | 'claimed' | 'not_available';
  readonly billingFact:
    | 'not_attempted'
    | 'attempt_claimed'
    | 'accepted_or_completed'
    | 'failed_before_submission'
    | 'submission_outcome_unknown';
}

interface ViduLiveValidationEventStatusDto {
  readonly sequence: number;
  readonly stage: ViduLiveValidationRecord['events'][number]['stage'];
  readonly state: ViduLiveValidationRecord['events'][number]['state'];
  readonly recordedAt: string;
  readonly errorCode?: string;
  readonly providerState?: string;
}

type ViduLiveValidationIpcResult =
  | { readonly ok: true; readonly value: ViduLiveValidationStatusDto }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ViduLiveValidationIpcErrorCode;
        readonly message: string;
      };
    };

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
      // The historical flow-8 validation channel is permanently closed here.
      // This guard runs before the service can read credentials or validate credits.
      denyViduRuntimeAuthorization();
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
  if (error instanceof ViduRuntimeAuthorizationClosedError) {
    return 'runtime_authorization_closed';
  }
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
    runtime_authorization_closed:
      'Vidu submissions and live validation are disabled until formal runtime authorization is approved',
    validation_operation_failed: 'The Vidu live validation operation failed safely'
  };
  return { ok: false, error: { code, message: messages[code] } };
}
