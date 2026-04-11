---
name: release-patterns
source: sandbox-cc:.claude/skills/release-patterns/SKILL.md
kind: reference-stub
---

# release-patterns (reference stub)

This skill is authored and maintained in **sandbox-cc** — the Claude Code harness config repo:

> `luutuankiet/sandbox-cc` → `.claude/skills/release-patterns/SKILL.md`

## Why this stub exists

The shim repo uses the pattern documented in that skill (narrative per-file release notes + OIDC tag→release→publish pipeline), so this stub is here to:

1. **Signal the pattern** — contributors reading `.claude/skills/` in the shim repo find the doc trail
2. **Prevent skill duplication** — bitrot from divergent copies is the #1 risk with shared skills across repos
3. **Point to canonical source** — agents (or humans) can grab the full text from sandbox-cc when authoring a new release

## Summary of the pattern (one-liner each)

| Concept | One-liner |
|---|---|
| **Pattern A (npm)** | Tag → build → release → publish via `actions/setup-node` (no `registry-url`) + `npx -y npm@latest publish --provenance` |
| **Pattern B (PyPI)** | Same shape, `pypa/gh-action-pypi-publish@release/v1` with Trusted Publisher |
| **Pattern C (narrative release notes)** 🌟 | Hand-written `releases/vX.Y.Z.md` in repo, published verbatim via `gh release create --notes-file` |
| **OIDC Trusted Publisher** | Zero stored secrets — trust configured once on npm/PyPI side, not in GitHub Actions |
| **Fail loudly on missing notes** | `publish.yml` verify-step exits if `releases/${{ github.ref_name }}.md` doesn't exist |

## What this repo uses

- **Pattern A (npm)** — see `.github/workflows/publish.yml`
- **Pattern C (narrative release notes)** — see `releases/README.md` and `releases/v1.5.0.md`

## When updating this stub

If the canonical skill gets a major version bump or a new pattern (D, E, ...), update the table above and the "What this repo uses" list. **Do not duplicate the full skill text here** — the whole point is to avoid drift.

## Full skill text

Fetch from sandbox-cc on any branch where the skill lives:

```bash
gh api repos/luutuankiet/sandbox-cc/contents/.claude/skills/release-patterns/SKILL.md \
  --jq -r '.content' | base64 -d
```

Or browse the file directly on GitHub: `luutuankiet/sandbox-cc/blob/main/.claude/skills/release-patterns/SKILL.md`