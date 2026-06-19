---
name: config-guide
description: Explains Fermi's configuration system, settings.json, local project settings, model tiers, and directory structure. Use when users ask about configuration, settings, how to set up providers, or project-local overrides.
---

# Fermi Configuration Guide

## Directory Structure

```
~/.fermi/                              # Global config
├── settings.json                      # User-editable settings (JSONC, supports comments)
├── .env                               # API keys (override mode: wins over shell env)
├── state/                             # System-managed (do not edit)
│   └── model-selection.json           #   Last /model selection
├── skills/                            # Global skills
├── hooks/                             # Global hooks
├── agent_templates/                   # Global agent templates
├── prompts/                           # Global prompts
├── projects/                          # Per-project session storage
│   └── <name>_<sha256[:6]>/           #   Per-project directory
│       ├── project.json               #     Project metadata
│       ├── .fermi/                     #     Project-store layer
│       │   ├── settings.json          #       Project-store settings
│       │   ├── skills/                #       Project-store skills
│       │   └── hooks/                 #       Project-store hooks
│       └── <session_uuid_v7>/         #     Session directory
│           ├── log.json               #       Conversation log
│           ├── meta.json              #       Session summary (fast listing)
│           ├── artifacts/             #       Session artifacts
│           └── archive/               #       Archived context windows
└── AGENTS.md                          # Global persistent memory

{PROJECT}/.fermi/                      # Workspace layer (user creates manually)
├── settings.json                      # Local overrides (can be committed to git)
├── skills/                            # Workspace skills
├── hooks/                             # Workspace hooks
├── agent_templates/                   # Workspace agent templates
└── .gitignore                         # Auto-generated
```

### Extension Layer Priority (highest first)

1. **Workspace** --- `{cwd}/.fermi/`
2. **Project-store** --- `~/.fermi/projects/<slug>/.fermi/`
3. **Global** --- `~/.fermi/`
4. **Bundled** --- shipped with Fermi binary

Skills, hooks, and templates are discovered from all layers in priority order.

## settings.json

The single user-editable config file. Supports `//` and `/* */` comments (JSONC).

```jsonc
{
  // ── Model ──
  // Declarative default model. Overrides state/model-selection.json on every
  // startup. Omit to let /model selections persist automatically.
  "default_model": "anthropic:claude-opus-4-6",
  "thinking_level": "high",                       // Default thinking level
  "context_budget_percent": 100,                   // Main-session context budget (1-100)

  // ── Sub-agent model tiers ──
  "model_tiers": {
    "high":   { "provider": "anthropic", "selection_key": "claude-opus-4-6", "model_id": "claude-opus-4-6", "thinking_level": "high" },
    "medium": { "provider": "kimi-cn",   "selection_key": "kimi-k2.5",      "model_id": "kimi-k2.5",      "thinking_level": "medium" },
    "low":    { "provider": "ollama",    "selection_key": "qwen3.5:9b",     "model_id": "qwen3.5:9b",     "thinking_level": "none" }
  },

  // ── Agent model pins (per-template, same shape as model_tiers entries) ──
  "agent_models": {
    "reviewer": { "provider": "anthropic", "selection_key": "claude-sonnet-4-6", "model_id": "claude-sonnet-4-6", "thinking_level": "high" }
  },

  // ── Provider registration ──
  "providers": {
    // Cloud provider: reference an env var holding the API key
    "anthropic": { "api_key_env": "ANTHROPIC_API_KEY" },
    "openai":    { "api_key_env": "OPENAI_API_KEY" },

    // Custom provider: arbitrary OpenAI/Anthropic-compatible endpoint
    "my-llm": {
      "custom": true,
      "label": "My LLM",
      "base_url": "https://api.example.com/v1",
      "protocol": "openai-chat",               // "openai-chat" (default) or "anthropic"
      "api_key": "${FERMI_CUSTOM_MY_LLM_KEY}", // env var ref; stored in ~/.fermi/.env
      "models": [
        {
          "id": "my-model-70b",
          "context_length": 131072,
          "max_output_tokens": 16384,           // optional
          "multimodal": true,                   // optional, default false
          "thinking_levels": ["off", "low", "medium", "high"],  // optional
          "web_search": false                   // optional, default false
        }
      ]
    },

    // Legacy single-model local provider
    "lmstudio": {
      "base_url": "http://localhost:1234/v1",
      "model": "qwen/qwen3.5-9b",
      "context_length": 131072,
      "api_key": "local"                        // optional, default "local"
    }
  },

  // ── Display ──
  "accent_color": "#4b4bf0",
  "theme_mode": "auto",                          // "auto" | "light" | "dark"
  "diff_display": "compact",                     // "compact" | "full"

  // ── Permissions ──
  "permission_mode": "reversible",                // "read_only" | "reversible" | "yolo"

  // ── Sub-agent inheritance ──
  "sub_agent_inherit_mcp": true,                  // Sub-agents inherit parent's MCP servers
  "sub_agent_inherit_hooks": true,                // Sub-agents inherit parent's hooks

  // ── Skills ──
  "disabled_skills": [],

  // ── MCP Servers ──
  "mcp_servers": {
    "my-server": {
      "transport": "stdio",                       // "stdio" (default) or "sse"
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": { "TOKEN": "${MY_TOKEN}" },          // env var refs resolved at startup
      "env_allowlist": ["HOME"],                  // passthrough from shell env
      "sensitive_tools": ["delete_all"]           // tools requiring explicit approval
    }
  },

  // ── Updates ──
  // true (default): patch/minor auto-download, major notify only
  // "notify": all versions notify only, never auto-download
  // false: disable update checks entirely
  "auto_update": true,

  // ── Summarize hints (two-tier context awareness) ──
  "summarize_hint": {
    "enabled": true,                              // master switch, default true
    "level1": 50,                                 // first hint trigger %, default 50
    "level2": 75                                  // second hint trigger %, default 75
  }
}
```

## API Keys

API keys are stored in `~/.fermi/.env` (created by `fermi init` or the `/model` credential flow). This file uses `KEY=VALUE` format and is loaded with **override semantics** --- values in `.env` always win over shell environment variables.

```bash
# ~/.fermi/.env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

In `settings.json`, provider entries reference env var names (not raw keys):

```jsonc
"providers": {
  "anthropic": { "api_key_env": "ANTHROPIC_API_KEY" }
}
```

The `api_key_env` value can also be a `${VAR}` reference, which is resolved at runtime.

### Provider credential types

| Type | How credentials work |
|------|---------------------|
| Standard (`anthropic`, `openai`, `openrouter`) | `api_key_env` references a shell/dotenv variable |
| OAuth (`openai-codex`, `copilot`) | Login via `fermi oauth` or `/codex` / `/copilot` commands; tokens stored internally |
| Managed (`kimi*`, `qwen*`, `glm*`, `deepseek`, `minimax*`, `xiaomi`) | Key stored in Fermi-managed env slot in `~/.fermi/.env`; external env vars auto-detected as import candidates during setup |
| Local (`ollama`, `omlx`, `lmstudio`) | No key needed (default "local"); optional `api_key` for authenticated endpoints |
| Custom | API key stored in `~/.fermi/.env` as `FERMI_CUSTOM_<ID>_KEY`; referenced via `${...}` in settings |

## Project-Local Settings

Create `{PROJECT}/.fermi/settings.json` to override global settings for a specific project. Only include the fields you want to override:

```jsonc
{
  "default_model": "anthropic:claude-opus-4-6",
  "model_tiers": {
    "low": { "provider": "kimi-cn", "selection_key": "kimi-k2.5", "model_id": "kimi-k2.5", "thinking_level": "medium" }
  }
}
```

### Override Rules

| Type | Behavior |
|------|----------|
| Scalars (`default_model`, `thinking_level`, `context_budget_percent`, `accent_color`, `theme_mode`, `permission_mode`, `sub_agent_inherit_mcp`, `sub_agent_inherit_hooks`) | Local replaces global |
| Objects (`model_tiers`, `mcp_servers`, `agent_models`, `summarize_hint`) | Per-key merge (local keys win) |
| Arrays (`disabled_skills`) | Local replaces global |
| `providers`, `diff_display`, `auto_update` | **Global only**, local value ignored |

There are two local layers: the **project-store** layer (`~/.fermi/projects/<slug>/.fermi/settings.json`, system-managed) and the **workspace** layer (`{cwd}/.fermi/settings.json`, user-authored). When both exist, workspace wins on conflict (same merge rules).

## Model Selection

Model identity is tracked as four fields: `provider`, `selection_key` (picker key), `model_id` (API model id), and `config_name` (`provider:selection_key`).

### Selection priority

1. `default_model` in settings.json (declarative pin; always wins on startup)
2. `state/model-selection.json` (last `/model` selection; auto-saved)
3. First model with a resolvable API key (fallback)

**Important**: `default_model` overrides the model-selection state on every startup. If you want `/model` switches to persist across restarts, omit `default_model` from settings.json. The init wizard deliberately does not write `default_model` for this reason.

## Model Tiers

Sub-agent model tiers let you assign different models to different capability levels (`high`, `medium`, `low`). Sub-agents declare which level they need; if a tier is not configured, they inherit the parent's model.

Each tier entry has four required fields:

```jsonc
{
  "provider": "anthropic",
  "selection_key": "claude-opus-4-6",
  "model_id": "claude-opus-4-6",
  "thinking_level": "high"        // required: a tier-eligible level (not "off" or "none")
}
```

The interactive tier picker filters out "off" and "none" from the thinking level choices --- sub-agent tiers are expected to have thinking enabled. For non-thinking models, `"thinking_level": "none"` is set automatically.

Configure via `/tier` (interactive) or edit `model_tiers` in settings.json directly.

## MCP Servers

MCP servers are configured via the `mcp_servers` field in `settings.json` (global and/or project-local, merged by name). This is the only active MCP configuration path.

Environment variable references (`${VAR}`) in the `env` block are resolved at startup.

After editing MCP config (or SKILL.md files, or AGENTS.md), call the `reload` tool to apply changes live without restarting the session. The reload tool re-reads settings from disk, diffs MCP server configs (adding new servers, removing deleted ones, reconnecting changed ones), refreshes skills, and rebuilds the system prompt.

## Slash Commands

| Command | Purpose |
|---------|---------|
| `/model` | Switch main model (interactive picker with provider grouping) |
| `/tier` | Configure sub-agent model tiers |
| `/theme` | Set theme mode (auto / light / dark) |
| `/diff` | Set write/edit diff display (compact / full) |
| `/permission` | Set permission mode (read_only / reversible / yolo) |
| `/autoupdate` | Toggle automatic update checks |
| `/summarize_hint` | Configure two-tier context summarize hints |
| `/skills` | Enable/disable installed skills (checkbox picker) |
| `/mcp` | Show MCP server status and tools |
| `/codex` | OpenAI ChatGPT OAuth login/logout/status |
| `/copilot` | GitHub Copilot OAuth login/logout/status |
| `/hooks` | Show registered hooks |
| `/review` | Code review (uncommitted, branch diff, commit, custom) |
| `/session` | Resume a previous session (alias: `/resume`) |
| `/new` | Start a new session |
| `/rename` | Rename current session |
| `/fork` | Fork the current session into a new branch |
| `/compact` | Manually compact the active context |
| `/summarize` | Manually summarize older context (range picker) |
| `/rewind` | Rewind to a previous turn (alias: `/undo`) |
| `/raw` | Toggle markdown raw/rendered mode (alias: `/md`) |
| `/agents` | Toggle agents panel |
| `/todos` | Toggle todo panel |
| `/shells` | View and stop background shells |
| `/copy` | Copy the agent's most recent text response |
| `/usage` | Show session token usage (alias: `/context`) |
| `/stat` | Show all-time token statistics |
| `/help` | Show commands and shortcuts |
| `/quit` | Exit the application (alias: `/exit`) |

## First-Time Setup

Run `fermi init` to:
1. Select your main model (hierarchical picker; credential setup is triggered inline when you pick a model from an unconfigured provider)
2. Choose a thinking level for the selected model
3. Optionally configure sub-agent model tiers (high / medium / low)
4. Optionally configure a web search API key (Serper, Tavily, Exa, or Brave Search)

The wizard saves to `~/.fermi/settings.json` and `~/.fermi/state/model-selection.json`. It also creates `~/.fermi/agent_templates/`, `~/.fermi/skills/`, and `~/.fermi/AGENTS.md` if they do not exist.

## CLI Override

The `-c` flag applies per-process settings overrides that are never persisted:

```bash
fermi -c context_budget_percent=50
```

Currently only `context_budget_percent` is supported as a `-c` override.
