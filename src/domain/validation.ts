import { InvariantViolationError } from './errors';

export function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new InvariantViolationError(`${field} cannot be empty`);
  }

  return normalized;
}

export function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvariantViolationError(
      `${field} must be a non-negative safe integer`
    );
  }

  return value;
}

export function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvariantViolationError(`${field} must be a positive safe integer`);
  }

  return value;
}

export function requireSha256(value: string): string {
  const normalized = value.toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new InvariantViolationError('checksum must be a SHA-256 hex digest');
  }

  return normalized;
}
