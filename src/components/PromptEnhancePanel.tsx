import { useEffect, useState } from 'react';
import { LuShieldCheck, LuSparkles } from 'react-icons/lu';
import { Button } from './Button';
import { ModelSelect } from './ModelSelect';
import type {
  PromptEnhanceApi,
  PromptEnhanceCandidateDto,
  PromptEnhanceIpcErrorCode
} from '../shared/prompt-enhance-ipc';

export interface PromptEnhanceHost {
  readonly subjectId: string;
  readonly subjectRevision: string;
  readonly originalInput: string;
  readonly inputSignature: string;
  readonly dirty: boolean;
  ensureSaved(): Promise<{ readonly subjectId: string; readonly subjectRevision: string } | undefined>;
  refreshResult(input: {
    readonly subjectId: string;
    readonly subjectRevision: string;
    readonly enhancedText: string;
  }): Promise<void>;
}

interface PromptEnhancePanelProps {
  readonly api?: PromptEnhanceApi;
  readonly host: PromptEnhanceHost;
  readonly onMessage: (message: string) => void;
}

const errorMessages: Partial<Record<PromptEnhanceIpcErrorCode, string>> = {
  invalid_request: '提示词增强请求无效。',
  project_not_open: '当前没有打开的项目。',
  draft_not_found: '当前草稿已不存在。',
  draft_revision_changed: '草稿已变化，请重试提示词增强。',
  subject_invalid: '当前输入或项目上下文暂不可用。',
  candidate_not_found: '所选文本模型已不存在。',
  candidate_unavailable: '所选文本模型当前不可用。',
  route_selection_invalid: '本次提示词增强已失效，请重试。',
  route_selection_expired: '本次提示词增强已过期，请重试。',
  route_selection_consumed: '本次增强准备已使用。',
  stale_route_selection: '草稿、提示词或上下文已变化，请重试提示词增强。',
  confirmation_required: '请重新确认提示词增强。',
  runtime_not_allowed: '在线文本运行尚未获准，没有发出请求。',
  authorization_not_claimed: '运行授权未取得，没有发出请求。',
  submission_failed_before_request: '增强请求发送前失败。',
  submission_outcome_unknown: '增强结果未知。',
  adapter_contract_invalid: '文本适配器合同不匹配。',
  empty_prompt: '请先填写原始创作需求。',
  empty_result: '增强未返回可用文本。',
  storage_error: '本地提示词增强失败，请重试。'
};

const unavailableReasonLabels: Readonly<Record<string, string>> = {
  model_disabled: '模型未启用',
  model_not_present: '模型不在当前目录',
  connection_unavailable: '连接不可用',
  profile_unavailable: '功能档案未验证',
  feature_unsupported: '不支持文本推理',
  binding_unavailable: '协议适配器不可用',
  runtime_not_allowed: '在线运行未授权',
  subject_constraints_unsatisfied: '约束不满足',
  schema_unsupported: '参数格式无法识别'
};

export function PromptEnhancePanel({ api, host, onMessage }: PromptEnhancePanelProps) {
  const [candidates, setCandidates] = useState<readonly PromptEnhanceCandidateDto[]>([]);
  const [candidateId, setCandidateId] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const selectedCandidate = candidates.find((item) => item.candidateId === candidateId);

  useEffect(() => {
    let active = true;
    setCandidates([]);
    setCandidateId('');
    if (!api || !open) {
      setLoadState('idle');
      return;
    }
    setLoadState('loading');
    const timer = window.setTimeout(() => {
      void api.listCandidates().then((result) => {
        if (!active) return;
        if (result.ok) setCandidates(result.value);
        else onMessage(errorMessages[result.error.code] ?? '读取增强模型失败，请重试。');
        setLoadState('loaded');
      }).catch(() => {
        if (active) {
          setLoadState('loaded');
          onMessage('读取文本增强候选失败。');
        }
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, host.inputSignature, onMessage, open]);

  async function confirmEnhancement() {
    if (!api || !selectedCandidate || busy || !host.originalInput.trim()) return;
    setBusy(true);
    try {
      const saved = await host.ensureSaved();
      if (!saved) {
        return;
      }
      const result = await api.prepare(
        saved.subjectId,
        saved.subjectRevision,
        selectedCandidate.candidateId,
        {}
      );
      if (!result.ok) {
        onMessage(errorMessages[result.error.code] ?? '提示词增强失败，请重试。');
        return;
      }
      const submission = await api.submit(
        saved.subjectId,
        saved.subjectRevision,
        result.value.routeSelectionToken,
        result.value.confirmation.confirmationId,
        true
      );
      if (!submission.ok || submission.value.status !== 'completed' || !submission.value.enhancedText) {
        const message = submission.ok
          ? '提示词增强未完成，请重试。'
          : errorMessages[submission.error.code] ?? '提示词增强失败，请重试。';
        onMessage(message);
        return;
      }
      await host.refreshResult({
        subjectId: submission.value.subjectId,
        subjectRevision: submission.value.subjectRevision,
        enhancedText: submission.value.enhancedText
      });
      setOpen(false);
      onMessage('提示词增强完成，结果已写入最终提示词并可直接编辑。');
    } catch {
      onMessage('提示词增强失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  const canEnhance = Boolean(host.originalInput.trim()) && Boolean(api);
  if (!open) {
    return (
      <Button
        disabled={!canEnhance}
        onClick={() => setOpen(true)}
        variant="secondary"
      >
        <LuSparkles aria-hidden="true" />
        提示词增强
      </Button>
    );
  }

  return (
    <section className="uc-prompt-enhance" aria-label="提示词增强">
      <ModelSelect
        disabled={!api || loadState !== 'loaded'}
        emptyDescription={loadState === 'loading'
          ? '正在读取文本推理模型候选。'
          : '当前没有匹配的文本推理模型，请在“模型与服务商”中完成配置。'}
        emptyTitle={loadState === 'loading' ? '正在读取' : '没有可选文本模型'}
        onChange={(nextId) => {
          setCandidateId(nextId);
        }}
        options={candidates.map((candidate) => ({
          id: candidate.candidateId,
          label: candidate.modelName,
          providerName: candidate.providerName,
          connectionName: candidate.connectionName,
          available: candidate.available,
          unavailableReasons: candidate.unavailableReasons
        }))}
        reasonLabels={unavailableReasonLabels}
        value={candidateId}
      />

      {selectedCandidate ? (
        <Button
          disabled={busy || !selectedCandidate.available || !host.originalInput.trim()}
          onClick={() => void confirmEnhancement()}
        >
          <LuShieldCheck aria-hidden="true" />
          {busy ? '增强中' : '确认增强'}
        </Button>
      ) : null}
    </section>
  );
}
