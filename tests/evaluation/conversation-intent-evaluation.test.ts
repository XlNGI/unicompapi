import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { analyzeLocalConversationIntent } from '../../src/application';

interface GoldenCase {
  readonly input: string;
  readonly context?: {
    readonly documents?: readonly {
      readonly messageId: string;
      readonly kind: 'word' | 'excel' | 'ppt';
      readonly fileName: string;
    }[];
  };
  readonly expectedKind: 'chat' | 'document' | 'unknown';
  readonly expectedAction?: 'create' | 'revise';
  readonly expectedDocumentKind?: 'word' | 'excel' | 'ppt' | 'auto';
  readonly expectedSourcePolicy?: 'none' | 'internal' | 'web' | 'mixed';
  readonly expectedReadiness?: 'ready' | 'needs_clarification' | 'needs_confirmation';
  readonly expectedTargetUnit?: 'document' | 'version' | 'page' | 'section' | 'table' | 'cell' | 'block';
  readonly expectedTargetOrdinal?: number;
  readonly expectedResolvedMessageId?: string;
}

interface GoldenSuite {
  readonly schemaVersion: 1;
  readonly suiteId: 'conversation-intent-offline-golden';
  readonly version: string;
  readonly updatedAt: string;
  readonly cases: readonly GoldenCase[];
}

describe('Conversation intent golden evaluation', () => {
  it('matches the versioned offline semantic baseline', async () => {
    const suite = JSON.parse(
      await readFile(
        new URL('./conversation-intent-golden.json', import.meta.url),
        'utf8'
      )
    ) as GoldenSuite;
    expect(suite).toMatchObject({
      schemaVersion: 1,
      suiteId: 'conversation-intent-offline-golden',
      version: '1.0.1',
      updatedAt: '2026-09-04'
    });
    expect(suite.cases).toHaveLength(46);
    const failures: string[] = [];
    for (const item of suite.cases) {
      const decision = analyzeLocalConversationIntent({
        rawText: item.input,
        context: item.context
      });
      const actual = decision.plan;
      if (actual.kind !== item.expectedKind) failures.push(`${item.input}: kind=${actual.kind}`);
      if (item.expectedAction !== undefined && actual.action !== item.expectedAction) failures.push(`${item.input}: action=${String(actual.action)}`);
      if (item.expectedDocumentKind !== undefined && actual.documentKind !== item.expectedDocumentKind) failures.push(`${item.input}: documentKind=${String(actual.documentKind)}`);
      if (item.expectedSourcePolicy !== undefined && actual.sourcePolicy !== item.expectedSourcePolicy) failures.push(`${item.input}: sourcePolicy=${actual.sourcePolicy}`);
      if (item.expectedReadiness !== undefined && decision.assessment.readiness !== item.expectedReadiness) failures.push(`${item.input}: readiness=${decision.assessment.readiness}`);
      if (item.expectedTargetUnit !== undefined && actual.targetHint?.unit !== item.expectedTargetUnit) failures.push(`${item.input}: targetUnit=${String(actual.targetHint?.unit)}`);
      if (item.expectedTargetOrdinal !== undefined && actual.targetHint?.ordinal !== item.expectedTargetOrdinal) failures.push(`${item.input}: targetOrdinal=${String(actual.targetHint?.ordinal)}`);
      if (item.expectedResolvedMessageId !== undefined && decision.resolvedTarget?.messageId !== item.expectedResolvedMessageId) failures.push(`${item.input}: resolvedMessageId=${String(decision.resolvedTarget?.messageId)}`);
    }
    expect(failures).toEqual([]);
  });
});
