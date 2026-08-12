import { useEffect, useState } from 'react';
import { LuSend, LuShieldCheck, LuSparkles } from 'react-icons/lu';
import { Checkbox } from 'rsuite';
import { Button } from './Button';
import {
  DynamicParameterForm,
  toDynamicParameterFields,
  type DynamicParameterValue
} from './DynamicParameterForm';
import { ModelSelect } from './ModelSelect';
import {
  SubmissionProgressSteps,
  type SubmissionProgressPhase
} from './SubmissionProgressSteps';
import { StatusPill } from './StatusPill';
import type {
  PromptEnhanceApi,
  PromptEnhanceCandidateDto,
  PromptEnhanceIpcErrorCode,
  PromptEnhancePreparationDto
} from '../shared/prompt-enhance-ipc';

export interface PromptEnhanceHost {
  readonly subjectId: string;
  readonly subjectRevision: string;
  readonly originalInput: string;
  readonly contextCount: number;
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
  draft_revision_changed: '草稿已变化，请重新准备增强。',
  subject_invalid: '当前输入或项目上下文暂不可用。',
  candidate_not_found: '所选文本模型已不存在。',
  candidate_unavailable: '所选文本模型当前不可用。',
  route_selection_invalid: '本次增强准备已失效。',
  route_selection_expired: '本次增强准备已过期。',
  route_selection_consumed: '本次增强准备已使用。',
  stale_route_selection: '草稿、提示词或上下文已变化，请重新准备。',
  confirmation_required: '请确认本次外发事实后再提交。',
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
  const [parameterValues, setParameterValues] = useState<
    Readonly<Record<string, DynamicParameterValue | undefined>>
  >({});
  const [preparation, setPreparation] = useState<PromptEnhancePreparationDto>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [progressPhase, setProgressPhase] = useState<SubmissionProgressPhase>('idle');
  const [progressFailure, setProgressFailure] = useState<string>();
  const [preparedSubject, setPreparedSubject] = useState<{
    readonly subjectId: string;
    readonly subjectRevision: string;
  }>();
  const selectedCandidate = candidates.find((item) => item.candidateId === candidateId);

  useEffect(() => {
    let active = true;
    setPreparation(undefined);
    setConfirmed(false);
    setCandidates([]);
    setCandidateId('');
    setParameterValues({});
    setProgressPhase('idle');
    setPreparedSubject(undefined);
    if (!api) {
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
  }, [api, host.inputSignature, onMessage]);

  async function prepare() {
    if (!api || !selectedCandidate || busy) return;
    setBusy(true);
    setProgressFailure(undefined);
    setProgressPhase('preparing');
    try {
      const saved = await host.ensureSaved();
      if (!saved) {
        setProgressPhase('failed');
        return;
      }
      const result = await api.prepare(
        saved.subjectId,
        saved.subjectRevision,
        selectedCandidate.candidateId,
        Object.fromEntries(
          Object.entries(parameterValues).filter((entry) => entry[1] !== undefined)
        ) as Readonly<Record<string, string | number | boolean | readonly string[]>>
      );
      if (!result.ok) {
        const message = errorMessages[result.error.code] ?? '准备提示词增强失败，请重试。';
        onMessage(message);
        setProgressFailure(message);
        setProgressPhase('failed');
        return;
      }
      setPreparation(result.value);
      setPreparedSubject(saved);
      setConfirmed(false);
      setProgressPhase('ready');
      onMessage('已固定本次提示词增强服务选择，请核对外发事实。');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!api || !preparation || !preparedSubject || !confirmed || busy) return;
    setBusy(true);
    setProgressFailure(undefined);
    setProgressPhase('requesting');
    const promoteWaiting = window.setTimeout(() => setProgressPhase('waiting'), 120);
    try {
      const result = await api.submit(
        preparedSubject.subjectId,
        preparedSubject.subjectRevision,
        preparation.routeSelectionToken,
        preparation.confirmation.confirmationId,
        true
      );
      if (!result.ok || result.value.status !== 'completed' || !result.value.enhancedText) {
        const message = result.ok
          ? '提示词增强未完成，请重试。'
          : errorMessages[result.error.code] ?? '提示词增强失败，请重试。';
        onMessage(message);
        setProgressFailure(message);
        setProgressPhase('failed');
        return;
      }
      await host.refreshResult({
        subjectId: result.value.subjectId,
        subjectRevision: result.value.subjectRevision,
        enhancedText: result.value.enhancedText
      });
      setPreparation(undefined);
      setPreparedSubject(undefined);
      setConfirmed(false);
      setProgressPhase('completed');
      onMessage('提示词增强完成，结果已写入系统补充；请确认后合并到最终提示词。');
    } catch {
      const message = '提示词增强失败，请重试。';
      onMessage(message);
      setProgressFailure(message);
      setProgressPhase('failed');
    } finally {
      window.clearTimeout(promoteWaiting);
      setBusy(false);
    }
  }

  const required = host.contextCount > 0;
  return (
    <section className="uc-prompt-enhance" aria-label="提示词增强">
      <header className="uc-prompt-enhance__heading">
        <LuSparkles aria-hidden="true" />
        <div>
          <strong>{required ? '必须：提示词增强' : '可选：提示词增强'}</strong>
          <p>{required
            ? `已选择 ${host.contextCount} 份项目上下文，必须增强并采用结果后才能生成。`
            : '使用文本推理模型改写原始需求；结果不会自动创建生成任务。'}</p>
        </div>
      </header>

      <ModelSelect
        disabled={!api || loadState !== 'loaded'}
        emptyDescription={loadState === 'loading'
          ? '正在读取文本推理模型候选。'
          : '当前没有匹配的文本推理模型，请在“模型与服务商”中完成配置。'}
        emptyTitle={loadState === 'loading' ? '正在读取' : '没有可选文本模型'}
        onChange={(nextId) => {
          setCandidateId(nextId);
          setParameterValues({});
          setPreparation(undefined);
          setConfirmed(false);
          setProgressPhase('idle');
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
        <>
          <div className="uc-image-feature-panel__facts">
            <span><strong>固定执行方式</strong>文本推理 · 非流式</span>
            <StatusPill tone={selectedCandidate.available ? 'success' : 'warning'}>
              {selectedCandidate.available ? '可准备' : '当前不可用'}
            </StatusPill>
          </div>
          <DynamicParameterForm
            disabled={busy}
            emptyHint="当前模型没有需要用户填写的参数。"
            fields={toDynamicParameterFields(selectedCandidate.parameterSchema.fields)}
            onChange={(fieldId, value) => {
              setParameterValues((current) => ({ ...current, [fieldId]: value }));
              setPreparation(undefined);
              setPreparedSubject(undefined);
              setConfirmed(false);
              setProgressPhase('idle');
            }}
            values={parameterValues}
          />
        </>
      ) : null}

      {preparation ? (
        <fieldset className="uc-image-quick__confirmations">
          <legend>确认本次提示词增强外发</legend>
          <dl className="uc-image-feature-panel__confirmation-facts">
            <div><dt>接收方</dt><dd>{preparation.confirmation.recipientName}</dd></div>
            <div><dt>服务路由</dt><dd>{preparation.confirmation.providerName} / {preparation.confirmation.connectionName} / {preparation.confirmation.modelName}</dd></div>
            <div><dt>项目上下文</dt><dd>{preparation.confirmation.contextCount} 份</dd></div>
            <div><dt>费用</dt><dd>{costLabel(preparation.confirmation.cost)}</dd></div>
          </dl>
          <Checkbox checked={confirmed} onChange={(_value, checked) => setConfirmed(checked)}>
            <span>我已核对并确认以上接收方、内容与费用事实。</span>
          </Checkbox>
        </fieldset>
      ) : null}

      <SubmissionProgressSteps failureMessage={progressFailure} phase={progressPhase} />
      <Button
        disabled={busy || !selectedCandidate?.available || !host.originalInput.trim() ||
          (Boolean(preparation) && !confirmed)}
        onClick={() => void (preparation ? submit() : prepare())}
      >
        {preparation ? <LuSend aria-hidden="true" /> : <LuShieldCheck aria-hidden="true" />}
        {busy ? '处理中' : preparation ? '确认并增强' : '准备增强'}
      </Button>
    </section>
  );
}

function costLabel(cost: { readonly state: string; readonly summary?: string }): string {
  if (cost.state === 'known') return cost.summary ?? '费用已知';
  if (cost.state === 'not_applicable') return '不适用';
  return '未知，以服务商账单为准';
}
