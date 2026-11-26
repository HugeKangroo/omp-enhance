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

const shortSubId = (n: FlowGraphNodeView): string =>
  n.parentGroupId && n.nodeId.startsWith(`${n.parentGroupId}__`) ? n.nodeId.slice(n.parentGroupId.length + 2) : n.nodeId;

function summarizeGroup(members: readonly FlowGraphNodeView[]): { glyph: string; status: NodeStatus; label: string } {
  const groupId = members[0]!.parentGroupId!;
  const done = members.filter((m) => m.status === "succeeded" || m.status === "skipped").length;
  const active = members.find((m) => m.status === "running" || m.status === "waiting_input");
  const bad = members.find((m) => m.status === "violation" || m.status === "failed" || m.status === "blocked");
  const status: NodeStatus = bad?.status ?? active?.status ?? (done === members.length ? "succeeded" : "pending");
  const wt = members.some((m) => m.workspace === "worktree") ? ":wt" : "";
  const activeShort = active ? `:${shortSubId(active)}` : "";
  return { glyph: nodeStatusGlyph(status), status, label: `${groupId}${wt}(${done}/${members.length}${activeShort})` };
}

export function renderWaveOverviewBar(graph: FlowGraphSnapshot, maxWidth: number, theme?: any): string {
  const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
  const byId = new Map<string, FlowGraphNodeView>(graph.nodes.map((n) => [n.nodeId, n]));
  const grouped = new Map<string, FlowGraphNodeView[]>();
  for (const n of graph.nodes) {
    if (n.parentGroupId) grouped.set(n.parentGroupId, [...(grouped.get(n.parentGroupId) ?? []), n]);
  }
  const seenGroups = new Set<string>();
  const waveEntries: Array<{ idx: number; items: Array<{ tone: string; text: string }> }> = [];

  graph.waves.forEach((wave, idx) => {
    const items: Array<{ tone: string; text: string }> = [];
    for (const id of wave) {
      const n = byId.get(id);
      if (!n) continue;
      if (n.parentGroupId) {
        if (seenGroups.has(n.parentGroupId)) continue;
        seenGroups.add(n.parentGroupId);
        const gs = summarizeGroup(grouped.get(n.parentGroupId)!);
        items.push({ tone: nodeStatusTone(gs.status), text: `${gs.glyph} ${gs.label}` });
      } else {
        const wt = n.workspace === "worktree" ? ":wt" : "";
        items.push({ tone: nodeStatusTone(n.status), text: `${nodeStatusGlyph(n.status)} ${n.nodeId}${wt}` });
      }
    }
    if (items.length > 0) waveEntries.push({ idx, items });
  });

  const plain = waveEntries.map((w, i) => `W${i}[${w.items.map((x) => x.text).join(" | ")}]`).join(" → ");
  if (plain.length <= maxWidth && typeof theme?.fg === "function") {
    return waveEntries
      .map((w, i) => `${fg("muted", `W${i}[`)}${w.items.map((x) => fg(x.tone, x.text)).join(fg("border", " | "))}${fg("muted", "]")}`)
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
  const out: string[] = [`任务图 (${graph.preset} · ${graph.waves.length} 波次 / ${graph.nodes.length} 节点):`];
  const seenGroups = new Set<string>();
  for (const n of graph.nodes) {
    if (n.parentGroupId) {
      if (seenGroups.has(n.parentGroupId)) continue;
      seenGroups.add(n.parentGroupId);
      const members = graph.nodes.filter((m) => m.parentGroupId === n.parentGroupId);
      const gs = summarizeGroup(members);
      out.push(` ${gs.glyph} ${gs.label}`);
      members.forEach((ph, idx) => {
        const branch = idx === members.length - 1 ? "└─" : "├─";
        out.push(`   ${branch} ${nodeStatusGlyph(ph.status)} ${shortSubId(ph)} (${ph.kind})`);
      });
      continue;
    }
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
  if (graph.mergedRef) {
    const sha = graph.mergedCommitSha ? ` (${graph.mergedCommitSha.slice(0, 12)})` : "";
    out.push(` 交付引用: ${graph.mergedRef}${sha}`);
  }
  return out;
}
