# SwarmFlow

终端里的多智能体编程助手，主打性价比：强模型当大脑负责规划与把关，执行类工作派给便宜的弱模型，按角色独立配置模型与思考深度。多智能体编排、高质量工程规则与自由的端点配置都围绕这一点。

## 与主流 CLI 的差异

截至 2026-10，Claude Code 已有子代理、自动压缩与 checkpoint 回退，OpenCode 支持 75+ Provider，Codex CLI 锁定 OpenAI 端点；Agent-Manager、Pane 这类编排器管理的是多个互相独立的会话。SwarmFlow 走的是另一条路——用模型分工把成本压下来，用工程规则把质量锁住：

- **按角色配模型，成本自己定**：Queen 与 Reviewer 这类需要判断力的角色用强模型，Scout/Worker/Merger 的执行类工作派给便宜的弱模型；每个角色独立设置模型与思考深度（`/agents`），未设置的角色自动回落到 Queen 当前模型。大头 token 花在便宜模型上，强模型只花在决策与把关上。
- **工程规则内置，不靠模型自觉**：六角色互锁（独立审查、安全检查、结构化 JSON 交接）；压缩失败保留原历史重试、审批挂起在压缩期被降级、回合级 `/rewind` 连文件副作用一起回退。
- **进程内多智能体编排**：Queen 把任务拆成 DAG，同一运行时内调度并行子代理，Merger 合并结果——不是拉起多个独立 CLI 会话，也没有外部编排器。
- **端点与账号自由**：Anthropic / OpenAI / Gemini 三类端点形态，另有 DeepSeek、Kimi、GLM、Qwen、MiniMax、小米、OpenRouter、GitHub Copilot 适配；`base_url` 官方端点或中转站任配；OpenAI（ChatGPT 账号）与 GitHub Copilot 支持 OAuth 登录，其余用 API key。

单代理场景下它也是一个普通 CLI：MCP、skills（兼容 Codex / Claude Code）、后台 shell、中途结构化提问都有。

## 快速开始

```bash
swarmflow init   # 选择 Provider、设置 API key
swarmflow        # 启动会话
```

## 工作方式

| 角色 | 职责 |
|------|------|
| Queen | 把请求分解为 DAG |
| Scout | 只读代码库探索 |
| Worker | 文件与 shell 全权限实施 |
| Reviewer | 独立代码审查与验证 |
| Guard | 安全与恢复检查 |
| Merger | 合并多个代理的结果 |

内置五种编排模式：扇出/扇入、流水线、集成、辩论、探索。也可以让 Queen 自己按任务拆分。

## Provider 兼容性

接口形态按 Claude Code、OpenCode 等工具的约定设计：

| Provider | 接口 | 思考深度 | 缓存策略 |
|----------|------|---------|---------|
| Anthropic | Messages API | adaptive + budget_tokens | `cache_control` 断点 |
| OpenAI | Chat Completions | `reasoning_effort` | `prompt_cache_key` 路由 |
| OpenAI | Responses | reasoning | 每次请求 |
| DeepSeek（Anthropic） | Messages 兼容 | `output_config.effort` | 服务端自动 prefix cache |
| DeepSeek / Kimi / GLM / Qwen / MiniMax / 小米 / OpenRouter | OpenAI 兼容 | 各异 | 各异 |

DeepSeek 的 Anthropic 兼容端点会自动启用 prefix cache，无需手动标记 `cache_control`。

另有 Gemini（Generate Content API）与 GitHub Copilot 端点适配。所有 Provider 的 `base_url` 都可指向官方端点或中转站；OpenAI 支持 ChatGPT 账号 OAuth 登录，GitHub Copilot 支持 GitHub OAuth 设备码登录，其余 Provider 用 API key（`api_key_env`）。

## 会话控制

- `/rewind` 回退到任意 turn，文件编辑与 bash 副作用通过反向 patch 和 mutation 记录回退
- `/fork` 把当前会话分叉到新方向
- 会话持久化到磁盘：`swarmflow --resume` 恢复历史会话，`swarmflow --session` 管理与删除
- AGENTS.md 项目级记忆，跨上下文重置保留

## 中途提问与后台 Shell

模型可以用 `ask` 工具在执行中途暂停，向用户提结构化问题——多选、自定义输入、"继续讨论"。回答记录在会话审计日志中。

长时间运行的命令用 `bash_background`，返回唯一 ID 和日志路径；用 `read_file` 读日志、`kill_shell` 终止、`await_event` 等待结束，不阻塞主循环。

## 架构

```
┌────────────────────────────────────────────────────────┐
│  用户输入                                              │
│      │                                                 │
│      ▼                                                 │
│  TaskDecomposer  →  TaskDAG  →  SwarmScheduler         │
│                                            │           │
│                                            ▼           │
│  SwarmCoordinator  →  AgentPool  →  并行 Agent         │
│       │                    ▲                           │
│       │                    └── MessageBus + Recovery   │
│       ▼                                                 │
│  ResultMerger → 最终输出                                │
└────────────────────────────────────────────────────────┘
```

核心是单一 Node.js 进程承载运行时；会话由 CLI（`swarmflow --server`）以 NDJSON JSON-RPC 协议派生给 GUI 使用。桌面 GUI 壳层正在从 Electron 迁移至 Tauri（Rust），Rust 端负责子进程管理、文件系统与 Git 等系统能力，AI 核心逻辑保留在 TypeScript。

## 桌面 GUI（迁移中）

`gui/` 提供桌面版前端（React 19 + Tailwind v4 + Zustand + Radix UI），正在从 Electron 向 Tauri 2 迁移：

- 前端组件与状态层已完成框架无关重写：`gui/components/`、`gui/state/sessionStore.ts`、`gui/styles/`
- 渲染器经 `window.swarmflow` 桥调用原生能力（`gui/lib/api.ts`），协议为 NDJSON JSON-RPC（`gui/shared/rpc.ts`）
- `gui/src-tauri/` 为 Tauri 2 空壳，Rust 端待实现；旧 Electron 主进程归档于 `.history/gui/electron/`
- 开发：`cd gui && pnpm install && pnpm tauri dev`；打包：`pnpm tauri build`
- 核心 CLI 不重写，Rust 仅承担对桌面体验提升最大的部分（子进程、文件系统、Git、系统能力）

## 命令

```
/help      分类帮助            /model      切换模型
/agents    配置子代理模型       /provider   管理 Provider
/permission 安全模式           /compact    压缩当前上下文
/rewind    回退 turn 与文件    /fork       分叉会话
/new       新建会话            /rename     重命名
/status    会话状态            /theme      切换主题
/usage     用量与统计          /init       生成 AGENTS.md
/plan      规划模式            /reviewer   代码审查
/skills    技能管理            /skills-creater  创建 Skill
/mcp       MCP 工具            /ask        旁路提问
```

命令全集见 `src/commands/commands.ts`。

## 模型配置

SwarmFlow 不随程序打包模型目录。云端模型需要在 `~/.swarmflow/settings.json` 的 `providers.<id>.models` 中手动声明，例如：

```json
{
  "providers": {
    "openai": {
      "api_key_env": "OPENAI_API_KEY",
      "models": [
        { "id": "gpt-5.4", "context_length": 400000 }
      ]
    }
  }
}
```

模型的思考深度不会由本地目录判断；供应商返回的请求错误是最终依据。

## 项目结构

```
src/
├── cli.ts            # 入口（--server 服务模式）
├── commands/         # 斜杠命令注册表与处理器
├── agents/           # Agent 与工具循环
├── providers/        # Anthropic / OpenAI / DeepSeek 等适配器
├── swarm/            # 多智能体编排（DAG、池、消息总线）
├── session/          # 会话生命周期、rewind、子代理
├── context/          # 上下文视图、摘要、日志投影
├── tools/            # bash、edit、read、web search、MCP
├── config/           # 配置、持久化、模型注册
├── server/           # NDJSON JSON-RPC 服务模式
├── platform/         # 跨平台能力（浏览器、剪贴板、shell、代理）
└── ...

gui/
├── src-tauri/        # Tauri 2 壳（Rust，待实现）
├── components/       # React 组件（Composer、Transcript、Sidebar 等）
├── state/            # Zustand 会话状态
├── lib/              # API 桥接、Shiki 高亮、路径工具
├── shared/rpc.ts     # 渲染器 ↔ 子进程共享 RPC 类型
└── styles/           # Tailwind v4 + 明暗主题 token

prompts/              # Agent 角色模板（queen/scout/worker/reviewer/guard/merger）
skills/               # 可插拔 Agent Skills（兼容 Codex / Claude Code）
tests/                # vitest 测试
scripts/              # 构建与安装脚本（SEA 打包、install.sh/ps1）
external/             # opentui（fork 的 TUI 渲染核心）等
```

## 构建

```bash
npm install            # 安装依赖
npm run dev            # 开发运行 TUI（tsx 热载入）
npm run build          # 编译 TS 产物到 dist/ 并复制资源
npm run build:exe      # 构建 Node.js SEA 单文件可执行
node dist/src/cli.js --server --work-dir "$PWD"   # RPC 服务
npm test               # vitest 测试
npm run test:node      # Node.js 运行时冒烟测试
npm run typecheck      # 类型检查
```

## 平台要求

- CLI/TUI 运行与开发需要 Node.js ≥ 22.13.0；macOS（Apple Silicon）、Linux（x86_64、arm64）、Windows（x64、arm64）
- `npm run build:exe` 使用 Node.js SEA 与 `node:ffi`，需要 Node.js ≥ 26
- 无沙箱：shell 与文件工具以当前用户权限运行，用 `/permission` 管控破坏性操作
- 第三方编程套餐（Kimi-Code、GLM-Code）走服务商侧白名单，可能拒绝部分请求

## 诊断日志

排查崩溃用的临时诊断工具，默认关闭：

```bash
SWARMFLOW_LOG=1 npm run dev                  # 写到 stderr + .logs/
SWARMFLOW_LOG=file npm run dev               # 仅写文件
SWARMFLOW_LOG_DIR=/tmp/sf-logs npm run dev   # 自定义目录
SWARMFLOW_LOG_LEVEL=trace npm run dev        # trace|debug|info|warn|error
```

输出位置：

- `.logs/swarmflow-<ISO 时间>-pid<PID>-<seq>.log`，单行 JSON，便于 grep/jq
- `.logs/last-heartbeat.json`：每 5 秒覆盖一次，崩溃前最后 5 秒内的运行时状态
- 进程 panic / 未捕获异常也会写入（`uncaughtException` / `unhandledRejection`）

记录的关键节点：cli 入口与 `--server` 短路、`runServerMode` 入口、NDJSON 帧解析与连接关闭、`Session` 构造、`turn()` 进入/退出/异常、`asyncRunToolLoop` 入口。

崩溃复现后需要提供：崩溃前最后一个 `.logs/swarmflow-*.log`（可能为空但要保留）、`.logs/last-heartbeat.json`、终端上的完整 panic 输出和 Node.js 堆栈。

## 许可证

MIT。TUI 使用 OpenTUI（MIT）。
