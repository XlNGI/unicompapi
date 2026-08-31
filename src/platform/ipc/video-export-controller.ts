import { randomUUID } from 'node:crypto';
import { access, mkdir, stat, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import {
  addExecutionToTask,
  createExecution,
  createFileReference,
  createRetryExecution,
  createVideoEditingTask,
  createVideoExportPlan,
  registerWork,
  toExecutionId,
  toFileReferenceId,
  toIsoTimestamp,
  toTaskId,
  toVideoEditDraftId,
  toVideoExportPlanId,
  toWorkId,
  transitionExecution,
  type Execution,
  type FileReference,
  type IsoTimestamp,
  type Task,
  type VideoEditDraft,
  type VideoExportInputSnapshot,
  type VideoExportPlan
} from '../../domain';
import type {
  VideoEditorExportPreflightDto,
  VideoEditorExportTaskDto,
  VideoEditorIpcErrorCode,
  VideoEditorIpcResult
} from '../../shared/video-editor-ipc';
import {
  FileVerificationPersistenceService,
  NodeFileStatusProbe,
  resolveFileReferencePathSafely
} from '../files';
import {
  JsonExecutionRepository,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonVideoEditDraftRepository,
  JsonVideoExportPlanRepository,
  JsonWorkRepository,
  computeVideoExportPlanHash
} from '../repositories';
import {
  NodeProjectStorage,
  toProjectRelativePath
} from '../storage';
import type {
  MediaEngineAdapter,
  MediaEngineCompositionExportPlan
} from '../videos';
import type { StorageProjectSession } from './storage-ipc-controller';

const activeExportStates = new Set([
  'queued',
  'validating_sources',
  'preparing_media',
  'encoding',
  'writing_file',
  'verifying_file',
  'registering_work',
  'cancel_requested'
]);

export interface VideoExportControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  getAdapter(): MediaEngineAdapter | undefined;
  now?(): string;
  createId?(): string;
  onError?(error: unknown): void;
  onActiveCountChanged?(count: number): void;
}

interface ExportContext {
  readonly session: StorageProjectSession;
  readonly storage: NodeProjectStorage;
  readonly drafts: JsonVideoEditDraftRepository;
  readonly plans: JsonVideoExportPlanRepository;
  readonly tasks: JsonTaskRepository;
  readonly executions: JsonExecutionRepository;
  readonly files: JsonFileReferenceRepository;
  readonly works: JsonWorkRepository;
  readonly fileIndex: JsonFileIndexRepository;
}

export type ExportLifecycleInterruptionReason =
  | 'system_suspend'
  | 'screen_locked'
  | 'background_processing_disabled'
  | 'application_shutdown';

interface RunningExport {
  readonly adapter: MediaEngineAdapter;
  readonly promise: Promise<void>;
}

export class VideoExportController {
  private readonly running = new Map<string, RunningExport>();
  private readonly lifecycleInterruptions = new Map<
    string,
    ExportLifecycleInterruptionReason
  >();

  constructor(private readonly dependencies: VideoExportControllerDependencies) {}

  async preflightExport(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorExportPreflightDto>> {
    return this.execute(async () => {
      const parsed = parseDraftRequest(request);
      const context = this.context();
      const draft = await requireDraft(context, parsed.draftId, parsed.expectedRevision);
      const checked = await this.preflight(context, draft);
      return checked.dto;
    });
  }

  async startExport(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorExportTaskDto>> {
    return this.execute(async () => {
      const parsed = parseDraftRequest(request);
      const context = this.context();
      const draft = await requireDraft(context, parsed.draftId, parsed.expectedRevision);
      const checked = await this.preflight(context, draft);
      if (!checked.dto.ready) {
        throw exportError('export_preflight_failed', checked.dto.reasons.join('; '));
      }
      const adapter = requireAdapter(this.dependencies.getAdapter());
      const createdAt = this.now();
      const taskId = toTaskId(this.id('video-export-task'));
      const planId = toVideoExportPlanId(this.id('video-export-plan'));
      const executionId = toExecutionId(this.id('video-export-execution'));
      const plan = buildFrozenPlan({
        draft,
        taskId,
        planId,
        checked,
        createdAt
      });
      const task = createVideoEditingTask({
        id: taskId,
        projectId: context.session.projectId,
        draftId: draft.id,
        draftRevision: draft.revision,
        exportPlanId: plan.id,
        title: draft.title,
        confirmedAt: createdAt
      });
      const execution = createExecution({
        id: executionId,
        taskId,
        exportPlanId: plan.id,
        createdAt
      });
      const queued = transitionExecution(execution, 'queued', createdAt);
      await context.plans.save(plan);
      await context.tasks.save(addExecutionToTask(task, queued));
      await context.executions.save(queued);
      await this.persistAttemptPlan(context, plan, queued.attempt);
      this.launch(context, plan, queued, adapter);
      return toTaskDto(task, queued);
    });
  }

  async getExport(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorExportTaskDto>> {
    return this.execute(async () => {
      const context = this.context();
      const task = await requireExportTask(context, parseTaskId(request));
      const execution = await latestExecution(context, task);
      return toTaskDto(task, execution);
    });
  }

  async cancelExport(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorExportTaskDto>> {
    return this.execute(async () => {
      const context = this.context();
      const task = await requireExportTask(context, parseTaskId(request));
      let execution = await latestExecution(context, task);
      if (!['queued', 'validating_sources', 'preparing_media', 'encoding'].includes(execution.state)) {
        throw exportError('export_not_cancellable', 'The export cannot be cancelled in its current state');
      }
      execution = transitionExecution(execution, 'cancel_requested', this.now());
      await context.executions.save(execution);
      const adapter = requireAdapter(this.dependencies.getAdapter());
      const cancelled = await adapter.cancel(execution.id);
      if (cancelled.status !== 'accepted' && !this.running.has(execution.id)) {
        execution = transitionExecution(execution, 'cancelled', this.now());
        await context.executions.save(execution);
      }
      return toTaskDto(task, execution);
    });
  }

  async retryExport(
    request: unknown
  ): Promise<VideoEditorIpcResult<VideoEditorExportTaskDto>> {
    return this.execute(async () => {
      const context = this.context();
      let task = await requireExportTask(context, parseTaskId(request));
      const previous = await latestExecution(context, task);
      const retry = createRetryExecution(
        previous,
        toExecutionId(this.id('video-export-execution')),
        this.now()
      );
      const queued = transitionExecution(retry, 'queued', retry.createdAt);
      task = addExecutionToTask(task, queued);
      const plan = await context.plans.get(requirePlanId(task));
      if (!plan) throw exportError('export_not_found', 'The frozen export plan is unavailable');
      await context.tasks.save(task);
      await context.executions.save(queued);
      await this.persistAttemptPlan(context, plan, queued.attempt);
      this.launch(context, plan, queued, requireAdapter(this.dependencies.getAdapter()));
      return toTaskDto(task, queued);
    });
  }

  async recoverExports(): Promise<
    VideoEditorIpcResult<{ readonly recoveryRequired: number }>
  > {
    return this.execute(async () => {
      const context = this.context();
      const tasks = (await context.tasks.list(context.session.projectId))
        .filter((task) => task.submission.kind === 'video_editing');
      let recoveryRequired = 0;
      for (const task of tasks) {
        const execution = await latestExecution(context, task);
        if (!activeExportStates.has(execution.state)) continue;
        if (execution.state === 'registering_work') {
          const recovered = await recoverWorkRegistration(
            context,
            task,
            execution,
            this.now()
          );
          if (recovered) continue;
        }
        if (execution.state === 'cancel_requested') {
          await context.executions.save(
            transitionExecution(execution, 'cancelled', this.now())
          );
          continue;
        }
        const interrupted = execution.state === 'interrupted'
          ? execution
          : transitionExecution(execution, 'interrupted', this.now());
        const recovery = transitionExecution(interrupted, 'recovery_required', this.now());
        await context.executions.save(recovery);
        recoveryRequired += 1;
      }
      return { recoveryRequired };
    });
  }

  get activeExportCount(): number {
    return this.running.size;
  }

  async interruptActiveExports(
    reason: ExportLifecycleInterruptionReason
  ): Promise<number> {
    const entries = [...this.running.entries()];
    for (const [executionId, running] of entries) {
      this.lifecycleInterruptions.set(executionId, reason);
      await running.adapter.cancel(executionId).catch((error) => {
        this.dependencies.onError?.(error);
        return { status: 'not_running' as const };
      });
    }
    await Promise.allSettled(entries.map(([, running]) => running.promise));
    return entries.length;
  }

  waitForExports(): Promise<void> {
    return Promise.all([...this.running.values()].map((running) => running.promise))
      .then(() => undefined);
  }

  private launch(
    context: ExportContext,
    plan: VideoExportPlan,
    execution: Execution,
    adapter: MediaEngineAdapter
  ): void {
    const promise = this.run(context, plan, execution, adapter)
      .catch((error) => this.dependencies.onError?.(error))
      .finally(() => {
        this.running.delete(execution.id);
        this.lifecycleInterruptions.delete(execution.id);
        this.dependencies.onActiveCountChanged?.(this.running.size);
      });
    this.running.set(execution.id, { adapter, promise });
    this.dependencies.onActiveCountChanged?.(this.running.size);
  }

  private async run(
    context: ExportContext,
    plan: VideoExportPlan,
    initial: Execution,
    adapter: MediaEngineAdapter
  ): Promise<void> {
    let execution = initial;
    try {
      execution = await this.move(context, execution, 'validating_sources');
      if (await this.finishLifecycleInterruption(context, execution)) return;
      if (await this.finishCancellation(context, execution)) return;
      const resolved = await verifyFrozenInputs(context, plan, adapter);
      if (await this.finishLifecycleInterruption(context, execution)) return;
      execution = await this.move(context, execution, 'preparing_media');
      if (await this.finishLifecycleInterruption(context, execution)) return;
      if (await this.finishCancellation(context, execution)) return;
      const outputPath = resolvePlanOutput(context.session.rootDirectory, plan);
      try {
        await mkdir(path.dirname(outputPath), { recursive: true });
      } catch {
        throw new NeedsUserActionError(
          'destination_unavailable',
          'The export destination could not be created'
        );
      }
      await assertOutputCapacity(outputPath, plan.estimatedOutputBytes);
      if (await this.finishLifecycleInterruption(context, execution)) return;
      const renderPlan = toMediaEnginePlan(plan, execution, resolved, outputPath);
      execution = await this.move(context, execution, 'encoding');
      if (await this.finishLifecycleInterruption(context, execution)) return;
      if (await this.finishCancellation(context, execution)) return;
      let progressQueue = Promise.resolve();
      const existing = await adapter.verifyOutput(outputPath);
      if (existing.status === 'invalid' && existing.reason !== 'missing') {
        throw new ExportRunError(
          'not_retryable',
          'The reserved export path contains an invalid artifact'
        );
      }
      if (existing.status === 'verified' && plan.output.conflictPolicy === 'fail') {
        throw new ExportRunError(
          'not_retryable',
          'The export destination already contains a file'
        );
      }
      const result = existing.status === 'verified'
        ? { status: 'completed' as const, output: existing }
        : await adapter.export(renderPlan, {
            onProgress: (progress) => {
              progressQueue = progressQueue.then(async () => {
                const current = await context.executions.get(execution.id);
                if (!current || current.state !== 'encoding') return;
                const updated: Execution = { ...current, progress, updatedAt: this.now() };
                await context.executions.save(updated);
              });
            }
          });
      await progressQueue;
      execution = (await context.executions.get(execution.id)) ?? execution;
      if (await this.finishLifecycleInterruption(context, execution)) return;
      if (result.status === 'cancelled') {
        if (execution.state !== 'cancel_requested') {
          execution = transitionExecution(execution, 'cancel_requested', this.now());
        }
        await context.executions.save(
          transitionExecution(execution, 'cancelled', this.now())
        );
        return;
      }
      if (result.status === 'failed') {
        throw new ExportRunError(
          result.code === 'invalid_plan' ? 'not_retryable' : 'retryable',
          `Media engine export failed (${result.code})`
        );
      }
      execution = await this.move(context, execution, 'writing_file');
      if (await this.finishLifecycleInterruption(context, execution)) return;
      execution = await this.move(context, execution, 'verifying_file');
      const independent = await adapter.verifyOutput(outputPath);
      if (await this.finishLifecycleInterruption(context, execution)) return;
      if (independent.status !== 'verified') {
        throw new ExportRunError('retryable', 'Published output failed independent verification');
      }
      if (
        independent.width !== renderPlan.composition.canvas.width ||
        independent.height !== renderPlan.composition.canvas.height ||
        Math.abs(independent.durationUs - expectedPlanDurationUs(plan)) > 500_000
      ) {
        throw new ExportRunError(
          'retryable',
          'Published output does not match the frozen export plan'
        );
      }
      const file = await registerOutputFile(context, plan, execution, this.now());
      if (await this.finishLifecycleInterruption(context, execution)) return;
      const workId = toWorkId(this.id('video-export-work'));
      execution = await this.move(context, execution, 'registering_work', {
        outputFileId: file.id,
        workId
      });
      if (await this.finishLifecycleInterruption(context, execution)) return;
      const work = registerWork({
        id: workId,
        task: await requireExportTask(context, execution.taskId),
        execution,
        file,
        mediaKind: 'video',
        name: plan.output.fileName,
        parentWorkId: plan.parentWorkId,
        createdAt: this.now()
      });
      await context.works.save(work);
      execution = transitionExecution(execution, 'completed', this.now(), {
        outputFileId: file.id,
        workId
      });
      await context.executions.save(execution);
    } catch (error) {
      this.dependencies.onError?.(error);
      if (await this.finishLifecycleInterruption(context, execution)) return;
      const current = (await context.executions.get(execution.id)) ?? execution;
      if (current.state === 'cancel_requested') {
        await context.executions.save(
          transitionExecution(current, 'cancelled', this.now())
        );
        return;
      }
      if (current.state === 'completed' || current.state === 'cancelled') return;
      if (error instanceof NeedsUserActionError) {
        await context.executions.save(
          transitionExecution(current, 'needs_user_action', this.now(), {
            userAction: {
              code: error.code,
              message: error.message
            }
          })
        );
        return;
      }
      const retryability = error instanceof ExportRunError
        ? error.retryability
        : 'retryable';
      const failed = transitionExecution(current, 'failed', this.now(), {
        failure: {
          stage: current.state,
          message: error instanceof ExportRunError
            ? error.message
            : 'Local export failed before verified work registration',
          retryability
        }
      });
      await context.executions.save(failed);
    }
  }

  private async move(
    context: ExportContext,
    execution: Execution,
    state: Parameters<typeof transitionExecution>[1],
    details: Parameters<typeof transitionExecution>[3] = {}
  ): Promise<Execution> {
    const current = (await context.executions.get(execution.id)) ?? execution;
    if (current.state === 'cancel_requested') return current;
    const updated = transitionExecution(current, state, this.now(), details);
    await context.executions.save(updated);
    return updated;
  }

  private async finishCancellation(
    context: ExportContext,
    execution: Execution
  ): Promise<boolean> {
    if (execution.state !== 'cancel_requested') return false;
    await context.executions.save(
      transitionExecution(execution, 'cancelled', this.now())
    );
    return true;
  }

  private async finishLifecycleInterruption(
    context: ExportContext,
    execution: Execution
  ): Promise<boolean> {
    if (!this.lifecycleInterruptions.has(execution.id)) return false;
    const current = (await context.executions.get(execution.id)) ?? execution;
    if (current.state === 'completed' || current.state === 'cancelled') return true;
    if (current.state === 'cancel_requested') {
      await context.executions.save(
        transitionExecution(current, 'cancelled', this.now())
      );
      return true;
    }
    const interrupted = current.state === 'interrupted'
      ? current
      : transitionExecution(current, 'interrupted', this.now());
    await context.executions.save(
      transitionExecution(interrupted, 'recovery_required', this.now())
    );
    return true;
  }

  private async preflight(context: ExportContext, draft: VideoEditDraft) {
    const reasons: string[] = [];
    if (draft.videoTrack.length === 0) reasons.push('The timeline has no video clips');
    validateOutputPreferences(draft, reasons);
    const adapter = this.dependencies.getAdapter();
    let capabilities;
    if (!adapter) {
      reasons.push('The approved local media engine is unavailable');
    } else {
      try {
        capabilities = await adapter.getCapabilities();
        if (!capabilities.videoEncoders.includes('libvpx-vp9')) {
          reasons.push('The media engine does not provide libvpx-vp9');
        }
        if (!capabilities.audioEncoders.includes('libopus')) {
          reasons.push('The media engine does not provide libopus');
        }
        if (!capabilities.containers.includes('webm')) {
          reasons.push('The media engine does not provide the WebM container');
        }
        const requiredFilters = new Set(['concat', 'scale', 'pad', 'atrim', 'amix']);
        if (draft.videoTrack.some((clip) => clip.transitionToNext.kind !== 'none')) {
          requiredFilters.add('xfade');
          requiredFilters.add('acrossfade');
        }
        if (draft.textTrack.length > 0) requiredFilters.add('drawtext');
        if (draft.canvas.background.kind === 'blur_source') requiredFilters.add('gblur');
        for (const filter of requiredFilters) {
          if (!capabilities.filters.includes(filter)) {
            reasons.push(`The media engine does not provide the ${filter} filter`);
          }
        }
        for (const fontFamily of new Set(
          draft.textTrack.map((overlay) => overlay.style.requestedFontFamily)
        )) {
          if (!(await adapter.validateFontFamily(fontFamily))) {
            reasons.push(`The requested font is unavailable (${fontFamily})`);
          }
        }
      } catch {
        reasons.push('The media engine capability probe failed');
      }
    }
    const inputChecks = await collectAndVerifyDraftInputs(context, draft, reasons);
    const estimatedOutputBytes = estimateOutputBytes(draft);
    return {
      dto: {
        ready: reasons.length === 0,
        reasons,
        output: {
          container: 'webm' as const,
          videoCodec: 'libvpx-vp9' as const,
          audioCodec: 'libopus' as const,
          hardwareAcceleration: 'software_only' as const
        },
        estimatedOutputBytes
      },
      capabilities,
      inputChecks
    };
  }

  private async persistAttemptPlan(
    context: ExportContext,
    plan: VideoExportPlan,
    attempt: number
  ): Promise<void> {
    await context.storage.writeJsonAtomically(
      toProjectRelativePath(`tmp/editor/${plan.taskId}/${attempt}/export-plan.json`),
      plan
    );
  }

  private context(): ExportContext {
    const session = this.dependencies.getSession();
    if (!session) throw exportError('project_not_open', 'Open a project before exporting');
    const storage = new NodeProjectStorage(session.rootDirectory);
    return {
      session,
      storage,
      drafts: new JsonVideoEditDraftRepository(storage, session.projectId),
      plans: new JsonVideoExportPlanRepository(storage, session.projectId),
      tasks: new JsonTaskRepository(storage, session.projectId),
      executions: new JsonExecutionRepository(storage),
      files: new JsonFileReferenceRepository(storage, session.projectId),
      works: new JsonWorkRepository(storage, session.projectId),
      fileIndex: new JsonFileIndexRepository(storage, session.projectId)
    };
  }

  private now(): IsoTimestamp {
    return toIsoTimestamp(this.dependencies.now?.() ?? new Date().toISOString());
  }

  private id(prefix: string): string {
    return `${prefix}-${this.dependencies.createId?.() ?? randomUUID()}`;
  }

  private async execute<T>(operation: () => Promise<T>): Promise<VideoEditorIpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      const known = error instanceof VideoExportControllerError;
      return {
        ok: false,
        error: {
          code: known ? error.code : 'export_failed',
          message: known ? error.message : 'The local video export operation failed'
        }
      };
    }
  }
}

function validateOutputPreferences(draft: VideoEditDraft, reasons: string[]): void {
  const preference = draft.outputPreference;
  const expected = [
    [preference.container, 'webm', 'container'],
    [preference.videoCodec, 'libvpx-vp9', 'video codec'],
    [preference.audioCodec, 'libopus', 'audio codec']
  ] as const;
  for (const [value, supported, label] of expected) {
    if (value.kind === 'capability' && value.valueId !== supported) {
      reasons.push(`The requested ${label} is unavailable (${value.valueId})`);
    }
  }
  if (preference.resolution.kind === 'capability') {
    reasons.push(`The requested resolution is unavailable (${preference.resolution.valueId})`);
  }
  if (preference.frameRate.kind === 'capability') {
    reasons.push(`The requested frame rate is unavailable (${preference.frameRate.valueId})`);
  }
  if (preference.quality.kind === 'capability') {
    reasons.push(`The requested quality mode is unavailable (${preference.quality.valueId})`);
  }
  if (preference.destinationId) {
    reasons.push('The requested export destination is not available in the project-local pipeline');
  }
}

class VideoExportControllerError extends Error {
  constructor(readonly code: VideoEditorIpcErrorCode, message: string) {
    super(message);
  }
}

class ExportRunError extends Error {
  constructor(
    readonly retryability: 'retryable' | 'not_retryable',
    message: string
  ) {
    super(message);
  }
}

class NeedsUserActionError extends Error {
  constructor(
    readonly code: 'source_unavailable' | 'destination_unavailable',
    message: string
  ) {
    super(message);
  }
}

function exportError(code: VideoEditorIpcErrorCode, message: string) {
  return new VideoExportControllerError(code, message);
}

function parseDraftRequest(value: unknown) {
  if (!isRecord(value) || typeof value.draftId !== 'string' ||
    !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) {
    throw exportError('invalid_request', 'A draft ID and expected revision are required');
  }
  return {
    draftId: toVideoEditDraftId(value.draftId),
    expectedRevision: Number(value.expectedRevision)
  };
}

function parseTaskId(value: unknown) {
  if (!isRecord(value) || typeof value.taskId !== 'string' || !value.taskId.trim()) {
    throw exportError('invalid_request', 'A task ID is required');
  }
  return toTaskId(value.taskId);
}

async function requireDraft(
  context: ExportContext,
  id: ReturnType<typeof toVideoEditDraftId>,
  revision: number
): Promise<VideoEditDraft> {
  const draft = await context.drafts.get(id);
  if (!draft) throw exportError('draft_not_found', 'The video edit draft does not exist');
  if (draft.revision !== revision) {
    throw exportError('draft_conflict', 'The video edit draft changed before export');
  }
  return draft;
}

async function requireExportTask(context: ExportContext, id: ReturnType<typeof toTaskId>) {
  const task = await context.tasks.get(id);
  if (!task || task.submission.kind !== 'video_editing') {
    throw exportError('export_not_found', 'The video export task does not exist');
  }
  return task;
}

function requirePlanId(task: Task) {
  if (task.submission.kind !== 'video_editing') {
    throw exportError('export_not_found', 'The task has no video export plan');
  }
  return task.submission.videoEditing.exportPlanId;
}

async function latestExecution(context: ExportContext, task: Task) {
  const id = task.executionIds[task.executionIds.length - 1];
  const execution = id ? await context.executions.get(id) : undefined;
  if (!execution) throw exportError('export_not_found', 'The export attempt is unavailable');
  return execution;
}

function requireAdapter(adapter: MediaEngineAdapter | undefined): MediaEngineAdapter {
  if (!adapter) throw exportError('adapter_unavailable', 'The approved local media engine is unavailable');
  return adapter;
}

interface VerifiedInput {
  readonly file: FileReference;
  readonly path: string;
  readonly hasAudio?: boolean;
  readonly sizeBytes?: number;
  readonly checksumSha256?: string;
  readonly modifiedAtMs?: number;
}

async function collectAndVerifyDraftInputs(
  context: ExportContext,
  draft: VideoEditDraft,
  reasons: string[]
): Promise<Map<string, VerifiedInput>> {
  const fileIds = new Set(draft.videoTrack.map((clip) => clip.source.fileId));
  if (draft.backgroundMusic) fileIds.add(draft.backgroundMusic.fileId);
  if (draft.cover?.prependToVideo && draft.cover.kind !== 'video_frame') {
    fileIds.add(draft.cover.fileId);
  }
  const result = new Map<string, VerifiedInput>();
  for (const fileId of fileIds) {
    const file = await context.files.get(fileId);
    if (!file) {
      reasons.push(`A referenced source file record is missing (${fileId})`);
      continue;
    }
    const probe = await new NodeFileStatusProbe(context.session.rootDirectory)
      .inspect(file, { expectedChecksum: file.checksumSha256 });
    if (probe.recommendedState !== 'available' || !probe.verification ||
      probe.verification.matchesExpected === false) {
      reasons.push(`A source file is unavailable or changed (${fileId})`);
      continue;
    }
    const sourcePath = await resolveFileReferencePathSafely(
      context.session.rootDirectory,
      file
    );
    const metadata = await stat(sourcePath);
    result.set(fileId, {
      file,
      path: sourcePath,
      sizeBytes: probe.verification.sizeBytes,
      checksumSha256: probe.verification.checksumSha256,
      modifiedAtMs: Math.round(metadata.mtimeMs)
    });
  }
  for (const clip of draft.videoTrack) {
    const checked = result.get(clip.source.fileId);
    if (checked && !sameIdentity(checked, clip.source.identity)) {
      reasons.push(`A clip source identity changed (${clip.id})`);
    }
  }
  if (draft.backgroundMusic) {
    const checked = result.get(draft.backgroundMusic.fileId);
    if (checked && !sameIdentity(checked, draft.backgroundMusic.identity)) {
      reasons.push('The background music identity changed');
    }
  }
  return result;
}

function sameIdentity(
  checked: VerifiedInput,
  expected: { readonly sizeBytes: number; readonly checksumSha256?: string }
): boolean {
  return checked.sizeBytes === expected.sizeBytes &&
    (!expected.checksumSha256 || checked.checksumSha256 === expected.checksumSha256);
}

async function verifyFrozenInputs(
  context: ExportContext,
  plan: VideoExportPlan,
  adapter: MediaEngineAdapter
): Promise<Map<string, VerifiedInput>> {
  const result = new Map<string, VerifiedInput>();
  for (const input of plan.inputs) {
    const file = await context.files.get(input.fileId);
    if (!file) {
      throw new NeedsUserActionError(
        'source_unavailable',
        'A frozen source file is missing'
      );
    }
    const probe = await new NodeFileStatusProbe(context.session.rootDirectory)
      .inspect(file, { expectedChecksum: input.identity.checksumSha256 });
    if (!probe.verification || probe.recommendedState !== 'available' ||
      probe.verification.sizeBytes !== input.identity.sizeBytes ||
      (input.identity.checksumSha256 &&
        probe.verification.checksumSha256 !== input.identity.checksumSha256)) {
      throw new NeedsUserActionError(
        'source_unavailable',
        'A frozen source identity no longer matches'
      );
    }
    const sourcePath = await resolveFileReferencePathSafely(
      context.session.rootDirectory,
      file
    );
    let mediaProbe;
    try {
      mediaProbe = input.role.kind === 'clip'
        ? await adapter.probe({ sourcePath })
        : undefined;
    } catch {
      throw new NeedsUserActionError(
        'source_unavailable',
        'A frozen source media stream could not be read'
      );
    }
    result.set(input.fileId, {
      file,
      path: sourcePath,
      hasAudio: mediaProbe?.streams.some((stream) => stream.type === 'audio')
    });
  }
  return result;
}

function buildFrozenPlan(input: {
  readonly draft: VideoEditDraft;
  readonly taskId: ReturnType<typeof toTaskId>;
  readonly planId: ReturnType<typeof toVideoExportPlanId>;
  readonly checked: Awaited<ReturnType<VideoExportController['preflight']>>;
  readonly createdAt: IsoTimestamp;
}): VideoExportPlan {
  const { draft, checked } = input;
  if (!checked.capabilities) throw exportError('adapter_unavailable', 'Media engine capabilities are unavailable');
  const inputs: VideoExportInputSnapshot[] = draft.videoTrack.map((clip) => ({
    fileId: clip.source.fileId,
    role: { kind: 'clip' as const, clipId: clip.id },
    identity: structuredClone(clip.source.identity)
  }));
  if (draft.backgroundMusic) {
    inputs.push({
      fileId: draft.backgroundMusic.fileId,
      role: { kind: 'background_music' },
      identity: structuredClone(draft.backgroundMusic.identity)
    });
  }
  if (draft.cover?.prependToVideo && draft.cover.kind !== 'video_frame') {
    const checkedCover = checked.inputChecks.get(draft.cover.fileId);
    if (!checkedCover?.sizeBytes || !checkedCover.checksumSha256) {
      throw exportError('export_preflight_failed', 'The selected cover is not verified');
    }
    inputs.push({
      fileId: draft.cover.fileId,
      role: { kind: 'cover' },
      identity: {
        sizeBytes: checkedCover.sizeBytes,
        modifiedAtMs: checkedCover.modifiedAtMs ?? 0,
        container: path.extname(checkedCover.path).slice(1).toLowerCase() || 'image',
        checksumSha256: checkedCover.checksumSha256
      }
    });
  }
  const fileName = safeExportName(
    draft.outputPreference.fileName ?? draft.title
  ).replace(/\.webm$/i, '') || 'video-export';
  const relativePath = draft.outputPreference.conflictPolicy === 'fail'
    ? `files/results/${fileName}.webm`
    : `files/results/${fileName}-${input.planId.slice(-8)}.webm`;
  const material = {
    id: input.planId,
    projectId: draft.projectId,
    taskId: input.taskId,
    draftId: draft.id,
    draftRevision: draft.revision,
    title: draft.title,
    inputs,
    timeline: {
      canvas: draft.canvas,
      clips: draft.videoTrack,
      textTrack: draft.textTrack,
      backgroundMusic: draft.backgroundMusic,
      cover: draft.cover
    },
    output: {
      relativePath,
      fileName: `${fileName}.webm`,
      conflictPolicy: draft.outputPreference.conflictPolicy,
      container: 'webm' as const,
      videoCodec: 'libvpx-vp9' as const,
      audioCodec: 'libopus' as const,
      resolution: { kind: 'source' as const },
      frameRate: { kind: 'source' as const },
      quality: { kind: 'crf' as const, value: 32 as const },
      hardwareAcceleration: 'software_only' as const
    },
    engine: {
      adapterId: checked.capabilities.descriptor.adapterId,
      adapterVersion: checked.capabilities.descriptor.adapterVersion,
      engineVersion: checked.capabilities.version,
      videoEncoder: 'libvpx-vp9' as const,
      audioEncoder: 'libopus' as const,
      container: 'webm' as const
    },
    estimatedOutputBytes: checked.dto.estimatedOutputBytes,
    parentWorkId: draft.sourceIntent.kind === 'from_work'
      ? draft.sourceIntent.sourceWorkId
      : undefined,
    createdAt: input.createdAt
  };
  const provisional = createVideoExportPlan({
    ...material,
    planHash: '0'.repeat(64)
  });
  return {
    ...provisional,
    planHash: computeVideoExportPlanHash(provisional)
  };
}

function toMediaEnginePlan(
  plan: VideoExportPlan,
  execution: Execution,
  resolved: Map<string, VerifiedInput>,
  outputPath: string
): MediaEngineCompositionExportPlan {
  const first = plan.timeline.clips[0].source.identity;
  const ratio = plan.timeline.canvas.aspectRatio.kind === 'source'
    ? first.width / first.height
    : plan.timeline.canvas.aspectRatio.numerator /
      plan.timeline.canvas.aspectRatio.denominator;
  const height = even(Math.max(2, first.height));
  const width = even(Math.max(2, Math.round(height * ratio)));
  return {
    jobId: execution.id,
    outputPath,
    composition: {
      clips: plan.timeline.clips.map((clip) => ({
        source: { sourcePath: requireResolved(resolved, clip.source.fileId).path },
        sourceRange: clip.sourceRange,
        speed: clip.speed,
        transform: clip.transform,
        sourceAudio: clip.sourceAudio,
        transitionToNext: clip.transitionToNext,
        hasAudio: requireResolved(resolved, clip.source.fileId).hasAudio === true
      })),
      canvas: {
        width,
        height,
        transformPolicy: plan.timeline.canvas.transformPolicy,
        background: plan.timeline.canvas.background
      },
      textTrack: plan.timeline.textTrack,
      backgroundMusic: plan.timeline.backgroundMusic
        ? {
            source: {
              sourcePath: requireResolved(
                resolved,
                plan.timeline.backgroundMusic.fileId
              ).path
            },
            sourceRange: plan.timeline.backgroundMusic.sourceRange,
            timelineRange: plan.timeline.backgroundMusic.timelineRange,
            volumePermille: plan.timeline.backgroundMusic.volumePermille,
            fadeInUs: plan.timeline.backgroundMusic.fadeInUs,
            fadeOutUs: plan.timeline.backgroundMusic.fadeOutUs
          }
        : undefined,
      cover: toMediaEngineCover(plan, resolved)
    },
    videoCodec: 'libvpx-vp9',
    audioCodec: 'libopus'
  };
}

function toMediaEngineCover(
  plan: VideoExportPlan,
  resolved: Map<string, VerifiedInput>
): MediaEngineCompositionExportPlan['composition']['cover'] {
  const cover = plan.timeline.cover;
  if (!cover?.prependToVideo) return undefined;
  if (cover.kind === 'video_frame') {
    const clip = plan.timeline.clips.find((candidate) => candidate.id === cover.clipId);
    if (!clip) throw new ExportRunError('not_retryable', 'The cover clip is absent from the frozen timeline');
    return {
      source: { sourcePath: requireResolved(resolved, clip.source.fileId).path },
      kind: 'video_frame',
      sourceTimeUs: cover.sourceTimeUs,
      durationUs: requirePrependDuration(cover.prependDurationUs)
    };
  }
  return {
    source: { sourcePath: requireResolved(resolved, cover.fileId).path },
    kind: 'image',
    durationUs: requirePrependDuration(cover.prependDurationUs)
  };
}

function requireResolved(result: Map<string, VerifiedInput>, id: string) {
  const input = result.get(id);
  if (!input) throw new ExportRunError('retryable', 'A frozen source could not be resolved');
  return input;
}

async function registerOutputFile(
  context: ExportContext,
  plan: VideoExportPlan,
  execution: Execution,
  now: IsoTimestamp
): Promise<FileReference> {
  let file = createFileReference({
    id: toFileReferenceId(`video-export-file-${randomUUID()}`),
    projectId: context.session.projectId,
    sourceExecutionId: execution.id,
    locator: { kind: 'project', relativePath: plan.output.relativePath },
    createdAt: now
  });
  await context.files.save(file);
  const probe = new NodeFileStatusProbe(context.session.rootDirectory);
  const persistence = new FileVerificationPersistenceService(
    context.files,
    context.fileIndex,
    probe,
    () => toIsoTimestamp(new Date().toISOString())
  );
  const result = await probe.inspect(file);
  file = await persistence.persistProbeResult(file, result);
  if (file.state !== 'available' || !file.checksumSha256 || file.sizeBytes === undefined) {
    throw new ExportRunError('retryable', 'The published output was not locally verified');
  }
  return file;
}

function resolvePlanOutput(root: string, plan: VideoExportPlan): string {
  const relative = toProjectRelativePath(plan.output.relativePath);
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix)) throw new ExportRunError('not_retryable', 'Output path escaped project storage');
  return target;
}

async function assertOutputCapacity(outputPath: string, estimated: number): Promise<void> {
  const directory = path.dirname(outputPath);
  try {
    await access(directory, constants.W_OK);
  } catch {
    throw new NeedsUserActionError(
      'destination_unavailable',
      'The export destination is not writable'
    );
  }
  let space;
  try {
    space = await statfs(directory);
  } catch {
    throw new NeedsUserActionError(
      'destination_unavailable',
      'The export destination space is unavailable'
    );
  }
  const available = Number(space.bavail) * Number(space.bsize);
  if (available < estimated * 1.1) {
    throw new NeedsUserActionError(
      'destination_unavailable',
      'The export destination does not have enough free space'
    );
  }
}

function estimateOutputBytes(draft: VideoEditDraft): number {
  const durationUs = draft.videoTrack.reduce((total, clip, index) => {
    const duration = Math.round(
      (clip.sourceRange.outUs - clip.sourceRange.inUs) *
      clip.speed.denominator / clip.speed.numerator
    );
    const previous = index > 0 ? draft.videoTrack[index - 1].transitionToNext : { kind: 'none' as const };
    return total + duration - (previous.kind === 'none' ? 0 : previous.durationUs);
  }, 0);
  return Math.max(1_048_576, Math.ceil(durationUs / 1_000_000 * 1_000_000));
}

function expectedPlanDurationUs(plan: VideoExportPlan): number {
  const timeline = plan.timeline.clips.reduce((total, clip, index) => {
    const duration = Math.round(
      (clip.sourceRange.outUs - clip.sourceRange.inUs) *
      clip.speed.denominator / clip.speed.numerator
    );
    const previous = index > 0
      ? plan.timeline.clips[index - 1].transitionToNext
      : { kind: 'none' as const };
    return total + duration - (previous.kind === 'none' ? 0 : previous.durationUs);
  }, 0);
  return timeline + (plan.timeline.cover?.prependToVideo
    ? requirePrependDuration(plan.timeline.cover.prependDurationUs)
    : 0);
}

function requirePrependDuration(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || !value || value <= 0) {
    throw new ExportRunError('not_retryable', 'The frozen cover prepend duration is invalid');
  }
  return value;
}

function safeExportName(value: string): string {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return (normalized || 'video-export').slice(0, 80);
}

function even(value: number): number {
  return value % 2 === 0 ? value : value - 1;
}

function toTaskDto(task: Task, execution: Execution): VideoEditorExportTaskDto {
  const canCancel = ['queued', 'validating_sources', 'preparing_media', 'encoding']
    .includes(execution.state);
  const canRetry = execution.state === 'cancelled' ||
    execution.state === 'expired' ||
    execution.state === 'interrupted' ||
    execution.state === 'recovery_required' ||
    execution.state === 'needs_user_action' ||
    (execution.state === 'failed' && execution.failure?.retryability === 'retryable');
  return {
    taskId: task.id,
    executionId: execution.id,
    attempt: execution.attempt,
    state: execution.state,
    progress: execution.progress,
    canCancel,
    canRetry,
    workId: execution.workId,
    requiredAction: execution.userAction,
    failure: execution.failure
      ? {
          message: execution.failure.message,
          retryability: execution.failure.retryability
        }
      : undefined,
    updatedAt: execution.updatedAt
  };
}

async function recoverWorkRegistration(
  context: ExportContext,
  task: Task,
  execution: Execution,
  now: IsoTimestamp
): Promise<boolean> {
  if (!execution.outputFileId || !execution.workId) return false;
  const file = await context.files.get(execution.outputFileId);
  const plan = execution.exportPlanId
    ? await context.plans.get(execution.exportPlanId)
    : undefined;
  if (!file || !plan || file.state !== 'available' || !file.checksumSha256 ||
    file.sizeBytes === undefined) {
    return false;
  }
  let work = await context.works.get(execution.workId);
  if (!work) {
    work = registerWork({
      id: execution.workId,
      task,
      execution,
      file,
      mediaKind: 'video',
      name: plan.output.fileName,
      parentWorkId: plan.parentWorkId,
      createdAt: now
    });
    await context.works.save(work);
  }
  if (
    work.sourceExecutionId !== execution.id ||
    work.fileId !== file.id ||
    work.sourceTaskId !== task.id
  ) return false;
  await context.executions.save(
    transitionExecution(execution, 'completed', now, {
      outputFileId: file.id,
      workId: work.id
    })
  );
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
