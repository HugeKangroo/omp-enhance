import type { ObservedToolCall, RoleSpec, SupervisorActiveTool } from "./types.ts";
import {
  matchesGlobList, resolveSafeTargetRealpath, snapshotConfigIntegrity, snapshotWorkspace,
  type SnapshotEntry,
} from "./fs.ts";

export const COMPANION_TOOL_NAMES = [
  "enhance_mandate", "enhance_handoff", "enhance_flow", "enhance_job",
] as const;

export const READONLY_SUBAGENTS = ["scout", "reviewer", "security-reviewer"] as const;
export const WRITE_TOOLS: Readonly<Record<string, true>> = { write: true, edit: true, apply_patch: true };
export const MUTATING_HOST_TOOLS = ["write", "edit", "apply_patch", "bash", "eval", "manage_skill"] as const;
export const DEFAULT_READONLY_TOOLS = ["read", "grep", "glob", "find", "lsp", "task", "wait"] as const;

const READONLY_SUBAGENT_SET = new Set<string>(READONLY_SUBAGENTS);
const STRICT_READONLY_BLOCKED_TOOLS = new Set<string>(["write", "edit", "apply_patch", "eval", "manage_skill"]);

export function isCompanionTool(toolName: string): boolean {
  return (COMPANION_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function isRoleReadOnly(role: RoleSpec | null | undefined): boolean {
  if (!role) return false;
  if (role.permissions.writable !== undefined) return role.permissions.writable.length === 0;
  return (role.permissions.protected ?? []).includes("**");
}

export function hasWriteBoundary(role: RoleSpec | null | undefined): boolean {
  if (!role) return false;
  return role.permissions.writable !== undefined || (role.permissions.protected?.length ?? 0) > 0;
}

export function roleAllowsBash(role: RoleSpec | null | undefined): boolean {
  if (!role) return true;
  if (role.permissions.tools !== undefined) return role.permissions.tools.includes("bash");
  return !isRoleReadOnly(role);
}

export function canRoleDelegateTo(
  fromRole: RoleSpec | null | undefined,
  targetRole: RoleSpec | null | undefined,
): { allowed: boolean; reason?: string } {
  if (!targetRole) return { allowed: false, reason: "Unknown delegation target role." };
  if (targetRole.id === "supervisor") {
    return { allowed: false, reason: 'Role "supervisor" is an internal monitor and cannot be delegated to.' };
  }
  if (fromRole && fromRole.id === targetRole.id) {
    return { allowed: false, reason: `Role "${fromRole.id}" cannot delegate to itself.` };
  }
  if (fromRole && isRoleReadOnly(fromRole) && !isRoleReadOnly(targetRole)) {
    return {
      allowed: false,
      reason: `Read-only role "${fromRole.id}" cannot escalate write privileges by delegating to "${targetRole.id}".`,
    };
  }
  return { allowed: true };
}

export function canRoleUseCompanionTool(
  role: RoleSpec | null | undefined,
  toolName: string,
  action?: string,
  targetRoles?: readonly RoleSpec[],
): { allowed: boolean; reason?: string } {
  if (!role) return { allowed: true };
  if (toolName === "enhance_mandate" || toolName === "enhance_handoff") return { allowed: true };
  if (toolName === "enhance_job") {
    const normalized = action?.trim().toLowerCase();
    if (normalized === "list" || normalized === "tail" || normalized === "reconcile") {
      return { allowed: true };
    }
    if (isRoleReadOnly(role) || !roleAllowsBash(role)) {
      return {
        allowed: false,
        reason: `Role "${role.id}" does not permit background shell job execution (requires bash + non-readonly permissions).`,
      };
    }
    return { allowed: true };
  }
  if (toolName === "enhance_flow") {
    const normalized = action?.trim().toLowerCase();
    if (normalized === "status" || normalized === "cancel") return { allowed: true };
    if (isRoleReadOnly(role)) {
      if (targetRoles && targetRoles.length > 0 && targetRoles.every((r) => isRoleReadOnly(r))) {
        return { allowed: true };
      }
      return { allowed: false, reason: `Read-only role "${role.id}" cannot start or steer write-capable Flows.` };
    }
    return { allowed: true };
  }
  return { allowed: false, reason: `Unknown companion tool "${toolName}".` };
}

export function resolveRoleActiveTools(
  role: RoleSpec,
  allAvailableToolNames: readonly string[],
  mode: "foreground" | "stage" = "foreground",
): string[] {
  const readOnly = isRoleReadOnly(role);
  const explicitTools = role.permissions.tools ? new Set<string>(role.permissions.tools) : null;

  const hostFiltered = allAvailableToolNames.filter((toolName) => {
    if (isCompanionTool(toolName)) return false;
    if (explicitTools) {
      if (!explicitTools.has(toolName)) return false;
      if (readOnly && STRICT_READONLY_BLOCKED_TOOLS.has(toolName)) return false;
      return true;
    }
    if (readOnly && (MUTATING_HOST_TOOLS as readonly string[]).includes(toolName)) return false;
    return true;
  });

  if (mode === "stage") {
    const stageCompanions = ["enhance_handoff", "enhance_mandate"];
    if (canRoleUseCompanionTool(role, "enhance_job", "start").allowed) stageCompanions.push("enhance_job");
    return [...new Set([...hostFiltered, ...stageCompanions])];
  }

  const fgCompanions = ["enhance_mandate", "enhance_handoff", "enhance_flow"];
  if (canRoleUseCompanionTool(role, "enhance_job", "start").allowed) fgCompanions.push("enhance_job");
  return [...new Set([...hostFiltered, ...fgCompanions])];
}

export function extractTaskSubagents(input: unknown): string[] {
  const record = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>) : {};
  if (Array.isArray(record.tasks) && record.tasks.length > 0) {
    return record.tasks.map((item) => {
      const a = typeof item === "object" && item !== null ? (item as Record<string, unknown>).agent : undefined;
      return typeof a === "string" && a.trim() ? a.trim() : "task";
    });
  }
  return [typeof record.agent === "string" && record.agent.trim() ? record.agent.trim() : "task"];
}

export function summarizeToolCall(toolName: string, input: unknown): string {
  const r = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>) : {};
  const clip = (s: string, n = 44): string => {
    const clean = s.replace(/\s+/g, " ").trim();
    return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
  };
  if (toolName === "task") return `task → ${extractTaskSubagents(input).join(", ")}`;
  for (const key of ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "summary"] as const) {
    if (typeof r[key] === "string" && r[key]!.trim()) return `${toolName} ${clip(String(r[key]))}`;
  }
  if (Array.isArray(r.paths) && typeof r.paths[0] === "string") return `${toolName} ${clip(String(r.paths[0]))}`;
  return toolName;
}

function extractRawWriteTargets(toolName: string, input: unknown): string[] {
  if (!WRITE_TOOLS[toolName]) return [];
  const record = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>) : {};
  const targets: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) targets.push(value.trim());
  };
  add(record.path);
  add(record.file_path);
  add(record.filePath);
  add(record.target_file);
  add(record.destination);
  if (Array.isArray(record.paths)) for (const value of record.paths) add(value);
  if (Array.isArray(record.edits)) {
    for (const edit of record.edits) {
      if (typeof edit === "object" && edit !== null) {
        const er = edit as Record<string, unknown>;
        add(er.path); add(er.file_path); add(er.filePath);
      }
    }
  }
  if (toolName === "apply_patch") {
    for (const key of ["patch", "input", "diff"] as const) {
      const text = record[key];
      if (typeof text !== "string") continue;
      for (const match of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) add(match[1]);
      for (const match of text.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) add(match[1]);
    }
  }
  return targets;
}

export function extractWriteTargetPaths(cwd: string, toolName: string, input: unknown): string[] {
  const rawTargets = extractRawWriteTargets(toolName, input);
  const resolved = rawTargets.map((target) => {
    const safe = resolveSafeTargetRealpath(cwd, target);
    return safe.escapesWorkspace ? `../${safe.relPath.replace(/^(?:\.\.\/)+/, "")}` : safe.relPath;
  });
  return [...new Set(resolved)];
}

export function checkToolCallAllowed(
  cwd: string,
  role: RoleSpec | null,
  event: { toolName: string; input?: unknown },
  rolesMap?: ReadonlyMap<string, RoleSpec>,
): { block: boolean; reason?: string } {
  if (!role) return { block: false };
  const record = typeof event.input === "object" && event.input !== null && !Array.isArray(event.input)
    ? (event.input as Record<string, unknown>) : {};

  if (isCompanionTool(event.toolName)) {
    const action = typeof record.action === "string" ? record.action : undefined;
    if (event.toolName === "enhance_handoff" && record.delegateNow === true) {
      const targetId = typeof record.toTarget === "string" ? record.toTarget.trim() : "";
      if (targetId && targetId !== "user") {
        if (targetId === role.id) return { block: true, reason: `Role "${role.id}" cannot delegate to itself.` };
        if (targetId === "supervisor") return { block: true, reason: 'Role "supervisor" cannot be a delegation target.' };
        if (rolesMap) {
          const check = canRoleDelegateTo(role, rolesMap.get(targetId));
          if (!check.allowed) return { block: true, reason: check.reason };
        }
      }
    }
    const targetRoles = event.toolName === "enhance_flow" && rolesMap && Array.isArray(record.roles)
      ? record.roles.map((id) => (typeof id === "string" ? rolesMap.get(id.trim()) : undefined)).filter((r): r is RoleSpec => Boolean(r))
      : undefined;
    const compCheck = canRoleUseCompanionTool(
      role, event.toolName, action ?? (event.toolName === "enhance_job" ? "start" : undefined), targetRoles,
    );
    return compCheck.allowed ? { block: false } : { block: true, reason: compCheck.reason };
  }

  const allowedTools = role.permissions.tools;
  if (allowedTools && !allowedTools.includes(event.toolName)) {
    return { block: true, reason: `Role "${role.id}" does not permit tool "${event.toolName}".` };
  }

  const readOnly = isRoleReadOnly(role);
  if (readOnly) {
    if (STRICT_READONLY_BLOCKED_TOOLS.has(event.toolName)) {
      return { block: true, reason: `Role "${role.id}" is read-only; tool "${event.toolName}" is not permitted.` };
    }
    if (event.toolName === "bash" && !allowedTools) {
      return { block: true, reason: `Role "${role.id}" is read-only; bash is not permitted.` };
    }
  }

  const boundary = hasWriteBoundary(role);
  if (event.toolName === "task") {
    if (boundary) {
      const forbidden = extractTaskSubagents(event.input).find((agent) => !READONLY_SUBAGENT_SET.has(agent));
      if (forbidden) {
        return {
          block: true,
          reason: `Role "${role.id}" restricts write paths and may only spawn read-only subagents (${READONLY_SUBAGENTS.join(", ")}); blocked "${forbidden}".`,
        };
      }
    }
    return { block: false };
  }

  if (!WRITE_TOOLS[event.toolName] || !boundary) return { block: false };
  const writable = role.permissions.writable;
  if (writable?.length === 0) {
    return { block: true, reason: `Role "${role.id}" is read-only; write operations are not permitted.` };
  }

  const rawTargets = extractRawWriteTargets(event.toolName, event.input);
  if (rawTargets.length === 0) {
    return {
      block: true,
      reason: `Role "${role.id}" restricts write paths and could not verify target path for "${event.toolName}".`,
    };
  }

  for (const rawTarget of rawTargets) {
    const resolved = resolveSafeTargetRealpath(cwd, rawTarget);
    if (resolved.escapesWorkspace) {
      return { block: true, reason: `Path "${rawTarget}" escapes the workspace boundary.` };
    }
    if (matchesGlobList(resolved.relPath, role.permissions.protected ?? [])) {
      return { block: true, reason: `Path "${resolved.relPath}" is protected for role "${role.id}".` };
    }
    if (writable && !matchesGlobList(resolved.relPath, writable)) {
      return { block: true, reason: `Path "${resolved.relPath}" is outside the writable globs for role "${role.id}".` };
    }
  }
  return { block: false };
}

export function isValidExecutionEvidence(toolName: string, isError: boolean): boolean {
  if (isError) return false;
  if (toolName === "enhance_job") return true;
  if (isCompanionTool(toolName)) return false;
  return Boolean(toolName && toolName !== "unknown");
}

export class TurnTracker {
  private baseline: Map<string, SnapshotEntry> | null = null;
  private configBaseline: Map<string, SnapshotEntry> | null = null;
  private calls: ObservedToolCall[] = [];
  private inFlightTool: { name: string; startedMs: number; summary?: string } | null = null;
  private turnOpen = false;

  resetTurn(cwd: string): void {
    this.turnOpen = false;
    this.inFlightTool = null;
    this.beginTurn(cwd, false);
  }

  beginTurn(cwd: string, preserveIfIncomplete = true): void {
    if (preserveIfIncomplete && this.turnOpen && this.baseline !== null) return;
    this.baseline = snapshotWorkspace(cwd);
    this.configBaseline = snapshotConfigIntegrity(cwd);
    this.calls = [];
    this.inFlightTool = null;
    this.turnOpen = true;
  }

  completeTurn(): void {
    this.turnOpen = false;
    this.inFlightTool = null;
  }

  checkToolCallAllowed(
    cwd: string,
    role: RoleSpec | null,
    event: { toolName: string; input?: unknown },
    rolesMap?: ReadonlyMap<string, RoleSpec>,
  ): { block: boolean; reason?: string } {
    return checkToolCallAllowed(cwd, role, event, rolesMap);
  }

  recordToolExecutionStart(toolName: string, input?: unknown): void {
    this.inFlightTool = { name: toolName, startedMs: Date.now(), summary: summarizeToolCall(toolName, input) };
  }

  recordToolExecutionEnd(
    cwd: string,
    event: { toolCallId: string; toolName: string; args?: unknown; isError?: boolean },
  ): ObservedToolCall {
    this.inFlightTool = null;
    const call: ObservedToolCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError ?? false,
      touchedPaths: extractWriteTargetPaths(cwd, event.toolName, event.args),
      timestamp: new Date().toISOString(),
      summary: summarizeToolCall(event.toolName, event.args),
    };
    this.calls.push(call);
    return call;
  }

  getActiveTool(): SupervisorActiveTool | null {
    if (!this.inFlightTool) return null;
    return {
      name: this.inFlightTool.name,
      elapsedSec: Math.max(0, Math.round((Date.now() - this.inFlightTool.startedMs) / 100) / 10),
      ...(this.inFlightTool.summary ? { summary: this.inFlightTool.summary } : {}),
    };
  }

  getObservedCalls(): ObservedToolCall[] { return [...this.calls]; }
  getBaselineSnapshot(): ReadonlyMap<string, SnapshotEntry> | null { return this.baseline; }
  getBaselineConfigSnapshot(): ReadonlyMap<string, SnapshotEntry> | null { return this.configBaseline; }
}
