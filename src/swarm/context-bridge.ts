/**
 * ContextBridge — shared context management for swarm agents.
 *
 * Provides a read-only shared knowledge base that all agents can access,
 * plus isolated per-agent scratchpads for private work.
 * Handles conflict detection when multiple agents modify the same files.
 *
 * @packageDocumentation
 */

import type { TaskResult } from "./types.js";

// ------------------------------------------------------------------
// Shared context
// ------------------------------------------------------------------

/** A single design decision recorded in shared context. */
export interface Decision {
  subject: string;
  decision: string;
  madeBy: string;
  timestamp: number;
  rationale?: string;
}

/** A file that was read or modified. */
export interface FileRecord {
  path: string;
  readBy: string[];
  modifiedBy: string[];
  content?: string;
}

/** Entry in the shared context. */
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
 * SharedContext — read-only knowledge accessible by all swarm agents.
 *
 * Stores:
 * - Design decisions
 * - File metadata (who read/modified what)
 * - Key findings
 * - Project structure
 */
export class SharedContext {
  private _decisions: Decision[] = [];
  private _files = new Map<string, FileRecord>();
  private _entries: SharedContextEntry[] = [];
  private _projectDescription = "";

  /** Record a design decision. */
  addDecision(subject: string, decision: string, madeBy: string, rationale?: string): void {
    this._decisions.push({ subject, decision, madeBy, timestamp: Date.now(), rationale });
  }

  /** Get all decisions. */
  getDecisions(): Decision[] {
    return [...this._decisions];
  }

  /** Get decisions by subject. */
  getDecisionsBySubject(subject: string): Decision[] {
    return this._decisions.filter((d) => d.subject === subject);
  }

  /** Record that an agent read a file. */
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

  /** Record that an agent modified a file. */
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

  /** Get file records. */
  getFileRecords(): FileRecord[] {
    return [...this._files.values()];
  }

  /** Get files modified by a specific agent. */
  getFilesModifiedBy(agentId: string): FileRecord[] {
    return [...this._files.values()].filter((f) => f.modifiedBy.includes(agentId));
  }

  /** Set project description. */
  setProjectDescription(desc: string): void {
    this._projectDescription = desc;
  }

  /** Get project description. */
  getProjectDescription(): string {
    return this._projectDescription;
  }

  /** Add a generic key-value entry. */
  set(key: string, value: string, agentId: string): void {
    this._entries.push({ timestamp: Date.now(), agentId, key, value });
  }

  /** Get entries by key. */
  get(key: string): SharedContextEntry[] {
    return this._entries.filter((e) => e.key === key);
  }

  /** Get all entries. */
  getAllEntries(): SharedContextEntry[] {
    return [...this._entries];
  }

  /** Check for conflicts: files modified by multiple agents. */
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

  /** Format shared context as a prompt fragment for an agent. */
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

  /** Reset all context. */
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
 * AgentScratchpad — private workspace for a single agent.
 *
 * Each agent gets its own scratchpad for:
 * - Current thinking / plan
 * - Draft code changes
 * - Temporary notes
 * - File edits in progress
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

  /** Agent ID. */
  get agentId(): string {
    return this._agentId;
  }

  /** Add a note. */
  addNote(note: string): void {
    this._notes.push(`[${new Date().toISOString()}] ${note}`);
  }

  /** Get all notes. */
  getNotes(): string[] {
    return [...this._notes];
  }

  /** Set the current plan. */
  setPlan(plan: string): void {
    this._currentPlan = plan;
  }

  /** Get the current plan. */
  getPlan(): string {
    return this._currentPlan;
  }

  /** Set draft code. */
  setDraft(code: string): void {
    this._draftCode = code;
  }

  /** Get draft code. */
  getDraft(): string {
    return this._draftCode;
  }

  /** Mark a file as being edited. */
  startEditing(filePath: string): void {
    this._editingFiles.add(filePath);
  }

  /** Finish editing a file. */
  finishEditing(filePath: string): void {
    this._editingFiles.delete(filePath);
  }

  /** Get files currently being edited. */
  getEditingFiles(): string[] {
    return [...this._editingFiles];
  }

  /** Clear the scratchpad. */
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
 * ContextBridge — manages shared + per-agent contexts.
 *
 * The bridge provides:
 * - One SharedContext (read-only for all agents)
 * - Per-agent AgentScratchpad (private workspace)
 * - Conflict detection across agents
 * - Snapshot/summary for handoff
 */
export class ContextBridge {
  readonly shared: SharedContext;
  private _scratchpads = new Map<string, AgentScratchpad>();

  constructor() {
    this.shared = new SharedContext();
  }

  /** Get or create a scratchpad for an agent. */
  getScratchpad(agentId: string): AgentScratchpad {
    if (!this._scratchpads.has(agentId)) {
      this._scratchpads.set(agentId, new AgentScratchpad(agentId));
    }
    return this._scratchpads.get(agentId)!;
  }

  /** Release an agent's scratchpad. */
  releaseScratchpad(agentId: string): void {
    this._scratchpads.delete(agentId);
  }

  /** Release all scratchpads. */
  releaseAll(): void {
    this._scratchpads.clear();
  }

  /** Detect file conflicts across all agents. */
  detectConflicts(): Array<{ file: string; agents: string[] }> {
    return this.shared.detectConflicts();
  }

  /** Build a context snapshot suitable for handoff. */
  buildHandoffContext(): string {
    return this.shared.toPromptFragment();
  }

  /** Clear all contexts. */
  clear(): void {
    this.shared.clear();
    this._scratchpads.clear();
  }
}
