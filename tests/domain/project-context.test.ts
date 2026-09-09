import { describe, expect, it } from 'vitest';
import {
  InvariantViolationError,
  addProjectContextDraftFragment,
  createProjectContextContentSnapshot,
  createProjectContextDraft,
  deleteProjectContext,
  getCurrentProjectContextVersion,
  getProjectContextRevision,
  parseProjectContext,
  registerProjectContextDraft,
  removeProjectContextDraftFragment,
  replaceProjectContextDraftLabels,
  toConversationId,
  toIsoTimestamp,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  toProjectId,
  updateProjectContextContent,
  updateProjectContextSourceStatus
} from '../../src/domain';

const t0 = toIsoTimestamp('2026-07-28T12:00:00.000Z');
const t1 = toIsoTimestamp('2026-07-28T12:01:00.000Z');
const t2 = toIsoTimestamp('2026-07-28T12:02:00.000Z');
const t3 = toIsoTimestamp('2026-07-28T12:03:00.000Z');
const t4 = toIsoTimestamp('2026-07-28T12:04:00.000Z');
const t5 = toIsoTimestamp('2026-07-28T12:05:00.000Z');
const projectId = toProjectId('project-context-domain');
const conversationId = toConversationId('conversation-context-domain');

function draft() {
  return createProjectContextDraft({
    id: toProjectContextDraftId('context-draft-domain'),
    projectId,
    conversationId,
    createdAt: t0
  });
}

function addFragment(
  current = draft(),
  id = 'fragment-domain-1',
  messageId = 'message-domain-1',
  content = '第一段内容',
  updatedAt = t1
) {
  return addProjectContextDraftFragment(current, {
    id: toProjectContextFragmentId(id),
    conversationId,
    messageId: toMessageId(messageId),
    messageRevision: 0,
    messageRole: 'user',
    selection: { schemaVersion: 1, startUtf16: 0, endUtf16: content.length },
    contentSnapshot: content
  }, updatedAt);
}

describe('project context drafts', () => {
  it('keeps multiple normalized fragments from one conversation in explicit order', () => {
    const first = addFragment(
      draft(),
      'fragment-domain-1',
      'message-domain-1',
      '  第一段\r\n内容  ',
      t1
    );
    const second = addFragment(
      first,
      'fragment-domain-2',
      'message-domain-2',
      '第二段内容',
      t2
    );
    const labeled = replaceProjectContextDraftLabels(
      second,
      [' 需求 ', '人物'],
      t3
    );

    expect(labeled).toMatchObject({
      revision: 3,
      projectId,
      conversationId,
      labels: ['需求', '人物']
    });
    expect(labeled.fragments.map((fragment) => ({
      order: fragment.selectionOrder,
      snapshot: fragment.contentSnapshot
    }))).toEqual([
      { order: 0, snapshot: '第一段\n内容' },
      { order: 1, snapshot: '第二段内容' }
    ]);
    expect(createProjectContextContentSnapshot(labeled.fragments)).toBe(
      '第一段\n内容\n\n第二段内容'
    );

    const removed = removeProjectContextDraftFragment(
      labeled,
      toProjectContextFragmentId('fragment-domain-1'),
      t4
    );
    expect(removed.fragments).toMatchObject([{ selectionOrder: 0 }]);
  });

  it('rejects fragments from another conversation', () => {
    expect(() => addProjectContextDraftFragment(draft(), {
      id: toProjectContextFragmentId('fragment-cross-conversation'),
      conversationId: toConversationId('another-conversation'),
      messageId: toMessageId('another-message'),
      messageRevision: 0,
      messageRole: 'assistant',
      selection: { schemaVersion: 1, startUtf16: 0, endUtf16: 4 },
      contentSnapshot: '禁止跨对话'
    }, t1)).toThrow('cannot contain multiple conversations');
  });
});

describe('registered project context history', () => {
  it('appends immutable revisions for updates, source status and tombstone deletion', () => {
    const registered = registerProjectContextDraft(
      addFragment(),
      toProjectContextId('context-domain'),
      t2
    );
    const updated = updateProjectContextContent(
      registered,
      '用户确认后的上下文',
      ['确认'],
      t3
    );
    const sourceDeleted = updateProjectContextSourceStatus(
      updated,
      'source_deleted',
      t4
    );
    const deleted = deleteProjectContext(sourceDeleted, t5);

    expect(deleted).toMatchObject({
      currentRevision: 4,
      status: 'deleted'
    });
    expect(getCurrentProjectContextVersion(deleted)).toMatchObject({
      revision: 4,
      status: 'deleted',
      sourceStatus: 'source_deleted',
      contentSnapshot: '用户确认后的上下文'
    });
    expect(getProjectContextRevision(deleted, 1)).toMatchObject({
      revision: 1,
      status: 'active',
      sourceStatus: 'available',
      contentSnapshot: '第一段内容'
    });
    expect(getProjectContextRevision(deleted, 2)).toMatchObject({
      contentSnapshot: '用户确认后的上下文',
      labels: ['确认']
    });
    expect(() => updateProjectContextContent(
      deleted,
      '禁止修改',
      [],
      t5
    )).toThrow(InvariantViolationError);
  });

  it('rejects overwritten source facts, impure tombstones and sensitive extra fields', () => {
    const registered = registerProjectContextDraft(
      addFragment(),
      toProjectContextId('context-strict'),
      t2
    );
    expect(() => parseProjectContext({
      ...registered,
      absolutePath: 'C:\\private\\project-contexts.json'
    })).toThrow('unexpected or missing fields');

    const updated = updateProjectContextContent(
      registered,
      '新版本',
      [],
      t3
    );
    expect(() => parseProjectContext({
      ...updated,
      versions: [
        updated.versions[0],
        {
          ...updated.versions[1],
          sourceFragments: [{
            ...updated.versions[1].sourceFragments[0],
            contentSnapshot: '篡改来源'
          }]
        }
      ]
    })).toThrow('source selection must remain immutable');

    const deleted = deleteProjectContext(updated, t4);
    expect(() => parseProjectContext({
      ...deleted,
      versions: [
        ...deleted.versions.slice(0, -1),
        { ...deleted.versions.at(-1), contentSnapshot: '删除时篡改内容' }
      ]
    })).toThrow('pure tombstone');
  });
});
