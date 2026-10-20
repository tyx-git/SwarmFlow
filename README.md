# SwarmFlow
基于多智能体蜂群编排的终端 AI 编程助手。专为长时间任务而研发。

## 快速开始
```bash
swarmflow init   # 选择 Provider、设置 API key
swarmflow        # 启动会话
```
## 桌面 GUI（迁移中）
`gui/` 提供桌面版前端（React 19 + Tailwind v4 + Zustand + Radix UI），正在从 Electron 向 Tauri 2 迁移：
- 前端组件与状态层已完成框架无关重写：`gui/components/`、`gui/state/sessionStore.ts`、`gui/styles/`
- 渲染器经 `window.swarmflow` 桥调用原生能力（`gui/lib/api.ts`），协议为 NDJSON JSON-RPC（`gui/shared/rpc.ts`）
- `gui/src-tauri/` 为 Tauri 2 空壳，Rust 端待实现；旧 Electron 主进程归档于 `.history/gui/electron/`
- 开发：`cd gui && pnpm install && pnpm tauri dev`；打包：`pnpm tauri build`
- 核心 CLI 不重写，Rust 仅承担对桌面体验提升最大的部分（子进程、文件系统、Git、系统能力）

## 核心特性

### 多智能体蜂群
六种内置 Agent 角色，根据任务类型自动调度：

| 角色 | 职责 |
|------|------|
| **Queen** | 把请求分解为 DAG |
| **Scout** | 只读代码库探索 |
| **Worker** | 文件与 shell 全权限实施 |
| **Reviewer** | 全新视角的代码审查与测试验证 |
| **Guard** | 安全与合规检查 |
| **Merger** | 合并多个 Agent 的结果 |

五种编排模式覆盖常见工作形态：扇出/扇入、流水线、集成、辩论、探索。

### 上下文管理
自动 compact 防止上下文溢出，并生成可继续工作的接续摘要：
| 阈值 | 行为 |
|------|------|
| 85% | 回合前 compact |
| 90% | 回合中 compact |

上下文达到阈值时由系统自动 compact，并生成可继续工作的上下文接续摘要。

### 会话控制
- **回退**（`/rewind`）— 回滚到任意 turn；文件编辑与 bash 副作用通过反向 patch 和 mutation 跟踪回退
- **分支**（`/fork`）— 把当前会话分支到新方向继续探索
- **恢复** — 所有会话持久化到磁盘；使用 `swarmflow --resume` 恢复历史会话，使用 `swarmflow --session` 管理并删除历史会话
- **AGENTS.md 持久记忆** — 项目级笔记跨上下文重置保留

### Provider 兼容性
按 Claude Code、OpenCode 等主流工具的接口形态设计：
| Provider | 接口 | 思考深度 | 缓存策略 |
|----------|------|---------|---------|
| Anthropic | Messages API | adaptive + budget_tokens | `cache_control` 断点 |
| OpenAI | Chat Completions | `reasoning_effort` | `prompt_cache_key` 路由 |
| OpenAI | Responses | reasoning | 每次请求 |
| DeepSeek（Anthropic） | Messages 兼容 | `output_config.effort` | 服务端自动 prefix cache |
| DeepSeek / Kimi / GLM / Qwen / MiniMax / 小米 / OpenRouter | OpenAI 兼容 | 各异 | 各异 |

DeepSeek 的 Anthropic 兼容端点会自动启用 prefix cache，无需手动标记 `cache_control`。

### 中途提问
模型可以在执行中途通过 `ask` 工具暂停，向用户提出结构化问题——多选、自定义输入、"继续讨论"。回答记录在会话审计日志中。

### 后台 Shell
长时间运行的命令（`bash_background`）获得唯一 ID 和日志路径；用 `read_file` 读取日志、用 `kill_shell` 终止。Agent 通过 `await_event` 等待完成，不阻塞主循环。

## 同类产品对比
| 特性 | SwarmFlow | Claude Code | OpenCode | Aider |
|------|-----------|-------------|----------|-------|
| 多智能体蜂群 | 内置 | — | — | — |
| DAG 任务分解 | 自动，基于规则 | — | — | — |
| 并行子代理 | 支持，可配模型档位 | 单 Agent | 单 Agent | 单 Agent |
| 上下文压缩 | 自动 compact 与 `/compact` | 仅 `/compact` | 仅 `/compact` | 仅 `/compact` |
| 文件级回退 | 反向 patch 日志 | — | — | Git revert |
| 会话分叉 | 支持 | — | — | — |
| Provider 数量 | 9+ | 仅 Anthropic | 多 | 多 |
| 界面 | 终端 + 桌面 GUI | 终端 | 终端 | 终端 |
| 运行时 | Node.js + TypeScript（GUI 向 Tauri 迁移中） | Node | Go + Rust | Python |

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
核心为单一 Node.js 进程承载运行时；会话由 CLI（`swarmflow --server`）以 NDJSON JSON-RPC 协议派生给 GUI 使用。桌面 GUI 壳层正在从 Electron 迁移至 Tauri（Rust），Rust 端负责子进程管理、文件系统与 Git 等系统能力，AI 核心逻辑保留在 TypeScript。

## 命令
`/help` 分类帮助
`/model` 切换模型
`/agents` 配置子代理默认模型
`/provider` 管理 Provider
`/permission` 设置安全模式
`/compact` 压缩当前上下文
`/rewind` 回退 turn + 文件
`/fork` 分叉会话
`/new` 新建会话 · `/rename` 重命名 · `/status` 会话状态
`/theme` 切换主题 · `/usage` 用量与统计
`/init` 生成 AGENTS.md · `/plan` 规划模式 · `/reviewer` 代码审查
`/skills` 管理技能 · `/skills-creater` 创建 Skill · `/mcp` MCP 工具 · `/ask` 旁路提问
......

### 模型配置

SwarmFlow 不再随程序打包模型目录。云端模型需要在 `~/.swarmflow/settings.json` 的
`providers.<id>.models` 中手动声明，例如：

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

prompts/              # Agent 模板（main、explorer、worker、reviewer）
skills/               # 可插拔 Agent Skills（兼容 Codex / Claude Code）
tests/                # vitest 测试
scripts/              # 构建与安装脚本（SEA 打包、install.sh/ps1）
external/             # opentui（fork 的 TUI 渲染核心）等
```

## 构建
```bash
npm install                 # 安装依赖
npm run dev                # 开发运行 TUI（tsx 热载入）
npm run build               # 编译 TS 产物到 dist/ 并复制资源
npm run build:exe           # 构建 Node.js SEA 单文件可执行
node dist/src/cli.js --server --work-dir "$PWD"   # RPC 服务
npm test                    # vitest 测试
npm run test:node           # Node.js 运行时冒烟测试
npm run typecheck           # 类型检查
```

## 平台要求
- 普通 CLI/TUI 运行与开发需要 Node.js ≥ 22.13.0；macOS（Apple Silicon）· Linux（x86_64、arm64）· Windows（x64、arm64）
- `npm run build:exe` 使用 Node.js SEA 与 `node:ffi`，仍需要 Node.js ≥ 26
- 无沙箱——shell 与文件工具以当前用户权限运行。使用 `/permission` 管控破坏性操作
- 第三方编程套餐（Kimi-Code、GLM-Code）使用服务商侧白名单，可能拒绝部分请求

## 诊断日志（运行时崩溃排查）
排查过程中使用的临时诊断工具。默认关闭，避免影响生产输出。

启用方式：
```bash
SWARMFLOW_LOG=1 npm run dev                  # 写到 stderr + .logs/
SWARMFLOW_LOG=file npm run dev               # 仅写文件
SWARMFLOW_LOG_DIR=/tmp/sf-logs npm run dev   # 自定义目录
SWARMFLOW_LOG_LEVEL=trace npm run dev        # trace|debug|info|warn|error
```

输出位置：
- 默认 `.logs/swarmflow-<ISO 时间>-pid<PID>-<seq>.log`，单行 JSON，便于 grep/jq
- `.logs/last-heartbeat.json`：每 5 秒覆盖一次，崩溃前最后 5 秒内的运行时状态
- 进程 panic / 未捕获异常也会写入（`uncaughtException` / `unhandledRejection`）

记录的关键节点：
| 组件       | 触发点 |
|-----------|--------|
| cli        | `main` 入口、`--server` 短路 |
| server     | `runServerMode` 入口 |
| rpc        | NDJSON 帧解析、handler 调用、连接关闭 |
| session    | `Session` 构造、Node GC 边界 |
| session.turn | `turn()` 进入/退出/异常 |
| tool-loop  | `asyncRunToolLoop` 入口 |

崩溃复现后，请把以下文件提供给排查者：
1. 崩溃前最后一个 `.logs/swarmflow-*.log`（可能为空但要保留）
2. `.logs/last-heartbeat.json`（崩溃前最后状态）
3. 终端上的完整 panic 输出和 Node.js 堆栈

## 许可证
MIT。TUI 使用 OpenTUI（MIT）。


