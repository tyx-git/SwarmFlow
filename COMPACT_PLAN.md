# COMPACT_PLAN.md — 压缩提交、内存释放与续跑质量修复方案

> 状态：已按用户授权实施；Phase 1/2/3a/4/5 的源码与自动化门禁已完成。Phase 3b 冷区 entry shell 驱逐仍保持单独授权边界；真实 TTY 目视验收与对用户目录的实际迁移未执行。
> 基线（2026-10-25，当前工作树，HEAD `f153a52` 未提交改动）：
> `npm run typecheck`、`npm run typecheck:tui`、`npm run test:node`、`npm run build`、`npm run build:exe` 通过；全量 `npm test` **1500 passed / 3 skipped**；列表回归定向测试 **8/8**。
> 量测、已知脚本口径差异和未验证项见 §10；行号按当前工作树，以代码实际位置为准。
> 纪律：不 commit / merge / push；红测先行，期望值来自本方案而非实现；每个新测试配定向变异与负向探针；数据丢弃或行为变更先量化再确认；打包改动必须重建 release 并冒烟。

---

## 0. 核实结论

### 0.1 用户清单逐条核对

| 编号 | 结论 | 当前证据（文件:行）与说明 |
|---|---|---|
| **P0-1** 压缩提交不是事务 | **成立** | `doAutoCompact` 先追加 marker/context，再 `archiveWindow` → `archiveEntries` → strip → 清 token → `onCompactEnd`（`src/session/compact-flow.ts:316-403`）。手动作业把 post-commit 的 `onSaveRequest`、`_finishCurrentWork`、`appendCommandEcho` 也包在同一个 try（同文件 `167-191`），catch 用 `logLenBeforeCompact` 统一丢弃（`411-419`）。`SessionLog.touch()` 直接遍历监听器、不捕获异常（`src/session/log.ts:210-220`），TUI/进度/命令回调抛错即可触发。旧条目已 `archived=true, content=null`，marker/context 被标 discarded 后，API 投影从上一个 live marker 开始并过滤 `archived && content===null`（`src/context/projection/api.ts:91-99`），窗口永久消失。**已用临时测试复现**：监听器在归档翻转后抛错，live marker=0、旧条目 archived+null、投影只剩 system。 |
| P0-1 第二个原子性缺口 | **成立** | marker 与 compact_context 是两条独立 JSONL 记录，`appendRecords` 逐条 `writeSync`（`src/config/log-jsonl.ts:230-286`）；反向有界扫描遇到 marker 即停（同文件 `496-630`）；`validateAndRepairLog` 只清理最后一个 marker 之后的孤立 `compactPhase`，不校验 marker 是否有配对 context（`src/config/log-repair.ts:32-50`）。崩溃/ENOSPC 落在两条记录之间 → live marker 无 context → 下一轮只剩 system prompt。**注意**：首次保存/归一化走 `writeLogJsonlSnapshot` 的 tmp+rename（`log-jsonl.ts:787-846`），该缺口只影响增量追加路径。 |
| **P0-2** 压缩后内存未按预期释放 | **成立，但口径需精确** | `archiveWindow` 只归档 `content !== null && !archived` 的条目（`src/config/archive.ts:125-144`）；`archiveEntries` 只把 `content=null, archived=true`，不动 display/meta（`src/session/log.ts:345-356`）；`stripArchivedPresentation` 只按 TUI 折叠边界执行（`src/session/compact-flow.ts:379-385`），折叠阈值 3（`src/context/projection/tui.ts:12`、`24-42`）。**content 已释放；1–2 次压缩的 display/meta/工具元数据是 0 释放**，不是“整条 0 释放”。结构性条目（status/error/work_end/turn_end 等 `content=null`）永远不会被 `archiveWindow` 选中，因此永不 `archived`、永不 strip。`LOG_PERSISTENCE_TASKS.md` §1.5 的 33.2%–51.8% 是 marker 前 display+meta 的可剥上界；36.2% 是夹具里未归档条目仍常驻的 display+meta。**本文未重跑字节量测**，只确认代码路径与文档口径一致。 |
| **P1-1** 无效 continuation 被当成功 | **成立** | `runCompactPhase` 只判断 `if (result.text)`（`compact-flow.ts:268-300`），不 trim、不识别 `isNoReply`。`<NO_REPLY>` 的剥离只发生在 `runTurnActivationLoop`（`src/session/activation.ts:668-690`），压缩 phase 走 `_runActivation`，绕过该段。末尾 `"[Compact phase did not produce a continuation prompt.]"`（`compact-flow.ts:302-304`）在 `detectTurnDefect` 下多半不可达，但仍是同类“哨兵当 continuation”的死代码，应删除。 |
| **P1-2** window 序号复用 | **成立** | 文件名 `window-${_compactCount-1}.json.gz`（`compact-flow.ts:374`、`331-337`）；恢复时 `compactCount: meta.compactCount`（`src/session/log-surgery.ts:710-719`）；`persistToDisk` 先追加日志、后写 `meta.json`（`src/session.ts:2658-2664`），崩溃窗口里 meta 计数落后于 live marker；失败压缩在 `doAutoCompact` 内先自增 `_compactCount`（`compact-flow.ts:328`）；rewind 后 `_resetAfterRewind` 用 live marker **个数**重算（`src/session.ts:2353-2363`），不是 `max(compactIndex)+1`。live marker 索引出现 `0,2` 这类空洞时，下一次压缩可生成索引 2 并与仍存活的 marker 2 撞车；`_restoreArchivesRescindedBy` 按 `compactIndex` 读窗口（`src/session.ts:2274-2281`）会恢复到错误内容。 |
| **P1-3** 一次 write_file 多份副本 | **成立** | 同一份新内容/旧内容同时存在于：`tool_call.content.rawArguments`（`src/agents/tool-loop/run.ts:355-365`）、`tool_call.meta.toolStreamSections`（`run.ts:371-394`、`streaming-arguments.ts:335-352`，完成后不清理）、`tool_call.meta.fileModifyData.writeLines`（`run.ts:502-519`、`src/patches/hunk.ts:277-290`）、`tool_result.meta.toolMetadata.tui_preview.newContent`（`src/tools/file-write.ts:124-138`）、`tool_result.meta.toolMetadata.fileModifyData.writeLines`（同文件）、`fileMutation.reversePatch`（`src/tools/mutations.ts:366-383`）。图片 `_contentBlocks` 在 append 时内联（`src/session/tool-drain.ts:227-232`、`run.ts:724-727`），仅落盘时由 `capPersistedEntry` 外置（`src/config/log-write-policy.ts:108-123`）。TUI 已声明 result 侧 `fileModifyData` 为权威（`external/opentui/presentation/transform.ts:284-292`）。 |
| **P1-4** 归档读取失败静默降级 | **成立** | `_restoreArchivesRescindedBy` 的 catch 保留 `archived=true, content=null`（`src/session.ts:2266-2286`）；`_installArchivedMeta` 读失败直接吞掉（`src/session.ts:1827-1839`），回退计划缺 mutation，`rewindFiles` 可能返回成功但不回退文件；`restoreArchivedEntries` 用归档快照整体替换 meta（`src/session/log.ts:359-374`），会覆盖运行时写入的 `fileMutationReverted*`。现有 `tests/session/session-archive-lifecycle.test.ts:67-99` 明确锁定“归档缺失时静默降级”，这是需要翻转的旧行为。 |
| **P1-5** before_turn 卷走当前用户消息 | **成立** | 用户消息先入日志（`src/session.ts:3893-3901`），随后 before_turn compact（`3910-3938`）；归档范围包含这条消息（`compact-flow.ts:360-378`）。能否活下来完全取决于模型摘要。 |
| **P1-6** 无 usage / mid_turn 自激 | **成立** | `budget <= 0` 直接禁用自动压缩（`src/session/context-manager.ts:68-96`），不报错；`_lastInputTokens` 只在 provider 返回 >0 时更新（`src/session/activation.ts:307-314`、`628-631`），本地/代理不返回 usage 时 before_turn 永远按 0 判断。mid_turn 压缩后 `activationIdx = -1; continue`（`activation.ts:732-759`），把 30 次 activation 预算清零；没有每 turn 压缩次数上限，也没有压缩后阈值复检。 |
| **P2** 状态复位不完整 | **成立** | `runCompactPhase` 在 try 之前设置 `_compactInProgress=true`（`compact-flow.ts:219`）并调用 `onCompactStart`、追加 prompt（`221-237`）；若这些抛错，`finally`（`305-307`）不会执行，会话永久卡在 compact。失败也不发 `compact_end`（`399-402` 只在成功路径）。手动 body 的 `_installCurrentTurnSignal` / `_agentState` / `_beginWorkIfNeeded` 也在 try 之前（`162-166`）。 |
| **P2** 归档写入峰值/非原子 | **成立** | `writeArchiveFile` 构造整个数组 → `JSON.stringify` → `gzipSync` → `writeFileSync` 直接写最终路径（`src/config/archive.ts:59-68`、`src/config/gzip-json.ts:6-8`）；window 与 index 分两次写；半截 gz 会被读取侧当成缺失/损坏。 |
| **P2** 失败尝试仍落盘 | **成立** | `discardCompactAttemptEntries` 只 `patchFlags({discarded:true})`（`compact-flow.ts:411-419`）；`shouldPersistEntry` 不检查 `discarded`（`src/config/log-write-policy.ts:39-46`），`getLogForPersistence` 返回 `_log` 全量（`src/session/restore.ts:177-238`）。反复失败会把完整压缩提示/推理/工具输出一直写入日志。 |
| **P2** continuation/task snapshot 无上限 | **成立** | `continuationPrompt + taskSuffix` 直接成为 compact_context（`compact-flow.ts:346-358`），没有长度/token 上限；超大摘要会让下一轮立刻再压缩。 |
| **P2** `/compact` 的“turn 仍在运行”拦截 | **基本成立** | 命令注册为 `queued`（`src/commands/registration.ts:54`）；`runManualCompact` 先在锁内才检查 blocker（`compact-flow.ts:126-139`）。运行中输入会排队，锁后 `_agentState` 通常已 idle，该分支基本不可达；属于文案/契约问题，不是压缩正确性问题。 |
| **P2** 旧兼容路径 | **成立** | 启动 `hydrateArchivedDisplay` 全量补齐（`src/session/resume.ts:152`）、无 entryIds 的归档索引兜底、`hasPresentation` 守卫、`restoreArchiveToEntries` 缺失字段容忍等。**已定案：新版本不做旧压缩/归档格式兼容，直接删除**（旧会话迁移/硬丢见 §4）。 |
| **已核实无问题** | **成立** | API 严格从最后一个 live marker 开始并过滤 discarded/archived+null（`api.ts:65-99`）；`reachedMaxToolRounds`/`suspendedAsk` 在写 marker 前显式拒绝（`compact-flow.ts:255-266`）；失败清理按索引区间（`411-419`）能覆盖 meta 被整体替换的条目；成功后 per-response token 清零、恢复只认最近 marker 之后（`compact-flow.ts:391-397`、`log-surgery.ts:616-633`）；有界恢复过滤 marker 后补写的 archived upsert / discarded marker / truncate 死区（`log-jsonl.ts:486-630`）；turn lock 串行化 `/compact` 与 turn；归档 display 已支持按需读取，历史页有 8 MiB 上限。实施后的测试与门禁结果见 §10。 |

### 0.2 本次核实新增的发现

**A1. “保留 meta 白名单”不足以支撑扩大剥离。**
`RETAINED_ARCHIVED_META_KEYS` 只有 `contextId/providerRoundId/fileMutationReverted/bashMutationReverted/bashMutationRevertedIndices`（`archive.ts:155-170`）。如果按 P0-2 把 marker 前全部条目 archive + strip：

- `token_update` 的 `inputTokens/totalTokens/cacheReadTokens/cacheCreationTokens/cacheSupported` 丢失 → 累计用量/用量页错误；
- `agent_result` 的 `agentId/outcome/cause/elapsedMs` 丢失 → `_indexChildOutcomesFromLog` 无法对账；
- `tool_call/tool_result` 的 `toolCallId/toolName` 丢失，而 `validateAndRepairLog` 会扫描**全量**条目（不跳过 archived，`log-repair.ts:52-109`）→ 可能把 `undefined === undefined` 当成配对、或合成 `tr-recovered-undefined`；
- `compact_marker` 的 `compactIndex/originalTokens`、`ask_request` 的 `askId/toolCallId`、`input_received/turn_start` 的 `inputKind/turnKind` 也可能被消费。

**结论：P0-2 不能只改 strip 边界；必须先做 full-log consumer 审计，选择“跳过 archived”或“扩展保留键”，并加契约测试。** 推荐：`validateAndRepairLog` 跳过 archived 条目（冷区由归档/回退恢复完整 meta）；`token_update` 保留 token 字段；`agent_result` 保留身份字段；其余靠“跳过 archived”解决。

**A2. full/legacy 恢复会在启动时把 display 又读回来。**
`applySessionRestore` 无条件调用 `hydrateArchivedDisplay`（`resume.ts:152`）；full/legacy 路径会读取全部归档窗口并回填 display（`archive.ts:332-346`）。如果 P0-2 把 marker 前 display 清空，这一路径会把释放的内存又搬回来。必须改为按历史页懒加载（R-3 已有 `TuiHistoryPager` + `loadArchivedDisplaysForEntries`），或只对 bounded 窗口做启动补齐。

**A3. archive 文件与 index 不是同一个提交单元。**
`archiveWindow` 先写 `window-N.json.gz`，再写 `window-N.index.json.gz`（`archive.ts:137-143`）。任一步失败/半写，读取侧会降级或误判“旧归档”。新的 checkpoint 提交协议必须要求“archive + index 都完整存在”才能 append checkpoint；最好合并成单一 envelope。

**A4. `writeArchiveIndex` 对空窗口直接返回。**
如果窗口只有 `content=null` 结构性条目，`entries.length===0` 时不会写 index（`archive.ts:109-117`），`hasPresentation/entryIds` 缺失，M0 不会剥离。扩大 archive 到结构性条目时必须写 index（即使没有 content）。

**A5. `stripEntryForPersistence` 的 M0 已经会影响 full 恢复的 repair。**
当前 M0 在落盘时把 marker 前 archived+capable 条目的 meta 剥到白名单（`session.ts:2500-2524`、`2546-2550`）。bounded 恢复只加载活动窗口，问题不显现；但缺计数器/旧 policy/legacy 回退到 full 时，`validateAndRepairLog` 会扫描被剥掉 `toolCallId` 的 archived 条目。A1 的“跳过 archived”修复对当前 M0 也适用，不只是 P0-2。

---

## 1. 目标与非目标

### 目标

1. **提交原子性**：一次压缩要么完整提交（archive + checkpoint + continuation），要么完全不改活动窗口；任何 post-commit 异常都不能留下空洞。
2. **内存按预期释放**：1 次压缩后，marker 前的 content/display/meta/工具重复副本不再常驻；TUI 通过历史分页按需取回。
3. **续跑质量**：最新用户消息、最后 assistant 文本、最后工具结果确定性保留；无效 continuation 不得清空历史；任务/运行体状态实时可见。
4. **可观测与可回退**：压缩/归档/回退失败必须可见；rewind 不能“成功但没回退”；token/compacted 记账准确。

### 非目标（本方案不做）

- 不换压缩模型、不引入第二套摘要层级、不改 system prompt 的缓存策略。
- 不删除旧归档格式，直到完成迁移审计（见 §5）。
- 不在本方案中做自动总量配额、冷段、zstd；这些属于 D22/D18。
- 不把 TUI 折叠阈值当成存储清理边界；两者解耦。

---

## 2. 核心设计决策

### D1. 用单一 `compact_checkpoint` 记录替代 marker + context 两条记录

**决定**：新增 JSONL record `op:"compact_checkpoint"`，一条记录同时携带：

```text
checkpointId, markerId, compactIndex, originalTokens, compactedTokens?,
continuation, taskSuffix?, archiveFile, archiveIndexFile?,
scenario, hideMarker?, prevMarkerId?, createdAt
```

提交时只追加这一条。读取时在内存中展开为 `compact_marker` + `compact_context` 两个条目，保持 API/TUI 投影、rewind、turn index 的现有形状不变。

**理由**：消除“marker 无 context”的崩溃窗口；bounded reverse scan 停在 checkpoint 时自带 continuation，无需配对；`committed` 有唯一判据。

**兼容**：**不做旧日志兼容**。新写入一律 checkpoint；旧 marker/context 检测到即显式失败（见 §4/D9），不配对、不静默丢弃、不回退到上一窗口。

**备选**：context 先写、marker 后写。能缩小窗口，但仍需配对校验，且不能解决 post-commit 回滚；不选。

### D2. 归档文件按 checkpoint/marker id 命名，`compactIndex` 只作展示

**决定**：新归档文件名 `archive/window-<checkpointId>.json.gz`（或 envelope 的 `window-<checkpointId>.jsonl.gz`），checkpoint 的 `archiveFile` 字段是唯一权威。`compactIndex` 保留用于 UI/旧格式，但不再参与文件名。

**理由**：彻底消除 `compactCount` 落后/rewind 空洞/失败自增导致的窗口号复用。`compactIndex` 冲突只影响显示，不影响数据。

**兼容**：**不读旧 window-N**。新写入只用 checkpoint id 文件名；旧文件名检测到即显式失败（见 §4/D9）。

**备选**：`compactIndex = max(live/discarded markers)+1`。能缓解但不能根治 bounded 恢复看不到旧 marker 的问题；不选为主方案。

### D3. 提交顺序：archive 完整 → 追加 checkpoint → 再改内存/剥离

**决定**：

1. 生成 continuation（不写 marker/context）。
2. 写 archive 到 tmp，`fsync`（可选）后 rename 到最终文件；index 同文件或同批完成。
3. 追加 `compact_checkpoint` **一条记录**——这是唯一 commit point。
4. 内存中展开 marker/context；旧窗口 `archiveEntries`（content=null, archived=true）。
5. strip marker 前的 presentation/meta（按 D8）。
6. 更新 per-response token / compactedTokens / meta（`compactCount/nextCompactIndex`）并保存。

**规则**：checkpoint append 成功前失败 → 旧窗口不动；checkpoint append 成功后失败 → 压缩已提交，**不得** discard marker/context，只能把 strip/meta 失败作为可重试的后台/下次保存动作。

**理由**：当前顺序是“先改内存/写 marker，再 archive”，任何 post-commit 异常都会把 marker discard 而旧 content 已 null。新顺序把不可逆的 archive 写放在 commit 之前，把可重建的 strip 放在 commit 之后。

### D4. 失败清理：物理截断未提交区间，不再只打 discarded

**决定**：`doAutoCompact` 返回 `{ status: "committed", checkpointId }` 或抛 `CompactError { committed: false }`。只有 `committed:false` 才允许清理。清理用 `SessionLog.truncateFrom(firstAttemptEntryId)`（`log.ts:320-342`）物理截断本次尝试写入的连续尾部区间，并持久化 `truncate` record；若区间已被自动保存写入，truncate 重放会覆盖。

**理由**：`discarded` 不阻止 `shouldPersistEntry`，反复失败会把完整 prompt/推理/工具输出写进日志。物理截断同时解决内存和落盘。

**边界**：只截断尝试区间；不能截断用户输入或压缩前条目。若 checkpoint 已提交，禁止截断。

### D5. continuation 合法性：无哨兵、无 `<NO_REPLY>`、有最小长度

**决定**：新增 `validateContinuation(text)`：

- `trim()` 后非空；
- `!isNoReply(text)`，且不包含 `<NO_REPLY>`；
- 不等于 `"[Compact phase did not produce a continuation prompt.]"`；
- 长度 ≥ `MIN_CONTINUATION_CHARS`（**已定案：200 字符，无小窗口例外**）；
- 不包含 `[SYSTEM: COMPACT REQUIRED]` 等压缩阶段控制文本。

失败抛 `CompactPhaseEmptyError`；**不写 checkpoint、不写 archive、不归档**，旧窗口保留，向用户/进度报可见错误。删除末尾字符串 fallback。若会话太短、模型无法产出 200 字符的合法 briefing，按“压缩失败但旧窗口保留”处理，不降级为短哨兵。

**备选**：用固定哨兵判断。字符串哨兵会漂移；用显式错误类型，不选字符串。

### D6. 逐字 tail：由代码确定性追加，不依赖模型摘要

**决定**：在 checkpoint 的 continuation 后追加一段：

```text
[VERBATIM TAIL — reference only]
Latest user message (verbatim; <scenario label>):
...
Last assistant message (verbatim):
...
Last tool result (verbatim excerpt; mid_turn only):
...
```

- 最新真实用户消息：`inputKind === "user"`、非 `compactPhase`、非 system notice；上限 4k 字符，超限保留头尾并标注 `…[N chars omitted]…`。
- 最后 `assistant_text`：排除 `compactPhase`；上限 4k。
- mid_turn 最后 `tool_result`：`toolSummary` + content 摘录，上限 2k。
- 手动压缩：标签为“已答复，仅供参考，不要重新回答”；before_turn/mid_turn：标签为“当前请求，继续它”。
- 压缩提示同步更新：“逐字 tail 会自动追加，不要重复它；把篇幅留给周围状态”。
- **已定案 caps：4k / 4k / 2k 字符**，不做比例下调。若 checkpoint + tail + 静态前缀估算后剩余工作空间 < 40%，不缩短 tail，而是拒绝本次 commit、保留旧窗口并报错；需要更小摘要时由用户显式手动压缩并给指令。

**理由**：摘要无法保证精确路径/命令/常数；代码提取是唯一确定性保真层。上限防止巨大粘贴把压缩后上下文再次撑爆。

### D7. 实时任务/运行体状态块，替代 compact_context 里的静态任务快照

**决定**：从 compact_context 移除 `[Current Tasks]` 快照；在每次请求的历史之后追加一个 `[RUNTIME STATE]` 块（ephemeral tail，带 `_ephemeral_tail`，不写日志、不破坏缓存前缀）：

- open tasks：id、role、status、owner、有效 blockers（过滤已完成）；已完成最多 3 条或不列；
- active child agents：id、template、status、最后一条摘要；
- running shells：id、status、log 路径；
- 标签：“只读参考，不要当成新的用户请求”。

**理由**：任务/运行体状态是“当前世界”，不是“压缩时快照”；自动压缩可能在子代理/shell 运行时发生。实时块避免重启后旧快照与对账通知冲突。

**兼容**：不做旧格式兼容（见 §4）。新写入不再生成静态任务快照；压缩提示改为“任务/运行体状态由运行时另行提供，不要在 continuation 中重复 id/status”。

### D8. 内存释放边界与保留键

**决定**：

1. `archiveWindow` 目标改为窗口内**全部**条目（含 `content=null`），记录完整 `{id, content, display, meta}`；index 始终写 `entryIds`（即使没有 content）。
2. checkpoint commit 后，对窗口内全部条目 `archiveEntries`（content=null, archived=true）。
3. `stripArchivedPresentation` 的边界改为“最后一个 live checkpoint/marker 之前”，与 TUI 折叠阈值解耦；对全部 archived 条目 strip display/meta。
4. **采用混合策略，不做二选一**：
   - **跳过 archived**：所有“推导/修复/副作用”型 full-log consumer 不再扫描冷区；旧数据由 archive/index/meta 提供。首批至少包括 `validateAndRepairLog`、`aggregateTokenUsage`、`_generateSummary`、`rebuildRuntimeSignalsIn`、`_indexChildOutcomesFromLog`、`listTurns`、`_aggregateEntryMutations`。
   - **保留最小索引键**：仅在“实时路由/回退”必须不读 archive 才能工作的条目上保留标量键：`contextId`、`providerRoundId`、`fileMutationReverted*`、checkpoint/marker 的 `archiveFile/compactIndex`。
   - **不逐条保留 token_update**：把累计用量折成 `meta.tokens`/一个 `usage` base（现有 `meta.tokens` 已有 input/output/cacheRead；需要补 firstInput/firstUserMessageTokens 的读取路径），而不是让每条 token_update 继续背 5 个数字。
   - `agent_result` 优先使用 child meta/signals；若审计发现缺口，再保留 `agentId/outcome/cause` 三个标量键，不保留 display/content。
   - `tool_call/tool_result` 的 `toolCallId/toolName` **不保留**；repair 必须跳过 archived，避免 `undefined === undefined` 误配对。
   - `statusType` 等 TUI 展示字段：优先写进 archive index/display 快照；若历史页确需，再作为小键保留。
5. TUI 默认只渲染活动窗口；更早历史用 `TuiHistoryPager` + `loadArchivedDisplaysForEntries` 按需取回 display。旧工具结果的完整 content 需要时从 archive 读取（新增 lazy content loader，或明确只显示 display 摘要）。
6. 全量恢复不再无条件 `hydrateArchivedDisplay`；改为按历史页/展开项懒加载，或仅 bounded 窗口启动补齐。
7. **两阶段内存目标**：3a 先剥 content/display/大 meta，保留轻量 entry shell；3b 若量测显示 shell 对象/索引仍显著，再把冷区 entry shell 从 `_log` 驱逐到紧凑索引，按需从 archive/log 页取回。3b 需要单独授权，不与 3a 同批。

**跳过 vs 保留的影响（定案依据）**：

| 维度 | 跳过 archived | 保留键 |
|---|---|---|
| 内存 | 最省：冷区只留极轻索引/shell；display/大 meta 可完全释放 | 每个 archived 条目仍背 meta 对象；token_update 占 20% 条目，逐条保留 5 个数字不划算 |
| 正确性 | repair/usage/summary 不会对冷区做副作用；但所有消费方必须审计，漏一个会静默丢数据 | 旧消费方少改；但白名单是跨模块契约，漏键同样静默丢数据；repair 仍会扫描/可能改冷区 |
| 归档失败 | archive/index/meta 必须完整；失败可见（Phase 2 前置），符合“不要静默降级” | 保留键会掩盖 archive 缺失，容易回到当前静默降级 |
| 复杂度 | 一次性审计面较大，但边界清晰：冷区=archive | 改动小，但长期双源、键名单漂移，且内存收益更低 |
| 适用 | **推荐作为默认** | 仅用于 checkpoint/marker 路由、revert 标记、必要的 usage/agent 聚合 |

**结论**：不是“全跳过”或“全保留”，而是 **skip for derivation/repair + retain minimal routing/aggregate**。这样既拿到主要内存收益，又避免把 archive 失败藏在保留键后面。

**D8.1 定案清单（2026-10-25，用户确认）**：

- 推导/修复类 consumer 全部跳过 archived：repair、usage、summary、signals、outcomes、turns、mutations。
- 只在必须不读 archive 的路由/标记上保留标量键：`contextId`、`providerRoundId`、`fileMutationReverted*`、checkpoint 的 `archiveFile/compactIndex`。
- 累计用量折成 `meta`/usage base，不逐条保留 `token_update`。
- `agent_result` 优先用 child meta；只有测试发现缺口才保留 `agentId/outcome/cause`。
- 不保留 `display/content/toolCallId`；TUI 历史从 archive 按需取。
- 增加 `FULL_LOG_CONSUMERS` 契约测试：每个 consumer 必须声明“跳过 archived”或“需要的键”，用 stripped archived fixture 驱动。

**D8.2 `FULL_LOG_CONSUMERS` 契约测试规格**：

- 文件建议：`tests/config/full-log-consumers.test.ts`（按现有测试目录约定落位）。
- 每个 consumer 暴露一个声明：`{ name, skipsArchived: true }` 或 `{ name, requiredKeys: [...] }`；测试遍历声明，未声明的 full-log consumer 直接失败（新增 consumer 必须显式登记）。
- 正向 fixture：一个 live checkpoint + 一个已归档窗口；archived 条目的 `display/meta` 已 stripped；archive 文件与 index 完整。
- 负向 fixture：archive 缺失/损坏；必须由 Phase 2 的失败路径接管，不得静默返回空结果。
- 断言：
  - skip 型 consumer 的行为与“冷区不存在”一致；
  - requiredKeys 型只读取声明键，不读取 display/content；
  - `validateAndRepairLog` 不对 archived 生成 synthetic `tool_result`/`ask` 结果；
  - `_generateSummary` 不退化为 `"New session"`（必须从 meta.summary/title 或活动窗口取）；
  - `aggregateTokenUsage` 与 `meta.tokens`/usage base 一致；
  - `_indexChildOutcomesFromLog` 与 child meta/signals 一致；
  - `listTurns`/`_aggregateEntryMutations` 与 archive index 一致。
- 变异：把 skip 改成全量扫描、删掉一个 requiredKey、archive 缺失仍成功，三条必须红。

**量化门禁**：先跑 `.tmp/measure-log-waste.mjs`、`.tmp/measure-persist-disk.mjs`、`.tmp/bench-resume.ts`，记录“当前常驻 / strip 后可释放 / archive gzip 增长 / TUI 分页延迟 / 归档写入峰值 / 冷区 shell 对象开销”。若 archive 增长超过释放量的 20%，或 TUI 分页明显退化，先调整保留键/页大小再继续。

### D9. loader/repair 规则（无旧格式兼容）

**决定**：

- 新 checkpoint：天然配对，无需检查；bounded reverse scan 停在 checkpoint。
- **不读取旧 marker/context/window-N 格式**。遇到旧压缩记录或旧归档文件名，加载/恢复必须**显式失败**并提示“需要迁移或使用旧版本导出”，不得静默丢弃旧窗口、也不得把它当成无压缩历史继续跑。
- `validateAndRepairLog` **跳过 `archived` 条目**：它们是冷区，完整 meta 在 archive 中，回退时由 `restoreArchivedEntries` 恢复；不得对 stripped meta 做 tool/ask 合成。
- `_indexChildOutcomesFromLog`、`aggregateTokenUsage`、`_generateSummary`、`rebuildRuntimeSignalsIn` 等 full-log consumer 必须显式声明“跳过 archived”或“使用 meta/archive 派生”，并进 `FULL_LOG_CONSUMERS` 契约测试。
- `_computeUsageStats`/`usageTotals` 使用 `meta.tokens`/usage base 作为冷区基线；不得依赖被 strip 的 token_update meta。
- **当前 M0 已存在同风险**：M0 落盘会剥 archived 条目的 `toolCallId`；full 恢复时 repair 可能误配对或合成 `tr-recovered-undefined`。`skip archived` 必须先于 P0-2 落地并加红测，不是等扩大 strip 才做。

### D10. 归档写入原子化与流式化

**阶段 1（P0 必需）**：`writeArchiveFile`/`writeArchiveIndex` 改为 temp + `renameSync`；先写 archive，再写 index，二者都成功才允许 checkpoint append。失败清理 tmp。

**阶段 2（P0-2 内存优化，已定案）**：单一 gzip JSONL envelope（header + 每条 entry 一行 + trailer index），用 `createGzip` + `pipeline` 流式写，避免 `JSON.stringify`/`gzipSync` 全量峰值。**不做 v1 JSON array 读取兼容**；Phase 1 如仍写 JSON array，只是新归档的编码选择，不是旧格式兼容；Phase 3 切 envelope 后，旧 JSON array 归档走一次性迁移（见 §4）。

**理由**：P0-1 的 commit 需要 archive 完整；P0-2 的大窗口需要低峰值。分两步降低一次性风险。

### D11. rewind/归档失败必须可见

**决定**：

- `_restoreArchivesRescindedBy`：回退范围内任一窗口缺失/损坏/解析失败 → **失败**，保留 rewind journal，列出窗口文件；不得把 archived+null 留在被恢复的窗口里。
- `_installArchivedMeta`：计划范围内 archive meta 不可读 → `planRewind`/`rewindFiles` 失败；不得以空 lookup 生成“成功但无 mutation”的计划。
- `restoreArchivedEntries`：恢复 archive 的 content/display/meta 时，用当前条目的保留键覆盖归档快照（尤其 `fileMutationReverted*`），不要整体替换。
- 测试：现有“归档缺失静默降级”用例改为期望失败；新增 corrupt/missing/partial 三种；新增 revert flag overlay。

### D12. 无 usage 的压缩与 mid_turn 配额

**决定**：

- `onTokenUpdate` 只在 >0 时更新 per-response 快照；新增 `estimatedContextTokens` 兜底：
  - before_turn：`_lastInputTokens` 为 0 时，用 `estimateEntryTokens` 估算活动窗口 + system/tools 估算；
  - mid_turn：provider 的 `inputTokens/outputTokens` 都为 0 时，用同一估算；估算缓存按日志 revision 失效，避免每轮全扫。
- `budget <= 0`：UI 明确显示“auto-compact unavailable: invalid model context budget”，不要静默。
- **触发阈值（已定案 2026-10-25）**：统一为默认上下文预算（`budgetInfo().budget`；非 full_context 时已扣除 `maxTokens` 输出余量）占用 >80%，`compact_before_turn` 与 `compact_mid_turn` 都取 80（当前默认 85/90，`src/config/compact-thresholds.ts:23-27`）。这是一次行为变更：压缩更早、更频繁，换来 20% 工作余量。
- **成本门禁**：Phase 4 用真实会话统计 85/90 → 80/80 的压缩次数与摘要 token 增量；当前实现已统一为 80/80，实际压缩次数与摘要增量尚未在带 provider usage 的真实生产回合中单独采样。
- **每 turn 自动压缩上限 3 次（已定案 2026-10-25）**：同一个 `turn()` 内，自动压缩（`before_turn` + `mid_turn`）合计最多 3 次；只统计已提交的 checkpoint，失败尝试不计数；手动 `/compact` 不计入、也不重置配额。`runManualCompact` 复用 `doAutoCompact("before_turn", ...)`（`src/session/compact-flow.ts:168-173`），因此必须给调用加 `origin: "auto" | "manual"`，不能按 scenario 判断。
- **达到上限时**：第 4 次自动触发不进入 compact phase、不写 archive/checkpoint，抛 `CompactTurnLimitError` 并结束 turn；保留当前上下文，提示用户“发送新消息开新 turn”或手动 `/compact`。配额在下一个 `turn()` 从 0 重置，不持久化。
- 压缩后复检：估算 `system + tools + checkpoint + 逐字 tail`；若仍高于 80%，立即抛 `CompactDidNotReduceContextError` 并结束 turn，不再消耗后续配额（提示换更大窗口/手动 prune）。若已低于 80%，本回合后续再次越线仍可在 3 次配额内压缩。

**“每 turn 压缩上限”指什么**：同一个用户回合内自动压缩被触发的次数。它与阈值正交：阈值决定“什么时候压”，上限决定“同一回合最多压几次”。当前实现没有上限——mid_turn 压缩后 `activationIdx = -1; continue`（`src/session/activation.ts:732-759`）会把 30 次 activation 预算清零（`activation.ts:31`、`574`），所以同一回合可以反复压缩。上限 3 次拦住“正常但过长的回合”反复摘要；压缩后复检拦住“压完仍超阈值”的单次无效压缩（例如 system+tools 本身就超过 80%，或 usage 估算错误）。两者配合：前者限制总次数，后者在第一次没有进展时立即止损。

### D13. 压缩状态机与进度

**决定**：`CompactAttempt` 状态：

```text
preparing → archiving → committed → stripping → done
                  ↘ failed(uncommitted)
                              ↘ failed(committed)
```

- `_compactInProgress=true`、`onCompactStart`、prompt append、signal/agentState 安装全部进入 try/finally。
- `onCompactEnd` 在 finally 中**恰好一次**发送，携带 `status/committed/originalTokens/compactedTokens?/error?`。
- `doAutoCompact` 返回 `{status:"committed", checkpointId}`；`runManualCompactBody` 只在 `committed:false` 时 truncate；post-commit 的 `onSaveRequest`/`finishWork`/`appendCommandEcho` 异常只 warning，不 discard。
- `compactedTokens` 记录压缩后估算；marker/checkpoint/progress 使用它，不再固定 0。

---

## 3. 分阶段实施

### Phase 0 — 基线、夹具与红测（不改生产代码）

- 固定基线：初始 typecheck、全量 1466/3 skipped、压缩/归档定向 80/80；实施后的最终结果见 §10。
- 新增红测（先红在预期原因）：
  1. P0-1 post-commit listener/save/finish/echo 抛错 → 不得出现“live marker=0 且旧条目 archived+null”的空洞；理想结果：旧窗口完整或新 checkpoint 完整。
  2. P0-1 marker-only / context-only / marker+错 context → repair 后不得留下无 continuation 的 live marker。
  3. P0-2 1 次压缩后 marker 前 display/meta/结构性条目未释放 → 断言仍常驻（先红），作为后续修复的基线。
  4. P1-1 `<NO_REPLY>`、空白、哨兵、过短 continuation → 不得 commit/archive。
  5. P1-2 meta 落后 / rewind 空洞 → 下一次压缩不得复用仍被 live marker 引用的 window 文件。
  6. P1-4 缺失/损坏 archive → rewind 必须失败并保留 journal（翻转旧测试）。
  7. P1-5 before_turn → 最新用户消息的唯一 sentinel 必须逐字出现在 compact_context。
  8. P1-6 provider usage=0 → before_turn/mid_turn 用本地估算触发；同一回合自动压缩第 4 次触发必须报错结束；压缩后复检仍 >80% 必须报错结束，不得再次压缩。
  9. P2 失败尝试 → 不得以完整 prompt/推理/工具输出落盘；重放后日志应只有 truncate 后的状态。
- 每个红测配变异：把修复点改回旧行为必须红；负向探针：正常压缩不得被误杀。

### Phase 1 — 提交协议与窗口身份（P0-1、P1-2）

1. **1.1 schema**：`log-jsonl` 增加 `compact_checkpoint` record、校验、codec、replay 展开；bump `LOG_JSONL_VERSION`。**不保留旧 marker/context record 的运行时读取**；旧格式检测到即显式失败（见 §4）。
2. **1.2 commit 顺序**：`doAutoCompact` 拆成 `prepareContinuation → writeArchiveAtomic → appendCheckpoint → applyInMemory → strip → finalize`；返回 `committed`。
3. **1.3 archive 原子写**：archive/index 先写 tmp 再 rename；两者成功才 append checkpoint；失败清理 tmp；A4 空 index 也要写。
4. **1.4 失败清理**：`discardCompactAttemptEntries` 改为 `truncateCompactAttempt(attemptStartEntryId)`，物理截断 + truncate record；只有 uncommitted 调用。
5. **1.5 marker id 文件名**：新 archive 用 `window-<checkpointId>.json.gz`；checkpoint 存 `archiveFile`。**不读取旧 `window-N` 文件名/旧 index**；旧格式检测到即失败。
6. **1.6 next index**：新 checkpoint 的 `compactIndex` 取 `lastCheckpoint.compactIndex+1`（bounded 用最后 checkpoint；full 用 max+1）；`_compactCount` 只作展示；rewind 后不得用 count 生成文件名。
7. **1.7 loader/repair**：新 checkpoint 天然配对；**不做旧 marker/context 配对兜底**，检测到旧压缩记录即显式失败并提示迁移/使用旧版本导出；`validateAndRepairLog` 跳过 archived（D9）。
8. **1.8 post-commit 异常**：manual body 的 post-commit 操作只 warning；`onCompactEnd` 失败不影响 committed 状态。
9. **1.9 测试**：red tests from Phase 0 + mutation：
   - 监听器在 archive 后抛错 → 新 checkpoint 或旧窗口完整，无空洞；
   - crash 模拟：只写 checkpoint 不写 context（新格式天然通过）；
   - 旧 marker/context/window-N 格式 → 显式 `E_COMPACT_FORMAT_LEGACY` 失败，不静默丢弃/继续；
   - meta.compactCount 落后/rewind 0,2 空洞 → 新 archive 文件名唯一，rewind 读对；
   - post-commit echo 抛错 → marker/checkpoint 保留。
10. **门禁**：`typecheck`、全量测试、`log-jsonl`/`log-repair`/`session-archive` 定向、`test:node`。

### Phase 2 — 回退/归档失败可见（P1-4）

1. `_restoreArchivesRescindedBy` 失败即抛，保留 journal；错误列出窗口文件。
2. `_installArchivedMeta` 读取失败即抛；`rewindFiles` 不得返回空成功。
3. `restoreArchivedEntries` overlay 当前保留键，不整体替换 meta。
4. 翻转 `session-archive-lifecycle` 的“静默降级”用例；新增 missing/corrupt/partial/overlay 四类。
5. 门禁：Phase 3 扩大剥离前必须绿；否则不进入内存优化。

### Phase 3 — 内存释放与 TUI 活动窗口（P0-2、P1-3）

1. **3.1 archive 全覆盖**：窗口全部条目入 archive（含 content=null），index 写全量 entryIds；`archiveEntries` 标 archived；A4 修复。
2. **3.2 strip 解耦**：strip 边界改为最后一个 live checkpoint/marker；TUI 默认只渲染活动窗口；`TuiHistoryPager` 懒加载更早 display；full 恢复不再全量 `hydrateArchivedDisplay`。
3. **3.3 full-log consumer 契约**：按 D8 的混合策略，逐个 consumer 标记“跳过 archived”或“使用 meta/archive 派生”；新增 `FULL_LOG_CONSUMERS` 契约测试（用 stripped archived fixture 驱动），锁住 `validateAndRepairLog`、`aggregateTokenUsage`、`_generateSummary`、`rebuildRuntimeSignalsIn`、`_indexChildOutcomesFromLog`、`listTurns`、`_aggregateEntryMutations` 的行为；`archive-meta-contract` 只锁最小保留键。
4. **3.4 工具元数据**：tool 完成时清 call 侧 `toolStreamSections`/`fileModifyData`；`tui_preview.newContent` 改有界预览（首尾 N 行 + 省略）；`writeLines` 只留一份或按需；`reversePatch` 归档按需读；`_contentBlocks` 在 append 时外置为 image_ref（复用 `extractAndSaveImages`），投影时 resolve。
5. **3.5 archive 原子/流式**：temp+rename 在 Phase 1 已完成；本阶段引入单一 gzip JSONL envelope + 流式写。**不保留 v1 读**（与 §4 的硬切一致）；Phase 1 若仍写 JSON array，切 envelope 时旧归档走 §4 的一次性迁移。测峰值 RSS/文件完整性。
6. **3.6 量化**：按 D8 跑真实会话/夹具；记录释放/增长/分页延迟/峰值；超过门槛先停下调整。
7. **3.7 TUI 活动窗口（已定案）**：`projectToTuiEntries` 默认只渲染活动窗口；更早历史通过顶部 banner/PageUp/滚动加载 `TuiHistoryPager` 页；折叠阈值不再决定存储剥离边界。测试：1 次压缩后旧条目不在默认投影、banner 计数来自 index、PageUp 懒加载 display、8 MiB 页缓存上限。
8. **3.8 冷区 shell 驱逐（可选，需单独授权）**：若量测显示 archived entry shell 对象仍显著，再把冷区 shell 从 `_log` 驱逐到紧凑索引，按需从 archive/log 页取回；不与 3a 同批。
9. **门禁**：typecheck / typecheck:tui / 全量 / test:node / build / build:exe / runtime 冒烟；`archive/` 往返逐字等价；rewind 恢复 display/meta/content；真实 TTY（无 TTY 时明确记录“未目视验证”）。

### Phase 4 — 质量与配额（P1-1、P1-5、P1-6、P2）

1. **4.1 continuation 校验**：`validateContinuation`、删除 fallback、`CompactPhaseEmptyError`、不 commit；测试 no-reply/空白/哨兵/过短。
2. **4.2 逐字 tail**：D6 的确定性提取、caps、场景标签、prompt 更新；测试唯一 sentinel、头尾截断、manual 不重答、mid_turn tool result。
3. **4.3 实时状态块**：D7 的 open tasks/agents/shells；移除 compact_context 的静态 `[Current Tasks]`；测试任务更新即时可见、重启不冲突。
4. **4.4 usage 兜底与阈值**：D12 的估算、UI 警告、单 80% 阈值、每 turn 自动压缩上限 3、压缩后复检；测试 usage=0、连续 mid_turn 第 4 次报错、手动 `/compact` 不计数、压后仍超阈值报错。
5. **4.5 长度记账**：continuation + task snapshot 上限；`compactedTokens` 估算并写入 checkpoint/marker/progress；超限不静默 commit。
6. **4.6 `/compact` 文案**：锁前预检或明确“排队到当前回合结束”；低优先级。
7. **门禁**：全量 + 新增质量测试；变异：去掉 tail/校验/实时块/估算/cap 各一条必须红。

### Phase 5 — 发布与旧会话迁移（无运行时兼容）

前置：Phase 1/2/3 绿；新格式在夹具/定向会话上稳定；发布说明明确“旧压缩格式不兼容”。

1. **不保留旧压缩格式运行时读取**：旧 marker/context/window-N 检测到即抛 `E_COMPACT_FORMAT_LEGACY`，提示迁移或使用旧版本导出；不得静默丢弃旧窗口，也不得把它当成无压缩历史继续跑。
2. **旧会话处理（已定案 A）**：一次性离线迁移 `sessions migrate-compact`。实现了只读旧 marker/context/window-N、写 checkpoint + marker-id archive、校验 content/display/meta/continuation 的迁移命令；转换器仅由 CLI 动态加载，不进入运行时 resume/load。当前工作树只验证了迁移夹具，未对 `~/.swarmflow` 执行实际数据迁移。
3. **清理项**：旧配对兜底、window-N 读取、启动 `hydrateArchivedDisplay`、无 entryIds 索引兜底、`hasPresentation` 守卫、`restoreArchiveToEntries` 缺失字段容忍，全部删除。
4. **保留**：`RETAINED_ARCHIVED_META_KEYS` 作为唯一最小白名单 + `FULL_LOG_CONSUMERS` 契约测试。
5. **范围**：本硬切只覆盖压缩/归档格式；`log.json` legacy / JSONL policy 迁移是另一条线，不在本次移除范围（除非另行确认）。
6. **门禁**：旧会话迁移/拒绝行为抽样；新会话 `resume`/`rewind`/`fork`；全量测试；发布产物冒烟。

---

## 4. 迁移与兼容（硬切）

1. **新版本只读新格式**：`compact_checkpoint` + `window-<checkpointId>`；旧压缩格式不读，检测到即失败并给出迁移/旧版本导出提示。禁止静默丢弃、禁止把旧窗口当无压缩历史。
2. **旧版本不读新格式**：bump `LOG_JSONL_VERSION`，`meta.json` 写 `compaction_format: 2`；旧版本遇新格式明确报“需要升级”。**无读写双轨、无 feature flag 回退读旧格式。**
3. **旧会话迁移（已定案 A）**：一次性迁移命令 `sessions migrate-compact` 在发布前按运维窗口执行；本次源码已提供并覆盖迁移/回滚/安全边界测试，但未修改用户目录中的实际会话。不采用“旧会话不可 resume”的硬丢方案。
4. **fork**：只支持新格式；旧会话先迁移；fork 后 checkpoint id 继续递增，不继承父会话 writer lock（已有 D13）。
5. **回滚**：新格式没有旧版本读取路径，回滚需保留旧二进制；发布前确认可接受。
6. **数据不可逆点**：strip 后的 display/meta 只能从 archive 恢复；archive 损坏/缺失必须失败可见（Phase 2 先行）。任何“删除 archive”的维护命令不在本方案。

---

## 5. 量化门禁（Phase 3 前必须交数）

用现有脚本/夹具，至少三条真实会话 + 三档夹具：

- `.tmp/measure-log-waste.mjs`：按 `content/display/meta/toolMetadata/…` 分类的常驻字节；1 次/2 次/3 次压缩会话分别统计。
- `.tmp/measure-persist-disk.mjs`：strip 前后 `log.jsonl` 字节、archive gzip 字节、sealed/artifacts/images 总量。
- `.tmp/bench-resume.ts`：bounded/full resume 的耗时与常驻峰值。
- 新增：archive 写入峰值 RSS、TUI 历史页读取字节/延迟、8 MiB 页缓存命中。

输出一张表：`当前常驻 → strip 后可释放 → archive 增长 → 净磁盘变化 → TUI 延迟`。若净收益不明确或 archive 增长 > 释放量 20%，暂停 Phase 3 的“全量 strip”，先只做“结构性条目归档 + 工具元数据清理”的小步版本。

---

## 6. 待授权决策点

| 编号 | 决策 | 状态/推荐 | 备注 |
|---|---|---|---|
| D-A | 单一 `compact_checkpoint` vs context-first 两记录 | **已定案：单一 checkpoint** | 2026-10-25 用户接受；旧版本不读新格式，新版本不读旧格式 |
| D-B | 归档文件名用 checkpoint id vs `compactIndex` | **已定案：checkpoint id** | 移除 window-N/旧 index 读取，不做兼容 |
| D-C | archive 编码：JSON array → gzip JSONL envelope | **已定案：Phase 3 切 gzip JSONL envelope**；不做 v1 读 | 与 D-A 的硬切一致；Phase 1 可先 JSON array + temp/rename，发布前统一为 envelope |
| D-D | 扩大 strip 后 full-log consumer 策略 | **已定案：skip for derivation/repair + retain minimal routing/aggregate** | 见 D8.1/D8.2；`FULL_LOG_CONSUMERS` 契约测试为门禁 |
| D-E | TUI 默认只渲染活动窗口 | **已定案：是**；更早历史按页加载 | 需要真实 TTY 目视验收 |
| D-F | 逐字 tail caps / continuation 最小长度 | **已定案：4k / 4k / 2k；min 200 chars，无小窗口例外** | — |
| D-G | 触发阈值与每 turn 上限 | **已定案：触发只看默认上下文预算 >80%；before_turn/mid_turn 统一 80；同一回合自动压缩上限 3 次（含 before_turn，不含手动 `/compact`）；第 4 次触发报错结束；压缩后复检仍 >80% 立即报错** | 当前默认 85/90 将改为 80/80；语义见 D12 |
| D-H | 旧会话迁移方式 | **已定案：A 一次性离线迁移 `sessions migrate-compact`** | 迁移后删除旧文件与迁移代码；B 不采用 |
| D-I | 冷区 entry shell 驱逐（Phase 3b） | **已定案：Phase 3b，量测显示 shell 对象仍显著后单独授权** | 不与 3a 同批 |

---

## 7. 验收清单

### P0-1

- [ ] 归档翻转后监听器/保存/进度/echo 任一抛错：不存在“live marker=0 且旧条目 archived+null”的窗口；要么旧窗口完整，要么新 checkpoint 完整。
- [ ] checkpoint 追加是唯一 commit point；post-commit 异常只产生 warning，不 discard。
- [ ] 旧 marker/context/window-N 格式：显式 `E_COMPACT_FORMAT_LEGACY` 失败并提示迁移/旧版本导出；不静默丢弃、不产生 system-only 窗口。
- [ ] 失败尝试物理截断；重放日志不包含完整压缩 prompt/推理/工具输出。

### P0-2 / P1-3

- [ ] 1 次压缩后，marker 前 content/display/meta/结构性条目按 D8 释放；TUI 默认只渲染活动窗口，历史页可展开并取回 display。
- [ ] archive 记录包含完整 `{id,content,display,meta}`；index 对空/结构性窗口也写 entryIds。
- [ ] full/legacy 恢复不再启动全量 hydrate；history pager 按需读取。
- [ ] `FULL_LOG_CONSUMERS` 契约：repair/usage/summary/signals/outcomes/turns/mutations 全部声明并验证“跳过 archived”；未声明的新 consumer 直接失败。
- [ ] 仅保留 `contextId/providerRoundId/fileMutationReverted*/checkpoint archiveFile+compactIndex` 等路由标量键；不保留 display/content/toolCallId。
- [ ] 累计用量与 `meta.tokens`/usage base 一致；不逐条保留 token_update。
- [ ] `agent_result` 与 child meta/signals 一致；未出现为补缺口而保留 `agentId/outcome/cause` 的例外。
- [ ] TUI 历史从 archive 按需取 display；启动不再全量 hydrate。
- [ ] write_file 同一内容常驻副本从 5–6 份降到 ≤2 份（活动窗口 + archive），并有字节量化。
- [ ] 归档写入 temp+rename；峰值 RSS/半截 gz 测试通过。

### P1

- [ ] `<NO_REPLY>`/空白/哨兵/短于 200 字符：不 commit、不 archive、旧窗口保留、错误可见。
- [ ] meta 落后/rewind 空洞/失败自增后，新 archive 文件不与 live marker 冲突；rewind 读对。
- [ ] 缺失/损坏 archive：rewind 失败、journal 保留、窗口文件列出；不出现“成功但没回退”。
- [ ] before_turn：最新用户消息唯一 sentinel 逐字出现在 compact_context；超长头尾截断。
- [ ] usage=0：本地估算触发；阈值统一 80%；同一回合自动压缩 ≤3，第 4 次触发报错结束；手动 `/compact` 不计数；压缩后复检仍 >80% 立即报错，不自激。

### P2 / 质量

- [ ] `_compactInProgress`、agentState、signal 在所有路径复位；`compact_end` 恰好一次。
- [ ] `compactedTokens` 有真实估算；progress/marker 不再固定 0。
- [ ] 实时状态块：任务更新/子代理/shell 在下一请求可见；不烘进 compact_context。
- [ ] continuation/task snapshot 有上限；超限不静默 commit。
- [ ] `/compact` 排队语义与文案一致。

### 门禁

- [ ] `npm run typecheck`、`npm run typecheck:tui`、`npm test`、`npm run test:node`、`npm run build`、`npm run build:exe`。
- [ ] `runtime/dist` 冒烟：JSONL checkpoint 往返、checkpoint-id archive 往返、旧格式显式失败、rewind 失败可见、strip/restore、fork。
- [ ] 真实 TTY：多轮工具 + 1 次 `/compact` + `--resume` + 历史展开 + 回退。没有 TTY 时明确记录“未验证”，不声称完成。
- [ ] 每个新测试有定向变异 + 负向探针；期望值来自本方案，不来自实现。

---

## 8. 明确不做

- 不用字符串哨兵当 continuation，不保留 `"[Compact phase did not produce...]"` fallback。
- 不只打 `discarded` 而不物理截断失败尝试。
- 不在 rewind/归档失败仍静默降级时扩大 strip。
- 不用 `compactCount` 生成归档文件名。
- 不在没有 full-log consumer 审计/保留键契约前 strip token_update/agent_result/tool/ask 元数据。
- 不把 TUI 折叠阈值当存储清理边界。
- 不在本方案中引入自动总量配额、zstd、冷段。
- 不做旧压缩格式的运行时兼容：不读旧 marker/context、不读 window-N、不做双轨/feature flag；旧会话按 §4 的迁移或硬丢处理。
- 不 commit / merge / push；本次实施已获授权，但真实 TTY 与用户目录迁移仍按 §10 的边界处理。

---

## 9. 决策记录

| 日期 | 决策 | 结论 |
|---|---|---|
| 2026-10-25 | 压缩格式兼容 | 旧版本不读新格式；新版本不读旧压缩/归档格式；移除运行时兼容逻辑 |
| 2026-10-25 | 归档文件命名 | 按 checkpoint id 命名；移除旧 window-N 逻辑 |
| 2026-10-25 | TUI 默认范围 | 只渲染活动窗口；更早历史按页懒加载 |
| 2026-10-25 | 逐字 tail / continuation | 4k / 4k / 2k；最小 200 字符，无小窗口例外 |
| 2026-10-25 | 扩大 strip 后 full-log consumer | 混合：推导/修复类全部跳过 archived；仅保留路由/标记标量键；usage 折成 meta/usage base；agent_result 优先 child meta；不保留 display/content/toolCallId；新增 `FULL_LOG_CONSUMERS` 契约测试 |
| 2026-10-25 | 旧会话迁移 | A：一次性离线 `sessions migrate-compact`；迁移命令与回滚/安全测试已实现，实际用户目录迁移留给发布运维窗口；B 不采用 |
| 2026-10-25 | archive 编码 | Phase 3 切 gzip JSONL envelope；不做 v1 读 |
| 2026-10-25 | 触发阈值 | 统一为默认上下文预算 >80%（before_turn/mid_turn 均 80），替换当前 85/90 |
| 2026-10-25 | 每 turn 压缩上限 | 自动压缩（before_turn + mid_turn）合计最多 3 次；第 4 次报错结束；手动 /compact 不计数；复检仍 >80% 立即报错 |
| 2026-10-25 | 冷区 entry shell 驱逐 | Phase 3b，量测显示 shell 对象仍显著后单独授权 |

## 10. 实施回写与门禁证据（2026-10-25）

### 10.1 已实施范围

- JSONL 版本升级到 v5；`compact_checkpoint` 成为唯一压缩提交点，运行时严格拒绝旧 marker/context/window-N 压缩格式。
- archive 使用 checkpoint id 命名的单一 gzip JSONL envelope；失败写入采用临时文件与 rename，checkpoint 追加前不改变活动窗口。
- repair、usage、summary、signals、outcomes、turns、mutations 等推导/修复 consumer 跳过 archived；usage 折入 meta/base；`FULL_LOG_CONSUMERS` 契约测试已加入。
- TUI 默认活动窗口与历史分页、8 MiB 历史缓存上限、archive display/content 懒加载已接入；工具结果图片 append 时外置并在 API 投影恢复，路径穿越与 symlink escape 有负向测试。
- continuation 最小 200 字符、逐字 tail 4k/4k/2k、默认 80% 阈值、自动压缩每 turn 上限 3、压缩后 workspace guard 与 v4 离线迁移命令已接入。
- 冷会话归档在读取日志前取得 session 单写者锁，并在目录搬迁后的新路径释放锁；图片外置仅接受 png/jpeg/gif/webp/bmp MIME，恶意 MIME 路径有回归覆盖。
- Phase 3b 冷区 entry shell 驱逐未实施，保持单独授权边界。

### 10.2 自动化门禁

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run typecheck:tui` | PASS |
| `npm test` | PASS：172 test files，1500 passed，3 skipped |
| `npm run test:node` | PASS：2/2 |
| `npm run build` | PASS |
| `npm run build:exe` | PASS：生成 `release/SwarmFlow-win32-x64/SwarmFlow.exe` |
| `node dist/src/cli.js --help` | PASS |
| `release/SwarmFlow-win32-x64/SwarmFlow.exe --help` | PASS |
| 会话列表定向回归 | PASS：8/8；覆盖 v4/v5 header 与 pre-v5/pre-compact backup size allowlist |

### 10.3 量化结果

- `.tmp/measure-persist-disk.mjs`：5/50/200 MiB 夹具的 M0+M1 日志分别减少 44.6%/40.3%/38.1%；含 sealed 等已存在磁盘数据的净变化为 -19.3%/-19.1%/-18.3%，合计日志 -38.5%、总量 -18.1%。marker 后条目逐字不变均为 `true`。
- `.tmp/measure-log-waste.mjs`：当前 4 个真实会话合计 12.87MB；重复 display 0.22MB（1.7%），marker 前封存 reasoning 1.25MB（9.7%），已归档 meta 1.51MB。
- `.tmp/measure-cold-gzip.mjs`：5/50/200 MiB 夹具整体 gzip 比 0.41/0.39/0.36，均低于 0.6 门槛，保留 gzip 有收益。
- v5 分页 probe：5.64/53.94/217.54MB 文件首屏均返回 200 条，扫描 0.69/1.31/1.31MB，耗时 4.2/6.5/8.1ms，均继续提供更早历史。
- 原 `.tmp/bench-history-pager.mjs` 直接作用于 v4 夹具时返回 0 条并扫描全文件；这是旧夹具被 v5-only parser 拒绝的预期表现，不作为新格式性能结果。迁移 probe 另发现该夹具引用缺失的 `window-0.json.gz`，因此未把它冒充迁移成功样本。
- `.tmp/bench-resume.ts` 仍按旧 `log.json`/旧 loader 假设，直接作用于上述夹具会因 v5-only loader 报 `log.jsonl has no session record`；未将该失败归因于生产实现，待后续重写为 v5 fixture benchmark。
- 已知中风险：`readGzipJsonlEnvelopeIndex` 当前仍通过同步 `gunzipSync` 物化完整 envelope，再取 trailer index；功能正确但超大 archive 的 index-only 路径会产生全量解压瞬时峰值。未采用私有 zlib API、子进程或大范围同步 API 异步化绕过，需单独设计可验证的流式/可寻址 index 方案。

### 10.4 未验证与外部操作边界

- 未进行真实 TTY 目视验收：多轮工具、`/compact`、`--resume`、历史展开与回退组合尚未人工操作验证。
- 未对 `~/.swarmflow` 现有用户会话执行 `sessions migrate-compact`；只验证迁移夹具、回滚、路径安全和运行时拒绝行为。实际迁移属于会修改用户数据的运维操作，应在发布窗口单独执行并抽样复核。
- 本次未执行 commit、merge 或 push。
