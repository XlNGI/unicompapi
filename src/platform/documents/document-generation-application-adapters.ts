import {
  DocumentDraftCompilationError,
  DocumentGenerationApplicationError,
  type DocumentDraftCompilerPort,
  type DocumentGenerationExecutionInput,
  type DocumentGenerationExecutionResult,
  type DocumentGenerationExecutorPort
} from '../../application';
import {
  DocumentGenerationError,
  type DocumentGenerationRunner
} from './document-generation-runner';
import {
  DocumentOutlineError,
  parseDocumentContent,
  recoverDocumentContent,
  stripPreamble
} from './document-outline-parser';
import { PresentationLayoutError } from './office-document-generator';

export class PlatformDocumentDraftCompiler implements DocumentDraftCompilerPort {
  compile(input: Parameters<DocumentDraftCompilerPort['compile']>[0]) {
    return withCompilationErrors(() =>
      parseDocumentContent(stripPreamble(input.content), input.kind)
    );
  }

  recover(input: Parameters<DocumentDraftCompilerPort['recover']>[0]) {
    return withCompilationErrors(() =>
      recoverDocumentContent(stripPreamble(input.content), input.kind)
    );
  }
}

export class PlatformDocumentGenerationExecutor
  implements DocumentGenerationExecutorPort {
  constructor(private readonly runner: DocumentGenerationRunner) {}

  async run(
    input: DocumentGenerationExecutionInput
  ): Promise<DocumentGenerationExecutionResult> {
    try {
      const result = await this.runner.run(input);
      return {
        taskId: result.task.id,
        executionId: result.execution.id,
        workId: result.work.id,
        fileName:
          result.file.locator.kind === 'project'
            ? result.file.locator.relativePath.split('/').pop() ?? result.work.name
            : result.work.name,
        sizeBytes: result.file.sizeBytes ?? 0
      };
    } catch (error) {
      if (error instanceof PresentationLayoutError) {
        throw new DocumentGenerationApplicationError(
          'layout_overflow',
          error.message
        );
      }
      if (error instanceof DocumentGenerationError) {
        throw new DocumentGenerationApplicationError(
          error.code === 'cancelled'
            ? 'cancelled'
            : error.code === 'generation_failed' ||
                error.code === 'verification_failed'
              ? 'generation_failed'
              : 'storage_error',
          error.message
        );
      }
      throw error;
    }
  }
}

function withCompilationErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof DocumentOutlineError) {
      throw new DocumentDraftCompilationError(
        isResourceLimitError(error.message)
          ? 'resource_limit'
          : 'invalid_structure',
        error.message
      );
    }
    throw error;
  }
}

function isResourceLimitError(message: string): boolean {
  return /exceeds|budget|maximum|too large/i.test(message);
}
