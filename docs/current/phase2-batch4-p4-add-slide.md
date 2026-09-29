# 第二阶段第四批 P4：add_slide 验收记录

本批只实现 `add_slide`，不实现 `delete_slide`、reorder、duplicate、move 或其他页面/元素 CRUD。生产入口仍由现有 Canonical Tool Contract、Available Tool Set、Runtime Context、DocumentVersionPin、DocumentMutationCoordinator、CAS、QA/Hash/Work 和 Session refresh 组成。

`add_slide` 的 Provider 参数只有 `position`、受控的 `referencePageId` 和可选 `title`。新 pageId 及可选标题 elementId 由 Host 根据本次幂等键创建；模型不能提交身份、物理 slide part、路径、Work/File ID、checksum 或 Runtime Context。Patch 是单操作严格合同：`add_slide` 携带新 pageId、`before|after|end` 位置、可选 referencePageId 和成对的 title/titleElementId。

页面顺序按 `presentation.xml` 的 `p:sldIdLst` 维护，业务身份按原 slide part 继承。`after`/`before` 按精确 pageId 插入；`end` 在可识别 closing 页之前插入，没有 closing 页时追加。物理页码在新 revision 重新计算，原 pageId 不随 ordinal 变化。可选标题生成受控文本 shape，并在 identity manifest 中绑定新 elementId。

## 验证

- manifest 14/14：after、before、end-before-closing、无 closing append、重复标题按 pageId 定位、真实 PPTX round-trip。
- 生产 mutation adapter、session、canonical contract、bridge 和 coordinator 定向测试通过；共享 coordinator 已覆盖 CAS、取消、QA/materialization rollback、revision conflict、authorization、持久幂等和 committed_pending_refresh。
- `pnpm test`：Node/UI 384/384；Vitest 264 文件、2353/2353。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm audit:platform`、`pnpm verify:recovery-audit`、`pnpm verify:phase9-closeout`、`pnpm verify:plan-compliance`、`git diff --check`：全部通过。
- `pnpm verify:production-document-add-slide`：隔离 dry-run 通过，无网络请求。
- 指定 `kimi-k3` 真实验收：4 次 HTTP，`read_document_structure → add_slide → read_document_structure`；新页在目标第二页后真实出现，new pageId/title elementId 从真实文件恢复，后续原 pageId 稳定，最终回答使用真实 Observation，脱敏检查通过。

P4 完成后停止。`delete_slide` 留待后续负责人明确授权的 P5。
