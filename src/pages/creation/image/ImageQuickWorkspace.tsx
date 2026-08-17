import { useState } from 'react';
import { LuArrowRight, LuFolderOpen, LuSparkles } from 'react-icons/lu';
import { Input } from 'rsuite';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { GenerationResultPreview } from '../../../components/GenerationResultPreview';
import { StatusPill } from '../../../components/StatusPill';
import { useGlobalNotifications } from '../../../ui/notifications/GlobalNotificationProvider';
import type { GenerationImageDraftDto } from './ImageGenerationControls';
import { ImageFeatureSubmissionPanel } from './ImageFeatureSubmissionPanel';

interface ImageQuickWorkspaceProps {
  readonly dirty: boolean;
  readonly draft: GenerationImageDraftDto;
  readonly onClearUi?: () => void;
  readonly onDraftChange: (draft: GenerationImageDraftDto) => void;
  readonly onDraftPersisted?: (draft: GenerationImageDraftDto) => void;
  readonly onMessage: (message: string) => void;
  readonly onNavigateToProfessional?: () => void;
}

export function ImageQuickWorkspace({
  dirty,
  draft,
  onClearUi,
  onDraftChange,
  onDraftPersisted,
  onMessage,
  onNavigateToProfessional
}: ImageQuickWorkspaceProps) {
  const imageWorkspaces = window.unicomp?.imageWorkspaces;
  const storage = window.unicomp?.storage;
  const notifications = useGlobalNotifications();
  const [busy, setBusy] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [resultUrls, setResultUrls] = useState<readonly string[]>([]);
  const [workId, setWorkId] = useState<string>();
  const legacyReason = draft.input
    ? '此旧草稿含图片输入，快速生图不能提交；请迁移到专业生图。'
    : draft.contextReferences.length > 0
      ? '此旧草稿含上下文，快速生图不能提交；请迁移到专业生图。'
      : undefined;

  function changePrompt(value: string) {
    setResultUrls([]);
    setWorkId(undefined);
    onDraftChange({
      ...draft,
      state: 'editing',
      prompt: {
        originalInput: value,
        systemSupplements: [],
        finalPrompt: value
      },
      featureSelection: {
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
    if (!storage || !workId || revealing) return;
    setRevealing(true);
    try {
      const result = await storage.revealWorkFile(workId);
      notifications.show(result.ok
        ? {
            id: `image-result-reveal:${draft.draftId}`,
            kind: 'success',
            title: '已打开图片位置',
            description: '图片已在系统文件管理器中定位。'
          }
        : {
            id: `image-result-reveal:${draft.draftId}`,
            kind: 'error',
            title: '打开图片位置失败',
            description: '本地作品文件当前无法定位，请前往作品库检查文件状态。'
          });
    } catch {
      notifications.show({
        id: `image-result-reveal:${draft.draftId}`,
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
      <div className="uc-image-workbench__workspace uc-image-quick__workspace">
        <Card className="uc-image-workbench__panel uc-image-quick__composer">
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
              placeholder="例如：雪山日落下的露营海报"
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

        <Card className="uc-image-workbench__panel uc-image-workbench__capabilities uc-image-quick__inspector">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">2</span>
            <div>
              <h2>模型与生成</h2>
              <p>选择服务后一键生成；调用记录会保存返回的图片链接。</p>
            </div>
          </header>
          <ImageFeatureSubmissionPanel
            blockedReason={legacyReason}
            dirty={dirty}
            draft={draft}
            onDraftChange={onDraftChange}
            onDraftPersisted={onDraftPersisted}
            onMessage={onMessage}
            onSubmissionComplete={(submission) => {
              setResultUrls(submission.resultImageUrls ?? []);
              setWorkId(submission.workId);
              if (
                submission.status === 'completed' ||
                submission.status === 'provider_accepted'
              ) {
                onClearUi?.();
              }
            }}
            oneShot
          />
        </Card>

        <Card className="uc-image-workbench__panel uc-image-workbench__canvas uc-image-quick__stage">
          <header className="uc-image-workbench__panel-heading">
            <span aria-hidden="true">3</span>
            <div>
              <h2>生成结果</h2>
              <p>展示服务商返回的图片链接；任务中心调用记录同步可见。</p>
            </div>
          </header>
          <GenerationResultPreview
            emptyDescription="填写提示词并选择模型后点生成。"
            emptyTitle="尚无生成结果"
            mediaKind="image"
            remoteUrls={resultUrls}
            workId={workId}
          />
          <div className="uc-image-quick__result-actions">
            <Button
              disabled={!storage || !workId || revealing}
              onClick={() => void revealResult()}
              title={workId ? '在系统文件管理器中定位已保存图片' : '图片完成本地保存后可用'}
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

      <Card className="uc-image-workbench__notice" role="status">
        <StatusPill tone="info">调用记录</StatusPill>
        <p>
          每次生成都会写入任务中心调用记录，并保存可展示的图片链接；本地校验作品另行登记。
        </p>
      </Card>
    </>
  );
}
