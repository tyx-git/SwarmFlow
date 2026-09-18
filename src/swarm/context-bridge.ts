/**
 * ContextBridge — swarm agent 的共享上下文管理。
 *
 * 提供所有 agent 都可以访问的只读共享知识库，
 * 加上隔离的每 agent 草稿本用于私人工作。
 * 处理多个 agent 修改同一文件时的冲突检测。
 *
 * @packageDocumentation
 */


// ------------------------------------------------------------------
// 共享上下文
// ------------------------------------------------------------------

/** 记录在共享上下文中的单个设计决策。 */
export interface Decision {
  subject: string;
  decision: string;
  madeBy: string;
  timestamp: number;
  rationale?: string;
}

/** 读取或修改过的文件。 */
export interface FileRecord {
  path: string;
  readBy: string[];
  modifiedBy: string[];
  content?: string;
}

/** 共享上下文中的条目。 */
export interface SharedContextEntry {
  /** When this entry was added. */
  timestamp: number;
  /** Which agent added it. */
  agentId: string;
  /** The key. */
  key: string;
  /** The value. */
  value: string;
}

/**
 * SharedContext — 所有 swarm agent 可访问的只读知识库。
 *
 * 存储：
 * - 设计决策
 * - 文件元数据（谁读取/修改了什么）
 * - 关键发现
 * - 项目结构
 */
export class SharedContext {
  private _decisions: Decision[] = [];
  private _files = new Map<string, FileRecord>();
  private _entries: SharedContextEntry[] = [];
  private _projectDescription = "";

  /** 记录一个设计决策。 */
  addDecision(subject: string, decision: string, madeBy: string, rationale?: string): void {
    this._decisions.push({ subject, decision, madeBy, timestamp: Date.now(), rationale });
  }

  /** 获取所有决策。 */
  getDecisions(): Decision[] {
    return [...this._decisions];
  }

  /** 按主题获取决策。 */
  getDecisionsBySubject(subject: string): Decision[] {
    return this._decisions.filter((d) => d.subject === subject);
  }

  /** 记录某 agent 读取了一个文件。 */
  recordFileRead(filePath: string, agentId: string): void {
    const existing = this._files.get(filePath);
    if (existing) {
      if (!existing.readBy.includes(agentId)) {
        existing.readBy.push(agentId);
      }
    } else {
      this._files.set(filePath, { path: filePath, readBy: [agentId], modifiedBy: [] });
    }
  }

  /** 记录某 agent 修改了一个文件。 */
  recordFileModification(filePath: string, agentId: string): void {
    const existing = this._files.get(filePath);
    if (existing) {
      if (!existing.modifiedBy.includes(agentId)) {
        existing.modifiedBy.push(agentId);
      }
    } else {
      this._files.set(filePath, { path: filePath, readBy: [], modifiedBy: [agentId] });
    }
  }

  /** 获取文件记录。 */
  getFileRecords(): FileRecord[] {
    return [...this._files.values()];
  }

  /** 获取特定 agent 修改的文件。 */
  getFilesModifiedBy(agentId: string): FileRecord[] {
    return [...this._files.values()].filter((f) => f.modifiedBy.includes(agentId));
  }

  /** 设置项目描述。 */
  setProjectDescription(desc: string): void {
    this._projectDescription = desc;
  }

  /** 获取项目描述。 */
  getProjectDescription(): string {
    return this._projectDescription;
  }

  /** 添加一个通用键值条目。 */
  set(key: string, value: string, agentId: string): void {
    this._entries.push({ timestamp: Date.now(), agentId, key, value });
  }

  /** 按键获取条目。 */
  get(key: string): SharedContextEntry[] {
    return this._entries.filter((e) => e.key === key);
  }

  /** 获取所有条目。 */
  getAllEntries(): SharedContextEntry[] {
    return [...this._entries];
  }

  /** 检查冲突：多个 agent 修改的文件。 */
  detectConflicts(): Array<{ file: string; agents: string[] }> {
    const conflicts: Array<{ file: string; agents: string[] }> = [];
    for (const [path, record] of this._files) {
      const uniqueModifiers = [...new Set(record.modifiedBy)];
      if (uniqueModifiers.length > 1) {
        conflicts.push({ file: path, agents: uniqueModifiers });
      }
    }
    return conflicts;
  }

  /** 将共享上下文格式化为 agent 的提示片段。 */
  toPromptFragment(): string {
    const parts: string[] = [];

    if (this._projectDescription) {
      parts.push(`Project: ${this._projectDescription}`);
    }

    if (this._decisions.length > 0) {
      parts.push("Decisions:");
      for (const d of this._decisions) {
        parts.push(`- ${d.subject}: ${d.decision} (by ${d.madeBy})`);
      }
    }

    if (this._entries.length > 0) {
      const latest = this._entries.slice(-10);
      parts.push("Recent Context:");
      for (const e of latest) {
        parts.push(`- ${e.key}: ${e.value} (by ${e.agentId})`);
      }
    }

    return parts.join("\n");
  }

  /** 重置所有上下文。 */
  clear(): void {
    this._decisions = [];
    this._files.clear();
    this._entries = [];
    this._projectDescription = "";
  }
}

// ------------------------------------------------------------------
// AgentScratchpad
// ------------------------------------------------------------------

/**
 * AgentScratchpad — 单个 agent 的私有工作空间。
 *
 * 每个 agent 都有自己的草稿本，用于：
 * - 当前思考/计划
 * - 草稿代码更改
 * - 临时笔记
 * - 正在进行的文件编辑
 */
export class AgentScratchpad {
  private _agentId: string;
  private _notes: string[] = [];
  private _currentPlan = "";
  private _draftCode = "";
  private _editingFiles = new Set<string>();

  constructor(agentId: string) {
    this._agentId = agentId;
  }

  /** Agent ID。 */
  get agentId(): string {
    return this._agentId;
  }

  /** 添加一条笔记。 */
  addNote(note: string): void {
    this._notes.push(`[${new Date().toISOString()}] ${note}`);
  }

  /** 获取所有笔记。 */
  getNotes(): string[] {
    return [...this._notes];
  }

  /** 设置当前计划。 */
  setPlan(plan: string): void {
    this._currentPlan = plan;
  }

  /** 获取当前计划。 */
  getPlan(): string {
    return this._currentPlan;
  }

  /** 设置草稿代码。 */
  setDraft(code: string): void {
    this._draftCode = code;
  }

  /** 获取草稿代码。 */
  getDraft(): string {
    return this._draftCode;
  }

  /** 将文件标记为正在编辑。 */
  startEditing(filePath: string): void {
    this._editingFiles.add(filePath);
  }

  /** 完成文件编辑。 */
  finishEditing(filePath: string): void {
    this._editingFiles.delete(filePath);
  }

  /** 获取当前正在编辑的文件。 */
  getEditingFiles(): string[] {
    return [...this._editingFiles];
  }

  /** 清除草稿本。 */
  clear(): void {
    this._notes = [];
    this._currentPlan = "";
    this._draftCode = "";
    this._editingFiles.clear();
  }
}

// ------------------------------------------------------------------
// ContextBridge
// ------------------------------------------------------------------

/**
 * ContextBridge — 管理共享+每 agent 上下文。
 *
 * 桥接器提供：
 * - 一个 SharedContext（所有 agent 只读）
 * - 每 agent AgentScratchpad（私有工作空间）
 * - 跨 agent 冲突检测
 * - 用于交接的快照/摘要
 */
export class ContextBridge {
  readonly shared: SharedContext;
  private _scratchpads = new Map<string, AgentScratchpad>();

  constructor() {
    this.shared = new SharedContext();
  }

  /** 获取或创建某 agent 的草稿本。 */
  getScratchpad(agentId: string): AgentScratchpad {
    if (!this._scratchpads.has(agentId)) {
      this._scratchpads.set(agentId, new AgentScratchpad(agentId));
    }
    return this._scratchpads.get(agentId)!;
  }

  /** 释放某 agent 的草稿本。 */
  releaseScratchpad(agentId: string): void {
    this._scratchpads.delete(agentId);
  }

  /** 释放所有草稿本。 */
  releaseAll(): void {
    this._scratchpads.clear();
  }

  /** 检测所有 agent 间的文件冲突。 */
  detectConflicts(): Array<{ file: string; agents: string[] }> {
    return this.shared.detectConflicts();
  }

  /** 构建适合交接的上下文快照。 */
  buildHandoffContext(): string {
    return this.shared.toPromptFragment();
  }

  /** 清除所有上下文。 */
  clear(): void {
    this.shared.clear();
    this._scratchpads.clear();
  }
}
