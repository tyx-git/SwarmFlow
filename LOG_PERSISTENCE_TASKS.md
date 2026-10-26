# SwarmFlow 日志持久化重设计 —— 执行任务清单

配套设计文档（2026-10-23 已拆分）：
- 总体/测量/问题/决策：[LOG_PERSISTENCE_DESIGN.md](LOG_PERSISTENCE_DESIGN.md)（下称"总体"）
- 写侧：[LOG_WRITE_DESIGN.md](LOG_WRITE_DESIGN.md)（下称"写侧"）
- 读侧：[LOG_READ_DESIGN.md](LOG_READ_DESIGN.md)（下称"读侧"）

> **任务映射**：原 M0/M1/M2/M5/M6/M9 → 写侧 W-2/W-1/W-4/W-5；原 M3/M4/M7/M8 → 读侧 R-3/R-1/R-5/R-1。
> **原 M6 的"出局"结论已被 D14 取代**：用户 2026-10-23 指示采纳 Codex 写模型（append-only JSONL）。下列任务保留原编号，具体规格以新文档为准；**未授权前不动代码**。

纪律（全程有效）：
- **不 commit / merge / push**，git 由用户执行（记忆 `feedback-git-commits`）。
- **红测先行**，期望值来自设计规格，不来自实现；红必须红在预期原因上（`feedback-root-cause-regressions`）。
- **每个新测试配一条定向变异检验**，并配负向探针。
- 数据丢弃类改动先量化再确认；"先/只/等待"是硬边界。
- 打包相关改动必须重建 release 并在产物上验证，源码全绿不算完成（`feedback-packaged-artifact-delivery`）。

---

## 0. 启动前基线（已实测，2026-10-23）

| 项 | 结果 |
| --- | --- |
| 真实语料 | `~/.swarmflow/projects` 下 4 份 `log.json`，紧凑合计 12.87 MB，最大 6.65 MB |
| 最大单项 | 内联 `meta.reasoningState` 合计 **5.00 MB = 38.9%**（活动窗口内 3.75 MB = 29.1%） |
| 封存态分布 | 408 条 / 5102 条；单条 P50 **6.7 KB**、P90 32.3 KB、max **110.9 KB** |
| 预算校准（D3） | **4 KiB 已定**：命中 70.1%、语料 12.87 → 8.13 MB（−36.8%）；逐会话 −47.0% / −33.7% / −4.6% |
| 密文可压性 | 封存态 gzip 只省 **26%**（5.00 → 3.70 MB）→ M5 冷层收益预期要打折 |
| 已消除 | 缩进开销 1.17 MB（9.1%，②） |
| 高估纠正 | `display` 与 `content` 全等仅 0.22 MB（**1.7%**） |
| 未复现 | 报告里的 OOM 量级：本地无 ≥50 MB 日志 → P0 必须先造夹具 |
| 工作树 | 上一轮 ①②③ 改动待用户提交（12 改 + 4 新测试文件） |

量测脚本（`.tmp/` 已 gitignore）：`.tmp/measure-log-bytes.mjs`、`.tmp/measure-log-waste.mjs`、`.tmp/measure-sealed-distribution.mjs`、`.tmp/bench-log-memory.ts`、`.tmp/mutation-check-oom.mjs`、`.tmp/verify-built-log.mjs`。

---

## 1. P0 — 夹具与校准（**2026-10-23 已完成**；总体 §1、写侧 §W1、读侧 §R1）

- [x] **P0.1a 真实语料形态量测**（`.tmp/measure-log-shape.mjs`）
  类型配比：`tool_call` 31.6% / `tool_result` 31.6% / `token_update` 20.2% / `reasoning` 8.1% / `assistant_text` 3.6%。
  单条：reasoning `meta` P50 7.1 KB / P90 32.4 KB / max 112.2 KB；tool_result `content` P50 0.2 KB / P90 7.2 KB / max 59.9 KB。
  节奏：条目间隔 P50 925–1604 ms，≤2 s 占比 55–68%；**每 turn 条目 P50 59 / P90 321 / max 631**，平均每 turn 落盘 387.6 KB。
  `toolMetadata` 出现率仅 **2.5%**（41/1612），子键合计只有 `tui_preview=7.8 KB` → 触发 P-10（M2 降级）。
  封存态结构：`reasoningState` 是数组，**93.7% 的字节是 `encrypted_content` base64**（4.69/5.00 MB）；本语料 408 条 `thinkingArtifact.encryption` 全是 `none`、`sealedPayload` **0 B**。

- [x] **P0.1 夹具生成与形态校准**（`.tmp/make-log-fixture.mjs`，输出 `%TEMP%\swarmflow-log-fixtures\tier-*`）
  做法改为**按真实"整 turn 连续段"抽样 + 保字节扰动**（回填等字节数的 base64 字符）。两版返工记录：
  ① 第一版按字符保长并注入 CJK → UTF-8 字节膨胀，封存态占比冲到 73%、gzip 比 0.612（真实 0.390），废；
  ② 第二版按条目独立抽样 → 打断 `tool_call`↔`tool_result` 配对，`validateAndRepairLog` 报 `repaired=true` 并**合成条目**（2060→2061），测量失真，废。
  现版验收：三档封存态占比 42.1 / 39.1 / 36.7%（真实 38.9%，偏差 ≤8%）；P50/P90/max 偏差 ≤12%；gzip 比 0.410 / 0.399 / 0.376（真实 0.390，偏差 ≤10%）；封存态不可压缩性复现（保留比 0.737–0.747 vs 真实 0.740）；`repaired=false` 且条目数不变。**偏差 < 20% 验收通过。**

- [x] **P0.2 resume 峰值与耗时基准**（`.tmp/bench-resume.ts`）
  loadLog：5 MB 16 ms / 50 MB 145 ms / 200 MB 656 ms；**驻留/文件 = 1.34–1.52×，三档一致**。
  摘除 `reasoningState` 后的驻留下降 / 封存态文件字节 = **1.01–1.04×**（200 MB 档 −77.3 MiB / 279.1 MiB = −28% 常驻）→ M1 的内存收益拿到实测上界。
  修脚本时踩到一次真坑：第一版这里报 −271 MiB，是 V8 活跃性分析把整份日志当垃圾收了；加 `retain` 强制保活后才是真数。
  OOM 探针：200 MB 档在 `--max-old-space-size=384` 下**完整跑完** → 单份大日志不解释上一轮的崩溃；归因要转向"多份叠加"（主会话+子会话日志同驻、归档 gzip 缓冲）。

- [x] **P0.3 检查点写字节分布与 M6 判定**（`.tmp/bench-checkpoint.ts`）
  真实 6.65 MB 会话：稳态单次写 6.01 MiB / 18 ms，924 触发点 / 7.06 h → **0.04 次/s**，整场总写入 3.00 GiB（写放大 462×）。
  50 MB 档 107 ms / 0.05 次/s / 144.97 GiB；200 MB 档 **427 ms** / 0.04 次/s / 2415 GiB。
  **判定：甲出局（后由 D14 取代）**——总体 §7 D5/D14 的原判据第二子句"≥1 次/s"被 ② 的 2 s debounce 结构性钉死在 0.5 次/s，永不成立。
  判据本身写得不好，已在总体 §7 D5/D14 与写侧 §W5 重述为"单次 `saveLog` 耗时 P95 > 250 ms 或单会话总写入 > 100 GiB"，重入门槛约等于 200 MB 级会话（连续 6 天），当前工作流差 30 倍。

- [x] **P0.4 / P0.4b 预算校准与夹具复算**
  脚本已参数化根目录（`--root=` 或位置参数，兼容 `<root>/<session>/log.json` 与 `<root>/<project>/<session>/log.json`）。
  200 MB 档复算：4 KiB 命中 70.1%、200.10 → 125.81 MB（−37.1%）；2 KiB 只多省 3.19 MB（1.6%）却多 1128 个文件（+25%）；8 KiB 少省 10.7 MB。
  **D3 = 4 KiB 在外推量级上仍是最优点，唯一剩余风险已消除。**

- [x] **P0.5 交数据**：本轮汇报后停住。**待批：D1（M1 范围）、D2（`sealed/`）、D4（LRU 4 MiB）、D7（M7 小票）**；D3/D5 由数据直接定案。

- [!] **P0 副产品 = 两个新问题**（已写入总体 §2）
  **P-9**：`validateAndRepairLog` 超线性（5/86/**1279 ms**），200 MB 档比 `loadLog` 还贵 1.9×；根因是第 4 步对每条 reasoning 全表扫描（[src/config/log-repair.ts:207](src/config/log-repair.ts#L207)）。→ 新阶段 **P7/M7**。
  **P-10**：M2 的靶子在真实语料上几乎不存在（`toolMetadata` 2.5%、`reversePatch`/`_contentBlocks` 0 B）→ **P2 降级后置**。

---

## 1.5 P1a — M0：标记前的 `display`/`meta` 不落盘（**用户更正，2026-10-23；排在 M1 之前**；写侧 §W4.3、总体 §2 P-15、D11/D12）

> **实施状态（2026-10-23，已落地）**：实际测试在 `tests/config/log-m0-m1.test.ts`（9 例）。落盘边界取最后一个 live marker；legacy 守卫用 archive index 的 `hasPresentation + entryIds`；`stripEntryForPersistence` 只生成副本，内存不动；重启 display 由 `hydrateArchivedDisplay` 从 archive 补齐（**启动补齐，不是懒加载**）。磁盘对账（R0.6）已跑，结论见 §1.5.1 R0.6：**存量会话 0%（归档无 presentation，守卫拒绝），新压缩下可剥占比实测 32.4%**。

前提已核实：投影窗口从最后一个 live `compact_marker` 开始（[src/context/projection/api.ts:85-97](src/context/projection/api.ts#L85-L97) → [src/context/active-context.ts:83-90](src/context/active-context.ts#L83-L90)），所以标记前的封存态**永不再被发送**。而 ① 的剥离被 TUI 的 3 窗口折叠阈值门控（[tui.ts:34-36](src/context/projection/tui.ts#L34-L36) 返回 `-1` → [compact-flow.ts:379-382](src/session/compact-flow.ts#L379-L382) 跳过），**1–2 次压缩的会话一条都没剥**。实测可省 33.2%（真实 6 MB）–51.8%（200 MB 夹具）；`compact_count=0` 的会话省 0%。

### 1.5.1 红测（先写，先红）

- [x] **R0.1** `tests/config/log-m0-m1.test.ts`（实际路径）：一个已压缩（≥1 marker）且归档带 presentation 的会话，`persistToDisk` 后
  ① 标记前条目在 `log.jsonl` 里 `display` 缺省/为空、`meta` 只剩 `RETAINED_ARCHIVED_META_KEYS`；② 内存条目**不变**（`display`/`meta` 仍在）——这条断言是关键，防止把"不落盘"实现成"就地清空"从而弄坏 TUI。
  期望来源：写侧 §W4.3 写前策略 + D11(a)。**红在**：当前 `writeLogFile` 原样序列化每个条目（[log-serialization.ts:94-108](src/config/log-serialization.ts#L94-L108)）。
- [ ] **R0.2（部分）** 只测了"无 marker 不剥"；marker 之后未单独测。原口径：`compact_count=0` 的会话保存后**一个字段都不剥**；marker **之后**的条目（含刚压缩那一轮的新窗口）完整保留 `reasoningState`。这条锁住"绝不碰还要发出去的数据"。
- [x] **R0.3** legacy 守卫已测：归档索引没有 `hasPresentation` 标志时**不剥**（旧版归档只有 content，剥了就是不可逆丢失）。用手工构造的旧格式 `window-0.json.gz` + 旧索引驱动。
- [ ] **R0.4（未补磁盘级）** 内存级 archive 闭环有既有测试；原口径：`saveLog` → `loadLog` → 撤销压缩（`restoreArchiveToEntries`）→ 投影，断言 `_reasoning_state` 与"从未剥离"时**逐字相等**。这是 provider 硬失败的最后防线（Anthropic 交错思考要求 thinking 块随 tool_use 一起回传）。
- [ ] **R0.5（偏差）** 当前是启动时 `hydrateArchivedDisplay` 一次性补齐，不是展开时懒加载；R-3 再做。原口径：重启后标记前条目是存根，展开旧轮次时能从 `archive/` 取回 `display`；**默认折叠时不读**（断言没有整份归档进内存，用读取次数或字节计数 spy）。
- [x] **R0.6（已跑，2026-10-23；`.tmp/measure-persist-disk.mjs`）** 三档夹具 + 本机全部真实会话，同一份条目分别按「基线 / +M0 / +M0+M1」写快照，比较 `log.jsonl` 原始字节：

  | 会话 | 基线 | +M0 | +M0+M1（日志） | +M0+M1（含 sealed/artifacts/images） | marker 之后条目不变 |
  | --- | --- | --- | --- | --- | --- |
  | tier-5mb | 5.39 MB | 4.81 MB（**−10.8%**） | 2.99 MB（−44.6%） | 4.35 MB（−19.3%） | 是 |
  | tier-50mb | 51.46 MB | 45.47 MB（−11.6%） | 30.71 MB（−40.3%） | 41.64 MB（−19.1%） | 是 |
  | tier-200mb | 207.51 MB | 183.96 MB（−11.3%） | 128.38 MB（−38.1%） | 169.45 MB（−18.3%） | 是 |
  | `01a14e55…`（6.22 MB） | 6.22 MB | 6.22 MB（**−0.0%**） | 3.40 MB（−45.4%） | 5.51 MB（−11.4%） | 是 |
  | `01a14fd1…` | 5.62 MB | 5.62 MB（−0.0%） | 3.77 MB（−33.0%） | 5.15 MB（−8.5%） | 是 |
  | `01a15edb…` | 1.38 MB | 1.38 MB（−0.0%） | 1.31 MB（−4.4%） | 1.34 MB（−2.4%） | 是 |

  **偏离解释（不吞）**：M0 实测远低于原口径 −47.7% / −33.2%，两个原因都在守卫上，且都是设计要的行为。
  1. **存量会话省 0%**：`01a14e55…` 的 `archive/window-0.json.gz` 实测 1503 条只有 `{id,content}`，`display 非空=0`、`meta 键数=0`（`.tmp/check-archive-shape.mjs`）——归档早于 ① 落地，剥离就是不可逆丢失，`hasPresentation` 守卫正确地拒绝。M0 的收益只在**新压缩写出的归档**上兑现。
  2. **夹具的已归档占比低**：tier-5mb 标记前 1805 条里只有 **655 条 archived**，可剥 display+meta = 0.61 MB（占条目总 11.6%），而标记前未归档的 display+meta 有 1.90 MB（36.2%）——这部分**永远不能剥**。真实长会话的归档覆盖率高得多：`01a14e55…` 标记前 1988 条里 1503 条 archived（76%），可剥 1.94 MB = **32.4%**，与原口径 −33.2% 对齐（P0 的 1.99 MB 就是这一项）。
  3. `tier-*` marker 之后条目逐字节不变：**成立**（三种策略下 marker 之后每条的序列化结果全等）。

### 1.5.2 实现

- [x] **I0.1** 已实现（另加 `entryIds`）：（[src/config/archive.ts:42-45](src/config/archive.ts#L42-L45)），`writeArchiveIndex` 在写过 display/meta 的窗口上置位（[:93-117](src/config/archive.ts#L93-L117)）。旧索引读不到该字段 → 视为 false。
- [x] **I0.2** 已实现为 `stripEntryForPersistence` + `_refreshPersistenceStripIds`：：新增 `stripForPersistence(entries)`，按 `persistenceStripIdx = 最后一个 live compact_marker` 计算，返回**新的记录对象**，**不修改内存条目**（这是与 `stripArchivedPresentation` 的本质区别，后者是就地改内存）。放在 [src/config/archive.ts](src/config/archive.ts) 里与 ① 同处，避免第二套剥离规则。
- [x] **I0.3** 已接入 JSONL `prepareForPersistence`（快照与增量）：（[log-serialization.ts:94-108](src/config/log-serialization.ts#L94-L108)）；`RETAINED_ARCHIVED_META_KEYS` 复用现集合（[archive.ts:155-161](src/config/archive.ts#L155-L161)），**不要**新增键名单。
- [ ] **I0.4（偏差）** 已实现 display-only 读取，但由 `loadLog` 启动时调用；懒加载待 R-3。原口径：新增 display-only 的窗口读取（比照 [archive.ts:254-293](src/config/archive.ts#L254-L293) 的逐窗口 + 相关性判定，但只取 `display`），由 TUI 在展开旧轮次时调用。**不做启动预加载**。
- [x] **I0.5** fold 阈值未改，内存侧行为不变：内存侧仍按 TUI fold 阈值（3 窗）清理 presentation。**不要顺手把 fold 阈值改成 1**——那是 UI 行为改动，属于 D11(b)，本轮不选。

### 1.5.3 变异检验（≥6 条）

- [ ] V1 `stripEntryForPersistence` 就地改内存条目 → R0.1② 红（TUI 会被弄坏）。
- [ ] V2 边界写成"全部条目"而非"最后一个 marker 之前" → R0.2 红（窗口内封存态丢失 = 请求直接坏）。
- [ ] V3 忽略 `hasPresentation` 一律剥 → R0.3 红（legacy 不可逆丢失）。
- [ ] V4 归档仍存 meta 但 restore 链不恢复 → R0.4 红。
- [ ] V5 启动时预加载所有窗口 display → R0.5 红（把省下的内存又搬回来，等于白做）。
- [ ] V6 `RETAINED_ARCHIVED_META_KEYS` 少一个 `fileMutationReverted` → 由 `tests/config/archive-meta-contract.test.ts` 既有断言抓（回退标记丢了会让旧 mutation 重现）。

### 1.5.4 门禁

`typecheck` / `typecheck:tui` / `npm test` / `test:node` / `build` / `find-cycles`，再 `build:exe` + `runtime/dist` 冒烟。
基准：M0 后重跑 `.tmp/measure-log-waste.mjs`、`.tmp/bench-resume.ts`（三档），报告磁盘与常驻的原始字节下降；**并据此重新决定 M1 的范围（D12）**。

> **常驻基准已跑（2026-10-23；`.tmp/build-after-dirs.mjs` 物化三档"新管线形态"，`.tmp/bench-jsonl-vs-legacy-read.mjs` 同进程 A/B）**
>
> | 档 | legacy `log.json` | 新形态 `log.jsonl` | 耗时 | 驻留 |
> | --- | --- | --- | --- | --- |
> | tier-5mb | 5.2 MiB → 23 ms / heap +8.0 MiB | 3.0 MiB → 24 ms / +6.9 MiB | 1.06× | **0.87×** |
> | tier-50mb | 50.1 MiB → 182 ms / +72.8 MiB | 30.7 MiB → 207 ms / +58.6 MiB | 1.14× | **0.81×** |
> | tier-200mb | 201.7 MiB → 820 ms / +297.1 MiB | 128.4 MiB → 1043 ms / +233.6 MiB | **1.27×** | **0.79×** |
>
> 结论：M0+M1 把常驻压到 0.79–0.87×（200 MB 档 −63.5 MiB），接近 P0.2 的 −28% 上界的 3/4；**但同机 A/B 显示 JSONL 逐记录解析比 legacy 单次 `JSON.parse` 慢 1.06–1.27×**——这是写侧换格式的读取代价，记为 **P-17**，由读侧 R-2（有界反向扫描）偿还。跨轮次的 656 ms → 914 ms 不能直接相减：本机同代码态的 legacy 复测已是 820 ms，轮次间噪声 ±25%。
> 注意口径：夹具无 `archive/`，M0 的剥离在恢复时不会回填 display；真实会话由 `hydrateArchivedDisplay` 在启动补齐，所以这部分常驻收益**在真实语料上会被抵掉**，M1 的 sealed 化才是常驻收益的可靠来源。

---

## 2. P1 — M1 思维链封存态外置

> **实施状态（2026-10-23，已落地）**：实际测试在 `tests/config/log-m0-m1.test.ts`。侧车目录 `sealed/`、预算 4096 B、4 MiB LRU、写入前物化 `thinkingArtifact`、投影 `resolveReasoningState` 均已实现。**偏差**：archive 仍存内联 meta（唯一一份密文），M0 剥离后 sidecar 由 `pruneSealed` 回收，未改成 archive 引用；fork 整目录复制会带上 `sealed/` 但无专门红测；旧会话由 `persistence_policy=2` 触发一次快照归一化。

（写侧 §W4.3 + 读侧 §R3.7；对应 P-1/P-2，**范围待 M0 之后重定，见 D12**）

### 2.1 红测（先写，先红）

- [x] **R1.1** `tests/config/log-m0-m1.test.ts`（实际路径）：`meta.reasoningState` 序列化后 ≥ `SEALED_INLINE_BUDGET_BYTES = 4096` 的 reasoning 条目，保存后
  ① `log.jsonl` 内该键是 `{sealedRef, bytes, encoding:"gzip"}`，不含密文；② `sealed/<entryId>.json.gz` 存在且 gunzip 后与原始值 `toEqual` 逐字等价；③ 引用里的 `bytes` 等于原始序列化字节（不是压缩后）。
  期望来源：写侧 §W4.3 记录规格 + 总体 §1.1 预算。**红在**：当前 `entryToSnake` 原样内联（[src/config/log-serialization.ts:20-37](src/config/log-serialization.ts#L20-L37)）。
- [x] **R1.1b** 已测：正好 4096 B → 外置；4095 B → 内联。防"预算语义"写成 `>` 而规格是 `≥`。
- [x] **R1.2** 已测：小值（< 预算）保持内联，**不生成 sidecar**（负向探针，防止把所有 meta 都外置）。
- [x] **R1.3** 已测：`loadLog` 后 `entries[i].meta.reasoningState` **未解压**（引用形态），投影带 `resolveSealedState` 时 `_reasoning_state` 与"不外置"时逐字等价。
  期望来源：总体 §3 原则 4。
- [x] **R1.4** 已测：sidecar 缺失/损坏 → 投影**仍产出消息**且走"不带封存态"分支，warning 可见（不允许抛错打断回合）。
- [x] **R1.5（替代方案）** archive 存内联 meta，M0 剥离后 `pruneSealed` 删除 sidecar，长期只有一份密文：窗口关闭归档时，`window-<n>.json.gz` 的 `meta` 只含引用，**不含第二份密文**（写侧 §W4.3 + 读侧 §R3.7）。
- [ ] **R1.6（未测）** fork 整目录复制会带上 `sealed/`，无专门红测：fork 后新会话目录含 `sealed/`，且 fork 会话的投影能取回封存态（耦合点 4）。
- [x] **R1.7** 统一 v4；旧 JSONL/legacy 无 `persistence_policy` 时下一次保存快照归一化：`version: 2` 旧日志内联读，不产生 sidecar；`version: 3` 新日志写引用（写侧 §W7）。
- [x] **R1.8** 已测 `pruneSealed` 只删孤儿、保留存活：条目被 `discarded`/回退删除后再次保存，对应 `sealed/*.json.gz` 被删，且**存活引用一个不少**（用文件列表比对，不用计数，防止"删错另一个"混过断言）。`pruneSealed` 返回删除数须与实际一致。

### 2.2 实现

- [x] **I1.1** 已新增 `log-sealed.ts` + 共享 `gzip-json.ts`：（深度 2，与其他 config 模块同级），对外形状见写侧 §W4.3：`SEALED_INLINE_BUDGET_BYTES`/`SealedRef`/`maybeExternalizeReasoning`/`readSealed`/`collectSealedRefs`/`pruneSealed`。
  ✅ gzip 助手已提到 `gzip-json.ts`： [src/config/archive.ts:55-62](src/config/archive.ts#L55-L62) 的**模块私有函数**：要复用必须先提到共享处（建议新建 `src/config/gzip-json.ts`，archive 与 sealed 都改为 import），**不要复制第二份**。
- [x] **I1.2** 引用是普通 meta 对象，codec 原样往返：：[src/config/log-serialization.ts:20-56](src/config/log-serialization.ts#L20-L56)。
- [x] **I1.3** 已实现 sidecar 先写、日志后写、成功后 prune：先写缺失的 sidecar（tmp+rename），再写日志；再删孤儿（写侧 §W6）。
- [x] **I1.4** JSONL v4；引用随 meta 原样读取：与引用识别：[:222-266](src/config/log-serialization.ts#L222-L266)。
- [x] **I1.5** 已实现 `resolveReasoningState` + 4 MiB LRU：`ProjectionOptions.resolveSealedState`，与 `resolveImageRef` 同形（[src/context/projection/api.ts:33-34](src/context/projection/api.ts#L33-L34)、消费点 [:331-356](src/context/projection/api.ts#L331-L356)）；Session 侧提供带 LRU 的实现。
- [x] **I1.6** 已实现：（耦合点 1）：检查 [src/context/entry/factories.ts:220-225](src/context/entry/factories.ts#L220-L225) 与 [src/thinking/artifact.ts:209-269](src/thinking/artifact.ts#L209-L269) 的推断链，确保外置后 `inferThinkingArtifact` 不再是投影期的必经路径。
- [ ] **I1.7（未按原方案）** 采用 archive 内联 + 剥离后删 sidecar 的单副本方案（耦合点 2）：[src/config/archive.ts:134-139](src/config/archive.ts#L134-L139)；`restoreArchiveToEntries` 恢复引用而非密文：[:300-314](src/config/archive.ts#L300-L314)。
- [ ] **I1.8（未测）** fork 会复制 `sealed/`，缺少专门测试：：`forkSessionDirectory` 是整目录 `cpSync`（[src/server/session-fork.ts:18-39](src/server/session-fork.ts#L18-L39)），只需红测覆盖；子会话独立目录由 [src/session/children/manager.ts:116](src/session/children/manager.ts#L116) 的 `loadLog` 走同一条取回链。
- [x] **I1.9** 删除仍是整目录 `rmSync`，sealed/ 随目录删除：（确认现有实现是整目录删除，不新增遗漏）。

### 2.3 变异检验（≥8 条，逐条写明抓什么）

- [ ] V1 让 `saveLog` 先写日志后写 sidecar → R1.4 的"崩溃时序"分支应被更严的断言抓住。
- [ ] V2 把预算改成 0（全外置）与改成 ∞（全内联）→ R1.1/R1.2 必须一红一红。
- [ ] V3 投影里去掉 `resolveSealedState` 调用 → R1.3 红。
- [ ] V4 sidecar 读取失败改为抛错 → R1.4 红。
- [ ] V5 归档记录写密文而非引用 → R1.5 红。
- [ ] V6 fork 不拷 `sealed/`（或只拷 `log.json`）→ R1.6 红。
- [ ] V7 `version` 不升级 → R1.7 红。
- [ ] V8 `pruneSealed` 改成"清空整个 `sealed/`" → R1.8 必须红（这是最容易蒙对也最容易埋雷的实现）。
- [ ] V9 `bytes` 记成压缩后长度 → R1.1③ 红。


> **M0/M1 + W-4 门禁现状（2026-10-23）**：typecheck / typecheck:tui / 全量 1350 passed / test:node / build / build:exe 已跑；`runtime/dist` 冒烟（`.tmp/verify-built-log.mjs`）新增 JSONL 快照、P-14 紧凑/不重写、M1 sealed 读回断言，全部通过。R0.6 三档磁盘对账已跑（结论见 §1.5.1 的 R0.6 表）；`.tmp/bench-resume.ts` 的三档**常驻**基准仍未重跑。

### 2.4 P1 门禁

`typecheck` / `typecheck:tui` / `npm test` / `test:node` / `build` / `find-cycles` + `.tmp/verify-built-log.mjs` 扩一条 sidecar 断言，在 `release/SwarmFlow-win32-x64/runtime/dist` 上跑。
基准：P0.2 的 50 MB 档前后对比，**resume 峰值驻留必须给出下降的原始字节数**。已给（2026-10-23，同进程 A/B，数据源 `.tmp/bench-jsonl-vs-legacy-read.mjs`）：50 MB 档 loadLog 驻留 **+72.8 → +58.6 MiB（−14.2 MiB，0.81×）**，200 MB 档 **+297.1 → +233.6 MiB（−63.5 MiB，0.79×）**，5 MB 档 +8.0 → +6.9 MiB。同一轮量到 JSONL 的读取代价（耗时 1.06–1.27×）→ 记为 P-17。
落盘对账（已跑，2026-10-23，`.tmp/measure-persist-disk.mjs`）：预期 `01a14e55…` 6.01 → 3.18 MB、`01a14fd1…` 5.50 → 3.65 MB、`01a15edb…` 1.34 → 1.28 MB，合计 −36.8%。**实测**基线（JSONL）6.22 / 5.62 / 1.38 MB → 3.40 / 3.77 / 1.31 MB，即 **−2.82 / −1.85 / −0.07 MB**，与预期剥离量 −2.83 / −1.85 / −0.06 MB 吻合到 0.02 MB 以内；绝对值高 ~3.5% 来自 JSONL 每条记录的 `seq/ts/op` 开销，不是 M1 少剥。
**口径更正**：合计 −36.8% 说的是**日志正文**；把 `sealed/*.json.gz` 一起算进磁盘后只有 **−8.5%～−19.3%**（封存态近不可压，P0 实测保留比 0.737–0.747）。M1 的真实收益是日志体积与 resume 常驻，不是磁盘总量。

---

## 3. P2 — M2 写时上限（写侧 §W4.3；对应 P-1 的 tool_result 侧）

> **P0 后降级、后置（P-10）**：真实语料 `toolMetadata` 出现率 2.5%，`reversePatch` 与 `_contentBlocks` 均 **0 字节**，`tool_result.content` P90 只有 7.2 KB。本阶段在本地工作流上无可测量收益，**排在 M1/M4 之后**；重入门槛：语料里出现任一 `tool_result` 的 `meta` 单条 > 64 KB，或 `_contentBlocks`/`reversePatch` 合计占 `log.json` > 5%（`.tmp/measure-log-shape.mjs` 可直接复算）。下列任务保留，不删。

- [ ] **R2.1** 红测：工具产出 `_contentBlocks` 里的 base64 图，保存后日志内是 `{type:"image_ref", path, media_type}`，图片文件在 `<sessionDir>/images/`，投影 `resolveImageRef` 能还原成 `type:"image"` + 原 base64。
  现状：[src/session/tool-drain.ts:231](src/session/tool-drain.ts#L231)、[src/agents/tool-loop/run.ts:726](src/agents/tool-loop/run.ts#L726) 直接内联，而 `image_ref` 机制已存在于 [src/session/attachments.ts:28-85](src/session/attachments.ts#L28-L85)。
- [ ] **I2.1** 把工具产出接入既有 `image_ref` 落盘函数（**复用，不新增存储层**）。
- [ ] **I2.2** 上限常量集中到新模块（或与 `sealed` 合并为一个"落盘预算"模块），截断实现统一调 `truncateUtf8`（[src/prompts/assembler.ts:142-152](src/prompts/assembler.ts#L142-L152)）。
- [ ] **I2.3** `display === content` 时不写 `display`（1.7% 的边角收益，作为 I2.2 的副产物，不单列任务）。
- [ ] **明确不做**：`reversePatch` 截断；活动窗口内 `tool_result.content` 截断（写侧 §W4.3、总体 §11）。
- [ ] 变异检验：≥3 条（image_ref 未接线 / 还原丢 media_type / 截断误伤窗口内正文）。

---

## 4. P3 — M3 冷区存根契约（读侧 §R3.3；对应 P-7）

- [ ] **R3.1** 红测：一次压缩 + 保存后，滑出折叠边界的条目在 `log.json` 里只剩身份字段 + `RETAINED_ARCHIVED_META_KEYS`（[src/config/archive.ts:155-161](src/config/archive.ts#L155-L161)），且冷区字节 ≤ 全量 15%。
- [ ] **R3.2** 红测：`compact_count === 0` 的会话冷区为 0（把 P-2 变成基准里的一行可观测量）。
- [ ] **I3.1** 若 R3.1 已绿（① 大概率已覆盖），本阶段只做**契约固化**，不改实现 —— 在总体 §2 P-7 行更新状态。
- [ ] **I3.2** 折叠边界与 TUI 投影共用同一计算，防止两处漂移：[src/context/projection/tui.ts](src/context/projection/tui.ts) 的 `computeCompactFoldBoundary` ↔ [src/session/compact-flow.ts:379-382](src/session/compact-flow.ts#L379-L382)。

---

## 5. P4 — M4 选择器与体积（读侧 §R3.5；对应 P-5/P-6）

- [x] **R4.1（2026-10-24）** 格式耦合锁：`readLegacyLogHeader` 只在 `"entries":[` 之前取头部；`session-legacy-list-header.test.ts` 用“合法头部 + 非法正文”锁住该边界。
- [x] **R4.2（2026-10-24）** `meta.json` 缺失时，两处列表只读头部即可列出：JSONL 用 `readLogHeader`，legacy 用 `readLegacyLogHeader`（fd + `readSync` 64 KiB）；正文非法仍能列出，测试 5 例。
- [x] **R4.3（2026-10-24）** 红测 `tests/session/session-dir-size.test.ts`：已知文件/目录精确求和；新增 2 MB `artifacts/` 文件后 `sizeBytes` 不变。
- [x] **I4.1（2026-10-25）** 抽出 `src/config/session-list.ts` 单一映射；`SessionStore.listSessions` 委托 `listSessionsInProject`，`resume.ts` 重新导出；`session-list-parity.test.ts` 两入口逐项相等。
- [x] **I4.2（2026-10-24）** `readLogHeader`（JSONL）与新增 `readLegacyLogHeader`（legacy，64 KiB 上限 + 超限回退）替换两处整读回退。
- [x] **I4.3（2026-10-24）** 体积统计改为已知文件 + 已知目录（`log.jsonl`/`log.json`/`.pre-v4.bak`/`log.index.jsonl`/`meta.json` + `archive/`/`images/`/`sealed/`）；`artifacts/` 不参与。
- [x] 变异检验：5 条（header 读取退回整读、SessionStore 分支退回整读、不去尾逗号、超限不回退、忽略 log.session_id）全部变红并恢复。

---

## 6. P5 — M5 冷会话归档（写侧 §W-5；**2026-10-24 已授权并落地**）

- [x] **R5.1** 显式命令归档/还原：`swarmflow sessions archive <id>` 后会话从 `listSessions` 消失、目录搬到 `<base>/archived_sessions/<project_slug>/<id>/`、活动日志变 `log.jsonl.gz`；`swarmflow sessions restore <id>` 后 `log.jsonl` **逐字还原**、`--resume <id>` 重新可用，`archive/`、`sealed/`、`artifacts/` 一并搬走。
  **偏差说明**：落地为 CLI 子命令而不是会话内 `/sessions`（任务原写法）。理由：归档对象是不活跃会话，且活动会话必须禁止归档；CLI 已有 `sessions` 列表命令，扩成 `archive`/`restore` 子命令改动面最小。`--work-dir` 由父命令解析（Commander 同名选项会被父级吞掉）。
- [x] **I5.1（已测）** M1 后用 `.tmp/measure-cold-gzip.mjs` 复算整体 gzip 比：tier-5mb **0.41×**、tier-50mb **0.39×**、tier-200mb **0.36×**（日志正文 0.14–0.17×，`sealed/` 已是 gzip、原样计入）→ 远低于 0.6 门槛，**保留压缩步骤**。
- [x] **I5.2** 新增 [src/config/session-archive.ts](src/config/session-archive.ts)（`archiveSessionDir` / `restoreSessionDir`，深度 2 同级）；`SessionStore` 增 `archiveSession` / `restoreSession`（复用 `looksLikeSessionId` 校验、跨候选 base 查找、拒绝归档活动会话）；CLI 在 [src/cli.ts](src/cli.ts) 的 `sessions` 下挂 `archive` / `restore`。
  安全顺序：归档 = 先整体 `rename`（同卷）→ 写 `.gz.tmp` → rename → 删明文 → 置 `archived` 标志；还原 = 先查目标冲突 → 解压明文 → 清标志 → 搬回。中途崩溃最多留下明文与 `.gz` 并存，还原以明文为准。
- [x] **不做**：zstd、按时间自动搬迁（保持显式命令）；`log.json.pre-v4.bak` 不压缩。
- 测试：`tests/config/session-archive-cold.test.ts`（4 例：归档/还原/legacy/守卫）+ `tests/cli/cli-session-archive.test.ts`（2 例 CLI 端到端）；4 条变异（不压缩、不置标志、还原不解压、去掉目标冲突守卫）全部变红并恢复。
- 门禁：全量 **1409 passed / 3 skipped**；`build:exe`（100.0 MB）+ `.tmp/verify-built-log.mjs` 新增冷归档往返断言（gz 存在、gunzip 逐字等价、restore 后逐字等价、落回 `projects/`）全部通过。

---

## 7. P6 — M6 甲方案判定（**原判出局，2026-10-23 后被 D14 取代**）

> **2026-10-23 起**：用户已指示采纳 Codex 写模型，M6 不再按"出局"处理；实施规格见 [写侧 W-1](LOG_WRITE_DESIGN.md)，记录集待 D15、迁移待 D16。下面保留原判定作为历史记录。

- [x] 依据 P0.3 数据判断：`单次重写字节 > 2 MiB` 在 50/200 MB 档成立，但 `每秒检查点 ≥ 1` **永不成立**（② 的 2 s debounce 把天花板钉在 0.5 次/s，实测 0.04–0.05 次/s）。AND 条件不满足 → **甲出局，保持整份重写**。
- [x] 原判据的第二子句衡量"频不频"，不衡量"单次占主线程多久"——已在总体 §7 D5/D14 与写侧 §W5 重述为
  **`单次 saveLog 耗时 P95 > 250 ms` 或 `单会话总写入 > 100 GiB`**；实测真实会话 18 ms / 3 GiB（远未触及），200 MB 档 427 ms / 2415 GiB（触及）。
  重入门槛 ≈ 单会话 200 MB（按真实节奏 = 连续用 6 天），当前工作流差 30 倍。
- [ ] 重开时：语义建模（补丁重放、检查点锚点、崩溃安全、迁移回退）已由写侧 §W3/§W4 给出；实施见 W-1。
- [ ] **2026-10-23 追加**：用户指出写侧磨损/代价偏大。Codex 的写路径已核实为"逐条追加 + 64 KiB 截断 + 不 fsync + 冷文件 zstd"（写侧 §W2）；我们 6.65 MB 会话仍是 3.00 GiB（462×）。**2026-10-23 用户指示采纳 Codex 写模型（append-only JSONL）**：记录集见 D15、迁移见 D16，不再走 base+delta。**未授权前不动代码。**

---

## 7.5 P7 — M7：修 `validateAndRepairLog` 超线性（P0 新发现 P-9；**需单独授权，= 设计 D7**）

- [x] **R7.1（2026-10-25）** `tests/config/log-repair-complexity.test.ts` 用 20k / 40k / 80k 条合成日志（10% action + 10% 待重戳 reasoning + 80% 填充）测 `validateAndRepairLog`：
  `t(40k)/t(20k) <3.5`、`t(80k)/t(20k) <8`；**旧 ×4 为 16.96×，新 ×4 为 2.4–4.8×**（3 次取最小值）。
  确定性读取计数：Proxy 统计 `type`/`roundIndex`/`turnIndex`/`discarded` 的读取，**旧 1,412,800 次（706×N）→ 新 18,601 次（9.3×N）**；断言 ≤40×N，不依赖计时。
  **收益范围**：R-2/R-3 后 bounded resume 只 repair 活动窗口；R-5 的主要收益在 full/legacy 恢复、迁移和全量重建。1279 ms 是 full 场景数字，bounded 验收不得复用。
- [x] **I7.1** 用不含 tool_call/ask 的夹具隔离第 2/3 步：旧实现 706×N 读取 vs 新 9.3×N，确认超线性来自第 4 步；未保留旧实现。
- [x] **I7.2** 一次预扫描建 `roundIndex → Set<turnIndex>` 与 `(turn,round) → 有动作` 两张表，第 4 步改查表。索引只统计**未丢弃且 `roundIndex !== undefined`** 的 action（`tool_call`/`tool_result`/`assistant_text`/`no_reply`）；reasoning 不计入；组合键 `turnIndex + ":" + roundIndex`。
- [x] **等价性 R7.2（不保留旧逻辑/旧代码）**：变更前采集 `tests/config/fixtures/log-repair-golden.json`（9 个边界夹具）；改后 golden 10 例逐项相等（含同 turn 不同 round 的组合键用例）。
  另对真实 4 份会话做变更前哈希：改后 `entries`（recovered timestamp 归一化）、`repaired`、`warnings` 全部一致（457 / 2978 / 8 / 1659 条）。
- [x] 变异检验：5 条（退回内层全表扫、action key 丢 round、round map 按 turn、reasoning 计入 action、discarded 未过滤）全部变红并恢复；`roundIndex !== undefined` 过滤无行为差（只影响索引卫生），由实现与审查保证。

---

## 7.6 P8 — M8：用量统计改走 `meta.json`（新发现 P-11；**需授权，= 设计 D8**）

现状：`computeGlobalTokenStats` 对 projects × sessions 双重循环，逐个 `JSON.parse(readFileSync(log.json))`（[src/config/session-store.ts:359-401](src/config/session-store.ts#L359-L401)，整读在 [:377](src/config/session-store.ts#L377)），只为求和 `token_update`。本机 4 会话 = 12.87 MB 全解析；且 [:385](src/config/session-store.ts#L385) 的 `meta["input_tokens"]` 蛇形分支是**死代码**（磁盘实测是 camelCase）。

- [x] **R8.1** 红测 `tests/config/session-store-usage-meta.test.ts`：两个会话各只有 `meta.json`（含 `tokens`）+ 非法 JSON 的 `log.json`/`log.jsonl`，统计仍正确 → 证明没有整读。**已通过**。
- [x] **R8.2** 一致性红测：真实会话保存后 `meta.tokens` == 日志内所有 `token_update` 的求和（含 cacheRead）。见 `tests/session/session-jsonl-persistence.test.ts`。
- [x] **R8.3** 缺 `tokens` 的旧会话：按 **D8(a)** 计入 `sessionsWithoutTokens` 列表、不整读、不计数；UI 用量面板显示 "Untracked" 行。
- [x] **I8.1** `saveSessionMeta` 增 `tokens` / `first_input` / `first_user_message_tokens`，值取自 `Session.usageTotals`（复用 `aggregateTokenUsage`，未在写侧新算一套）。有界恢复以 `meta.tokens` 为基线、只累加恢复后新增的 token_update；回退时从基线扣减已计入的条目（崩溃窗口最多少算 debounce 的 ≤2 s，按 P-8 既有口径接受）。
- [x] **I8.2** `computeGlobalTokenStats` 只遍历 `meta.json`，删除整读循环与蛇形死分支；`GlobalTokenStats` 增 `sessionsWithoutTokens`。
- [x] 变异：4 条（少算 output、缺 tokens 不列、忽略有界基线、回退不扣减）全红。
- 门禁：全量 **1409 passed / 3 skipped**。

## 7.7 P9 — M9（已否决）与契约清理（新发现 P-13 / P-12）

- [x] **P9.1（已核实，2026-10-23；不改代码）**：三处消费点 + 全仓搜索（`src/`、`tests/`、`external/opentui/`）已读。
  **结论：M9 否决。** `token_update` 同时被两类互斥语义消费：① 逐次求和——`aggregateTokenUsage`（[usage-accounting.ts:66](src/session/usage-accounting.ts#L66)）、`computeGlobalTokenStats`（[session-store.ts:413](src/config/session-store.ts#L413)）、子代理 `tokensIn`（[manager.ts:942](src/session/children/manager.ts#L942)）；② 最后一条即当前上下文——恢复时反向扫描取最近有效值（[log-surgery.ts:604-620](src/session/log-surgery.ts#L604-L620)）。合并成一条要么少算累计输入，要么放大 `inputTokens` 导致重启即误压缩（`session-compact-token-accounting.test.ts` 锁住的回归）。TUI 只消费事件（[app.tsx:1030-1037](external/opentui/app.tsx#L1030-L1037)），投影直接跳过。收益仅 2.3% 字节，**不再讨论**。结论已写回总体 §7 D9/P9.1。
- [x] **P9.2（2026-10-24 完成）**：`onSaveRequest` 契约统一为 `() => boolean`（[src/session.ts](src/session.ts) + [src/ui/contracts.ts](src/ui/contracts.ts) + 各 host slice）。
  - TUI `autoSave` 返回 `persistSessionLog` 的真实结果；`scheduleSave` 返回 **false**（只排队、尚未同步落盘），以免调用方误以为 journal 可以提前 finalize。
  - `external/opentui/autosave.ts` 带编译期断言：`TuiSession["onSaveRequest"]` 的返回类型必须是 boolean；`tests/ui/opentui-autosave.test.ts` 3 例覆盖成功/失败/异常。
  ⚠️ 未合并两条 finalize 路径（D10 约束保持）。
- [x] **P9.3（已完成，2026-10-23）**：P-14 伴生文件节流随 W-4 落地——`isSameUtcMinute` 统一判定（[timestamps.ts](src/config/timestamps.ts)），`saveSessionMeta` 内容不变直接返回，`project.json` 跨分钟才写，两处均为紧凑 JSON。测试 `tests/config/session-sidecar-throttle.test.ts`（5 例）+ `tests/session/session-jsonl-persistence.test.ts` 集成 1 例；4 条变异（取消分钟节流 ×2、取消跳过写、恢复美化输出）全部变红。**偏差**：`_ensureProjectMetadata` 首次创建仍用 `null, 2`（一次性写，随后被首次保存转为紧凑），未改。

---

## 7.8 P10 — M10：rewind 落盘物的生命周期（**用户点名标记，P-16；D13 ✅ 2026-10-24**）

**探针结果（2026-10-23，`tests/session/rewind-fork-probe.test.ts`，4 例全绿，代码未动）**

- [x] **I10.5** fork 探针：造带 ready-state journal 的会话 → `forkSessionDirectory`（[session-fork.ts:39](src/server/session-fork.ts#L39) 整目录 `cpSync`）→ 以 `fork: true` 走 `applySessionRestore`（[resume.ts:260](src/session/resume.ts#L260) 调 `recoverRewindIfNeeded`）。
  实测四条：
  1. fork 后 `artifacts/rewind-journal.json` 与 `rewind-journal.json.data-<uuid>` 都被复制（继承事实成立）。
  2. fork 恢复**不回放**：`_readRewindJournal` 的 `raw.filePath !== path` 校验（[engine.ts:704-712](src/session/rewind/engine.ts#L704-L712)）拒收副本，告警原文 `[rewind] recovery failed; the journal was retained: Rewind recovery journal is invalid; it was preserved for manual recovery.`，工作树不动。
  3. 机制隔离：把副本的 `filePath`/`backupDir`/`preimage.backupPath` 改成 fork 本地路径后，同一恢复流程立即回放并改写工作树 → 拦截点就是绝对路径绑定，不是 `_journalMatchesPersistedLog`（[engine.ts:291-294](src/session/rewind/engine.ts#L291-L294)，路径校验先抛，根本没走到）。
  4. 父会话 journal 不受 fork 影响；父会话恢复完成后，fork 的陈旧副本也不会覆盖后续编辑。
  → **"fork 会误恢复父会话文件"撤回**；残留只有死文件 + 每次恢复一条误导告警 + 副本内的用户文件内容。

**删除侧核实（用户点名需求）：已满足，不改代码**

- 唯一删除入口 [session-picker.ts:61-70](src/cli/session-picker.ts#L61-L70) 的 `rmSync(sessionDir, {recursive, force})`（调用点 [:538](src/cli/session-picker.ts#L538)）会连带删掉 `<sessionDir>/artifacts` 下的 journal 与 `.data-*`（[session-store.ts:335](src/config/session-store.ts#L335)）。
- 不存在用户可配的外部 artifacts 路径：`sessionArtifactsDir` 只由子会话构造传入（[session.ts:4012](src/session.ts#L4012)），值为 `<childSessionDir>/artifacts`（[manager.ts:330-331](src/session/children/manager.ts#L330-L331)），子会话目录又在父会话目录内（[manager.ts:316-317](src/session/children/manager.ts#L316-L317)）。
- **勘误**：原 R10.1 设想的 `paths.session_artifacts` 外部覆盖在仓库里不存在（该串只在错误文案中），场景不可达，条目删除；原 I10.1/I10.2（删除侧显式回收）、I10.3/I10.4（`session_id` + 孤儿 GC）、R10.5（删除前告知）随之撤销——可达布局下没有消费者。选择器本身已有二次确认（[session-picker.ts:537-538](src/cli/session-picker.ts#L537-L538)）。

**可选清理（D13 ✅ 2026-10-24；本就不影响正确性）**

- [x] **R10.6（2026-10-24）** 探针翻转：fork 后新会话 artifacts 内不存在 `rewind-journal.json` 与 `.data-*`，父会话两者仍存在；fork 恢复不再出现 `[rewind]` 告警。新增 `tests/session/rewind-artifacts.test.ts`（journal + 目录/文件两种备份 + 无关文件保留 + 目录缺失）。
- [x] **I10.6（2026-10-24）** rewind 子系统新增 `src/session/rewind/artifacts.ts`（`REWIND_JOURNAL_FILENAME` / `rewindJournalPath` / `rewindJournalBackupDir` / `isRewindJournalBackupName` / `discardRewindArtifacts`）；`forkSessionDirectory` 在 `cpSync` 成功后调用，server 层不拼文件名。engine 的 journal 路径/备份规则也改为引用该模块。
- [x] 变异检验：跳过清理、只删 journal 不删备份、误删无关 artifacts 三条全部变红并恢复。

---

## 7.9 W-1 写侧（2026-10-23：核心已实现，运行期未接线）

- `tests/config/log-jsonl-format.test.ts`：header、五种 op、非法记录、尾随换行、header 只读首行。
- `tests/config/log-jsonl-append-replay.test.ts`：追加不重写、空批次、session 仅首行、半条尾行、坏行、seq 缺口/重复、重放语义、写放大。
- `tests/config/log-jsonl-policy-migration.test.ts`：ephemeral/完成态、64 KiB 截断、图片 image_ref、v2→v4 迁移、备份、幂等、损坏不破坏、fork 迁移。
- `tests/session/log-mutation-gateway.test.ts`：变更网关、直接变更守卫、端到端重放等价、fork 独立。
- 当前状态：**全量 1466 passed / 3 skipped**；写侧专项（W-1/W-2/W-3 + P-14 + 写锁/seq）全绿。W-1 + W-2 基础策略（只写完成态、64 KiB 截断、图片 image_ref）均已实现；封存态外置（M1）已落地；`token_update` 合并（M9）经 P9.1 否决。
- 已实现：`log-jsonl` 格式/追加/重放/崩溃尾行/迁移、`SessionLog` 变更网关、`forkSessionDirectory` 支持 JSONL 并重写 header、W-2 完成态/截断/图片外置。
- **变更点接线完成（2026-10-23）**：流式增量、工具同步、丢弃、压缩归档/剥离、inbox 恢复、回退截断、rewind 标记共 14 处已改走 `SessionLog` 网关；全量测试通过（后续已扩到 1409 例）。
- **运行期已切换（2026-10-23）**：`Session.persistToDisk` 首次快照、之后增量追加；TUI/RPC/resume/子会话全部改走它。`loadLog` 优先 `log.jsonl`，legacy 自动迁移；选择器/用量统计/存储修复已兼容 JSONL。全量 **1409 passed / 3 skipped**。
- **W-3 已完成（2026-10-23）**：归档 patch、rewind truncate、compact_marker/context 与 `usage` 检查点均已落盘；真实压缩测试发现并修复 `archiveEntries` 跳过已归档条目的 bug。
- **W-4 已完成（2026-10-23）**：P-14 伴生文件节流落地（`last_active_at` 跨分钟、`meta.json` 内容不变跳过、两处紧凑 JSON）；M9 经 P9.1 核实否决。测试 `tests/config/session-sidecar-throttle.test.ts` 5 例 + `tests/session/session-jsonl-persistence.test.ts` 运行期集成 1 例；4 条变异（取消分钟节流 ×2、取消跳过写、恢复美化输出）全部变红。
- **W-5 已完成（2026-10-24）**：显式 `sessions archive|restore`（整目录搬到 `archived_sessions/` + 活动日志 gzip），不复用自动搬迁/zstd。测试 6 例、4 条变异全红；发布产物冒烟含冷归档往返。
- **读侧已切有界（2026-10-24）**：`loadModelContext` 反向有界扫描接入 resume；选择器优先 `meta.json`，坏 meta 时读 `log.jsonl` header；`loadLog` 仅用于迁移/全量重建。
- `src/config/log-write-policy.ts` 已实现（完成态/64 KiB/图片外置），不再是骨架。
- 变异检验已随各阶段补做：W-1/W-2/W-3 共 8 条、M0/M1 共 4 条、P-14 共 4 条，均按预期变红并恢复。

---

## 7.10 写侧收口审查（2026-10-24）

**本轮修复的真实缺陷（均红测先行 + 定向变异）**

- [x] **JSONL 元数据 null 泄漏**：`sessionMetaFromSnake` 对可选字段直接做类型断言，`meta.json` 的 `null` 会泄漏成 `modelProvider=null` / `title=null`（类型声明是 `string | undefined`，legacy 读取返回 undefined）。统一收敛为 `optionalString()`（[log-codec.ts](src/config/log-codec.ts)）。红测：`tests/config/log-jsonl-format.ts` 的“null 恢复为 undefined”。
- [x] **fork 缺 meta.json 时会话消失**：首次快照与 meta.json 之间有崩溃窗口，此时 fork 只写了身份字段，`turn_count` 缺失 → `listSessions` 按 0 轮跳过。改为从 JSONL header / legacy 头用 `buildLogHead` 重建完整元数据（[session-fork.ts](src/server/session-fork.ts)）。红测：`tests/config/log-jsonl-policy-migration.test.ts` 的 fork 重建用例。
- [x] **子会话中断正规化绕过网关**：`normalizeInterruptedTurnInLog` 原来只在内部就地改 `discarded`；子会话在 `_interruptBlockedChild` / `suspendAll` 里走的是 live 视图，于是这些标记不进待写队列，重启后丢失。改为透传 `patchFlags` 回调，`Session._normalizeInterruptedTurnFromLog` 接到 `SessionLog.patchFlags`（[log-surgery.ts](src/session/log-surgery.ts)、[session.ts](src/session.ts)）。红测：`tests/session/session-jsonl-persistence.test.ts` 的“先落盘、再正规化、再落盘”用例。
- [x] **rewind 恢复保存失败被吞**：`applySessionRestore` 直接 `persistToDisk()` 不看返回值，失败仍 finalize journal。改为返回 false 时抛错（journal 保留可重试）。
- [x] **冷归档失败顺序**：gzip 提前到搬迁之前（压缩失败目录原地不动）；搬移后任一步失败且明文仍在时尝试整体回滚。归档顺序改为“写 gz → 置标志 → 删明文”。

**复核通过**

- 网关覆盖：`_log.push` / `splice` / `length=` 在 `src/session*` 已绝迹；仅剩的 `discarded/archived/content=null` 就地写全部位于网关 mutator 或**已克隆的快照视图**（`parseRestoredState` 的 surgery）。
- 追加性 / 重放 / 半条尾行 / seq 告警 / 迁移校验 / 归档 strip / sealed 回收 / P-14 节流：均有独立测试，且 `runtime/dist` 冒烟覆盖。
- 行尾：`src/**`、`tests/**` 全部 CRLF、无 bare LF。

**遗留（未做，按设计边界或需授权）**

1. **writer lock 与写侧 seq 单调校验**（设计 W4.2）：当前仍是单进程假设；`appendRecords` 不校验 seq 连续。
2. **`archiveWindow` 与网关双写规则**：`archiveWindow` 仍先就地改内存，`archiveEntries` 再记录一次；幂等但规则有两处。
3. **retained-meta 剥离逻辑三份复制**：`stripEntryForPersistence`、`stripArchivedPresentation`、`log-jsonl.applyPatch` 各写一遍同一白名单（当前都引用同一个 `RETAINED_ARCHIVED_META_KEYS`，未漂移）。
4. **未使用的导出**：`nextSeq`、`collectSealedRefs`、`prepareEntryForPersistence`（仅测试/无消费者）——按“不删看起来没用的代码”约定保留，待确认。
5. **resume 期修复不落盘**：`validateAndRepairLog` 与中断正规化的**就地**修改只影响内存，policy=2 的会话不会写回；每次加载重新推导（确定性、非正确性问题，但与原“整份重写会顺带持久化修复”不同）。
6. 迁移 + 归一化首次保存会写两遍快照（一次性开销）；`readLogHeader` 固定读 64 KiB（超大 header 会解析失败）；`hydrateArchivedDisplay` 在 full/legacy 路径仍于启动时读取全部窗口（bounded 路径不触发；展开历史时另走 `loadArchivedDisplays` 并按需缓存）。

**门禁**：typecheck / typecheck:tui / **1409 passed / 3 skipped** / test:node / build（306 模块 0 循环）/ build:exe（100.0 MB）+ `runtime/dist` 冒烟全绿。

---

## 7.11 R-2 有界模型上下文（2026-10-24，核心落地；接线待 R-3）

- [x] **实现**：`loadModelContext(dir)`（[log-jsonl.ts](src/config/log-jsonl.ts)）从文件尾按 64 KiB 反向扫描，停在最新 live `compact_marker`，返回 **marker 及之后**。语义：
  - 同一 id 只看离文件尾最近的 upsert；
  - `truncate` 建立死区直到 `fromEntryId`（截断后追加的记录保留，不误删）；
  - 压缩时在 marker 之后补写的 `archived: true` upsert 属于标记前窗口，**过滤**；
  - marker `discarded` / 事后 patch 丢弃 → 继续向更早找；
  - 无 live marker 或 meta 缺计数器 → 回退整读（`bounded=false`）。
- [x] **追加安全契约**：meta.json 新增 `id_counters` / `work_count` / `tool_call_count` / `last_tool_call_summary` / `recent_session_events` / `last_turn_end_status` / `self_phase`。有界恢复用 meta 快照补窗口缺失（workCount/工具计数取 max，信号优先 meta）；`LogIdAllocator` 新增 `snapshotCounters` / `restoreCounters` / `mergeFrom`，避免窗口里没有某前缀时从 001 重号。
- [x] **测试**：`tests/config/log-model-context.test.ts`（10 例）——窗口与全量 slice 深度相等、压缩归档 upsert 过滤、discarded marker、truncate 跨 marker、整段截断回退、无 marker 回退、计数器继承、缺计数器回退、扫描字节上限、半条尾行。
- [x] **变异**：5 条（不过滤归档 upsert / 忽略 discarded / 忽略 truncate 死区 / 缺计数器仍走有界 / 不恢复计数器）全部变红并恢复。
- [x] **基准（`.tmp/bench-model-context.mjs`，`node --expose-gc`，after-dirs）**：

  | 档 | 整读（耗时 / 常驻 / 条目） | 有界 | 扫描字节 | 相对 |
  | --- | --- | --- | --- | --- |
  | 5 MB | 21 ms / +6.2 MiB / 2146 | **6 ms / +3.1 MiB / 343** | 0.7 MiB | 3.8× / 0.50× |
  | 50 MB | 171 ms / +58.9 MiB / 18224 | **37 ms / +28.1 MiB / 2905** | 7.3 MiB | 4.6× / 0.48× |
  | 200 MB | 652 ms / +230.5 MiB / 77944 | **40 ms / +29.3 MiB / 3063** | 7.7 MiB | **16.2× / 0.13×** |

- [x] **已接线（2026-10-24）**：`applySessionRestore` 对 JSONL 走 `loadModelContext`；缺 `idCounters/workCount/tokens`、无 live marker、或 `persistence_policy !== 3` 时回退整读；`windowStartOffset` 启用历史分页。P-17 的端到端收益已兑现（200 MB 档 652→40 ms）。
- 残留：`usedContextIds` 仍只来自窗口（4-hex 随机，碰撞概率可忽略）；旧 JSONL 首次有界读取回退整读一次，下一次保存补写计数器后生效；`readLogHeader` 仍限 64 KiB。

---

## 7.12 R-3 历史分页（2026-10-24，读层 + TUI + resume 接线完成）

- [x] **分页器**：`src/config/log-history.ts` 的 `TuiHistoryPager` / `loadLatestTuiPage`。从字节游标（默认文件尾，R-2 的 `windowStartOffset` 可作起点）按 64 KiB 反向扫描，逐页返回**已应用补丁/截断**的条目（旧→新）。页大小默认 200 条 / 2 MiB（先到者）。
- [x] **顺序正确性**：upsert 记录新增可选 `replaces: true`（写入侧知道条目已落盘）；分页器先持有最新内容，扫到**创建记录**时按创建位置发射——与全量重放 `Map.set` 的原始顺序一致。旧日志没有该标志（按创建处理，可能把更新条目放到较新位置），由 `persistence_policy=3` 触发下一次保存的一次性快照重写。
- [x] **写入侧配套**：`SessionLog` 维护 `_persistedIds`（`replace` 初始化、truncate 删除、快照 `markPersisted`、增量 commit 登记），只对已落盘条目发 `replaces`；`saveSessionMeta` 的 `persistence_policy` 由 2 升到 3，旧 JSONL/legacy 在下一次保存归一化重写。
- [x] **测试**：`tests/config/log-history-pager.test.ts` 10 例（页序/补丁/创建顺序/truncate/字节上限/首屏读取上限/尾行/窗口起点/跨页 replaces/大 replaces 切页）；`log-jsonl-format` 增 replaces 校验；`log-mutation-gateway` 增“创建 vs replaces / truncate 后重建”；`session-jsonl-persistence` 增“全量 vs 有界信号优先级”。3 条变异（忽略 replaces、忽略 dropPresentation、忽略 truncate 死区）全红。
- [x] **审查修复（2026-10-24）**：
  1. **全量恢复信号以日志扫描为准**，只有 `bounded=true` 才用 meta 快照（`LoadLogResult.bounded` → `prepareRestoreFromLog` → `parseRestoredState`）。避免崩溃后 meta 落后于已追加条目时把旧状态带回来。
  2. `hasMore` 以 header 结束偏移为界，消灭“只剩 header 时多一个空终止页”。
  3. 页字节上限改按**发射条目的序列化字节**计；更新后的大内容（如 120 KB replaces）会正确触发切页。
  4. `startOffset` 必须落在行首（文档化）；`loadLatestTuiPage` 是单页便捷入口，连续翻页必须复用同一个 pager（held/patch/truncate 状态跨页）。
- **仍需注意的边界**：从 EOF 起翻页会把活动窗口也算进去（UI 必须传 `windowStartOffset`）；EOF 仍未等到创建记录的 held 条目会被丢弃（仅可能来自被 truncate 的创建，正常重加会写成新创建）；旧日志没有 `replaces` 时可能把更新条目放到较新位置，直到 policy=3 的一次性重写。
- [x] **基准（`.tmp/bench-history-pager.mjs`）**：首屏（200 条）**2.0–3.5 ms / 读 448 KiB**；前 10 页（2000 条）**19–24 ms / 读 3.3–4.9 MiB**，与文件总量（3–128 MiB）基本无关。
- [x] **接线（2026-10-24 完成）**：
  1. `Session.getDisplayLog()` 合并已加载历史；`loadEarlierHistoryPage()` 按页取回（去重、bump revision）；`/history` 命令显式触发。**滚动自动加载已接（2026-10-24）**：250ms 轮询活动 scrollbox，`previousTop > 1 && currentTop <= 1` 边沿触发一页（不会停在顶部反复加载）；PageUp 在顶部时每次按键加一页。仅对主会话 scrollbox 生效，detail 标签不触发。
  2. `applySessionRestore` 对 JSONL 走 `loadModelContext`，以 `windowStartOffset` 启用历史分页；**有界守卫**：缺 `idCounters/workCount/tokens`、无 live marker、或 `persistence_policy !== 3` 时回退整读（后者防止归一化快照只写窗口而丢历史），并给出 `[load]` warning。
  3. `listTurns`/`getRewindTargets` 在有界会话下按需读完整日志；`planRewind`/`rewindConversation` 先 `_materializeFullHistory()`（落盘窗口 → 整体替换 `_log` → 关闭分页、用量回到全量口径）再回退。turn 索引（D20）已接入（§7.13）。
  4. 历史页中已归档且 display 被剥离的条目，按需从 `archive/` 取回（`loadArchivedDisplays` 缓存），不再启动预加载。
- **测试**：`tests/session/session-resume-bounded.test.ts` 7 例（窗口加载/历史分页/回退物化/planRewind/缺计数器/缺 tokens/旧 policy/归档 display）+ `/history` 命令注册。4 条变异（忽略有界、listTurns 只看窗口、回退不物化、不取回 display）全红。
- **仍未做**：真实终端 TUI 目视验证（本机无 TTY）；顶部"更早 N 条"占位与 8 MiB 页缓存；D20 在 patch/truncate/快照后的定向维护（见 §7.14）。

---

## 7.13 D20 可重建 turn 索引（2026-10-24）

- [x] **形态**：`<sessionDir>/log.index.jsonl`，每行一条 `header/turn/mutation/drop-mutation/revert/checkpoint`；`turn` 存 `{turnIndex, entryId, entryIndex, kind, preview, timestamp}`，`mutation` 存 `{entryId, turnIndex, path, additions, deletions, reverted}`。权威仍是 `log.jsonl`，索引只服务回退菜单。
- [x] **校验/重建**：`source_seq`（最后 checkpoint）必须等于 `readLastSeq(dir)`；不一致、缺失或损坏 → 整读完整日志 + `buildTurnIndex` 重建并原子写回。有界会话 `getRewindTargets()` 命中索引时不再读日志正文。
- [x] **增量维护**：每次增量保存后，若索引 checkpoint 等于保存前 seq，则把新 turn / tool_result mutation / revert / drop-mutation 追加并写新 checkpoint；**出现 patch 或 truncate、或任一快照保存 → 删除索引**（下次读取重建，避免语义漂移）。崩溃窗口（日志已写、索引未写）由 seq 校验兜底。
- [x] **turn_end 定稿（2026-10-24 补全）**：批次里出现 `turn_end` 时，强制刷新该 turn 的完整 `turn` 记录 + 该 turn 当前所有文件变更摘要（即使边界/工具结果分散在多个批次）。索引缺失且是**无分页的短会话**（≤5000 条）时，turn_end 直接自建索引（从内存日志构建），不必等首次打开回退菜单；长日志/有界会话仍按需重建。
- [x] **归档**：构建时把 archive 的 turn 预览/mutation 摘要合并进来（stripped 条目也有 preview）；新增 mutation 仍走日志 upsert。
- [x] **测试**：`tests/session/turn-index.test.ts` 5 例（构建/校验/增量/丢弃/坏行）；`tests/session/session-turn-index.test.ts` 6 例（有界首开与整读一致、增量新 turn、turn_end 补全、短会话自建、截断失效、seq 落后重建）。6 条变异（忽略 seq、忽略 before_seq、不追加 turn op、truncate 不失效、跳过 turn_end、禁用自建）全红。
- **基准（`.tmp/bench-turn-index.mjs`，after-dirs）**：
  | 档 | 整读+构建 | turn/mutation | 索引大小 | 索引读取（warm min） |
  | --- | --- | --- | --- | --- |
  | 5 MB | 56+2 ms | 16 / 0 | 3.3 KiB | **0.59 ms** |
  | 50 MB | 272+4 ms | 101 / 0 | 27.3 KiB | **0.85 ms** |
  | 200 MB | 1066+21 ms | 476 / 0 | 113.2 KiB | **3.02 ms** |
- **剩余**：首次打开仍要整读重建（索引缺失/损坏/未知语义）；patch/truncate/快照后的定向维护已落地（§7.14）。真实终端 TUI 仍未目视验证。

---

## 7.14 D20.1–D20.3：消除 patch/truncate 后的整读重建（✅ 2026-10-24 完成）

**问题**：`_updateTurnIndexAfterAppend` 目前遇到任何 `patch` 或 `truncate` 直接 `deleteTurnIndex`，快照保存也删除（[session.ts:1969-1971](src/session.ts#L1969-L1971)、[:2547](src/session.ts#L2547)）。索引缺失后，首次打开回退菜单要整读日志重建（200 MB 档 1066+21 ms）。长会话的工具回退、压缩丢弃、中断正规化等都会触发。

**Codex 对照（2026-10-24 复核）**：Codex 不在持久化流里做 patch/truncate——legacy 追加 `ThreadRolledBack` 事件，paginated revert 新建不可变段并 CAS 切换 `rollout_path`；派生 SQLite 投影按 `next_byte_offset + next_ordinal` 增量物化（读侧 §R2.1）。我们不引入分段/SQLite，改用**事件化索引操作**达到同样效果。

**实现（2026-10-24）**

1. **D20.1 patch 容忍**：索引新增 `drop-turn`（turn 边界被 discarded）、`set-revert`（`fileMutationReverted` 双向翻转）、`drop-mutation`（`tool_result` 被 discarded）。归档、`dropPresentation`、bash mutation 标记等与回退菜单无关的 patch 视为 no-op；遇到未知的 `discarded: false`、索引里找不到对应 turn、或 patch id 丢失时才回退整读。`drop-turn` 在还有同 `turnIndex` 的另一条边界记录时保留 mutation，避免误删。
2. **D20.2 truncate 定向失效**：`_updateTurnIndexAfterAppend` 读取 `beforeSeq` 对应的索引，用 `fromEntryId` 找到被截断的 turn 边界，追加 `drop-turns-from {turnIndex}`；读取时丢弃 `turnIndex >= cutoff` 的 turn 与 mutation。找不到边界时回退删除索引。
3. **D20.3 快照构建**：`writeSnapshot` 成功后不再 `deleteTurnIndex`，用 `data.entries.filter(shouldPersistEntry)` 构建索引并写入 `snapshot.nextSeq - 1`；构建失败才删除索引。索引的 `entryIndex` 与快照落盘顺序一致。
4. **测试**：`turn-index` 8 例（含 `drop-turn`/`drop-turns-from`/`set-revert`）；`session-turn-index` 13 例（归档 patch、文件回退双向、丢弃 turn/mutation、未知 patch 回退、截断定向更新、首次快照建索引）。7 条定向变异（patch/truncate/snapshot 仍删索引、drop-turns-from 漏删或过删、set-revert 忽略 false、discarded:false 不回退）全红并恢复。
5. **不做**：全量重建兜底保留（索引缺失/损坏/未知语义仍重建）；不引入新文件，只扩展 `log.index.jsonl` 的可重建 op。

**边界**：索引是可选加速，任何不确定情形都安全回退到重建；不会因为索引猜测错误而让回退菜单少 turn。

**门禁（D20 阶段，2026-10-24）**：全量 **1419 passed / 3 skipped**；typecheck / typecheck:tui / test:node / build（308 模块 0 循环）/ build:exe（100.0 MB）通过；`runtime/dist` 冒烟新增 `turn index ops: true`（打包产物能读新 op）。

---

## 7.15 读侧收尾 + 写侧硬化（✅ 2026-10-25）

**读侧**

- [x] **meta.json 损坏专门红测**：`session-legacy-list-header.test.ts` 新增 JSONL/legacy 两例，meta 损坏 + 正文非法仍只读 header 列出。
- [x] **分页 UI**：顶部“更早 200 条 · 点击或按 PageUp 加载”占位（`history-banner.ts` + `OpenTuiScreen`）；8 MiB 页缓存上限（`HISTORY_PAGE_CACHE_BYTES`）达到后停止加载并显示上限提示；不加入半页，保证连续。`hasEarlierHistory=false`、`isHistoryCacheCapped()=true`。
- [x] **归档 display 懒读**：`loadArchivedDisplaysForEntries` 按 `entryIds`/turnIndex 定位窗口；无索引旧窗口兜底逐窗口；`hydrateArchivedDisplay` 复用同一路径。测试断言 `windowsRead=[0]` 而不会读窗口 1。
- 测试/变异：banner 3 例、cache 1 例、lazy 3 例；3 条定向变异（读全部窗口/取消上限/忽略 capped）全红。

**写侧**

- [x] **`log.jsonl.lock` 单写者**：pid + token；resume 冲突返回 `Error.sessionBusy`（zh “当前会话正在被占用” / en，写入 `language.json`）；陈旧锁按 pid 回收；`Session.close`/`clearSession` 释放；RPC 切换成功后释放旧目录；fork 删除继承锁。
- [x] **seq 单调校验**：`appendRecords` 要求首条 = 文件末 seq+1 且批内连续；同时修复 `readLastSeq` 对“仅 header 一行”返回 0 的旧 bug。测试覆盖跳号、重复、首条非 1 与 header-only。
- [x] **归档双写/白名单收敛**：`archiveWindow` 只写归档文件，内存变更只走 `SessionLog.archiveEntries`（compact-flow 原先就调用一次）；白名单统一为 `retainArchivedMeta`（archive/M0/log-history/log-jsonl/SessionLog 共 5 处引用）。
- [x] **收口调查**：未用导出、迁移双快照、`hydrateArchivedDisplay` 的结论写入写侧 §W10。
- 测试/变异：写锁 6 例、归档纯函数 1 例、懒读 3 例、缓存 1 例、banner 3 例；10 条定向变异（seq/读 seq 回退/锁冲突/resume 忽略锁/归档回写内存/白名单/读全部窗口/缓存上限/banner/fork 锁）全红。

**门禁（R-5 阶段）**：全量 **1460 passed / 3 skipped**；typecheck / typecheck:tui / test:node / build（310 模块 0 循环）/ build:exe（100.0 MB）通过；`runtime/dist` 冒烟新增 D13 锁清理与归档网关路径。最终数字见 §7.16。

---

## 7.16 I4.1 列表合并 + D22 显式 prune（✅ 2026-10-25）

**I4.1 单一列表映射**

- [x] 抽出 `src/config/session-list.ts`：meta.json → JSONL header → legacy header 的字段映射、已知类别体积、UTC→本地 ISO 只此一份。
- [x] `SessionStore.listSessions()` 委托 `listSessionsInProject(this._projectDir)`；`resume.ts` 重新导出 `listSessionsForProject`，`findSessionByName` 也走同一函数。
- [x] `tests/config/session-list-parity.test.ts`：meta/JSONL/legacy 三种会话，两入口 `toEqual` 逐项相等。

**D22 显式 prune**

- [x] `sessions prune <id> [--dry-run] [--max-log-bytes <bytes>]`（`src/session/session-prune.ts` + CLI）。
- [x] 安全规则：只处理最后一个 live `compact_marker` 之前的前缀；droppable = `discarded` / `content === null`（结构条目）/ 旧 `compact_marker` / archive 中有正文副本。`system_prompt` 保留；其余无副本条目使整次 prune 拒绝。
- [x] 原子重写 `log.jsonl`（快照 seq 重建）、删除 `log.index.jsonl`；`archive/`、`artifacts/`、`sealed/` 不删除，只在结果中报告体积；报告丢失的用户 turn 列表。
- [x] CLI 先检查活动会话与 `log.jsonl.lock`，再执行；支持 dry-run 与日志大小阈值；`SessionStore.resolveSessionDir` 供维护命令解析目录。
- [x] 测试：`tests/session/session-prune.test.ts` 4 例（dry-run/实际/未归档拒绝/无 marker/阈值）+ `tests/cli/cli-session-prune.test.ts` 1 例；6 条变异（列表不委托、结构条目不可丢、未归档放行、dry-run 写盘、忽略阈值、索引未删）全红。
- **边界（未做）**：自动总量配额、删除 archive/artifacts/sealed、冷段（D18）。prune 不静默执行，必须显式命令。

**门禁**：全量 **1466 passed / 3 skipped**；typecheck / typecheck:tui / test:node / build（312 模块 0 循环）/ build:exe（100.0 MB）/ `runtime/dist` 冒烟通过。

---

## 8. 必须同步的既有测试（改格式/改目录就会红）

| 测试 | 断言的东西 | 受影响阶段 |
| --- | --- | --- |
| [tests/config/log-serialization-compact.test.ts:52](tests/config/log-serialization-compact.test.ts#L52) | `log.json` 无缩进 | P1/P4 |
| [tests/context/log-persistence.test.ts:161-329](tests/context/log-persistence.test.ts#L161-L329) | `validateAndRepairLog` 的 12 个行为用例 —— **P7/M7 的免费回归网**，改索引后必须逐条仍绿 | P7 |
| [tests/clients/mcp-security.test.ts:31](tests/clients/mcp-security.test.ts#L31)、[tests/context/ask-flow.test.ts:49](tests/context/ask-flow.test.ts#L49) | 测试替件里 `s.onSaveRequest = undefined` —— 契约改成 `() => boolean` 后这两处赋值要合规 | P9.2 |
| [tests/prompts/prompt-cache-affinity.test.ts:50](tests/prompts/prompt-cache-affinity.test.ts#L50)、[:102](tests/prompts/prompt-cache-affinity.test.ts#L102)、[:108](tests/prompts/prompt-cache-affinity.test.ts#L108) | 直接读 `log.json` 文本取头部字段 | P1/P4 |
| [tests/commands/commands-fork.test.ts:132](tests/commands/commands-fork.test.ts#L132)、[:170](tests/commands/commands-fork.test.ts#L170) | fork 后 `log.json` 存在与内容 | P1.8 |
| [tests/context/ask-flow.test.ts:331](tests/context/ask-flow.test.ts#L331) | 列表把 UTC 头字段格式化成本地时间 | P4 |
| [tests/session/session-child-approval.test.ts](tests/session/session-child-approval.test.ts) | 子会话 `log.json` 路径 | P1.8 |

## 9. 红线（沿用结构重构 §1.1，本清单同样适用）

- 路径深度：`src/config/*` 保持深度 2；不移动 `log-serialization.ts`/`archive.ts`/`session-meta.ts`（C1/C4/C5）。
- 打包：`scripts/build-sea-exe.mjs` 的拷贝清单（C6）—— 新增 sidecar 目录属运行期数据，**不改打包**；但产物必须重建并冒烟。
- 行尾：`src/**`、`tests/**`、`*.md` 用 CRLF（`tests` 不带 BOM；`src/session.ts` 带 BOM），`scripts/*.mjs` 用 LF。
- `tsconfig.json` 只编译 `src/**/*.ts`（C11）：测试辅助文件不要放进 `src/`。

## 10. 收尾验收清单（全阶段通用）

- [x] `npm run typecheck`、`npm run typecheck:tui`、`npm test`、`npm run test:node`、`npm run build` 全绿（2026-10-25 I4.1/D22 后：**1466 passed / 3 skipped**；test:node 2/2）。
- [x] `node .tmp/find-cycles.mjs dist/src` 无新循环（2026-10-23：模块 305，运行时循环 **0**）。
- [x] `npm run build:exe` 完成（**100.0 MB**），`release/SwarmFlow-win32-x64/runtime/dist` 上 `.tmp/verify-built-log.mjs` 通过：legacy 紧凑/往返、归档 display+meta、strip/restore、**JSONL 快照**、**P-14 紧凑且不重写**、**M1 sealed 外置读回**、**W-5 冷归档往返**（2026-10-23/24）。
- [ ] 真实终端跑一次长会话（多轮工具 + 一次 `/compact` + `--resume`），确认 TUI 展示、回退菜单、fork 三处无回归。**仍未验证**：本机 shell 无 TTY，做不到时在文档里明确标注"未验证"（上一轮已欠一条，别再欠）。
- [x] 总体 §2 问题表的状态列与 §12 待处理台账已同步（2026-10-24）。
- [x] 记忆 `project-log-memory-oom` 已含 R-2/R-3/resume/M8/D20/滚动加载结论；剩余 TTY 目视。D22 保留策略尚未定案，未写入决策记忆。

## 11. 节奏（P0 已交完，2026-10-23）

**P0 结论一句话**：封存态是实测唯一的大项（38.9% 文件 / 摘除后 −28% 常驻），M2 降级，另外挖出 P-9 这个真缺陷。**"甲出局"已被 D14 取代**（用户 2026-10-23 指示采纳 Codex 写模型）。

**2026-10-23 架构转向**：原顺序是"先 M0/M1 减字节"；采纳 Codex 写/读设计后，M0/M1 变成新管线里的减重步骤，**第一刀改为 W-1（变更网关 + JSONL）**。M0 的 33.2%–51.8% 与 M1 的 36.8% 仍成立，但不是写放大的解；写放大只有换格式才能消除。

新顺序（每阶段独立可交付、独立可回滚；具体任务编号待 D14–D20 批复后重排）：

1. **W-1（写侧核心）** — ✅ 2026-10-23 完成（变更网关 + writer/replay + 崩溃尾行 + 迁移）。
2. **R-1/R-2/R-3 读层** — R-1 列表/用量/体积快路径已兼容 JSONL；**R-2 有界模型上下文 ✅ 2026-10-24**（§7.11）；**R-3 历史分页 + TUI + resume 接线 ✅ 2026-10-24**（§7.12，`TuiHistoryPager` + `replaces` + policy=3 + 自动加载）。D20 索引已接（§7.13/§7.14）。
3. **W-2（写前减重）** — ✅ 2026-10-23 完成：完成态/64 KiB/image_ref + M0 标记前剥离 + M1 封存态外置。
4. **R-4（封存态投影）** — ✅ `resolveReasoningState` + 4 MiB LRU 已落地；重启 display 目前是启动时从 archive 补齐（懒加载 R-3 待做）。
5. **W-3（归档/回退/检查点）** — ✅ 2026-10-23 完成（patch/truncate/compact_marker/usage）。
6. **R-3（TUI 分页）** — ✅ 2026-10-25 完成（首屏/上翻/滚动自动加载 + 顶部“更早 N 条”占位 + 8 MiB 页缓存 + 归档 display 按窗口懒读 + resume 接线 + D20 索引）。
7. **W-4（meta/project 节流）** — ✅ 2026-10-23（P-14）；token_update 合并（M9）经 P9.1 **否决**。**R-5（repair/usage）** ✅ 2026-10-25；D7 已授权并完成，D8 已完成。
8. **M10（D13）** ✅ 2026-10-24 完成（fork 清理 rewind journal/`.data-*`）；**W-5（冷归档）** ✅ 2026-10-24（D21）。写侧完成（含 2026-10-25 的写锁/seq/归档整理）；读侧 R-1/R-2/R-3/R-4/R-5 ✅、M8 ✅、D10 ✅、D20 全部 ✅；剩下 D22 保留策略与 TTY 目视验证。完整清单见 §13。

夹具与量测脚本（后续阶段仍要用）：`.tmp/make-log-fixture.mjs`（turn-run 抽样 + 保字节扰动，`--tiers=`/`--root=`）、`.tmp/measure-log-shape.mjs`、`.tmp/measure-sealed-distribution.mjs`（均已参数化，可指夹具目录）、`.tmp/bench-resume.ts`（`--dir=`）、`.tmp/bench-checkpoint.ts`（`--dir=`）。夹具输出在 `%TEMP%\swarmflow-log-fixtures\tier-{5,50,200}mb`。
本轮新增：`.tmp/measure-persist-disk.mjs`（R0.6 三策略磁盘对账，`--dir=` 可指任意含 `log.json` 的会话）、`.tmp/build-after-dirs.mjs`（把夹具按当前写前策略物化成 `log.jsonl + sealed/`，输出在 `%TEMP%\swarmflow-after-dirs`）、`.tmp/bench-jsonl-vs-legacy-read.mjs`（同进程 legacy vs JSONL 读 A/B，P-17 的数据源）、`.tmp/check-archive-shape.mjs`（读归档记录的实际字段，验证 `hasPresentation` 守卫）。

## 12. 待处理台账（P0 挖出的新问题；已完成项保留记录，未完成项等授权）

| 编号 | 问题 | 证据（已核实） | 最佳解法（含"为什么不选别的"） | 落点 | 决策 | 优先级 |
| --- | --- | --- | --- | --- | — | 高 |
| **P-15** | **持久化剥离边界错用 TUI 折叠阈值 → 1–2 次压缩的会话标记前一条都没剥** | [tui.ts:34-36](src/context/projection/tui.ts#L34-L36) 返回 `-1` → [compact-flow.ts:379-382](src/session/compact-flow.ts#L379-L382) 跳过；真实最大那份 1 个 marker，标记前 display+meta **1.99 MB** 全量落盘 | **M0（用户更正）**：落盘边界改为"最后一个 marker"，与渲染边界解耦；archive 已是外置存储（① 存了完整 `{id,content,display,meta}`），所以**不需要新目录/sidecar/LRU**。不选"内存也一起剥"：那要回滚 ① 的 meta 归档才自洽，磁盘上并不更省（D11） | 总体 §2 P-15、写侧 §W4.3；任务 §1.5 | **D11**（渲染口径 a/b）、**D12**（M1 是否续做） | **最高（省 33.2%–51.8%，改动面比 M1 小）** |
| P-9 | `validateAndRepairLog` 超线性 | [log-repair.ts:199-225](src/config/log-repair.ts#L199-L225)；实测 5 / 86 / **1279 ms**（×4 条目 → ×14.9 时间；1279 ms 为 full 场景，bounded resume 只扫窗口） | 一次扫描建 `actionKeys` + `roundToTurns` 两张表，第 4 步改查表；**先按步插桩确认瓶颈**，不动第 2/3 步。不选"分块/异步化"：那会把纯函数修复变成架构改动 | 读侧 §R3.6/R-5；任务 §7.5 | **D7 ✅ 2026-10-25** | 已完成（计时 16.96×→2.4–4.8×，读取 706×N→9.3×N） |
| **P-16** | **删除会话必须同步回收 rewind 落盘物**（用户点名标记；2026-10-23 探针后缩围） | 唯一入口 [session-picker.ts:61-70](src/cli/session-picker.ts#L61-L70) 的 `rmSync(sessionDir)` 连带删掉 `<sessionDir>/artifacts`（[session-store.ts:335](src/config/session-store.ts#L335)）；**全仓无用户可配的外部 artifacts 路径**——`sessionArtifactsDir` 只由子会话构造传入（[session.ts:4012](src/session.ts#L4012)），值仍在父会话目录内（[manager.ts:316-317](src/session/children/manager.ts#L316-L317)、[:330-331](src/session/children/manager.ts#L330-L331)）。fork 曾复制 journal+备份，但恢复被 `_readRewindJournal` 的绝对 `filePath` 校验拒收（[engine.ts:704-712](src/session/rewind/engine.ts#L704-L712)），探针 4 例全绿，工作树不被回放；**2026-10-24 起 fork 直接清理继承产物**（D13） | 删除侧**无需改代码**；原 `paths.session_artifacts` 外部覆盖是误判，`session_id`/孤儿 GC/删除告知随之撤销。fork 清理已落地：`discardRewindArtifacts` + 6 条变异 | 总体 §2 P-16、§6；任务 §7.8；探针 [tests/session/rewind-fork-probe.test.ts](tests/session/rewind-fork-probe.test.ts)、[tests/session/rewind-artifacts.test.ts](tests/session/rewind-artifacts.test.ts) | **D13 ✅** | 已关闭 |
| P-11 | 用量页整读全部 `log.json` + 蛇形死分支 | [session-store.ts:359-401](src/config/session-store.ts#L359-L401)（整读 :377，死分支 :385）；当前语料一次 = 12.87 MB 全解析 | 累计用量落到 `meta.json`（复用 [usage-accounting.ts:53-66](src/session/usage-accounting.ts#L53-L66) 已有口径），统计页只读 meta，**删整读循环与死分支**。不选"给 log.json 建 token 索引"：那会造出第二份权威数据，索引失效后照样得整读 | 读侧 §R3.5/R-5；任务 §7.6 | **D8**（迁移口径 a/b） | 中 |
| P-12 | `onSaveRequest` 布尔契约不一致 | [session.ts](src/session.ts) vs [contracts.ts](src/ui/contracts.ts)；TUI handler 曾返回 undefined（[app.tsx](external/opentui/app.tsx)） | ✅ 2026-10-24：统一为 `() => boolean`；TUI 立即保存返回真实结果、防抖调度返回 false；编译期断言 + 3 例运行时测试；**未合并两条 finalize 路径** | 总体 §7 D10；任务 §7.7 | **D10 ✅** | 已关闭 |
| P-13 | `token_update` 占 20.2% 条目 / 2.3% 字节 | 总体 §1.1 形态量测（1032/5102 条，0.29 MB） | **已核实并否决 M9**：两类消费者互斥——逐次求和（[usage-accounting.ts:66](src/session/usage-accounting.ts#L66)、[session-store.ts:413](src/config/session-store.ts#L413)）vs 最后一条即上下文（[log-surgery.ts:604-620](src/session/log-surgery.ts#L604-L620)）。收益不抵语义风险 | 写侧 §W4.3；任务 §7.7 | **D9：否决（P9.1）** | 已关闭 |
| P-14 | 每检查点全读全写两份伴生小文件 | [session-meta.ts:107-123](src/config/session-meta.ts#L107-L123)、[log-serialization.ts:58-70](src/config/log-serialization.ts#L58-L70)；meta 实测 241–525 B | `last_active_at` 跨分钟才写；`meta.json` 仅字段变化才写；两处去掉 `null, 2` | 任务 §7.7 | 不需单独授权 | ✅ 2026-10-23（W-4） |
| P-10 | M2 靶子在真实语料里几乎不存在 | `toolMetadata` 2.5%（41/1612）、`reversePatch`/`_contentBlocks` **0 字节**、tool_result `content` P90 仅 7.2 KB | 不修，**降级后置**；重入门槛：任一 tool_result 的 `meta` 单条 > 64 KB，或 `_contentBlocks`/`reversePatch` 合计占 `log.json` > 5% | 写侧 §W4.3；任务 §3 | — | 挂起 |
| **P-17** | **换 JSONL 后读路径变慢**（W-1 的代价，2026-10-23 实测新发现） | 同进程 A/B（`.tmp/bench-jsonl-vs-legacy-read.mjs`）：5/50/200 MB 三档 `loadLog` 耗时 **1.06 / 1.14 / 1.27×**，200 MB 档 820 → 1043 ms；驻留反而 0.79–0.87×。根因是逐记录 `JSON.parse`（200 MB 档 77944 次调用）+ 仍整读 | 由**读侧 R-2** 偿还：反向有界扫描只取最后 marker 之后的记录（总体 D19/D20）；不换回 legacy 格式（写放大 462× 的代价大得多）。若 R-2 后仍慢，再考虑"记录分组批 upsert"减少 parse 次数 | 读侧 §R2；任务 §1.5.4 常驻基准 | **✅ 已偿还（2026-10-24）** | API 侧 200 MB 档 652→40 ms、77944→3063 条；resume 端到端已接有界（R-3 完成） |
| **P-18** | **日志/会话目录无总量上限**（用户 2026-10-24 提议：设上限，超限清理旧日志只留最近） | 本机实测：日志 14 MB、artifacts 60.5 MB、archive 0.32 MB → 只限日志无法控制目录总量；直接删前缀会让 undo-compact/rewind 失效 | ✅ 2026-10-25 显式 `sessions prune`：只清有 archive 正文/无正文结构条目的前缀，保留 system_prompt 与活动窗口；原子重写+删索引+报告丢失 turn 与三项目录体积。自动总量配额/archive 清理未做（不静默删） | 总体 D22；写侧 §W4.7；任务 §7.16/§13 | **D22 显式 prune ✅** | 中 |

---

## 13. 剩余工作盘点（2026-10-25）

**已封口**：W-1…W-5（含写锁、seq 校验）；R-1（列表 header + 用量 + `dirSize` 已知类别，含 P-5 legacy 头部快路径）；R-2（API + resume 接线）；R-3（分页读层 + `/history` + 滚动/顶部占位 + 8 MiB 页缓存 + 回退前物化 + 归档 display 按窗口懒读）；R-4；R-5（repair 索引化）；M0/M1；M8/D8(a)；D7；D10；D13；D19；D20 全部；**I4.1 列表合并；D22 显式 prune**；P-5/P-6/P-9/P-12/P-14/P-17/P-19；`archiveWindow` 纯化与 retained-meta 白名单收敛。

**门禁现状（2026-10-25 I4.1/D22 后）**：全量 **1466 passed / 3 skipped**；`typecheck` / `typecheck:tui` / `test:node` / `build`（312 模块 0 循环）/ `build:exe`（100.0 MB）/ `runtime/dist` 冒烟均绿。工作树 **45 改 + 57 未跟踪**，HEAD `d488595`，未提交。

### 13.1 读侧剩余

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实 TTY 目视验证 | **未验证** | 本机无 TTY；滚动/顶部占位/展开/回退需真实终端确认 |

### 13.2 写侧剩余

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 未使用导出 | **保留** | `nextSeq`（仅测试）/`collectSealedRefs`（无消费者）/`prepareEntryForPersistence`（Session 用更完整的私有实现）；作用见写侧 §W10 |
| resume 期修复不落盘 | **已接受** | policy=2 会话每次加载重新推导；确定性、非正确性问题 |
| 迁移 + 归一化双快照 | **已接受** | 一次性开销；单快照可行但需改迁移校验与备份顺序，结论见写侧 §W10 |
| `readLogHeader` 64 KiB 上限 | **已知** | 超大 header 会解析失败（legacy 超限会回退整读） |

### 13.3 D20.1–D20.3（✅ 2026-10-24 完成，见 §7.14）

patch 已翻译为 `drop-turn` / `drop-mutation` / `set-revert`；truncate 用 `drop-turns-from` 定向失效；快照后直接构建索引。未知语义（如 `discarded:false`、找不到截断边界）仍回退整读重建。7 条定向变异全红。

### 13.4 保留策略（P-18 / D22：显式 prune ✅，自动配额未做）

用户 2026-10-24 提议"设日志上限，超限清理旧日志只留最近"。实测本机日志 14 MB、artifacts 60.5 MB、archive 0.32 MB，**只限日志无法控制目录总量**；直接删前缀会让 undo-compact/rewind 失效。

已落地：`sessions prune <id> [--dry-run] [--max-log-bytes N]`，只清最后一个 live marker 前、有 archive 正文（或 content null/discarded/旧 marker）的前缀；system_prompt 与活动窗口保留；原子重写日志、删索引、报告丢失 turn 与三项目录体积。**未做**：自动总量配额、删除 archive/artifacts/sealed、冷段（D18）；不静默删除。

### 13.5 可选/低优先

- P-10/M2：工具产出 image_ref 与 64 KiB 上限，按门槛后置。
- R-6：fork lineage 分段、归档态透明 resume，当前明确不做。
- D22 自动总量配额与 archive/artifacts/sealed 清理：未做；显式 prune 已落地。
