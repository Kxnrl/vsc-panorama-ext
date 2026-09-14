# Changelog

All notable changes to this extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (unreleased)

- **Embedded MCP server** for AI assistants (Claude Code, Claude Desktop, Cursor, VS Code agent):
  a localhost daemon at `http://127.0.0.1:4377/mcp`, spawned on demand by any VS Code window and
  shared by every workspace. Six tools — `validate` (disk-based, with cross-file rules when a
  root is given or auto-detected), `panel_info`, `property_info`, `symbols`, `apply_fixes`, and
  `workspaces` (discovers the roots currently open in VS Code windows via heartbeat registration) —
  plus the raw
  reference data as resources and three prompts (`review_file`, `web_to_panorama`,
  `scaffold_layout`). Messages follow VS Code's display language; the daemon exits after 90 idle
  seconds. A Command Palette entry (`CS2 Panorama: Enable MCP for AI Assistants`) writes or
  copies the client config. Requires VS Code 1.101+ (`engines.vscode` raised from 1.85 for the
  stable `vscode.lm.registerMcpServerDefinitionProvider` API).
- **Auto-fixes** — deterministic repairs are now machine-executable in two places: as editor quick
  fixes on the lightbulb, and as the MCP `apply_fixes` tool (`ruleIds` filter, `dryRun`, automatic
  re-validation). Covers `visibility: hidden`→`collapse`, `@keyframes` quoting, box-shadow
  reordering, transition shorthand splitting, missing closing tags, root-panel `id` converted to `class`,
  `<Button>` text into a child `<Label>`, and binding prefixes `{d:}/{g:}/{t:}`→`{s:}`. Fixes
  with more than one defensible answer (what `display: flex` becomes, where an inline `style`
  moves) deliberately produce no mechanical edit.

### Changed (unreleased)

- Release automation: a manual `workflow_dispatch` (`.github/workflows/release.yml`, modelled on
  vscode-ssh-config-all-in-one) now bumps the version, tags, builds, tests, packages, creates the
  GitHub Release with the VSIX attached and publishes to the Marketplace in one run — input the
  version and a beta flag; needs a `VSCE_PAT` secret. CI gained a path filter (docs-only pushes
  no longer build) and a guard that the packaged VSIX still contains `dist/mcp-daemon.cjs`.

### Fixed (unreleased)

- MCP daemon hardening after code review: DNS-rebinding protection on the HTTP endpoint (Host
  allowlist, all browser origins rejected) so a web page can no longer reach the file-mutating
  tools; the health check now verifies the daemon's identity **and version**, replacing a stale
  daemon from a previous extension version instead of heartbeating it forever; an explicit
  `root` that is not a directory is rejected instead of silently producing an empty index that
  framed every class as unknown; `apply_fixes` with `ruleIds: []` applies nothing instead of
  everything; two fix edits inserting at the same offset no longer splice into malformed markup;
  content-directory scanning honours the layout/XML and styles/CSS suffix pairing;
  `panorama.mcp.port` is schema-constrained to a valid TCP port; the enable command creates the
  config's parent directory; prompt descriptions are localized; CI's path filter no longer skips
  localization-only changes.

## [1.0.0] — 2026-09-04

First public release.

### Added

- **Two languages** — `panorama-vxml` and `panorama-vcss`, recognised by path glob
  (`**/panorama/**/layout/**/*.xml`, `**/panorama/**/styles/**/*.css`) or unconditionally by the
  `.vxml` / `.vcss` extensions. TextMate grammars written for Panorama rather than adapted from
  web CSS.
- **Completion** — 245 panel types with inheritance-resolved attribute sets, VCSS properties and
  their value domains, Panorama-only functions, at-rules, pseudo-classes and `{s:}` bindings.
- **Hover documentation** for panel types, attributes and CSS properties, including the Web
  equivalent and why Panorama differs.
- **Cross-file intelligence** backed by a workspace index — `class=` completion drawn from every
  stylesheet, go-to-definition and find-references for class names, `@define` constants and
  `@keyframes`, and segment-by-segment `src="s2r://…"` path completion with existence checking.
- **Color decorators** for Panorama's 8-digit `#RRGGBBAA` notation.
- **28 diagnostic rules** in three tiers — provably wrong (`warning`), not in the known list
  (`hint`), and CustomHudLayout whitelist violations (`error`). Every rule carries a concrete
  replacement, not just a complaint. Seven configuration groups, each settable to
  `error` / `warning` / `hint` / `off`.
- **CustomHudLayout strict mode** for paths under `custom_game/` — narrows completion to the
  four allowed panel types and enforces the per-panel attribute whitelist. Completion and
  diagnostics always agree on the mode.
- **English and Simplified Chinese** for every user-facing message, selected automatically from
  VS Code's display language.

### Notes

- The panel and attribute data is generated from the schema Counter-Strike 2 itself emits via
  `panorama_generate_layout_xsd`. That schema is known to be incomplete — the corpus contains 554
  legitimate attribute uses outside the declared sets — which is why "not in the known list"
  diagnostics are capped at `hint` and never claim more than they can prove.
- Verified against 990 real Panorama files from the shipped game, with every rule's hit count
  pinned exactly so that both new false positives and silently weakened rules turn the gate red.

[Unreleased]: https://github.com/kxnrl/vsc-panorama-ext/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/kxnrl/vsc-panorama-ext/releases/tag/v1.0.0
