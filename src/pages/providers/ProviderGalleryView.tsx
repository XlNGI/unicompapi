import { LuCirclePlus, LuInbox } from 'react-icons/lu';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { StatusPill } from '../../components/StatusPill';
import type {
  ProviderConnectionSummaryDto,
  ProviderTemplateSummaryDto
} from '../../shared/provider-ipc';
import { templateKeyOf } from './provider-page-shared';

interface ProviderGalleryViewProps {
  readonly templates: readonly ProviderTemplateSummaryDto[];
  readonly connections: readonly ProviderConnectionSummaryDto[];
  readonly busy: boolean;
  readonly onAddConnection: (templateKey: string) => void;
  readonly onManageTemplate: (templateKey: string) => void;
  readonly onRequestAdapter: () => void;
}

function kindLabel(kind: ProviderTemplateSummaryDto['kind']): string {
  return kind === 'official' ? '官方模板' : '兼容模板';
}

function discoveryLabel(template: ProviderTemplateSummaryDto): string {
  if (template.modelDiscoveryKind === 'catalog') return '自动目录';
  if (template.modelDiscoveryKind === 'manual_exact') return '手动登记';
  return '无目录';
}

function validationLabel(template: ProviderTemplateSummaryDto): string {
  if (template.validationAction === 'available') return '保存时验证';
  if (template.validationAction === 'requires_live_api_approval') return '验证探针待批准';
  return '暂无免费验证';
}

export function ProviderGalleryView({
  templates,
  connections,
  busy,
  onAddConnection,
  onManageTemplate,
  onRequestAdapter
}: ProviderGalleryViewProps) {
  return (
    <div className="uc-provider-gallery" aria-label="供应商画廊">
      {templates.map((template) => {
        const templateKey = templateKeyOf(template);
        const liveConnections = connections.filter(
          (connection) =>
            connection.packageId === template.packageId &&
            connection.templateId === template.templateId &&
            connection.state !== 'deleted'
        );
        return (
          <Card className="uc-provider-gallery__card" key={templateKey}>
            <div className="uc-provider-gallery__card-heading">
              <span className="uc-provider-gallery__avatar" aria-hidden="true">
                {template.providerName.slice(0, 1)}
              </span>
              <div>
                <strong>{template.providerName}</strong>
                <small>{template.displayName}</small>
              </div>
              <StatusPill tone={liveConnections.length > 0 ? 'info' : 'neutral'}>
                {liveConnections.length > 0 ? `已连接 ${liveConnections.length}` : '未连接'}
              </StatusPill>
            </div>
            <div className="uc-provider-gallery__tags" aria-label="能力标签">
              <span>{kindLabel(template.kind)}</span>
              <span>{discoveryLabel(template)}</span>
              <span>{validationLabel(template)}</span>
            </div>
            <div className="uc-provider-gallery__actions">
              <Button
                disabled={busy || template.validationAction !== 'available'}
                onClick={() => onAddConnection(templateKey)}
                title={
                  template.validationAction === 'available'
                    ? undefined
                    : '该供应商尚无获批的免费验证探针，不能添加连接'
                }
              >
                <LuCirclePlus aria-hidden="true" /> 添加连接
              </Button>
              {liveConnections.length > 0 && (
                <Button disabled={busy} onClick={() => onManageTemplate(templateKey)} variant="ghost">
                  管理
                </Button>
              )}
            </div>
          </Card>
        );
      })}
      <Card className="uc-provider-gallery__card uc-provider-gallery__request">
        <div className="uc-provider-gallery__card-heading">
          <span className="uc-provider-gallery__avatar" aria-hidden="true">
            <LuInbox />
          </span>
          <div>
            <strong>没找到需要的供应商？</strong>
            <small>求适配</small>
          </div>
        </div>
        <p className="uc-provider-gallery__request-copy">
          画廊只展示已完成真实适配的供应商。告诉我们你需要接入的服务，适配完成后会出现在这里。
        </p>
        <div className="uc-provider-gallery__actions">
          <Button disabled={busy} onClick={onRequestAdapter} variant="secondary">
            求适配
          </Button>
        </div>
      </Card>
    </div>
  );
}
