# SwarmFlow
基于多智能体蜂群编排的终端 AI 编程助手。专为长时间任务而研发。

## 快速开始
```bash
swarmflow init   # 选择 Provider、设置 API key
swarmflow        # 启动会话
```

更新：`swarmflow update` 把最新版本暂存到下次启动。`swarmflow update --check` 仅检查不暂存。
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
三层压缩机制防止上下文溢出，避免激进的全窗口摘要：
| 阈值 | 行为 |
|------|------|
| 50% | 一级提示——建议针对性压缩 |
| 75% | 二级提示——警告即将自动 compact |
| 85% | 回合前 compact |
| 90% | 回合中 compact |

模型本身可通过 `show_context` 与 `summarize_context` 工具检视、压缩特定的上下文分组，保留关键决策、丢弃冗余。

### 会话控制
- **回退**（`/rewind`）— 回滚到任意 turn；文件编辑与 bash 副作用通过反向 patch 和 mutation 跟踪回退
- **分支**（`/fork`）— 把当前会话分支到新方向继续探索
- **恢复** — 所有会话持久化到磁盘；重启后可继续
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
长时间运行的命令（`bash` 带 `background=true`）获得唯一 ID；`bash_output` 与 `kill_shell` 与之交互。Agent 通过 `await_event` 等待完成，不阻塞主循环。

## 同类产品对比
| 特性 | SwarmFlow | Claude Code | OpenCode | Aider |
|------|-----------|-------------|----------|-------|
| 多智能体蜂群 | 内置 | — | — | — |
| DAG 任务分解 | 自动，基于规则 | — | — | — |
| 并行子代理 | 支持，可配模型档位 | 单 Agent | 单 Agent | 单 Agent |
| 上下文选择性压缩 | `summarize_context` 工具 | 仅 `/compact` | 仅 `/compact` | 仅 `/compact` |
| 文件级回退 | 反向 patch 日志 | — | — | Git revert |
| 会话分叉 | 支持 | — | — | — |
| Provider 数量 | 9+ | 仅 Anthropic | 多 | 多 |
| 界面 | 终端 | 终端 | 终端 | 终端 |
| 运行时 | Node + TypeScript（Rust 内核规划中） | Node | Go + Rust | Python |

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

单个 TS 进程承载运行时；会话由 CLI（`swarmflow --server`）为 Electron GUI 派生。Rust 内核开发中，目标是 CLI 冷启动 < 100ms。

## 命令

`/model` 切换模型
`/key` 管理 API key
`/summarize` 交互式压缩上下文
`/compact` 全量重置
`/rewind` 回退 turn + 文件
`/permission` 设置安全模式
`/tier` 配置子代理模型档位
`/session` 恢复历史会话
`/fork` 分叉会话
`/skills` 管理技能
`/mcp` MCP 工具
......

## 项目结构
```
src/
├── cli.ts            # 入口
├── config/           # 配置、持久化、模型注册
├── providers/        # Anthropic / OpenAI / DeepSeek 等适配器
├── swarm/            # 多智能体编排
├── session/          # 会话生命周期、rewind、子代理
├── context/          # 上下文视图、摘要
├── tools/            # bash、edit、read、web search、MCP
└── ...

prompts/
├── templates/        # Agent 模板（main、explorer、worker、reviewer）
└── subagent/         # 子代理提示片段

external/
└── opentui/          # Fork 的 OpenTUI 渲染核心
```

## 构建
```bash
npm install                 # 安装依赖
npm run dev                # Node.js 运行 TUI
npm run start:server       # Node.js 运行 RPC 服务
npm run build               # 构建 Node.js 服务产物
node dist/src/cli.js --server --work-dir "$PWD"
npm test                    # Node.js 测试
npm run test:node           # Node.js 运行时冒烟测试
npm run typecheck          # Node.js 类型检查
```

## 平台要求
- macOS（Apple Silicon）· Linux（x86_64、arm64）· Windows（x64、arm64）
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
