import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type * as ReactModule from 'react';
import type { ModelApiContractSummaryDto, ProviderApi, ProviderModelSummaryDto } from '../../src/shared/provider-ipc';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async original => ({
  ...await original<typeof ReactModule>(),
  useState(initial: unknown) {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = initial;
    return [hooks.slots[i], (next: unknown) => { hooks.slots[i] = typeof next === 'function' ? next(hooks.slots[i]) : next; }];
  },
  useEffect(effect: () => (() => void) | void, deps?: readonly unknown[]) {
    const i = hooks.cursor++;
    const old = hooks.slots[i] as { deps?: readonly unknown[]; cleanup?: () => void } | undefined;
    if (!old || !deps || deps.some((value, at) => !Object.is(value, old.deps?.[at]))) {
      hooks.slots[i] = { deps };
      hooks.effects.push(() => { old?.cleanup?.(); (hooks.slots[i] as { cleanup?: () => void }).cleanup = effect() ?? undefined; });
    }
  }
}));
import { ModelContractBinding } from '../../src/pages/providers/ModelContractBinding';

type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const e = node as Element;
  return predicate(e) ? e : find(e.props.children as ReactNode, predicate);
}
const contracts: readonly ModelApiContractSummaryDto[] = [
  { contractId: 'official.deepseek.v4.chat', revision: 1, authority: 'model_vendor', vendor: 'deepseek', modelNames: ['deepseek-v4-flash'], sourceUrls: [] },
  { contractId: 'official.moonshot.kimi-k3.chat', revision: 1, authority: 'model_vendor', vendor: 'moonshot', modelNames: ['kimi-k3'], sourceUrls: [] },
  { contractId: 'relay.unicompapi-www.wan3.0-video.video', revision: 1, authority: 'relay', vendor: 'www.unicompapi.com', modelNames: ['wan3.0-video'], sourceUrls: [] }
];
const model: ProviderModelSummaryDto = { modelId: 'model-ui', providerId: 'provider-ui', connectionId: 'connection-ui', protocolBindingId: 'binding-ui',
  name: 'deepseek-v4-flash', providerModelKey: 'deepseek-v4-flash', displayName: 'DeepSeek fixture', mediaKind: 'unknown', revision: 2, catalogState: 'present', enabled: false };

describe('production contract binding component behavior', () => {
  beforeEach(() => { hooks.slots = []; hooks.cursor = 0; hooks.effects = []; });
  async function renderFixture(selectedModel = model, packageId = 'provider-package-unicompapi-www') {
    const bind = vi.fn(async () => ({ ok: true as const, value: { modelId: selectedModel.modelId, state: 'bound' as const } }));
    const api = { listModelApiContracts: async () => ({ ok: true as const, value: contracts }), bindModelApiContract: bind } as unknown as ProviderApi;
    const runAction = vi.fn(async <T,>(action: () => Promise<T>) => { await action(); return true; });
    const render = () => { hooks.cursor = 0; return ModelContractBinding({ model: selectedModel, packageId, api, busy: false, runAction }); };
    let tree = render();
    for (const effect of hooks.effects.splice(0)) effect();
    await Promise.resolve();
    tree = render();
    const picker = () => find(tree, e => e.props['aria-label'] === '模型 API 合同')!;
    const options = () => (picker().props.data as { value: string }[]).map(o => o.value);
    return { bind, runAction, options, get tree() { return tree; }, rerender() { tree = render(); },
      select(id: string) { (picker().props.onChange as (value: string) => void)(id); tree = render(); } };
  }

  it('shows and explicitly submits an exact WWW text contract with the model revision', async () => {
    const f = await renderFixture();
    expect(f.options()).toEqual(['official.deepseek.v4.chat']);
    expect(f.bind).not.toHaveBeenCalled();
    f.select('official.deepseek.v4.chat');
    (find(f.tree, e => e.type === 'form')!.props.onSubmit as (e: { preventDefault(): void }) => void)({ preventDefault() {} });
    await Promise.resolve();
    expect(f.bind).toHaveBeenCalledWith({ modelId: 'model-ui', expectedRevision: 2,
      binding: { schemaVersion: 1, contractId: 'official.deepseek.v4.chat', contractRevision: 1, rules: [] }, confirmed: true });
  });

  it('keeps exact WWW video contracts separate from text and other relay models', async () => {
    const f = await renderFixture({ ...model, providerModelKey: 'wan3.0-video' });
    expect(f.options()).toEqual(['relay.unicompapi-www.wan3.0-video.video']);
  });

  it('does not guess contracts for an unknown WWW model; text aliases require explicit opt-in', async () => {
    const f = await renderFixture({ ...model, providerModelKey: 'deployment-custom' });
    expect(f.options()).toEqual([]);
    const toggle = find(f.tree, e => e.props['aria-label'] === '显示其他文本合同')!;
    expect(toggle).toBeDefined();
    (toggle.props.onChange as (checked: boolean) => void)(true);
    f.rerender();
    expect(f.options()).toEqual(['official.deepseek.v4.chat', 'official.moonshot.kimi-k3.chat']);
    expect(f.bind).not.toHaveBeenCalled();
  });

  it('preserves explicit vendor contract selection for other relay aliases', async () => {
    const f = await renderFixture({ ...model, providerModelKey: 'other-deployment' }, 'provider-package-newapi');
    expect(f.options()).toEqual(['official.deepseek.v4.chat', 'official.moonshot.kimi-k3.chat']);
  });
});
