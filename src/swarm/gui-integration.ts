/**
 * GUI integration guide for swarm visualization.
 *
 * This file documents the interfaces the Electron GUI should implement
 * to visualize swarm state. Actual React components live in gui/.
 *
 * ## Swarm Panel React Component
 *
 * The GUI should implement a SwarmPanel component that:
 * 1. Polls SwarmMonitor.getSnapshot() every 500ms
 * 2. Renders agent nodes as colored circles:
 *    - 💭 Thinking (yellow pulse)
 *    - 🔧 Tool-calling (blue spin)
 *    - ✅ Completed (green)
 *    - ❌ Error (red flash)
 * 3. Shows task DAG with completion status
 * 4. Displays:
 *    - Agent topology graph (star/chain/mesh)
 *    - Task progress bars per level
 *    - Token usage chart
 *    - Timeline of recent events
 *
 * ## Message Flow
 *
 * GUI <--RPC--> session-rpc.ts <---> SwarmExecutor
 *                    |
 *              SwarmMonitor.getSnapshot()
 *
 * ## Data Shape
 *
 * The GUI receives SwarmSnapshot via RPC events.
 * See types.ts → SwarmSnapshot for the full shape.
 *
 * ## Key CSS Classes (gui/src/styles/)
 *
 * .swarm-node - Agent node container
 * .swarm-node.thinking - Yellow pulse animation
 * .swarm-node.tool-calling - Blue rotation animation
 * .swarm-edge - Connection line between nodes
 * .swarm-task-progress - Task progress bar
 * .swarm-timeline - Event timeline
 * .swarm-metrics - Metrics display panel
 *
 * ## RPC Events to Add
 *
 * 1. "swarm.snapshot" → SwarmSnapshot (periodic, 500ms)
 * 2. "swarm.task_start" → { taskId, agentId }
 * 3. "swarm.task_complete" → TaskResult
 * 4. "swarm.task_failed" → { taskId, error }
 * 5. "swarm.error" → { error }
 * 6. "swarm.execution_complete" → ExecutionResult
 *
 * ## Wire-up in session-rpc.ts
 *
 * const monitor = new SwarmMonitor();
 * setInterval(() => {
 *   const snapshot = monitor.getSnapshot(coordinator.pool.handles);
 *   rpc.emit("swarm.snapshot", snapshot);
 * }, 500);
 */
export {};
