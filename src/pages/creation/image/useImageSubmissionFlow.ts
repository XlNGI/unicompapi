import { useEffect, useState } from 'react';
import type {
  ImageExecutionDto,
  ImagePreflightCandidateDto,
  ImagePreflightDto,
  ImageSubmissionConfirmationDto,
  ImageSubmissionErrorCode,
  ImageTaskCreatedDto,
  ImageWorkRegisteredDto
} from '../../../shared/image-submission-ipc';

export function useImageSubmissionFlow(options: {
  readonly draftId: string;
  readonly draftUpdatedAt: string;
  readonly preflight?: ImagePreflightDto;
  readonly candidate?: ImagePreflightCandidateDto;
  readonly confirmations: ImageSubmissionConfirmationDto;
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly onMessage: (message: string) => void;
  readonly onVideoDraftCreated?: (draftId: string) => void;
  readonly errorMessages: Readonly<Record<ImageSubmissionErrorCode, string>>;
}) {
  const submissions = window.unicomp?.imageSubmissions;
  const videoWorkspaces = window.unicomp?.videoWorkspaces;
  const [task, setTask] = useState<ImageTaskCreatedDto>();
  const [execution, setExecution] = useState<ImageExecutionDto>();
  const [work, setWork] = useState<ImageWorkRegisteredDto>();
  const canCreateTask = Boolean(
    options.preflight &&
    options.candidate &&
    options.preflight.blockers.length === 0 &&
    allConfirmed(options.confirmations) &&
    !task &&
    !options.busy
  );

  useEffect(() => {
    setTask(undefined);
    setExecution(undefined);
    setWork(undefined);
  }, [options.draftUpdatedAt]);

  async function createTask() {
    if (
      !submissions ||
      !canCreateTask ||
      !options.preflight ||
      !options.candidate
    ) return;
    options.setBusy(true);
    try {
      const result = await submissions.createTask(
        options.draftId,
        options.preflight.draftUpdatedAt,
        options.candidate.modelId,
        options.confirmations
      );
      if (!result.ok) return reportError(result.error.code);
      setTask(result.value);
      setExecution(undefined);
      setWork(undefined);
      options.onMessage('图片任务已创建；尚未创建执行，也没有调用远端。');
    } catch {
      options.onMessage('创建图片任务失败，请重试。');
    } finally {
      options.setBusy(false);
    }
  }

  async function createExecution() {
    if (!submissions || !task || execution || options.busy) return;
    options.setBusy(true);
    try {
      const result = await submissions.createExecution(task.taskId);
      if (!result.ok) return reportError(result.error.code);
      setExecution(result.value);
      options.onMessage('本地执行记录已创建；尚未调用远端。');
    } catch {
      options.onMessage('创建图片执行记录失败，请重试。');
    } finally {
      options.setBusy(false);
    }
  }

  async function invokeExecution() {
    if (!submissions || !execution || execution.state !== 'created' || options.busy)
      return;
    options.setBusy(true);
    try {
      const result = await submissions.invokeExecution(execution.executionId);
      if (!result.ok) return reportError(result.error.code);
      setExecution(result.value);
      options.onMessage(`图片提交已返回真实状态：${result.value.state}。`);
    } catch {
      options.onMessage('提交图片任务失败，请重试。');
    } finally {
      options.setBusy(false);
    }
  }

  async function receiveResult() {
    if (
      !submissions ||
      !execution ||
      execution.state !== 'remote_completed' ||
      options.busy
    ) return;
    options.setBusy(true);
    try {
      const result = await submissions.receiveResult(execution.executionId);
      if (!result.ok) return reportError(result.error.code);
      setWork(result.value);
      setExecution({ ...execution, state: 'completed' });
      options.onMessage(`图片结果已校验并登记为 Work：${result.value.name}。`);
    } catch {
      options.onMessage('接收图片结果失败，请重试。');
    } finally {
      options.setBusy(false);
    }
  }

  async function createVideoDraft() {
    if (!videoWorkspaces || !work || options.busy) return;
    options.setBusy(true);
    try {
      const result = await videoWorkspaces.createFromImageWork(work.workId);
      if (!result.ok) {
        options.onMessage(result.error.message);
        return;
      }
      options.onMessage('已从校验图片 Work 创建图生视频草稿；尚未创建视频任务。');
      options.onVideoDraftCreated?.(result.value.draftId);
    } catch {
      options.onMessage('创建图生视频草稿失败，请重试。');
    } finally {
      options.setBusy(false);
    }
  }

  function reportError(code: ImageSubmissionErrorCode) {
    options.onMessage(options.errorMessages[code]);
  }

  return {
    task,
    execution,
    work,
    canCreateTask,
    createTask,
    createExecution,
    invokeExecution,
    receiveResult,
    createVideoDraft
  };
}

function allConfirmed(value: ImageSubmissionConfirmationDto): boolean {
  return value.recipient && value.outboundScope && value.cost &&
    value.finalPrompt && value.model;
}
