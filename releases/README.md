# Release Notes Index

Append-only narrative release notes for `@luutuankiet/mcp-proxy-shim`.

## Authoring

- **One file per release.** Name: `vX.Y.Z.md`. No overwrites.
- **Audience:** human first, then agents picking up context six months later.
- **Structure:** TL;DR → Why → Highlights table → Mermaid diagram (when there's a flow) → Before/After example → Config → Upgrade notes → Files changed.
- **Voice:** pitch, not changelog. If a line could be a commit subject, cut it.
- **Diagrams:** Mermaid only — GitHub renders it natively in release bodies.
- **Promotion boundary:** anything that lands in `releases/` is world-readable. Private reasoning belongs in `gsd-lite/` (gitignored).

## Publishing

The `publish.yml` workflow reads `releases/${{ github.ref_name }}.md` via `gh release create --notes-file` when a tag is pushed. If the file is missing, the workflow fails loudly — no `--generate-notes` fallback, because empty stubs defeat the point.

## Index

| Version | Date | Theme |
|---|---|---|
| [v1.6.4](./v1.6.4.md) | 2026-04-20 | Passthru uses `Protocol.request()` — skips strict tool-output-schema validation; unblocks decorated servers like fs-mcp v2.0.x |
| [v1.6.1](./v1.6.1.md) | 2026-04-14 | Shim-trim middleware: dedup + cruft-strip kill schema token bleed at discovery time |
| [v1.5.0](./v1.5.0.md) | 2026-04-11 | Overflow-to-file bypass for daemon REST mode |

*Earlier releases predate this pattern — see [GitHub Releases](https://github.com/luutuankiet/mcp-proxy-shim/releases) for auto-generated changelogs.*
