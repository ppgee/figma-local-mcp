# Changelog

本项目的显著变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本。发布时由 `release.yml` 提取对应版本小节作为 GitHub Release 正文。

## [0.2.1] - 2026-11-11

### 新增

- 采用 MIT 许可证：新增 `LICENSE` 文件，`package.json` 增加 `license` 字段。

### 变更

- 历史提交邮箱统一为 GitHub noreply 地址，为公开仓库做准备；因历史改写，tag 与 Release 重建（v0.2.0 Release 内容已并入本页记录）。

## [0.2.0] - 2026-11-11

### 新增

- 单元与集成测试体系（vitest，78 个用例）：覆盖节点序列化截断、插件命令执行、本地配置校验、桥接认证/命令队列/超时/多实例复用、MCP 工具参数校验与导出落盘、版本号同步守卫。测试使用沙箱目录与随机回环端口，不读写本机真实配置，不影响正在运行的服务。
- 覆盖率报告：`pnpm test:coverage`（`@vitest/coverage-v8`）。
- CI：push / PR 到 `main` 自动运行类型检查、构建与测试（`.github/workflows/ci.yml`）。
- tag 触发发布：推送 `vX.Y.Z` 触发 `release.yml`，校验 tag 与 `package.json` 版本一致、CHANGELOG 存在对应小节并通过测试后，自动创建 GitHub Release 并以 CHANGELOG 小节作为正文。
- 版本号同步守卫测试（`package.json`、`scripts/build.mjs`、`src/server/index.ts` 三处一致）。

### 变更

- 插件命令执行抽到 `src/plugin/commands.ts`（figma 上下文注入），`code.ts` 收敛为编排层，插件纯函数拆分到 `prompt.ts` 与 `export.ts`。
- MCP 工具注册抽到 `src/server/tools.ts`，`src/server/index.ts` 变为薄入口。
- `PluginBridge` 支持注入端口与令牌（`BridgeOptions`）并暴露 `boundPort`，默认行为不变。
- `createDesignContext` 的文档信息改为显式参数，不再隐式读取全局 `figma`。

### 修复

- 导出文件名按 UTF-8 字节钳制到 120 字节：中文等长节点名 80 字符约 240 字节，叠加前缀后超出 Linux 文件系统 255 字节上限，导致导出 `ENAMETOOLONG` 失败（CI 首跑发现）。
- 桥接 `origin` 在注入 `port: 0` 时未使用实际绑定端口的问题。

## [0.1.0] - 2026-11-11

### 新增

- 首个版本：Figma 桌面端插件 + 本地 stdio MCP 服务，经 `127.0.0.1:3846` 桥接，使用 Figma Plugin API，不消耗官方 MCP/REST 读取额度。
- 6 个只读 MCP 工具：`get_plugin_status`、`get_selection`、`get_design_context`、`get_variable_defs`、`export_node`、`get_screenshot`。
- 插件界面：实时选区显示、一键复制节点 Prompt（`⌘/Ctrl + Shift + C`，复制时重读最新选区）、空选/多选禁用、可收起小状态条并记忆状态。
- 固定安装：`~/figma-local-mcp-app`、`figma-local-mcp` 命令、配置与导出目录位于 `~/.local/share/figma-local-mcp`；源码目录可迁移。
- 多会话桥接复用：后启动的 MCP 实例复用已有桥接，互不影响。
