import { randomUUID } from 'node:crypto';
import { copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  createFileReference,
  toFileReferenceId,
  toIsoTimestamp,
  type ProjectId
} from '../../domain';
import type {
  DocumentAttachmentImportDto
} from '../../shared/document-attachment-ipc';
import {
  FileVerificationPersistenceService,
  NodeFileStatusProbe
} from '../files';
import {
  JsonFileIndexRepository,
  JsonFileReferenceRepository
} from '../repositories';
import {
  NodeProjectStorage,
  resolveInsideRoot,
  toProjectRelativePath
} from '../storage';
import {
  FileExtractionService,
  defaultFileExtractionLimits,
  type FileExtractionLimits
} from './file-extraction-service';
import { sanitizeFileName } from './office-document-generator';

export type AttachmentImportErrorCode =
  | 'source_unavailable'
  | 'too_large'
  | 'storage_error';

export class AttachmentImportError extends Error {
  constructor(
    readonly code: AttachmentImportErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AttachmentImportError';
  }
}

export class AttachmentImportService {
  private readonly storage: NodeProjectStorage;
  private readonly files: JsonFileReferenceRepository;
  private readonly fileIndex: JsonFileIndexRepository;
  private readonly extraction: FileExtractionService;

  constructor(
    private readonly options: {
      readonly rootDirectory: string;
      readonly projectId: ProjectId;
      readonly limits?: Partial<FileExtractionLimits>;
      readonly createId?: () => string;
      readonly now?: () => string;
    }
  ) {
    this.storage = new NodeProjectStorage(options.rootDirectory);
    this.files = new JsonFileReferenceRepository(
      this.storage,
      options.projectId
    );
    this.fileIndex = new JsonFileIndexRepository(
      this.storage,
      options.projectId
    );
    this.extraction = new FileExtractionService({
      rootDirectory: options.rootDirectory,
      projectId: options.projectId,
      limits: options.limits
    });
  }

  async importAttachment(input: {
    readonly sourcePath: string;
  }): Promise<DocumentAttachmentImportDto> {
    const createId = this.options.createId ?? (() => randomUUID());
    const now = this.options.now ?? (() => new Date().toISOString());
    let sourceStat;
    try {
      sourceStat = await stat(input.sourcePath);
    } catch {
      throw new AttachmentImportError(
        'source_unavailable',
        'Selected file is unavailable'
      );
    }
    const originalName = path.basename(input.sourcePath);
    if (sourceStat.size > this.maxFileBytes()) {
      throw new AttachmentImportError(
        'too_large',
        `附件超过 ${this.maxFileBytes()} 字节上限`
      );
    }
    const safeName = `${createId()}-${sanitizeFileName(originalName)}`;
    const relativePath = toProjectRelativePath(
      `files/attachments/${safeName}`
    );
    const targetPath = resolveInsideRoot(
      path.resolve(this.options.rootDirectory),
      relativePath
    );
    await this.storage.ensureDirectory(
      toProjectRelativePath('files/attachments')
    );
    try {
      await copyFile(input.sourcePath, targetPath);
    } catch (error) {
      throw new AttachmentImportError(
        'storage_error',
        error instanceof Error ? error.message : 'Failed to import attachment'
      );
    }
    let file = createFileReference({
      id: toFileReferenceId(`attachment-file-${createId()}`),
      projectId: this.options.projectId,
      locator: { kind: 'project', relativePath },
      createdAt: toIsoTimestamp(now())
    });
    await this.files.save(file);
    const probe = new NodeFileStatusProbe(this.options.rootDirectory);
    const persistence = new FileVerificationPersistenceService(
      this.files,
      this.fileIndex,
      probe,
      () => toIsoTimestamp(now())
    );
    const probeResult = await probe.inspect(file);
    file = await persistence.persistProbeResult(file, probeResult);
    if (file.state !== 'available' || file.sizeBytes === undefined) {
      throw new AttachmentImportError(
        'storage_error',
        'Imported attachment did not pass local verification'
      );
    }
    const extraction = await this.extraction.extract(file.id);
    return {
      fileId: file.id,
      fileName: originalName,
      sizeBytes: file.sizeBytes,
      extraction
    };
  }

  private maxFileBytes(): number {
    return this.options.limits?.maxFileBytes ?? defaultFileExtractionLimits.maxFileBytes;
  }
}
