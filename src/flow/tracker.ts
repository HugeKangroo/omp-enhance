import { TurnTracker } from "../core/policy.ts";

export {
  COMPANION_TOOL_NAMES, DEFAULT_READONLY_TOOLS, MUTATING_HOST_TOOLS, READONLY_SUBAGENTS, TurnTracker,
  WRITE_TOOLS, canRoleDelegateTo, canRoleUseCompanionTool, checkToolCallAllowed, extractTaskSubagents,
  extractWriteTargetPaths, hasWriteBoundary, isCompanionTool, isRoleReadOnly, isValidExecutionEvidence,
  resolveRoleActiveTools, roleAllowsBash, summarizeToolCall,
} from "../core/policy.ts";

/** Per-session TurnTracker registry isolating workspace baselines & calls across conversations. */
export class SessionTrackerRegistry {
  private readonly trackers = new Map<string, TurnTracker>();

  get(sessionId: string): TurnTracker {
    const key = sessionId || "__default__";
    let tracker = this.trackers.get(key);
    if (!tracker) { tracker = new TurnTracker(); this.trackers.set(key, tracker); }
    return tracker;
  }

  reset(sessionId: string, cwd: string): TurnTracker {
    const tracker = this.get(sessionId);
    tracker.resetTurn(cwd);
    return tracker;
  }

  clear(): void { this.trackers.clear(); }
}
