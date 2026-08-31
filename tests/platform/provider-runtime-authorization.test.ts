import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JsonRuntimeAuthorizationLedgerStore,
  RuntimeAuthorizationDeniedError,
  RuntimeAuthorizationLedger,
  RuntimeAuthorizationLedgerConflictError,
  type RuntimeAuthorizationLedgerDocumentV1
} from '../../src/platform';

const roots: string[] = [];
const t0 = '2026-08-03T00:00:00.000Z';
const t1 = '2026-08-03T00:01:00.000Z';
const t2 = '2026-08-03T00:02:00.000Z';
const t3 = '2026-08-03T00:03:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-runtime-auth-'));
  roots.push(root);
  return root;
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    policyId: 'policy-default',
    providerPackageId: 'provider.package',
    state: 'interactive_allowed' as const,
    revision: 1,
    allowedOperations: ['submit', 'query', 'cancel', 'receive_result'] as const,
    ...overrides
  };
}

describe('runtime authorization ledger', () => {
  it('denies by default and gives a specific blocked policy priority over a broad allow', async () => {
    const root = await fixture();
    const ledger = new RuntimeAuthorizationLedger(
      new JsonRuntimeAuthorizationLedgerStore(path.join(root, 'authorization.json')),
      () => t0
    );
    await expect(ledger.checkAccess({
      providerPackageId: 'provider.package',
      connectionId: 'connection-a',
      adapterKey: 'adapter-a',
      operation: 'submit',
      now: t0
    })).resolves.toMatchObject({ allowed: false, reason: 'no_matching_policy' });

    await ledger.upsertPolicy(policy());
    await ledger.upsertPolicy(policy({
      policyId: 'policy-block-connection',
      connectionId: 'connection-a',
      adapterKey: 'adapter-a',
      state: 'blocked',
      allowedOperations: []
    }));

    await expect(ledger.checkAccess({
      providerPackageId: 'provider.package',
      connectionId: 'connection-a',
      adapterKey: 'adapter-a',
      operation: 'submit',
      now: t0
    })).resolves.toMatchObject({
      allowed: false,
      reason: 'policy_blocked',
      policyId: 'policy-block-connection'
    });
    await expect(ledger.checkAccess({
      providerPackageId: 'provider.package',
      connectionId: 'connection-b',
      adapterKey: 'adapter-a',
      operation: 'submit',
      now: t0
    })).resolves.toMatchObject({ allowed: true, policyId: 'policy-default' });
  });

  it('rejects expired policies, disallowed operations, and stale policy revisions before claiming', async () => {
    const root = await fixture();
    const ledger = new RuntimeAuthorizationLedger(
      new JsonRuntimeAuthorizationLedgerStore(path.join(root, 'authorization.json')),
      () => t2
    );
    await ledger.upsertPolicy(policy({
      allowedOperations: ['submit'],
      expiresAt: t1
    }));

    await expect(ledger.checkAccess({
      providerPackageId: 'provider.package',
      operation: 'query',
      now: t2
    })).resolves.toMatchObject({ allowed: false, reason: 'policy_expired' });
    await expect(ledger.claimSubmission({
      providerPackageId: 'provider.package',
      policyRevision: 2,
      routeSelectionNonce: 'nonce-expired',
      idempotencyKey: 'intent-expired',
      now: t2
    })).rejects.toMatchObject({ code: 'policy_expired' });
  });

  it('atomically enforces maximum submissions across independent ledger instances', async () => {
    const root = await fixture();
    const ledgerPath = path.join(root, 'authorization.json');
    const first = new RuntimeAuthorizationLedger(
      new JsonRuntimeAuthorizationLedgerStore(ledgerPath),
      () => t0
    );
    const second = new RuntimeAuthorizationLedger(
      new JsonRuntimeAuthorizationLedgerStore(ledgerPath),
      () => t0
    );
    await first.upsertPolicy(policy({ maximumSubmissions: 1 }));

    const results = await Promise.allSettled([
      first.claimSubmission({
        providerPackageId: 'provider.package',
        policyRevision: 1,
        routeSelectionNonce: 'nonce-a',
        idempotencyKey: 'intent-a',
        now: t0
      }),
      second.claimSubmission({
        providerPackageId: 'provider.package',
        policyRevision: 1,
        routeSelectionNonce: 'nonce-b',
        idempotencyKey: 'intent-b',
        now: t0
      })
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ code: 'submissions_exhausted' })
    });

    const successfulResult = results.find((result) => result.status === 'fulfilled');
    if (!successfulResult || successfulResult.status !== 'fulfilled') {
      throw new Error('expected one authorization claim to succeed');
    }
    const successful = successfulResult.value;
    await expect(first.claimSubmission({
      providerPackageId: 'provider.package',
      policyRevision: 1,
      routeSelectionNonce: 'nonce-a',
      idempotencyKey: 'intent-a',
      now: t1
    })).resolves.toMatchObject({ claimId: successful.claimId });

    await first.releaseBeforeRequest(successful.claimId, t1);
    await expect(second.claimSubmission({
      providerPackageId: 'provider.package',
      policyRevision: 1,
      routeSelectionNonce: 'nonce-c',
      idempotencyKey: 'intent-c',
      now: t2
    })).resolves.toMatchObject({ state: 'claimed' });
  });

  it('consumes nonce and idempotency keys exactly once', async () => {
    const root = await fixture();
    const ledger = new RuntimeAuthorizationLedger(
      new JsonRuntimeAuthorizationLedgerStore(path.join(root, 'authorization.json')),
      () => t0
    );
    await ledger.upsertPolicy(policy());
    const claim = await ledger.claimSubmission({
      providerPackageId: 'provider.package',
      policyRevision: 1,
      routeSelectionNonce: 'nonce-once',
      idempotencyKey: 'intent-once',
      now: t0
    });
    await expect(ledger.claimSubmission({
      providerPackageId: 'provider.package',
      policyRevision: 1,
      routeSelectionNonce: 'nonce-once',
      idempotencyKey: 'intent-once',
      now: t1
    })).resolves.toMatchObject({ claimId: claim.claimId });
    await expect(ledger.claimSubmission({
      providerPackageId: 'provider.package',
      policyRevision: 1,
      routeSelectionNonce: 'nonce-once',
      idempotencyKey: 'intent-other',
      now: t1
    })).rejects.toMatchObject({ code: 'nonce_reused' });
    await expect(ledger.claimSubmission({
      providerPackageId: 'provider.package',
      policyRevision: 1,
      routeSelectionNonce: 'nonce-other',
      idempotencyKey: 'intent-once',
      now: t1
    })).rejects.toMatchObject({ code: 'idempotency_reused' });
  });

  it('keeps an in-flight continuation valid after policy blocking until explicit claim revocation', async () => {
    const root = await fixture();
    const ledger = new RuntimeAuthorizationLedger(
      new JsonRuntimeAuthorizationLedgerStore(path.join(root, 'authorization.json')),
      () => t0
    );
    await ledger.upsertPolicy(policy());
    const claim = await ledger.claimSubmission({
      providerPackageId: 'provider.package',
      policyRevision: 1,
      routeSelectionNonce: 'nonce-live',
      idempotencyKey: 'intent-live',
      now: t0
    });
    await ledger.markRequestStarted(claim.claimId, t1);
    await ledger.upsertPolicy(policy({ state: 'blocked', allowedOperations: [], revision: 2 }));

    await expect(ledger.checkAccess({
      providerPackageId: 'provider.package',
      operation: 'submit',
      now: t2
    })).resolves.toMatchObject({ allowed: false, reason: 'policy_blocked' });
    await expect(ledger.authorizeContinuation({
      claimId: claim.claimId,
      operation: 'query',
      now: t2
    })).resolves.toMatchObject({ allowed: true, reason: 'allowed' });

    await ledger.revokeClaim(claim.claimId, 'security-revocation', t2);
    await expect(ledger.authorizeContinuation({
      claimId: claim.claimId,
      operation: 'cancel',
      now: t3
    })).resolves.toMatchObject({ allowed: false, reason: 'claim_revoked' });
  });

  it('does not return a claim after request start and persists transitions', async () => {
    const root = await fixture();
    const ledgerPath = path.join(root, 'authorization.json');
    const ledger = new RuntimeAuthorizationLedger(
      new JsonRuntimeAuthorizationLedgerStore(ledgerPath),
      () => t0
    );
    await ledger.upsertPolicy(policy({ maximumSubmissions: 1 }));
    const claim = await ledger.claimSubmission({
      providerPackageId: 'provider.package',
      policyRevision: 1,
      routeSelectionNonce: 'nonce-transition',
      idempotencyKey: 'intent-transition',
      now: t0
    });
    await ledger.markRequestStarted(claim.claimId, t1);
    await expect(ledger.releaseBeforeRequest(claim.claimId, t2)).rejects.toMatchObject({
      code: 'claim_state_conflict'
    });
    await ledger.recordOutcome(claim.claimId, t3);
    const reloaded = await new JsonRuntimeAuthorizationLedgerStore(ledgerPath).load();
    expect(reloaded.claims).toMatchObject([{ claimId: claim.claimId, state: 'outcome_recorded' }]);
  });

  it('detects stale direct saves and retains a parseable revisioned document', async () => {
    const root = await fixture();
    const ledgerPath = path.join(root, 'authorization.json');
    const store = new JsonRuntimeAuthorizationLedgerStore(ledgerPath, () => t0);
    const empty = await store.load();
    const next: RuntimeAuthorizationLedgerDocumentV1 = {
      ...empty,
      revision: 1,
      policies: [policy()]
    };
    await store.save(next, 0);
    await expect(store.save(next, 0)).rejects.toBeInstanceOf(RuntimeAuthorizationLedgerConflictError);
    await expect(store.load()).resolves.toMatchObject({ revision: 1, policies: [policy()] });
  });

  it('exposes typed denial errors for claim failures', async () => {
    const root = await fixture();
    const ledger = new RuntimeAuthorizationLedger(
      new JsonRuntimeAuthorizationLedgerStore(path.join(root, 'authorization.json')),
      () => t0
    );
    await expect(ledger.claimSubmission({
      providerPackageId: 'provider.package',
      policyRevision: 1,
      routeSelectionNonce: 'nonce-denied',
      idempotencyKey: 'intent-denied',
      now: t0
    })).rejects.toBeInstanceOf(RuntimeAuthorizationDeniedError);
  });
});
