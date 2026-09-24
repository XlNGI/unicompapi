import { useCallback, useEffect, useRef, useState } from 'react';
import { LuArrowRight, LuFolderOpen, LuSparkles } from 'react-icons/lu';
import { Input } from 'rsuite';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { GenerationHistory } from '../../../components/GenerationHistory';
import type { SubmissionProgressPhase } from '../../../components/SubmissionProgressSteps';
import { useGlobalNotifications } from '../../../ui/notifications/GlobalNotificationProvider';
import type { GenerationImageDraftDto } from './ImageGenerationControls';
import { ImageFeatureSubmissionPanel } from './ImageFeatureSubmissionPanel';

interface ImageQuickWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: GenerationImageDraftDto;
  readonly onClearUi?: () => void;
  readonly onDraftChange: (draft: GenerationImageDraftDto) => void;
  readonly onDraftPersisted?: (draft: GenerationImageDraftDto) => void;
  readonly onFlushDraft?: () => Promise<boolean>;
  readonly onNavigateToProviders?: () => void;
  readonly onMessage: (message: string) => void;
  readonly onNavigateToProfessional?: () => void;
}

export function ImageQuickWorkspace({
  dirty,
  draft,
  onClearUi,
  onDraftChange,
  onDraftPersisted,
  onFlushDraft,
  onNavigateToProviders,
  onMessage,
  onNavigateToProfessional
}: ImageQuickWorkspaceProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const storage = window.unicomp?.storage;
  const notifications = useGlobalNotifications();
  const [busy, setBusy] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [expectedWorkId, setExpectedWorkId] = useState<string>();
  const [expectedTaskId, setExpectedTaskId] = useState<string>();
  const [selectedWorkId, setSelectedWorkId] = useState<string>();
  const [submissionProgress, setSubmissionProgress] = useState<{
    readonly phase: SubmissionProgressPhase;
    readonly failureMessage?: string;
  }>({ phase: 'idle' });
  const userTookOverRef = useRef(false);
  const lastProgressPhaseRef = useRef<SubmissionProgressPhase>('idle');
  const currentDraftRef = useRef(draft);
  currentDraftRef.current = draft;
  const handleProgressChange = useCallback((phase: SubmissionProgressPhase, failureMessage?: string) => {
    if ((phase === 'preparing' && lastProgressPhaseRef.current !== 'preparing') ||
      (phase === 'requesting' && lastProgressPhaseRef.current !== 'preparing' && lastProgressPhaseRef.current !== 'requesting')) {
      userTookOverRef.current = false;
      setExpectedTaskId(undefined);
      setExpectedWorkId(undefined);
    }
    lastProgressPhaseRef.current = phase;
    setSubmissionProgress({ phase, failureMessage });
  }, []);
  useEffect(() => {
    setHistoryRefreshKey(0);
    setExpectedTaskId(undefined);
    setExpectedWorkId(undefined);
    setSelectedWorkId(undefined);
    setSubmissionProgress({ phase: 'idle' });
  }, [draft.draftId]);
  const legacyReason = draft.input
    ? '此旧草稿含图片输入，快速生图不能提交；请迁移到专业生图。'
    : draft.contextReferences.length > 0
      ? '此旧草稿含上下文，快速生图不能提交；请迁移到专业生图。'
      : undefined;

  function changePrompt(value: string) {
    onMessage('');
    onDraftChange({
      ...draft,
      state: 'editing',
      prompt: {
        originalInput: value,
        systemSupplements: [],
        finalPrompt: value
      },
      featureSelection: {
        ...(draft.featureSelection?.productFeature === 'text_to_image'
          ? draft.featureSelection
          : {}),
        productFeature: 'text_to_image',
        parameterValues:
          draft.featureSelection?.productFeature === 'text_to_image'
            ? draft.featureSelection.parameterValues
            : {}
      },
      generation: {}
    });
  }

  async function enterProfessional() {
    if (!imageWorkspaces || busy || dirty) return;
    setBusy(true);
    onMessage('');
    try {
      const result = await imageWorkspaces.derive(
        draft.draftId,
        'professional_image'
      );
      if (!result.ok) {
        onMessage('保存快速生图草稿失败，请重试。');
        return;
      }
      onMessage('已创建专业生图派生草稿；没有创建或提交任务。');
      onNavigateToProfessional?.();
    } catch {
      onMessage('创建专业生图派生草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function revealResult() {
    if (!storage || !selectedWorkId || revealing) return;
    setRevealing(true);
    try {
      const result = await storage.revealWorkFile(selectedWorkId);
      notifications.show(result.ok
        ? {
            id: `image-result-reveal:${selectedWorkId}`,
            kind: 'success',
            title: '已打开图片位置',
            description: '图片已在系统文件管理器中定位。'
          }
        : {
            id: `image-result-reveal:${selectedWorkId}`,
            kind: 'error',
            title: '打开图片位置失败',
            description: '本地作品文件当前无法定位，请前往作品库检查文件状态。'
          });
    } catch {
      notifications.show({
        id: `image-result-reveal:${selectedWorkId}`,
        kind: 'error',
        title: '打开图片位置失败',
        description: '本地作品文件当前无法定位，请前往作品库检查文件状态。'
      });
    } finally {
      setRevealing(false);
    }
  }

  return (
    <>
      <div className="uc-image-workbench__workspace uc-image-quick__workspace uc-generation-two-pane">
        <section aria-label="图片生成参数" className="uc-generation-two-pane__controls uc-scrollbar">
        <Card className="uc-image-workbench__panel uc-image-quick__composer uc-image-quick__compact-card">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">1</span>
            <div>
              <h2>输入一句话生成图片</h2>
              <p>选模型、填提示词后点生成；无需先新建或手动确认多步草稿。</p>
            </div>
          </header>
          <label className="uc-image-quick__field">
            <span>描述你想生成的图片</span>
            <Input
              as="textarea"
              maxLength={1000}
              onChange={(value) => changePrompt(value)}
              placeholder="描述想生成的画面，例如：雪山日落下的露营海报"
              rows={7}
              value={draft.prompt.originalInput}
            />
            <small>{draft.prompt.originalInput.length} / 1000</small>
          </label>
          <div className="uc-image-feature-panel__mode-fact">
            <LuSparkles aria-hidden="true" />
            <div>
              <strong>文生图</strong>
              <span>0 份图片素材 · 0 份上下文</span>
            </div>
          </div>
          {legacyReason ? (
            <div className="uc-image-quick__preflight" role="status">
              <strong>旧草稿需要迁移</strong>
              <span>{legacyReason}</span>
              <Button
                disabled={!imageWorkspaces || busy || dirty}
                onClick={() => void enterProfessional()}
                variant="secondary"
              >
                <LuArrowRight aria-hidden="true" />
                迁移到专业生图
              </Button>
            </div>
          ) : null}
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities uc-image-quick__inspector uc-image-quick__compact-card">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>模型与生成</h2>
              <p>选择服务后一键生成；调用记录会保存返回的图片链接。</p>
            </div>
          </header>
          <ImageFeatureSubmissionPanel
            blockedReason={legacyReason}
            className="uc-image-feature-panel--compact"
            dirty={dirty}
            draft={draft}
            onDraftChange={onDraftChange}
            onDraftPersisted={onDraftPersisted}
            onFlushDraft={onFlushDraft}
            onNavigateToProviders={onNavigateToProviders}
            onMessage={onMessage}
            onProgressChange={handleProgressChange}
            onSubmissionComplete={(submission) => {
              setExpectedTaskId(submission.taskId);
              setExpectedWorkId(submission.status === 'completed' ? submission.workId : undefined);
              setHistoryRefreshKey((key) => key + 1);
              if (submission.status === 'completed' &&
                currentDraftRef.current.draftId === draft.draftId &&
                currentDraftRef.current.prompt.originalInput === draft.prompt.originalInput &&
                JSON.stringify(currentDraftRef.current.featureSelection) === JSON.stringify(draft.featureSelection)) onClearUi?.();
            }}
            oneShot
          />
        </Card>
        </section>

        <Card aria-label="图片生成内容与历史" className="uc-generation-two-pane__result">
          <GenerationHistory
            draftId={draft.draftId}
            key={draft.projectId}
            mediaKind="image"
            workspaceMode="quick_image"
            projectId={draft.projectId}
            refreshKey={historyRefreshKey}
            expectedWorkId={expectedWorkId}
            expectedTaskId={expectedTaskId}
            onWorkSelectionChange={setSelectedWorkId}
            userTookOverRef={userTookOverRef}
            submissionProgress={submissionProgress}
          />
          <div className="uc-image-quick__result-actions">
            <Button
              disabled={!storage || !selectedWorkId || revealing}
              onClick={() => void revealResult()}
              title={selectedWorkId ? '在系统文件管理器中定位已保存图片' : '选择已完成图片后可用'}
              variant="secondary"
            >
              <LuFolderOpen aria-hidden="true" />
              打开图片位置
            </Button>
            <Button
              disabled={busy || dirty}
              onClick={() => void enterProfessional()}
              variant="secondary"
            >
              <LuArrowRight aria-hidden="true" />
              进入专业创作
            </Button>
          </div>
        </Card>
      </div>

    </>
  );
}
