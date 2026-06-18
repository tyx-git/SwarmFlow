export interface SessionCapabilities {
  includeSpawnTool: boolean;
  includeKillTool: boolean;
  includeCheckStatusTool: boolean;
  includeAwaitEventTool: boolean;
  includeShowContextTool: boolean;
  includeSummarizeContextTool: boolean;
  includeAskTool: boolean;
  includeSkillTools: boolean;
  includeReloadTool: boolean;
}

export const ROOT_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: true,
  includeKillTool: true,
  includeCheckStatusTool: true,
  includeAwaitEventTool: true,
  includeShowContextTool: true,
  includeSummarizeContextTool: true,
  includeAskTool: true,
  includeSkillTools: true,
  includeReloadTool: true,
};

export const CHILD_SESSION_CAPABILITIES: SessionCapabilities = {
  includeSpawnTool: false,
  includeKillTool: false,
  includeCheckStatusTool: false,
  includeAwaitEventTool: true,
  includeShowContextTool: false,
  includeSummarizeContextTool: false,
  includeAskTool: false,
  includeSkillTools: false,
  includeReloadTool: false,
};
