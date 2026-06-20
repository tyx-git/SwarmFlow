/**
 * GUI 集成指南 — swarm 可视化。
 *
 * 本文档记录了 Electron GUI 为实现 swarm 状态可视化应实现的接口。
 * 实际的 React 组件位于 gui/ 中。
 *
 * ## Swarm 面板 React 组件
 *
 * GUI 应实现一个 SwarmPanel 组件，该组件：
 * 1. 每 500ms 轮询 SwarmMonitor.getSnapshot()
 * 2. 将智能体节点渲染为彩色圆圈：
 *    - 💭 思考中（黄色脉冲）
 *    - 🔧 调用工具（蓝色旋转）
 *    - ✅ 已完成（绿色）
 *    - ❌ 错误（红色闪烁）
 * 3. 显示带有完成状态的任务 DAG
 * 4. 展示：
 *    - 智能体拓扑图（星形/链式/网状）
 *    - 每个层级的任务进度条
 *    - Token 使用量图表
 *    - 最近事件的时间线
 *
 * ## 消息流
 *
 * GUI <--RPC--> session-rpc.ts <---> SwarmExecutor
 *                    |
 *              SwarmMonitor.getSnapshot()
 *
 * ## 数据形状
 *
 * GUI 通过 RPC 事件接收 SwarmSnapshot。
 * 完整形状请参见 types.ts → SwarmSnapshot。
 *
 * ## 关键 CSS 类（gui/src/styles/）
 *
 * .swarm-node - 智能体节点容器
 * .swarm-node.thinking - 黄色脉冲动画
 * .swarm-node.tool-calling - 蓝色旋转动画
 * .swarm-edge - 节点之间的连接线
 * .swarm-task-progress - 任务进度条
 * .swarm-timeline - 事件时间线
 * .swarm-metrics - 指标显示面板
 *
 * ## 待添加的 RPC 事件
 *
 * 1. "swarm.snapshot" → SwarmSnapshot（周期性，500ms）
 * 2. "swarm.task_start" → { taskId, agentId }
 * 3. "swarm.task_complete" → TaskResult
 * 4. "swarm.task_failed" → { taskId, error }
 * 5. "swarm.error" → { error }
 * 6. "swarm.execution_complete" → ExecutionResult
 *
 * ## session-rpc.ts 中的连接
 *
 * const monitor = new SwarmMonitor();
 * setInterval(() => {
 *   const snapshot = monitor.getSnapshot(coordinator.pool.handles);
 *   rpc.emit("swarm.snapshot", snapshot);
 * }, 500);
 */
export { };