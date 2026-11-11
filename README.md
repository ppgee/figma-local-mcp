# Figma Local MCP

[English](README.md) | [简体中文](README.zh-CN.md)

Let coding agents read designs, variables and node screenshots from the currently open Figma file, through a Figma desktop plugin and a local MCP service. Uses the Figma Plugin API — no Figma REST API, no official MCP quota consumption.

Currently read-only: design queries and local exports. It does not modify Figma files.

## Requirements

- macOS
- Figma desktop app
- Node.js 22 or newer
- pnpm

## Install

```bash
pnpm install --frozen-lockfile
pnpm run install:local
```

After the first install, in the Figma desktop app choose **Plugins → Development → Import plugin from manifest...** and select:

```text
~/figma-local-mcp-app/manifest.json
```

Then run **Plugins → Development → Figma Local MCP Bridge** and wait until the plugin shows the local service is connected. Keep the plugin window open while using it; you can collapse it to a mini bar.

The installer creates:

- MCP command: `~/.local/bin/figma-local-mcp`
- Local config: `~/.local/share/figma-local-mcp/config.json`
- Export directory: `~/.local/share/figma-local-mcp/exports`
- Figma plugin: `~/figma-local-mcp-app`

Make sure `~/.local/bin` is on your `PATH`. Moving the source directory does not affect the installed command or plugin.

## Configure your agent

Claude Code can register the command directly — no absolute source paths:

```bash
claude mcp add --scope user figma-local -- figma-local-mcp
```

Other stdio MCP clients can use the equivalent config:

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

Each client starts its own MCP process and reuses the same local bridge. Do not put the plugin token into MCP config.

## Usage

1. Select a layer in Figma.
2. Click "Copy node prompt", or press `Cmd/Ctrl + Shift + C`. Copy also works while collapsed.
3. Paste the prompt straight into any agent configured with `figma-local`.

The plugin shows the current selection live. With no selection or multiple layers selected, copy is disabled.

MCP tools:

- `get_plugin_status`: check plugin connection and current selection.
- `get_selection`: read the current selection.
- `get_design_context`: read layout, text, styles, components and variable bindings.
- `get_variable_defs`: read local variable collections.
- `get_screenshot`: get a PNG screenshot of a node.
- `export_node`: export a node as PNG, SVG, JPG or PDF.

## Update

```bash
pnpm run check
pnpm run install:local
```

After updating, rerun the plugin in Figma — no manifest re-import, no MCP config changes.

## Development

```bash
pnpm run typecheck  # TypeScript type check
pnpm run build      # Build MCP service and plugin into dist/
pnpm run check      # Type check and build
pnpm test           # Unit and integration tests (vitest)
pnpm test:coverage  # Tests with coverage report
pnpm start          # Start the MCP service over stdio
```

Main directories:

- `src/plugin/`: Figma plugin and its UI.
- `src/server/`: MCP service and local bridge.
- `src/shared/`: protocol types shared by plugin and server.
- `scripts/`: build and local install scripts.
- `tests/`: unit and integration tests.

Tests cover node serialization truncation, plugin command execution, plugin pure helpers, local config validation, bridge auth/command queue/timeouts/multi-instance reuse, and MCP tool parameter validation with export file writing. Tests use sandbox directories and random loopback ports — they never touch your real config or running services. The plugin UI and polling orchestration still need manual verification in the Figma desktop app. After changes, run at least `pnpm run check` and `pnpm test`, and verify selection sync, prompt copy and MCP node reads in Figma.

## CI and releases

Pushes and PRs to `main` run type check, build and tests on GitHub Actions (`.github/workflows/ci.yml`).

Releases are triggered by tags:

```bash
# 1. Bump the version in all three places (package.json, scripts/build.mjs, src/server/index.ts)
# 2. Add a matching section to CHANGELOG.md (it becomes the release body)
# 3. Commit and merge into main
# 4. Tag and push
git tag v0.3.0
git push origin v0.3.0
```

On a `v*` tag, `release.yml` verifies the tag matches `package.json`, that CHANGELOG.md has the matching section, then runs `pnpm check` and `pnpm test`. If everything passes it creates the GitHub Release with the CHANGELOG section as the body, plus auto-generated change lists. Mismatched versions, a missing CHANGELOG section or failing tests block the release (both invariants are also guarded by tests).

Releases never attach build artifacts: plugin builds embed the local token and must not be distributed; users install from source per this README.

## Local data and security

The bridge listens on `127.0.0.1:3846` only, and the plugin authenticates with a random token. The token lives in the user data directory and is never committed; it is baked into the plugin build under `dist/`, which is why `dist/` stays Git-ignored.

This service never uploads design data to remote servers. How MCP clients and models handle returned content is outside this service's control.

## License

[MIT](LICENSE)
