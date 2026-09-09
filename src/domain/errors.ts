export type DomainErrorCode =
  | 'invalid_state_transition'
  | 'invariant_violation'
  | 'retry_not_allowed'
  | 'work_registration_rejected';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(entity: string, from: string, to: string) {
    super(
      'invalid_state_transition',
      `${entity} cannot transition from ${from} to ${to}`
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export class InvariantViolationError extends DomainError {
  constructor(message: string) {
    super('invariant_violation', message);
    this.name = 'InvariantViolationError';
  }
}

export class RetryNotAllowedError extends DomainError {
  constructor(message: string) {
    super('retry_not_allowed', message);
    this.name = 'RetryNotAllowedError';
  }
}

export class WorkRegistrationRejectedError extends DomainError {
  constructor(message: string) {
    super('work_registration_rejected', message);
    this.name = 'WorkRegistrationRejectedError';
  }
}
