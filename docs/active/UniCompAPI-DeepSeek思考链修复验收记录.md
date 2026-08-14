# UniCompAPI DeepSeek 思考链修复验收记录

## 阶段与范围

- 当前仍为阶段 9 已收口，阶段 10 未启动。
- 本次属于 UniCompAPI 文本推理请求缺陷修复，不新增页面、DTO、IPC、仓储 Schema 或迁移。
- 修改范围限定为 NewAPI 共享聊天适配器中的 UniCompAPI DeepSeek V4 请求序列化、合成协议测试及工程记录。
- 普通 NewAPI、自定义 OpenAI 兼容服务、DeepSeek 官方适配器、图片和视频调用语义保持不变。
- 未由工程验证发起真实收费调用，未读取或输出真实凭证。

## 原因与真实故障证据

第一次修复错误地参考 DeepSeek 官方适配器，向 UniCompAPI 的 OpenAI Compatible 请求直接注入 `thinking.type=enabled`，但该字段不在 UniCompAPI 公开的 Chat Completions 请求合同中。

2026-08-14 本地真实执行记录确认：

- 14:12 的 `deepseek-v4-flash` 请求发生在源码修改、重新构建和 Electron 重启之前；请求完成并保存 3858 字正文，但只有 174 个 `content_delta`，`reasoning_delta` 为 0，不能称为思考链成功；
- 源码于 14:27 加入错误字段，14:38:48 重新构建并重启；14:39:11 新进程首次推理请求在 0 个内容/思考分片时以 `newapi.invalid_response` 失败；
- 第一次合成测试只证明本地能够解析人为构造的 `reasoning_content`，不能证明 UniCompAPI 接受 `thinking` 请求字段。

UniCompAPI 公开状态接口指向官方 Apifox 文档 `https://rz6jfb2cv7.apifox.cn/472080530e0`。该 Chat Completions 合同公开的推理请求字段为 `reasoning_effort`，取值 `low`、`medium`、`high`，默认 `medium`；响应字段为 `reasoning_content`。公开请求合同中没有 `thinking`。

## 实际修改

当且仅当以下条件同时成立且用户没有显式填写 `reasoning_effort` 时，NewAPI 聊天适配器自动加入：

```json
{
  "reasoning_effort": "medium"
}
```

条件为：

1. RouteSnapshot 包为 `provider-package-unicompapi`；
2. 模型精确为 `deepseek-v4-flash` 或 `deepseek-v4-pro`；
3. 当前 ProductFeature 为 `text_reasoning`。

用户显式选择 `low`、`medium` 或 `high` 时原值优先。普通对话不注入 `reasoning_effort`；普通对话即使异常收到 `reasoning_content`，也继续按既有隔离规则不保存为思考链。请求体不再为 UniCompAPI DeepSeek 注入 `thinking`。

## 验证结果

适配器端到端合成测试覆盖：

- UniCompAPI `deepseek-v4-flash` 深度推理空参数请求包含 `reasoning_effort=medium`，不包含 `thinking`；
- UniCompAPI `deepseek-v4-pro` 显式选择 `high` 时保留用户值；
- 同一模型普通对话不包含 `reasoning_effort` 或 `thinking`；
- 合成上游的 `reasoning_content` 被独立保存，普通对话收到该字段时不混入思考链。

当前验证结果：

- NewAPI/UniCompAPI 聚焦测试：41 项通过；
- 完整门禁：Node/UI 260 项与 Vitest 691 项，共 951 项通过，0 失败、0 跳过；
- TypeScript、ESLint、生产构建、331 文件平台审计、50 项交接校验和差异检查通过。

## 未完成项与人工验证

- 应用必须完整重启以加载新的主进程代码，再由用户使用 UniCompAPI `deepseek-v4-flash/pro` 人工验证。
- 本地只真实渲染上游返回的 `reasoning_content`。如果请求完成但该字段仍为空，必须明确记录为上游未返回思考链，不能由 UI 生成或猜测。
