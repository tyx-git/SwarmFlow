# SwarmFlow 待办清单（唯一）

> 2026-10-26 整理：日志持久化重构（写侧 W-1…W-5 含写锁/seq、读侧 R-1…R-5、M0/M1、D7/D8/D10/D13/D19/D20、D22 显式 prune）已全部落地并接线，设计稿与执行清单已出树。本文件只留未完成项；每项的验收口径见文末"门禁与红线"。

## T-1 D22 自动总量配额与保留清理（未做，需授权）

已落地：`sessions prune <id> [--dry-run] [--max-log-bytes N]` —— [src/session/session-prune.ts](src/session/session-prune.ts)、[src/cli.ts](src/cli.ts)、[tests/session/session-prune.test.ts](tests/session/session-prune.test.ts)。只清最后一个 live compact_marker 之前、已有 archive 正文（或 `content=null`/discarded/旧 marker）的结构条目；保留 `system_prompt` 与活动窗口；原子重写 `log.jsonl`、删除 turn 索引、报告丢失 turn 与 archive/artifacts/sealed 三项目录体积。

未决口径（动手前要先定）：

- **上限对象**：本机实测日志 14 MB、artifacts 60.5 MB、archive 0.32 MB —— 只限日志控不住目录总量（总体 D22）。
- **触发方式**：自动执行还是启动时提示；自动路径必须先报告"将删掉什么"。
- **清理对象**：是否包含 archive/artifacts/sealed —— 包含则 undo-compact、rewind、M1 封存态读回会失效。
- **冷段（D18）**：fork lineage 分段是否同期做。

红线：不静默删除；先量化损失（受影响 turn 数、字节数、因此失效的能力）并确认，再实施。

## T-2 真实 TTY 目视验证（未验证：本机 shell 无 TTY）

- 长会话：多轮工具 + 一次 `/compact` + `--resume`，确认 TUI 展示无回归。
- 历史分页：首屏、上翻自动加载、顶部"更早 N 条"占位、条目展开、8 MiB 页缓存边界。
- 回退菜单（`/rewind` picker）与 fork。

做不到就在文档里明确标注"未验证"，不得当作已验收。

## T-3 挂起项（有重入门槛，不到门槛不做）

- **P-10/M2**：工具产出 `image_ref` 与 64 KiB 单条上限。重入门槛：任一 `tool_result` 的 `meta` 单条 > 64 KB，或 `_contentBlocks`/`reversePatch` 合计占 `log` > 5%。
- **R-6**：fork lineage 分段、归档态透明 resume —— 当前明确不做。

## 已定案不做（别再提）

resume 期修复不落盘（每次加载重新推导，确定性）、迁移 + 归一化双快照（一次性开销）、`readLogHeader` 64 KiB 上限（超限 legacy 会回退整读）、未使用导出（`nextSeq`/`collectSealedRefs`/`prepareEntryForPersistence`）。

## 门禁与红线（每项任务的收尾口径）

- 每轮收尾：`npm run typecheck`、`npm run typecheck:tui`、`npm test`、`npm run test:node`、`npm run build`；改到写侧格式或打包清单再跑 `npm run build:exe` 并对 `release/SwarmFlow-win32-x64/SwarmFlow.exe` 冒烟。
- 行尾：`src/**`、`tests/**`、`*.md` 用 CRLF（`tests` 不带 BOM；`src/session.ts` 带 BOM），`scripts/*.mjs` 用 LF。
- 路径深度：`src/config/*` 保持深度 2；不移动 `log-serialization.ts`/`archive.ts`/`session-meta.ts`。
- `tsconfig.json` 只编译 `src/**/*.ts`：测试辅助文件不要放进 `src/`。
