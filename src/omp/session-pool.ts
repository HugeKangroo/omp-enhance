import type { SnapshotEntry } from "../core/fs.ts";
import type { TurnTracker } from "../core/policy.ts";
import { resolveModelSpec } from "../core/settings.ts";
import type { HandoffEnvelope } from "../core/types.ts";
import type { RoleSessionPoolLike, RoleStepContext } from "../flow/orchestrator.ts";

export interface ActiveTurnBindings {
  stepCtx: RoleStepContext;
  childTracker: TurnTracker;
  baselineSnap: ReadonlyMap<string, SnapshotEntry> | null;
  baselineConfigSnap: ReadonlyMap<string, SnapshotEntry> | null;
  stageId: string;
  stageStartedJobIds: Set<string>;
  submittedEnvelope: HandoffEnvelope | null;
  boundaryViolations: string[];
  touchActivity: () => void;
}

export interface WarmSessionHandle {
  key: string;
  flowId: string;
  nodeId: string;
  roleId: string;
  cwd: string;
  session: any;
  modelLabel: string;
  turnRef: { current: ActiveTurnBindings };
  disposed: boolean;
}

const poolKey = (flowId: string, nodeId: string): string => `${flowId}::${nodeId}`;

export function isRetryableHostError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /\b(429|500|502|503|504|529|rate[_ -]?limit|timeout|timed out|overloaded|stream|ECONNRESET|ETIMEDOUT|fetch failed|network)\b/i.test(message);
}

export function formatResolvedModelLabel(model: unknown, fallback = "default"): string {
  if (!model || typeof model !== "object") return fallback;
  const m = model as { provider?: unknown; id?: unknown };
  return m.provider && m.id ? `${String(m.provider)}/${String(m.id)}` : fallback;
}

export class FlowSessionPool implements RoleSessionPoolLike {
  private readonly handles = new Map<string, WarmSessionHandle>();

  constructor(private readonly pi?: any, private readonly hostCtx?: any) {}

  hasWarm(flowId: string, nodeId: string): boolean {
    const h = this.handles.get(poolKey(flowId, nodeId));
    return Boolean(h && !h.disposed);
  }

  getWarm(flowId: string, nodeId: string): WarmSessionHandle | null {
    const h = this.handles.get(poolKey(flowId, nodeId));
    return h && !h.disposed ? h : null;
  }

  putWarm(handle: WarmSessionHandle): void {
    const existing = this.handles.get(handle.key);
    if (existing && existing !== handle && !existing.disposed) {
      existing.disposed = true;
      void Promise.resolve(existing.session?.dispose?.()).catch(() => {});
    }
    this.handles.set(handle.key, handle);
  }

  getForkMessages(flowId: string, fromNodeId: string): any[] | null {
    const src = this.getWarm(flowId, fromNodeId);
    const msgs = src?.session?.messages;
    return Array.isArray(msgs) && msgs.length > 0 ? msgs.map((m: any) => ({ ...m })) : null;
  }

  async switchModelInPlace(
    flowId: string,
    nodeId: string,
    nextModelSpec: string,
  ): Promise<{ switched: boolean; modelLabel?: string; reason?: string }> {
    const handle = this.getWarm(flowId, nodeId);
    if (!handle) return { switched: false, reason: `No warm session found for node "${nodeId}".` };
    const hasRegistry = Boolean(this.hostCtx?.modelRegistry || this.pi?.modelRegistry);
    const resolved = hasRegistry ? resolveModelSpec(nextModelSpec, this.hostCtx, this.pi) : nextModelSpec;
    if (!resolved) return { switched: false, reason: `Could not resolve fallback model "${nextModelSpec}".` };
    try { await handle.session.abort?.(); } catch {}
    if (typeof handle.session?.setModel !== "function") {
      return { switched: false, reason: "Child session does not support in-place setModel()." };
    }
    try {
      await handle.session.setModel(resolved);
      handle.modelLabel = typeof resolved === "string" ? resolved : formatResolvedModelLabel(resolved, nextModelSpec);
      return { switched: true, modelLabel: handle.modelLabel };
    } catch (err) {
      return { switched: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async disposeNode(flowId: string, nodeId: string): Promise<void> {
    const key = poolKey(flowId, nodeId);
    const h = this.handles.get(key);
    if (!h) return;
    this.handles.delete(key);
    if (h.disposed) return;
    h.disposed = true;
    try { await h.session?.dispose?.(); } catch {}
  }

  async disposeFlow(flowId: string): Promise<void> {
    const prefix = `${flowId}::`;
    const toDispose: WarmSessionHandle[] = [];
    for (const [k, h] of this.handles) {
      if (k.startsWith(prefix)) {
        this.handles.delete(k);
        toDispose.push(h);
      }
    }
    await Promise.allSettled(
      toDispose.map(async (h) => {
        if (h.disposed) return;
        h.disposed = true;
        try { await h.session?.dispose?.(); } catch {}
      }),
    );
  }
}

export interface StallWatchdogHandle {
  touch(): void;
  wasStalled(): { idleSec: number } | null;
  stop(): void;
}

export function startStallWatchdog(input: {
  timeoutMs?: number;
  onStall: (idleSec: number) => void;
}): StallWatchdogHandle {
  const timeoutMs = input.timeoutMs ?? 0;
  let lastActivityMs = Date.now();
  let stalledInfo: { idleSec: number } | null = null;
  let stopped = false;

  if (timeoutMs <= 0) {
    return { touch: () => { lastActivityMs = Date.now(); }, wasStalled: () => null, stop: () => { stopped = true; } };
  }

  const checkEveryMs = Math.max(25, Math.min(2_000, Math.floor(timeoutMs / 4)));
  const timer = setInterval(() => {
    if (stopped || stalledInfo) return;
    const elapsedMs = Date.now() - lastActivityMs;
    if (elapsedMs >= timeoutMs) {
      stalledInfo = { idleSec: Math.max(1, Math.round(elapsedMs / 1000)) };
      stopped = true;
      clearInterval(timer);
      input.onStall(stalledInfo.idleSec);
    }
  }, checkEveryMs);
  timer.unref?.();

  return {
    touch() { if (!stopped) lastActivityMs = Date.now(); },
    wasStalled() { return stalledInfo; },
    stop() { stopped = true; clearInterval(timer); },
  };
}
