# Skill Attributions

This file ships inside the Fermi binary (it lives in `skills/`, which the build
copies wholesale; the skill loader ignores non-directory entries so this file is
never loaded as a skill).

All SKILL.md instruction text in this directory is **original work written for
Fermi**. Workflow ideas were informed by surveying open coding agents and skill
hubs, but no third-party prompt/instruction text was copied.

Skills that invoke external open-source libraries or tools at runtime credit them
below. Inclusion here is attribution only; each dependency is the user's to
install (see the skill's "Requirements" section) and remains under its own
license.

## Runtime libraries referenced by script-bearing skills

These libraries are **not bundled**. The skill instructs the agent to use them
and the user installs them on demand (each skill has a "Requirements" section).
Listed here for transparency; each remains under its own license. Licenses
verified against PyPI metadata 2026-05-17.

| Skill | Library / tool | License | Bundled? | Purpose |
|-------|----------------|---------|----------|---------|
| docx | python-docx | MIT | no (user-installed) | read/create/edit Word |
| xlsx | openpyxl | MIT | no (user-installed) | read/create/edit Excel |
| xlsx | pandas | BSD-3-Clause | no (optional) | bulk tabular analysis |
| pptx | python-pptx | MIT | no (user-installed) | create/edit slides |
| csv-data | pandas | BSD-3-Clause | no (optional; stdlib csv default) | tabular transform/clean |

## Idea sources (surveyed, not copied)

Open coding agents and curated hubs were surveyed at the capability level only
(what skills users commonly need) — no text reused:
Claude Code, OpenAI Codex CLI, Sourcegraph Amp, Factory Droid, opencode, Crush,
Cline, Kilo Code, Gemini CLI, Cursor, Aider; and curated lists
awesome-claude-code, awesome-cursorrules, github/awesome-copilot, and the public
Agent Skills spec at agentskills.io.
