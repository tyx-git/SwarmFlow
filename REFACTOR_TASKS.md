# SwarmFlow 结构重构任务清单

范围：`src/**`、`tests/**`、`scripts/**`、`prompts/**`、`skills/**`。`gui/` 与 `external/` 不在改造对象内（但 `external/opentui` 的 import 路径必须同步更新）。

原则：只改结构，不改行为。允许的动作限于移动文件、拆分文件、合并明显重复的结构职责、调整 import 路径、迁移测试与类型、更新 barrel。

---

## 0. 重构前基线（已实测）

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（exit 0） |
| `npm test` | 127 个测试文件全绿，1182 通过 / 3 跳过，54.8s |
| `npm run typecheck:tui` | 未跑，B0 需补测 |
| Lint | **仓库无任何 lint 工具**：无 eslint/biome/prettier 配置，`package.json` 无 lint 脚本。验收项 1 的"Lint 通过"退化为"不新增 typecheck/tsc 报错" |
| 工作树 | 干净（`git status --porcelain` 空） |

规模：`src` 152 个文件 / 61,246 行；`tests` 123 个测试文件 + 5 个 `tests/swarm` + 1 个 helper / 27,912 行。

---

## 1. 重构地图

### 1.1 硬约束：会被"移动文件"悄悄破坏的路径假设

这些是本项目的不可触碰红线。任何批次若移动以下文件，必须先按本表处理。

| # | 位置 | 假设 | 破坏后果 |
| --- | --- | --- | --- |
| C1 | `src/config/config.ts:545` `getBundledAssetsDir()` = `join(dirname(moduleUrl), "..", "..")` | 该文件必须恰在 `src/<x>/` 深度 2 | bundled assets（prompts/skills/assets）定位失败，TUI 与模板全崩 |
| C2 | `src/cli.ts:806` `resolveOpenTuiEntry(modulePath = fileURLToPath(import.meta.url))`，只探测 `..` 与 `../..` | 入口必须在 `src/` 深度 1 | 打包后找不到 `external/opentui/main.js`，exe 启动失败 |
| C3 | `src/version.ts:8` `import pkg from "../package.json"` | 必须在 `src/` 深度 1 | 构建期解析失败 |
| C4 | `src/config/ui-colors.ts:1`、`src/lib/ui-text.ts:19`、`src/models/registry.ts:9` 用 `../../assets/...` 导入 JSON | 三者必须深度 2；`ui-text.ts` 若移入 `src/ui/`（仍深度 2）安全 | 构建期解析失败 |
| C5 | `src/tools/json-query.ts:150-158`、`src/tools/native-search.ts:29-38` 按 `dirname(import.meta.url)/../intools/<tool>/` 与 `dirname(execPath)/intools/` 查找二进制；`scripts/copy-node-assets.mjs:24-25` 与 `scripts/build-sea-exe.mjs:158` 硬编码 `src/tools/intools` | 这两个 resolver 必须留在 `src/tools/`，`src/tools/intools/` 目录名不能变 | jq/rg/fd 静默回退到 JS 实现或找不到，`tests/packaged-paths.test.ts:277-282` 失败 |
| C6 | `scripts/build-sea-exe.mjs:163` 把 `src`、`assets`、`prompts`、`skills` 整目录拷进 runtime（`external/opentui` 原也在列表内，2026-10-23 已移除：TUI 由 esbuild 打成 `runtime/external/opentui/main.js` + hash 资源，源码副本运行期无人读取，见 §6「收尾清理 2」） | 不得新增需要运行的顶层源码目录，除非同步改这里 | 打包缺文件 |
| C7 | `tests/ui/status-panel-tasks.test.ts:113` 读源文件文本断言 `Task #${task.id} created:`；该模板串现位于 `src/session/task-list.ts:197`（B10.4 从 `session.ts` 抽出时测试路径与断言目标已同步） | 模板字符串所在文件路径变了要改测试 | 测试红 |
| C8 | `tests/logging/diagnostics-logging.test.ts:40,43` 读 `src/config/settings/types.ts` 与 `src/cli.ts` 文本断言（原 `src/config/persistence.ts`，B2 拆分后改指 `settings/types.ts`） | 同上 | 测试红 |
| C9 | `tests/node-runtime.test.ts:14` spawn `src/cli.ts`；`package.json` 的 `test:node` 脚本硬编码该路径 | 移动 cli 入口要同步改 | `npm run test:node` 失败 |
| C10 | `src/commands/types.ts:25,147` 原为 `session: any`（**T-L-01 起为 `SessionLike`**，T-L-02 起住在中立的 `src/session/contract.ts`），运行时鸭子调用 41 个 Session 成员（含 `_resetTransientState` 等下划线成员；`grep` 出的 43 个名字里 `js`/`ts` 是 `session.js` 之类字符串误命中），多数带 `typeof === "function"` 守卫 | Session 公有/下划线成员名与语义不能变；`Session implements SessionLike` 后改名/删成员会在 `session.ts` 直接编译报错，新增未声明成员的调用点会在调用方文件报错 | ~~静默降级~~ 已升级为编译期保护；T-L-02 起保护面从命令层扩到 `models/` 与会话内部（接口 43 个成员 = 41 个命令层成员 + `currentModelName`/`currentModelConfigName` 两个 getter） |
| C11 | `tsconfig.json` `include: ["src/**/*.ts"]`、`exclude: [..., "tests", "**/*.test.ts"]`；`tsconfig.build.json` 继承之并 `noEmit:false`；`vitest.config.ts` `include: ["tests/**/*.test.ts"]` | 测试若移入 `src/`，`*.test.ts` 虽被 exclude，但 `tests/helpers/*.ts`（非 `.test.ts`）会被卷入构建图 | dist 里混入测试辅助 |
| C12 | `src/session.ts` 与 `src/session/` 目录同名共存 | 移动后若两边都留 `session` 模块会产生歧义 | 解析混乱 |

### 1.2 模块与领域映射（改造前基线）

| 领域 | 目录 | 行数 | 说明 |
| --- | --- | --- | --- |
| 会话运行时 | `src/session.ts` + `src/session/` + `src/session-*.ts` + `src/session-*.ts` | 约 11,900 | 分散在 3 处：根文件、子目录、根散文件 |
| 蜂群编排 | `src/swarm/` | 4,322 | 16 文件，最大 515 行 |
| Provider 适配 | `src/providers/` | 5,526 | 24 文件平铺，含 3 个协议家族基类 |
| 工具层 | `src/tools/` | 约 9,400 | `basic.ts` 单文件 4,471 |
| 上下文与日志 | `src/context/` | 3,917 | 7 文件 |
| 配置与持久化 | `src/config/` | 约 4,300 | `persistence.ts` 1,833 |
| Agent 执行 | `src/agents/` | 2,050 | `tool-loop.ts` 1,818 |
| 斜杠命令 | `src/commands/` | 3,484 | 单文件 |
| 权限 | `src/permissions/` | 2,624 | `classify.ts` 904 |
| 平台适配 | `src/platform/` | 约 1,300 | 已有 6 个子文件夹，形态良好 |
| 模型与凭据 | `src/models/` + `src/auth/` | 约 2,700 | Provider 注册表数据却在 `models/registry.ts` |
| 服务/RPC | `src/server/` | 1,674 | 4 文件 |
| `src/lib/` | 20 文件 | 5,365 | **泛化桶**，跨 8 个真实领域 |
| 其它 | lifecycle/security/skills/templates/ui/hooks/clients/browser/primitives/types | 约 3,300 | 规模合理 |

### 1.3 大文件清单与职责判断（改造前，≥400 行，36 个）

标记：`拆` = 职责混杂必须拆；`抽` = 职责基本单一但可抽出数据/类型；`留` = 不建议拆。

| 文件 | 行 | 判定 | 混杂的职责 |
| --- | --- | --- | --- |
| `src/session.ts` | 7105 | 拆 | 一个 Session 类含 19 个职责簇：轮次锁/中断、激活流、工具 drain、ask、compact、用量、inbox、日志簿记、恢复重置、任务清单、skills+MCP+reload、子代理通信工具、附件图片、路径解析、system prompt、模型设置、shell 外观、close、标题 |
| `src/tools/basic.ts` | 4471 | 拆 | 7 个工具 schema + 7 个工具实现 + 参数校验 + glob/grep 原生与 JS 双引擎 + bash 变更追踪 + 派发表 + 限额常量 |
| `src/commands/commands.ts` | 3484 | 拆 | 注册表机制 + 30+ 命令实现 + 各域选项构造器 + provider 配置向导 + reviewer/plan 脚手架落盘 |
| `src/config/persistence.ts` | 1833 | 拆 | SessionStore 类、settings 读写合并、日志序列化与校验修复、归档、存储修复、10 个导出类型 |
| `src/agents/tool-loop.ts` | 1818 | 拆 | 展示摘要构造、不完整 JSON 流式解析器、循环类型定义、主循环 |
| `src/session/child-session-manager.ts` | 1551 | 拆 | 1 个类 + 6 个导出类型 + 纯函数 helper |
| `src/auth/openai-oauth.ts` | 1067 | 拆 | OAuth 端点常量、token 落盘、PKCE、设备码流、JWT 解析 |
| `src/cli.ts` | 1055 | 拆 | argv 解析、全局会话浏览/删除、交互式选择器、恢复动画、TUI 启动、main |
| `src/context/log-projection.ts` | 1017 | 拆 | TUI 投影（19-580）与 API 消息投影（581-1017）两个互不相干的出口 |
| `src/providers/openai-responses.ts` | 982 | 拆 | 需核实：请求构造 / SSE 事件流 / 工具增量 / 用量 |
| `src/config/config.ts` | 907 | 拆 | 模型能力表、模型名格式化、字段校验器、资源路径解析、Config 类 |
| `src/permissions/classify.ts` | 904 | 拆 | 20+ 命令安全分级表（纯数据）+ 分类算法 |
| `src/session/rewind-engine.ts` | 878 | 抽 | RewindEngine 类 + journal 类型 + 路径工具 |
| `src/server/session-rpc.ts` | 835 | 拆 | payload 构造器、参数校验器、fork 目录、RPC 注册 |
| `src/providers/openai-chat.ts` | 827 | 拆 | 同 responses，需核实 |
| `src/context/log-entry.ts` | 818 | 拆 | 类型 + 30 个 `create*` 工厂 + LogIdAllocator + TuiDisplayKind 映射 |
| `src/tools/web-search.ts` | 809 | 拆 | 多引擎适配 + 解析 + 工具定义 |
| `src/providers/anthropic-base.ts` | 790 | 抽 | 单抽象类，可按请求体/SSE/工具分面 |
| `src/permissions/bash/parser.ts` | 748 | 留 | 单一 wasm parser |
| `src/lib/task-store.ts` | 748 | 拆 | 类型 + 规范化纯函数 + TaskStore 类 + 快照格式化 + resume hint |
| `src/lib/background-shell-manager.ts` | 700 | 抽 | 单类 + deps 类型 |
| `src/session/session-persistence.ts` | 688 | 拆 | 日志手术多函数集合，按"写入/解析/修复"分面 |
| `src/lib/file-attach.ts` | 684 | 拆 | 扫描、解析引用、分类、读取摘要、格式化 context block、常量表 |
| `src/templates/loader.ts` | 673 | 拆 | 模板 IO、tool pack/tier 表、prompt 组装、校验 |
| `src/models/picker-tree.ts` | 632 | 拆 | 模型选择树 + 凭据端点树两棵树 |
| `src/clients/mcp-client.ts` | 584 | 拆 | MCP 环境白名单/URL 校验/凭据权限（安全策略）+ 连接管理器类 |
| `src/swarm/coordinator.ts` | 515 | 留 | 单协调器 |
| `src/context/document-projection.ts` | 502 | 拆 | DOCX/MD/HTML 三类转换混在一个文件 |
| `src/tools/web-fetch.ts` | 462 | 留 | 单工具 |
| `src/lib/thinking-artifact.ts` | 460 | 拆 | 落盘 IO + 类型 + 读取 |
| `src/tools/symbol-search.ts` | 452 | 留 | 单工具 |
| `src/lib/network-retry.ts` | 417 | 拆 | 错误分类表 + 退避计算 + retry 包装 |
| `src/providers/base.ts` | 409 | 拆 | 纯类型（ImageBlock/ToolDef/Message/Usage…）与 BaseProvider 实现同居 |
| `src/providers/usage.ts` | 405 | 留 | 用量计算 |
| `src/providers/credential-flow.ts` | 402 | 拆 | 凭据读写 + 交互向导，TUI 依赖它 |
| `src/swarm/decomposer.ts` | 401 | 留 | 单分解器 |

### 1.4 命名问题清单（改造前快照；B1–T-L-03 已逐项处置）

| 问题 | 位置 | 处置 |
| --- | --- | --- |
| 文件名重复目录语义 | `src/config/config.ts`、`src/context/context-rendering.ts`、`src/hooks/hook-runtime.ts`、`src/session/session-log.ts`、`src/session/session-persistence.ts`、`src/session/session-prompts.ts`、`src/commands/commands.ts`、`src/swarm/gui-integration.ts` | 已处置：拆分/改名完成（B1–B10）；`gui-integration.ts` 已删除（B13） |
| Python 风格 barrel | `src/swarm/__init__.ts`（仅被 `src/index.ts:250,262` 引用） | 已改为 `src/swarm/index.ts`（B1） |
| 泛化桶 | `src/lib/`（20 文件 5,365 行，跨 shell/文件/网络/日志/任务/UI/推理 7 个领域） | 已按 B5 解散，仅留 3 个通用件 |
| 泛化名 | `src/tools/shared.ts`（真实内容是 SEARCH_BUDGET_MS + EXCLUDE_DIRS + truncate*）、`src/tools/basic.ts`（"basic" 不含信息） | 已拆为 `scan-exclusions`/`output-truncation`（B1）；`basic.ts` 已拆为 14 模块（B6） |
| 语义不明的近义对 | `src/providers/registry.ts` vs `registry-effective.ts`（后者仅 6 行透传 `EFFECTIVE_PROVIDER_SPECS = FACTORY_PROVIDER_SPECS`）；`defaults.ts` vs `presets.ts` | 已处置：确认无环后删除 `registry-effective.ts`（B13） |
| 跨目录职责错位 | Provider 注册表数据在 `src/models/registry.ts`；`src/lib/system-proxy.ts`（46 行）套在 `src/platform/system-proxy/` 外面 | 已归位（B5/B8.3） |
| 目录职责重叠 | `src/browser/`（本地 HTTP 设计助手服务器）vs `src/platform/browser/`（跨平台打开浏览器）；同名不同义 | 已改名 `src/browser-preview/`（B9.5） |
| 根目录散落文件 | `src/session.ts`、`src/session-resume.ts`、`src/session-tree-types.ts`、`src/session-capabilities.ts`、`src/ask.ts`、`src/version.ts`、`src/index.ts` | 已归位 `src/session/`（B10.1）；`version.ts`/`index.ts` 留根（C3/C1） |
| 类名与文件名不符职责 | `InitService`（`src/lifecycle/init-service.ts`）内又定义 `ProviderPresetInfo`/`ModelPickerNode`/`ModelSelection`，与 `src/models/*` 类型重复 | 已消解（Q5）：定义仅存 `src/lifecycle/types.ts` |

### 1.5 测试与类型存放问题

| 问题 | 证据 | 处置 |
| --- | --- | --- |
| 123 个测试文件平铺 `tests/` 根 | `tests/*.test.ts` | B11 按模块镜像子目录；`vitest.config.ts` 的 `tests/**/*.test.ts` 已递归，**无需改配置** |
| 测试名看不出被测对象 | `tool-improvements`、`phase2-tool-validation`、`phase5-atomic-write`、`p3-ask`、`p4-p6`、`p7-mcp-security`、`crossplatform-fixes`、`commands-chain` | B11 重命名（`p3/p4/p6/p7` 是历史阶段编号，非领域） |
| 测试读源文件文本当契约 | `status-panel-tasks.test.ts:113`、`diagnostics-logging.test.ts:40,43` | 随文件移动同步改路径（属结构改动） |
| 类型与实现混杂 | `providers/base.ts:1-409`、`lib/task-store.ts:22-193`、`session.ts:223-366`、`auth/openai-oauth.ts:60-84` | 各模块 `types.ts` |
| `tests/helpers/` 仅 1 文件 | `tests/helpers/session-harness.ts` | 保留目录，B11 更新引用 |
| `src/types/` 只有 2 个 `.d.ts` | `mammoth.d.ts`、`turndown-plugin-gfm.d.ts` | 形态可接受，不动 |

### 1.6 最终结构（实际落地，不含 `gui/`/`external/`）

```
src/                        301 个 .ts
  cli.ts                    428   # 深度1锁定（C2/C9）；入口守卫 + resolveOpenTuiEntry
  cli/session-picker.ts     655   # 启动期会话选择 UI
  index.ts                         # 公共 barrel：117 个导出符号与 HEAD 完全一致
  version.ts                       # 深度1锁定（C3）
  session.ts               4089   # Session 类（7105 → 4089，-42%）；`implements SessionLike`
  ask.ts                           # ask 协议与 UI 形状
  agents/agent.ts + tool-loop/{types,display,streaming-arguments,run}.ts
  attachments/              9 个文件（file-kinds/scanner/types/reference/reader/context-block/pipeline/image-compress/clipboard-image）
  auth/{openai/{endpoints,types,http,token-store,jwt,pkce-flow,device-code-flow,refresh},oauth-command,github-copilot-*}
  browser-preview/          2 个（原 src/browser/，消除与 platform/browser/ 的歧义）
  clients/mcp/{manager,security-policy,config}.ts
  commands/{types,registry,registration,settings-patch}.ts + {session,model,provider,workflow,ecosystem,ui}/
  config/                  19 个 + settings/（asset-paths 深度2锁定 C1/C4）
  context/                  6 个 + entry/ projection/ document/（token-estimate、context-tags…）
  hooks/                    5 个（dispatcher 等）
  lib/                      3 个（jsonc / line-window / filesystem-hash —— D2 保留的小 lib）
  lifecycle/                4 个   logging/ 3 个   network/ 1 个   patches/ 1 个   primitives/ 1 个
  models/                   5 个 + picker/{types,labels,model-tree,credential-tree}.ts
  permissions/              8 个 + bash/（command-catalog / git-subcommand-rules / classify）
  platform/                 3 个 + 6 个子目录（system-proxy/ 等）
  prompts/{templates,assembler}.ts        # ← templates/loader + lib/prompt-assembler
  providers/                28 个（base/types/response/tool-call/stop-reason + 适配器 + provider-specs）
  security/ 2 个   server/ 8 个   skills/ 1 个   swarm/ 15 个   tasks/ 6 个
  thinking/ 1 个   types/ 2 个   ui/ 5 个 + 1 子目录
  session/                  27 个 + children/ rewind/ background-shell/
                            # contract.ts = SessionLike 能力契约（T-L-02 起，供 commands/models/ui 共用）
                            # 12 簇：activation/ask-flow/attachments/compact-flow/inbox/mcp/
                            # model-settings/round-tracking/skills/task-list/tool-drain/turn-control
                            # + restore/resume/log/log-surgery/usage-accounting/turn-types/no-reply-stream
  tools/                    27 个 + web-search/ intools/（intools 为原生二进制，C5 锁定）
```

### 1.7 任务完成表

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| B0 | 基线与护栏（typecheck/test/build 基线、C 红线复核） | 完成 |
| B1 | 零风险改名与 barrel（`swarm/index.ts`、`tools/limits` 等） | 完成 |
| B2 | config 层拆分（`config.ts` 1866 → 18 文件） | 完成 |
| B3 | server / security / lifecycle / clients / hooks / platform | 完成 |
| B4 | context 层拆分（rendering/log-entry/document/entry/projection） | 完成 |
| B5 | `src/lib/` 归宿主模块（20 文件 → 3 个通用件） | 完成 |
| B6 | `tools/basic.ts` 4471 行 → 14 模块 | 完成 |
| B7 | `commands.ts` 3487 行 → 31 模块 | 完成 |
| B8 | providers/base + auth/openai-oauth 拆分；家族目录化按证据放弃 | 完成（部分决策） |
| B9 | tool-loop 四拆、prompts 合并、classify 三拆、web-search 三拆、browser-preview、picker 四拆、children 三拆、rewind 三拆、cli 二拆 | 完成 |
| B10 | `session.ts` 12 簇全部外移（05a–05o）：B10 收尾 4113，B13/T-L-01 后 4100，T-L-03 后 4092，收尾清理 3 后 4089 | 完成 |
| B11 | 121 个测试迁入 24 个镜像子目录 + 8 个历史命名清理 | 完成 |
| B12 | 全量校验 + SEA exe 构建与冒烟 + C1–C12 复核 | 完成（已合并 main） |
| B13 | 收尾清理：参数校验单一化、死文件/透传删除、ToolExecutor 单导出、注释腐化、p4-p6 拆分、文档同步 | 完成 |
| T-L-01 | `SessionLike` 收敛 `CommandContext.session: any`（并把 `ui/contracts.Session` 并为同一能力面） | 完成 |
| T-L-02 | `SessionLike` 移到中立模块 `src/session/contract.ts`，收编剩余 9 处 `session: any` | 完成 |
| T-L-03 | `SessionLike` 取舍复核：注释纠偏、`RewindTargetTurn` 归位、TUI 消费侧去 `any` | 完成 |
| 收尾清理 2 | 删 `isCurrentSelection` 冗余形参、`external/opentui` 移出拷贝清单（发布包 -7.94 MB 死重）、补 picker「当前模型」标记测试 | 完成 |
| 收尾清理 3 | 删 `session.ts` 两个死 const、6 个 provider 的 `network-retry` 注释名纠正 | 完成 |

## 2. 决策点（已确认，2026-10-21）

**D1 — `src/session.ts` 拆分深度：抽满 12 簇。**
风险已知并接受：C10 的 `session: any` 鸭子调用（41 个成员、多数带 `typeof` 守卫，失效为静默降级）typecheck 抓不到。执行时每个子步必须逐条 grep 核对这些调用点仍然存在且名称未变，且每子步跑全量测试。不可外移的部分（constructor、字段声明区、`new Session` 递归闭包、`_logSurgeryView` getter/setter 出借契约、`_withTurnLock` 单锁实例）保留在类壳内。**（该风险已由 T-L-01 消除：`CommandContext.session` 现为 `SessionLike`，成员改名/删除会在 `session.ts` 编译报错。）**

**D2 — `src/lib/`：归宿主模块 + 保留小 lib。** 见 B5 映射表。

**D3 — 测试：留 `tests/`，按模块镜像子目录。** 见 B11。

**D4 — 分支：`refactor/structure-cleanup`（ASCII 名，避免 Windows 下 git 路径转义问题）。全程不提交**：文件移动用 `git mv` 保留重命名可追踪，但一次 commit 都不做，由用户审阅后自行提交。**（2026-10-22 用户改为自行提交：`31e6424 代码库整理中` 已 fast-forward 合并进 `main`，B13 与 T-L-01 由用户提交；本约束的"零提交"部分已由该流程取代。）**

**D5 — 不留兼容 re-export。** `src/session.ts`、`src/config/config.ts`、`src/config/persistence.ts` 拆分后旧路径直接删除，所有引用改到具体新模块（符合单一权威源原则）。

---

## 3. 分批任务清单

统一约定：
- 每批执行序固定为 `建目录/移动 → 拆分 → 迁类型 → 迁测试 → 改引用 → 验证`。
- 统一验证命令：`npm run typecheck && npm test`；涉及 `external/opentui` 的路径改动追加 `npm run typecheck:tui`；涉及 C1–C6 的批次追加 `npm run build` 与 `node scripts/build-sea-exe.mjs` 冒烟（按你的"打包产物交付"要求，产物必须实测）。
- 统一移动方式：`git mv`（git 2.52 可用），新建文件用 Write，不复制粘贴整块逻辑改动。
- 统一回滚：原计划每批一个提交；实际按用户要求全程零提交，提交与合并由用户执行（见 §2 D4）。
- 表中"引用数"为跨目录口径，不含同目录 `./x.js`；执行时每批用 grep 全量复核。

### B0 基线与护栏（前置，不改代码）

| ID | 内容 | 验证 |
| --- | --- | --- |
| T-B0-01 | 建 `refactor/结构整理` 分支（D4-A） | `git rev-parse --abbrev-ref HEAD` |
| T-B0-02 | 补跑 `npm run typecheck:tui` 记录既有报错清单，作为"重构前已有问题"基线 | 输出存档 |
| T-B0-03 | 记录 `npm run test:node` 与 `npm run build` 基线结果 | 全绿基线 |
| T-B0-04 | 把本文 C1–C12 作为每批 check 清单，写入本文件顶部执行守则 | — |

### B1 零风险：barrel 改名与文档型死文件

#### T-B1-01 `src/swarm/__init__.ts` → `src/swarm/index.ts`
- 批次 B1｜当前：`src/swarm/__init__.ts`（104 行）
- 现状职责与问题：纯 re-export barrel，无实现；`__init__` 是 Python 惯例，TS/ESM 项目里属外来命名，且破坏 `tsc` 大小写/扩展名一致性直觉
- 目标模块：`src/swarm/`｜拆分后文件：`src/swarm/index.ts`（同内容，仅改名）
- 命名理由：ESM 目录 barrel 的社区约定名是 `index.ts`，目录已表领域
- 迁移测试：`tests/swarm/*.test.ts` 若引用需改（实测引用方仅 `src/index.ts:250,262`）
- 迁移类型：无｜引用更新：`src/index.ts` 2 处 from 路径
- 验证：`npm run typecheck && npm test`｜风险/回滚：极低；单文件改名，回滚 `git checkout`
- 状态：完成（见 §6 批次日志）

#### T-B1-02 `src/swarm/gui-integration.ts` 处置提案（B1 提案保留 → 2026-10-22 用户指示删除，见 §6 B13）
- 当前：60 行，**内容全是注释**，零引用（全仓 grep 无一处 import）
- 问题：领域层目录里放一个非代码文档文件，且描述的是 `gui/`（本次范围外）
- 处置：列入待确认清单 **Q1**，建议移 `docs/swarm-visualization.md`；不擅自删除
- 验证：不适用｜状态：完成（2026-10-22 已删除该文件，见 §6 B13）

#### T-B1-03 `src/tools/shared.ts` 按职责重命名
- 当前：`src/tools/shared.ts`（99 行）：`SEARCH_BUDGET_MS`、`EXCLUDE_DIRS`、`isHiddenName`、`isExcludedDirName`、`truncateMiddle`、`truncateLine`
- 问题：`shared` 是泛化命名，"单一真实来源"注释也说明它其实是一组有边界的常量与截断函数
- 目标：`src/tools/scan-exclusions.ts`（EXCLUDE_DIRS + isHiddenName + isExcludedDirName + SEARCH_BUDGET_MS）、`src/tools/output-truncation.ts`（truncateMiddle + truncateLine）
- 命名理由：文件名直接说明提供什么能力；目录已表 tools
- 迁移测试：`tests/tool-improvements.test.ts` 等（引用数实测 1，执行时复核）
- 迁移类型：本文件无导出类型｜引用更新：`src/tools/*`、`src/lib/file-attach.ts:77`（`SCAN_EXCLUDE_DIRS = EXCLUDE_DIRS`）
- 验证：`npm run typecheck && npm test`｜风险/回滚：低
- 状态：完成（见 §6 批次日志）

### B2 `src/config/` —— 最高引用密度的配置层

#### T-B2-01 `src/config/persistence.ts` 拆分（1833 行 → 4 文件）
- 当前：`src/config/persistence.ts`
- 现状职责与问题：5 个不相关职责同居 —— ① SessionStore 目录寻址与生命周期（`:57-146` helpers、`:147-524` 类）② 10 个导出类型（`:524-882`）③ 日志序列化/落盘/校验修复（`:839-1413`）④ 归档窗口（`:1326-1413`）⑤ 全局/本地 settings 读写合并（`:1542-1833`）⑥ `fixStorage`（`:1427-1542`）
- 目标与拆分后文件：
  - `src/config/session-store.ts` — `SessionStore` 类 + `projectSlug`/`randomSessionId`/`looksLikeSessionId`/`resolvePreferredBaseDir`/时间戳 helpers（`:44-524`）
  - `src/config/types.ts` — `SwarmflowSettings`/`ProviderEntry`/`CustomModelEntry`/`MCPServerSettingsEntry`/`GlobalTuiPreferences`/`LocalModelEntry`/`LocalProviderConfig`/`GlobalTokenStats`（`:524-810`）
  - `src/config/log-storage.ts` — `LogSessionMeta`/`createLogSessionMeta`/`saveSessionMeta`/`saveLog`/`loadLog`/`LoadLogResult`/`entryToSnake`/`entryFromSnake`/`normalizeChildSessionMeta`/`validateAndRepairLog`/`LogRepairResult`/`archiveWindow`/`loadArchive`/`loadArchiveFile`/`restoreArchiveToEntries`/`updateProjectLastActive`（`:810-1420`）
  - `src/config/storage-repair.ts` — `fixStorage`/`FixStorageResult`（`:1413-1542`）
  - `src/config/settings/io.ts` — `loadGlobalSettings`/`loadLocalSettings`/`mergeSettings`/`parseSettingsOverrides`/`saveSettings`（`:1542-1833`）
- 命名理由：目录表 config，文件名只表职责；`persistence` 过于笼统无法区分 settings 持久化与日志持久化
- 迁移测试：`tests/settings.test.ts`、`tests/log-persistence.test.ts`、`tests/session-storage-lifecycle.test.ts`、`tests/config-*.test.ts`、`tests/home-path.test.ts`、`tests/packaged-paths.test.ts:22`；**并同步 `tests/diagnostics-logging.test.ts:40` 的文本断言路径 → `src/config/types.ts`（C8）**
- 迁移类型：见上，全部集中在 `config/types.ts` 与 `log-storage.ts`
- 引用更新：实测 46 处（src 21 / opentui 4 / tests 21）；`src/index.ts` 的 `SessionStore` 导出路径改为 `./config/session-store.js`，**导出符号名不变**
- 验证：`npm run typecheck && npm run typecheck:tui && npm test`
- 风险/回滚：中高（引用面最大之一）。C8 文本契约测试必须同批改；`resolvePreferredBaseDir` 无 `import.meta.url`，深度变化安全。回滚：本批 revert
- 状态：完成（见 §6 批次日志）

#### T-B2-02 `src/config/config.ts` 拆分（907 行 → 4 文件，全部保持深度 2）
- 现状职责与问题：① 模型能力登记表与查询（`KNOWN_*` 5 张表 + 9 个 getter，`:114-263`）② 模型名格式化（`:199-228`）③ 配置字段校验器（`:264-377`）④ 资源路径四层解析（`:378-553`，**含 C1 红线**）⑤ `Config` 类（`:554-907`）⑥ 文件名与目录同名
- 拆分后文件：
  - `src/config/model-capabilities.ts` — `ModelConfig`/`ModelConfigEntry` + 5 张 `KNOWN_*` + `getContextLength`/`getMultimodalSupport`/`getExtendedCacheSupport`/`getWebSearchSupport`/`getModelMaxOutputTokens`/`getThinkingLevels`/`getSubAgentThinkingLevels`/`getHighestThinkingLevel`/`runtimeTransportProtocol`
  - `src/config/model-naming.ts` — `normalizeModelId`/`formatDisplayModelName`/`formatScopedModelName`
  - `src/config/asset-paths.ts` — `ResolvedPaths`/`resolveAssetPaths`/`isDir`/`getBundledAssetsDir`（**C1：必须留在 `src/config/` 深度 2；实现逐字照搬，`import.meta.url` 默认参不变；更新函数内文档注释里的"源码布局：<repo>/src/config/config.ts"字样**）
  - `src/config/loader.ts` — `Config` 类 + 字段校验器 + `parseEnvRef`/`hasResolvableApiKey`
- 迁移测试：`tests/config-normalize.test.ts`、`tests/config-validation.test.ts`、`tests/config-preferences.test.ts`、`tests/packaged-paths.test.ts:21`、`tests/thinking-artifact.test.ts`、`tests/api-key-management.test.ts`
- 引用更新：实测 51 处（src 29 / opentui 1 / tests 21）；`src/index.ts` 的 9 个导出改到新路径，符号名不变
- 验证：`npm run typecheck && npm run typecheck:tui && npm test` **并追加 `npm run build` 后校验 `dist/src/config/asset-paths.js` 的 `getBundledAssetsDir()` 返回仓库根**（C1 是唯一能让 TUI 起不来的改动）
- 风险/回滚：高。深度算错不报编译错，只在运行期找不到 prompts。回滚：本批 revert + 重建 dist
- 状态：完成（见 §6 批次日志）

#### T-B2-03 `src/lib/home-path.ts` → `src/config/home-dir.ts`
- 当前：13 行，只导出 `SWARMFLOW_HOME_DIR`；`lib` 泛化 + 文件名不表内容
- 目标：`src/config/home-dir.ts`（深度 2）｜命名理由：home 目录是配置根
- 迁移测试：`tests/home-path.test.ts` → 已由 B11 迁入 `tests/config/home-path.test.ts`（保留原名，未改成 `home-dir.test.ts`）
- 引用更新：实测 19 处（src 14 / opentui 4 / tests 1）—— 本次引用面最大的单文件移动
- 验证：typecheck + tui typecheck + test
- 风险/回滚：低逻辑高机械；C4 无涉（本文件不 import assets JSON）
- 状态：完成（见 §6 批次日志）

#### T-B2-04 核查 `src/config/settings.ts` / `theme.ts` / `thinking.ts` / `ui-colors.ts` 是否需拆
- `ui-colors.ts` 受 C4 锁定（`../../assets/ui-colors/color.json`），**只允许原地小改或不动**
- 动作：确认 `settings.ts` 与 T-B2-01 的 `settings/io.ts` 不重复（双源迹象 → 待确认清单 **Q2**）；`theme.ts`/`thinking.ts` 复核结论：不动
- 状态：完成（见 §6 批次日志）

### B3 `src/server/` `src/security/` `src/lifecycle/` `src/clients/` `src/hooks/` `src/platform/`

#### T-B3-01 `src/server/session-rpc.ts` 拆分（835 行 → 4 文件）
- 混杂职责：① 状态 payload 构造（`:52-250`）② `forkSessionDirectory`（`:251-331`）③ 通用参数守卫（`:331-386`）④ `registerSessionRpc` 主装配（`:386-835`）
- 目标：`src/server/session-payloads.ts`、`src/server/session-fork.ts`、`src/server/rpc-arg-guards.ts`、`src/server/session-rpc.ts`（仅剩注册与分发）
- 命名理由：目录表 server，避免 `session-rpc-helpers.ts` 之类泛化后缀
- 迁移测试：`tests/server-rpc.test.ts`（313 行，2 处引用）
- 引用更新：`src/server/server-mode.ts`、`tests/server-rpc.test.ts`
- 验证：typecheck + test｜风险：低（`PROTOCOL_VERSION`/`PROTOCOL_CAPABILITIES` 对外契约值不可动）
- 状态：完成（见 §6 批次日志）

#### T-B3-02 `src/clients/mcp-client.ts` 拆分（584 行）
- 混杂：安全策略层（`DEFAULT_MCP_ENV_ALLOWLIST:36`、`ensureCredentialFilePermissions:81`、`validateMcpSseUrl:115`、`buildMcpServerEnv:139`）与连接管理层（`MCPClientManager:199-572`）
- 目标：`src/clients/mcp/security-policy.ts`、`src/clients/mcp/manager.ts`、`src/clients/mcp/status-types.ts`，并把 `src/clients/mcp-config.ts` 并入 `src/clients/mcp/config.ts`
- 迁移测试：`tests/p7-mcp-security.test.ts`（引用这 3 个安全函数）
- 引用更新：实测 mcp-client 8 处 + mcp-config 1 处；`src/session.ts` 内引用需同步
- 状态：完成（见 §6 批次日志）

#### T-B3-03 `src/hooks/hook-runtime.ts` → `src/hooks/runtime.ts`
- 问题：目录已表 hooks，`hook-` 前缀冗余；但 `runtime.ts` 与既有 `runner.ts` 语义相邻易混
- 处置：先读两者确认边界（`runner.ts` = 子进程执行一条命令；`hook-runtime.ts` = 事件匹配与编排），若仍易混改用 `src/hooks/orchestrator.ts`
- 迁移测试：`tests/hook-context-tail.test.ts`｜引用：`src/hooks/index.ts:1`（barrel 已在，外部只 import `hooks/index.js`，实测 6 处）
- 状态：完成（命名为 `src/hooks/dispatcher.ts`，见 §6 B3）

#### T-B3-04 `src/lifecycle/init-service.ts` 类型归位（390 行）
- 问题：`:44-83` 定义 `ProviderPresetInfo`/`ModelPickerNode`/`ModelSelection`/`ConfigStatus`/`SearchApiOption`，与 `src/models/` 与 `src/providers/presets.ts` 同义类型重复
- 目标：`src/lifecycle/types.ts` 承接本模块私有类型；跨模块同义类型不擅自合并，登记 **Q5**
- 状态：完成（见 §6 批次日志）

#### T-B3-05 `src/platform/` 只补一处
- `src/lib/system-proxy.ts`（46 行，`applySystemProxyToEnv`）归入 `src/platform/system-proxy/apply-to-env.ts`，消除与 `platform/system-proxy/` 的桶外包装
- 引用更新：`src/cli.ts` 1 处 + `tests/system-proxy.test.ts`
- 状态：完成（见 §6 批次日志）

#### T-B3-06 `src/security/` 不动（2 文件，277+49 行，职责单一），仅复核
- 状态：完成（见 §6 批次日志）

### B4 `src/context/` —— 上下文视图、摘要与投影

#### T-B4-01 `src/context/log-projection.ts` 拆分（1017 行 → 2 文件）
- 问题：一个文件两条完全不同的出口 —— TUI 投影（`:19-580`）与 API 消息投影（`:581-1017`）
- 目标：`src/context/projection/tui.ts`（`projectToTuiEntries`/`projectQueuedInputs`/`TuiProjectionOptions`/`isProjectableTuiEntry`/`buildSubAgentRollup`/`buildToolElapsedMap`/`projectTuiWindow`/中断标记常量）、`src/context/projection/api.ts`（`projectToApiMessages`/`ApiProjectionOptions`/`InternalMessage`/`validateToolCallProtocol`/`resolveImageRefs`/`buildAssistantMessage`/`injectLabeledUserContext`/`mergeMessageContent`/`USER_MESSAGE_HEADER`）
- 命名理由：投影是一个领域，两个目标是不同消费方；`tui`/`api` 表达边界而非行数
- 迁移测试：`tests/log-projection.test.ts`（772 行，实测引用 12 处）
- 引用更新：`external/opentui` 2 处、`src/session.ts`、`src/agents/*`；`src/context/` 内引用
- 验证：typecheck + tui + test｜风险：中。`resolveImageRefs`（`:847`）被 API 投影使用但依赖 session 回调形状，照搬不改
- 状态：完成（见 §6 批次日志）

#### T-B4-02 `src/context/log-entry.ts` 拆分（818 行 → 3 文件）
- 混杂：类型（`:16-140`）、`LogIdAllocator` 类（`:197-240`）、30 个 `create*` 工厂（`:240-818`）、`AGENT_RESULT_TUI_PREVIEW_LINES` + `TYPE_PREFIX_MAP`（`:140-197`）
- 目标：`src/context/entry/types.ts`、`src/context/entry/factories.ts`、`src/context/entry/id-allocator.ts`
- 迁移测试：`tests/log-entry.test.ts`（447 行，18 处引用）
- 引用更新：实测 34 处（src 15 / opentui 1 / tests 18），本批机械改动最宽的一处，需脚本化批量替换 + 全量 grep 复核
- 状态：完成（见 §6 批次日志）

#### T-B4-03 `src/context/context-rendering.ts` 拆分并改名（302 行 → 3 文件）
- 问题：文件名重复目录语义且实际含 3 件事 —— compact marker 常量与守卫（`:17-34`）、context id 与标签注入/剥离/`ContextTagStripBuffer`（`:36-193`）、连续同角色合并（`:195-302`）
- 目标：`src/context/compact-marker.ts`、`src/context/context-tags.ts`、`src/context/message-merging.ts`
- 迁移测试：`tests/context-rendering.test.ts`、`tests/prompt-context-snapshot.test.ts`
- 引用更新：实测 6 处；`src/index.ts` 的 5 个导出（`COMPACT_MARKER_ROLE`/`CONTEXT_ID_KEY`/`isCompactMarker`/`injectContextIdTag`/`mergeConsecutiveSameRole`）路径更新、符号不变
- 状态：完成（见 §6 批次日志）

#### T-B4-04 `src/context/document-projection.ts` 拆分（502 行）
- 动作：按转换源分面 `document/docx.ts`、`document/markdown.ts`、`document/html-text.ts` + 共用 `document/types.ts`；执行前先读全文确认边界（本次未逐行读，判定依据是文件名与行数）
- 迁移测试：`tests/document-projection.test.ts`
- 状态：完成（见 §6 批次日志）

#### T-B4-05 `active-context.ts` / `ephemeral-log.ts` / `token-estimate.ts` 复核（实测 290 / 290 / 46 行，结论：均不动）
- 状态：完成（见 §6 批次日志）

### B5 `src/lib/` 解散（依 D2 选项 A 执行完毕）

映射表（选项 A）：

| 当前 | 行数 | 目标 | 引用数 | 备注 |
| --- | --- | --- | --- | --- |
| `lib/task-store.ts` | 748 | `src/tasks/store/{types,normalize,store,snapshot}.ts` | 8 | 拆：类型 `:22-114`、normalize `:127-193`、`TaskStore:193-660`、格式化+hint `:660-748` |
| `lib/task-reconcile.ts` | 169 | `src/tasks/reconcile.ts` | 4 | 与 store 同域 |
| `lib/background-shell-manager.ts` | 700 | `src/shell/background/{types,manager}.ts` | 2 | 单类，只分离类型 |
| `lib/tool-runtime.ts` | 396 | `src/tools/runtime.ts` | 4 | |
| `lib/thinking-artifact.ts` | 460 | `src/reasoning/{types,artifact}.ts` | 12 | |
| `lib/network-retry.ts` | 417 | `src/network/retry/{classification,backoff}.ts` | 8 | 拆：错误分类表 vs 退避与包装；`MAX_NETWORK_RETRIES` 是 barrel 契约值不变 |
| `lib/logger.ts` | 257 | `src/logging/logger.ts` | 4 | `:114` 用 `process.execPath`，深度无关 |
| `lib/log-rotation.ts` | 21 | `src/logging/rotation.ts` | 2 | 与 logger 同域 |
| `lib/progress.ts` | 333 | `src/observability/progress.ts` | 5 | barrel 导出 5 个符号，名称不变 |
| `lib/ui-text.ts` | 164 | `src/ui/text.ts` | 14 | **C4：目标仍是深度 2，`../../assets/` 保持不变** |
| `lib/home-path.ts` | 13 | `src/config/home-dir.ts` | 19 | 见 T-B2-03 |
| `lib/system-proxy.ts` | 46 | `src/platform/system-proxy/apply-to-env.ts` | 2 | 见 T-B3-05 |
| `lib/file-attach.ts` | 684 | `src/attachments/{scan,resolve,summarize,format}.ts` | 5 | 拆：`scanCandidates:91`、`parseReferences:277`+`resolvePath:294`+`classifyFile:304`、`readAndSummarize:317-478`、`formatContextBlock:478+` |
| `lib/image-compress.ts` | 151 | `src/attachments/image-compress.ts` | 1 | 与附件同域 |
| `lib/clipboard-image.ts` | 25 | `src/attachments/clipboard-image.ts` | 1 | 同上 |
| `lib/diff-hunk.ts` | 289 | `src/patches/hunk.ts`（或 `filesystem/diff-hunk.ts`） | 5 | opentui 3 处引用 |
| `lib/prompt-assembler.ts` | 287 | `src/prompts/assembler.ts` | 4 | 与 `templates/loader.ts` 合成 prompts 域 |
| `lib/line-window.ts` | 136 | `src/filesystem/line-window.ts` | 2 | |
| `lib/jsonc.ts` | 37 | `src/filesystem/jsonc.ts` | 1 | |
| `lib/filesystem-hash.ts` | 32 | `src/filesystem/hash.ts` | 2 | |

- 迁移测试：`tests/{task-store,task-tools,task-reconcile,background-shell,network-retry,network-retry-upstream,thinking-artifact,ui-texts-and-theme,home-path,system-proxy,line-window,file-attach→session-file-attach,diff 相关,read-file-*}.test.ts`
- 验证：`npm run typecheck && npm run typecheck:tui && npm test`
- 风险/回滚：机械面极大但逻辑零改动。`lib/` 一旦清空，任何遗漏引用立刻编译失败，可被 typecheck 兜住。分批提交（按目标目录 6-7 个子提交）
- 状态：完成（见 §6 批次日志）

### B6 `src/tools/` —— 工具层

#### T-B6-01 `src/tools/basic.ts` 拆分（4471 行 → 约 12 文件）
- 现状职责与问题：7 类职责同居（schema、实现、参数校验、双引擎 glob/grep、变更追踪、派发、限额常量）
- 拆分后文件（`src/tools/` 下）：

| 新文件 | 内容（行号区间） | 职责 |
| --- | --- | --- |
| `limits.ts` | `:425-472` | 所有 `*_MAX_*` / `BASH_*` / `SEARCH_*` 限额常量 |
| `mutations.ts` | `:68-424` | `FileMutation`/`BashMutation` 类型 + `parseTrackableBashMutation`/`prepareBashPreExec`/`recordBashPostExec`/`splitCompoundBash`/`computeSha256`/`countDiffLines` |
| `arg-validation.ts` | `:2552-2718` | `ToolArgValidationError` + `expectArgsObject`/`required*Arg`/`optional*Arg`（B13 已与 `arg-helpers.ts` 合并为单一实现） |
| `path-scoping.ts` | `:2719-2787` | `READ_ACCESS_KINDS` + `scopedPath` + `toolRoot` |
| `definitions.ts` | `:474-1096` | 11 个 `ToolDef`（READ/LIST/EDIT/WRITE/BASH/TIME/GLOB/GREP/BACKGROUND/KILL_SHELL）+ `BASIC_TOOLS`/`BASIC_TOOLS_MAP` + `buildBashToolDef`/`shellAwareDescription` |
| `file-read.ts` | `:1096-1321` | `toolReadFile` |
| `file-list.ts` | `:1327-1448` | `toolListDir`/`formatFileSize`/`ListDirOptions` |
| `file-edit.ts` | `:1448-1936` | 版本快照 + 冲突错误 + `toolEditFileAppend`/`toolEditFileMulti` + EOL 检测与偏移定位 |
| `file-write.ts` | `:1868-2005` | `toolWriteFile`/`atomicWriteTextFile` |
| `bash.ts` | `:1993-2523` | `buildBashEnv`/`spillOutputToFile`/`toolBash`/`AdoptShell*` 类型/`buildUnifiedDiffPreview`/`simpleUnifiedDiff`/`toolTime` |
| `glob.ts` | `:2787-3149` | `globToRegex`/`normalizeGlobPattern`/`GlobOptions`/`bundledFdArgs`/`normalizeNativeFdOutput`/`toolGlob` |
| `grep.ts` | `:3149-3948` | `GrepOptions`/`bundledRgArgs`/`parseNativeGrepJson`/`buildJsGrepOutputFiles`/`formatGrep*`/`toolGrep` |
| `dispatch.ts` | `:2534-2552`, `:3948-4471` | `ExecuteToolContext`/`formatToolError`/`createDispatch`/`executeTool` |
- 命名理由：目录表 tools，文件名即工具或能力
- 迁移测试：`tests/{tool-improvements,phase2-tool-validation,phase5-atomic-write,read-file-window,read-file-tail,read-file-fuse,edit-write-size-limit,native-tool-parity,native-search-gating,jq-tool,grep*,line-window,tool-loop-per-call,arg-repair}.test.ts`（实测 basic.js 引用 27 处 / 26 文件）
- 迁移类型：`FileMutation`/`BashMutation*`/`TrackableBashParsed`/`GlobOptions`/`GrepOptions`/`ExecuteToolContext`/`AdoptShellRequest`/`AdoptShellFn`/`FileVersionSnapshot`/`ListDirOptions`/`Grep*` 内部类型
- 引用更新：`src/index.ts:186`、`src/agents/tool-loop.ts`、`src/session.ts`、`src/commands/commands.ts`、tests 全部；`BASIC_TOOLS`/`BASIC_TOOLS_MAP`/`executeTool` **导出符号与语义不变**
- **硬约束**：`json-query.ts`、`native-search.ts`、`intools/` 三者不得离开 `src/tools/`（C5）
- 验证：typecheck + test；追加 `npm run build` 校验 `dist/src/tools/intools` 就位 + `tests/packaged-paths.test.ts` 全绿（C5 只在运行期暴露）
- 风险/回滚：高（单批最大改动，建议内部再按"常量→类型→单工具→派发"分 4 个子提交）。`FileMutation` 等 mutation 追踪与 session 侧 `rewind` 有数据契约（`src/session/rewind-engine.ts`），跨文件搬迁时须逐字保持字段
- 状态：完成（见 §6 批次日志）

#### T-B6-02 `src/tools/web-search.ts` 拆分（809 行）
- 动作：按搜索引擎适配器分面 `web-search/{brave,tavily,serper,duckduckgo}.ts` + 共用 `web-search/{types,results}.ts`；执行前读全文确认实际引擎清单
- 迁移测试：`tests/web-search.test.ts`
- 状态：完成（见 §6 批次日志）

#### T-B6-03 `src/tools/comm.ts` / `tasks.ts` / `symbol-search.ts` / `web-fetch.ts` / `arg-repair.ts` / `shell-notes.ts` / `gitignore.ts` 复核
- 均 ≤452 行；`executor-types.ts` 是刻意为避免 `basic.ts` ↔ `tool-loop.ts` 循环依赖而存在的类型文件（其头注释 `:3-6` 明说），**保留并作为 B9 拆分的环解除手段**
- 状态：完成（见 §6 批次日志）

### B7 `src/commands/` —— 斜杠命令

#### T-B7-01 机制与实现分离
- 目标：`src/commands/types.ts`（`CommandContext`/`SlashCommand`/`CommandOption`/`CommandOptionsContext`/`ShowMessageFn`/`SemanticColor`/`CommandCategory`，`:67-259`）、`src/commands/registry.ts`（`CommandRegistry` + `registerBuiltin` + `getLocalizedCommandDescription` + `builtinDescription`，`:232-313`）
- 注意：`CommandContext.session: any`（`:76`）是 C10 的根源，本次**不改类型**（改类型可能暴露出既有隐藏错误，属功能改动范畴），登记 **Q6**。（Q6 后来由独立立项 T-L-01 处理，见 §7；当时的"可能暴露隐藏错误"确实发生 —— 暴露出 TUI 契约的 3 处类型缺陷。）
- 状态：完成（实际落点：`src/commands/types.ts` 180 行、`src/commands/registry.ts` 86 行；`CommandContext.session` 现位于 `src/commands/types.ts:25`、`CommandOptionsContext.session` 在 `:147`，T-L-01 起两者类型为 `SessionLike`；`CommandRegistry.register` 的 Map.set 覆盖语义位于 `src/commands/registry.ts:49`）

#### T-B7-02 命令按域拆分（实测 122 个顶层声明 → 31 个文件）
- 实际落点（比原计划多切出 `workflow/` 一域，因 `/init /plan /goal /fix /ask /reviewer /diff` 与 provider/model 无共享状态，混在 ecosystem 里会形成 700 行的第二杂桶）：
  - `src/commands/session/`：`help.ts`（/help /usage /status /clear /memory）、`lifecycle.ts`（/new /compact /ps /rename /fork /reload）、`rewind.ts`（/rewind + `rewindOptions`）
  - `src/commands/model/`：`persistence.ts`（模型/思考深度写回 + `promptThinkingLevel`）、`picker-options.ts`（选项树）、`selection-flow.ts`（就绪检查→选择器→解析）、`switch.ts`（/model + `parseModelArgs`）、`subagents.ts`（/agents + 角色选项）
  - `src/commands/provider/`：`protocol.ts`（线协议↔存储协议映射）、`presentation.ts`（取词与切换回声）、`options.ts`（/provider 选项）、`credentials.ts`（/key）、`endpoint.ts`（`normalizeEndpointUrl`/`testEndpoint`/`registerCustomModel`）、`custom.ts`（增删改自定义提供商）、`switch.ts`（/provider 分流）、`discovery.ts`（本地模型发现）、`oauth.ts`（codex/copilot）
  - `src/commands/workflow/`：`goal.ts`（/init /plan /goal /fix /ask）、`review.ts`（/reviewer + git 目标构建）、`session-files.ts`（plan/reviewer 脚手架落盘）、`diff.ts`（/diff）
  - `src/commands/ecosystem/`：`mcp.ts`、`skills.ts`（含 `registerSkillCommands`/`reRegisterSkillCommands`）、`hooks.ts`
  - `src/commands/ui/`：`theme.ts`、`language.ts`、`permission.ts`
  - `src/commands/registration.ts`：`buildDefaultRegistry`；`src/commands/settings-patch.ts`：`persistSettingsPatch`（10 个跨域调用点共用的"写回并吞异常"原语）
- 命名理由：`commands` 已是领域，域内文件名只表职责；未使用 `misc-commands.ts` 之类的杂桶
- 迁移测试：`tests/commands-{model,mcp,fork,diff,rewind-picker,shells,chain,permission}.test.ts`、`tests/skills-workflows.test.ts`、`tests/packaged-paths.test.ts`、`tests/custom-provider-endpoint.test.ts`、`tests/normalize-endpoint-url.test.ts`、`tests/language-command.test.ts`、`tests/deferred-command.test.ts`、`tests/prompt-context-snapshot.test.ts`（只改 import 路径，断言未动）
- 引用更新：实测 23 个文件；`src/index.ts` 的 5 个符号名称与形状不变、来源改为 `registry.js`/`types.js`/`registration.js`/`ecosystem/skills.js`；`external/opentui` 3 处；`README.md:110` 的"命令全集见 `src/commands/commands.ts`"改指 `src/commands/`
- **执行前置校验**：已做。临时红测 `tests/tmp-b7-order.test.ts` 先证明"同名二次注册会被记录"（检测器有效），再证明 `buildDefaultRegistry` 的 29 次注册**无重名**（`register` 为 Map.set，有覆盖语义，故重名=顺序敏感）；确认后已删除该临时测试。等价性另用 `.tmp/dump-commands.mts` 前后快照比对：29 个命令的 name/category/executionMode/picker/options 源码文本/handler 源码文本**逐字段一致**，注册顺序一致
- 正文一致性：`.tmp/verify-body.mjs` 对 HEAD 版单体做代码行多重集比对，2768 行完全一致，唯一差异是 73 行补 `export`
- 循环检查：`.tmp/find-cycles.mjs dist/src` → 258 个模块、**0 个运行时循环**（`types.ts ↔ registry.ts` 为纯类型双向引用，产物中已擦除，`dist/src/commands/types.js` 无任何 import）
- 状态：完成


### B8 `src/providers/` —— 供应商适配

#### T-B8-01 `src/providers/base.ts` 类型与实现分离（409 行）
- 目标：`src/providers/types.ts`（`ImageBlock`/`ToolCall`/`Citation`/`ToolDef`/`Message`/`MessageRole`/`SendMessageOptions`/`ToolTuiPolicy`/`ToolTuiPartialRevealPolicy`）+ `src/providers/stop-reason.ts`（`StopReason`/`STOP_REASON_ALIASES`/`normalizeStopReason`，比原计划单列：终止原因归一化是独立词汇表职责）+ `src/providers/response.ts`（`Usage`/`ProviderResponse`/`ToolResult` 值对象）+ `src/providers/tool-call.ts`（`finalizeToolCall`/`recoverPartialArgs`，参数收口与截断修复）+ `src/providers/base.ts`（仅 `BaseProvider`）
- 迁移测试：实测 43 处 `providers/base.js` 引用（src 21 / tests 18 / external 1），全项目第二宽引用面
- 硬约束：`src/index.ts` 的 11 个导出符号名与类型形状不变（已核：只改来源路径）；`src/tools/executor-types.ts` 的防环理由复核仍成立（它只需 `ToolResult` 类型，现指向 `providers/response.js`），但其文档提到已删除的 `src/tools/basic.ts`，见 **Q11**
- 状态：完成（5 文件，正文代码行 236 行多重集与 `HEAD:base.ts` 全等，0 处可见性放宽）


#### T-B8-02 协议家族文件夹化（**决策：不做，理由见下**）
- 原计划：`src/providers/anthropic/`、`openai/`、`copilot/`、`gateway/`、`registry/` 五个家族目录 + 把 `anthropic-base`(790)/`openai-chat`(827)/`openai-responses`(983) 按方法组拆成 `request`/`stream`/`tool-call-assembly`/`usage-mapping`
- **实测结论（改变方案的事实）**：这三个大文件都只有 1 个顶层声明（一个类），其"方法组"是**子类契约**而非内部实现细节。实测有 16 处 `protected override` / `override` 落在 5 个子类上：
  - `glm.ts`：`_applyThinkingParams`、`_convertTools`
  - `qwen.ts`：`_applyThinkingParams`、`_augmentRequestKwargs`
  - `openrouter.ts`：`_sealedSchemaForChatProvider`、`_applyThinkingParams`、`_augmentRequestKwargs`、`sendMessage`、`_convertMessages`
  - `qwen-responses.ts`：`_applyThinkingParams`、`_nativeWebSearchTool`、`_supportsMaxOutputTokens`、`_supportsPromptCacheKey`、`_forceStream`、`_plainThinkingInputItems`
  - 把 protected 方法抽成自由函数会直接改掉继承面 ⇒ 属功能改动，违反"仅结构"授权。**因此不对这三个类做方法级拆分**（按"职责边界而非行数"判断：单类适配器 + 子类钩子 = 一个职责）
- 家族目录化（纯移动）本身可行（17 文件、约 50 处引用），但会把全部 provider 路径变深一级且只有分组收益；在 B10（session 12 簇）这个用户点名的高价值项之前，优先级靠后
- 状态：**完成（决策：不做家族目录化与方法级拆分）** —— `base.ts` 已按职责拆成 5 文件（B8.1）；家族目录化与三适配器方法拆分不做，理由如上。`src/providers/` 仍保持 27 个平铺文件 + 按继承事实分层的类命名（`BaseAnthropicProvider` → `*AnthropicProvider`；`OpenAIChatProvider` → glm/qwen/openrouter；`OpenAIResponsesProvider` → qwen-responses + copilot 内部实现）

#### T-B8-03 `src/providers/credential-flow.ts`（402）与 `src/auth/` 的边界确认
- 结论：边界正确，**不动**。`credential-flow.ts` 是 TUI 依赖的凭据向导（`CredentialPromptAdapter`），`src/auth/` 是 OAuth 实现；二者已各自成域。搬成单文件目录（`providers/credentials/flow.ts`）只增路径深度不减职责，按最小范围原则跳过
- 状态：完成（结论：保持现状）

#### T-B8-04 `src/auth/openai-oauth.ts` 拆分（1067 行 / 61 声明 → 9 文件）
- 实际落点：`src/auth/openai/{endpoints,types,http,token-store,jwt,pkce-flow,device-code-flow,refresh}.ts` + `src/auth/oauth-command.ts`
  - 比原计划多出 `types.ts`（`OAuthProgress`/`HeadlessOAuthOptions` 被两条流程共用，放任一流内会造成流间依赖）与 `http.ts`（`fetchJson`/`fetchForm` 被两条流与 refresh 共用）；`refresh.ts` 单列（刷新是独立职责，且被 provider 适配器直接调用）
  - 原计划的"5 文件"里 `pkce-flow` 同时承载浏览器回调与无头变体，现保持同置（它们共享 `waitForCallback`/`callbackHtml`），设备码流独立
  - `oauthCommand` 及其 `codex*/copilot*` 交互与终端输出放在 `src/auth/oauth-command.ts`（目录 `auth` 表领域，文件名表"OAuth 子命令"；它同时服务 Codex 与 GitHub Copilot，故不放进 `openai/`）
- 依赖为单向：endpoints/types/token-store 为叶 → http/jwt → pkce-flow/device-code-flow/refresh → oauth-command
- 引用更新 15 处（含 4 处 `await import(...)` 动态导入：`cli.ts`、`server/init-rpc.ts`、`server/server-mode.ts`、`opentui/bootstrap.ts`）；`github-copilot-oauth.ts` 的同目录 `./openai-oauth.js` 单独手工改（工具匹配的是跨目录写法）
- 等价性：正文代码行 738 行与 `HEAD:openai-oauth.ts` 多重集全等，17 处可见性放宽（端点常量与 `fetchJson`/`fetchForm`/`authStorePath`）
- 状态：完成

#### T-B8-05 `src/models/` 与 provider 数据的归位
- 已完成：`src/models/registry.ts` → `src/providers/provider-specs.ts`（`git mv`，内容零改动）。**深度仍为 2，故 C4 的 `../../assets/model-registry/providers.json` 不用改**，无需重新验证深度（比原计划的 `providers/registry/specs.ts` 深度 3 更安全）。引用更新 4 处（`models/presentation.ts`、`providers/{presets,registry-effective,registry}.ts`）
- 延后：`src/models/picker-tree.ts`（632，两棵树）→ `src/models/picker/{model-tree,credential-tree}.ts`，并入 B9 一起做
- 状态：完成（picker-tree 已在 B9.2 拆分）

### B9 `src/agents/` `src/swarm/` `src/templates/` `src/skills/` `src/ui/` `src/models/` `src/permissions/`

#### T-B9-01 `src/agents/tool-loop.ts` 拆分（1809 行 → 4 文件）——完成
- 实际落点：`src/agents/tool-loop/{types,display,streaming-arguments,run}.ts`（236 / 144 / 430 / 1069 行）；`run.ts` 仍大，因为 `asyncRunToolLoop` 本身是 914 行的单一函数（拆函数内部属行为改动，不做）。
  - `types.ts`：`ToolLoopResult`、四组回调类型、`ToolPreflight*`、可见性策略、`ToolLoopOptions`；并承接原 `:63` 的 `export type { ToolExecutor, ToolExecutorContext }` 二度导出（Q7：保留双源，只统一路径）
  - `display.ts`：`generateToolSummary`/`generateToolCallDisplay`/`extractToolPreview` + `compactDisplayValue`
  - `streaming-arguments.ts`：增量 JSON 解析器（`parsePartialFlatObject`/`extractComplete*`/`parseEditsArray`）+ `buildStreamableToolCall` + 流式状态类型
  - `run.ts`：`asyncRunToolLoop`、`detectTurnDefect`、`buildToolCallMeta`、`resolveDefaultToolCallTuiVisibility`、`COMPACT_ASK_DENY_MESSAGE`
- 引用更新 11 处（src 7 / tests 4），按符号分别指向 `tool-loop/types.js` 或 `tool-loop/run.js`；`src/agents/tool-loop.ts` 已 `git rm`，不保留 shim。
- 一处必要的类型适配：`host._activeAsk` 在"赋值 → 调用其他方法 → 再读"之间会被 TS 重置收窄（原类里 `this._activeAsk` 不会），在 6 处读点加了非空断言 `!`（纯类型注解，无运行时变化）。
- 状态：完成

#### T-B9-02 `src/swarm/` 只动 barrel（见 T-B1-01），其余文件不动（B13 删掉 `gui-integration.ts` 后为 15 个）
- `coordinator.ts`(515)/`decomposer.ts`(401)/`message-bus.ts`(362)/`types.ts`(354)/`monitor.ts`(348)/`merger.ts`(323)/`context-bridge.ts`(318)/`task-dag.ts`(310) 均职责单一
- 状态：完成（见 §6 批次日志）

#### T-B9-03 `src/templates/loader.ts` + `src/lib/prompt-assembler.ts` → `src/prompts/`——完成
- 实际落点：`src/prompts/templates.ts`（673 行，原 `templates/loader.ts`）+ `src/prompts/assembler.ts`（287 行，原 `lib/prompt-assembler.ts`）。两者都是纯移动（深度同为 2，import 无需改），消费方 8 处路径按符号重指；`src/templates/` 目录已消失，`src/lib/` 只剩 `jsonc`/`line-window`/`filesystem-hash` 三个真正的通用件。
- 未按原计划再切成 `tool-packs`/`recipe`/`template-io`/`template-validation`：`loader.ts` 的发现/校验/组装共享 `PromptRecipe` 与大量私有 helper，硬切会把 10+ 个内部函数互相暴露；先按"域"合并（这正是 B5 的 D2 决策），函数级再拆留给后续。
- 修了两处随移动产生的过期引用：`templates.ts` 注释里的 `src/prompt-assembler.ts` → `src/prompts/assembler.ts`；两个新模块头注释（原为 classify/loader 的整段说明）。
- 状态：完成

#### T-B9-04 `src/skills/loader.ts`（267）与 `src/permissions/classify.ts`（904）——classify 完成
- 实际落点：`permissions/command-catalog.ts`（272 行，19 个 Set/Map 分级表 + `isDangerCommand`）、`permissions/git-subcommand-rules.ts`（145 行，`GIT_*` + `classifyGitDetailed`）、`permissions/classify.ts`（538 行，parser 初始化、`CLASS_ORDER`、两个 classify 入口、PS 判定与 canonical pattern helper）。
- 正文代码行与 `HEAD:classify.ts` 多重集全等（591 行），19 处补 `export`；`CLASS_ORDER` 与升级规则逐字未动；`initBashParser` 的 wasm 加载（受 `bash/parser.ts` 的 `createRequire` 影响）未动。
- `src/skills/loader.ts` 未拆：267 行、职责单一（技能发现 + 内容解析），不满足拆分条件。
- 状态：完成

#### T-B9-05 零散大文件与目录歧义
- `tools/web-search.ts`（809）按职责三拆——完成：`src/tools/web-search/{results,engines,tool}.ts`（379 / 347 / 131 行）。`results.ts` 是"结果值类型 + JSON/文本块两种解析 + 展示格式化"，`engines.ts` 是"后端优先级解析 + 7 个引擎实现（4 个 API key、2 个免费 MCP、DuckDuckGo 抓取）"，`tool.ts` 是"工具定义 + 直通车处理器 + 主执行器"。正文代码行与 `HEAD` 多重集全等（676 行），12 处补 `export`；消费方 4 处 + 测试 1 处按符号重指，原文 `git rm`。
- `src/browser/` → `src/browser-preview/`——完成。消除与 `src/platform/browser/` 的同名歧义；唯一外部消费方 `commands/workflow/goal.ts` 已重指，`platform/index.ts` 的 `./browser/index.js`（它自己的子目录）保持不变。深度未变，目录内 import 无需改。
- `src/ui/` 4 文件均 <282 行，不拆；`lib/ui-text.ts` → `ui/text.ts` 已在 B5 完成。
- 状态：完成（web-search 三拆 + browser 改名）

### B10 `src/session*` —— 核心，依 D1/D5 执行

#### T-B10-01 根散文件归位
- `src/session-resume.ts`→`src/session/resume.ts`（引用 5）、`src/session-tree-types.ts`→`src/session/tree-types.ts`（引用 11，含 opentui 4）、`src/session-capabilities.ts`→`src/session/capabilities.ts`（引用 3）
- 均为纯类型/小函数，深度变化无路径假设（已核：无 `import.meta.url`）
- 状态：**完成**。`resume.ts` 的 `./config/*`→`../config/*`、`./session.js`→`../session.js`；`src/session/`、`src/session/background-shell/` 内部的 `session-tree-types` 引用按相对位置手工改为 `./tree-types.js` / `../tree-types.js`，其余 21 处消费方用 `rewrite.mjs` 统一重指

#### T-B10-02 `src/session/` 去冗余前缀
- `session-log.ts`→`log.ts`（引用 3）、`session-persistence.ts`→`log-surgery.ts`（引用 1）、`session-prompts.ts`→`prompts.ts`（引用 2）
- 命名理由：目录已表 session；`log-surgery` 沿用其头注释自述的职责（被 `Session._logSurgeryView` 借用）
- 状态：**完成**。同目录内部 spec 先手工改（`log-surgery.ts` 里的 `../session-tree-types.js`→`./tree-types.js`、`./session-log.js`→`./log.js`），再做全局重指

#### T-B10-03 `src/session/child-session-manager.ts` 拆分（1554 行）——完成
- 实际落点：`src/session/children/{formatting,types,manager}.ts`（82 / 156 / 1417 行）。
  - `formatting.ts`：`formatTokenCount`/`extractLatestAssistantText`/`childPromptCacheKey`/`SUB_AGENT_OUTPUT_LIMIT`
  - `types.ts`：`ChildSessionHandle`/`PreparedChildRestore`/`ChildSessionSpawnOpts`/`ChildSessionManagerDeps`
  - `manager.ts`：`ChildSessionManager` 类本体（1365 行单类，未做方法级拆分——与 B8-02 同样的判断：单类=一个职责）
- 正文代码行与 `HEAD` 多重集全等（1220 行），1 处补 `export`。消费方 7 处按符号重指（类 → `children/manager.js`、类型 → `children/types.js`、`childPromptCacheKey` → `children/formatting.js`），`restore.ts` 的 inline `import("./…").ChildSessionHandle` 手工改指 `children/types.js`。
- 失误：`fix-depth` 非幂等，把已正确的 `src/session/background-shell/*` 又加深了一级（`../../`→`../../../`），typecheck 报 8 处 TS2307；已逐行还原，并把 `fix-depth` 改成"只对解析不到、且补一层后能解析到的 spec 生效"的幂等版本。同目录内 `./tree-types.js`→`../tree-types.js` 这类"跨出子目录"的搬运仍需手工核。
- 状态：完成

#### T-B10-04 `session/rewind-engine.ts`（878）与 `session-persistence.ts`（688）——rewind 完成
- `rewind-engine.ts` → `src/session/rewind/{types,engine,paths}.ts`（79 / 839 / 57 行）：journal/变更类型契约、引擎本体（790 行单类，不拆方法）、`pathsOverlap`。正文代码行与 `HEAD` 多重集全等（710 行），4 处补 `export`；唯一消费方 `session.ts` 重指。
- `session-persistence.ts` 已在 T-B10-02 改名为 `log-surgery.ts`（682 行），本轮**未**再按"写入/解析/修复"三面切：它是同一条日志手术流水线，外部只经 `Session._logSurgeryView` 借用；再切需要把 `LogSurgery` 契约拆成三份，收益低于风险。
- 状态：完成（rewind 拆分；persistence 维持单一模块）

#### T-B10-06 `src/cli.ts`（1051）——完成
- 落点：`src/cli.ts`（428 行，入口）+ `src/cli/session-picker.ts`（655 行，启动期会话选择 UI：项目/全局会话列表、续跑动画、交互式选择）。
- **C2/C9 红线保持**：`resolveOpenTuiEntry` 与入口守卫（`fileURLToPath(import.meta.url)` 比较）都留在 `src/cli.ts`（深度 1），`import.meta.url` 未搬进 `src/cli/`。
- 两处必须留意的坑：① partition 把文件头（含 `#!/usr/bin/env node`）复制到 `session-picker.ts`，而我改写头注释时把 shebang 顶到了第 2 行——esbuild 直接报 `Syntax error "!"`，已删除；② 入口守卫是顶层语句（非声明），partition 按声明切分时会把它丢掉，已从原文尾部恢复（否则二进制会"构建成功但什么也不做"）。构建后实测 `node dist/src/cli.js --version` → `0.4.0`，`tests/packaged-paths.test.ts` 31 项全绿。
- 状态：完成

#### T-B10-05 `src/session.ts` 按 D1 分簇抽取（每个子步独立提交）
执行顺序按耦合从低到高。**表中的行号是拆分前基线，B10-01/02 的文件归位与各子步抽取后已变化，执行时必须按声明名重新定位**（不要用行号直接切）。

| 子步 | 抽出簇 | 行号（基线） | 私有状态依赖 | 状态 |
| --- | --- | --- | --- | --- |
| 05a | `session/turn-types.ts` ← `InlineImageInput`/`TurnLifecycleStatus`/`TurnLifecycleEvent`/`DrainPendingToolCallsResult` | `:184-214` | 无 | **完成**（`DrainPendingToolCallsResult` 补了 `export`；`session.ts` 保留 3 个公开类型的 re-export 以稳住 `src/ui/contracts.ts`、`tests/session-visibility.test.ts` 的导入面） |
| 05b | `session/no-reply-stream.ts` ← `NoReplyStreamBuffer` | `:232-289` | 无（独立类，零依赖） | **完成**（类改为 `export`，`session.ts` 内部导入） |
| 05c | `session/attachments.ts` ← 图片落盘/回读/`@file` 附件 | `:6746-6901` | 低（`_store.sessionDir`、`_imageCounter`、`_projectRoot`、`_sessionArtifactsOverride`、`primaryAgent`） | **完成**（155 行 → `extractAndSaveImages`/`resolveImageRef`/`processAttachments`；`Session` 侧留三个同名薄委托） |
| 05d | `session/usage-accounting.ts` ← token 用量聚合 + system prompt 分段估算 | `:211-234,3607-3716` | 中 | **完成**（纯计算外移，memo 缓存仍留 Session；`UsageStats`/`ContextBreakdown` 一起搬走，mojibake 注释逐字保留） |
| 05e | `session/task-list.ts` ← TaskStore 生命周期 + 5 个 `task_*` 执行器 + 子会话 settle 回写 + 启动对账 | `:2870-3413` | 中（字段簇自包含） | **完成**（12 个方法 / 564 行；`deliverRestoreNotice` 按职责留在 Session） |
| 05f | `session/skills.ts` + `session/mcp.ts` ← skills 启停 + MCP reload + 工具可用性通知 | `:2424-2584,2581-2860` | 中 | **完成**（skills 9 个方法 / 142 行；MCP 10 个方法 / 281 行；`_execReload` 与 `reloadConfigurationFromCommand` 作为编排入口留在 Session） |
| 05g | `session/model-settings.ts` ← 模型切换/全局偏好/subagent 设置 | `:2841-2975` | 低 | **完成**（7 个写入/组装方法 / 145 行；纯字段读写器 `get/set thinkingLevel`、`accentColor`、`currentModelName`、`currentModelConfigName` 按"状态面本身"留在 Session） |
| 05h | `session/restore.ts` ← prepare/commit/getLogForPersistence | `:2130-2323` | **高**（一次写约 25 字段） | **完成（保守版）**：4 个编排方法 / 213 行已搬；唯一的状态写入点 `_applyRestoredState` **仍留在 Session**（紧邻字段声明），`resetForNewSession`/`setStore` 作为生命周期入口留下 |
| 05i | `session/inbox.ts` ← 投递、排队输入、auto-resume、`_drainInboxAsEntries` | `:1266-1629` | 高（与轮次主体互调） | **完成**（13 个方法 / 384 行） |
| 05j | `session/round-tracking.ts` ← round/contextId 簿记、工作单元、中断提示 | `:925-1157` | 高 | **完成**（14 个方法 / 273 行）；"日志委托" `_appendEntry`/`_touchLog`/`_bumpLogRevision`/`_notifyLogListeners`/`_nextLogId`/`_logSurgeryView` 按"类自身的日志门面"留在 Session |
| 05k | `session/ask-flow.ts` ← 订阅、`_execAsk`、两类决议、子会话路由 | `:509-548,1426-1543,2895-2935,4606-4930` | 高 | **完成**（16 个方法 / 500 行） |
| 05l | `session/compact-flow.ts` ← 手动与自动压缩执行 | `:2650-2812,4806-5014` | 高（与激活循环互调） | **完成**（7 个方法 / 407 行） |
| 05m | `session/tool-drain.ts` ← `_beforeToolExecute` + `_drainPendingToolCalls` | `:2757-3230` | 高（`_permissionAdvisor["_allowOnceGrants"]` 括号访问保持原样） | **完成**（6 个方法 + 箭头属性 / 432 行） |
| 05n | `session/activation.ts` ← `_runActivation` + `_runTurnActivationLoop` | `:2965-3275,3686-4138` | 最高（约 766 行） | **完成**（2 个方法 / 869 行模块） |
| 05o | `session/turn-control.ts` ← 轮次锁、中断、错误幂等、close | `:1370-1442,3190-3373,4122` | 最高（锁与两个幂等标志同模块） | **完成**（9 个方法 / 350 行；`_turnErrorEntryWritten` 与 `_lifecycleEndedEmitted` 仍与锁同处） |
- **05c 暴露的硬约束（后续子步必读）**：`tests/session-file-attach.test.ts:130` 这种 `(Session.prototype as any)._processFileAttachments.call(fakeSession, …)` 用**纯对象冒充 this**，只保证"方法直接引用的那批字段"存在。一旦在委托里多调一个 `this._attachmentContext()`，4 个测试立刻 `TypeError: this._attachmentContext is not a function`。**因此每个抽出的方法必须保持与原来完全相同的 `this` 字段读取面**：把 deps 对象内联在委托里，不要新增中转方法。
- **05f 暴露的硬约束（后续子步必读）**：`tests/session-tool-availability-notice.test.ts` 用 `Object.create(Session.prototype)` 造对象，并**直接覆盖实例方法**（`session._ensureMcp = vi.fn(...)`）。因此模块内的同簇调用必须写成 `host._ensureMcp(...)` 走**虚分派**，不能直接调自由函数 `ensureMcp(host)`——后者会绕过实例覆盖，让真实实现跑起来（该测试正是因此先红后修）。判据：原代码写 `this.X(` 的地方，搬走后一律写 `host.X(`。
- 已知不可外移：`constructor:782-913`、字段声明区 `:369-594`、`:6737-6802` 的子会话 deps 闭包（依赖"同类实例可访问私有成员"语言规则）、`_logSurgeryView:1000-1021`（以 getter/setter 出借字段，是既有契约）
- 每子步必做：跑全量 `npm test`；grep `src/commands/` 全目录内 `session.<成员>` 逐条核对 41+ 鸭子调用点仍存在且语义未变（C10，typecheck 抓不到）
- 迁移测试：`tests/session-*.test.ts` 24 个 + `tests/{p3-ask,p4-p6,p7-mcp-security,background-shell,phase2-tool-validation,path-security-integration,session-*}.test.ts`；**并同步 C7（`status-panel-tasks.test.ts:113` 路径）**
- 风险：全项目最高。05h/05i/05l/05m/05n/05o 任一步失败都可能引入静默行为漂移
- 状态：**完成（按 D1 + B 策略）** —— 05a–05o 全部落地，`session.ts` 7105 → **4113 行**（B13/T-L-01 收尾后 4100 行；T-L-03 把 `getRewindTargets()` 的 8 行内联返回类型收成命名类型后 4092 行，收尾清理 3 删掉两个死 const 后 4089 行）

### B11 `tests/` 组织与命名——完成

#### T-B11-01 按模块镜像子目录（依 D3-A）——完成
121 个顶层测试文件迁入 22 个领域子目录（`session` 26 / `tools` 14 / `providers` 13 / `ui` 13 / `commands` 11 / `context` 8 / `config` 8 / `prompts` 4 / `security` 3 / `tasks` 3 / 其余 1–2），`tests/swarm/` 早已镜像。根目录只留两个跨模块验收测试：
- `tests/node-runtime.test.ts`：**不动**（`package.json` 的 `test:node` 与 `vitest.config.ts` 的 exclude 双硬编码，C9）；
- `tests/packaged-paths.test.ts`：读全仓路径的验收测试，放根目录才能同时覆盖 `src/` 与 `external/`。

相对导入统一 `../src/…`→`../../src/…`、`./helpers/`→`../helpers/`；`tests/helpers/session-harness.ts` 留在根 `helpers/`。

#### T-B11-02 命名不清的测试重命名——完成
| 现名 | 新名 |
| --- | --- |
| `p3-ask` | `session/ask-flow.test.ts` |
| `p4-p6` | ~~两个 describe 仍在同文件~~ **已在 B13 拆分**：`shell-governance.test.ts`（4 项）+ `output-round-context.test.ts`（1 项），共享 `minimal-session.ts` |
| `p7-mcp-security` | `clients/mcp-security.test.ts` |
| `phase2-tool-validation` | `tools/tool-arg-validation.test.ts` |
| `phase5-atomic-write` | `tools/atomic-write.test.ts` |
| `tool-improvements` | `tools/parameter-and-output-bounds.test.ts` |
| `crossplatform-fixes` | `permissions/path-handling.test.ts` |
| `commands-chain` | `commands/registry-chain.test.ts` |

本批真实失误：两个 opentui 测试用 `import.meta.url` 推仓库根（`dirname(dirname(...))` 与 `resolve(testDir, "..")`），迁移后各少一层，分别表现为 `mkdtemp … tests/tests/…` 与读取 `tests/external/opentui/main.tsx` 失败；已改为三层 `dirname` / `resolve(testDir, "..", "..")`。移动脚本本身在 121 个 `git mv` 中途抛错一次（原因未复现），已用同一脚本幂等续跑完成。

验证：`npm test` 127/1182/3 ✓、check-resolve ✓（同 4 条注释/fixture 假阳性）。

### B12 收尾验收
- T-B12-01 `npm run typecheck` + `npm run typecheck:tui` + `npm test` + `npm run test:node` 全绿
- T-B12-02 `npm run build` + `node scripts/build-sea-exe.mjs` 产物冒烟：启动 `release/SwarmFlow.exe`，验证 prompts/skills/jq/rg/fd 均解析到位（C1/C5/C6；按你的交付标准，源码测试全绿不算完成）
- T-B12-03 输出最终结构说明 + 任务完成表 + 待确认清单
- T-B12-04 合并 `refactor/structure-cleanup` → `main`（已授权并完成）
- 状态：完成（提交 `31e6424`，fast-forward 合并进 `main`）

---

## 4. 待确认清单（2026-10-22 已全部处置）

| # | 事项 | 处置结果 |
| --- | --- | --- |
| Q1 | `src/swarm/gui-integration.ts` 60 行纯注释、零引用 | **已解决**：文件已删除（零引用，无行为影响） |
| Q2 | ~~settings 双源~~ | **已解决**：`settings.ts` 实为压缩阈值，已改名 `compact-thresholds.ts`（B2） |
| Q3 | 工具参数校验三套并存（`arg-helpers.ts`、`arg-validation.ts`、Session 薄委托） | **已解决**：合并到 `src/tools/arg-validation.ts` 单一模块；核心校验抛 `ToolArgValidationError`，`ToolResult` 适配器复用同一判定与文案；删除 `arg-helpers.ts` 与 Session 3 个委托；新增 `tests/tools/arg-validation-contract.test.ts` 57 项，合并前后均绿 |
| Q4 | `registry-effective.ts` 纯透传 `EFFECTIVE_PROVIDER_SPECS = FACTORY_PROVIDER_SPECS` | **已解决**：确认 `provider-specs.ts` 不构成环（只依赖纯模块 `thinking/artifact.ts`），5 处消费方直连 `FACTORY_PROVIDER_SPECS`，删除透传文件；provider 与打包测试通过 |
| Q5 | init-service 与 models/providers 同义类型重复 | **已消解**：现有定义只剩 `src/lifecycle/types.ts` 一处；它与 `ProviderPreset`/`ModelPickerTreeNode`/`ResolvedModelSelection` 形状不同，不再构成重复声明 |
| Q6 | `CommandContext.session: any` 导致 41+ 鸭子调用无编译保护 | **已解决（T-L-01）**：新增 `SessionLike`（当时为 `src/commands/session-like.ts`，T-L-02 起移到 `src/session/contract.ts`），替换 `CommandContext.session`/`CommandOptionsContext.session` 的 `any`，`Session implements SessionLike` 提供双向编译保护；`ui/contracts.Session` 改为 `extends SessionLike`，删除 24 处重复/失真声明 |
| Q7 | `ToolExecutor`/`ToolExecutorContext` 二度导出 | **已解决**：删除 `agents/tool-loop/types.ts` 的 re-export，真源 `tools/executor-types.ts`；6 处消费方改指 |
| Q8 | `skills/` 仅 `.gitkeep` | **已决定保留**（用户确认，作为 bundled skills 落点） |
| Q9 | `index.ts` 等历史注释残留 | **已清理**：`launchTui` 注释改为 `main.tsx`/构建产物；src 内指向旧模块名的注释全部改指当前文件 |
| Q10 | session.ts 分节标题错位、乱码注释 | **已修正**：`AGENTS.md persistent memory` → `Tool call visibility`；`配置重载` → `Shared helpers`；`usage-accounting.ts` 两处乱码重写 |
| Q11 | `executor-types.ts` 注释指向已删除 `basic.ts` | **已修正**：改指 `tools/dispatch.ts` 与 `agents/tool-loop/run.ts` |
| Q12 | ~~session 有状态方法组抽取策略~~ | **已解决**：采用策略 B（放宽可见性 + host 虚分派），05e–05o 全部完成 |
| Q13 | `p4-p6` 两个 describe 同文件，拆分需复制 harness | **已解决**：拆为 `tests/session/shell-governance.test.ts`（4 项）与 `tests/session/output-round-context.test.ts`（1 项），共享 `tests/session/minimal-session.ts`；原 `session-flows.test.ts` 删除 |

---

## 5. 验收清单（B12 基线 + B13/T-L-01 收尾实测）

- [x] 未修改任何业务逻辑、算法、边界条件、错误语义、返回值、副作用、配置行为 — 拆分前每批做代码行多重集比对（B6 2768 行、B7 2768 行、B8.1 236 行、B8.2 738 行、05d/05e/05f 各模块、tool-loop 676 行、classify 591 行、picker 541 行、children 1220 行、rewind 710 行），差异仅为补 `export`
- [x] `npm run typecheck` 通过（0 报错）
- [x] `npm run typecheck:tui` 通过（0 报错，与基线一致）
- [x] `npm test` **130 文件 / 1246 通过 / 3 跳过**（B13 新增 57 项参数校验契约测试；p4-p6 拆分后 5 项保持通过；T-L-01 为纯类型改动，测试数不变；2026-10-23 收尾补 `tests/models/picker-current-marker.test.ts` 7 项，变异检验 4/4 全被捕获）
- [x] `npm run test:node` 通过（pass 2 / fail 0）
- [x] `npm run build` + SEA exe 产物冒烟通过：
  - `node scripts/build-sea-exe.mjs` → `release/SwarmFlow-win32-x64/SwarmFlow.exe`（100.0 MB）
  - `SwarmFlow.exe --version` → `0.4.0`；`SwarmFlow.exe --help` 正常输出
  - `runtime/prompts/{review.md,subagent,templates}`、`runtime/src/tools/intools/{jq,fd,ripgrep}`（`NATIVE_TOOL_DIRS` 只打包被引用的三个，**curl 等未引用资产不进发布包**）、`runtime/assets/model-registry/providers.json`、`runtime/external/opentui/{main.js,assets/*}` 全部在位（C1/C5/C6）
  - `find-cycles dist/src` → 299 个模块、0 运行时循环（clean build；B13/T-L-01 复测。此前 310 是未清 `dist` 的旧统计）
- [x] C1–C12 逐项复核未被违反（2026-10-23 用 `.tmp/acceptance-audit.mjs` 做结构化断言，16 项全通过）：C1/C4 的 bundled-assets 与 `../../assets` JSON 导入者均在 `src/<x>/` 深度 2；C2/C3 入口深度 1；C5 resolver 与 `intools/` 目录名未变；C6 拷贝清单 `src/assets/prompts/skills`；C7/C8 的契约测试路径与断言目标已随文件移动同步（见上表）；C9 `test:node` → `tests/node-runtime.test.ts` → spawn `src/cli.ts`；C10 的 43 个成员名与语义未变且由 `SessionLike` 在编译期兜住；C11 `tsconfig` 编译图范围未变；C12 的 `session.ts` + `session/` 共存且 `session/` 下无 `index.ts`
- [x] `src/index.ts` 全部公共导出符号名与类型形状不变（每批仅改来源路径）
- [x] ≥400 行文件已按 1.3 判定：职责混杂的已拆（basic/commands/commands-base/openai-oauth/session 12 簇等）；保留的是单类适配器（providers 三个）、单函数（asyncRunToolLoop）、单类（ChildSessionManager/RewindEngine）与两个编排入口
- [x] 命名问题清单 1.4 逐项闭环；§4 Q1–Q13 已全部处置
- [x] B13 收尾：参数校验单一模块、删除 3 个死/透传文件（`gui-integration`/`registry-effective`/`arg-helpers`）、`ToolExecutor` 单导出、注释腐化清理、p4-p6 拆分
- [x] T-L-01：`SessionLike` 取代 `CommandContext.session: any` / `CommandOptionsContext.session: any`，`Session implements SessionLike`，`ui/contracts.Session extends SessionLike`；`typecheck`/`typecheck:tui` 双向 0 报错，全量测试与基线一致
- [x] `onMcpStatus` 单一类型：删除 `McpStatusEntry` 副本，`session.ts:499` / `session/mcp.ts:39` / `SessionLike` 三处统一用 `clients/mcp/manager.ts` 的 `McpServerStatus`（`state` 由 `string` 收为 4 字面量联合）；`typecheck`/`typecheck:tui`/`npm test` 129/1239/3 全绿，clean `build` 仍 299 模块 0 循环，`dist` 里该类型边为 `export {}`
- [x] 无新增循环依赖（dist 产物实测 0 循环；`src/tools/executor-types.ts` 的防环手段保留）
- [x] T-L-03：`session-like.ts` 注释理由纠偏（`Pick` 实测可行，原"不能反向依赖"不成立）；`RewindTargetTurn` 归位 `session/rewind/types.ts` 并由 `session.ts`/`session-like.ts`/`commands/session/rewind.ts` 共用一份；TUI `app.tsx` 去掉 `any[]`/`(s: any)`。`app.tsx` 转译产物与 `HEAD` 字节相同（EOL 归一），未重建 exe
- [x] T-L-02：契约移到 `src/session/contract.ts`，`SessionLike` 补 `currentModelName`/`currentModelConfigName` 两个 getter（43 个成员）；`models/` 与 `session/role-model-resolver.ts` 的 9 处 `session: any` 全部收编，`grep -rn "session: any" src/` 归零。非 Session 调用方用两个派生最小视图（`ModelResolutionSession`、`ModelPickerSessionView`）；反向负向探针确认 `models/` 里访问未声明成员会报 `TS2339`
- [x] 收尾清理 2：删 `isCurrentSelection` 冗余首形参并同步唯一调用点；`scripts/build-sea-exe.mjs` 拷贝清单移除 `external/opentui`（`runtime/external/opentui` 15.88 MB → 7.94 MB，forked 源码树不进发布包）；重建 exe 后做产物级冒烟（`--version`/`--help`/无参 TUI 启动）；补 `tests/models/picker-current-marker.test.ts` 覆盖三条「当前模型」命中路径 + 四条防过度标记
- [x] 收尾清理 3：删 `session.ts` 两个零引用死 const（4092 → 4089 行，真实使用者在 `session/activation.ts:31` 与 `session/compact-flow.ts:15`）；6 个 provider 文件的 `network-retry` 注释改为真实模块名 `network/retry`，`grep -rn network-retry src/` 归零。五道门禁 + exe 重建冒烟全部复跑通过

**已执行**：T-B12-04 提交并合并（`31e6424 代码库整理中`，fast-forward 进 `main`）；B13 由用户提交为 `97256e0 删除gui-*相关文件。 合并三套参数校验。 删除registry-effective.ts透传文件`。**B13 之后的 A（`McpServerStatus` 收敛）+ T-L-01/02/03 + 收尾清理 2/3 全部留在工作区待用户提交**：27 个 modified + 2 个未跟踪新增（`src/session/contract.ts`、`tests/models/picker-current-marker.test.ts`）；`src/commands/session-like.ts` 是 T-L-01 在工作区新建、T-L-02 又移走的中间文件，从未入库，故 git 侧看不到删除。远端推送始终由用户执行。

## 6. 执行日志

### B0 — 基线（完成）
分支 `refactor/structure-cleanup`。基线：typecheck ✓、typecheck:tui ✓（0 报错）、npm test 127 文件/1182 通过/3 跳过、test:node ✓、build ✓。**无 lint 工具**。

### B1 — 零风险改名与 barrel（完成）
| 变更 | 说明 |
| --- | --- |
| `src/swarm/__init__.ts` → `src/swarm/index.ts` | `src/index.ts` 2 处 from 路径更新，符号不变 |
| `src/tools/shared.ts` → `src/tools/scan-exclusions.ts` | EXCLUDE_DIRS / isHiddenName / isExcludedDirName |
| 新建 `src/tools/output-truncation.ts` | truncateMiddle / truncateLine，函数体逐字照搬 |
| 新建 `src/tools/limits.ts` | SEARCH_BUDGET_MS（保留 native/JS 超时语义不分叉的原注释） |
| 引用更新 | basic.ts、symbol-search.ts、json-query.ts、native-search.ts、web-fetch.ts、lib/file-attach.ts、tests/tool-improvements.test.ts |

`src/swarm/gui-integration.ts` 仅登记 Q1，未改动。
验证：typecheck ✓、npm test 127/1182/3 ✓（与基线逐项一致）。

### B2 — config 层（完成）
| 变更 | 结果 |
| --- | --- |
| `src/lib/home-path.ts` → `src/config/home-dir.ts` | 20 处引用更新（含 opentui 4 处） |
| `src/config/settings.ts` → `src/config/compact-thresholds.ts` | 3 处；顺带解决 Q2（内容是压缩阈值，非 settings） |
| `src/config/persistence.ts`(1833) → 11 个文件 | `storage-layout`(56)/`timestamps`(51)/`session-store`(417)/`session-meta`(125)/`log-serialization`(229)/`log-repair`(230)/`archive`(96)/`storage-repair`(139)/`settings/types`(179)/`settings/legacy-preferences`(55)/`settings/io`(312) |
| `src/config/config.ts`(907) → 5 个文件 | `types`(85)/`model-naming`(43)/`model-capabilities`(127)/`asset-paths`(191)/`loader`(496) |
| 引用更新 | persistence 45 处 + config 49 处，符号级映射改写；`src/index.ts` 全部公共符号名不变，仅路径改变 |
| C8 契约测试 | `tests/diagnostics-logging.test.ts:40` 文本断言路径 → `src/config/settings/types.ts` |
| C1 校验 | `getBundledAssetsDir` 移入 `asset-paths.ts`（同深度 2），实测 `dist/src/config/asset-paths.js` → `F:\...\SwarmFlow\dist`，prompts/assets 均在位；函数内"源码布局"注释同步改名 |
| 拆分手法 | 按行区间切片生成新文件（字节级照搬，不重敲），边界逐条验证起止于完整块；仅 3 个原模块私有 helper（`nowTimestamps`/`toLocalIsoFromUtc`/`looksLikeSessionId`/`resolvePreferredBaseDir`）因跨文件复用而加 `export`，公共导出面未扩大 |

验证：typecheck ✓、typecheck:tui ✓、npm test 127/1182/3 ✓、`rm -rf dist && npm run build` ✓ 且无 `config.js`/`persistence.js`/`settings.js` 残留。

### B3 — server / lifecycle / hooks / platform / clients（完成）
| 变更 | 说明 |
| --- | --- |
| `src/hooks/hook-runtime.ts` → `src/hooks/dispatcher.ts` | 与既有 `runner.ts`（执行单条钩子命令）形成清晰对偶：dispatcher 负责事件匹配与结果汇总。类名 `HookRuntime` 未改，`hooks/index.ts` barrel 与 `tests/p3-ask.test.ts` 路径更新 |
| `src/lib/system-proxy.ts` → `src/platform/system-proxy/apply-to-env.ts` | 消除 `lib` 对 `platform/system-proxy/` 的桶外包装；内部引用改 `../index.js`，`src/cli.ts` 与测试路径更新 |
| `src/lifecycle/types.ts` 新建 | `ProviderPresetInfo`/`ModelPickerNode`/`ModelSelection`/`ConfigStatus`/`SearchApiOption` 从 init-service 抽出；`SEARCH_API_OPTIONS` 数据表留在服务内；`src/server/init-rpc.ts` 改指 types.js。init-service 390→351 行 |
| `src/server/session-rpc.ts`(835) → 4 个文件 | `protocol.ts`(19，线路版本与能力声明)/`session-status-payloads.ts`(196，负载类型+构造器)/`session-fork.ts`(107，`session.fork` 目录复制)/`session-rpc.ts` 收敛为 514 行（注册与分发）。`PROTOCOL_VERSION=1` 与能力数组逐字未变 |
| `src/clients/{mcp-client,mcp-config}.ts` → `src/clients/mcp/` | `security-policy.ts`（环境白名单/凭据文件权限/SSE URL 校验）、`manager.ts`（惰性 SDK 加载 + 连接管理；模块级可变 `Client/StdioClientTransport/SSEClientTransport/mcpAvailable` 与 `ensureMcpSdk` 同模块，未拆分以保持单例语义）、`config.ts`（原 mcp-config 逐字迁入） |
| 引用更新 | mcp 两处说明符共 8 处改写（含 `src/index.ts` 的 `loadMcpServers`、`external/opentui/bootstrap.ts` 动态导入、`src/session.ts` 两处动态导入） |

过程中新增两件常驻校验工具（`.tmp/`，gitignored）：
- `check-resolve.mjs`：全量校验相对导入是否指向真实文件。当前基线 5 条命中均为**文档注释示例与测试 fixture 字符串**（`src/lib/file-attach.ts:9`、`tests/opentui-code-highlighting.test.ts:416-418`、`external/opentui/.../env.ts:8`），非真实引用；后续批次只关注新增项。
- `prune.mjs`：删除因整块继承而未使用的 import 说明符。

验证：typecheck ✓、typecheck:tui ✓（0 报错）、npm test 127/1182/3 ✓。
本批唯一回归：`tests/prompt-cache-affinity.test.ts` 仍从 `session-rpc.js` 导入已迁走的 `forkSessionDirectory`（tsconfig 不含 tests，typecheck 无法捕获），已改指 `session-fork.js` 并复测通过。

### B4 — context 层（完成）
| 变更 | 结果 |
| --- | --- |
| `src/context/context-rendering.ts`(302) → 3 文件 | `compact-marker.ts`(20)/`context-tags.ts`(162)/`message-merging.ts`(110)。实测三簇零交叉引用，拆分无依赖注入成本 |
| `src/context/log-projection.ts`(1017) → 2 文件 | `projection/tui.ts`(576)/`projection/api.ts`(455)。实测两侧无符号交叉；`src/index.ts` 与 `external/opentui` 共 12 处引用按符号重定位 |
| `src/context/log-entry.ts`(818) → 4 文件 | `entry/types.ts`(135)/`entry/agent-result-preview.ts`(30)/`entry/id-allocator.ts(79)`/`entry/factories.ts`(595，30 个 `create*` 构造器)。34 处引用重定位 |
| `src/context/document-projection.ts`(502) → 6 文件 | `document/view.ts`(123，扩展名判定+投影缓存+分派)/`ooxml.ts`(68)/`pdf.ts`(23)/`docx.ts`(32)/`xlsx.ts`(159)/`pptx.ts`(151)。原文件是"缓存管道 + 4 种格式转换器"混杂，现按格式各归其位 |
| 未改动 | `active-context.ts`(290)/`ephemeral-log.ts`(298)/`token-estimate.ts` —— 职责单一，复核后保留 |

过程回归与修复（均为路径/别名问题，未触碰逻辑）：
- `split-rewrite.mjs` 早期不识别 `import { X as Y }` 形式，导致 3 个文件（`agents/tool-loop.ts`、`session/session-persistence.ts`、`session.ts`）漏改；已支持 `as` 别名后重跑。
- `log-entry` 的映射键漏了 `entry/` 子目录，先产生 `../context/types.js` 又被子串修补误伤成 `../context/entry/context/types.js`；已用 `context/entry/context/` → `context/entry/` 一次纠正 45 处，并逐个校正 `projection/*.ts`、`token-estimate.ts` 的跨目录导入。
- 拆分导致的可见性放宽：4 个原模块私有的转换器（`convertPdf/Docx/Xlsx/Pptx`）与 OOXML 助手（`XmlElement`、`byLocalName`、`loadZipXml`、`toMarkdownTable`、`escapeTableCell`、`relationshipId`）加 `export`；公共导出面（`src/index.ts`）符号名与形状不变。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（仍为 5 条注释/fixture 假阳性）、npm test 127/1182/3 ✓。

### B5 — `src/lib/` 归宿主模块（完成，按 D2 选项 A）
纯移动（保持深度 2，无需改路径计算）：

| 原路径 | 新路径 | 引用改写 |
| --- | --- | --- |
| `lib/logger.ts` | `logging/logger.ts` | 5 |
| `lib/log-rotation.ts` | `logging/rotation.ts` | 2 |
| `lib/progress.ts` | `logging/progress.ts` | 5 |
| `lib/network-retry.ts` | `network/retry.ts` | 8 |
| `lib/thinking-artifact.ts` | `thinking/artifact.ts` | 15 |
| `lib/tool-runtime.ts` | `tools/runtime.ts` | 4 |
| `lib/ui-text.ts` | `ui/text.ts` | 15（C4：深度仍为 2，`../../assets/` 未变） |
| `lib/diff-hunk.ts` | `patches/hunk.ts` | 5 |
| `lib/task-reconcile.ts` | `tasks/reconcile.ts` | 4 |
| `lib/home-path.ts` | `config/home-dir.ts` | B2 已做 |
| `lib/system-proxy.ts` | `platform/system-proxy/apply-to-env.ts` | B3 已做 |

拆分：

| 原文件 | 拆成 | 说明 |
| --- | --- | --- |
| `lib/task-store.ts`(748) | `tasks/{types,resume,normalize,store,snapshot}.ts`(101/36/80/488/82) | 按"数据形状 / 续跑判定 / 载入修复 / 存储类 / 压缩快照"四面 + 路径助手随 store |
| `lib/file-attach.ts`(684) | `attachments/{file-kinds,scanner,types,reference,reader,context-block,pipeline}.ts`(76/111/55/50/228/94/142) | 原文件混杂限额表、目录扫描、引用解析、读取摘要、上下文块渲染、主编排 6 件事。原模块头注释已是 mojibake（见 Q10），新文件写清晰头 |
| `lib/background-shell-manager.ts`(700) | `session/background-shell/{manager,types}.ts`(599/60) | 深度 2→3，导入统一 `../`→`../../`；Session 的类型导入改指 types.js |
| `lib/image-compress.ts` / `lib/clipboard-image.ts` | `attachments/` 同名 | 与附件同域 |

瘦身后 `src/lib/` 仅剩真·跨领域原语：`jsonc.ts`、`line-window.ts`、`filesystem-hash.ts`。
`lib/prompt-assembler.ts` 留给 B9 与 `templates/loader.ts` 一起并入 prompts 域，避免二次移动。

本批回归全部为机械问题，逐条已修：
- 说明符基路径重复（`./lib/` + `tasks/…` → `./lib/tasks/…`）两次，用 `lib/tasks/`→`tasks/`、`lib/attachments/`→`attachments/` 各纠正 15/9 处。
- `wire-siblings.mjs` 的 import 插入点检测误把函数参数行当 import 续行，把 5 条导入插进 `pipeline.ts` 函数体中间；已重排到头部并把 `"./attachments/x"` 修正为 `"./x"`。
- 拆分导致的可见性放宽：`file-kinds` 的 9 个原私有常量、`reader` 的 `makeFileInfo`/`summarizeTextContent`、`normalize` 的 5 个 as* 助手、`resume` 的 2 个助手、`snapshot` 的 `compareById`/`edgeWarning`、bg-shell 的类型面，均加 `export`。`src/index.ts` 公共符号名与形状未变。
- 顺带取证 Q3：`session/background-shell/types.ts` 的兄弟模块证实 `tools/arg-helpers.ts` 与 `tools/basic.ts` 的参数校验助手确实并行存在（B13 已合并为 `tools/arg-validation.ts` 单一实现）。

验证：typecheck ✓（0 报错）、typecheck:tui ✓、check-resolve ✓（4 条，均为注释/fixture 假阳性，原 5 条中 `file-attach.ts` 那条随文件删除而消失）、npm test 127/1182/3 ✓。

### B6 — `src/tools/` 最大文件（完成）
`src/tools/basic.ts`（4471 行，7 类职责同居）→ 14 个职责模块，全部保持 `src/tools/` 目录与深度 2（C5 不受影响）：

| 新模块 | 行 | 职责 |
| --- | --- | --- |
| `limits.ts` | 62 | 全部 `*_MAX_*` / `BASH_*` / `SEARCH_*` 限额 + `SEARCH_BUDGET_MS` |
| `mutations.ts` | 387 | 文件/命令变更追踪：`FileMutation`、`BashMutation*`、可追踪 bash 变更解析与前后记录 |
| `definitions.ts` | 646 | 11 个 `ToolDef` schema 与 `BASIC_TOOLS`/`BASIC_TOOLS_MAP` 聚合 |
| `file-read.ts` / `file-list.ts` / `file-edit.ts` / `file-write.ts` / `file-version.ts` | 275/176/352/212/120 | 五个文件类工具实现；`file-version.ts` 单独承载版本快照与冲突检测（edit 与 write 共用） |
| `bash.ts` | 573 | `toolBash`、输出落盘、环境构造、统一 diff 预览、`toolTime` |
| `glob.ts` / `grep.ts` | 377/841 | 两个搜索工具各自的 native+JS 双引擎与输出格式化 |
| `path-scoping.ts` | 118 | `scopedPath` + `READ_ACCESS_KINDS` + `toolRoot` |
| `arg-validation.ts` | 199 | `ToolArgValidationError` 与 required/optional 参数校验族 |
| `dispatch.ts` | 629 | `ExecuteToolContext`、`formatToolError`、`createDispatch`、`executeTool` |

`json-query.ts`、`native-search.ts`、`intools/` 未动（C5）。`src/index.ts` 的 `BASIC_TOOLS`/`BASIC_TOOLS_MAP`/`executeTool` 符号名不变，仅路径改变。

工具链建设：新增 `.tmp/partition.mjs`（按"顶层声明 + 紧邻注释块"做**逐字节连续、互不重叠**的切分，块边界 = 下一块注释起始），后续 commands/tool-loop/openai-oauth 等批次复用。

本批真实失误与修复（如实记录）：
- `partition.mjs` 首两版有两个缺陷：单行 `/** … */` 注释回溯退到文件首、以及 import 区误取"全文最后一处 import 样式行"，导致每块吞下全文。已改为"遇空行/非注释即止"+"首个声明块之前即 import 区"。
- **`src/tools/limits.ts` 被 partition 覆盖**：B1 建的 limits.ts（只含 `SEARCH_BUDGET_MS`）与 basic.ts 的限额常量目标同名，被整体改写，`SEARCH_BUDGET_MS` 定义一度丢失。已按 `HEAD:src/tools/shared.ts` 的原文（值 `15_000` 与"native/JS 共用避免超时语义分叉"注释）恢复到同一个 limits 模块，并删掉 limits.ts 内自引用 import。后续批次的 partition 目标文件名一律先与既有文件比对，不再允许同名覆盖。
- 14 个新模块间需要互相引用，把原本 module-private 的 30 个限额常量与工具执行函数（`toolReadFile`/`toolBash`/`scopedPath` 等）加了 `export`。公共导出面（`src/index.ts`）符号名与类型形状未变。
- `src/ui/contracts.ts:67` 的 inline `import("../tools/basic.js").BashMutationEntry` 单独改指 `mutations.js`。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（4 条已知假阳性）、npm test 127/1182/3 ✓、`rm -rf dist && npm run build` ✓ 且 `dist/src/tools/intools/{jq,fd,ripgrep}` 在位、`resolveBundledSearchExecutable`/`bundledJqPath` 可解析（C5 实测）。

### B7 — `src/commands/` 拆分（完成）
`src/commands/commands.ts`（3487 行，122 个顶层声明）→ 31 个职责模块（合计 3785 行，多出的 298 行是各文件必要的头部与跨模块 import），命令域分组 `session/ model/ provider/ workflow/ ecosystem/ ui/` + 机制层 `types.ts`/`registry.ts`/`registration.ts`/`settings-patch.ts`。行数分布：最大 324（`provider/custom.ts`），最小 18（`provider/presentation.ts`、`settings-patch.ts`），中位 101。本层不再有"最大文件"问题。

深度与红线：`commands.ts` 内无 `import.meta.url`/JSON 导入/`..` 逃逸路径（唯一的 `join(sourceDir,"log.json")` 等用的是运行期变量），因此子目录化不触任何 C 红线；C10 的 `session: any` 形状原样搬入 `types.ts`。

等价性证据（三重）：
1. **注册顺序前置校验**：临时红测先证明检测器有效（同名二次注册会被记录），再证明 29 次注册无重名；`register` 为 `Map.set`（`registry.ts:49`）有覆盖语义，所以"无重名"即"分组 import 顺序变化不可能改变 handler"。测完即删。
2. **产物级快照比对**：`.tmp/dump-commands.mts` 抓取前后注册顺序 + 每个命令的 `handler.toString()`/`options.toString()`/picker/category/executionMode，结果 29/29 逐字段全等。
3. **代码行多重集比对**：`.tmp/verify-body.mjs` 对 `HEAD:commands.ts` 与 31 个新文件的声明区正文做忽略注释/空行的行级多重集比较，2768 行全等，唯一差异 73 行补 `export`。

工具链建设：`.tmp/wire-internal.mjs`（按声明归属表自动生成模块间 import 并做最小 `export` 放宽，只扫声明区正文且跳过注释行，避免文档示例与 `x as y` 别名造成误报）、`.tmp/verify-body.mjs`、`.tmp/find-cycles.mjs`（以 dist 产物为输入，type-only 已擦除，得真实运行时图；本次 258 模块 0 循环）、`.tmp/refmap.mjs`（拆前先看每个声明的内聚/被引面，用来定边界而不是按行数切）。

本批真实失误与修复（如实记录）：
- `headers.mjs` 首版删"残留分区注释"时把注释行判定写成 `^(\*|//|/\*)`（缺 `^\s*`），越过 jsdoc 起始 `/**` 把它单独吃掉，导致 `types.ts` 的 `ShowMessageFn` 文档注释残缺。已删除全部生成物重跑流水线，并把规则改为"只删连续的 `//` 行，遇空行/块注释/代码即停"。
- 重跑时忘记重新应用两处手工修正（`provider/oauth.ts` 的多行动态 `import("../../providers/copilot-models-cache.js")`、`types.ts` 的 `import type { CommandRegistry }`），typecheck 复现后补回。
- `split-rewrite.mjs` 两个缺陷：映射键我写成了 `types.ts`（项目约定相对导入一律 `.js`），以及纯 type 分组把 `Foo as Bar` 输出成 `Bar` 丢了别名。前者用 `.tmp/fix-ts-ext.mjs` 修正 36 行/22 文件，另 4 行因 CRLF 未被 `$` 锚点匹配、单独修正；`src/ui/contracts.ts` 的 3 个别名 import 手工还原。工具已就地修好（别名保留 + 键必须 `.js` 结尾否则抛错），供 B8/B9 使用。
- 教训：`.tmp` 脚本里的行锚点必须容忍 CRLF；`tests/` 与 `external/opentui` 下多为 CRLF 文件。

引用更新 23 文件；`src/index.ts` 的 5 个导出符号名与形状不变（改为 `registry.js`/`types.js`/`registration.js`/`ecosystem/skills.js`）；`README.md:110` 的过期路径改指 `src/commands/`。可见性放宽 73 个符号（全部为原本 module-private 的命令 handler、选项构造器与 provider 助手），`src/index.ts` 公共面未扩大。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`npm run test:node` pass 2/fail 0 ✓、`rm -rf dist && npm run build` ✓、find-cycles 0 循环 ✓。

### B8.1 — `src/providers/base.ts` 分离（完成）
`base.ts`（409 行 / 18 个顶层声明）→ 5 个文件，深度不变（`src/providers/` 内无 `import.meta`/JSON import，不触 C 红线）：`stop-reason.ts`（终止原因词汇表与归一化）、`types.ts`（消息/工具/选项契约）、`response.ts`（`Usage`/`ProviderResponse`/`ToolResult` 值对象）、`tool-call.ts`（参数收口与截断修复）、`base.ts`（仅 `BaseProvider`）。内部依赖为单向叶子图（types 与 stop-reason 为叶；response→types+stop-reason；tool-call→types；base→types+response），0 处可见性放宽（原本全部已 export）。

引用更新 43 处：跨目录写法 `providers/base.js` 25 处由 `.tmp/split-rewrite.mjs` 按符号重指；`src/providers/` 内部另有 `./base.js` 写法 18 处，需以 `./base.js` 为匹配串**再跑一遍**才对上（见失误 1）。`src/index.ts` 的 11 个导出符号名与类型形状不变。

本批真实失误与修复（如实记录）：
1. **同目录 `./base.js` 形态漏改**：split-rewrite 的匹配串取自跨目录写法，同目录相对写法不在其内，typecheck 报 10+ 处 TS2459/TS2305 才暴露。已用同一映射表以 `./base.js` 再跑（先确认全仓只有这一个 `base.ts`，该匹配串无歧义）；`glm.ts` 的 inline `import("./base.js").SendMessageOptions` 手工改成顶层 `import type`（qwen.ts 等同族文件本就是顶层写法）。
2. **`prune.mjs` 顺手重排了无关语句**：它按说明符数量决定单行/多行，且对全文做 `\n{3,}` 折叠，于是本轮并未拆分的 `presets.ts`（多行→单行）、`copilot-models-cache.ts`（单行→多行；该文件的 `../config/home-dir.js` 是 B5 的合法改动，行形态被改坏）与 `copilot.ts`（`copilot-headers.js` 三说明符被折行）出现纯格式漂移。已逐处还原原写法，并把 prune 改成"沿用原语句行风格 + 空行折叠只作用于 import 区"。
3. `verify-body.mjs` 的 `ONLY` 过滤用 `endsWith`，把 `anthropic-base.ts` 误拉进 `base.ts` 的比对，报出假差异；改为相对路径精确匹配后 236 行全等。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓。

### B8.2 — `src/auth/openai-oauth.ts` 拆分（完成）
1067 行 / 61 个顶层声明 → 9 文件：`auth/openai/{endpoints,types,http,token-store,jwt,pkce-flow,device-code-flow,refresh}.ts` + `auth/oauth-command.ts`。正文代码行 738 行与 `HEAD:openai-oauth.ts` 多重集全等，17 处可见性放宽（端点常量、`fetchJson`/`fetchForm`/`authStorePath`）。

依赖单向：endpoints/types/token-store 为叶 → http/jwt → 两条登录流 + refresh → oauth-command。引用更新 15 处（4 处是 `await import(...)` 动态导入，工具原样支持）。`src/cli.ts` 的 `oauth` 子命令仍指向 `oauth-command.js`。

本批真实失误与修复：
- `github-copilot-oauth.ts` 用的是同目录写法 `from "./openai-oauth.js"`，不在 `auth/openai-oauth.js` 匹配串内，typecheck 报 TS2307 + 一串级联 TS7006；已手工改为 `./openai/token-store.js` + `./openai/types.js`。
- 该文件 `:145` 的注释"复用 openai-oauth.ts 的 OAuthProgress"随文件删除失效，已改指 `openai/types.ts`（属引用更新，不改语义）。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓。

### B8.3 — provider 规格数据归位 + 家族目录化决策（已收口：归位完成，家族目录化决策不做）
- `src/models/registry.ts` → `src/providers/provider-specs.ts`（`git mv`，内容零改动）。移到 `src/providers/` 后深度仍是 2，C4 的 `../../assets/model-registry/providers.json` **无需改动**；这比原计划放进 `providers/registry/`（深度 3，需改成 `../../../assets/...`）少一个红线风险。引用更新 4 处。
- **不做**家族目录化与三个大适配器的方法级拆分，理由是实测到 16 处 `protected override`（glm 2 / qwen 2 / openrouter 5 / qwen-responses 6 / copilot 3）——那些"方法组"是子类契约，抽成自由函数等于改继承面。按"职责边界而非行数"判断：单类适配器 + 子类钩子 = 一个职责。已在 T-B8-02 记录证据。
- `models/picker-tree.ts` 的两棵树拆分延后到 B9。

验证：typecheck ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓。








### B10.1 — session 文件归位 + 05a/05b/05c 抽取（阶段记录：05d–05o 由 B10.2–B10.12 收口）
- 文件归位（T-B10-01/02）：`session-resume`→`session/resume`、`session-tree-types`→`session/tree-types`、`session-capabilities`→`session/capabilities`、`session-log`→`session/log`、`session-persistence`→`session/log-surgery`、`session-prompts`→`session/prompts`。6 个文件 `git mv`，深度变化只影响 `resume.ts`（`./config/*`→`../config/*`、`./session.js`→`../session.js`）；`src/session/`、`src/session/background-shell/` 内部的相对引用先手工改，再对剩余消费方共 24 处引用做全局重指。已核这 6 个文件都没有 `import.meta`/JSON 导入。
- 05a：`session/turn-types.ts`（35 行）← `DrainPendingToolCallsResult`/`InlineImageInput`/`TurnLifecycleStatus`/`TurnLifecycleEvent`；`session.ts:171` 保留 re-export，消费方零改动。
- 05b：`session/no-reply-stream.ts`（60 行）← `NoReplyStreamBuffer`，类改为 `export`。
- 05c：`session/attachments.ts`（183 行）← 图片落盘/回读 + `@file` 附件展开；`Session` 侧留三个薄委托，`_imageCounter` 仍留在类里（属于会话状态）。
- `session.ts` 7105 → 6865 行。

本批真实失误与修复（如实记录）：
- 05c 首版在委托里引入 `this._attachmentContext()` 中转方法，`tests/session-file-attach.test.ts` 立刻 4 红：该测试用 `(Session.prototype as any)._processFileAttachments.call(fakeSession, …)`，`fakeSession` 只是"带若干字段的纯对象"。改为把 deps 对象内联进委托，**保持与被抽方法完全相同的 `this` 字段读取面**，测试恢复 6/6。该约束已写进 T-B10-05 的"后续子步必读"。
- 定位方法块时一度用"以 `}` 结尾且前一行是 `return …`"做结束锚点，实际缩进与预期不同导致锚点落空；改用下一个方法名做上界并显式校验首尾行内容后才切割。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`tests/session-file-attach.test.ts` 6/6 ✓、`tests/session-visibility.test.ts` ✓。

### B10.2 — 05d token 用量聚合（完成）
`session/usage-accounting.ts`（171 行）← `UsageStats`/`ContextBreakdown` 两个接口 + `aggregateTokenUsage(log)`（日志求和）+ `estimatePromptSections(input)`（system prompt 四段 gpt-tokenizer 估算）+ `scalePromptBreakdown(est, total)`（按 provider 实际上报体积缩放）。

- 只搬**纯计算**：两处 memo（`_promptSectionEstimates`、`_usageStatsCache`）仍留在 Session，因为它们是会话级状态；`_getPromptSectionEstimates` / `_computeUsageStats` 退化成 memo 包装 + 一次纯函数调用。
- `UsageStats`/`ContextBreakdown` 的注释里有历史 mojibake（"危 inputTokens"、"鈭?"），搬运用整行切片而非重打，字节保持原样（Q10 未变）。
- `session.ts` 6865 → 6778 行。
- 未触碰任何 memo 失效点、getter 名称或返回类型；`tests/session-compact-token-accounting.test.ts` 直接调用 `internals._computeUsageStats()`，仍存在且语义不变。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`tests/session-compact-token-accounting.test.ts` 4/4 ✓。

### B10 剩余评估（05e–05o）
从 05e 起，剩余"簇"与已完成的四个性质不同：
- 05a/05b 是独立声明/独立类，05c/05d 是**无私有状态或只有只读状态**的计算——可以真正搬出类外。
- 05e–05o 是同一个聚合根上的**有状态方法组**（任务列表、恢复、收件箱、日志簿记、ask、压缩、工具排空、激活循环、轮次锁）。要把它们搬到模块级，只有两条路：
  1. 把被读写的私有字段放宽为 public/internal —— 这是**封装契约变更**，且 `src/commands/`、`tests/` 存在大量 `Session.prototype.X.call(fakeSession, …)` 式鸭子调用，字段面一变就静默降级（typecheck 抓不到）；
  2. 逐个方法穿 `deps` 对象 —— 约 50 个方法 × 平均 6 个依赖，净增样板，可读性反而下降。
- 因此剩余 11 个子步不是"继续搬"就能保持零行为差异的，需要用户先定策略（见 §4 的 Q12）。当前 `session.ts` 6778 行仍是全项目最大文件，但四个真正的混职责块已经分离出去。

### B10.3 — 策略 B 落地 + 05e 存储生命周期（已收口：05e 由 B10.4 完成）
按用户选择的 **B（放宽字段可见性后继续抽）** 执行。

- 新增 `src/session/task-list.ts`（100 行）：`TaskListHost` 接口 + `getTaskState`/`subscribeTaskState`/`notifyTaskListeners`/`ensureTaskStore`/`ensureTaskToolsForSession`/`getTaskPersistence`。方法体逐字搬运，只把 `this.` 换成 `host.`；类内保留同名薄委托（含 `_ensureTaskStore` 等私有名），所以 `_onChildSettled`、`_execTask*` 与构造期的 `this._ensureTaskTools()` 调用点全部零改动。
- **为 B 策略放宽的可见性（后续每步都会列清单）**：`_store`、`_sessionArtifactsOverride`、`_taskStoreScope`、`_taskStoreRef`、`_taskStoreKey`、`_taskListeners`、`_capabilities`、`_getArtifactsDirIfAvailable()`。放宽仅去掉 `private` 修饰符，不改类型、不改初值、不改读写时机。
- 为什么这些放宽是安全的：委托把 `this` 原样传给自由函数，自由函数访问的字段集合与被搬方法**完全一致**；即便测试用 `Session.prototype.X.call(fakeObject)`，`fakeObject` 需要的字段也还是原来那批（多一个都不需要）。
- `session.ts` 6778 → 6739 行。
- 未搬：5 个 `task_*` 执行器与 `reconcileTaskListAfterRestore`/`_onChildSettled`/`_indexChildOutcomesFromLog`（约 430 行），它们还要读 `_log`、`_deliverMessage`、`_childSessionManagerInstance`，留下一步单独处理。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`tests/session-task-tools.test.ts` + `tests/task-tools.test.ts` + `tests/session-queued-input.test.ts` 共 39 项 ✓。

### B10.4 — 05e 完成（task-list 全量抽出）
`session/task-list.ts` 由 100 行扩到 **564 行**，共 12 个方法：
- 存储生命周期（上一步）：`getTaskState`/`subscribeTaskState`/`notifyTaskListeners`/`ensureTaskStore`/`ensureTaskToolsForSession`/`getTaskPersistence`
- 执行器：`execTaskCreate`/`execTaskList`/`execTaskGet`/`execTaskUpdate`/`execTaskResume`
- 对账与续跑：`onChildSettled`（子会话 settle 回写 metadata）、`reconcileTaskListAfterRestore`（重启对账，117 行）、`indexChildOutcomesFromLog`、`resumeRefusalText`、`resumeChildSession`、`argTaskMetadata`

追加放宽的可见性（承接 B10.3 的 8 个）：`_log` getter、`_childSessionManagerInstance` getter。合计 10 个成员；全部只去掉 `private`。

引用改造：`_argRequiredString`/`_argOptionalString` 在模块内改成直接调用 `tools/arg-helpers`（同一实现，少一层委托）；其余同簇互调改为 `fn(host, …)`。类内保留同名薄委托，`_buildToolExecutors` 的 5 个映射与 `_onChildSettled` 回调点零改动。

**C7 契约测试同步**：`tests/status-panel-tasks.test.ts` 的 "keeps task tool IDs intact" 原本读 `src/session.ts` 断言 `Task #${task.id} created:` 与 `#${task.id} [${task.status}]`，两条字符串随执行器搬到 `src/session/task-list.ts`。只改读取路径，断言未动（该测试 9/9 ✓）。

本批真实失误与修复：
- 脚本化的"方法→函数"转换第一版有两处缺陷：`_execTaskList` 的空参数签名被两条替换规则各插一次，产出 `(host, host)`（TS2300）；生成函数名保留了前导下划线（`_execTaskList`），与委托调用的 `execTaskList` 对不上。均已修正——修正后先 typecheck 再跑测试。
- 缺少 6 个模块依赖的 import（`argRequiredString`/`argOptionalString`/`readResumeHint`/`buildContinuationPrompt`/`isAgentRoleId`/`TaskUpdateFields`）与 3 个类型（`ChildTaskHandoff`/`TaskResumeHint`/`decideChildResume`），靠 typecheck 报错逐个补齐。
- `isVoid` 判定最初取了 `sigLines[closeLine]`（数组下标越界返回 undefined），导致 void 方法里写 `return`；改为 `lines[closeLine]`。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`tests/status-panel-tasks.test.ts` 9/9 ✓、任务相关 4 个测试文件 41 项 ✓。

### B10.5 — 05f 前半：skills 子簇（完成）
新增 `src/session/skills.ts`（142 行）：`SkillsHost` 接口 + 9 个函数——`getSkills`/`getDisabledSkills`/`getAllSkillNames`/`skillsDirty`/`setSkillEnabled`/`reloadSkills`/`ensureSkillToolForSession`/`refreshSkills`/`execSkill`。类内 4 个 getter 与 5 个方法全部退化为同名薄委托（getter 仍是 getter，`get skills()` 等对外形态不变）。

追加放宽的可见性（累计 14 个）：`_skills`、`_disabledSkills`、`_skillRoots`、`_skillsDirty`。仍只去掉 `private`。

工具链：新增 `.tmp/extract-methods2.mjs` —— 带字符串/注释感知的括号匹配，支持 getter/setter 签名、多行参数、`renameCalls` 同簇互调改写；写盘前断言方法结束行确实是 `}`。本批两次修工具：getter 前缀未匹配导致签名没换；空参数方法产出 `(host: X, )`。

`session.ts` 6377 → 6346 行。验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`tests/skills-workflows.test.ts` ✓。

余下 05f 的 MCP 半边（`mcpManager`/`ensureMcpReady`/`_ensureMcp`/`_snapshotMcpAvailability`/`_queueToolAvailabilityNotice`/`reloadMcp`/`reconnectMcpServer`/3 个 `*FromCommand`/`_execReload`/`reloadConfigurationFromCommand`，约 280 行）依赖 `_mcpManager`、`_mcpConnected`、`_conversationStarted`、`_deliverMessage`、`_withTurnLock`、`onMcpStatus`、`_rebuildSystemPrompt` 等成员，下一步单独做并先列放宽清单。

### B10.6 — 05f 完成：MCP 半边
新增 `src/session/mcp.ts`（281 行）：`McpHost` + 10 个函数——`getMcpManager`/`ensureMcpReady`/`ensureMcp`/`snapshotMcpAvailability`/`queueToolAvailabilityNotice`/`reloadMcp`/`reconnectMcpServer`/`reloadMcpFromCommand`/`reconnectMcpServerFromCommand`/`ensureMcpReadyFromCommand`；`McpAvailabilitySnapshot`/`ToolAvailabilityNotice` 两个接口一并搬走（原本就是这套逻辑的私有类型）。

**留在 Session 的编排入口**：`_execReload`（协调 skills 重扫 + 重建 prompt + MCP 重载 + 汇总通知）与 `reloadConfigurationFromCommand`（加轮次锁）。它们跨 skills/MCP 两个新模块，放哪个模块都会制造反向依赖。

追加放宽（累计 18 个）：`_mcpManager`、`_mcpConnected`、`_mcpReadyPromise`、`_toolExecutors`、`_conversationStarted`、`_projectRoot`、`_deliverMessage`、`_withTurnLock`、`_sortedUnique`、`_diffNames`、`_ensureMcp`、`_snapshotMcpAvailability`、`_queueToolAvailabilityNotice`。`onMcpStatus` 与 `agentTemplates` 本来就是公开成员。

**本批最重要的发现（已写入 T-B10-05 硬约束）**：`tests/session-tool-availability-notice.test.ts` 用 `Object.create(Session.prototype)` 造对象并覆盖实例方法（`session._ensureMcp = vi.fn()`）。首版抽取把同簇调用改成直接调自由函数，绕过了虚分派，真实 `_ensureMcp` 被跑起来并因 `agentTemplates` 缺失抛 `TypeError`。修正为：**原代码的 `this.X(` 一律改成 `host.X(`**，自由函数只作为委托入口。修复后该测试 4/4 通过。

其它失误：
- 动态 `import("./clients/mcp/manager.js")` 随文件下沉需要改成 `../clients/...`，抽取器只处理静态 import 与 `this.` 改写，靠 typecheck 发现。
- 把 MCP 函数误塞进 skills 的 import 块，typecheck 报 10 处 TS2305；已拆成两条 import。
- `_execReload` 仍用 `_diffNames`/`_sortedUnique`（留在 Session），未受影响。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`tests/session-tool-availability-notice.test.ts` 4/4 ✓、`tests/commands-mcp.test.ts` 2/2 ✓、`tests/p7-mcp-security.test.ts` 5/5 ✓。

### B10.7 — 05g 完成：模型/偏好写入
新增 `src/session/model-settings.ts`（145 行）：`ModelSettingsHost` + 7 个函数——`switchModel`/`reloadCurrentModelConfig`/`applyGlobalPreferences`/`applySettings`/`getGlobalPreferences`/`getSubagentSettings`/`setSubagentSettings`。

**与计划的一处偏离（有意）**：`get/set thinkingLevel`、`get/set accentColor`、`currentModelName`、`currentModelConfigName` 这些纯字段读写器**没有搬**。它们是类的状态面本身，搬出去只会多一层 hop，不减少任何复杂度（"按职责边界而非行数"）。

追加放宽（累计 27 个）：`_persistedModelSelection`、`_preferredThinkingLevel`、`_preferredAccentColor`、`_thinkingLevel`、`_permissionAdvisor`、`_contextManager`、`_buildPersistedModelSelection`、`_rebuildSystemPrompt`、`_ensureSessionStorageReady`。

内部调用继续走虚分派：`host.reloadSkills()`、`host._rebuildSystemPrompt()`、`host._ensureSessionStorageReady()`、`host._buildPersistedModelSelection(...)`、`host.currentModelConfigName`。

`session.ts` 6187 → 6136 行。验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`tests/settings.test.ts` + `tests/subagent-resume-contract.test.ts` ✓。

### B10.8 — 05h 完成（保守版）：恢复编排
新增 `src/session/restore.ts`（213 行）：`RestoreHost` + `PreparedSessionRestore` + 4 个函数——`prepareRestoreFromLog`（在 structuredClone 上解析）、`commitPreparedRestore`（重置瞬态 → 应用状态 → 提交子会话 → 恢复 inbox）、`restoreFromLog`、`getLogForPersistence`（meta + entries）。

**有意保留在 Session 的两处**：
- `_applyRestoredState`：整个类唯一的状态写入点，一次写约 28 个字段。把它搬走意味着这些字段必须以 `RestoredSessionState` 的形式在模块与类之间往返，任何漏写都是静默状态漂移；紧邻字段声明反而更难写错。
- `resetForNewSession` / `setStore`：生命周期入口（打断轮次、清空瞬态、重绑存储），不是"恢复"职责。

追加放宽 21 个成员（累计 48 个）：`_inbox`、`_createdAt`、`_initialModel`、`_title`、`_promptCacheKey`、`_turnCount`、`_compactCount`、`_currentTurnSignal`、`_currentTurnAbortController`、`_turnInFlight`、`_childSessions`、`_archivedChildren`、`_subAgentCounter`(get/set)、`_describeInitialModel`、`_generateSummary`、`_resetHookContextForNewSession`、`_bumpLogRevision`、`_notifyLogListeners`、`_entriesHaveRealUserMessage`、`_applyRestoredState`。内部调用全部走 `host.X(...)`。

本批失误与修复：
- 抽取器把 `resolvePersistedModelSelection(this, …)` 里的**裸 `this`**（作为值传入，不是 `this.` 成员访问）漏改了，模块里出现隐式 any 的 `this`；已改为 `host`。
- `PreparedSessionRestore` 接口搬到模块后，session.ts 的本地定义变成重复声明（TS2440），已删除本地版本并改为类型导入。
- `_resetTransientState` 本来就是公开方法，widen 清单里多余一项，脚本因此中断且未写盘（先 `includes` 断言再写，避免了部分写入）。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`session-resume`/`session-resume-equivalence`/`log-persistence`/`session-archive-lifecycle` 共 30 项 ✓。

### B10.9 — 05i 完成：inbox 投递与唤醒
新增 `src/session/inbox.ts`（384 行）：`InboxHost` + 13 个函数——`deliverInboxMessage`/`deliverMessage`/`getQueuedUserInputs`/`maxLiveInputIndex`/`restoreQueuedUserInput`/`scheduleAutoResume`/`autoResumeFromIdle`/`hasUnprocessedUserMessage`/`hasInboxMessages`/`hasWakingInboxMessages`/`clearCompletedTasksBeforeUserInput`/`beginActiveInput`/`drainInboxAsEntries`。

追加放宽 22 个成员（累计 70）：`_agentState`、`_compactInProgress`、`_pendingTurnState`、`_autoResumeScheduled`、`_activeAsk`、`_shellManager`、`_recordTurnFailure`、`_turnInner`、`_recordInputReceived`、`_allocateContextId`、`_nextLogId`、`_appendEntry`、`_touchLog`、`_appendDeliveredUserMessage`、`_ensureTaskStore`、`_notifyTaskListeners`，以及被搬方法的同类委托（`_getQueuedUserInputs` 等 11 个）。内部调用一律 `host.X(...)`。

工具链修复（重要）：抽取器原来用"参数右括号所在行的最后一个 `{`"定位方法体，遇到 `Array<{ … }>` 这类**返回类型自带花括号**的方法会切错（`_getQueuedUserInputs` 报"结束位置异常"）。改为从参数右括号后逐个尝试 `{`，只接受"匹配到的 `}` 恰好是缩进 2 格的方法结束行"的候选；同时委托改成自己在签名末尾补 `{`。

本批失误与修复：
- `_beginActiveInput` 的调用参数是我按名字猜的（`inputId`），实际签名是 `(inputKind, display, content)`，typecheck 报 `inputId` 未定义后修正；host 接口里的同名片段也一并改正。
- host 接口里 `_appendDeliveredUserMessage`/`_recordInputReceived` 的签名先写错（参数个数/顺序），靠 typecheck 逐个比对修正。
- 两次"逐个放宽"后 typecheck 又依次报 `_ensureTaskStore`、`_notifyTaskListeners` 仍为 private —— 因为被搬方法的**私有委托**也需要放宽才能在 host 接口里声明。

`session.ts` 6026 → 5899 行。验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`tests/session-queued-input.test.ts` 6/6 ✓。

### B10.10 — 05j 完成：轮次簿记与中断提示
新增 `src/session/round-tracking.ts`（273 行）：`RoundTrackingHost` + 14 个函数——`beginWorkIfNeeded`/`finishCurrentWork`/`maybeRunIdleGc`/`appendInterruptionSystemMessage`/`recordInputReceived`/`appendDeliveredUserMessage`/`computeNextRoundIndex`/`findRoundContextId`/`resolveOutputRoundContextId`/`retagRoundEntries`/`activeWindowStartIdx`/`findToolCallEntry`/`toolCallAnchor`/`findToolCallContextId`。

**有意留在 Session 的"日志门面"**：`_appendEntry`/`_touchLog`/`_bumpLogRevision`/`_notifyLogListeners`/`_nextLogId`/`_logSurgeryView`。它们每个只有 1–2 行、直接转发给 `_logStore`，是类自身最常用的基础设施；搬出去只会变成"委托→自由函数→`host._logStore`"的两跳空转。`_logSurgeryView` 还会以 getter/setter 出借 7 个字段，属于既有契约。

追加放宽 6 个成员（累计 76）：`_lastIdleGcAt`、`_lastTurnEndStatus`、`_logSurgeryView`、`_logStore`、`_maybeRunIdleGc`、`_computeNextRoundIndex`、`_findToolCallEntry`、`_findRoundContextId`、`_activeWindowStartIdx`、`_resolveOutputRoundContextId`（其中若干是"被搬方法的委托"）。

本批失误与修复：
- `_computeNextRoundIndex(turnIndex = this._turnCount)` 的**默认参数**里带 `this`，抽取器只改方法体不改签名，生成出 `= this._turnCount`；手工改为 `= host._turnCount`（默认参数可引用前面的参数）。
- host 接口里 `_lastTurnEndStatus` 先写成 `string | undefined`，实际是 `"completed" | "interrupted" | "error" | null`，typecheck 报联合类型不兼容后对齐。
- `_recordInputReceived` 依赖的 `createInputReceived` 只存在于 session.ts 的工厂导入，模块侧补了同名导入。

`session.ts` 5899 → 5804 行。验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`session-log-index` + `session-visibility` + `session-queued-input` 共 32 项 ✓。

### B10.11 — 05k/05l/05m 完成：ask、压缩、工具排空
- `src/session/ask-flow.ts`（500 行，16 个方法）：`subscribeAsk`/`notifyAskChanged`/`denyPendingAsk`/`denyAndInterruptPendingAsk`/`getPendingAsk`/`hasPendingTurnToResume`/`emitAskRequestedProgress`/`emitAskResolvedProgress`/`execAsk`/`resolveAgentQuestionAsk`/`resolveOwnAgentQuestionAsk`/`resolveApprovalAsk`/`resolveOwnApprovalAsk`/`withAskRouting`/`findChildWithPendingAsk`/`resumeChildPendingTurn`。
- `src/session/compact-flow.ts`（407 行，7 个方法）：`getManualCompactBlocker`/`runManualCompact`/`runManualCompactBody`/`buildCompactCheck`/`runCompactPhase`/`doAutoCompact`/`discardCompactAttemptEntries`。
- `src/session/tool-drain.ts`（432 行，6 个方法 + 箭头属性 `_beforeToolExecute`）：`findEarliestPendingToolCallLogIndex`/`finalizeDrainInterruptedWork`/`drainPendingToolCalls`/`findNextPendingToolCall`/`updateToolCallExecState`/`isInsideArtifactsDir`/`beforeToolExecute`。
- `session.ts` 5804 → **5005 行**（累计 7105 → 5005，-2100）。

工具链改进（本轮三次触发，已固化）：
- 参数右括号不再用"全局深度归零"判断，而是从方法名后的第一个 `(` 开始配对（`_buildCompactCheck(): ((` 这类返回类型自带括号的方法不再切错）。
- 方法体 `{` 改为候选扫描：只接受"匹配 `}` 正好是缩进 2 格结束行"的候选（`Array<{…}>`、`((…) => {…})` 之类不再误切）。
- 名后支持泛型 `<T>`（`_withAskRouting<T>`）。
- 箭头属性方法（`private _beforeToolExecute = async (…) => {…}`）不在声明块正则覆盖范围，单独用一次性脚本转换，类内保留薄箭头以维持"实例属性、可被覆盖"的语义。

本批失误与修复：箭头属性转换时漏掉了 `ctx` 参数；`_installCurrentTurnSignal`/`_restoreCurrentTurnSignal` 的返回/入参结构先写错；`_findNextPendingToolCall` 返回值远不止 `{index, entry}`（含 toolCallId/toolName/toolArgs/turnIndex/roundIndex/agentName），按实际签名修正；`_toolExecutors` 的宿主类型要用 `ToolExecutor` 而不是手写函数类型。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓；ask 相关 15 项、compact 相关 19 项、tool-loop/arg-repair/stale-retry 42 项全绿。

### B10.12 — 05n/05o 完成：B10 全簇收口
- `src/session/activation.ts`（869 行，2 个方法）：`runTurnActivationLoop`（312 行）+ `runActivation`（454 行）。这两条是全项目耦合最深的循环，抽出后 `session.ts` 不再持有任何 provider 调用/工具排空的编排逻辑。
- `src/session/turn-control.ts`（350 行，9 个方法）：`withTurnLock`/`waitForTurnComplete`/`requestTurnInterrupt`/`handleInterruption`/`collectInterruptHints`/`recordTurnFailure`/`isTurnAbortError`/`recordTurnErrorEntry`/`closeSession`。**`_turnErrorEntryWritten` 与 `_lifecycleEndedEmitted` 两个幂等标志与锁仍在同一模块**（锁每次进临界区清零它们），`_turnInFlight` 的同步抢占逻辑逐字未改。
- `session.ts` 5005 → **4113 行**。

### B10 总收口
`src/session.ts` **7105 → 4113 行（-42%）**，12 簇全部落地（B13/T-L-01 收尾后 4100 行，T-L-03 后 4092 行，收尾清理 3 后 4089 行）：

| 模块 | 行 | 职责 |
| --- | --- | --- |
| `turn-types.ts` | 35 | turn 生命周期事件、内联图片输入、排空结果类型 |
| `no-reply-stream.ts` | 60 | `<NO_REPLY>` 流抑制 |
| `skills.ts` | 142 | 技能启停/重扫/`skill` 工具 |
| `model-settings.ts` | 145 | 模型切换与全局/subagent 偏好 |
| `usage-accounting.ts` | 171 | token 聚合与 prompt 分段估算 |
| `attachments.ts` | 183 | 图片落盘/回读、`@file` 附件 |
| `restore.ts` | 213 | 恢复解析/提交与持久化快照 |
| `round-tracking.ts` | 273 | 轮次簿记、round contextId、中断提示 |
| `mcp.ts` | 281 | MCP 生命周期与可用性通知 |
| `turn-control.ts` | 350 | 轮次锁、中断、错误/生命周期幂等、close |
| `inbox.ts` | 384 | 投递、排队输入、auto-resume、排空 |
| `compact-flow.ts` | 407 | 手动/自动压缩 |
| `tool-drain.ts` | 432 | 工具排空与执行前闸门 |
| `ask-flow.ts` | 500 | ask 订阅/执行/决议/子会话路由 |
| `task-list.ts` | 564 | 任务清单存储 + `task_*` 执行器 + 对账 |
| `activation.ts` | 869 | 单次激活与激活循环 |

**留在 Session 的**：字段与构造器、日志门面（6 个一行转发）、`_applyRestoredState`（唯一状态写入点）、纯字段读写器、`resetForNewSession`/`setStore`、`_execReload`/`reloadConfigurationFromCommand`（跨 skills/MCP 的编排入口）。

**放宽清单（累计约 90 个成员）**：全部只是去掉 `private`，不改类型/初值/读写时机；内部调用一律 `host.X(...)` 走虚分派，保证实例覆盖与 `Object.create(Session.prototype)` 式测试桩仍然生效。

**验证**：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、`rm -rf dist && npm run build` ✓、`find-cycles dist/src` → **286 模块 0 运行时循环**、`dist/src/session.js` 144KB。

### B9.1 — T-B9-01 完成：tool-loop 四拆
`src/agents/tool-loop.ts`（1809 行）→ `src/agents/tool-loop/{types,display,streaming-arguments,run}.ts`（236 / 144 / 430 / 1069）。`run.ts` 仍偏大是刻意的：`asyncRunToolLoop` 本身是 914 行单一函数，拆其内部属行为改动。原文已 `git rm`，不留 shim。

- 引用更新 11 处，按符号指向 `tool-loop/types.js`（全部类型 + `ToolExecutor` 二度导出）或 `tool-loop/run.js`（`asyncRunToolLoop`）。
- 文件内 import 与声明交错（原文件在常量之后还有一段 import），partition 会把这段卷进相邻声明块；已按符号归位并用 `prune` 清掉各文件的冗余说明符。
- 类型适配：`host._activeAsk` 在"赋值 → 调用 → 再读"间被 TS 重置收窄（原 `this._activeAsk` 不会），6 处读点加非空断言 `!`，纯类型注解。

验证：typecheck ✓、typecheck:tui ✓、check-resolve ✓（同 4 条已知假阳性）、`npm test` 127/1182/3 ✓、tool-loop/ask/arg-repair/turn-retry 共 50 项 ✓。

**B9 剩余**：T-B9-05 `tools/web-search.ts`(809) 按引擎拆；T-B9-06 `src/browser/`→`src/browser-preview/`（消除与 `platform/browser/` 的名字冲突）；T-B9-07 `session/child-session-manager.ts`(1554)→`session/children/`；T-B9-08 `cli.ts`(1051) 拆分（入口保持深度 1）；T-B9-09 `models/picker-tree.ts`(632) 两棵树；T-B9-10 `session/rewind-engine.ts`(878)；T-B9-11 `ui/` 与 `browser/` 的剩余归位。

### B9.2 — picker-tree 拆分 + child-session-manager 拆分
**`src/models/picker-tree.ts`（632）→ `src/models/picker/{types,labels,model-tree,credential-tree}.ts`**（80 / 113 / 347 / 159 行）：节点类型契约、标签渲染、模型选择树、凭据选择树。正文代码行与 `HEAD` 多重集全等（541 行），2 处补 `export`；消费方 4 处按符号重指。

**`src/session/child-session-manager.ts`（1554）→ `src/session/children/{formatting,types,manager}.ts`**（82 / 156 / 1417 行）：展示辅助、句柄/依赖类型、管理器类本体。正文 1220 行多重集全等，1 处补 `export`；7 处消费方重指。类本体 1401 行未做方法级拆分（单类=一个职责，与 B8-02 同一判断）。

工具链修复：`fix-depth.mjs` 原来无条件给所有 `from "../` 加前缀，重跑会把已正确的文件再加深一级（本轮把 `session/background-shell/*` 打成 `../../../`，typecheck 抓出 8 处 TS2307 后逐行还原）。已改为幂等版：只处理"当前解析不到、补一层后能解析到"的 spec，且同时覆盖 `./x` → `../x`（跨出子目录的兄弟引用）。重跑验证：`src/session` 与 `src/commands` 均 0 改动。

验证：typecheck ✓、`npm test` 127/1182/3 ✓。

### B9.3 — rewind-engine 与 cli 拆分（B9 收口）
**`src/session/rewind-engine.ts`（878）→ `src/session/rewind/{types,engine,paths}.ts`**（79 / 839 / 57）：journal/变更类型、引擎本体（790 行单类）、`pathsOverlap`。正文 710 行多重集全等，4 处补 `export`。

**`src/cli.ts`（1051）→ `src/cli.ts`（428）+ `src/cli/session-picker.ts`（655）**：入口与 `resolveOpenTuiEntry` 留在深度 1（C2/C9 红线），启动期会话选择 UI 独立成模块。

本批两个真实的"差点静默坏掉"：
1. **入口守卫被 partition 丢掉**：`const entryPath = …; if (entryPath === modulePath) main()…` 是顶层语句而非声明，按声明块切分时不属于任何块，新 `cli.ts` 里消失了。typecheck 与单测都发现不了（文件仍合法），是"二进制构建成功但什么都不做"级别的故障。已从原文尾部整段恢复；随后 `node dist/src/cli.js --version` 实测输出 `0.4.0`。
2. **shebang 位置**：partition 把 `#!/usr/bin/env node` 复制进 `session-picker.ts`，改写头注释时它落到了第 2 行，esbuild 报 `Syntax error "!"`；已删除（非入口文件不需要 shebang）。

验证：typecheck ✓、`npm test` 127/1182/3 ✓、`tests/packaged-paths.test.ts` 31 项 ✓（含 C1/C2 路径断言）、`npm run build` ✓、`node dist/src/cli.js --version` → `0.4.0`。

**B9 收口**：tool-loop 四拆、prompts 合并、classify 三拆、web-search 三拆、browser-preview 改名、picker-tree 四拆、child-session-manager 三拆、rewind 三拆、cli 二拆全部完成。剩余仅 B11（tests 镜像化/命名）与 B12（最终验收 + exe 冒烟）。

### B12 — 最终验收（完成）
- **T-B12-01 全绿**：typecheck ✓、typecheck:tui ✓、`npm test` 127/1182/3 ✓、`npm run test:node` pass 2/fail 0 ✓。
- **T-B12-02 产物冒烟 ✓**：`npm run build` + `node scripts/build-sea-exe.mjs` → `release/SwarmFlow-win32-x64/SwarmFlow.exe`（100.0 MB）；`SwarmFlow.exe --version` → `0.4.0`，`--help` 正常；`runtime/prompts/*`、`runtime/src/tools/intools/{jq,fd,ripgrep,curl}`、`runtime/assets/model-registry/providers.json` 全部在位；`find-cycles dist/src` → 310 模块 0 运行时循环。
- **T-B12-03**：§5 验收清单逐项打勾；§4 待确认清单更新（Q2/Q12 已解决，Q7 指针已改）。
- **T-B12-04 合并 ✓**：全部改动提交为 `31e6424 代码库整理中`（383 文件），`refactor/structure-cleanup` fast-forward 合并进 `main`；合并前全量测试 127/1182/3 通过；未推送远端。

### B13 — 收尾清理（完成）
- **参数校验单一化**：`arg-helpers.ts`（返回 `ToolResult`）与 `arg-validation.ts`（抛 `ToolArgValidationError`）合并为 `src/tools/arg-validation.ts` 单一模块；核心校验器只保留一份判定逻辑，底部 `arg*` 适配器复用同一核心并转换错误通道。删除 `arg-helpers.ts` 与 `session.ts` 的 `_argOptionalString`/`_argRequiredString`/`_argRequiredStringArray` 三个薄委托；`background-shell/manager.ts`、`session/task-list.ts` 与测试改指新模块。
  - 先写 `tests/tools/arg-validation-contract.test.ts`（57 项，覆盖两套实现与 Session 委托的全部可观察行为），对合并前代码跑绿；合并后原断言重跑仍 57/57 绿。
- **删除死文件与透传层**：删除零引用纯注释的 `src/swarm/gui-integration.ts`；确认 `provider-specs.ts` 无环后删除 `src/providers/registry-effective.ts`，5 处消费者直连 `FACTORY_PROVIDER_SPECS`（`defaults.ts`、`presentation.ts`、`presets.ts`、`registry.ts`、`managed-provider-credentials.ts`）。
- **`ToolExecutor` 单导出**：删除 `agents/tool-loop/types.ts` 的 re-export；`agent.ts`、`session.ts`、`activation.ts`、`mcp.ts`、`tool-drain.ts`、`tests/helpers/session-harness.ts` 改指 `tools/executor-types.ts`。
- **注释腐化清理**：修正 `src` 内指向已删除/已改名模块的注释（`basic.ts`、`tool-loop.ts`、`session-persistence.ts`、`session-log.ts`、`session-tree-types.ts`、`child-session-manager.ts`、`network-retry.ts`、`task-reconcile.ts` 等），修正 `session.ts` 两处分节标题与 `usage-accounting.ts` 两处乱码注释。
- **p4-p6 拆分**：`tests/session/session-flows.test.ts` → `tests/session/shell-governance.test.ts`（4 项）+ `tests/session/output-round-context.test.ts`（1 项），共享 `tests/session/minimal-session.ts`；原文件删除。
- 验证：`typecheck` ✓、`typecheck:tui` ✓、`npm test` 129/1239/3 ✓、`test:node` pass 2/fail 0 ✓、clean `build` ✓、SEA exe 重建 + `--version`/`--help`/assets 冒烟 ✓。

### T-L-01 — `SessionLike`（完成）
- **新增** `src/commands/session-like.ts`：手写 `SessionLike` 接口（41 个成员），成员清单来自对 `src/commands/` 全部 `session?.X` 访问的扫描结果去重（`grep` 出的 43 个名字中 `js`/`ts` 来自 `session.js`/`session.ts` 字符串，已剔除），覆盖 rewind/mcp/skills/model/permission/lifecycle/subagent 各簇；另附 `RewindTargetTurn`、`McpStatusEntry` 两个同形条目类型。（T-L-02 起该文件移到 `src/session/contract.ts`；两个同形条目类型分别由 T-L-03 与"重复类型收敛"那条消掉。）
- **替换**：`CommandContext.session`（`types.ts:25`）与 `CommandOptionsContext.session`（`types.ts:147`）由 `any` 改为 `SessionLike`；命令层内两处 `session: any` 形参（`model/persistence.ts:19` 的 `currentSessionModelDisplayName`、`model/selection-flow.ts:20` 的 `resolveModelSelection` 包装）同步改指。
- **双向编译保护**：`src/session.ts` 改为 `export class Session implements SessionLike`（纯类型边，`dist` 里 `session-like.js` 是 `export {}`，无运行时代码、0 新循环）。Session 改名/删成员 → 在 `session.ts` 报错；命令层新调用未声明成员 → 在命令文件报错。此前是静默降级。
- **顺带合并第三份平行声明**：`src/ui/contracts.ts` 的 `Session` 接口原本手工重复声明了 24 个与命令层重叠的成员（且已失真：`resetForNewSession?(): void` 与真实的 `Promise<void>` 不符、`permissionMode?: string`、`config?: {…}` 等）。改为 `export interface Session extends SessionLike` 并删除这些重复声明，TUI 侧只保留渲染专用的只读快照/订阅成员。这一步暴露了 3 处真实类型缺陷（TUI 构造 `CommandContext` 时缺 `setTitle`/`setPersistedModelSelection`/`getSubagentSettings`/`setSubagentSettings` 等成员声明），修完后 `typecheck:tui` 0 报错。
- **两处必要的类型收窄（行为不变）**：
  - `commands/ui/permission.ts`：原 `PERMISSION_MODES.includes(mode as any)` 改为同判定的类型谓词 `isPermissionMode(mode)`，赋值 `session.permissionMode` 不再需要 `any`。
  - `commands/session/lifecycle.ts`：`applySessionRestore` 的参数仍是 `Session`（它要用 8 个恢复/rewind/对账深层成员），fork 调用点改为 `session as Session` 并注明原因——这是命令层唯一保留的显式下传点。
- **未覆盖（后续项 T-L-02）**：9 处 `session: any` 仍在 `models/{picker/labels,picker/types,presentation,restore,selection}` 与 `session/role-model-resolver.ts`。它们由命令层传入，因此编译保护止于这些边界；把这些面并入 `SessionLike` 需要先把该接口从 `commands/` 移到中立模块（否则 `models/` 反向依赖 `commands/`），属独立决策。
- **重复类型收敛（T-L-01 后续核对）**：`session-like.ts` 里的 `McpStatusEntry` 是对 `clients/mcp/manager.ts` 已导出的 `McpServerStatus` 的重复声明，且把 `state` 从 4 字面量联合抄成了 `string`。已删除该副本，三处 `onMcpStatus` 声明（`session.ts:499`、`session/mcp.ts:39` 的内联 `Array<{…state: string…}>` 与 `SessionLike`）统一改用 `McpServerStatus`；三个文件原本就 type-import 自该模块，**0 新增依赖边**。`Pick<Session, 41 keys>` 经探针实测可编译且与 `SessionLike` 互相可赋值，故 `commands/` 不依赖 `session.ts` 并非硬约束（真实取舍见 §7 T-L-03）。
- 验证：`typecheck` ✓、`typecheck:tui` ✓、`npm test` 129/1239/3 ✓（与 B13 后完全一致）、`test:node` pass 2/fail 0 ✓、clean `build` ✓（299 模块、0 运行时循环）。

### T-L-03 — 取舍复核（完成）
- 三项落地细节见 §7 T-L-03。净效果：`session.ts` 4100 → **4092 行**（`getRewindTargets()` 的 8 行内联返回类型改为命名类型；再经「收尾清理 3」删两个死 const → 4089 行），`RewindTargetTurn` 全仓只剩 `session/rewind/types.ts` 一份声明，TUI 消费侧不再用 `any[]` 屏蔽 `McpServerState`。
- **本仓行尾约定（踩过的坑，后续批次必守）**：`src/` 下所有 `.ts` 均为 CRLF。用 Write 类工具新建的文件默认 LF，`git` 在 `core.autocrlf` 下会把整文件标为改动，看起来像"重写了整个文件"。新建/脚本改写源码后要归一回 CRLF 再看 `git diff --numstat` 是否只剩真实改动（本次 `session-like.ts` 与本文档各修一次）。

### T-L-02 — 契约中立化（完成）
- **移动**：`src/commands/session-like.ts` → `src/session/contract.ts`（内容与成员清单不变，仅路径与头部注释）。住在 `session/` 是因为 `models/` 与会话内部簇都要引用它，放命令层会让下层反向依赖上层目录。5 个引用方改指新路径：`commands/types.ts`、`commands/model/{persistence,selection-flow}.ts`、`session.ts`、`ui/contracts.ts`。
- **接口扩 2 个成员**：补 `readonly currentModelName` / `readonly currentModelConfigName`（`session.ts:2440,2445` 的公开 getter），`SessionLike` 达 43 个成员。顺带暴露并修掉 `ui/contracts.ts:153` 的 `currentModelConfigName?: string`（真实类型是 `string`，`TS2430` 直接报出），删除后由 `extends SessionLike` 继承。
- **9 处 `session: any` 收编**：
  - `models/selection.ts:172,287` → `ModelResolutionSession`（`Pick<SessionLike, "config" | "primaryAgent">`）。用最小面而不是 `SessionLike`，因为 `session/restore.ts:95` 传的是 `RestoreHost`（只有 2 个共同成员），强推 `SessionLike` 会变成一处 `as unknown as`。
  - `models/restore.ts:5`、`models/presentation.ts:207`、`session/role-model-resolver.ts:29,42` → `SessionLike`（调用方全是真实 Session / TuiSession / `ctx.session`）。
  - `models/picker/types.ts:38,51` → `ModelPickerSessionView`。必须独立声明而不是 `Pick<SessionLike, …>`：init 向导在没有 Session 时自造 `{ config, currentModelConfigName, primaryAgent: { modelConfig } }` 喂选择器树（`lifecycle/init-service.ts:294`），那里的 `primaryAgent` 不是 `Agent` 实例。顺带把 `createPickerSession(): any` 与该函数内 `as unknown as Record<string, unknown>` 的双重强制转换去掉。
  - `models/picker/labels.ts:50` 的 `session` **实参完全未被使用**（判定只依赖后面 6 个字符串参数，`model-tree.ts:106` 仍传 session）。T-L-02 当时按"结构重构不删看似未使用的代码"的红线只把 `any` 收到 `unknown`；用户批准后已于 2026-10-23 删除，见下面的「收尾清理 2」。
- **保护面确认（负向探针）**：在 `models/presentation.ts` 里临时写 `session._store` 与 `session.primaryAgent.modelConfigXYZ`，`typecheck` 报 `TS2339: Property '_store' does not exist on type 'SessionLike'` 与 `TS2551 … Did you mean 'modelConfig'?`，探针已还原（该文件 diff 回到 2/1 行）。此前这两处在 `any` 下静默通过。
- 验证：`typecheck` 0、`typecheck:tui` 0、`npm test` 129/1239/3、`test:node` pass 2/fail 0、clean `build` 299 模块 / 0 运行时循环，`dist/src/session/contract.js` 为 `export {}`（纯类型边）；`src/` 仍 301 个 .ts（净零：删一个、加一个）。

### 收尾清理 2 — 冗余形参与 release 死重（完成，2026-10-23）
- **删冗余形参**：`models/picker/labels.ts` 的 `isCurrentSelection(session, …)` 首参从未被函数体读取，已删除形参并同步唯一调用点 `models/picker/model-tree.ts:106`（全仓含 `tests/` 无其他调用者）。
- **打包死重清理（C6 相关）**：`scripts/build-sea-exe.mjs` 原先把 `external/opentui` **整目录**拷进 `runtime/`。实测该目录在发布布局下无人读取：`buildOpenTuiEntry()` 用 esbuild 把 `main.tsx` 连同全部本地 import（含 `forked/**` 与 tree-sitter 的 `.wasm`/`.scm`）打成单文件 `runtime/external/opentui/main.js`，静态资源按 `assets/[name]-[hash]` 另落盘；`forked/core/platform/runtime.ts:41` 的 `resolveBundledFilePath()` 在打包后 `import.meta.url` 已是 `main.js`，其 `./assets/...` 兜底路径不会命中源码树，只会走 hash 资源。因此把 `external/opentui` 从拷贝清单移除。
- **量化结果**：`runtime/external/opentui` 由 211 个文件 / 15.88 MB 降到 18 个文件 / 7.94 MB（forked 7.46 MB + TUI 源码 0.48 MB 归零），`main.js` 1.94 MB 与 17 个 hash 资源保留。附带好处：`src/cli.ts:179` 的 `resolveOpenTuiEntry()` 不再有 `main.tsx` 源码兜底可在生产布局里被误命中。
- **产物级验证**（源码测试全绿不等于产物可用，故重建 exe 实测）：`npm run build:exe` 成功（100.0 MB）；`SwarmFlow.exe --version` → `0.4.0` exit 0；`--help` exit 0；**无参启动 TUI** 15 秒内持续输出 ANSI 终端序列且无 `ERR_MODULE_NOT_FOUND`/`Cannot find module`（说明被打包的 TUI 在新布局下真的跑起来了）；`runtime/external/opentui/{main.js,assets/*}` 到位，`prompts/`、`runtime/src/tools/intools/`、`runtime/assets/model-registry/`、`runtime/dist/src/cli.js` 均存在。
- **补覆盖缺口**：删除形参后发现 `buildModelPickerTree` 的「当前模型」标记（`isCurrentSelection`）在 `tests/` 里**零直接覆盖**，遂补 `tests/models/picker-current-marker.test.ts`（7 项，走真实 `Config` + 会话视图，断言可观察的 `isCurrent` 叶节点；期望值按行为规格硬编码，不调用被测函数推导）。
  - 三条命中路径各一条：`provider:model` 稳定名、`runtime-<provider>-<model>` 运行名、无配置名时按 primary agent 正在跑的 provider+model。
  - 另四条防过度标记：名字与运行态都不匹配 → 不标记；同 provider 的兄弟模型不被连坐；**两个 provider 暴露同一 model id 时只标记运行中的那个**；多条件同时成立时全树恰好一个 `isCurrent`。
  - 变异检验（`.tmp/mutation-check-picker-marker.mjs`，逐条破坏 `isCurrentSelection` 的判定后跑该文件，跑完自动还原源码）：M1 去掉稳定名判定 → 1 红；M2 去掉 runtime 名判定 → 1 红；M3 放宽 `modelId === currentModel` → 3 红；M4 放宽 `providerId === currentProvider` → 初版**未被捕获**，据此补出跨 provider 同名模型那条，复测 → 1 红。4/4 捕获，还原后恢复绿。
- 复核：`typecheck` 0、`typecheck:tui` 0、`npm test` 130/1246/3。

### 收尾清理 3 — 死 const 与注释腐化（完成，2026-10-23）
- **删死 const**：完整性扫描发现 `session.ts` 里的 `MAX_ACTIVATIONS_PER_TURN = 30` 与 `MAX_COMPACT_PHASE_ROUNDS = 10` 各只出现在自己的声明行（全仓 0 引用）。真实使用者是同名常量的独立声明：`session/activation.ts:31`（用于 :569、:779）与 `session/compact-flow.ts:15`（用于 :238）——它们是 B10 外移簇时留下的副本，删除不影响任何行为。`session.ts` 4092 → **4089 行**。
- **修注释腐化**：6 个 provider 文件把来源模块写成不存在的 `network-retry`，实际是 `src/network/retry.ts`（`agents/tool-loop/run.ts:29` 从该模块 import `MAX_NETWORK_RETRIES`）。已统一改为 `network/retry`：`providers/{anthropic-base.ts:58,base.ts:54,copilot.ts:64,openai-chat.ts:50,openai-responses.ts:76,openrouter.ts:69}`，`grep -rn network-retry src/` 归零。
- **门禁**：`typecheck` 0、`typecheck:tui` 0、`npm test` 130 文件 / 1246 通过 / 3 跳过、`test:node` pass 2 / fail 0、clean `build` 299 模块 / 0 运行时循环。
- **产物级验证**：`npm run build:exe` 重建（100.0 MB），`--version` → `0.4.0` exit 0、`--help` exit 0、无参启动 TUI 持续输出 ANSI 且无模块解析错误，入口解析 `runtime/external/opentui/main.js`；`dist/src/session.js` 内两个死 const 各 0 次，`activation.js` 3 次、`compact-flow.js` 2 次（真实使用者仍在）。
- **扫描中判定为既有代码、未动（等授权，详见 §7 T-L-04）**：`providers/qwen.ts` 的 `QwenProvider` 生产侧零引用（仅 `tests/providers/qwen-provider.test.ts` 引用，registry 用的是 `qwen-responses.ts`）；`server/init-rpc.ts:21/29/35` 与 `server/rpc-arg-guards.ts:8/16/22` 重复的 `expectObject/expectString/optString`；`HTTP_TIMEOUT_MS` 三处各写 15s（`providers/copilot-models-cache.ts:33` 的 10s 是有意区分，不并入）；提示词工具清单与工具注册表之间缺一致性契约测试。

### 最终结构速览
- `src/` 301 个 .ts；最大文件 `session.ts` **4089 行**（起点 7105，-42%）。
- 剩余 ≥400 行文件 40 个，全部是"单类/单函数"或已判定保留的适配器：`session/children/manager.ts`(1401，单类)、`agents/tool-loop/run.ts`(1069，单函数 `asyncRunToolLoop`)、`providers/openai-responses.ts`(983)/`openai-chat.ts`(826)/`anthropic-base.ts`(789)（子类钩子是继承契约，B8 决策不拆）、`session/activation.ts`(864)、`tools/grep.ts`(841)、`session/rewind/engine.ts`(825)、`permissions/bash/parser.ts`(748)。
- `tests/` 按模块镜像为 24 个子目录（+ `helpers/`），根目录只留 `node-runtime.test.ts`（C9）与 `packaged-paths.test.ts`（全仓路径验收）。
- 运行时模块图 299 个节点、0 循环（clean build）。
- 会话能力面只有一份声明源：`src/session/contract.ts` 的 `SessionLike`（43 个成员）；`Session implements SessionLike`、`ui/contracts.Session extends SessionLike`；`commands/`、`models/`、`session/` 内部簇与 TUI 全部指向它，`src/` 内已无 `session: any`。

---

## 7. 独立立项的结构任务

这些项不属于 B1–B13 的"搬家式"范围，各自需要一次独立授权。

### T-L-01 `SessionLike` 收敛 `CommandContext.session: any`
- 状态：**完成（2026-10-22）**。执行过程与验收见 §6「T-L-01 — `SessionLike`（完成）」。
- 结果：`src/commands/types.ts` 两处 `session: any` → `SessionLike`；新增 `src/commands/session-like.ts`（T-L-02 起已移到 `src/session/contract.ts`）；`Session implements SessionLike`、`ui/contracts.Session extends SessionLike`，三份平行会话声明并为一份。

### T-L-02 `SessionLike` 移出 `commands/`，收编剩余 9 处 `session: any`
- 状态：**完成（2026-10-22）**。执行细节与验收见 §6「T-L-02 — 契约中立化（完成）」。
- 决策留档（立项时写的判断，事后核对成立）：9 处只读取 9 个成员（`config`、`primaryAgent`、`thinkingLevel`、`getGlobalPreferences`、`getSubagentSettings`、`switchModel`、`setPersistedModelSelection`、`currentModelName`、`currentModelConfigName`），其中 7 个已在接口里，只缺 2 个 getter，因此**不需要拆两层接口**；落点选了 `src/session/contract.ts`（候选中的 `src/session/like.ts` 未用）。
- 实际比预期多出的两件事：
  1. `session/restore.ts` 传的是 `RestoreHost`（只有 `config` + `primaryAgent`），所以 `models/selection.ts` 用 `Pick<SessionLike, "config" | "primaryAgent">` 而不是整个 `SessionLike`，否则要在会话里加 `as unknown as`。
  2. init 向导会造一个只有 `config` 的假会话喂选择器树，那里的 `primaryAgent` 不是 `Agent` 实例，所以 picker 上下文用独立的 `ModelPickerSessionView` 结构视图，`Pick<SessionLike, …>` 在此不可用。
- 复核：C12（`session.ts` 与 `session/` 共存）未受影响——新文件是 `session/contract.ts`，与根 `session.ts` 无同名歧义；`tests/packaged-paths.test.ts` 全绿，无路径断言需要跟进。
- ~~遗留一项待你决定~~ **已于 2026-10-23 按用户指示处置**：`src/models/picker/labels.ts:50` 的 `session` 形参（完全未被使用）已删除，唯一调用点 `models/picker/model-tree.ts:106` 同步；全仓含 `tests/` 无其他调用者（见 §6「收尾清理 2」）。

### T-L-03 `SessionLike` 自身取舍的复核
- 状态：**完成（2026-10-22，用户批准后三项全部落地）**。
- 背景：`Pick<Session, 41 keys>` 用探针实测**能编译**，且与手写 `SessionLike` 互相可赋值（探针文件当时在 `tsconfig.json` 编译图内，注入的假错误被 tsc 报出，随后已删除）。因此 `src/commands/session-like.ts` 原注释里"`commands/` 不能反过来依赖 `session.ts`（类型循环会让鸭子调用失去可检查性）"这句**不成立**，属注释腐化。
- 落地：
  1. **注释改写**：`session-like.ts:1-13` 换成真实取舍——`Pick` 只会镜像实现当前的样子（`onMcpStatus` 把 `state` 写成 `string` 这类失真会被原样继承）；手写可以声明得比实现更严，靠 `Session implements SessionLike` 强制两边收敛；`ui/contracts.Session` 必须能被"非 `Session` 实例"的渲染实现满足，不宜绑死具体类。并明写"这些是取舍而非硬约束，实测 `Pick<Session, 41 keys>` 可编译"。
  2. **`RewindTargetTurn` 归位**：声明移到 [src/session/rewind/types.ts:14](src/session/rewind/types.ts)（该模块本就是 rewind 域的类型契约）。`src/session.ts:29` 加类型 import、`:1562` 的 8 行匿名内联返回类型改为 `RewindTargetTurn[]`；`session-like.ts:26` 从该模块 import；`src/commands/session/rewind.ts:25` 删掉缺 `entryIndex`/`timestamp` 的局部子集副本，改为 `const targets = session.getRewindTargets();`（同时去掉在 `SessionLike` 下已冗余的 `?.` 与 `?? []`）。**保留** `formatRewindDetail` 的 4 字段结构性参数：纯格式化 helper 只需那 4 个字段，绑到 8 字段记录上反而放宽了它的适用面。
  3. **TUI 消费侧收口**：`external/opentui/app.tsx:739` 去掉 `(statuses: any[])` 与两处 `(s: any)`，参数由上下文推为 `McpServerStatus[]`，`s.state === "failed"` 现受 `McpServerState` 联合校验（换成不存在的状态值会报 `TS2367`）。
- 验证：`typecheck` 0、`typecheck:tui` 0、`npm test` 129/1239/3、`test:node` pass 2/fail 0、clean `build` 299 模块 / 0 运行时循环；新增的三处类型边在 `dist` 里运行时引用数为 0（`session-like.js` 仍是 `export {}`）。`app.tsx` 的改动经 esbuild（`tsx` 的转译后端）转译后与 `HEAD` 版本**字节相同**（EOL 归一后均 112005 字节），故未重建 exe。

### T-L-04 完整性扫描产出的既有代码项（**待授权**，2026-10-23）
这些项在结构重构中被扫描发现，但都不是本次重构造出的（基线 `857db46` 就已存在或属既有设计），按"结构重构不动既有语义"的红线全部原地保留，等逐项点头：
1. **`src/providers/qwen.ts` 生产侧零引用**：`QwenProvider` 在 `src/`、`external/`、`gui/` 均无引用方——`providers/registry.ts:31` 映射的是 `qwen-responses.ts` 的 `QwenResponsesProvider`，该文件头注释自陈"已弃用的回滚路径"。唯一引用者是 `tests/providers/qwen-provider.test.ts`（10 处，含 2 个 describe），所以删除要连测试文件一起走，不能只看"零引用"就当死文件删。基线 `857db46` 时已如此。
2. **`src/server/init-rpc.ts:21/29/35` 重复的参数校验**：本地 `expectObject`/`expectString`/`optString` 与 `src/server/rpc-arg-guards.ts:8/16/22` 的导出同名同义。合并属"多源收敛"，需先确认两处错误文案是否被测试或前端依赖。
3. **`HTTP_TIMEOUT_MS` 三处各写 15s**：`auth/github-copilot-oauth.ts:61`、`auth/github-copilot-token-manager.ts:32`、`auth/openai/endpoints.ts:41`（只有最后一处是 export，前两处各文件私有）。可收成单一常量；但 `providers/copilot-models-cache.ts:33` 的 10s 是有意区分，不并入。
4. **提示词 ↔ 工具注册表缺一致性契约测试**：`prompts/` 与内嵌提示词里声明的工具名没有测试保证它们与注册表同步（删工具时的清单遗漏只能靠人肉）。这是覆盖缺口，不是缺陷。
