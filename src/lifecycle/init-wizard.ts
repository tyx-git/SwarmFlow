/**
 * swarmflow 的初始化向导。
 *
 * 简化版：联网搜索 → 主题 → 第三方中转（可选）→ 直接进入主界面。
 * 供应商和模型也可通过 /provider 和 /model 命令随时配置。
 * 支持 Ctrl+C / ESC 返回上一步。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import { select, input } from "@inquirer/prompts";
import { getSwarmflowHomeDir } from "../lib/home-path.js";
import { setDotenvKey } from "../lifecycle/dotenv.js";
import {
  type SwarmflowSettings,
  type ProviderEntry,
  saveSettings,
  globalSettingsPath,
  loadGlobalSettings,
} from "../config/persistence.js";
import { customProviderEnvVar } from "../providers/credential-flow.js";

// ------------------------------------------------------------------
// 向导结果
// ------------------------------------------------------------------

export interface WizardResult {
  homeDir: string;
}

// ------------------------------------------------------------------
// Esc 支持的提示层
// ------------------------------------------------------------------

const BACK = Symbol("wizard-back");
type Back = typeof BACK;

function isAbortPromptError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as any).name === "AbortPromptError";
}

function isUserCancel(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as any).name === "ExitPromptError" ||
    (err as any).code === "ERR_USE_AFTER_CLOSE";
}

async function withEscBack<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | Back> {
  const controller = new AbortController();
  const stdin = process.stdin;
  readline.emitKeypressEvents(stdin);
  const onKey = (_str: string | undefined, key: { name?: string } | undefined) => {
    if (key?.name === "escape") controller.abort();
  };
  stdin.on("keypress", onKey);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (isAbortPromptError(err) || isUserCancel(err)) return BACK;
    throw err;
  } finally {
    stdin.removeListener("keypress", onKey);
  }
}

const ansiBold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const ansiDim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const ESC_BACK_SELECT_THEME = {
  style: {
    keysHelpTip: (keys: [string, string][]) =>
      [...keys, ["Esc/Ctrl+C", "back"] as [string, string]]
        .map(([key, action]) => `${ansiBold(key)} ${ansiDim(action)}`)
        .join(ansiDim(" • ")),
  },
};

interface SelectStepChoice {
  name: string;
  value: string;
}

async function selectStep(opts: { message: string; choices: SelectStepChoice[] }): Promise<string | Back> {
  return withEscBack((signal) =>
    select({ message: opts.message, choices: opts.choices, theme: ESC_BACK_SELECT_THEME }, { signal }),
  );
}

async function inputStep(opts: { message: string; default?: string }): Promise<string | Back> {
  return withEscBack((signal) => input({ message: opts.message, default: opts.default }, { signal }));
}

async function confirmStep(opts: { message: string; default?: boolean }): Promise<boolean | Back> {
  return withEscBack((signal) => {
    const { confirm } = require("@inquirer/prompts");
    return confirm({ message: opts.message, default: opts.default }, { signal });
  });
}

// ------------------------------------------------------------------
// 联网搜索配置
// ------------------------------------------------------------------

const SEARCH_API_OPTIONS = [
  { env: "TAVILY_API_KEY", name: "Tavily", url: "https://tavily.com", free: "1000/month" },
  { env: "FIRECRAWL_API_KEY", name: "Firecrawl", url: "https://firecrawl.dev", free: "500/month" },
  { env: "EXA_API_KEY", name: "Exa", url: "https://exa.ai", free: "one-time credit" },
  { env: "BRAVE_SEARCH_API_KEY", name: "Brave Search", url: "https://brave.com/search/api/", free: "$5 credit" },
] as const;

async function stageWebSearch(): Promise<"next" | Back> {
  const configured = SEARCH_API_OPTIONS.find(({ env }) => process.env[env]?.trim());
  if (configured) {
    console.log(`  ✓ Web search: ${configured.name} (${configured.env} detected)\n`);
    return "next";
  }

  const choice = await selectStep({
    message: "Web search: Paste an API key for better results (strongly recommended)",
    choices: [
      ...SEARCH_API_OPTIONS.map((opt) => ({
        name: `${opt.name} — ${opt.free} free → ${opt.url}`,
        value: opt.env,
      })),
      { name: "Skip (use built-in free search — limited quality)", value: "skip" },
    ],
  });

  if (choice === BACK) return BACK;
  if (choice === "skip") {
    console.log("  Using built-in search (Exa → Parallel → DuckDuckGo).\n");
    return "next";
  }

  const selected = SEARCH_API_OPTIONS.find(({ env }) => env === choice)!;
  console.log(`\n  Sign up at ${selected.url} and copy your API key.\n`);

  const key = await inputStep({ message: `Paste your ${selected.env}` });
  if (key === BACK) return BACK;

  if (key.trim()) {
    setDotenvKey(selected.env, key.trim());
    console.log(`  ✓ Saved to ~/.swarmflow/.env\n`);
  } else {
    console.log("  Skipped. You can set it later in ~/.swarmflow/.env\n");
  }

  return "next";
}

// ------------------------------------------------------------------
// 主题选择
// ------------------------------------------------------------------

const THEME_OPTIONS = [
  { name: "Default (dark)", value: "default" },
  { name: "Dracula", value: "dracula" },
  { name: "Nord", value: "nord" },
  { name: "Light", value: "light" },
  { name: "Auto (follow system)", value: "auto" },
];

async function stageTheme(homeDir: string): Promise<"next" | Back> {
  const choice = await selectStep({
    message: "Select theme",
    choices: THEME_OPTIONS,
  });

  if (choice === BACK) return BACK;

  const settings = loadGlobalSettings(homeDir);
  saveSettings({ ...settings, theme_mode: choice as SwarmflowSettings["theme_mode"] }, globalSettingsPath(homeDir));
  console.log(`  ✓ Theme set to: ${choice}\n`);

  return "next";
}

// ------------------------------------------------------------------
// 第三方中转设置
// ------------------------------------------------------------------

const PROTOCOL_CHOICES = [
  { name: "OpenAI Chat Completions", value: "openai-chat" },
  { name: "OpenAI Responses API", value: "openai-responses" },
  { name: "Anthropic Messages", value: "anthropic" },
  { name: "Gemini generateContent", value: "gemini" },
];

async function stageCustomProvider(homeDir: string): Promise<"next" | Back> {
  const want = await selectStep({
    message: "Set up a third-party relay provider now?",
    choices: [
      { name: "Yes — configure a custom provider endpoint", value: "yes" },
      { name: "Skip — I'll configure later via /provider", value: "skip" },
    ],
  });
  if (want === BACK) return BACK;
  if (want === "skip") return "next";

  // 1. Display name
  const label = (await inputStep({ message: "Provider display name (e.g. My LLM)" })) as string;
  if (label === BACK) return BACK;
  if (!label.trim()) return "next";

  // 2. Endpoint URL
  const rawUrl = (await inputStep({ message: `${label.trim()} — endpoint URL (e.g. https://api.example.com/v1/chat/completions)` })) as string;
  if (rawUrl === BACK) return BACK;
  if (!rawUrl.trim()) return "next";

  // 3. Protocol
  const protocol = await selectStep({
    message: `${label.trim()} — API protocol`,
    choices: PROTOCOL_CHOICES,
  });
  if (protocol === BACK) return BACK;

  // 4. API key (optional)
  const apiKey = (await inputStep({ message: `${label.trim()} — API key (Enter to skip if none required)` })) as string;
  if (apiKey === BACK) return BACK;

  // 5. Model id
  const modelId = (await inputStep({ message: `${label.trim()} — model ID (e.g. gpt-4o)` })) as string;
  if (modelId === BACK) return BACK;
  if (!modelId.trim()) return "next";

  // 6. Context length
  const ctxLenStr = (await inputStep({ message: `${label.trim()} — context length (tokens, e.g. 128000)`, default: "128000" })) as string;
  if (ctxLenStr === BACK) return BACK;
  const ctxLen = parseInt(ctxLenStr, 10) || 128000;

  // Build provider entry
  const baseId = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
  const entry: ProviderEntry = {
    custom: true,
    label: label.trim(),
    base_url: rawUrl.trim(),
    protocol: protocol as ProviderEntry["protocol"],
    models: [{ id: modelId.trim(), context_length: ctxLen }],
  };

  let apiKeyRef = "local";
  if (apiKey.trim()) {
    const envVar = customProviderEnvVar(baseId);
    setDotenvKey(envVar, apiKey.trim(), homeDir);
    entry.api_key = `\${${envVar}}`;
    apiKeyRef = `\${${envVar}}`;
  }

  const settings = loadGlobalSettings(homeDir);
  const providers = { ...(settings.providers ?? {}), [baseId]: entry };
  saveSettings({ ...settings, providers }, globalSettingsPath(homeDir));

  console.log(`  ✓ Added provider "${label.trim()}" with model ${modelId.trim()}\n`);
  return "next";
}

// ------------------------------------------------------------------
// 主向导
// ------------------------------------------------------------------

export async function runInitWizard(): Promise<WizardResult> {
  const homeDir = getSwarmflowHomeDir();

  console.log();
  console.log("  ╔══════════════════════════════════════╗");
  console.log("  ║       Welcome to swarmflow Setup!        ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log("  (Esc or Ctrl+C: go back one step)\n");

  // Stage 1: 联网搜索
  {
    const result = await stageWebSearch();
    if (result === BACK) {
      console.log("  Skipping setup.\n");
      return { homeDir };
    }
  }

  // Stage 2: 主题选择
  {
    const result = await stageTheme(homeDir);
    if (result === BACK) {
      // 回退到 web search 不再循环
      console.log("  Using default theme.\n");
    }
  }

  // Stage 3: 第三方中转（可选）
  {
    const result = await stageCustomProvider(homeDir);
    if (result === BACK) {
      console.log("  Skipping provider setup.\n");
    }
  }

  // 确保目录存在
  mkdirSync(join(homeDir, "prompts", "templates"), { recursive: true });
  mkdirSync(join(homeDir, "skills"), { recursive: true });
  mkdirSync(join(process.cwd(), ".swarmflow"), { recursive: true });

  console.log("  ✓ Setup complete.\n");
  console.log("  Use /provider to add providers, /model to select a model.\n");

  return { homeDir };
}
