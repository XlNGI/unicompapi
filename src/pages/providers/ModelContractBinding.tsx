import { useEffect, useState } from 'react';
import { Input, Toggle } from 'rsuite';
import { SelectPicker } from '../../components/Pickers';
import { Button } from '../../components/Button';
import type { ModelApiContractSummaryDto, ProviderApi, ProviderFrameworkResult, ProviderModelSummaryDto } from '../../shared/provider-ipc';
import type { ParameterCompatibilityRuleV1 } from '../../domain/entities/parameter-compatibility';

export function ModelContractBinding({ model, packageId, api, busy, runAction }: {
  readonly model: ProviderModelSummaryDto;
  readonly packageId?: string;
  readonly api: ProviderApi;
  readonly busy: boolean;
  readonly runAction: <T>(action: () => Promise<ProviderFrameworkResult<T>>, message: string) => Promise<boolean>;
}) {
  const [catalog, setCatalog] = useState<readonly ModelApiContractSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeTextAliases, setIncludeTextAliases] = useState(false);
  const [selection, setSelection] = useState<string | null>(model.apiContract?.contractId ?? null);
  const [rulesText, setRulesText] = useState('[]');
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setLoading(true);
    setCatalog([]);
    api.listModelApiContracts?.().then(result => {
      if (!current) return;
      setLoading(false);
      if (result.ok) setCatalog(result.value); else setError('无法读取合同目录。');
    }).catch(() => { if (current) { setLoading(false); setError('无法读取合同目录。'); } });
    if (!api.listModelApiContracts) { setLoading(false); setError('无法读取合同目录。'); }
    return () => { current = false; };
  }, [api, model.providerModelKey, packageId]);
  useEffect(() => { setSelection(model.apiContract?.contractId ?? null); setRulesText(JSON.stringify(model.apiContract?.rules ?? [], null, 2)); setIncludeTextAliases(false); setError(''); }, [model.modelId, model.apiContract]);
  const isWww = packageId === 'provider-package-unicompapi-www';
  const hasExactRelay = catalog.some(c => c.authority === 'relay' && c.modelNames.includes(model.providerModelKey));
  const contracts = catalog.filter(c => c.authority === 'relay'
    ? isWww && c.modelNames.includes(model.providerModelKey)
    : !isWww || !hasExactRelay && (includeTextAliases || c.modelNames.includes(model.providerModelKey) || c.contractId === model.apiContract?.contractId));
  const selected = contracts.find(contract => contract.contractId === selection);
  return <details className="uc-provider-page__native-search">
    <summary>模型 API 合同</summary>
    <form className="uc-provider-page__stack-form" onSubmit={event => {
      event.preventDefault();
      if (!selected || !api.bindModelApiContract || busy) return;
      let rules: readonly ParameterCompatibilityRuleV1[];
      try { const parsed: unknown = selected.authority === 'relay' ? [] : JSON.parse(rulesText); if (!Array.isArray(parsed)) throw new Error(); rules = parsed; }
      catch { setError('兼容规则必须是 JSON 列表。'); return; }
      setError('');
      void runAction(() => api.bindModelApiContract!({ modelId: model.modelId, expectedRevision: model.revision,
        binding: { schemaVersion: 1, contractId: selected.contractId, contractRevision: selected.revision, rules }, confirmed: true }),
        '已绑定 API 合同；真实服务验收状态另行记录。');
    }}>
      <p className="uc-provider-page__muted">选择该模型实际使用的 API 合同；参数校验和显示将使用这份合同。网关合同仅适用于对应网关和精确型号。</p>
      {model.apiContract && <p>当前绑定：{model.apiContract.contractId} · 已声明，未实测</p>}
      {isWww && !hasExactRelay && <Toggle aria-label="显示其他文本合同" label="中转别名：显示其他已确认兼容的文本合同"
        checked={includeTextAliases} disabled={busy || loading} onChange={setIncludeTextAliases} />}
      {!loading && !error && contracts.length === 0 && <p className="uc-provider-page__muted">当前型号没有精确合同候选，需先完成适配；已确认的文本别名可选择其他文本合同。</p>}
      <SelectPicker aria-label="模型 API 合同" block cleanable={false} disabled={busy} value={selection}
        data={contracts.map(contract => ({ value: contract.contractId,
          label: `${contract.authority === 'relay' ? '网关合同' : '厂商合同'} · ${contract.vendor} / ${contract.modelNames.length ? contract.modelNames.join('、') : contract.contractId}` }))}
        onChange={value => setSelection(value)} placeholder="选择已确认兼容的 API 合同" />
      {selected && <p className="uc-provider-page__muted">合同依据：{selected.sourceUrls.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">{selected.authority === 'relay' ? '网关文档 ' : '厂商文档 '}</a>)}</p>}
      {selected?.authority === 'model_vendor' && !selected.modelNames.includes(model.providerModelKey) && <p className="uc-provider-page__muted">当前型号未列入所选合同。请先确认中转别名使用相同文本协议；绑定仅记录兼容声明。</p>}
      {selected?.authority === 'model_vendor' && <details><summary>参数兼容规则</summary>
        <p className="uc-provider-page__muted">完全一致时保留空列表。差异可声明 fieldId、targetPath、unsupported、minimum、maximum、options 或 enumMappings；范围只能收紧，已填写的值不会被静默丢弃。</p>
        <Input as="textarea" rows={5} aria-label="参数兼容规则" value={rulesText} disabled={busy} onChange={setRulesText} maxLength={16000} />
      </details>}
      {error && <p role="alert">{error}</p>}
      <Button disabled={busy || !selected} type="submit">确认兼容并绑定合同</Button>
    </form>
  </details>;
}
