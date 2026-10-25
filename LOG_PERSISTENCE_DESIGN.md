# SwarmFlow 日志持久化总体设计

> 2026-10-23 重构：详细设计拆为写侧与读侧两份。
>
> - 写侧：[LOG_WRITE_DESIGN.md](LOG_WRITE_DESIGN.md)（格式、追加、崩溃、迁移、写放大）
> - 读侧：[LOG_READ_DESIGN.md](LOG_READ_DESIGN.md)（有界恢复、分页、列表、用量、修复）
> - 执行：[LOG_PERSISTENCE_TASKS.md](LOG_PERSISTENCE_TASKS.md)
>
> **状态（2026-10-25）：写侧 W-1…W-5（含写锁、seq 校验）、读侧 R-1…R-5（含分页 UI/页缓存/归档懒读/repair 索引化）、D8(a)/D10/D13/D19/D20 均已落地并接线；D22 显式 prune 已落地。** 本文保留原基线与决策记录；剩余工作集中在 D22 的自动总量配额、真实 TTY 验证与 I4.1（已完成），清单见任务文档 §13。

---

## 0. 一句话结论

当前日志是"单个 JSON 对象、每次检查点整份重写、恢复时整份解析"：**写放大 462×**（6.65 MB 会话写 3.00 GiB），200 MB 档 **2.4 TiB**；恢复时 200 MB 档 `loadLog` 656 ms、repair 1279 ms，常驻 ≈ 文件的 1.5×。

采纳 Codex 的两条主线：

1. **写侧 append-only JSONL**：只追加变更记录，不重写历史；写前过滤/截断/外置；不逐条 fsync；崩溃靠尾行修复。
2. **读侧有界反向扫描**：模型上下文只读到最后一个 live `compact_marker`；TUI 分页；列表只读 header/`meta.json`；归档/封存态按需取回。

预期：写放大从 462× 降到接近 1×；200 MB 档模型上下文读取从 656 ms 降到 <50 ms；列表永不整读日志。**以上是实现目标，不是已实现结果。**

**实施进度（2026-10-24）**：W-1 + W-2 基础策略 + W-3 + **运行期切换全部落地**。`Session.persistToDisk` 首次写快照、之后增量追加；`loadLog` 优先 `log.jsonl` 并自动迁移 legacy；TUI/RPC/resume/子会话均改用新入口；选择器/用量/存储修复兼容 JSONL。全量 **1466 passed / 3 skipped**（2026-10-25）。M0（标记前 presentation 不落盘）+ M1（封存态外置）已落地；W-4 的 P-14 伴生文件节流已落地；`token_update` 合并经 P9.1 核实**否决**（两类消费者语义互斥，见 D9）；**R-2 有界模型上下文 + R-3 历史分页 + resume 接线已落地**（resume 有界；回退按需物化；`/history` + 滚动到顶自动加载；D20 turn 索引接回退菜单；200 MB 档 652→40 ms）。

**尚未完成**：D22 的自动总量配额（显式 prune 已落地）、真实 TTY 目视验证。I4.1 已完成。

---

## 1. 基线测量（真实语料 + 夹具，2026-10-23）

### 1.1 语料与封存态

- 真实语料 4 份，紧凑总量 **12.87 MB**，最大单份 **6.65 MB**。
- `meta.reasoningState` 合计 **5.00 MB = 38.9%**（窗口内 29.1%）；单条最大 100× 放大；Top8 中 6 条未归档。
- 条目 5102 条；`token_update` 1032 条（20.2%）但只占 0.29 MB（2.3%）；`toolMetadata` 出现率 2.5%，`_contentBlocks`/`reversePatch` 在真实语料中 **0 字节**。
- 封存态密文 gzip 只省 26%；4 KiB 外置预算命中 70.1%，预测文件 **−36.8%**（200 MB 档 201.74 → 125.81 MB，−37.1%）。
- 2 KiB 只多省 3.19 MB（1.6%）却多 1128 个文件（+25%）；8 KiB 少省 10.7 MB → **D3 = 4 KiB**。

### 1.2 M0（标记前不落盘）实测

| 源 | 文件 | 标记前 display+meta | 可省 |
| --- | --- | --- | --- |
| 真实 `01a14e55…` | 6.01 MB | 1.99 MB（封存态 1.25 MB） | **33.2%** |
| 夹具 tier-5mb | 5.24 MB | 2.50 MB | 47.7% |
| 夹具 tier-50mb | 50.12 MB | 22.09 MB | 44.1% |
| 夹具 tier-200mb | 201.74 MB | 104.50 MB | **51.8%** |
| `01a14fd1…`（无 marker） | 5.50 MB | — | **0%** |
| `01a15edb…`（无 marker） | 1.34 MB | — | 0% |

结论：M0 吃"压缩密集的长会话"；`compact_count=0` 的会话只能靠 M1（D12）。

### 1.3 恢复基准

- 驻留 ≈ 文件 **1.50×**（三档一致）。
- 200 MB 档 `loadLog` **656 ms**；strip-drop 后常驻 **−28%（−77.3 MiB）**；repair **5 / 86 / 1279 ms**（条目 ×4 → ×14.9，P-9）。
- 单份 200 MB 日志在 `--max-old-space-size=384` 下**不 OOM** → 崩溃归因转向"多份叠加"。

### 1.4 写入基准（当前格式）

| 源 | 最终文件 | 稳态单次写 | 单次耗时 | 触发点 | 整场总写入 | 写放大 |
| --- | --- | --- | --- | --- | --- | --- |
| 真实 6.65 MB | 6.01 MiB | 6.01 MiB | 18 ms | 924 | 3.00 GiB | **462×** |
| 50 MB 夹具 | 50.12 MiB | 50.12 MiB | 107 ms | 5924 | 144.97 GiB | 2962× |
| 200 MB 夹具 | 201.74 MiB | 201.74 MiB | 427 ms | 24520 | 2415 GiB | 12260× |

保存频率只有 **0.04–0.05 次/s**（2 s debounce 把上限钉在 0.5/s）。问题不是"太频繁"，是"每次太大"。

---

## 2. 问题清单与归属

| # | 问题 | 量级 | 归属 | 状态 |
| --- | --- | --- | --- | --- |
| P-1 | 封存态内联 | 38.9% 文件 / 摘除 −28% 常驻 | 写侧 W-2 | ✅ 2026-10-23（M1；实测日志 −38%～−45%，200 MB 档常驻 −63.5 MiB = 0.79×） |
| P-2 | `compact_count=0` 永不剥离 | 最大真实会话 34.8% 封存态 | 写侧 W-2 | ✅ 2026-10-23（M1，窗口内也外置） |
| P-3 | 每检查点重写整份 | 462×；200 MB 2.4 TiB | **写侧 W-1** | ✅ 2026-10-23（追加式 `log.jsonl`，运行期已切换） |
| P-4 | 恢复全量解析、无边界 | 200 MB 656 ms；常驻 1.5× | **读侧 R-2** | ✅ 2026-10-24（resume 已走有界：200 MB 档 652→40 ms、77944→3063 条；回退时按需物化） |
| P-5 | meta 坏时整读日志 | 6 MB × N | 读侧 R-1 | ✅ 2026-10-24：JSONL 读 `readLogHeader`；legacy 读 `readLegacyLogHeader`（64 KiB，正文不解析），超限才回退整读 |
| P-6 | `dirSize` 递归 | 与 artifacts 文件数线性 | 读侧 R-1 | ✅ 2026-10-24：只统计日志/meta/索引/archive/images/sealed，不递归 `artifacts/` |
| P-7 | 冷区存根依赖后续保存 | 不压缩就不瘦 | 写侧 W-3 / 读侧 R-3 | 部分 |
| P-8 | 崩溃丢最近 2 s | 用户已接受 | — | 已知、接受 |
| P-9 | repair 超线性 | 5/86/1279 ms（1279 ms 为 full 场景；R-2/R-3 后 bounded resume 只扫窗口） | 读侧 R-5 | ✅ 2026-10-25（第 4 步索引化；计时 16.96×→2.4–4.8×，读取 706×N→9.3×N） |
| P-10 | M2 实测价值低 | toolMetadata 2.5%；`_contentBlocks` 0 B | 写侧 W-2 | 降级，等门槛 |
| P-11 | 用量页整读全部日志 | 12.87 MB 全解析；蛇形死分支 | 读侧 R-1/R-5 | ✅ 2026-10-24（只读 meta.tokens） |
| P-12 | `onSaveRequest` 契约不一致 | 当前无失败路径 | 总体 D10 | ✅ 2026-10-24：统一为 `() => boolean`；TUI 立即保存返回真实结果，防抖调度返回 false（尚未同步落盘） |
| P-13 | `token_update` 占 20.2% 条目/2.3% 字节 | 检查点 per-entry 序列化成本 | 写侧 W-4 | **否决**（D9；P9.1 核实两类消费互斥） |
| P-14 | meta/project 每检查点全读全写 | +2 读 +2 写/检查点 | 写侧 W-4 | ✅ 2026-10-23（跨分钟才写、内容不变跳过、紧凑 JSON） |
| P-15 | 持久化剥离错用 TUI 折叠阈值 | 1–2 次压缩的会话一条不剥；标记前 1.99 MB 全量落盘 | 写侧 W-2 | ✅ 2026-10-23（M0，落盘边界改为最后一个 marker） |
| P-16 | 删除会话同步回收 rewind 落盘物 | 删除语义已满足；fork 复制 journal 但不执行 | 总体 §6 | 已核实；可选清理 |
| P-17 | 换 JSONL 后读路径变慢（W-1 的代价，2026-10-23 实测） | 同进程 A/B：5/50/200 MB 档 `loadLog` **1.06 / 1.14 / 1.27×**，200 MB 档 820 → 1043 ms；驻留反而 0.79–0.87×。根因是逐记录 `JSON.parse`（200 MB 档 77944 次）+ 仍整读 | 读侧 R-2（有界反向扫描）偿还；不换回 legacy（写放大 462× 更贵） | ✅ 端到端已兑现（resume 走有界；200 MB 652→40 ms） |
| P-19 | 并发 resume 无写锁；写侧 seq 不校验 | 两个进程可同时写同一 `log.jsonl`；写侧 seq 断档会被读侧仅告警 | 写侧 W4.2/W6：`log.jsonl.lock`（陈旧锁按 pid 回收）+ `appendRecords` 连续性校验 | ✅ 2026-10-25 |

---

## 3. 设计原则

1. **追加式权威日志**：`log.jsonl` 只追加；任何"修改"都是一条可重放记录。读侧永远能从文件尾恢复。
2. **变更必须可记录**：条目不能继续被随意就地修改；所有变更走 `SessionLog` 的变更网关（写侧 W4.1）。这是本设计最大的改造成本。
3. **单一权威源**：`log.jsonl` 是唯一权威；`meta.json`/turn 索引/SQLite 类投影都必须是**可重建**的，损坏时不阻塞启动。
4. **外置不等于丢弃**：封存态、归档、图片、大工具输出都只能"移到有取回路径的地方"，并有逐字等价红测。
5. **写前减重**：过滤瞬时数据、只写完成态、截断大载荷、外置密文——不要等落盘后再优化。
6. **不逐条 fsync**：与 Codex 一致；崩溃只丢尾部，靠尾行修复。零丢失不在本轮目标内（P-8）。
7. **有界读取**：模型上下文只读 marker 之后；TUI 分页；列表只读 header。禁止把整份日志重新搬进内存。
8. **复用现有机制**：`agent-outputs` 截断、`image_ref`、gzip 归档、`truncateUtf8`、`loadArchivedMetaForTurns` 都已有，不造第二套。

---

## 4. Codex 对照（摘要）

详细证据见写侧 W2、读侧 R2。

| Codex | 我们的对应 | 采纳 |
| --- | --- | --- |
| append-only `rollout-*.jsonl`，逐条追加 | `log.jsonl` + 变更网关 | **采纳**（写侧核心） |
| 写入前过滤/64 KiB 截断 | ephemeral + 完成态 + 64 KiB + image_ref | **采纳**（W-2） |
| flush 不 fsync，尾行修复 | 同样策略 | **采纳**（W6） |
| `CompactedItem` 追加、携带替换历史 | `compact_marker` + 其后 `compact_context` | **采纳锚点，不复制替换历史**（我们语义更简单） |
| 反向扫描 + 64 KiB 块 | `ReverseJsonlScanner` 同构实现 | **采纳**（R-2） |
| SQLite 投影/分页 | `meta.json` + 可重建 turn 索引 | **不引入 SQLite**（D20） |
| 7 天后 zstd 冷压缩 | 冷文件压缩 | ✅ 形态改为**显式命令 + 整目录搬迁 + gzip**（W-5，2026-10-24）；不做 zstd/自动搬迁 |
| fork/revert 新建不可变段 | v1 复制 JSONL | v1 复制；lineage 可选（D18） |

**关键差异**：Codex 的压缩会用 `replacement_history` 替换历史，所以检查点必须自带新历史；我们的 `compact_marker` 之后就是活动窗口，摘要正文紧随其后，**反向扫到 marker 即可**，不需要在检查点里复制窗口。

---

## 5. 目标架构

```
<sessionDir>/
  log.jsonl                  # 权威：header + session/upsert/patch/truncate/usage
  meta.json                  # 列表/摘要/用量快路径（可重建）
  log.index.jsonl            # 可选：可重建 turn 索引（D20）
  sealed/<entryId>.json.gz   # 封存态 sidecar
  archive/window-<n>.json.gz # 已压缩窗口全文
  images/                    # image_ref
```

- 写：`SessionLog` 变更网关 → dirty upsert/patch/truncate → 2 s 批处理 → 追加 → flush。
- 读：header → 有界反向扫描（模型）/分页（TUI）→ 按需读归档/封存态。
- 迁移：`log.json`（v2/v3）一次性转 `log.jsonl`（v4），校验后备份旧文件，保留单一读路径。

---

## 6. 生命周期：rewind 落盘物（P-16，用户点名）

**已核实（2026-10-23，探针 `tests/session/rewind-fork-probe.test.ts` 4 例全绿）**

- 删除侧已满足：唯一入口 `deleteGlobalSession` 的 `rmSync(sessionDir, {recursive, force})`（[session-picker.ts:61-70](src/cli/session-picker.ts#L61-L70)）覆盖全部可达布局；`sessionArtifactsDir` 只由子会话构造传入且仍在父会话目录内（[session.ts:4012](src/session.ts#L4012)、[manager.ts:316-317](src/session/children/manager.ts#L316-L317)）。原 `paths.session_artifacts` 外部覆盖是误判，已撤回。
- fork 会把 `rewind-journal.json` 与 `.data-<uuid>` 复制进新会话（[session-fork.ts:39](src/server/session-fork.ts#L39)），但恢复时被 `_readRewindJournal` 的绝对 `filePath` 校验拒收（[engine.ts:704-712](src/session/rewind/engine.ts#L704-L712)），**不会回放**；残留是死文件 + 一条误导告警。
- ✅ 可选清理已做（D13，2026-10-24）：fork 后由 rewind 子系统的 `discardRewindArtifacts` 删除继承的 journal 与 `.data-*`，父会话保留；`session_id`/孤儿 GC/删除前告知均不做。

---

## 7. 决策点

| # | 问题 | 选项 | 结论/倾向 |
| --- | --- | --- | --- |
| D1 | M1 范围 | 全量 / 只做 M0 打不到的部分 | ✅ 全量落地（W-2，2026-10-23） |
| D2 | sidecar 目录 | `sealed/` / 其他 | ✅ `sealed/` 已落地 |
| D3 | 内联预算 | 2 / 4 / 8 KiB | ✅ 4 KiB 已落地（4096 B 边界有测试） |
| D4 | 投影 LRU | 4 MiB / 不缓存 | ✅ 4 MiB LRU 已落地 |
| D5 | M6（JSONL） | 现在做 / 出局 | **已被 D14 取代**；原判据作废 |
| D6 | 强制归档无 marker 会话 | 加 / 不加 | **不加**（改变 API 语义） |
| D7 | M7 repair 超线性 | 授权 / 挂起 | ✅ **已授权并落地（2026-10-25）**；收益主要在 full/legacy、迁移与全量重建，bounded resume 只扫窗口 |
| D8 | M8 用量 + 迁移 | (a) 未统计并列出 / (b) reindex | ✅ **(a) 已落地（2026-10-24）**：meta.tokens 单一权威；缺 tokens 列 `sessionsWithoutTokens`，不整读 |
| D9 | M9 合并 token_update | 做 / 挂起 / 否决 | **否决**（2026-10-23 P9.1 核实：消费者同时依赖逐次求和与"最后一条"，合并无法同时满足） |
| D10 | onSaveRequest 布尔契约 | 统一 / 不动 | ✅ **已统一（2026-10-24）**：契约 `() => boolean`；TUI `autoSave` 返回真实结果，`scheduleSave` 返回 false（仅排队）；未合并两条 finalize |
| D11 | M0 渲染口径 | (a) 只改落盘 / (b) 内存同步剥 | ✅ (a) 已落地；重启后 display 从 archive 取回 |
| D12 | M0 后 M1 是否续做 | 立即 / 复测后再定 | ✅ M1 已续做并落地 |
| D13 | P-16 可选清理 | 做 / 不做 | ✅ **已做（2026-10-24）**：fork 后丢弃继承的 journal 与 `.data-*`，父会话保留 |
| **D14** | **写模型** | 维持整写 / base+delta / **全 JSONL** | **方向已按用户指示采纳 Codex 写模型 = 全 JSONL**；记录集待 D15 |
| **D15** | **记录 op 集合** | `session/upsert/patch/truncate/usage` / 其他 | 待批；见写侧 W3.2 |
| **D16** | **迁移口径** | 一次性转换 + 备份 / 双读 | **一次性转换 + `log.json.pre-v4.bak`**；不保留双读 |
| **D17** | **TUI 分页粒度** | 200 条 / 2 MiB / 其他 | ✅ 200 条 / 2 MiB；页缓存 8 MiB 上限与顶部"更早 N 条"已实现（2026-10-25）；达到上限后显示提示并停止加载 |
| **D18** | **fork 形态** | 复制 JSONL + 重写 header / lineage 分段 | v1 **复制并重写第一行 header**；lineage 作为 R-6 可选 |
| **D19** | **读模型** | 有界窗口 + 分页 / 继续全量 | ✅ **全部接线（2026-10-24）**：resume 走 `loadModelContext`，`/history` 按页取回 + 滚动到顶自动加载，回退/文件回退前物化完整日志，D20 索引接回退菜单 |
| **D20** | **turn 索引** | 反向扫描按需重建 / 可重建索引文件 | ✅ 全部（2026-10-24）：`log.index.jsonl`、seq 校验、增量追加、turn_end 定稿；patch 事件化（`drop-turn`/`drop-mutation`/`set-revert`）、truncate 定向失效（`drop-turns-from`）、快照直接建索引；200 MB 档读取 3 ms |
| **D21** | **M5 冷归档形态** | 自动+zstd / 显式 CLI+gzip / 只搬目录 | ✅ **显式 CLI + 整目录搬迁 + gzip**（2026-10-24；实测 gzip 比 0.36–0.41）；不做 zstd 与按时间自动搬迁（用户授权范围） |
| **D22** | **日志保留上限** | 自动删旧 / 显式 prune / 冷段 | **显式 prune 已落地（2026-10-25）**：`sessions prune <id> [--dry-run] [--max-log-bytes N]`，只清最后一个 live marker 前、有 archive 正文副本/已丢弃/无正文的结构条目，system_prompt 与活动窗口保留；原子重写日志、删 turn 索引、报告丢失 turn 与 archive/artifacts/sealed 体积。**自动总量配额与 archive/artifacts 清理未做**（不静默删除；长期可做冷段 D18） |

### P9.1 核实结论（2026-10-23）：M9 否决

`token_update` 有两类互斥消费者：

1. **逐次求和**：`aggregateTokenUsage` 累加每个条目的 `inputTokens`（[usage-accounting.ts:66](src/session/usage-accounting.ts#L66)）；`computeGlobalTokenStats` 同样逐条求和（[session-store.ts:413](src/config/session-store.ts#L413)）；子代理断点阈值的 `tokensIn` 也来自该累计值（[manager.ts:942](src/session/children/manager.ts#L942)）。合并成"最后一笔"会少算每次工具往返的输入。
2. **最后一条即当前上下文**：恢复时从后向前找最近一条有效 `token_update`，用它的 `inputTokens` 作为当前上下文大小（[log-surgery.ts:604-620](src/session/log-surgery.ts#L604-L620)）。若把一轮内多次调用求和写进 `inputTokens`，重启后会按放大后的值立刻触发压缩（正是 [session-compact-token-accounting.test.ts](tests/session/session-compact-token-accounting.test.ts) 锁住的回归）。

同时满足两者只能新增字段并改三处消费者与条目契约，而收益只有 2.3% 字节（20.2% 条目的序列化开销已被 JSONL 增量追加吸收）。**按 P9.1 预设规则直接否决，不再讨论。**

---

## 8. 迁移与回滚（摘要）

- 版本从 2/3 升到 **4**；打开旧会话时一次性转换，重放校验后原子替换；旧文件改名 `log.json.pre-v4.bak`。
- `persistence_policy` 2 → **3**：旧 JSONL/legacy 在下一次保存做一次性快照重写（补 `upsert.replaces` 与 R-2 计数器），成本是一次全量写（6 MB ≈ 0.1 s，200 MB ≈ 0.4 s）。
- 迁移后只读 `log.jsonl`，不保留双读路径；备份不参与运行，仅供人工回滚。
- `archive/`、`images/`、`sealed/` 不变；fork 的旧会话同样在 attach 时迁移。
- 详细步骤与红测见写侧 W7。

---

## 9. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **变更网关漏点** | 重启丢数据 | 全量收编直接变更；开发态 freeze；全流程重放等价红测 |
| TUI 分页改造 | 滚动/折叠/回退回归 | R-3 独立可回滚；首屏与展开分开验证；无 TTY 时明确标注未验证 |
| 迁移 | 旧日志损坏/丢条目 | 写临时文件 → 重放比对 → 原子替换；保留 `.bak` |
| 崩溃尾行 | 丢最后一批 | 尾行修复 + 坏行跳过；不承诺零丢失 |
| 归档 display 取回 | 旧轮次无法渲染 | display-only 读取 + 不预载断言 |
| turn 索引漂移 | 回退列表错误 | 索引标注可重建；一致性校验失败即重建 |
| fork 复制 journal/索引 | 死文件/误导告警 | 按 P-16 探针结论清理；不影响正确性 |

---

## 10. 验收门禁

1. 红测先行；期望值来自本文规格；红必须红在预期原因。
2. 每个新测试至少 1 条定向变异（写侧变更网关、读侧有界扫描必须有）。
3. `typecheck` / `typecheck:tui` / `npm test` / `test:node` / `build` / `find-cycles` 全绿。
4. `build:exe` + `runtime/dist` 真实读写冒烟（SEA blob 压缩过，grep exe 无效）。
5. 写字节基准：三档夹具 + 真实 4 份，给出追加前后原始字节；目标见写侧 W5。
6. resume 基准：三档峰值驻留与耗时；目标见读侧 R0。
7. TUI 分页/展开/回退需真实终端验证；无 TTY 时明确标注未验证。

---

## 11. 明确不做

- SQLite/索引库（D20 也不引入）。
- zstd 冷压缩不做；W-5 已按"显式命令 + 目录搬迁 + gzip"落地（D21），归档态不可 resume，restore 时物化明文。
- `reversePatch` 截断（回退事实来源）。
- `compact_count=0` 强制归档（改变 API 语义）。
- 崩溃零丢失（P-8 已接受）。
- `display` 与 `content` 去重（实测 1.7%，作为写前减重边角）。
- 自动分段/轮转（v1 单文件）。
- 旧 `log.json` 双读兼容路径。

---

## 12. 与原任务的映射

| 原任务 | 新落点 |
| --- | --- |
| M0（P-15 标记前不落盘） | 写侧 W-2 + 读侧 R-3（display 取回） |
| M1（封存态外置） | 写侧 W-2 + 读侧 R-4 |
| M2（写时上限） | 写侧 W-2 |
| M3（冷区存根契约） | 读侧 R-3 |
| M4（选择器与体积） | 读侧 R-1 |
| M5（冷会话归档） | 写侧 W-5 |
| M6（JSONL 甲） | **写侧 W-1**（原"出局"结论被 D14 取代） |
| M7（repair 超线性） | 读侧 R-5 |
| M8（用量统计） | 读侧 R-1/R-5 |
| M9（token_update） | 写侧 W-4 |
| M10（rewind 生命周期） | 本文 §6 + 任务 §7.8 |
| P-9/P-11/P-13/P-14/P-15/P-16 | 分别见上表 R-5 / R-1 / W-4 / W-4 / W-2 / §6 |

执行拆解见 [LOG_PERSISTENCE_TASKS.md](LOG_PERSISTENCE_TASKS.md)；2026-10-24 的状态盘点与剩余清单见该文档 §13。
