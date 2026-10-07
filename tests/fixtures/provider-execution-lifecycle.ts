import type { ProviderExecutionLifecyclePort } from '../../src/platform/providers/provider-tool-calling';

export function providerExecutionLifecycleFixture(
  onBoundary?: (name: keyof ProviderExecutionLifecyclePort, input: unknown) => void | Promise<void>
) {
  const events: Array<{ name: keyof ProviderExecutionLifecyclePort; input: unknown }> = [];
  const boundary = (name: keyof ProviderExecutionLifecyclePort) => async (input: unknown) => {
    events.push({ name, input });
    await onBoundary?.(name, input);
  };
  const port: ProviderExecutionLifecyclePort = {
    modelPrepared: boundary('modelPrepared'), modelStarted: boundary('modelStarted'),
    modelResult: boundary('modelResult'), modelFailed: boundary('modelFailed'),
    toolStarted: boundary('toolStarted'), toolAdmitted: boundary('toolAdmitted'), toolResult: boundary('toolResult'),
    observationCommitted: boundary('observationCommitted')
  };
  return { port, events };
}
