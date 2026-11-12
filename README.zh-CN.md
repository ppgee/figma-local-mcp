# Figma Local MCP

[English](README.md) | [简体中文](README.zh-CN.md)

通过 Figma 桌面端插件和本地 MCP 服务，让编程 Agent 读取当前文件中的设计结构、变量和节点截图。使用 Figma Plugin API，不调用 Figma REST API，也不消耗 Figma 在线 MCP 额度。

目前提供只读查询和本地导出功能，不支持修改 Figma 设计。

## 环境要求

- macOS
- Figma 桌面客户端
- Node.js 22 或更高版本
- pnpm

## 安装

```bash
pnpm install --frozen-lockfile
pnpm run install:local
```

首次安装后，在 Figma 桌面客户端选择 **Plugins → Development → Import plugin from manifest...**，导入：

```text
~/figma-local-mcp-app/manifest.json
```

然后运行 **Plugins → Development → Figma Local MCP Bridge**，等待插件显示"本地 MCP 服务已连接"。使用时不要关闭插件窗口，可以点击收起按钮缩小窗口。

安装程序会创建以下内容：

- MCP 命令：`~/.local/bin/figma-local-mcp`
- 本地配置：`~/.local/share/figma-local-mcp/config.json`
- 导出目录：`~/.local/share/figma-local-mcp/exports`
- Figma 插件：`~/figma-local-mcp-app`
- 常驻后台桥接服务（launchd 代理 `com.figma-local-mcp.bridge`）：登录自启并保持存活，即使没有任何 MCP 客户端会话在跑，插件也不会掉线；MCP 进程自动复用它。日志：`~/.local/share/figma-local-mcp/bridge.log`。停止/启动：

```bash
launchctl bootout gui/$UID/com.figma-local-mcp.bridge     # 停止
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.figma-local-mcp.bridge.plist  # 启动
```

确保 `~/.local/bin` 已加入 `PATH`。移动源码目录不会影响已安装的命令或插件。

## 配置 Agent

Claude Code 可以直接注册命令，无需写源码的绝对路径：

```bash
claude mcp add --scope user figma-local -- figma-local-mcp
```

其他支持 stdio MCP 的客户端可以使用等价配置：

```json
{
  "mcpServers": {
    "figma-local": {
      "command": "figma-local-mcp",
      "args": []
    }
  }
}
```

每个客户端会启动自己的 MCP 进程，并复用同一个本地桥接服务。不要在 MCP 配置中填写插件令牌。

## 使用

1. 在 Figma 中选中一个图层。
2. 点击"复制节点 Prompt"，或按 `Cmd/Ctrl + Shift + C`。收起状态下也可以复制。
3. 将 Prompt 直接粘贴给已配置 `figma-local` 的 Agent。

插件会实时显示当前选区。未选中图层或选中多个图层时，复制按钮不可用。复制的 Prompt 包含节点 ID 和文件 fileKey，Agent 第一次调用就能锁定正确的文件。

`get_plugin_status` 的返回中还包含 `usageHints` 工作流指引（先截图看整体，再取结构，再取变量/样式，最后导出资产，以及工具选择与节点定位方式），任何 MCP 客户端第一次调用就能学会正确用法，无需额外安装 skill。

界面语言默认跟随系统（`zh*` 为中文，否则英文），可通过插件头部的按钮切换并记忆；复制的 Prompt 模板与运行时提示也跟随该语言。

支持同时连接多个文件：在每个打开的文件里运行插件，桥接服务会按 Figma 文件 key 为每个文件维护独立会话。`get_plugin_status` 会列出所有已连接文件及其 `fileKey`，最近活跃的文件是工具的默认目标；读取类工具都可以传可选的 `fileKey` 参数来锁定具体文件，避免读到别的文件的数据：

```json
{ "name": "get_design_context", "arguments": { "fileKey": "ABcDEF1234567", "nodeId": "1:23" } }
```

MCP 提供以下工具：

- `get_plugin_status`：列出已连接的文件、当前活跃文件 key 及其中的选区。
- `get_document`：列出所有页面及节点数、本地资源数量。
- `get_selection`：读取当前选区。
- `find_nodes`：按名称子串和/或类型搜索节点，可限定单页。
- `get_design_context`：读取布局、文本、样式、组件和变量绑定。
- `get_variable_defs`：读取本地变量集合。
- `get_style_defs`：读取本地颜色、文字、效果和网格样式。
- `get_screenshot`：获取节点 PNG 截图。
- `export_node`：将节点导出为 PNG、SVG、JPG 或 PDF。

## 插件无法使用的场景

| 场景 | 原因 | 解决方案 |
| --- | --- | --- |
| 只有查看权限的文件 | Figma 运行插件要求文件编辑权限 | 向所有者申请编辑权限，或请有权限的人导出相关画板；只读分析也可改用基于 Figma REST API 的工具 |
| FigJam 文件 | 本插件只支持 Figma 设计文件（`editorType: figma`） | 先把内容复制到 Figma 设计文件 |
| Figma 网页版 | 仅支持 Figma 桌面 App | 使用桌面 App |
| 组织管理员禁用了插件 | 企业设置可以整体禁用第三方/开发插件 | 请管理员放行开发插件 |
| 社区预览页和移动端 App | 没有插件运行环境 | 在桌面 App 编辑器中打开文件 |
| 断网 | Figma 本身需要联网 | 联网后再使用 |
| 其他电脑或同事的环境 | 这是带本机令牌的开发插件，没有发布到 Community | 在目标机器上克隆仓库并按本文档安装 |

未保存的草稿可以使用，但没有 `figma.fileKey`：插件会退回一个本次运行内稳定的合成 key，重启插件后 key 会变化；保存文件后即可获得稳定的 `fileKey`。

## 更新

```bash
pnpm run check
pnpm run install:local
```

更新后在 Figma 中重新运行插件即可，不需要重新导入 manifest，也不需要修改 Agent 的 MCP 配置。

## 开发

```bash
pnpm run typecheck  # TypeScript 类型检查
pnpm run build      # 构建 MCP 服务和插件到 dist/
pnpm run check      # 类型检查并构建
pnpm test           # 运行单元与集成测试（vitest）
pnpm test:coverage  # 运行测试并输出覆盖率报告
pnpm start          # 通过 stdio 启动 MCP 服务
```

主要目录：

- `src/plugin/`：Figma 插件及界面。
- `src/server/`：MCP 服务和本地桥接。
- `src/shared/`：插件与服务端共享的协议类型。
- `scripts/`：构建和本地安装脚本。
- `tests/`：单元与集成测试。

单元与集成测试覆盖节点序列化截断、插件命令执行、插件纯函数、本地配置校验、桥接认证/命令队列/超时/多实例复用，以及 MCP 工具参数校验与导出落盘。测试使用临时沙箱目录和随机回环端口，不会读写本机真实配置，也不会影响正在运行的服务。插件界面与轮询编排仍需在 Figma 桌面端人工验证。变更后至少运行 `pnpm run check` 与 `pnpm test`，并在 Figma 桌面端验证选区同步、Prompt 复制和 MCP 节点读取。

## 持续集成与发布

推送到 `main` 或提交 PR 时，GitHub Actions 会自动运行类型检查、构建与测试（`.github/workflows/ci.yml`）。

发布通过打 tag 触发：

```bash
# 1. 同步更新三处版本号（package.json、scripts/build.mjs、src/server/index.ts）
# 2. 在 CHANGELOG.md 增加对应版本的小节（作为 Release 正文）
# 3. 提交并合入 main
# 4. 打 tag 并推送
git tag v0.3.0
git push origin v0.3.0
```

推送 `v*` tag 后，`release.yml` 会校验 tag 与 `package.json` 版本一致、CHANGELOG 存在对应小节，跑完 `pnpm check` 与 `pnpm test`，全部通过后创建 GitHub Release，正文取自 CHANGELOG 小节并附加自动生成的变更列表。版本不一致、缺 CHANGELOG 小节或测试失败时不会发布（三处版本号与 CHANGELOG 小节也有测试守卫）。

Release 不附带构建产物：插件构建产物内嵌本地令牌，不能对外分发；使用方按 README 从源码安装。

## 本地数据与安全

桥接服务仅监听 `127.0.0.1:3846`，插件使用随机令牌认证。令牌保存在用户数据目录，不随源码提交；构建时写入 `dist/` 中的插件产物，因此 `dist/` 也被 Git 忽略。

本服务不主动将设计数据上传到远程服务。Agent 如何处理收到的设计内容，取决于对应 MCP 客户端和模型服务。

## 许可证

[MIT](LICENSE)
