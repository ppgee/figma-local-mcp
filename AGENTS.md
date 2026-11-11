# AGENTS.md

## Scope

This file defines how the repository is developed and verified. Installation, agent configuration and user-facing instructions live in `README.md` (English) and `README.zh-CN.md` (Chinese); do not duplicate them here.

## Project goals and boundaries

- The project consists of a Figma desktop plugin and a local stdio MCP service, bridged over `127.0.0.1:3846`.
- It uses the Figma Plugin API; it does not rely on the Figma REST API or online MCP quotas.
- It only provides design reading, screenshots and local exports; it does not modify Figma files. New write operations are not pre-authorized.
- The local service never uploads design data on its own; how MCP clients and models handle returned content is outside this service's control.

## Layout and responsibilities

- `src/plugin/code.ts`: plugin orchestration — selection sync, prompt entry point, polling and command forwarding.
- `src/plugin/ui.html`: standalone plugin UI; no frontend framework, no external resources.
- `src/plugin/commands.ts`: plugin command execution (selection, structure, variables, styles, document/search, exports) with an injected Figma context.
- `src/plugin/serialize.ts`: serialization of the design structure and nodes.
- `src/plugin/prompt.ts`, `src/plugin/export.ts`: plugin pure helpers (prompt template, base64 encoding, export scale computation).
- `src/server/index.ts`: MCP service entry — assembles the bridge, tool registration and stdio transport.
- `src/server/tools.ts`: MCP tool registration, parameter validation and export file writing.
- `src/server/bridge.ts`: local HTTP bridge, auth, per-file sessions, command routing and connection state; port and token are injectable via `BridgeOptions` (defaults come from local config).
- `src/server/config.ts`: local configuration in the user data directory.
- `src/shared/protocol.ts`: protocol types shared by plugin and server.
- `src/shared/messages.ts`: bilingual runtime message catalog (single source for localized strings).
- `src/plugin/i18n.ts`: locale resolution helper.
- `scripts/build.mjs`, `scripts/install.mjs`: build and local install.
- `tests/`: vitest unit and integration tests; `vitest.config.ts` configures coverage.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`: CI and tag-triggered releases.
- `manifest.json`: Figma plugin entry and network permissions.

## Engineering conventions

- Node.js 22 or newer; the package manager follows `packageManager` in `package.json`.
- Use pnpm; do not generate other lockfiles with npm or Yarn. Dependency changes must update `pnpm-lock.yaml` with a stated reason.
- Keep the existing TypeScript strict, ESM, esbuild and in-file code style; do not introduce new frameworks for local changes.
- Do not hardcode user directories or machine paths in source; use `os.homedir()` where a home directory is needed.
- User-facing runtime strings live in the shared bilingual catalog `src/shared/messages.ts` (the `zh` table is type-checked against `en`). The plugin UI has its own table in `ui.html` (it cannot import modules).
- Protocol changes must update `src/shared/protocol.ts`, the plugin implementation and the runtime validation in `src/server/bridge.ts` together — types alone are not enough.
- Session model: the bridge keeps one session per Figma file key (`PluginDocumentStatus.fileKey`; the plugin falls back to a synthetic key for unsaved drafts). Polls without a `fileKey` are rejected. Commands route to the targeted session's queue — per-file serialization, parallel across files — and without a `fileKey` they target the most recently active session. Sessions expire after 5s without reports, failing their queued commands immediately.
- The version number exists in `package.json`, `scripts/build.mjs` and `src/server/index.ts` and must be bumped in sync; `tests/version-sync.test.ts` verifies all three match.

## Releases and versioning

- Release flow: sync the three version places → add a matching section to `CHANGELOG.md` → merge into `main` → tag `vX.Y.Z` and push.
- `release.yml` triggers on `v*` tags: it verifies the tag matches `package.json`, that CHANGELOG has the matching section, and that `pnpm check` and `pnpm test` pass, then creates the GitHub Release with the CHANGELOG section as its body. `tests/version-sync.test.ts` guards both invariants.
- Never attach `dist/` build artifacts to a Release or distribute them: plugin builds embed the local token.

## Common commands

```bash
pnpm install --frozen-lockfile  # Install locked dependencies
pnpm typecheck                 # TypeScript type check
pnpm build                     # Build into dist/
pnpm check                     # Type check and build
pnpm test                      # Run unit and integration tests
pnpm test:watch                # Tests in watch mode
pnpm test:coverage             # Tests with coverage report
pnpm install:local             # Build and install into the fixed local directory
```

`pnpm start` runs the stdio MCP service — it is not a standalone dev server; it is normally launched by an MCP client, not kept running in the foreground.

## Verification requirements

- Run `pnpm check` after source, build script or dependency changes; also run `pnpm test` after server, serialization or test changes. Pure documentation changes do not need a rebuild.
- The test framework is vitest (devDependency only). Unit and integration tests live in `tests/`, covering serialization truncation, plugin command execution, plugin pure helpers, config validation, bridge auth/queue/timeout/multi-file sessions/multi-instance reuse, the MCP tool layer and version sync.
- Tests run with sandbox directories and random loopback ports: never read or write the real `~/.local/share/figma-local-mcp` config or export directories, and never occupy or terminate services on port 3846.
- The plugin UI (`ui.html`) and the plugin polling orchestration (`code.ts` poll loop and message handling) are outside automated tests; verify real scenarios in the Figma desktop app — selection sync, actual pasted content, empty/multi selection and the collapsed state. A successful build is not a passing UI verification.
- MCP changes must be exercised through a real client calling the affected tools; importing the module or starting the service is not enough.
- A `Bridge mode: reusing` log line means an existing service was reused — it does not verify newly started server code. Never terminate other agents' MCP processes for testing.
- `pnpm install:local` modifies the local install outside the repository; run it only when the install flow needs verifying. Clean up only backups created by the current run, preferring the trash.

## Plugin behavior constraints

- The plugin UI language follows the system locale (`zh*` → Chinese, otherwise English) with a manual toggle persisted in clientStorage; the plugin reports its locale to the server, which localizes runtime messages accordingly (English fallback before the plugin connects).
- Each plugin window reports its file's key (`figma.fileKey`, synthetic for drafts). Multiple files may connect simultaneously; each gets its own bridge session, and tools can target a file with the optional `fileKey` argument.
- With a single selection, show and copy the current node prompt; with an empty or multi selection, disable copy.
- Re-read the current selection when copying — never use a cached stale node.
- Update the UI promptly after `selectionchange` and `currentpagechange`.
- Stay connected and copyable while collapsed; hiding or closing the plugin window is not a substitute for collapsing.
- Keep `Cmd/Ctrl + Shift + C` working and keep the manual copy fallback available when automatic copy fails.
- The manifest uses `documentAccess: "dynamic-page"`: tools that touch other pages (`find_nodes`, `get_document`) must `await page.loadAsync()` before reading a page's children; the current page and `getNodeByIdAsync` are always available.

## Local data and security

- The real token lives in `~/.local/share/figma-local-mcp/config.json`; never print, document or commit it.
- Plugin build artifacts under `dist/` embed the token; they must stay Git-ignored — never force-add them.
- Local exports are written to `~/.local/share/figma-local-mcp/exports`; never commit export contents.
- The local install uses `~/figma-local-mcp-app` and `~/.local/bin/figma-local-mcp`; moving the source directory must not affect the installed command.
- The bridge listens on the loopback interface only; do not widen network exposure or relax token validation.

## Documentation sync

When commands, layout responsibilities, install paths, protocol constraints or verification practices change, update this file and the affected parts of `README.md` and `README.zh-CN.md`.
