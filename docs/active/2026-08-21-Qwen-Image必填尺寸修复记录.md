# 2026-08-21 Qwen-Image 必填尺寸修复记录

日期：2026-08-21

开发分支：`feature/fix-qwen-image-required-size`

## 问题

UniCompAPI 上游对 `qwen-image` 的 `size` 参数要求为必填，且格式为 `<width>x<height>`。原模型参数契约将 `size` 声明为可选字段；快速生图只投影必填字段，因此会在候选投影阶段移除 `size`，最终上游返回 `status_code=400, Missing required parameter(s): size`。

## 实际修改

- 将 `qwen-image` 文生图参数契约中的 `size` 改为 `user_required`、`require_user_value`、`required: true`。
- 参数契约 revision 从 2 升级为 3，使存量草稿和路由不会继续使用旧契约快照。
- 保持合法尺寸值为 `1664x928`、`1472x1104`、`1328x1328`、`1104x1472`、`928x1664`。
- 增加回归断言，确认快速生图的 `required_only` 投影仍包含 `size`，并继续验证最终请求采用 `<width>x<height>` 格式。

## 验收边界

- 不调用真实服务商，不读取凭证，不产生收费请求。
- 不改变模型选择组件、其他 Qwen 参数或 `qwen-image-edit-2509` 图生图契约。
- 阶段 10、签名、公证、更新、生产媒体组件和正式发布准入均未启动。

## 验证结果

- 定向参数、候选投影与图片链路 Vitest：62 项通过，0 失败。
- 全量测试：Node/UI/工具链 312 项与 Vitest 752 项，共 1064 项通过，0 失败。
- `pnpm.cmd typecheck`、`pnpm.cmd lint`、`pnpm.cmd build` 与 `git diff --check` 通过。
- 未执行真实 `qwen-image` 请求；最终联网复验需由项目负责人使用现有连接手工触发，避免未经确认的收费调用。
