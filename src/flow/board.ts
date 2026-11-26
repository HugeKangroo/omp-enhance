import type { FlowBoardEntry, FlowNodeSpec, NodeBrief } from "../core/graph-types.ts";
import type { EnhanceStore } from "../core/store.ts";

const DEFAULT_MAX_BOARD_CHARS = 3_600;

export function formatNodeBrief(brief: NodeBrief | string | undefined, fallbackGoal: string): string {
  if (!brief) return `Goal: ${fallbackGoal}`;
  if (typeof brief === "string") return brief;
  const lines = [`Owns: ${brief.owns}`];
  if (brief.nonGoals?.length) lines.push("Non-goals / Constraints:", ...brief.nonGoals.map((g) => `- ${g}`));
  if (brief.acceptance.length) lines.push("Definition of Done:", ...brief.acceptance.map((a) => `- ${a}`));
  if (brief.contextRefs?.length) lines.push(`Context refs: ${brief.contextRefs.join(", ")}`);
  return lines.join("\n");
}

export function appendBoardEntrySafe(
  store: EnhanceStore,
  flowId: string | null | undefined,
  entry: Omit<FlowBoardEntry, "seq" | "eventId" | "flowId" | "createdAt">,
): FlowBoardEntry | null {
  if (!flowId || store.isClosed()) return null;
  try {
    return store.appendFlowBoardEvent(flowId, entry);
  } catch {
    return null;
  }
}

export function renderBoardContextForNode(input: {
  store: EnhanceStore;
  flowId: string | null | undefined;
  nodeSpec: FlowNodeSpec;
  maxChars?: number;
}): string {
  const { store, flowId, nodeSpec } = input;
  if (!flowId || store.isClosed()) return "";
  const all = store.listFlowBoardEvents(flowId, { limit: 80 });
  if (all.length === 0) return "";
  const depSet = new Set(nodeSpec.dependsOn);
  const relevant = all.filter((e) => {
    if (e.kind === "brief") return false;
    if (e.target === nodeSpec.id || (nodeSpec.role && e.target === nodeSpec.role)) return true;
    if (e.nodeId && depSet.has(e.nodeId)) return true;
    return e.kind === "finding" || e.kind === "gate_result" || e.kind === "merge_result" || e.kind === "repair_feedback";
  });
  if (relevant.length === 0) return "";

  const budget = input.maxChars ?? DEFAULT_MAX_BOARD_CHARS;
  const lines: string[] = [];
  let used = 0;
  for (const e of relevant.slice(-24)) {
    const to = e.target && e.target !== "all" ? ` → @${e.target}` : "";
    const row = `#${e.seq ?? "?"} [${e.kind}] ${e.speaker}${to}: ${e.text.replace(/\s+/g, " ").trim()}`;
    const clipped = row.length > 320 ? `${row.slice(0, 319)}…` : row;
    if (used + clipped.length + 1 > budget) break;
    lines.push(clipped);
    used += clipped.length + 1;
  }
  return lines.length > 0 ? ["Shared Flow Board (recent verified findings & signals):", ...lines].join("\n") : "";
}
