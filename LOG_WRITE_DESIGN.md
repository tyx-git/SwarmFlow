# SwarmFlow 日志持久化 · 写侧设计

> 2026-10-23。本文只回答"写什么、怎么写、崩溃后怎么恢复"。
> 读侧见 [LOG_READ_DESIGN.md](LOG_READ_DESIGN.md)，总体测量/问题/决策见 [LOG_PERSISTENCE_DESIGN.md](LOG_PERSISTENCE_DESIGN.md)。
>
> **状态（2026-10-25）：W-1…W-5 已实现并完成运行期切换；写锁、seq 校验、归档双写/白名单收敛已落地。** 剩余为保留策略与少量一次性开销，见 §W8.4 与 §W10。

---

## W0 结论

- 当前 6.65 MB 会话整场写 **3.00 GiB（462× 放大）**，200 MB 档 **2.4 TiB**；根因是格式（每次检查点重写整份），不是频率（0.04 次/s）。
- 目标：`log.json` 整写 → **`log.jsonl` 追加**。每个检查点只写"本次变更的条目"，不再触碰历史。
- 写入前做三件事：过滤瞬时数据、截断大载荷、外置密文/图片。
- 默认**不逐条 fsync**（与 Codex 一致）；崩溃只可能丢文件尾，靠"补齐尾换行 + 跳过坏行"恢复。
- 代价：必须改造 `SessionLog` 的变更入口。当前条目允许就地修改（[session/log.ts:64-67](src/session/log.ts#L64-L67)），没有脏集；不改这一层，追加式写入无法知道"什么变了"。

预测收益（待 W0 量测确认，不当作已实现）：

| 会话 | 现在总写入 | 追加式预测 | 下降 |
| --- | --- | --- | --- |
| 真实 6.65 MB | 3.00 GiB | < 100 MB | > 30× |
| 50 MB 夹具 | 144.97 GiB | < 500 MB | > 290× |
| 200 MB 夹具 | 2415 GiB | < 2 GB | > 1200× |

---

## W1 现状与证据

### W1.1 写路径

- `saveLog` 每次生成完整 payload，`writeLogFile` 按 ~1 MiB 批量 `writeSync` 后 `rename`（[log-serialization.ts:83-114](src/config/log-serialization.ts#L83-L114)、[:117-164](src/config/log-serialization.ts#L117-L164)）。② 降低了峰值内存，**没有降低写入字节**。
- 已有一个写前过滤：`meta.ephemeral === true` 的条目不进文件（[log-serialization.ts:95-97](src/config/log-serialization.ts#L95-L97)）。这是 Codex "transient 不落盘"的雏形。
- 检查点触发点 924 个（真实会话 7.06 h），单次 6.01 MiB / 18 ms；50 MB 档 107 ms；200 MB 档 427 ms（[设计 §6.6](LOG_PERSISTENCE_DESIGN.md)）。
- `meta.json` 与 `project.json` 每次检查点各一次全读+全写，仍用 `null, 2`（P-14，[session-meta.ts:103-124](src/config/session-meta.ts#L103-L124)、[log-serialization.ts:58-70](src/config/log-serialization.ts#L58-L70)）。

### W1.2 变更模型（关键约束）

当前日志是"可变条目数组"：

- `SessionLog.entries` 直接暴露数组，调用方可就地改（[session/log.ts:64-67](src/session/log.ts#L64-L67)）；`touch()` 只 bump revision，不记录"哪个条目变了"。
- 工具回合通过 `updateEntryFn` 直接改 `content/display/meta`（[activation.ts:449-503](src/session/activation.ts#L449-L503)），`discardEntryFn` 直接置 `discarded`（[:506-512](src/session/activation.ts#L506-L512)）。
- 其他直接变更点：archive 置 `archived` 并清 presentation（[archive.ts:142](src/config/archive.ts#L142)、[:163-180](src/config/archive.ts#L163-L180)）；compact 丢弃条目（[compact-flow.ts:412](src/session/compact-flow.ts#L412)）；log-surgery 丢弃（[log-surgery.ts:312](src/session/log-surgery.ts#L312)）；inbox 丢弃（[inbox.ts:172](src/session/inbox.ts#L172)）；rewind 写回退标记（[engine.ts:385-387](src/session/rewind/engine.ts#L385-L387)）。
- 结论：追加式写入必须先把这些变更收编到一个**变更网关**（见 W4.1），否则只能每次全量 diff（CPU 仍是 O(文件大小)，收益打折）。

---

## W2 Codex 写侧（证据）

对照 `external/codex/codex-rs`（vendored，只读参考）：

| 机制 | 证据 |
| --- | --- |
| 逐条追加，不重写 | `record_canonical_items` 入队 → writer 逐条写 JSONL，每条 `write_all` + `flush`；每次 append 后走 flush barrier（[recorder.rs:1048-1060](external/codex/codex-rs/rollout/src/recorder.rs#L1048-L1060)、[:1908-1949](external/codex/codex-rs/rollout/src/recorder.rs#L1908-L1949)、[live_writer.rs:372-383](external/codex/codex-rs/thread-store/src/local/live_writer.rs#L372-L383)） |
| 写入前减重 | MCP 结果/命令输出 > 64 KiB 截断并打标记；delta/approval/error 等瞬时事件不落盘；`CompactionTrigger`/`Other` 丢弃（[policy.rs:16-19](external/codex/codex-rs/rollout/src/policy.rs#L16-L19)、[:127-224](external/codex/codex-rs/rollout/src/policy.rs#L127-L224)、[:250-259](external/codex/codex-rs/rollout/src/policy.rs#L250-L259)） |
| 不 fsync | 只 `flush` 到 OS；`sync_all` 仅用于压缩/物化（[compression.rs:155-165](external/codex/codex-rs/rollout/src/compression.rs#L155-L165)） |
| 崩溃恢复 | 追加前补齐尾换行；反向扫描跳过坏行（[recorder.rs:2059-2072](external/codex/codex-rs/rollout/src/recorder.rs#L2059-L2072)、[reverse_jsonl_scanner.rs:71-80](external/codex/codex-rs/rollout/src/reverse_jsonl_scanner.rs#L71-L80)） |
| 检查点 | `CompactedItem` 追加而非重写，携带 `replacement_history`、`window_number`、`latest_token_usage_record`（[core/session/mod.rs:4213-4243](external/codex/codex-rs/core/src/session/mod.rs#L4213-L4243)） |
| 冷压缩 | 只压 7 天前的 rollout，zstd level 3、后台、最多 2 并发；追加前先物化回明文（[compression.rs:363-369](external/codex/codex-rs/rollout/src/compression.rs#L363-L369)、[recorder.rs:2033-2051](external/codex/codex-rs/rollout/src/recorder.rs#L2033-L2051)） |
| 元数据 | JSONL 先落盘，再把增量投影进 SQLite；SQLite 是可重建视图，不是第二权威（[live_writer.rs:349-365](external/codex/codex-rs/thread-store/src/local/live_writer.rs#L349-L365)） |
| fork/revert | 新建不可变 rollout 段（ordinal + byte offset），不复制父文件（[rollout_lineage.rs:14-30](external/codex/codex-rs/thread-store/src/local/rollout_lineage.rs#L14-L30)） |
| 观测 | 按 item/turn 采样写入字节（`persistence_metrics.rs`），用数据调写入策略 |

**采纳**：逐条追加、写前过滤/截断、不 fsync、尾行修复、检查点不重写、冷归档方向（形态改为显式命令 + gzip，见 W4.6）。
**不采纳**：SQLite 投影（我们只有 4 个会话，`meta.json` 足够）；自动分段（先不做，见 W9）。

---

## W3 目标格式：`log.jsonl`

### W3.1 文件布局

```
<sessionDir>/
  log.jsonl                  # 新增：追加式权威日志
  meta.json                  # 保留：列表/摘要快路径
  sealed/<entryId>.json.gz   # M1：封存态 sidecar
  archive/window-<n>.json.gz # 保留：已压缩窗口全文
  images/                    # 保留：image_ref
```

- 一个会话一个 `log.jsonl`；`version: 4`。
- 文件第一行必须是 `session` 记录；之后只追加，不修改历史行。
- 每行一个紧凑 JSON 对象，行尾 `\n`；不做缩进。

### W3.2 记录类型（D15 待批）

| op | 载荷 | 用途 |
| --- | --- | --- |
| `session` | `seq, ts, session`（session_id/created_at/project_path/model_*/prompt_cache_affinity_key/title/turn_count/compact_count/thinking_level/child_sessions） | **仅文件第一行**；可变摘要（title/summary/turn_count/usage）由 `meta.json` 负责 |
| `upsert` | `seq, ts, entries: [snake_entry, ...], replaces?` | 新增条目；内容/meta 变更；compact_marker 的 discarded 变更也走整条 upsert。`replaces: true` 表示覆盖已存在条目（TUI 分页按创建位置排序依赖它；缺省=首次出现） |
| `patch` | `seq, ts, ids: [...], flags?: {discarded?, archived?, fileMutationReverted?, bashMutationReverted?, bashMutationRevertedIndices?}, dropPresentation?: true` | 闭集标志翻转；归档剥离 display/meta |
| `truncate` | `seq, ts, fromEntryId` | 回退/撤销压缩：删除该条目及其之后的所有条目 |
| `usage`（可选） | `seq, ts, totals: {input, output, cacheRead}` | 让读侧不必回扫 marker 之前的 token_update |

规则：

- `seq` 单调递增、从 1 开始；同一 session 由单写者分配。
- `session` 只允许作为第一行；已有文件再追加 `session` 记录视为无效（`appendRecords` 拒绝，`readRecords` 告警）。
- `entries` 用现有 `entryToSnake` 落盘、`entryFromSnake` 读取（[log-serialization.ts:20-56](src/config/log-serialization.ts#L20-L56)），不另造字段名。
- 重放顺序即 `seq` 顺序；同一 `id` 多次 upsert 时**最后一条生效**，不报重复 ID。
- `replaces` 只由 `SessionLog._persistedIds` 决定：创建/迁移快照不带，已落盘条目的再次写带；truncate 删除后重新添加视为创建。旧记录缺该字段时读侧按创建处理（`persistence_policy=3` 会在下一次保存重写成带标志的格式）。
- `patch` 只允许上表列出的闭集字段；其他字段变化必须发 `upsert`。未知 flag 一律拒绝，防止静默丢字段。
- `compact_marker` 必须整条 upsert，不走 patch（读侧反向扫描要靠它做锚点，必须能只看最后一条记录判定 live/discarded）。
- `truncate` 之后新追加的条目自然排在文件尾部；重放时先应用 truncate，再应用其后的记录。
- `meta.ephemeral` 条目仍然不写（沿用 [log-serialization.ts:95-97](src/config/log-serialization.ts#L95-L97)）。

示例：

```jsonl
{"v":4,"op":"session","seq":1,"ts":"2026-10-23T10:00:00.000Z","session":{"session_id":"019...","title":"Demo","turn_count":0,"compact_count":0}}
{"v":4,"seq":2,"ts":"2026-10-23T10:00:01.000Z","op":"upsert","entries":[{"id":"sys-001","type":"system_prompt","timestamp":1,"turn_index":0,"content":"..."}]}
{"v":4,"seq":3,"ts":"2026-10-23T10:00:02.000Z","op":"upsert","entries":[{"id":"ts-001","type":"turn_start","timestamp":2,"turn_index":1,"content":"..."}]}
{"v":4,"seq":4,"ts":"2026-10-23T10:01:00.000Z","op":"patch","ids":["rsn-001"],"flags":{"archived":true},"dropPresentation":true}
{"v":4,"seq":5,"ts":"2026-10-23T10:02:00.000Z","op":"truncate","fromEntryId":"user-009"}
```

### W3.3 为什么不用 base + delta

上一版曾建议"`log.json` 作为 base + `log.delta`"。它仍需要两套读取边界、合并规则和崩溃时序，且 base 与 delta 谁是权威要额外定义。JSONL 只有一种格式、一条读取路径，反向扫描天然可用；代价是变更网关的工作量（W4.1），但这笔工作 base+delta 同样躲不掉。**结论：直接采用 JSONL。**

---

## W4 写管线

### W4.1 变更网关（最高风险项）

把 `SessionLog` 变成唯一写入点，所有变更必须经过它：

```ts
append(entry): void;                       // 新条目
updateEntry(id, mutator): void;            // 内容/meta 变更 → 记入 dirtyUpsert
patchFlags(ids, flags, opts?): void;       // 闭集标志/剥 presentation → 记入 dirtyPatch
truncateFrom(id): void;                    // 数组截断 + 记 truncate op
replace(entries): void;                    // 仅恢复/迁移，不产生写操作
readonly entries: readonly LogEntry[];     // 调用方不得再就地改
```

- 迁移现有直接变更点：activation 的 `updateEntryFn`/`discardEntryFn`、archive 的 strip、compact/log-surgery/inbox 的 discarded、rewind 的 mutation 标记，全部改走网关。
- 兼容策略：不允许"直接改 + 事后 touch"继续存在。开发/测试下对 entries 做 `Object.freeze` 或加 `isDirty` 断言，逼出漏网调用点。
- 完整性红测：跑一组真实流程（工具更新、丢弃、压缩归档、回退、撤销压缩）→ flush → 清空内存重放 `log.jsonl` → 断言 entries/meta 与写前深度相等。**漏一个变更点就红。**

### W4.2 批次、flush、锁

- 保留 2 s debounce；每次保存把 dirty upsert/patch/truncate 合并成**一个批次**追加，批次结束 `flush` 到 OS。
- 回合结束、命令结束、进程退出前强制 flush；不逐条 fsync（与 Codex 一致，P-8 已接受）。
- 单会话单写者：✅ 2026-10-25。会话目录加 `log.jsonl.lock`（pid + token）；`createSession` 与 `applySessionRestore` 获取，`Session.close`/`clearSession` 释放。第二个实例 resume 返回 `Error.sessionBusy`（`language.json`）并拒绝恢复；崩溃留下的陈旧锁按 pid 存活检测接管；fork 复制后删除继承锁。
- fork 是离线新建：复制 `log.jsonl` 后**重写第一行 header**（新 session_id/title/fork 来源），其余行原样复制；父文件不动。这不算追加写，属于新文件构造。
- 写失败：保留 dirty 集合，下次重试；部分写入的行在下次打开时修正（W6）。

### W4.3 写前策略（承接 M2/M1/M9/P-14）

- **只写完成态**：`toolStreamState === "partial"` / `toolExecState === "running"` 的条目先不落盘，等 completed/failed 再 upsert。避免把流式中间态反复写进日志。
- **64 KiB 截断**：MCP 结果、命令输出超过 64 KiB 时截断并留续读指针（复用 `agent-outputs` 的既有模式，[manager.ts:653-667](src/session/children/manager.ts#L653-L667)）；图片走 `image_ref`（M2）。
- **封存态外置**：`reasoningState` ≥ 4 KiB 写 `sealed/<entryId>.json.gz`，日志里只留引用（M1，D2/D3）。
- **token_update**：**否决（P9.1，2026-10-23）**。消费者同时依赖逐次求和（[usage-accounting.ts:66](src/session/usage-accounting.ts#L66)、[session-store.ts:413](src/config/session-store.ts#L413)）与"最后一条 = 当前上下文"（[log-surgery.ts:604-620](src/session/log-surgery.ts#L604-L620)），合并无法同时满足；收益仅 2.3% 字节。保留逐条记录，累计值仍随 `compact_marker` 写 `usage`。
- **meta.json/project.json**：✅ 已落地（P-14）。`last_active_at` 跨分钟才推进，`meta.json` 内容不变则不重写，两处均为紧凑 JSON。
- **meta.json 兼作恢复快照（R-2/M8，2026-10-24）**：`id_counters` / `work_count` / `tool_call_count` / `last_tool_call_summary` / `recent_session_events` / `last_turn_end_status` / `self_phase` / `tokens`（累计 input/output/cacheRead）/ `first_input` / `first_user_message_tokens`。有界恢复只加载活动窗口，靠这些字段保持 ID/work 不重号、恢复信号不退化为空；缺失时读侧回退整读。

### W4.4 归档与回退

- `archiveWindow` 仍写 `archive/window-<n>.json.gz`（全文 + display/meta）；内存侧 `stripArchivedPresentation` 改为 `patch { ids, flags:{archived:true}, dropPresentation:true }`，一条记录可带一批 id。
- `restoreArchiveToEntries`（撤销压缩）改为批量 `upsert` 恢复的条目，并 `truncate` 掉不需要的尾部（如适用）。
- `rewindConversation` 改为 `truncateFrom(id)`；文件字符串仍保留在盘上，读侧按 truncate 忽略，后续由冷压缩/归档回收。

### W4.5 检查点与用量

- `compact_marker` 就是读侧锚点；写入时整条 upsert。若本批包含 `compact_marker`，保存会追加一条 `usage` 记录（累计 input/output/cacheRead），让读侧无需回扫 marker 之前。
- 物理文件不因压缩而截断（与 Codex 相同）；逻辑读取停在最新 live marker。

### W4.6 冷会话归档（W-5，2026-10-24）

**形态**：显式 CLI（`swarmflow sessions archive <id>` / `restore <id>`），不按时间自动搬迁、不做 zstd。

- 搬移：整个 `<base>/projects/<slug>/<id>/` → `<base>/archived_sessions/<slug>/<id>/`（同一 base 下的同卷 `rename`），`archive/`、`sealed/`、`artifacts/` 原样带走。
- 压缩：活动日志（`log.jsonl`，legacy 回退 `log.json`）→ 同名 `.gz`，顺序为“写 `.gz.tmp` → rename → 删明文”。`log.json.pre-v4.bak` 不压。
- 标志：搬完后在归档目录的 `meta.json` 置 `archived: true`；restore 前清除。位置是权威、标志只是元数据（列表本就只扫 `projects/`，且会跳过 `archived`）。
- 还原：先查 `projects/` 目标冲突 → 解压明文（明文与 `.gz` 并存时以明文为准）→ 清标志 → 搬回。往返日志逐字等价，`--resume` 恢复可用。
- 守卫：`looksLikeSessionId` 校验（防路径穿越）、未知 id、重复归档、目标已存在、活动会话（`SessionStore.sessionDir`）全部拒绝。
- 收益实测（I5.1，M1 后）：整体 gzip 比 **0.36–0.41**，故保留压缩；真实冷会话收益主要来自日志正文（0.14–0.17）。

---

### W4.7 显式 prune 保留策略（D22，2026-10-25）

`sessions prune <id> [--dry-run] [--max-log-bytes <bytes>]`：

- 只处理最后一个 live `compact_marker` 之前的前缀；可丢条目 = `discarded`、`content === null`（turn_start/turn_end 等结构条目）、旧 `compact_marker`、或 archive 中有正文副本的条目。`system_prompt` 保留；其他无副本条目让整次 prune 拒绝。
- 原子重写 `log.jsonl`（新快照 seq 从 1 开始），删除 `log.index.jsonl`；活动窗口、system prompt、archive/artifacts/sealed 均保留。
- 结果报告丢失的用户 turn 列表、日志前后字节、archive/artifacts/sealed 体积；`--max-log-bytes` 只在超阈值时执行，`--dry-run` 不写盘。
- 不自动执行、不删除 archive/artifacts/sealed；自动总量配额与冷段（D18）仍未做。

## W5 写放大预算

每个检查点的写入：

```
bytes(save) = Σ serialized(upsert entries) + Σ patch records + truncate/usage + 行开销
```

- 典型检查点：1–3 个新/改条目 + 1 条 patch；大工具结果只写一次完成态（≤64 KiB）。
- 归档剥离：一条 patch 带 N 个 id，不写 N 份 content。
- 压缩检查点：marker + compact_context + usage，KB 级；不再重写整个窗口。
- 验收目标（W0 实测后再固化）：6.65 MB 会话总写入 < 100 MB；200 MB 会话 < 2 GB；单次 flush P95 < 20 ms。

**真实 turn 实测（2026-10-23，`.tmp/measure-jsonl-turn.ts`）**：首轮快照 4,426 B（10 条），第二轮只追加 2,080 B（6 条），没有整份重写。大夹具/真实语料的前后对比在 W-3 完成后重跑。

**必须先量测**：当前日志没有"保存边界"记录，无法从存量反推每次变更量。W0 第一步应在现有代码里插桩统计每个检查点的 dirty 条目数与字节数，再确认上表。

---

## W6 崩溃与恢复

- 打开文件：若最后一行不是 `\n` 结尾，追加一个换行（不改内容）；解析失败的行跳过并记录 warning。
- 重放：按 seq；缺 seq/重复 seq 只告警（不阻塞启动）；最后一条坏行丢弃。
- 写入：`appendRecords` 在追加前用 `readLastSeq` 校验“首条 = 文件末 seq + 1、批内连续”，断档/重复直接拒绝；只有 header 一行的文件也能正确读出 seq 1。
- 写入顺序：`upsert`/`patch` 只追加，不 rename；因此不存在"改坏旧数据"的窗口。丢的是最后一次 flush 之后的尾部。
- 明确不承诺：断电零丢失。需要更强保证时，只能在回合边界加 `fsync`，作为可选配置（默认关）。

---

## W7 迁移（2026-10-23 已落地：首次读取自动迁移）

1. 打开会话时若只有 `log.json`（v2/v3）且无 `log.jsonl`：
   - 按现有 `loadLog` 读入 → 校验 → 写 `log.jsonl`（header + 每条 entry 一条 upsert）到临时文件；
   - 重放临时文件，与内存 entries/meta 深度比对；不一致则中止并保留旧文件；
   - 原子 rename 为 `log.jsonl`；把旧文件改名为 `log.json.pre-v4.bak`（不删除，供回滚）。
2. 之后只读 `log.jsonl`；**不保留双读路径**。备份文件不参与运行，只用于人工回滚。
3. fork 的会话目录若含旧 `log.json`，在 attach 时走同一迁移。
4. `archive/`、`images/`、`sealed/` 不变；`log.jsonl` 迁移不改这些目录。

回滚：保留旧 `log.json.pre-v4.bak` 与旧二进制；不提供运行时回退读。

---

## W7.5 变更点盘点与接线（2026-10-23）

**运行期变更（已接网关）**

| 变更点 | 网关入口 |
| --- | --- |
| 流式文本/思维链增量、`onReasoningDone` 写 reasoningState | `updateEntry`（[activation.ts:184](src/session/activation.ts#L184)、[:228](src/session/activation.ts#L228)、[:249](src/session/activation.ts#L249)） |
| 工具调用同步、条目丢弃 | `updateEntry`（[activation.ts:460](src/session/activation.ts#L460)、[:509](src/session/activation.ts#L509)） |
| 压缩归档窗口（content=null + archived） | `SessionLog.archiveEntries(ids)`（[compact-flow.ts:379](src/session/compact-flow.ts#L379)） |
| 归档后剥离 display/meta | `SessionLog.stripArchivedPresentation` → `patchFlags` + `dropPresentation`（[compact-flow.ts:384](src/session/compact-flow.ts#L384)） |
| 压缩失败清理 | `patchFlags(discarded)`（[compact-flow.ts:418](src/session/compact-flow.ts#L418)） |
| 恢复排队输入 | `patchFlags(discarded)`（[inbox.ts:174](src/session/inbox.ts#L174)） |
| 中断回合丢弃未完成 reasoning | `patchFlags(discarded)`（[turn-control.ts:173](src/session/turn-control.ts#L173)、[log-surgery.ts:277](src/session/log-surgery.ts#L277)） |
| 会话回退截断 | `truncateFrom(firstRemoved)`（[session.ts:1721](src/session.ts#L1721)） |
| 回退撤销归档 | `restoreArchivedEntries`（[session.ts:1750](src/session.ts#L1750)） |
| rewind 文件/bash 回退标记、清理 journal 标记 | `RewindEngineDeps.patchFlags`（[engine.ts:392](src/session/rewind/engine.ts#L392)、[:596](src/session/rewind/engine.ts#L596)、[:813](src/session/rewind/engine.ts#L813)） |
| 所有新条目 | `SessionLog.append`（原有入口） |

**未接但已论证安全**

- `tool-loop/run.ts:408-410`、`:765-766`，`activation.ts:366-423`，`compact-flow.ts:235/282/295/339`，`inbox.ts:363/378`，`round-tracking.ts:98-99`，`log-surgery.ts:374-375`：都在 `appendEntry` **之前**设置字段；append 的快照包含最终值。
- `config/log-repair.ts`：加载期修复，不发生在 live 日志上；修复结果随下一次保存落盘。
- `context/projection/*`：投影副本，不是日志条目。
- `SessionLog.replace`：恢复路径，不应产生增量记录。
- `log-surgery` 的 fallback（无回调时直接置 discarded）：现在只用于测试/快照视图；live 调用均传网关回调。

**运行期切换（2026-10-23 已完成）**

- 保存：`Session.persistToDisk()` 首次写快照（header + 全部条目），之后 `peekPendingRecords` → `appendRecords` → `commitPendingRecords`；追加失败时队列保留，下次重试。
- 读取：`loadLog` 优先 `log.jsonl`；只有 legacy `log.json` 时自动迁移（校验后写 JSONL，旧文件改名 `.pre-v4.bak`），不保留双读回退。
- `Session.getLogForPersistence` 恢复为纯读，原先的 `clearPendingRecords()` 临时代码已删除。
- 调用点：TUI `app.tsx`/`main.tsx`、`session-rpc`、`resume`、子会话保存全部改走 `persistToDisk`。
- **读侧已优化（2026-10-24）**：`loadModelContext` 有界反向扫描已落地并接入 resume；`loadLog` 只保留给迁移/全量重建。

**审查结论与遗留风险**

- 全量 1383 例通过；运行期已切换为 `log.jsonl`（实现状态见 W8.1）。
- 真实 turn 全流程测试已补（`tests/session/session-jsonl-persistence.test.ts`）：两次 turn 追加、无变更不重写、真实回退 truncate、手动压缩 marker/context/usage、fresh Session 的 `applySessionRestore`。
- `archiveWindow` 仍先就地改内存，`archiveEntries` 再记录一次；幂等但规则有两处，后续可让 archiveWindow 只返回 targets。
- `patchFlags` 不处理 `tuiVisible`；丢弃语义分 `updateEntry`（同时隐藏）与 `patchFlags`（只置 discarded）两条路径，当前调用点与旧行为一致，但契约需在代码注释中写明。

## W8 阶段、测试与门禁

### W8.1 阶段

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| **W-1** | 变更网关 + `log.jsonl` writer/replay + 崩溃尾行 + 迁移 | ✅ 2026-10-23 |
| **W-2** | 写前策略：只写完成态、64 KiB 截断、image_ref、封存态外置（M2/M1） | ✅ 2026-10-23（含 M0/M1） |
| **W-3** | 归档 patch、rewind truncate、compact_marker/usage | ✅ 2026-10-23 |
| **W-4** | meta/project 节流（P-14）；token_update 合并（M9）**否决** | ✅ 2026-10-23（P-14 落地；D9 见总体 §7 P9.1） |
| **W-5** | 冷会话归档（M5）：显式 CLI + 目录搬迁 + gzip | ✅ 2026-10-24（无 zstd；gzip 比 0.36–0.41） |

### W8.2 红测清单

**已交付（2026-10-23；W-1/W-2 已实现）**：

- `tests/config/log-jsonl-format.test.ts`：header、五种 op、非法记录、尾随换行、header 只读首行。
- `tests/config/log-jsonl-append-replay.test.ts`：追加不重写、空批次、session 仅首行、半条尾行、坏行、seq 缺口/重复、重放语义、写放大。
- `tests/config/log-jsonl-policy-migration.test.ts`：ephemeral/完成态、64 KiB 截断、图片 image_ref、v2→v4 迁移、备份、幂等、损坏不破坏、fork 迁移。
- `tests/session/log-mutation-gateway.test.ts`：SessionLog 变更网关（append/update/patch/truncate/compact_marker）、直接变更守卫、端到端“操作→写盘→重放==内存”、fork 独立。
- `tests/config/session-sidecar-throttle.test.ts`：P-14 跨分钟节流、内容不变跳过、紧凑 JSON、外部字段保留（5 例）；`tests/session/session-jsonl-persistence.test.ts` 增真实 `persistToDisk` 的同一分钟不重写断言。
- `tests/config/session-archive-cold.test.ts`：W-5 冷归档/还原/legacy 日志/五类守卫（4 例）；`tests/cli/cli-session-archive.test.ts`：CLI `sessions archive|restore` 端到端（2 例）。

**实现状态（2026-10-24）**：W-1 + W-2（含 M0/M1）+ W-3 + W-4（P-14）+ W-5（冷归档）+ **R-3 读侧分页**（`replaces` 契约、`persistence_policy=3`）+ **运行期切换全部落地**。`Session.persistToDisk` 首次写快照、之后 `peekPendingRecords` + append + commit；`loadLog` 优先 `log.jsonl`，只有 legacy 时自动迁移。TUI app/main、RPC、resume、子会话均改用新入口。全量 **1466 passed / 3 skipped**（2026-10-25）。M0 用 archive index 的 `hasPresentation + entryIds` 做 legacy 守卫，磁盘存根不碰内存；M1 按 4096 B 外置到 `sealed/`，归档剥离后回收 sidecar，archive 保留唯一一份密文。W-4 的 P-14 已落地：`last_active_at` 跨分钟才推进、meta 内容不变不重写、两处紧凑 JSON；`token_update` 合并（M9）经 P9.1 核实**否决**。**writer lock 与 seq 单调校验已落地（2026-10-25）；读侧 R-2/R-3 已接线（resume 有界、`/history` + 滚动加载、D20 索引完整）**。W-3 的真实压缩测试顺带修复了 `archiveEntries` 对已归档条目跳过入队的 bug。**W-5 冷会话归档已落地（2026-10-24）**：`src/config/session-archive.ts` + `SessionStore.archiveSession/restoreSession` + CLI `sessions archive|restore`；测试 6 例、4 条变异全红。门禁：typecheck / typecheck:tui / 全量 1466 passed / test:node / build（312 模块 0 循环）/ build:exe 全部通过；`runtime/dist` 冒烟（`.tmp/verify-built-log.mjs`）覆盖 JSONL 快照、P-14 紧凑且不重写、M1 sealed 读回、W-5 冷归档往返、D20 新索引 op、D13 fork 清理、P-5 legacy 列表头与 P-6 目录体积、D13 锁清理。**写侧收口审查（2026-10-24）**：修复 JSONL 可空字段 null 泄漏、fork 缺 meta 时元数据重建不完整、子会话中断正规化绕过网关（详见任务 §7.10）。**D10/D13/P-6 已收口（2026-10-24）**：`onSaveRequest` 统一返回 boolean、fork 清理继承的 rewind journal/`.data-*`、列表体积只统计已知类别。**写锁/seq/归档整理（2026-10-25）**：`log.jsonl.lock`、追加 seq 连续性校验、`archiveWindow` 改为纯写盘 + 网关单次归档、retained-meta 白名单统一为 `retainArchivedMeta`。**D22 显式 prune（2026-10-25）**：`sessions prune` 只清有 archive 正文/无正文结构条目的 marker 前前缀，原子重写并报告丢失 turn；不自动删除 archive/artifacts/sealed。



实现后仍需满足：

- 追加性：一次保存后 `log.jsonl` 只增长不重写（spy 文件写入偏移/大小；断言旧行逐字节不变）。
- 重放等价：`append/update/flags/truncate/compact` 全流程 → 重放 == 内存（深度相等）。
- 变更网关完整性：故意绕过网关直接改 entry → 测试必须红（freeze/断言）。
- 崩溃尾：截断最后一行/半行 → 加载成功、丢该条、其余完整。
- 只写完成态：流式 partial 不落盘；completed 只写一次。
- 截断/外置：>64 KiB 输出、≥4 KiB reasoningState、图片 → 日志只留引用，取回逐字等价。
- 迁移：v2 样例 → v4 重放等价；失败不破坏旧文件。
- 归档/回退：patch/truncate 重放后与现有语义一致（rewind 标记、undo-compact 闭环）。

### W8.3 门禁

`typecheck` / `typecheck:tui` / `npm test` / `test:node` / `build` / `find-cycles`；`build:exe` + `runtime/dist` 冒烟；写字节基准（W0 脚本）给出 6.65 MB / 50 MB / 200 MB 三档前后原始字节；resume 基准由读侧 R2 共同验收。

### W8.4 剩余工作（2026-10-25 盘点）

- **未使用导出**：`nextSeq`（仅测试）、`collectSealedRefs`（无消费者）、`prepareEntryForPersistence`（Session 使用更完整的私有实现）——按"不删看起来没用的代码"约定保留，作用见 §W10。
- **resume 期修复不落盘**：`validateAndRepairLog` 与中断正规化的就地修改只影响内存，policy=2 会话不会写回；每次加载重新推导。
- **迁移 + 归一化首次保存写两遍快照**：一次性开销；结论见 §W10。
- **保留策略（D22）**：日志与 artifacts 的总量上限未实现，见总体 D22 与任务 §12 P-18。

### W10 收口调查（2026-10-25）

**1）未用导出**

| 导出 | 作用 | 引用 |
| --- | --- | --- |
| `nextSeq(records)` | 从一批记录求 `max(seq)+1` | 仅测试；运行期用 `readLastSeq(dir)+1` 与 `snapshot.nextSeq` |
| `collectSealedRefs(entries)` | 收集 `meta.reasoningState` 里的 `sealedRef` | 无；`pruneSealed` 用 live entry id 集合，不需要反查引用 |
| `prepareEntryForPersistence(entry, dir)` | `shouldPersistEntry` + `capPersistedEntry` 的通用入口 | 无；`Session._prepareEntryForPersistence` 还需 M0 strip 与 M1 外置，因此另有一套 |

结论：三者都不是"第二套写路径"，只是通用 helper/诊断函数；当前保留，若后续允许删未用代码可一次性移除。

**2）迁移 + 归一化双快照**

数据流：`applySessionRestore` → `loadLog` → legacy 时 `migrateLogToJsonl` 写**第一份**原始快照（校验逐条等价后把 `log.json` 改名 `.pre-v4.bak`）→ `Session.persistToDisk` 发现 `persistencePolicy !== 3` → `writeSnapshot` 写**第二份**归一化快照（M0 剥离、M1 sealed、usage、policy=3）。

两份写是否必须：**不是必须，但当前是低风险选择。** 第一份负责"legacy → JSONL 的逐条校验 + 备份"；第二份负责"应用写前策略"。可以合并成一次写：在迁移时直接对 entries 应用 prepare，再用 `replay == prepared legacy` 校验；但迁移校验当前是"逐字节等价"，合并后要改成"归一化后等价"，并自己维护备份顺序。代价是每份旧会话一次性多写 6 MB ≈ 0.1 s / 200 MB ≈ 0.4 s；收益只是一次性 IO。**结论：暂不合并**；`log.jsonl` 始终是唯一权威，第一份只在毫秒级内被第二份原子替换，不存在两个长期快照，也不需要"其余地方引用同一快照"的额外机制。

**3）`hydrateArchivedDisplay` 与 full/legacy 启动全读**

- full/legacy 恢复时 `hydrateArchivedDisplay` 仍会读取所有含“已归档且 display 为空”条目的窗口。效果：启动时解压归档窗口、临时持有单窗口记录（helper 逐窗口处理），CPU/IO 与窗口总大小线性；不会把全部窗口同时驻留。
- 为什么需要：M0 把标记前条目的 display 从日志剥离，而 full/legacy 的 TUI 要一次渲染完整历史；不补齐就会显示空条目。
- 为什么不懒加载：bounded 路径已经按历史页懒读；full/legacy 没有分页，TUI 会投影全部条目，延迟读取需要视图层虚拟化，属于另一项 UI 改造。当前统一在 `loadArchivedDisplaysForEntries` 这一条读取路径上，只是 full 传入的条目集合是全部。

---

## W9 明确不做

- 不把 `reversePatch` 截断（回退事实来源）。
- 不逐条 fsync（P-8 已接受；需要时只做配置项）。
- 不引入 SQLite/索引库（会话规模不需要；读侧用反向扫描）。
- 不做自动分段/轮转（v1 单文件；冷压缩与归档负责长期体积）。
- 不按时间自动归档（W-5 只保留显式命令）；不做 zstd；冷归档只压活动日志，不动 `.pre-v4.bak`。
- 不保留 `log.json` 双读路径（迁移后单一权威）。
