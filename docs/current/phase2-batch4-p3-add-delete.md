# 第二阶段第四批 P3：add_element / delete_element 验收入口

本批验收脚本为 `scripts/verify-production-document-add-delete.cjs`，与 P2 的
`verify-production-document-update.cjs` 分开维护。默认命令只执行隔离 dry-run：

```text
pnpm verify:production-document-add-delete
```

dry-run 使用现有 Runner、Office/PDF QA 和 RegisteredPresentationReader 建立 4
页合成 PPT，第二页和另一页各有一个相同文本对象；不会解密 Provider 凭证，也不
发出 HTTP 请求。报告写入被忽略的
`outputs/phase2-batch4-p3-kimi-add-delete/dry-run.json`，脱敏范围证据为
`docs/evidence/phase2-batch4-p3.json`。

获得本轮明确授权后，真实入口需要在已构建的 Electron 运行时显式传入：

```text
pnpm exec electron scripts/verify-production-document-add-delete.cjs --authorized-add-delete-case --model kimi-k3
```

脚本最多允许 7 次 HTTP，要求 Provider 完成一次
`add_element` 和一次 `delete_element`，并在两次写入后各有
`read_document_structure` 真实读回；写入前允许 Provider 额外读取结构。脚本检查
实际 wire model、Canonical Schema、tool_call_id、Host 生成的 opaque elementId、
revision 1→2→3、manifest/tombstone、旧 Artifact、真实 PPTX 读回和路径/Runtime
脱敏。

2026-09-29 真实验收已通过：指定 `kimi-k3`，6 次 HTTP，工具结果中的 add/delete
各成功一次，新增 ID 在 revision 2 的真实 PPTX 和 identity manifest 中恢复，删除后
revision 3 仅留下 tombstone；两个原有相同文本元素和未修改 elementId 保持不变，
旧 Artifact 保留，最终回答基于真实 Observation，未发现路径、内部身份或 Runtime
Context 外泄。脱敏机器证据见 `docs/evidence/phase2-batch4-p3.json`，原始本地报告
见 `outputs/phase2-batch4-p3-kimi-add-delete/real-provider.json`。
