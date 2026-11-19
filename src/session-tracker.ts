import path from "node:path";
import type { ObservedToolCall, RoleSpec } from "./types.ts";
import { matchesGlobList, snapshotWorkspace, type SnapshotEntry } from "./store.ts";

export const COMPANION_TOOL_NAMES = ["enhance_mandate", "enhance_handoff", "enhance_flow", "enhance_job"] as const;

export function isCompanionTool(toolName: string): boolean {
  return (COMPANION_TOOL_NAMES as readonly string[]).includes(toolName);
}

const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, apply_patch: true };

export function extractWriteTargetPaths(cwd: string, toolName: string, input: unknown): string[] {
  if (!WRITE_TOOLS[toolName]) return [];
  const record = typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const targets: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) targets.push(value.trim());
  };
  add(record.path);
  add(record.file_path);
  if (Array.isArray(record.paths)) {
    for (const value of record.paths) add(value);
  }
  if (Array.isArray(record.edits)) {
    for (const edit of record.edits) {
      if (typeof edit === "object" && edit !== null) add((edit as Record<string, unknown>).path);
    }
  }
  if (toolName === "apply_patch") {
    for (const key of ["patch", "input"] as const) {
      const text = record[key];
      if (typeof text !== "string") continue;
      for (const match of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) add(match[1]);
    }
  }
  return [...new Set(targets.map((target) => path.relative(cwd, path.resolve(cwd, target)).replaceAll("\\", "/")))];
}

export class TurnTracker {
  private baseline: Map<string, SnapshotEntry> | null = null;
  private calls: ObservedToolCall[] = [];

  resetTurn(cwd: string): void {
    this.baseline = snapshotWorkspace(cwd);
    this.calls = [];
  }

  checkToolCallAllowed(
    cwd: string,
    role: RoleSpec | null,
    event: { toolName: string; input?: unknown },
  ): { block: boolean; reason?: string } {
    if (!role) return { block: false };
    const allowedTools = role.permissions.tools;
    if (allowedTools && !allowedTools.includes(event.toolName) && !isCompanionTool(event.toolName)) {
      return { block: true, reason: `Role "${role.id}" does not permit tool "${event.toolName}".` };
    }
    if (!WRITE_TOOLS[event.toolName]) return { block: false };
    const writable = role.permissions.writable;
    if (writable?.length === 0) {
      return { block: true, reason: `Role "${role.id}" is read-only; write operations are not permitted.` };
    }
    for (const relPath of extractWriteTargetPaths(cwd, event.toolName, event.input)) {
      if (relPath === ".." || relPath.startsWith("../")) {
        return { block: true, reason: `Path "${relPath}" escapes the workspace boundary.` };
      }
      if (matchesGlobList(relPath, role.permissions.protected ?? [])) {
        return { block: true, reason: `Path "${relPath}" is protected for role "${role.id}".` };
      }
      if (writable && !matchesGlobList(relPath, writable)) {
        return { block: true, reason: `Path "${relPath}" is outside the writable globs for role "${role.id}".` };
      }
    }
    return { block: false };
  }

  recordToolExecutionEnd(
    cwd: string,
    event: { toolCallId: string; toolName: string; args?: unknown; isError?: boolean },
  ): ObservedToolCall {
    const call: ObservedToolCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError ?? false,
      touchedPaths: extractWriteTargetPaths(cwd, event.toolName, event.args),
      timestamp: new Date().toISOString(),
    };
    this.calls.push(call);
    return call;
  }

  getObservedCalls(): ObservedToolCall[] {
    return [...this.calls];
  }

  getBaselineSnapshot(): ReadonlyMap<string, SnapshotEntry> | null {
    return this.baseline;
  }
}

export function resolveRoleActiveTools(role: RoleSpec, allAvailableToolNames: readonly string[]): string[] {
  const companions = COMPANION_TOOL_NAMES as readonly string[];
  if (!role.permissions.tools) return [...new Set([...allAvailableToolNames, ...companions])];
  const enabled = new Set([...role.permissions.tools, ...companions]);
  return [...new Set([...allAvailableToolNames.filter((toolName) => enabled.has(toolName)), ...companions])];
}
