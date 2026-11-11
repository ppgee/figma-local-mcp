# AGENTS.md

## 适用范围

本文件约定本仓库的开发与验证方式。安装、Agent 配置和用户操作说明见 `README.md`，不在这里重复维护。

## 项目目标与边界

- 项目由 Figma 桌面端插件和本地 stdio MCP 服务组成，通过 `127.0.0.1:3846` 桥接。
- 使用 Figma Plugin API，不依赖 Figma REST API 或在线 MCP 额度。
- 当前只提供设计读取、截图和本地导出，不修改 Figma 文件。新增写操作不能视为已有授权。
- 本地服务不主动上传设计数据；MCP 客户端和模型如何处理返回内容不属于本服务的控制范围。

## 目录与职责

- `src/plugin/code.ts`：插件编排：选区同步、Prompt 生成入口、轮询与命令转发。
- `src/plugin/ui.html`：独立插件界面，无前端框架或外部资源。
- `src/plugin/commands.ts`：插件命令执行（选区、结构、变量、导出），figma 上下文注入。
- `src/plugin/serialize.ts`：设计结构和节点的序列化。
- `src/plugin/prompt.ts`、`src/plugin/export.ts`：插件纯函数（Prompt 模板、base64 编码、导出倍率计算）。
- `src/server/index.ts`：MCP 服务入口，装配桥接、工具注册与 stdio 传输。
- `src/server/tools.ts`：MCP 工具注册、参数校验和导出文件写入。
- `src/server/bridge.ts`：本地 HTTP 桥接、认证、命令队列和连接状态；端口与令牌可通过 `BridgeOptions` 注入（默认读本地配置）。
- `src/server/config.ts`：用户数据目录中的本地配置。
- `src/shared/protocol.ts`：插件与服务端共享的协议类型。
- `scripts/build.mjs`、`scripts/install.mjs`：构建和本地安装。
- `tests/`：vitest 单元与集成测试；`vitest.config.ts` 配置覆盖率。
- `.github/workflows/ci.yml`、`.github/workflows/release.yml`：CI 与 tag 触发的发布。
- `manifest.json`：Figma 插件入口及网络权限。

## 工程约定

- 使用 Node.js 22 或更高版本，包管理器以 `package.json` 的 `packageManager` 为准。
- 使用 pnpm，不混用 npm 或 Yarn 生成其他锁文件。依赖变更必须更新 `pnpm-lock.yaml` 并说明原因。
- 沿用现有 TypeScript strict、ESM、esbuild 和文件内代码风格，不为局部修改引入新框架。
- 不在源码中写死用户目录或机器路径；需要用户目录时沿用 `os.homedir()` 的方式。
- 协议变更需同时检查 `src/shared/protocol.ts`、插件实现和 `src/server/bridge.ts` 的运行时校验，不能只修改类型。
- 版本号目前存在于 `package.json`、`scripts/build.mjs` 和 `src/server/index.ts`，版本变更时需同步；`tests/version-sync.test.ts` 会校验三处一致。

## 发布与版本

- 发布流程：同步三处版本号 → 在 `CHANGELOG.md` 增加对应版本小节 → 合入 `main` → 打 `vX.Y.Z` tag 并推送。
- `release.yml` 由 `v*` tag 触发：校验 tag 与 `package.json` 版本一致、CHANGELOG 存在对应小节，`pnpm check` 与 `pnpm test` 通过后创建 GitHub Release，正文取自 CHANGELOG 小节。`tests/version-sync.test.ts` 同步校验版本号与 CHANGELOG 小节。
- 禁止把 `dist/` 构建产物附加到 Release 或对外分发：插件产物内嵌本地令牌。

## 常用命令

```bash
pnpm install --frozen-lockfile  # 安装锁定依赖
pnpm typecheck                 # TypeScript 类型检查
pnpm build                     # 构建到 dist/
pnpm check                     # 类型检查并构建
pnpm test                      # 运行单元与集成测试
pnpm test:watch                # 测试 watch 模式
pnpm test:coverage             # 测试并输出覆盖率
pnpm install:local             # 构建并安装到本机固定目录
```

`pnpm start` 启动的是 stdio MCP 服务，不是可独立访问的开发服务器；通常由 MCP 客户端调用，不作为前台测试命令长时间运行。

## 验证要求

- 源码、构建脚本或依赖变更后运行 `pnpm check`；服务端、序列化或测试相关变更后同时运行 `pnpm test`。纯文档变更不必重复构建。
- 测试框架为 vitest（仅 devDependency）。单元与集成测试位于 `tests/`，覆盖序列化截断、插件命令执行、插件纯函数、配置校验、桥接认证/队列/超时/多实例复用、MCP 工具层和版本号同步。
- 测试通过临时沙箱目录与随机回环端口运行：不得读写真实的 `~/.local/share/figma-local-mcp` 配置与导出目录，不得占用或终止 3846 端口上的现有服务。
- 插件 UI（`ui.html`）和插件轮询编排（`code.ts` 的 poll 循环与消息处理）不在自动化测试范围，仍需在 Figma 桌面端验证与变更相关的真实场景，包括选区同步、实际粘贴内容、空选/多选和收起状态。构建成功不等于界面验证通过。
- MCP 改动需通过真实客户端调用相关工具，不能只验证模块导入或服务启动。
- 日志出现 `Bridge mode: reusing` 表示复用已有服务，不能据此声称新启动的服务端代码已验证。不要为了测试擅自终止其他 Agent 的 MCP 进程。
- `pnpm install:local` 会修改仓库外的本地安装，仅在需要验证安装流程时运行。只清理由本次运行产生的备份，优先移入废纸篓。

## 插件行为约束

- 单选时显示并复制当前节点 Prompt，空选或多选时禁用复制。
- 复制时重新读取当前选区，不能使用缓存的旧节点。
- `selectionchange` 和 `currentpagechange` 后及时更新界面。
- 收起状态下仍保持连接并可复制；不要把隐藏或关闭插件窗口当作收起的替代方案。
- 保持 `Cmd/Ctrl + Shift + C` 快捷键和复制失败时的手动复制入口可用。

## 本地数据与安全

- 真实令牌位于 `~/.local/share/figma-local-mcp/config.json`，不要读取后打印、写入文档或提交。
- `dist/` 中的插件构建产物包含令牌，必须继续被 Git 忽略，不要强制添加。
- 本地导出写入 `~/.local/share/figma-local-mcp/exports`，不要提交导出内容。
- 本地安装使用 `~/figma-local-mcp-app` 和 `~/.local/bin/figma-local-mcp`，移动源码目录不应影响已安装命令。
- 桥接仅监听回环地址，不扩大网络暴露范围或放宽令牌校验。

## 文档同步

命令、目录职责、安装路径、协议约束或验证方式变化时，同步更新本文件和 `README.md` 中受影响的说明。
