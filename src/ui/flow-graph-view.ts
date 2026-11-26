import type { FlowGraphNodeView, FlowGraphSnapshot, NodeStatus } from "../core/graph-types.ts";
import { truncateDisplay, wrapPlainText } from "./kit.ts";

export function nodeStatusGlyph(status: NodeStatus): string {
  if (status === "succeeded") return "✓";
  if (status === "running") return "●";
  if (status === "waiting_input") return "?";
  if (status === "retrying" || status === "invalidated") return "↺";
  if (status === "failed" || status === "violation") return "✕";
  if (status === "blocked") return "!";
  if (status === "skipped") return "↷";
  if (status === "cancelled") return "⏹";
  return "○";
}

function nodeStatusTone(status: NodeStatus): string {
  if (status === "succeeded") return "success";
  if (status === "running") return "accent";
  if (status === "waiting_input" || status === "retrying" || status === "invalidated" || status === "blocked") return "warning";
  if (status === "failed" || status === "violation") return "error";
  return "muted";
}

export function renderWaveOverviewBar(
  graph: FlowGraphSnapshot,
  maxWidth: number,
  theme?: any,
): string {
  const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
  const byId = new Map<string, FlowGraphNodeView>(graph.nodes.map((n) => [n.nodeId, n]));
  const plainParts = graph.waves.map((wave, idx) => {
    const items = wave.map((id) => {
      const n = byId.get(id);
      if (!n) return id;
      const wt = n.workspace === "worktree" ? ":wt" : "";
      return `${nodeStatusGlyph(n.status)} ${n.nodeId}${wt}`;
    });
    return `W${idx}[${items.join(" | ")}]`;
  });
  const plain = plainParts.join(" → ");
  if (plain.length <= maxWidth && typeof theme?.fg === "function") {
    return graph.waves
      .map((wave, idx) => {
        const items = wave.map((id) => {
          const n = byId.get(id);
          if (!n) return id;
          const wt = n.workspace === "worktree" ? ":wt" : "";
          return fg(nodeStatusTone(n.status), `${nodeStatusGlyph(n.status)} ${n.nodeId}${wt}`);
        });
        return `${fg("muted", `W${idx}[`)}${items.join(fg("border", " | "))}${fg("muted", "]")}`;
      })
      .join(fg("muted", " → "));
  }
  return fg("accent", truncateDisplay(plain, Math.max(12, maxWidth)));
}

export function renderConcurrentWidgetSummary(graph: FlowGraphSnapshot): string | null {
  const running = graph.nodes.filter((n) => n.status === "running");
  const waiting = graph.nodes.filter((n) => n.status === "waiting_input");
  const done = graph.nodes.filter((n) => n.status === "succeeded" || n.status === "skipped").length;
  if (running.length > 1) {
    const labels = running.map((n) => `${n.nodeId}${n.role ? `(${n.role})` : `(${n.kind})`}`).join(", ");
    return `● ${running.length} 并行中 (${done}/${graph.nodes.length}): ${labels}`;
  }
  if (waiting.length > 0) {
    return `? 待确认 (${done}/${graph.nodes.length}): ${waiting.map((n) => n.nodeId).join(", ")}`;
  }
  if (running.length === 1) {
    const n = running[0]!;
    const wt = n.workspace === "worktree" ? " [worktree]" : "";
    return `● W${n.waveIndex} ${n.nodeId} (${n.role ?? n.kind}${wt}) · ${done}/${graph.nodes.length} 完成`;
  }
  return null;
}

export function renderGraphNodeInspectorSection(graph: FlowGraphSnapshot, rightW: number): string[] {
  const out: string[] = [
    `任务图 (${graph.preset} · ${graph.waves.length} 波次 / ${graph.nodes.length} 节点):`,
  ];
  for (const n of graph.nodes) {
    const glyph = nodeStatusGlyph(n.status);
    const kindLabel = n.kind === "role" ? (n.role ?? "role") : n.kind;
    const tags: string[] = [];
    if (n.workspace === "worktree") tags.push("wt");
    if (n.sessionResidency === "warm") tags.push("warm");
    if (n.repairRound > 0) tags.push(`R${n.repairRound}`);
    if (n.triedModels.length > 1) tags.push(`切模×${n.triedModels.length - 1}`);
    const tagStr = tags.length > 0 ? ` [${tags.join(",")}]` : "";
    out.push(` ${glyph} W${n.waveIndex} ${n.nodeId} (${kindLabel})${tagStr}`);
    if (n.writableScope?.length) {
      out.push(...wrapPlainText(`   scope: ${n.writableScope.join(", ")}`, Math.max(16, rightW - 2), 2));
    }
  }
  if (graph.mergedRef) out.push(` 合流引用: ${graph.mergedRef}`);
  return out;
}
