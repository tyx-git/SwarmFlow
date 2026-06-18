export function compactModelLabel(configName: string | null | undefined, modelId?: string | null): string {
  const name = configName?.trim() ?? ''
  if (!name) return ''

  const model = modelId?.trim()
  if (model && name.length > 28) return model

  const runtimeOpenAi = name.match(/^runtime-openai-codex-(.+)$/)
  if (runtimeOpenAi) return normalizeRuntimeModel(runtimeOpenAi[1]!)

  return name
}

function normalizeRuntimeModel(value: string): string {
  const gpt = value.match(/^gpt-(\d+)-(\d+)(.*)$/)
  if (gpt) return `gpt-${gpt[1]}.${gpt[2]}${gpt[3] ?? ''}`
  return value
}

// Display names mirror src/model-presentation.ts BRAND_LABEL_OVERRIDES.
// Kept in sync manually — see decisions.md if the canonical list grows.
const PROVIDER_BRAND: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  copilot: 'Copilot',
  openrouter: 'OpenRouter',
  kimi: 'Kimi',
  'kimi-cn': 'Kimi',
  'kimi-code': 'Kimi',
  glm: 'GLM',
  'glm-intl': 'GLM',
  'glm-code': 'GLM Code',
  'glm-intl-code': 'GLM Code',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax',
  deepseek: 'DeepSeek',
  xiaomi: 'MiMo',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  omlx: 'oMLX',
}

export function providerBrandLabel(providerId: string): string {
  return PROVIDER_BRAND[providerId] ?? providerId
}

// Strip the `provider:` prefix from a config name for in-group display —
// when the picker already groups items under the provider header, the
// prefix is redundant.
export function stripProviderPrefix(configName: string, providerId: string): string {
  const prefix = `${providerId}:`
  return configName.startsWith(prefix) ? configName.slice(prefix.length) : configName
}
