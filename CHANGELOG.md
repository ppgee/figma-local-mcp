# Changelog

Notable changes to this project. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows SemVer. On release, `release.yml` extracts the matching section as the GitHub Release body.

## [0.4.0] - 2026-11-11

### Added

- Full internationalization: the plugin UI language follows the system locale (`zh*` → Chinese, otherwise English) with a manual language toggle in the plugin header; the choice persists across sessions.
- A shared bilingual message catalog (`src/shared/messages.ts`) as the single source for runtime strings; the Chinese table is type-checked against the English one.
- Runtime errors now follow the plugin's language, including plugin command errors, bridge errors and MCP tool errors (the server learns the locale from the plugin's poll reports; English applies until the plugin connects).
- The copied node prompt template follows the selected language.
- `resolveLocale` helper (`src/plugin/i18n.ts`) with unit tests.

## [0.3.0] - 2026-11-11

### Changed

- Internationalized the repository: `README.md` is now English-first with the previous Chinese content moved to `README.zh-CN.md` (cross-linked); `AGENTS.md` and `CHANGELOG.md` are in English.
- All user-facing product strings are now English: plugin UI (`ui.html`), the copied node prompt template, runtime error messages (plugin and server), and installer messages. No logic changes.
- Commit messages on this repository switch to English.

## [0.2.1] - 2026-11-11

### Added

- Adopted the MIT license: added the `LICENSE` file and the `license` field in `package.json`.

### Changed

- Rewrote history to use the GitHub noreply email for all commits, preparing the repository for public release; the tag and Release were rebuilt as a result (the v0.2.0 release content is recorded on this page).

## [0.2.0] - 2026-11-11

### Added

- Unit and integration test suite (vitest, 78 cases): covers node serialization truncation, plugin command execution, local config validation, bridge auth/command queue/timeout/multi-instance reuse, MCP tool parameter validation and export writing, and a version-sync guard. Tests use sandbox directories and random loopback ports; they never touch real local config or running services.
- Coverage report: `pnpm test:coverage` (`@vitest/coverage-v8`).
- CI: pushes and PRs to `main` run type check, build and tests (`.github/workflows/ci.yml`).
- Tag-triggered releases: pushing `vX.Y.Z` triggers `release.yml`, which verifies the tag matches `package.json`, that CHANGELOG has the matching section, then creates the GitHub Release after tests pass.
- Version-sync guard test (`package.json`, `scripts/build.mjs`, `src/server/index.ts` stay in sync).

### Changed

- Plugin command execution moved to `src/plugin/commands.ts` (injected Figma context); `code.ts` is now a thin orchestration layer, with pure helpers split into `prompt.ts` and `export.ts`.
- MCP tool registration moved to `src/server/tools.ts`; `src/server/index.ts` became a thin entry.
- `PluginBridge` accepts injected port and token (`BridgeOptions`) and exposes `boundPort`; default behavior unchanged.
- `createDesignContext` takes document info as an explicit parameter instead of reading the global `figma`.

### Fixed

- Export file names are now clamped to 120 UTF-8 bytes: an 80-character CJK node name is about 240 bytes and, with the prefix, exceeded the Linux 255-byte file name limit, failing exports with `ENAMETOOLONG` (found by CI on its first run).
- Bridge `origin` did not use the actually bound port when `port: 0` was injected.

## [0.1.0] - 2026-11-11

### Added

- Initial release: a Figma desktop plugin plus a local stdio MCP service bridged over `127.0.0.1:3846`, using the Figma Plugin API without consuming official MCP/REST read quotas.
- Six read-only MCP tools: `get_plugin_status`, `get_selection`, `get_design_context`, `get_variable_defs`, `export_node`, `get_screenshot`.
- Plugin UI: live selection display, one-click node prompt copy (`⌘/Ctrl + Shift + C`, re-reading the latest selection on copy), disabled copy for empty/multi selection, and a collapsible mini bar with state memory.
- Fixed local install: `~/figma-local-mcp-app`, the `figma-local-mcp` command, config and exports under `~/.local/share/figma-local-mcp`; the source directory can be moved freely.
- Multi-session bridge reuse: later MCP instances reuse the existing bridge without interfering with each other.
