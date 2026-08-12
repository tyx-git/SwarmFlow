---
name: config-guide
description: Explains SwarmFlow's configuration system, settings.json, local project settings, model tiers, and directory structure. Use when users ask about configuration, settings, how to set up providers, or project-local overrides.
---

#  Configuration Guide

## Directory Structure

```
~/.swarmflow/                              # Global config
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
│       ├── .swarmflow/                     #     Project-store layer
│       │   ├── settings.json          #       Project-store settings
│       │   ├── skills/                #       Project-store skills
│       │   └── hooks/                 #       Project-store hooks
│       └── <session_uuid_v7>/         #     Session directory
│           ├── log.json               #       Conversation log
│           ├── meta.json              #       Session summary (fast listing)
│           ├── artifacts/             #       Session artifacts
│           └── archive/               #       Archived context windows
└── AGENTS.md                          # Global persistent memory

{PROJECT}/.swarmflow/                      # Workspace layer (user creates manually)
├── settings.json                      # Local overrides (can be committed to git)
├── skills/                            # Workspace skills
├── hooks/                             # Workspace hooks
├── agent_templates/                   # Workspace agent templates
└── .gitignore                         # Auto-generated
```

### Extension Layer Priority (highest first)

1. **Workspace** --- `{cwd}/.swarmflow/`
2. **Project-store** --- `~/.swarmflow/projects/<slug>/.swarmflow/`
3. **Global** --- `~/.swarmflow/`
4. **Bundled** --- shipped with  binary

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
    // Custom provider: Anthropic Messages, OpenAI Chat Completions,
    // OpenAI Responses, or Gemini generateContent endpoint
    "my-llm": {
      "custom": true,
      "label": "My LLM",
      "base_url": "https://api.example.com/v1",
      "protocol": "openai-chat",               // "openai-chat" | "openai-responses" | "anthropic" | "gemini"
      "api_key": "${CUSTOM_MY_LLM_KEY}", // env var ref; stored in ~/.swarmflow/.env
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
  "theme_mode": "auto",                          // "auto" | "light" | "dark" | "default" | "dracula" | "brief"
  "diff_display": "compact",                     // "compact" | "full"
  "copy_on_select": true,                         // Automatically copy terminal selections
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
      // For SSE, use "transport": "sse" and provide "url" instead.
      // "url": "https://example.com/mcp",
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

API keys are stored in `~/.swarmflow/.env` (created or updated by `swarmflow init`, `/provider`, or `/key`). This file uses `KEY=VALUE` format and is loaded with **override semantics** --- values in `.env` always win over shell environment variables.

```bash
# ~/.swarmflow/.env
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
| OAuth (`openai-codex`, `copilot`) | Login via `swarmflow oauth` or `/codex` / `/copilot`; tokens are stored internally |
| Managed (`kimi*`, `qwen*`, `glm*`, `deepseek`, `minimax*`, `xiaomi`) | Key stored in a provider-managed env slot in `~/.swarmflow/.env`; external env vars can be imported during setup |
| Local (`ollama`, `omlx`, `lmstudio`) | No key needed (default "local"); optional `api_key` for authenticated endpoints |
| Custom | API key stored in `~/.swarmflow/.env` as `CUSTOM_<ID>_KEY`; referenced via `${...}` in settings |

## Project-Local Settings

Create `{PROJECT}/.swarmflow/settings.json` to override global settings for a specific project. Only include the fields you want to override:

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
| `providers`, `diff_display`, `copy_on_select`, `auto_update` | **Global only**, local value ignored |

There are two local layers: the **project-store** layer (`~/.swarmflow/projects/<slug>/.swarmflow/settings.json`, system-managed) and the **workspace** layer (`{cwd}/.swarmflow/settings.json`, user-authored). When both exist, workspace wins on conflict (same merge rules).

## Model Selection

Model identity is tracked as four fields: `provider`, `selection_key` (picker key), `model_id` (API model id), and `config_name` (`provider:selection_key`).

`/provider` registers providers and custom models, `/key` manages provider credentials, and `/model` selects one of the registered models. `/model` accepts a config name or `provider:model` target; inline `key=` and `api_key=` arguments are not supported.

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
Configure via `/tier` (interactive) or edit `model_tiers` in settings.json directly. `/tier clear` removes all tier assignments; an individual tier can also be cleared from its picker.

## MCP Servers

MCP servers are configured via the `mcp_servers` field in `settings.json` (global and/or project-local, merged by name). This is the only active MCP configuration path. Environment variable references (`${VAR}`) in the `env` block are resolved at startup.

Use `/mcp` to inspect server status and tools, reload configuration, reconnect a server, or enable/disable a configured server. Add or edit servers in `settings.json`, then use `/mcp` → `Reload config` (or call the `reload` tool) to apply changes without restarting the session.

## Slash Commands

The built-in commands below come from `buildDefaultRegistry()` in `src/commands/commands.ts`. User-invocable skills can add additional `/<skill-name>` commands at runtime.

### Session

| Command | Purpose |
|---------|---------|
| `/help` | Show categorized command help |
| `/usage` | Show provider usage |
| `/stat` | Show session statistics |
| `/new` | Start a new session |
| `/resume` | Resume a previous session |
| `/session` | Resume a previous session (alias) |
| `/rename` | Rename the current session |
| `/status` | Show the current session status summary |
| `/quit` | Exit the application |
| `/exit` | Exit the application (alias) |

### Context

| Command | Purpose |
|---------|---------|
| `/summarize` | Summarize selected context |
| `/summarize_hint` | Configure summarization hints |
| `/compact` | Compact the active context |
| `/clear` | Clear the screen and future model context |
| `/fork` | Fork the current session into a branch |
| `/shells` | Show tracked background shells |
| `/ask` | Ask an isolated side question |
| `/rewind` | Rewind conversation and file changes |

### Workflow

| Command | Purpose |
|---------|---------|
| `/init` | Explore the project and draft `AGENTS.md`/`.rules` |
| `/plan` | Enter planning discussion mode |
| `/goal` | Set or view the current session goal |
| `/fix` | Reproduce, fix, and verify a known bug |
| `/reviewer` | Review the project or a natural-language scope |
| `/diff` | Configure inline diff display (`compact` or `full`) |

### Provider and Model

| Command | Purpose |
|---------|---------|
| `/provider` | Manage providers, API keys, and registered models |
| `/key` | Manage provider API keys |
| `/model` | Select the current session model |
| `/effort` | Set current session and sub-agent effort (`low`, `medium`, `high`, `xhigh`, `max`) |
| `/tier` | Configure sub-agent model tiers |
| `/permission` | Set the current session permission mode |
| `/codex` | Manage OpenAI Codex login |
| `/copilot` | Manage GitHub Copilot login |

### Ecosystem and Project Configuration

| Command | Purpose |
|---------|---------|
| `/skills` | View and enable/disable skills globally |
| `/mcp` | View, enable/disable, and reconnect MCP servers |
| `/hooks` | View hook configuration and status |
| `/memory` | Inspect and correct current session context |
| `/rules` | View or update the project `.rules` file |
| `/autoupdate` | Configure automatic update checks |

### UI

| Command | Purpose |
|---------|---------|
| `/theme` | Set the global theme preference |
| `/autocopy` | Configure copy-on-select |

Common argument forms:

- `/diff compact|full`
- `/theme custom|auto|light|dark|default|dracula|brief`
- `/autoupdate on|off`
- `/autocopy on|off`
- `/permission read_only|reversible|yolo`
- `/summarize_hint on|off|<level1> <level2>` where `0 < level1 < level2 < 85`
- `/tier high|medium|low|clear`
- `/rules [rule description]`

## First-Time Setup

Run `swarmflow init` to:
1. Configure web search with Tavily, Firecrawl, Exa, or Brave Search, or keep the built-in fallback
2. Choose a theme (`default`, `dracula`, `brief`, `light`, or `auto`)
3. Optionally add one custom provider endpoint with an API protocol, optional key, model ID, and context length

The wizard writes provider/theme settings to `~/.swarmflow/settings.json` and credentials to `~/.swarmflow/.env`. It creates `~/.swarmflow/prompts/templates/`, `~/.swarmflow/skills/`, and the project `.swarmflow/` directory when needed. It does not select the main model or configure model tiers; use `/provider`, `/key`, `/model`, `/effort`, and `/tier` after initialization. The wizard is also started automatically on first launch when no provider or managed credential is configured.

## CLI Override
The `-c` flag applies per-process settings overrides that are never persisted:

```bash
swarmflow -c context_budget_percent=50
```

Currently only `context_budget_percent` is supported as a `-c` override.

