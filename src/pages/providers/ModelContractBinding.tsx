import { useEffect, useState } from 'react';
import { Input } from 'rsuite';
import { SelectPicker } from '../../components/Pickers';
import { Button } from '../../components/Button';
import type { ModelApiContractSummaryDto, ProviderApi, ProviderFrameworkResult, ProviderModelSummaryDto } from '../../shared/provider-ipc';
import type { ParameterCompatibilityRuleV1 } from '../../domain/entities/parameter-compatibility';

export function ModelContractBinding({ model, api, busy, runAction }: {
  readonly model: ProviderModelSummaryDto;
  readonly api: ProviderApi;
  readonly busy: boolean;
  readonly runAction: <T>(action: () => Promise<ProviderFrameworkResult<T>>, message: string) => Promise<boolean>;
}) {
  const [contracts, setContracts] = useState<readonly ModelApiContractSummaryDto[]>([]);
  const [selection, setSelection] = useState<string | null>(model.apiContract?.contractId ?? null);
  const [rulesText, setRulesText] = useState('[]');
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    api.listModelApiContracts?.().then(result => {
      if (!current) return;
      if (result.ok) setContracts(result.value); else setError('无法读取合同目录。');
    }).catch(() => { if (current) setError('无法读取合同目录。'); });
    return () => { current = false; };
  }, [api]);
  useEffect(() => { setSelection(model.apiContract?.contractId ?? null); setRulesText(JSON.stringify(model.apiContract?.rules ?? [], null, 2)); setError(''); }, [model.modelId, model.apiContract]);
  const selected = contracts.find(contract => contract.contractId === selection);
  return <details className="uc-provider-page__native-search">
    <summary>模型 API 合同</summary>
    <form className="uc-provider-page__stack-form" onSubmit={event => {
      event.preventDefault();
      if (!selected || !api.bindModelApiContract || busy) return;
      let rules: readonly ParameterCompatibilityRuleV1[];
      try { const parsed: unknown = JSON.parse(rulesText); if (!Array.isArray(parsed)) throw new Error(); rules = parsed; }
      catch { setError('兼容规则必须是 JSON 列表。'); return; }
      setError('');
      void runAction(() => api.bindModelApiContract!({ modelId: model.modelId, expectedRevision: model.revision,
        binding: { schemaVersion: 1, contractId: selected.contractId, contractRevision: selected.revision, rules }, confirmed: true }),
        '已绑定官方合同并记录兼容声明；尚未实测中转调用。');
    }}>
      <p className="uc-provider-page__muted">选择该模型实际兼容的厂商 API。保存只更新本地配置；参数校验和显示将使用这份合同。</p>
      {model.apiContract && <p>当前绑定：{model.apiContract.contractId} · 已声明，未实测</p>}
      <SelectPicker aria-label="模型 API 合同" block cleanable={false} disabled={busy} value={selection}
        data={contracts.map(contract => ({ value: contract.contractId,
          label: `${contract.vendor} / ${contract.modelNames.length ? contract.modelNames.join('、') : contract.contractId}` }))}
        onChange={value => setSelection(value)} placeholder="选择已确认兼容的官方 API" />
      {selected && <p className="uc-provider-page__muted">官方依据：{selected.sourceUrls.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">官方文档 </a>)}</p>}
      <details><summary>参数兼容规则</summary>
        <p className="uc-provider-page__muted">完全一致时保留空列表。差异可声明 fieldId、targetPath、unsupported、minimum、maximum、options 或 enumMappings；范围只能收紧，已填写的值不会被静默丢弃。</p>
        <Input as="textarea" rows={5} aria-label="参数兼容规则" value={rulesText} disabled={busy} onChange={setRulesText} maxLength={16000} />
      </details>
      {error && <p role="alert">{error}</p>}
      <Button disabled={busy || !selected} type="submit">确认兼容并绑定合同</Button>
    </form>
  </details>;
}
