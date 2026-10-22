/**
 * swarmflow 的初始化向导。
 *
 * 步骤：语言选择 → 联网搜索 → 主题（Brief/Dark/Light）→ 第三方中转（可选）
 * → 进入主界面。供应商和模型也可通过 /provider 和 /model 命令随时配置。
 * 支持 Ctrl+C / ESC 返回上一步。
 *
 * 所有面向用户的文案都来自 `assets/ui-texts/init-wizard.json`（Chinese /
 * English 两份），本文件只保留流程逻辑，便于增删语言或改文案。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import { select, input } from "@inquirer/prompts";
import { getSwarmflowHomeDir } from "../config/home-dir.js";
import { setDotenvKey } from "../lifecycle/dotenv.js";
import {
  DEFAULT_UI_LANGUAGE,
  createUiText,
  type UiLanguage,
  type UiText,
} from "../ui/text.js";
import type { SwarmflowSettings, ProviderEntry } from "../config/settings/types.js";
import { saveSettings, globalSettingsPath, loadGlobalSettings } from "../config/settings/io.js";
import { customProviderEnvVar } from "../providers/credential-flow.js";
import { normalizeEndpointUrl } from "../commands/provider/endpoint.js";

// ------------------------------------------------------------------
// 向导结果
// ------------------------------------------------------------------

export interface WizardResult {
  homeDir: string;
  /** 用户在向导中选择的界面语言。 */
  language: UiLanguage;
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

interface WizardRuntime {
  /** 界面语言（决定文案表）。 */
  language: UiLanguage;
  /** 文案表。 */
  t: UiText;
}

async function selectStep(run: WizardRuntime, opts: { message: string; choices: SelectStepChoice[] }): Promise<string | Back> {
  return withEscBack((signal) =>
    select({ message: opts.message, choices: opts.choices, theme: ESC_BACK_SELECT_THEME }, { signal }),
  );
}

async function inputStep(run: WizardRuntime, opts: { message: string; default?: string }): Promise<string | Back> {
  return withEscBack((signal) => input({ message: opts.message, default: opts.default }, { signal }));
}

// ------------------------------------------------------------------
// Stage 0: 语言选择
// ------------------------------------------------------------------

async function stageLanguage(): Promise<UiLanguage | Back> {
  const promptText = createUiText(DEFAULT_UI_LANGUAGE);
  const choice = await selectStep(
    { language: DEFAULT_UI_LANGUAGE, t: promptText },
    {
      message: promptText.get(["Init", "language", "title"]),
      choices: [
        { name: promptText.get(["Init", "language", "chinese"]), value: "zh" },
        { name: promptText.get(["Init", "language", "english"]), value: "en" },
      ],
    },
  );
  if (choice === BACK) return BACK;
  const language: UiLanguage = choice === "en" ? "en" : "zh";
  return language;
}

// ------------------------------------------------------------------
// Stage 1: 联网搜索配置
// ------------------------------------------------------------------

const SEARCH_API_OPTIONS = [
  { env: "TAVILY_API_KEY", name: "Tavily", url: "https://tavily.com", free: "1000/month" },
  { env: "FIRECRAWL_API_KEY", name: "Firecrawl", url: "https://firecrawl.dev", free: "500/month" },
  { env: "EXA_API_KEY", name: "Exa", url: "https://exa.ai", free: "one-time credit" },
  { env: "BRAVE_SEARCH_API_KEY", name: "Brave Search", url: "https://brave.com/search/api/", free: "$5 credit" },
] as const;

async function stageWebSearch(homeDir: string, run: WizardRuntime): Promise<"next" | Back> {
  const { t } = run;
  const configured = SEARCH_API_OPTIONS.find(({ env }) => process.env[env]?.trim());
  if (configured) {
    console.log(t.get(["Init", "search", "detected"], { name: configured.name, env: configured.env }) + "\n");
    return "next";
  }

  const choice = await selectStep(run, {
    message: t.get(["Init", "search", "prompt"]),
    choices: [
      ...SEARCH_API_OPTIONS.map((opt) => ({
        name: `${opt.name} — ${opt.free} free → ${opt.url}`,
        value: opt.env,
      })),
      { name: t.get(["Init", "search", "skipChoice"]), value: "skip" },
    ],
  });

  if (choice === BACK) return BACK;
  if (choice === "skip") {
    console.log(t.get(["Init", "search", "skipDone"]));
    return "next";
  }

  const selected = SEARCH_API_OPTIONS.find(({ env }) => env === choice)!;
  console.log(t.get(["Init", "search", "signUp"], { url: selected.url }));

  const key = await inputStep(run, { message: t.get(["Init", "search", "pasteKey"], { env: selected.env }) });
  if (key === BACK) return BACK;

  if (key.trim()) {
    setDotenvKey(selected.env, key.trim(), homeDir);
    console.log(t.get(["Init", "search", "saved"]));
  } else {
    console.log(t.get(["Init", "search", "skipped"]));
  }

  return "next";
}

// ------------------------------------------------------------------
// Stage 2: 主题选择
// ------------------------------------------------------------------

function themeChoicesFor(t: UiText): SelectStepChoice[] {
  return [
    { name: t.get(["Init", "theme", "brief"]), value: "brief" },
    { name: t.get(["Init", "theme", "dark"]), value: "dark" },
    { name: t.get(["Init", "theme", "light"]), value: "light" },
  ];
}

async function stageTheme(homeDir: string, run: WizardRuntime): Promise<"next" | Back> {
  const { t } = run;
  const choice = await selectStep(run, {
    message: t.get(["Init", "theme", "prompt"]),
    choices: themeChoicesFor(t),
  });

  if (choice === BACK) return BACK;

  const settings = loadGlobalSettings(homeDir);
  saveSettings(
    { ...settings, theme_mode: choice as SwarmflowSettings["theme_mode"] },
    globalSettingsPath(homeDir),
  );
  console.log(t.get(["Init", "theme", "saved"], { mode: choice }));

  return "next";
}

// ------------------------------------------------------------------
// Stage 3: 第三方中转设置
// ------------------------------------------------------------------

function protocolChoicesFor(t: UiText): SelectStepChoice[] {
  return [
    { name: t.get(["Init", "provider", "protocolChoices", "openai-chat"]), value: "openai-chat" },
    { name: t.get(["Init", "provider", "protocolChoices", "openai-responses"]), value: "openai-responses" },
    { name: t.get(["Init", "provider", "protocolChoices", "anthropic"]), value: "anthropic" },
    { name: t.get(["Init", "provider", "protocolChoices", "gemini"]), value: "gemini" },
  ];
}

async function stageCustomProvider(homeDir: string, run: WizardRuntime): Promise<"next" | Back> {
  const { t } = run;
  const want = await selectStep(run, {
    message: t.get(["Init", "provider", "ask"]),
    choices: [
      { name: t.get(["Init", "provider", "yes"]), value: "yes" },
      { name: t.get(["Init", "provider", "later"]), value: "skip" },
    ],
  });
  if (want === BACK) return BACK;
  if (want === "skip") return "next";

  // 1. 显示名称
  const label = await inputStep(run, { message: t.get(["Init", "provider", "label"]) });
  if (label === BACK) return BACK;
  if (!label.trim()) return "next";
  const displayLabel = label.trim();

  // 2. 先选择协议，以便按所选 SDK 规范化完整端点或 base URL。
  const protocol = await selectStep(run, {
    message: t.get(["Init", "provider", "protocol"], { label: displayLabel }),
    choices: protocolChoicesFor(t),
  });
  if (protocol === BACK) return BACK;

  // 3. 输入地址；提示会明确说明所选协议及其可接受的 URL 形式。
  const rawUrl = await inputStep(run, {
    message: t.get(["Init", "provider", "endpointUrl"], {
      label: displayLabel,
      protocol: t.get(["Init", "provider", "protocolChoices", protocol]),
    }),
  });
  if (rawUrl === BACK) return BACK;
  if (!rawUrl.trim()) return "next";
  const baseUrl = normalizeEndpointUrl(rawUrl, protocol).baseUrl;

  // 4. API key（可选）
  const apiKey = await inputStep(run, { message: t.get(["Init", "provider", "apiKey"], { label: displayLabel }) });
  if (apiKey === BACK) return BACK;

  // 5. 模型 ID
  const modelId = await inputStep(run, { message: t.get(["Init", "provider", "modelId"], { label: displayLabel }) });
  if (modelId === BACK) return BACK;
  if (!modelId.trim()) return "next";

  // 6. 上下文长度
  const ctxLenStr = await inputStep(run, {
    message: t.get(["Init", "provider", "contextLength"], { label: displayLabel }),
    default: "128000",
  });
  if (ctxLenStr === BACK) return BACK;
  const ctxLen = parseInt(ctxLenStr, 10) || 128000;

  // 组装 provider 条目（id 由显示名称派生，显示时用原始大小写 label）
  const baseId = displayLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
  const entry: ProviderEntry = {
    custom: true,
    label: displayLabel,
    base_url: baseUrl,
    protocol: protocol as ProviderEntry["protocol"],
    models: [{ id: modelId.trim(), context_length: ctxLen }],
  };

  if (apiKey.trim()) {
    const envVar = customProviderEnvVar(baseId);
    setDotenvKey(envVar, apiKey.trim(), homeDir);
    entry.api_key = `\${${envVar}}`;
  }

  const settings = loadGlobalSettings(homeDir);
  const providers = { ...(settings.providers ?? {}), [baseId]: entry };
  saveSettings({ ...settings, providers }, globalSettingsPath(homeDir));

  console.log(t.get(["Init", "provider", "added"], { label: displayLabel, model: modelId.trim() }));
  return "next";
}

// ------------------------------------------------------------------
// 主向导
// ------------------------------------------------------------------

const BANNER_WIDTH = 40;

export async function runInitWizard(homeDir = getSwarmflowHomeDir()): Promise<WizardResult> {

  // Stage 0：语言选择（放在最前面，后续文案都由它决定）
  const pickedLanguage = await stageLanguage();
  if (pickedLanguage === BACK) {
    console.log("\n  Skipping setup.\n");
    return { homeDir, language: DEFAULT_UI_LANGUAGE };
  }
  const language = pickedLanguage;
  const t = createUiText(language);
  const run: WizardRuntime = { language, t };

  // 语言选择立即落盘，后续 UI 文案（含命令回显）据此选择 Chinese/English。
  {
    const settings = loadGlobalSettings(homeDir);
    saveSettings({ ...settings, ui_language: language }, globalSettingsPath(homeDir));
  }

  const title = ` ${t.get(["Init", "banner", "title"])} `;
  console.log();
  console.log(`  ╔${"═".repeat(BANNER_WIDTH)}╗`);
  console.log(`  ║${title.padEnd(BANNER_WIDTH)}║`);
  console.log(`  ╚${"═".repeat(BANNER_WIDTH)}╝`);
  console.log(`  ${t.get(["Init", "banner", "backHint"])}\n`);

  // Stage 1: 联网搜索
  {
    const result = await stageWebSearch(homeDir, run);
    if (result === BACK) {
      console.log(`\n${t.get(["Init", "wizard", "skipped"])}`);
      return { homeDir, language };
    }
  }

  // Stage 2: 主题选择
  {
    const result = await stageTheme(homeDir, run);
    if (result === BACK) {
      // 回退到 web search 不再循环
      console.log(t.get(["Init", "wizard", "themeFallback"]));
    }
  }

  // Stage 3: 第三方中转（可选）
  {
    const result = await stageCustomProvider(homeDir, run);
    if (result === BACK) {
      console.log(t.get(["Init", "wizard", "providerFallback"]));
    }
  }

  // 确保目录存在
  mkdirSync(join(homeDir, "prompts", "templates"), { recursive: true });
  mkdirSync(join(homeDir, "skills"), { recursive: true });
  mkdirSync(join(process.cwd(), ".swarmflow"), { recursive: true });

  console.log(t.get(["Init", "wizard", "complete"]));
  console.log(t.get(["Init", "wizard", "hintProviders"]));

  return { homeDir, language };
}
