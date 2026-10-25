# SwarmFlow 日志持久化 · 读侧设计

> 2026-10-23。本文只回答"启动/恢复、列表、TUI、回退、用量各读什么、读多少"。
> 写侧格式见 [LOG_WRITE_DESIGN.md](LOG_WRITE_DESIGN.md)，总体测量/问题/决策见 [LOG_PERSISTENCE_DESIGN.md](LOG_PERSISTENCE_DESIGN.md)。
>
> **状态（2026-10-25）**：R-1/R-2/R-3/R-4/R-5、M8 用量基线均已落地；resume 走有界路径，`/history` + 滚动到顶自动加载 + 顶部“更早 N 条”占位；页缓存 8 MiB 上限、归档 display 按窗口懒读已实现；D20 turn 索引接回退菜单。剩余：真实 TTY 验证（滚动/展开的目视行为）。

---

## R0 结论

- 当前 `--resume` 一次 `JSON.parse` 整个 `log.json`，再全表 repair、全表恢复 ID 分配器（[log-serialization.ts:222-266](src/config/log-serialization.ts#L222-L266)、[resume.ts:232-243](src/session/resume.ts#L232-L243)）。200 MB 档 loadLog 656 ms、repair 1279 ms，常驻 ≈ 文件的 1.5×。
- 目标：**模型上下文只读"最后一个 live compact_marker 及其之后"**；TUI 分页按需读；列表只读头部/`meta.json`；归档/封存态按需取回。
- 关键认知（来自 Codex）：有界恢复靠的不是 JSONL 本身，而是**检查点锚点**。我们已有 `compact_marker` 和 `findActiveWindowStart`（[active-context.ts:83-90](src/context/active-context.ts#L83-L90)），只缺读侧实现。
- 我们不采用 SQLite：本地会话规模小；反向扫描 + 一个可重建的 turn 索引足够（D20）。

目标（待 R0 基准确认）：200 MB 档模型上下文读取 < 50 ms、常驻 < 20 MB；列表永不整读日志；TUI 首屏 < 100 ms。

---

## R1 现状与证据

### R1.1 读路径

| 场景 | 现状 | 问题 |
| --- | --- | --- |
| 恢复/投影 | `loadLog` 整文件 `JSON.parse`（[log-serialization.ts:222-224](src/config/log-serialization.ts#L222-L224)），随后 repair 全扫（[resume.ts:243](src/session/resume.ts#L243)）、`LogIdAllocator.restoreFrom` 全扫（[log-serialization.ts:261-263](src/config/log-serialization.ts#L261-L263)） | 无边界；200 MB 档 656 ms + 1279 ms |
| 列表 | `meta.json` 缺失/坏时整读 `log.json`（[session-store.ts:246-265](src/config/session-store.ts#L246-L265)、[resume.ts:153-168](src/session/resume.ts#L153-L168)） | 坏一个 meta.json 就 6 MB × N |
| 体积 | `dirSize` 递归整个会话目录（[resume.ts:41-57](src/session/resume.ts#L41-L57)） | 与 artifacts 文件数线性相关 |
| TUI | `projectToTuiEntries` 吃完整 entries（[tui.ts:555-589](src/context/projection/tui.ts#L555-L589)） | 启动即全量驻留；与 P-4 同源 |
| 回退 | `getRewindTargets` 扫内存全量 log | 分页后需要 turn 索引（R3.4） |
| 用量 | projects × sessions 逐个整读 `log.json`（[session-store.ts:359-401](src/config/session-store.ts#L359-L401)），还带蛇形死分支 [:385](src/config/session-store.ts#L385) | P-11；与日志规模线性 |
| 修复 | `validateAndRepairLog` 第 4 步对每条 reasoning 全表扫（[log-repair.ts:199-225](src/config/log-repair.ts#L199-L225)） | P-9；200 MB 档 1279 ms |

**2026-10-24 现状**：resume 已走 `loadModelContext` 有界路径；`/history` + 滚动到顶自动加载可用；回退/文件回退前物化完整日志。`loadLog` 只保留给迁移/全量重建。列表的 JSONL 回退已改读 header（`readLogHeader`）；`dirSize` 仍递归。

**新增的读侧欠账（P-17，2026-10-23 实测）**：同进程 A/B（`.tmp/bench-jsonl-vs-legacy-read.mjs`）显示 JSONL 整读比 legacy 单次 `JSON.parse` **慢 1.06 / 1.14 / 1.27×**（5 / 50 / 200 MB 档，200 MB 档 820 → 1043 ms），代价来自"每条目一次 parse"（200 MB 档 77944 次）；换来的是驻留 **0.79–0.87×**。R-2 因此从"性能优化"升为"补债"。**已偿还（2026-10-24 实测）**：三档夹具整读 → 有界，5 MB 21→6 ms / 343 条、50 MB 171→37 ms / 2905 条、**200 MB 652→40 ms / 3063 条（16.2×，常驻 0.13×，扫描 7.7 MiB）**；resume 已走该路径。

### R1.2 已有的可用锚点

- `compact_marker` 条目由 `createCompactMarker` 生成，带 `meta.compactIndex/originalTokens/compactedTokens`（[factories.ts:331-345](src/context/entry/factories.ts#L331-L345)）；紧随其后的 `compact_context` 才是摘要正文。
- `findActiveWindowStart` 返回**最后一个 live marker 的索引 + 1**（[active-context.ts:83-90](src/context/active-context.ts#L83-L90)）——这说明模型上下文所需的就是"marker（含）+ 之后"。
- API 投影只在活动窗口内组装 `_reasoning_state`（[api.ts:331-356](src/context/projection/api.ts#L331-L356)），标记前的封存态永不发送（P-15 的前提）。

---

## R2 Codex 读侧（证据）

| 机制 | 证据 |
| --- | --- |
| 反向分块扫描 | `ReverseJsonlScanner` 从文件尾按 64 KiB 块读，跳过超大记录、容忍坏行（[reverse_jsonl_scanner.rs:11-80](external/codex/codex-rs/rollout/src/reverse_jsonl_scanner.rs#L11-L80)） |
| 检查点锚点 | `ModelContextScan` 从新到旧收集，停在"同时带 `replacement_history` 与 `window_number` 的最新 `CompactedItem`"；缺字段的旧检查点则退化为全量重放（[model_context.rs:1-59](external/codex/codex-rs/rollout/src/model_context.rs#L1-L59)） |
| 有界恢复 | paginated 线程按 lineage 分段反向扫描，每个 segment 用自己的 byte offset；收集完反转成时间顺序（[thread-store/model_context.rs:177-207](external/codex/codex-rs/thread-store/src/local/model_context.rs#L177-L207)） |
| 列表/分页 | SQLite 投影 + byte offset 游标；正文仍在 JSONL（[thread_history.rs:27-31](external/codex/codex-rs/thread-store/src/local/thread_history.rs#L27-L31)、[list.rs:199-277](external/codex/codex-rs/rollout/src/list.rs#L199-L277)） |
| 分段/血缘 | fork/revert 产生不可变 rollout 段，读取按 lineage 合并（[rollout_lineage.rs:14-30](external/codex/codex-rs/thread-store/src/local/rollout_lineage.rs#L14-L30)） |
| 冷文件 | 读取透明支持 `.jsonl.zst`（[lib.rs:69-73](external/codex/codex-rs/rollout/src/lib.rs#L69-L73)） |

**采纳**：反向扫描、检查点锚点、有界模型上下文、列表不读正文、分页游标、冷文件透明读。
**不采纳**：SQLite 投影（我们用一个可重建的小索引，见 R3.4）；自动分段（v1 单文件）。

**重要差异**：Codex 的 `CompactedItem` 必须自带 `replacement_history`，因为压缩后用摘要替换了历史。我们的 `compact_marker` 语义不同：**marker 之后就是活动窗口**，摘要正文是紧随其后的 `compact_context` 条目。因此我们只需反向扫到 marker（含），**不需要把替换历史塞进检查点**——这比 Codex 更简单，也避免了压缩时复制整个窗口。

### R2.1 Codex 如何处理 patch/truncate 与索引失效（2026-10-24 复核）

Codex 在持久化流里**尽量避免 patch/truncate**：

- **Legacy 线程**：回退不物理删行，而是追加 `ThreadRolledBack` 事件，读取时应用；turn 定位按 post-rollback 历史计算（[thread_rollout_truncation.rs:40-57](external/codex/codex-rs/core/src/thread_rollout_truncation.rs#L40-L57)）。app-server 侧回退同样在内存中移除最后 N 轮（[thread_history.rs:1373](external/codex/codex-rs/app-server-protocol/src/protocol/thread_history.rs#L1373)）。
- **Paginated 线程**：revert 新建一个**不可变 rollout 文件**，`history_base` 指向保留前缀，旧文件原样保留；唯一可变点是 SQLite 的 `rollout_path` 用 CAS 切换（[revert_thread.rs:15-18](external/codex/codex-rs/thread-store/src/local/revert_thread.rs#L15-L18)、[threads.rs:410-418](external/codex/codex-rs/state/src/runtime/threads.rs#L410-L418)）。新段 ordinal 从 `history_base.end_ordinal_exclusive` 继续（[ordinal.rs:23-32](external/codex/codex-rs/rollout/src/ordinal.rs#L23-L32)、[paginated_fork.rs:87-148](external/codex/codex-rs/thread-store/src/local/paginated_fork.rs#L87-L148)）。
- **派生历史是按 rollout 增量的投影**：`thread_history_projection_state` 保存 `next_byte_offset` + `next_ordinal`，物化只读新增字节并在一个事务里应用 ChangeSet（[thread_history_materialization.rs:22-76](external/codex/codex-rs/thread-store/src/local/thread_history_materialization.rs#L22-L76)、[thread_history.rs:50-103](external/codex/codex-rs/thread-store/src/local/thread_history.rs#L50-L103)）。投影按 rollout_id 存，revert 产生的新段不会让旧段失效。
- **模型上下文**仍停在"同时带 `replacement_history` + `window_number` 的最新 `Compacted`"；缺字段的旧检查点要求全量重放（[model_context.rs:30-58](external/codex/codex-rs/rollout/src/model_context.rs#L30-L58)）。
- 另有 writer lock（[writer_lock.rs:21-43](external/codex/codex-rs/rollout/src/writer_lock.rs#L21-L43)）、flush barrier（[recorder.rs:1811](external/codex/codex-rs/rollout/src/recorder.rs#L1811)、[:2111](external/codex/codex-rs/rollout/src/recorder.rs#L2111)）与 resume 快照版本校验（[history_revision.rs:1](external/codex/codex-rs/thread-store/src/local/history_revision.rs#L1)）。

**映射到我们**：`patch`/`truncate` 正是 Codex 设法避免的"可变记录"。完整对齐需要新段 + `history_base` + 稳定 ordinal（D18），当前不必要；D20.1–D20.3 用**事件化索引操作**模拟"不整读重建"的效果。`log.index.jsonl` 可重建、非权威，等价于 Codex 的 SQLite 投影，但我们仍不引入 SQLite（D20 成立）。

---

## R3 目标读架构

### R3.1 数据入口

```ts
readHeader(dir): LogSessionMeta;                    // ✅ 第一行 session 记录，≤64 KiB
loadModelContext(dir): ModelContextResult;          // ✅ 反向扫到最新 live marker（含），带 windowStartOffset
openTuiHistoryPager(dir, opts): TuiHistoryPager;    // ✅ 字节游标分页（R-3 读层）；loadLatestTuiPage 单页便捷入口
readTurnIndex(dir, expectedSeq): TurnIndexData|null; // ✅ log.index.jsonl（D20 完整）
readUsage(dir): UsageTotals | null;                 // ✅ meta.json.tokens（D8a）
```

`loadLog(dir)` 只保留给迁移/全量重建，不再出现在 resume/TUI/列表热路径。

### R3.2 有界模型上下文

反向扫描（64 KiB 块，复用 Codex 的扫描思路）从文件尾开始：

1. 收集 `upsert`/`patch`/`truncate`/`usage` 记录；
2. 维护"该 id 的最新记录"映射（同一 id 只看离文件尾最近的一条 upsert）；
3. 遇到 `truncate`：建立死区，跳过被截断的条目直到 `fromEntryId` 的 upsert；**截断之后追加的记录保留**（它们在文件里位于 truncate 之后，反向扫描时先被收集）；
4. 遇到 `type === "compact_marker"` 的最新 upsert：
   - `discarded === true`（或事后被 patch 丢弃）→ 继续向前找更早的 live marker；
   - `discarded !== true` → **停止**，返回 **marker（含）及之后**的重放结果。包含 marker 是因为 `activeWindowStartIdx()`/M0 剥离边界需要它；API 投影会忽略它；
5. 扫到文件头仍无 marker → 返回全部存活记录（`compact_count = 0` 的会话，行为与今天一致）。

**实现中补的两条规则**（设计稿未写，实测必需）：
- **归档 upsert 过滤**：压缩顺序是先追加 marker、再把标记前窗口的 `archiveEntries` upsert 到文件尾；这些 `archived: true` 的记录不属于当前窗口，反向扫描时过滤掉（最新 marker 之后不可能有合法归档条目）。
- **追加安全**：有界结果只含窗口条目，ID/work 计数器必须来自 `meta.json`（`id_counters` / `work_count`）；缺失时回退整读，下一次保存补写。恢复信号（工具计数、最近事件、上一轮状态、selfPhase）同样以 meta 快照优先。

重放规则：`upsert` 覆盖同 id 条目；`patch` 合并闭集 flags / 清 presentation；`truncate` 已在扫描阶段处理；`session` 只取最后一条。结果与 `entries.slice(最新 live marker 的索引)` 在全部夹具上深度相等（R3.2 红测）。

不读的内容：marker 之前的正文、`display`（除非该条目在窗口内且 TUI 需要）、归档/封存 sidecar（按需）。

### R3.3 TUI 分页（读层与 UI 接线均已落地）

**已实现（2026-10-24）**：`src/config/log-history.ts` 的 `TuiHistoryPager` / `loadLatestTuiPage`。按 64 KiB 反向扫描、字节游标续页；页大小默认 200 条 / 2 MiB（按**发射条目的序列化字节**计，更新后的大内容也会切页）；应用 patch（含 `dropPresentation`）与 truncate；`hasMore` 以 header 结束偏移为界，不产生空终止页。`upsert.replaces` 标志让更新后的条目回到创建位置。`startOffset` 必须传**行首**（UI 用 R-2 的 `windowStartOffset`）；连续翻页必须复用同一个 pager。实测首屏 **2.0–3.5 ms / 448 KiB**，前 10 页 **19–24 ms / 3.3–4.9 MiB**（与文件 3–128 MiB 几乎无关）。
**已完成**：`Session.getDisplayLog()` 合并历史页；`/history` 命令、**滚动到顶自动加载**与**顶部“更早 N 条”占位**（点击加载）均可用；页缓存按条目序列化字节限制在 **8 MiB**，达到上限后停止加载并显示“更早历史已达 8 MiB 缓存上限”；历史页 display 只读取涉及窗口（`loadArchivedDisplaysForEntries` 按 `entryIds`/turn 定位）。

**边界**：达到 8 MiB 后不再向更早翻页（`hasEarlierHistory=false`、`isHistoryCacheCapped()=true`）；不加入“半页”，保证已展示历史连续。

- 首屏（已实现）：反向取最后 N 条（N 默认 200，或 ≤2 MiB，取先到者）；顶部“更早 N 条”占位（已实现，点击加载）。
- 向上滚动/展开（已实现）：用字节游标再取一页；页缓存上限 8 MiB（已实现，达到即停止并提示）。
- 旧轮次若已被 `dropPresentation` 剥离：展开时调 `loadArchivedDisplay(turnIndex)` 从 `archive/` 只取 display（M0 R0.5），**不预载全部归档**。
- `projectToTuiEntries` 消费页数据；折叠占位与现有 `computeCompactFoldBoundary` 语义保持（[tui.ts:24-42](src/context/projection/tui.ts#L24-L42)），但折叠边界现在可以落在未加载页的边界上。
- 回退选择器：读取 R3.4 的 turn 索引，不依赖内存全量 entries。

### R3.4 turn 索引（D20）

回退、turn 列表需要"每个 turn 的起始条目/预览/文件增删"。两个选项：

- **(a) 反向扫描按需重建**：打开选择器时扫一遍文件，O(文件大小)；200 MB 档约 100–200 ms，可接受但不理想。
- **(b) 可重建索引 `log.index.jsonl`**：每个 turn 结束追加一条 `{turnIndex, startSeq, kind, preview, fileCount, additions, deletions}`；删除/重建不影响权威日志，索引丢失可全量重建。读取 O(turn 数)。
- **已选 (b)（2026-10-24）**：`log.index.jsonl`（`src/session/turn-index.ts`）。每 turn 一条 + mutation 摘要；带 `source_seq` 校验，patch/truncate/快照后失效重建，增量保存时追加。200 MB 档索引 113 KiB / 476 turn，读取 **0.6–3 ms**（整读重建 56–1066 ms）。 `turn_end` 批次会定稿该 turn 的完整记录与 mutation 摘要；无分页短会话（≤5000 条）在 turn_end 时自建索引，长日志/有界会话按需重建。
- **✅ D20.1–D20.3（2026-10-24）**：patch 翻译成 `drop-turn` / `drop-mutation` / `set-revert`（归档与 presentation 剥离类 patch 视为 no-op，`discarded:false` 等未知语义回退重建）；truncate 用索引里的 turn 边界算出 cutoff 并追加 `drop-turns-from`；快照保存后直接构建索引。Codex 的对照见 §R2.1，实现与测试见任务文档 §7.14。

### R3.5 列表、体积、用量

- `listSessions`：✅ 单一实现在 [session-list.ts](src/config/session-list.ts)：meta.json → JSONL header（`readLogHeader`）→ legacy header（`readLegacyLogHeader`，64 KiB 上限），正文非法也不影响列表。`SessionStore.listSessions` 与 `listSessionsForProject` 均委托它（I4.1），UTC 时间统一转本地 ISO；测试覆盖两入口 parity 与 JSONL/legacy/pretty/超限四种输入。
- `dirSize`：✅ 2026-10-24。只统计已知文件（`log.jsonl`/`log.json`/`.pre-v4.bak`/`log.index.jsonl`/`meta.json`）与已知目录（`archive/`/`images/`/`sealed/`），不递归 `artifacts/`（M4/R1）；测试断言新增 artifact 不改变 `sizeBytes`。
- 用量：✅ `meta.json.tokens`（保存时写入）是单一权威；缺失按 **D8(a)** 列入 `sessionsWithoutTokens`、不整读。全局统计已按此实现（2026-10-24）。
- 截断显示：`download` 等列表字段仍来自 meta.json，不触发正文读取。

### R3.6 修复与一致性

- 热路径只对"加载到的窗口/页"做轻量校验；`validateAndRepairLog` 的完整修复只在迁移、全量重建、索引重建时运行。
- M7 的 O(n²) ✅ 2026-10-25 已修（[log-repair.ts:197-231](src/config/log-repair.ts#L197-L231)）：一次预扫描建 `(turn,round)→有动作` 与 `round→turns` 两张表，第 4 步改查表。200 MB 迁移/重建不再撞二次方。
- **索引过滤规则**：只统计未丢弃且 `roundIndex !== undefined` 的 action 条目（`tool_call`/`tool_result`/`assistant_text`/`no_reply`）；reasoning 自身不得计入。`(turn,round)` 用组合键，第 4 步只查表，不再内层全表扫。
- **等价性不保留旧代码**：变更前采集 `tests/config/fixtures/log-repair-golden.json`（9 个边界夹具）；改后 10 例逐项相等（含同 turn 不同 round）。真实 4 份变更前哈希在改后 `entries/repaired/warnings` 全部一致（457/2978/8/1659 条）。
- **复杂度不只靠计时**：2000 条夹具读取计数由旧 1,412,800（706×N）降到 18,601（9.3×N），断言 ≤40×N；计时 ×2 <3.5×、×4 <8×（旧 16.96×，新 2.4–4.8×），仅作粗上界。
- **收益范围**：R-2/R-3 后 bounded resume 只 repair 活动窗口；R-5 的收益主要在 full/legacy 恢复、迁移与全量重建。1279 ms 是 full 场景，bounded 验收不要复用该数字。

### R3.7 归档、封存态、fork

- `archive/`：`loadArchivedMetaForTurns` 按 turn 取回 meta（[archive.ts:254-293](src/config/archive.ts#L254-L293)）；✅ display 读取由历史展开按需触发：新归档用 `window-N.index.json.gz.entryIds` 直接定位，旧索引按 turnIndex 缩小范围，无索引的旧窗口才兜底逐窗口读取；`hydrateArchivedDisplay` 与历史页共用同一 helper。
- `sealed/`：投影遇到引用时调 `resolveSealedState`，结果进 4 MiB LRU（M1/D4）；sidecar 缺失/损坏返回 null，消息走"不带封存态"分支并给 warning，不抛错。
- fork：✅ 复制 `log.jsonl` 后**重写第一行 header**（新 session_id/title/fork 来源），其余行原样复制；父文件不动。fork 缺 `meta.json` 时从 header 重建完整元数据（`buildLogHead`）。**继承的 rewind journal 与 `.data-*` 在复制后由 rewind 子系统丢弃**（D13），父会话保留；Codex 的 lineage 分段作为 R6 可选项（D18）。

### R3.8 冷文件读取（W-5 后：不需要透明读）

W-5 采用"归档时 gzip 活动日志、restore 时物化明文"，因此读路径**不需要**透明支持 `.gz`；代价是归档态会话不可 `--resume`，必须先 `sessions restore <id>`。若未来改成"归档态可直接 resume"，再补透明读与追加前物化（与 Codex 一致）。

---

## R4 读侧阶段与依赖

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| **R-1** | header 读取、列表/体积/用量的快路径（M4/M8 读侧） | ✅ 2026-10-24 列表 header + 用量 + `dirSize` 已知类别 |
| **R-2** | 反向扫描 + 有界模型上下文（P-4 核心） | ✅ 2026-10-24 API + resume 接线 |
| **R-3** | TUI 分页 + resume 接线 + display-only 归档 + D20 turn 索引 | ✅ 2026-10-24；占位/页缓存/归档懒读 ✅ 2026-10-25 |
| **R-4** | 封存态投影解析 + LRU（M1/D4） | ✅ 2026-10-23 已落地 |
| **R-5** | repair 索引化（M7）、usage 一致性（M8） | ✅ 2026-10-25（repair + usage） |
| **R-6** | fork lineage（可选，需授权）；冷文件透明读**不需要**（W-5 还原时物化） | — |

顺序建议：W-1 → R-1/R-2 → W-2 → R-4 → W-3 → R-3 → R-5。R-3 与 D20.1–D20.3 已落地；接下来优先 R-5/D7 与 R-1 的 `dirSize`。

---

## R5 测试清单

- **有界窗口**：三档夹具 + 真实 4 份，`loadModelContext` 与 `slice(最新 live marker)` 深度相等（已由 `tests/config/log-model-context.test.ts` 10 例覆盖，含扫描字节上限 `scannedBytes`）。
- **无 marker**：`compact_count=0` 的会话走全量，行为与今天一致。
- **截断/补丁**：truncate 之后的重放、discarded marker、archived patch、undo-compact 后 `_reasoning_state` 逐字回来。
- **分页**：`tests/config/log-history-pager.test.ts` **10 例**（首屏/上一页/补丁/创建顺序/truncate/字节上限/尾行/窗口起点/跨页 replaces/大 replaces 切页）；首屏实测 2–3.5 ms / 448 KiB。`tests/session/session-resume-bounded.test.ts` **7 例**覆盖 resume 有界与回退物化。
- **turn 索引**：`tests/session/turn-index.test.ts` **8 例**（构建/校验/增量/丢弃/坏行 + 三种新 op）+ `tests/session/session-turn-index.test.ts` **13 例**（有界首开、增量、turn_end 定稿、短会话自建、截断定向更新、seq 落后重建、归档 patch、文件回退双向、丢弃 turn/mutation、未知 patch 回退、首次快照建索引）。7 条定向变异全红。
- **列表**：✅ `tests/session/session-legacy-list-header.test.ts` 5 例——JSONL 坏行、legacy 坏正文、pretty 头部、头部超 64 KiB 回退、`SessionStore.listSessions` 路径；证明不解析正文。
- **体积**：✅ `tests/session/session-dir-size.test.ts`：已知类别精确求和；新增 2 MB `artifacts/` 文件后 `sizeBytes` 不变。
- **用量**：✅ meta.tokens 一致性；缺失走 `sessionsWithoutTokens` 且不整读（3 例）。
- **修复**：✅ M7 复杂度（×4 条目计时 16.96×→2.4–4.8×；确定性读取 706×N→9.3×N）+ 改前 golden 与改后 `entries/repaired/warnings` 逐项等价；不保留旧代码。
- **分页 UI**：✅ `tests/ui/opentui-history-banner.test.ts` 3 例（有更早/达到上限/子会话隐藏）+ `tests/session/session-history-cache.test.ts`（9 MB 历史在 8 MiB 处停止）。
- **归档懒读**：✅ `tests/config/archive-display-lazy.test.ts` 3 例（只读目标窗口、旧窗口无索引兜底、hydrate 复用同一路径）。
- **按需取回**：不展开旧轮次时归档/封存 sidecar 读取次数为 0；展开后逐字等价。
- **fork**：复制后的会话可独立读取；父目录删除后仍可恢复；✅ fork 不带继承的 rewind journal/`.data-*`，父会话保留。

变异检验：至少覆盖"反向扫描不停在 marker → 读到标记前数据/字节超标"、"truncate 被忽略 → 回退前的条目复活"、"分页预载全量 → 读取字节红"、"列表回退整读 → 非法 JSON 测试红"、"repair 改回全表扫 → 复杂度红"。

## R6 门禁

`typecheck` / `typecheck:tui` / `npm test` / `test:node` / `build` / `find-cycles`；`build:exe` + `runtime/dist` 冒烟；resume 峰值与耗时的原始字节报告（三档）；真实终端验证 TUI 分页/展开/回退（无 TTY 时明确标注未验证）。

## R7 明确不做

- 不引入 SQLite（D20 选 (b) 时也不引入）。
- 不做自动分段/轮转（v1 单文件）。
- 不做启动预加载归档/封存态。
- 不把 TUI 全量历史常驻内存。
- 不为旧 `log.json` 保留永久双读路径（迁移后单一权威）。
