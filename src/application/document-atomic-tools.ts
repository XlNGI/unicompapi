import {
  canonicalToolInputSchema,
  validateCanonicalToolArguments,
  type CanonicalToolArguments,
  type CanonicalToolContract,
  type DocumentToolResult,
  type ToolExecutionContext
} from '../domain/entities/canonical-tool-contract';

/** Injected by the host. Never added to the model-visible input schema. */
export interface DocumentAtomicExecutionContext extends ToolExecutionContext {
  readonly callId: string;
  readonly idempotencyKey: string;
}

/** A runtime binding has behavior and a catalog reference, never its own fields/schema. */
export interface DocumentAtomicToolBinding {
  readonly contract: CanonicalToolContract;
  authorize(args: CanonicalToolArguments, context: DocumentAtomicExecutionContext): Promise<boolean>;
  execute(args: CanonicalToolArguments, context: DocumentAtomicExecutionContext): Promise<DocumentToolResult>;
}

/** Compatibility entry points; both delegate to the independent canonical contract. */
export function atomicToolSchema(binding: DocumentAtomicToolBinding): Readonly<Record<string, unknown>> {
  return canonicalToolInputSchema(binding.contract);
}

export function parseAtomicToolArguments(binding: DocumentAtomicToolBinding, value: unknown): CanonicalToolArguments {
  return validateCanonicalToolArguments(binding.contract, value);
}
