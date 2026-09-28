# 第二阶段第四批 P1：稳定身份与文本 Patch

状态：`spike_and_core_boundary_passed`（2026-09-28）。本子批不进入 add/delete、页面增删、shape/image CRUD 或布局重构。

## 固定设计

- 身份元数据采用 **external manifest**，不写入 PPTX，也不修改 PptxGenJS。
- Manifest 绑定 `documentLineageId + workId + revision + exact artifact SHA-256`。
- 首次索引为每个物理页和文本 shape 分配 opaque UUID；后续版本只通过原 manifest 的具体 `slidePart + cNvPr shapeId` locator 继承 ID。
- 文本、坐标、页码、数组序号和 fingerprint 只用于校验，不用于猜测或重建身份。定位缺失或文本漂移返回 `identity_unresolved` / `identity_ambiguous`。
- authoritative editable source 是“已登记 PPTX 字节 + checksum-pinned external manifest”。更新采用 copy-on-write XML overlay，旧 artifact 保持不变；不是从聚合 read-back 文本重建整份 Document IR。

## Patch 与提交边界

第一版 Patch 只有一个操作：

```json
{"schemaVersion":1,"operations":[{"op":"update_text","target":{"elementId":"..."},"text":"..."}]}
```

`update_element` 的模型参数只有 `elementId` 与 `text`。Document version pin 为 `headWorkId`、File、source execution、完整 SHA-256、runtime revision 和 identity-index version。Mutation Coordinator 的状态为：

```text
pinned → identity_resolved → patch_validated → candidate_prepared
→ materialized → qa_verified → commit_prepared → committed
→ session_refreshed
```

Candidate manifest 在 head CAS 前生成并验证。候选 Work 注册后再执行 authoritative head CAS；CAS 失败进入 reconciliation，旧 head 不变；CAS 成功但 Session 刷新失败返回 `committed_pending_refresh`。取消、幂等、QA 失败和 revision conflict 均 fail closed。

## 已验证

- 同一页两个相同文本 shape 获得不同 element ID，指定第二个更新后真实 PPTX XML 读回仍定位第二个，第一个不变。
- 同一 element ID 可连续更新并保持不漂移。
- checksum/locator 不匹配被拒绝。
- Patch 校验拒绝未知字段、运行时字段和非法文本。
- Coordinator 测试覆盖 commit、幂等、CAS 冲突、取消、QA 失败保护和 `committed_pending_refresh`。
- `pnpm test`：258 个 Vitest 文件、2264 项通过；`pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。

## 当前边界

当前已完成 manifest、Patch、Coordinator 和 Canonical `update_element` Binding 的核心边界及 spike。Binding 尚未接入第三批 `ConversationDocumentToolSession` 的生产写会话，也尚未创建实际 Work/File/head repository adapter；因此本子批不宣称真实 Provider 的 update_element 生产验收完成。下一步只能在明确的 Session/Work CAS 适配器中接线，继续保持第三批生成与读取链路不变。
