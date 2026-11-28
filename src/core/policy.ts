import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ObservedToolCall, RoleSpec, SupervisorActiveTool } from "./types.ts";
import { computeSnapshotFingerprint, matchesGlobList, resolveSafeTargetRealpath, snapshotConfigIntegrity, snapshotWorkspace, type SnapshotEntry } from "./fs.ts";

export const COMPANION_TOOL_NAMES = ["enhance_mandate", "enhance_handoff", "enhance_flow", "enhance_job"] as const;
export const READONLY_SUBAGENTS = ["scout", "reviewer", "security-reviewer"] as const;
export const WRITE_TOOLS: Readonly<Record<string, true>> = { write: true, edit: true, apply_patch: true, ast_edit: true };
export const MUTATING_HOST_TOOLS = [
  "write", "edit", "apply_patch", "ast_edit", "bash", "eval",
  "manage_skill", "learn", "memory_edit", "retain", "context_notes", "new_context",
] as const;
export const DEFAULT_READONLY_TOOLS = ["read", "grep", "glob", "find", "lsp", "task", "wait"] as const;

const GLOB_META = /[*?[\]{}]/;
const READONLY_SUBAGENT_SET = new Set<string>(READONLY_SUBAGENTS);
const STRICT_READONLY_BLOCKED_TOOLS = new Set<string>([
  "write", "edit", "apply_patch", "ast_edit", "eval",
  "manage_skill", "learn", "memory_edit", "retain", "context_notes", "new_context",
]);
const COORDINATOR_BLOCKED_DIRECT_TOOLS = new Set<string>([...MUTATING_HOST_TOOLS]);
const FG_COORD_HINT = "(/coord off 退回标准 OMP，或 /coord 切回总秘书)";
const ANSI_STRIP_RE = /\x1b\[[0-9;:?]*[A-Za-z]/g;
const BG_LAUNCH_OUTPUT_RE = /^\s*(?:Started background job|Background job started|Launched background|bg_[a-zA-Z0-9_-]+\s+started)\b/i;

export const isCompanionTool = (toolName: string): boolean => (COMPANION_TOOL_NAMES as readonly string[]).includes(toolName);
export const isInternalRole = (role: RoleSpec | null | undefined): boolean => Boolean(role?.internal || role?.id === "supervisor");
export const canRoleDispatch = (role: RoleSpec | null | undefined): boolean => Boolean(role?.permissions.dispatch);
export function isRoleReadOnly(role: RoleSpec | null | undefined): boolean {
  if (!role) return false;
  return role.permissions.writable !== undefined ? role.permissions.writable.length === 0 : (role.permissions.protected ?? []).includes("**");
}
export const hasWriteBoundary = (role: RoleSpec | null | undefined): boolean =>
  Boolean(role && (role.permissions.writable !== undefined || (role.permissions.protected?.length ?? 0) > 0));
export function roleAllowsBash(role: RoleSpec | null | undefined): boolean {
  if (!role) return true;
  return role.permissions.tools !== undefined ? role.permissions.tools.includes("bash") : !isRoleReadOnly(role);
}

export function canRoleDelegateTo(fromRole: RoleSpec | null | undefined, targetRole: RoleSpec | null | undefined): { allowed: boolean; reason?: string } {
  if (!targetRole) return { allowed: false, reason: "Unknown delegation target role." };
  if (isInternalRole(targetRole)) return { allowed: false, reason: `Role "${targetRole.id}" is an internal monitor and cannot be delegated to.` };
  if (fromRole && fromRole.id === targetRole.id) return { allowed: false, reason: `Role "${fromRole.id}" cannot delegate to itself.` };
  if (fromRole && isRoleReadOnly(fromRole) && !canRoleDispatch(fromRole) && !isRoleReadOnly(targetRole)) {
    return { allowed: false, reason: `Read-only role "${fromRole.id}" cannot escalate write privileges by delegating to "${targetRole.id}".` };
  }
  return { allowed: true };
}

export function canRoleUseCompanionTool(
  role: RoleSpec | null | undefined, toolName: string, action?: string, targetRoles?: readonly RoleSpec[],
): { allowed: boolean; reason?: string } {
  if (!role || toolName === "enhance_mandate") return { allowed: true };
  const norm = action?.trim().toLowerCase();
  if (canRoleDispatch(role)) {
    if (toolName === "enhance_handoff") return { allowed: false, reason: `Role "${role.id}" dispatches specialists via enhance_flow and never submits stage handoffs directly.` };
    if (toolName === "enhance_flow") return { allowed: true };
    if (toolName === "enhance_job") {
      if (norm === "list" || norm === "reconcile" || norm === "tail" || norm === "watch" || norm === "cancel") return { allowed: true };
      return { allowed: false, reason: `Role "${role.id}" never spawns shell commands directly — dispatch specialist ["algo"] or ["dev"] via enhance_flow to run background jobs.` };
    }
    return { allowed: false, reason: `Unknown companion tool "${toolName}".` };
  }
  if (toolName === "enhance_handoff") return { allowed: true };
  if (toolName === "enhance_job") {
    if (norm === "list" || norm === "tail" || norm === "reconcile") return { allowed: true };
    if (isRoleReadOnly(role) || !roleAllowsBash(role)) {
      return { allowed: false, reason: `Role "${role.id}" does not permit background shell job execution (requires bash + non-readonly permissions).` };
    }
    return { allowed: true };
  }
  if (toolName === "enhance_flow") {
    if (norm === "status" || norm === "cancel") return { allowed: true };
    if (isRoleReadOnly(role)) {
      if (targetRoles && targetRoles.length > 0 && targetRoles.every((r) => isRoleReadOnly(r))) return { allowed: true };
      return { allowed: false, reason: `Read-only role "${role.id}" cannot start or steer write-capable Flows.` };
    }
    return { allowed: true };
  }
  return { allowed: false, reason: `Unknown companion tool "${toolName}".` };
}

export function resolveEffectiveActiveTools(
  role: RoleSpec | null | undefined, allAvailableToolNames: readonly string[], mode: "foreground" | "stage" = "foreground",
): string[] | null {
  return role ? resolveRoleActiveTools(role, allAvailableToolNames, mode) : null;
}

export function resolveRoleActiveTools(
  role: RoleSpec, allAvailableToolNames: readonly string[], mode: "foreground" | "stage" = "foreground",
): string[] {
  const readOnly = isRoleReadOnly(role), dispatch = canRoleDispatch(role);
  const explicitTools = role.permissions.tools ? new Set<string>(role.permissions.tools) : null;
  const allowMcpWildcard = role.permissions.mcp === true && !(role.permissions.tools?.some((t) => t.startsWith("mcp_")) ?? false);
  const hostFiltered = allAvailableToolNames.filter((toolName) => {
    if (isCompanionTool(toolName)) return false;
    if (allowMcpWildcard && toolName.startsWith("mcp_")) return true;
    if (explicitTools) return explicitTools.has(toolName) && !(readOnly && STRICT_READONLY_BLOCKED_TOOLS.has(toolName));
    return !(readOnly && (MUTATING_HOST_TOOLS as readonly string[]).includes(toolName));
  });
  const baseCompanions = dispatch
    ? ["enhance_mandate", "enhance_flow", "enhance_job"]
    : (mode === "stage" ? ["enhance_handoff", "enhance_mandate"] : ["enhance_mandate", "enhance_handoff", "enhance_flow"]);
  if (!dispatch && canRoleUseCompanionTool(role, "enhance_job", "start").allowed) baseCompanions.push("enhance_job");
  return [...new Set([...hostFiltered, ...baseCompanions])];
}

export function extractTaskSubagents(input: unknown): string[] {
  const r = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (Array.isArray(r.tasks) && r.tasks.length > 0) {
    return r.tasks.map((it) => {
      const a = typeof it === "object" && it !== null ? (it as Record<string, unknown>).agent : undefined;
      return typeof a === "string" && a.trim() ? a.trim() : "task";
    });
  }
  return [typeof r.agent === "string" && r.agent.trim() ? r.agent.trim() : "task"];
}

export function summarizeToolCall(toolName: string, input: unknown): string {
  const r = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const clip = (s: string, n = 44): string => { const c = s.replace(/\s+/g, " ").trim(); return c.length > n ? `${c.slice(0, n - 1)}…` : c; };
  if (toolName === "task") return `task → ${extractTaskSubagents(input).join(", ")}`;
  for (const key of ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "summary"] as const) {
    if (typeof r[key] === "string" && r[key]!.trim()) return `${toolName} ${clip(String(r[key]))}`;
  }
  return Array.isArray(r.paths) && typeof r.paths[0] === "string" ? `${toolName} ${clip(String(r.paths[0]))}` : toolName;
}

function extractRawWriteTargets(toolName: string, input: unknown): { targets: string[]; invalid: boolean } {
  if (!WRITE_TOOLS[toolName]) return { targets: [], invalid: false };
  const record = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const targets: string[] = [];
  let invalid = false;
  const add = (v: unknown): void => { if (typeof v === "string" && v.trim()) targets.push(v.trim()); };
  const addArray = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    if (arr.length === 0) { invalid = true; return; }
    for (const item of arr) { if (typeof item !== "string" || !item.trim()) invalid = true; else targets.push(item.trim()); }
  };
  const rawPath = typeof record.path === "string" && record.path.trim() ? record.path.trim() : undefined;
  if (record.glob !== undefined) {
    if (typeof record.glob !== "string" || !record.glob.trim()) invalid = true;
    else targets.push(rawPath ? `${rawPath.replace(/\/+$/, "")}/${record.glob.trim().replace(/^\/+/, "")}` : record.glob.trim());
  } else if (rawPath) targets.push(rawPath);
  for (const k of ["file_path", "filePath", "target_file", "destination"] as const) add(record[k]);
  addArray(record.paths); addArray(record.files);
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
      for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) add(m[1]);
      for (const m of text.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) add(m[1]);
    }
  }
  return { targets, invalid };
}

const isExistingDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

function staticPrefixOfGlob(raw: string): string {
  const norm = raw.trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (!norm || norm === ".") return "";
  const segs: string[] = [];
  for (const seg of norm.split("/")) { if (GLOB_META.test(seg)) break; segs.push(seg); }
  return segs.join("/");
}

function validateWriteTarget(cwd: string, rawTarget: string, role: RoleSpec): { block: boolean; reason?: string } {
  const writable = role.permissions.writable, protectedGlobs = role.permissions.protected ?? [];
  if (!GLOB_META.test(rawTarget)) {
    const resolved = resolveSafeTargetRealpath(cwd, rawTarget);
    if (resolved.escapesWorkspace) return { block: true, reason: `Path "${rawTarget}" escapes the workspace boundary.` };
    if (resolved.relPath !== "" && !isExistingDir(resolved.resolvedPath)) {
      if (matchesGlobList(resolved.relPath, protectedGlobs)) return { block: true, reason: `Path "${resolved.relPath}" is protected for role "${role.id}".` };
      if (writable && !matchesGlobList(resolved.relPath, writable)) return { block: true, reason: `Path "${resolved.relPath}" is outside the writable globs for role "${role.id}".` };
      return { block: false };
    }
  }

  const slashNorm = rawTarget.trim().replaceAll("\\", "/");
  const rootLead = slashNorm.startsWith("/") ? "/" : (/^[a-zA-Z]:\//.exec(slashNorm)?.[0] ?? "");
  const restSegs = slashNorm.slice(rootLead.length).replace(/^(?:\.\/)+/, "").split("/").filter(Boolean);
  const staticSegs: string[] = [];
  for (const seg of restSegs) { if (GLOB_META.test(seg)) break; staticSegs.push(seg); }
  const prefixTarget = rootLead ? `${rootLead}${staticSegs.join("/")}` : (staticSegs.join("/") || ".");
  const resolvedBase = resolveSafeTargetRealpath(cwd, prefixTarget);
  if (resolvedBase.escapesWorkspace) return { block: true, reason: `Path "${rawTarget}" escapes the workspace boundary.` };
  const subRoot = resolvedBase.relPath;
  if (!subRoot) return { block: true, reason: `Role "${role.id}" restricts write paths; "${rawTarget}" must target a bounded subdirectory or file.` };

  const tailSegs = restSegs.slice(staticSegs.length);
  const probeTail = tailSegs.length > 0
    ? tailSegs.map((s) => (s === "**" ? "__sub__" : s.replace(/\{([^,}]+)(?:,[^}]*)?\}/g, "$1").replace(/\*\*/g, "__sub__").replace(/[*?]/g, "x").replace(/\[[^\]]*\]/g, "x"))).join("/")
    : "__probe__";
  const probes = [...new Set([`${subRoot}/${probeTail}`, `${subRoot}/__probe__`])];

  for (const pGlob of protectedGlobs) {
    const pPre = staticPrefixOfGlob(pGlob);
    if (!pPre || pPre === subRoot || pPre.startsWith(`${subRoot}/`) || subRoot.startsWith(`${pPre}/`)) {
      return { block: true, reason: `Target "${rawTarget}" overlaps protected path "${pGlob}" for role "${role.id}".` };
    }
  }
  if (probes.some((p) => matchesGlobList(p, protectedGlobs))) return { block: true, reason: `Target "${rawTarget}" is protected for role "${role.id}".` };
  if (writable && !matchesGlobList(probes[0]!, writable)) return { block: true, reason: `Target "${rawTarget}" is outside the writable globs for role "${role.id}".` };

  if (existsSync(resolvedBase.resolvedPath)) {
    const stack = [resolvedBase.resolvedPath];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".omp-enhance") continue;
        const full = path.join(dir, entry.name), safe = resolveSafeTargetRealpath(cwd, full);
        if (safe.escapesWorkspace) return { block: true, reason: `Symlink "${safe.relPath}" inside "${subRoot}" escapes workspace.` };
        const checkPath = isExistingDir(safe.resolvedPath) ? `${safe.relPath}/__probe__` : safe.relPath;
        if (matchesGlobList(safe.relPath, protectedGlobs) || matchesGlobList(checkPath, protectedGlobs)) {
          return { block: true, reason: `Path "${safe.relPath}" inside "${subRoot}" is protected for role "${role.id}".` };
        }
        if (entry.isSymbolicLink() && writable && !matchesGlobList(checkPath, writable)) {
          return { block: true, reason: `Symlink "${entry.name}" inside "${subRoot}" points outside writable globs for role "${role.id}".` };
        }
        if (entry.isDirectory()) stack.push(full);
      }
    }
  }
  return { block: false };
}

export function extractWriteTargetPaths(cwd: string, toolName: string, input: unknown): string[] {
  const { targets } = extractRawWriteTargets(toolName, input);
  const resolved = targets.filter((t) => !GLOB_META.test(t)).flatMap((target) => {
    const safe = resolveSafeTargetRealpath(cwd, target);
    if (!safe.escapesWorkspace && (safe.relPath === "" || isExistingDir(safe.resolvedPath))) return [];
    return [safe.escapesWorkspace ? `../${safe.relPath.replace(/^(?:\.\.\/)+/, "")}` : safe.relPath];
  });
  return [...new Set(resolved)];
}

export function checkToolCallAllowed(
  cwd: string, role: RoleSpec | null, event: { toolName: string; input?: unknown },
  rolesMap?: ReadonlyMap<string, RoleSpec>, mode: "foreground" | "stage" = "foreground",
): { block: boolean; reason?: string } {
  if (!role) return { block: false };
  const record = typeof event.input === "object" && event.input !== null && !Array.isArray(event.input) ? (event.input as Record<string, unknown>) : {};
  const addFgHint = (reason: string): string => (mode === "foreground" ? `${reason} ${FG_COORD_HINT}` : reason);

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
    const spawnsViaWatch = event.toolName === "enhance_job" && action?.trim().toLowerCase() === "watch"
      && typeof record.command === "string" && Boolean(record.command.trim()) && !(typeof record.jobId === "string" && record.jobId.trim());
    const compCheck = canRoleUseCompanionTool(
      role, event.toolName, spawnsViaWatch ? "start" : (action ?? (event.toolName === "enhance_job" ? "start" : undefined)), targetRoles,
    );
    return compCheck.allowed ? { block: false } : { block: true, reason: compCheck.reason };
  }

  if (canRoleDispatch(role) && COORDINATOR_BLOCKED_DIRECT_TOOLS.has(event.toolName)) {
    return {
      block: true,
      reason: `Role "${role.id}" is a pure coordinator and never mutates files or runs shell commands directly — dispatch a background specialist (e.g. ["dev"] or ["dev","qa"]) via enhance_flow instead.`,
    };
  }

  const allowedTools = role.permissions.tools;
  const allowMcpWildcard = role.permissions.mcp === true && !(allowedTools?.some((t) => t.startsWith("mcp_")) ?? false);
  if (allowedTools && !allowedTools.includes(event.toolName) && !(allowMcpWildcard && event.toolName.startsWith("mcp_"))) {
    const base = `Role "${role.id}" does not permit tool "${event.toolName}".`;
    const isMut = Boolean(WRITE_TOOLS[event.toolName] || COORDINATOR_BLOCKED_DIRECT_TOOLS.has(event.toolName));
    return { block: true, reason: !canRoleDispatch(role) && isMut ? addFgHint(base) : base };
  }

  if (isRoleReadOnly(role)) {
    if (STRICT_READONLY_BLOCKED_TOOLS.has(event.toolName)) {
      return { block: true, reason: addFgHint(`Role "${role.id}" is read-only; tool "${event.toolName}" is not permitted.`) };
    }
    if (event.toolName === "bash" && !allowedTools) return { block: true, reason: addFgHint(`Role "${role.id}" is read-only; bash is not permitted.`) };
  }

  const boundary = hasWriteBoundary(role);
  if (event.toolName === "task") {
    if (boundary) {
      const forbidden = extractTaskSubagents(event.input).find((agent) => !READONLY_SUBAGENT_SET.has(agent));
      if (forbidden) {
        return { block: true, reason: `Role "${role.id}" restricts write paths and may only spawn read-only subagents (${READONLY_SUBAGENTS.join(", ")}); blocked "${forbidden}".` };
      }
    }
    return { block: false };
  }

  if (!WRITE_TOOLS[event.toolName] || !boundary) return { block: false };
  if (role.permissions.writable?.length === 0) return { block: true, reason: addFgHint(`Role "${role.id}" is read-only; write operations are not permitted.`) };

  const { targets: rawTargets, invalid } = extractRawWriteTargets(event.toolName, event.input);
  if (invalid || rawTargets.length === 0) {
    return { block: true, reason: addFgHint(`Role "${role.id}" restricts write paths and could not verify target path for "${event.toolName}".`) };
  }
  for (const rawTarget of rawTargets) {
    const res = validateWriteTarget(cwd, rawTarget, role);
    if (res.block) return { block: true, reason: res.reason ? addFgHint(res.reason) : undefined };
  }
  return { block: false };
}

export function isValidExecutionEvidence(
  toolName: string, isError: boolean, call?: Pick<ObservedToolCall, "isBackgroundLaunch" | "exitCode">,
): boolean {
  if (isError || call?.isBackgroundLaunch || (typeof call?.exitCode === "number" && call.exitCode !== 0)) return false;
  if (toolName === "enhance_job") return true;
  return !isCompanionTool(toolName) && Boolean(toolName && toolName !== "unknown");
}

function extractToolResultText(rawResult: unknown, rawOutput?: unknown): string {
  if (typeof rawOutput === "string") return rawOutput;
  if (typeof rawResult === "string") return rawResult;
  if (!rawResult || typeof rawResult !== "object") return "";
  const r = rawResult as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    const joined = r.content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).filter(Boolean).join("\n");
    if (joined) return joined;
  }
  for (const k of ["output", "stdout", "stderr", "text"] as const) if (typeof r[k] === "string" && r[k]) return r[k] as string;
  return "";
}

function extractToolOutcomeMeta(
  toolName: string, args: unknown,
  event: { isError?: boolean; result?: unknown; output?: unknown; details?: unknown; exitCode?: number | null },
): Pick<ObservedToolCall, "command" | "exitCode" | "outputSnippet" | "isBackgroundLaunch"> {
  const rec = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const isExec = toolName === "bash" || toolName === "enhance_job";
  const rawCmd = isExec ? ([rec.command, rec.cmd].find((v): v is string => typeof v === "string" && Boolean(v.trim()))?.trim()) : undefined;
  const rawText = extractToolResultText(event.result, event.output).replace(ANSI_STRIP_RE, "").trim();
  const outputSnippet = rawText ? (rawText.length > 240 ? `${rawText.slice(0, 239)}…` : rawText) : undefined;
  const resObj = event.result && typeof event.result === "object" && !Array.isArray(event.result) ? (event.result as Record<string, unknown>) : null;
  const details = (event.details && typeof event.details === "object" ? event.details : resObj?.details) as Record<string, unknown> | undefined;
  const action = typeof rec.action === "string" ? rec.action.trim().toLowerCase() : "";
  const isBackgroundLaunch = (toolName === "enhance_job" && (action === "start" || (!action && Boolean(rawCmd)))) ||
    (toolName === "bash" && (rec.background === true || rec.run_in_background === true || rec.async === true || details?.background === true || BG_LAUNCH_OUTPUT_RE.test(rawText)));

  let exitCode: number | null | undefined = event.exitCode;
  if (exitCode === undefined && details) exitCode = typeof details.exitCode === "number" ? details.exitCode : (typeof details.code === "number" ? details.code : undefined);
  if (exitCode === undefined && toolName === "enhance_job" && rawText.startsWith("{")) {
    try {
      const p = JSON.parse(rawText) as { exitCode?: unknown; status?: unknown; job?: { exitCode?: unknown; status?: unknown } };
      const jc = typeof p.exitCode === "number" ? p.exitCode : (typeof p.job?.exitCode === "number" ? p.job.exitCode : undefined);
      if (jc !== undefined) exitCode = jc; else if (p.status === "running" || p.job?.status === "running") exitCode = null;
    } catch {}
  }
  if (exitCode === undefined && rawText) { const m = /(?:Exit code:|exited with code)\s*(-?\d+)/i.exec(rawText); if (m) exitCode = Number.parseInt(m[1]!, 10); }
  if (exitCode === undefined && (isExec || event.result !== undefined || event.output !== undefined)) exitCode = isBackgroundLaunch ? null : (event.isError ? 1 : 0);
  return {
    ...(rawCmd !== undefined ? { command: rawCmd } : {}), ...(exitCode !== undefined ? { exitCode } : {}),
    ...(outputSnippet !== undefined ? { outputSnippet } : {}), ...(isBackgroundLaunch ? { isBackgroundLaunch: true } : {}),
  };
}

export class TurnTracker {
  private baseline: Map<string, SnapshotEntry> | null = null;
  private configBaseline: Map<string, SnapshotEntry> | null = null;
  private lastCwd: string | null = null;
  private calls: ObservedToolCall[] = [];
  private pendingInputs = new Map<string, unknown>();
  private lastStartInput: { toolName: string; input: unknown } | null = null;
  private inFlightTool: { name: string; startedMs: number; summary?: string } | null = null;
  private turnOpen = false;
  private turnFailed = false;

  resetTurn(cwd?: string): void {
    if (cwd) this.lastCwd = cwd;
    this.baseline = null; this.configBaseline = null; this.calls = []; this.pendingInputs.clear(); this.lastStartInput = null;
    this.inFlightTool = null; this.turnOpen = false; this.turnFailed = false;
  }
  beginTurn(cwd: string, preserveIfIncomplete = true): void {
    this.lastCwd = cwd;
    if (preserveIfIncomplete && this.turnOpen && this.baseline !== null) return;
    this.baseline = snapshotWorkspace(cwd); this.configBaseline = snapshotConfigIntegrity(cwd);
    this.calls = []; this.pendingInputs.clear(); this.lastStartInput = null;
    this.inFlightTool = null; this.turnOpen = true; this.turnFailed = false;
  }
  markTurnFailed(): void { this.turnFailed = true; this.inFlightTool = null; }
  completeTurn(): void { this.turnOpen = false; this.turnFailed = false; this.inFlightTool = null; }
  checkToolCallAllowed(
    cwd: string, role: RoleSpec | null, event: { toolName: string; input?: unknown },
    rolesMap?: ReadonlyMap<string, RoleSpec>, mode: "foreground" | "stage" = "foreground",
  ): { block: boolean; reason?: string } {
    return checkToolCallAllowed(cwd, role, event, rolesMap, mode);
  }
  recordToolExecutionStart(toolName: string, input?: unknown, toolCallId?: string): void {
    this.inFlightTool = { name: toolName, startedMs: Date.now(), summary: summarizeToolCall(toolName, input) };
    this.lastStartInput = { toolName, input };
    if (toolCallId) this.pendingInputs.set(toolCallId, input);
  }
  recordToolExecutionEnd(
    cwd: string,
    event: { toolCallId: string; toolName: string; args?: unknown; input?: unknown; result?: unknown; output?: unknown; details?: unknown; exitCode?: number | null; isError?: boolean; stageId?: string },
  ): ObservedToolCall {
    this.inFlightTool = null;
    const effArgs = event.args ?? event.input ?? this.pendingInputs.get(event.toolCallId) ?? (this.lastStartInput?.toolName === event.toolName ? this.lastStartInput.input : undefined);
    this.pendingInputs.delete(event.toolCallId); this.lastStartInput = null;
    const meta = extractToolOutcomeMeta(event.toolName, effArgs, event);
    const captureTree = (event.toolName === "bash" || event.toolName === "enhance_job") && !(event.isError ?? false) && !meta.isBackgroundLaunch && (meta.exitCode === undefined || meta.exitCode === 0);
    const call: ObservedToolCall = {
      toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError ?? false,
      touchedPaths: extractWriteTargetPaths(cwd, event.toolName, effArgs), timestamp: new Date().toISOString(),
      summary: summarizeToolCall(event.toolName, effArgs), ...meta,
      ...(event.stageId ? { stageId: event.stageId } : {}), ...(captureTree ? { testedTreeFingerprint: computeSnapshotFingerprint(snapshotWorkspace(cwd)) } : {}),
    };
    this.calls.push(call);
    return call;
  }
  getActiveTool(): SupervisorActiveTool | null {
    if (!this.inFlightTool) return null;
    return {
      name: this.inFlightTool.name, elapsedSec: Math.max(0, Math.round((Date.now() - this.inFlightTool.startedMs) / 100) / 10),
      ...(this.inFlightTool.summary ? { summary: this.inFlightTool.summary } : {}),
    };
  }
  getObservedCalls(): ObservedToolCall[] { return [...this.calls]; }
  getBaselineSnapshot(cwd?: string): ReadonlyMap<string, SnapshotEntry> | null {
    const target = cwd ?? this.lastCwd; if (this.baseline === null && target) this.baseline = snapshotWorkspace(target); return this.baseline;
  }
  getBaselineConfigSnapshot(cwd?: string): ReadonlyMap<string, SnapshotEntry> | null {
    const target = cwd ?? this.lastCwd; if (this.configBaseline === null && target) this.configBaseline = snapshotConfigIntegrity(target); return this.configBaseline;
  }
}
