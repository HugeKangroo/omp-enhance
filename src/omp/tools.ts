import { canRoleDelegateTo, canRoleUseCompanionTool } from "../core/policy.ts";
import { normalizeUsageSummary } from "../core/settings.ts";
import type { EnhanceStore } from "../core/store.ts";
import type {
  EnhanceSettings, EpistemicKind, EpistemicStatus, FlowRunResult, HandoffEnvelope,
  HandoffVerdict, Mandate, MandateStatus, RoleSpec, UsageSummary, VerifiedFact,
} from "../core/types.ts";
import { BoundaryViolationError, createAndVerifyHandoff } from "../flow/handoff.ts";
import { executeRoleStep, type RoleSessionRunner, type RoleStepContext, type RoleSupervisorConfig } from "../flow/orchestrator.ts";
import type { FlowRoomManager } from "../flow/state.ts";
import type { SessionTrackerRegistry } from "../flow/tracker.ts";
import { cancelJob, readJobLogTail, reconcileJobs, startBackgroundJob } from "../jobs/runner.ts";
import { watchBackgroundJob, type SupervisorInspector } from "../jobs/supervisor.ts";

export interface WorkspaceRuntime {
  cwd: string; globalRolesDir: string; builtinRolesDir?: string;
  store: EnhanceStore; trackers: SessionTrackerRegistry; room: FlowRoomManager;
  roles: Map<string, RoleSpec>; settings: EnhanceSettings;
  getSessionId(ctx: any): string;
  getSessionRoleId(ctx: any): string | null;
  getActiveRole(ctx: any): RoleSpec | null;
  applyActiveRole(roleId: string | null, ctx: any, persistToSession?: boolean): Promise<void>;
  refresh(ctx?: any): Map<string, RoleSpec>;
  syncStatusBar(ctx: any): void;
  runnerFor(ctx: any): RoleSessionRunner;
  supervisorFor(ctx: any): RoleSupervisorConfig | undefined;
  emitMessage(ctx: any, text: string, options?: { excludeFromContext?: boolean }): void;
  startManagedFlow(input: {
    ctx: any; flowId?: string; roles: RoleSpec[]; mandate: Mandate;
    initialHandoff: HandoffEnvelope | null; maxRepairRounds: number;
    background: boolean; initiatorText?: string; signal?: AbortSignal;
  }): Promise<{ started: true; flowId: string; background: true; status: "running"; roleChain: string[]; goal: string } | FlowRunResult>;
  resumeManagedFlow(
    ctx: any, background: boolean, signal?: AbortSignal,
  ): Promise<{ resumed: true; flowId: string; startIndex: number; background: true; status: "running"; roleChain: string[] } | FlowRunResult>;
  dispatchFollowUpFromRoom(ctx: any, rawText: string): Promise<void>;
}

const EPISTEMIC_KINDS: readonly EpistemicKind[] = ["fact", "hypothesis", "inquiry", "decision"];
const EPISTEMIC_STATUSES: readonly EpistemicStatus[] = ["open", "verified", "falsified", "deferred"];
const MANDATE_STATUSES: readonly MandateStatus[] = ["active", "completed", "archived"];
const VERDICTS: readonly HandoffVerdict[] = ["ready", "rejected", "blocked"];

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}
function asVerifiedFacts(value: unknown): VerifiedFact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const facts = value.flatMap((item): VerifiedFact[] => {
    if (typeof item !== "object" || item === null) return [];
    const r = item as Record<string, unknown>, claim = asString(r.claim), evidenceRef = asString(r.evidenceRef);
    return claim && evidenceRef ? [{ claim, evidenceRef }] : [];
  });
  return facts.length > 0 ? facts : undefined;
}

export function schemaKit(pi: any) {
  const T = pi?.typebox?.Type;
  const opt = (v: unknown): unknown => {
    if (!T?.Optional) return v;
    return T.Union && T.Null ? T.Optional(T.Union([v, T.Null()])) : T.Optional(v);
  };
  return {
    str: (): unknown => (T?.String ? T.String() : { type: "string" }),
    num: (): unknown => (T?.Number ? T.Number() : { type: "number" }),
    bool: (): unknown => (T?.Boolean ? T.Boolean() : { type: "boolean" }),
    arr: (item: unknown): unknown => (T?.Array ? T.Array(item) : { type: "array", items: item }),
    en: (values: readonly string[]): unknown =>
      T?.Union ? T.Union(values.map((v: string) => T.Literal(v))) : { type: "string", enum: values },
    obj: (props: Record<string, unknown>, req: string[]): unknown =>
      T?.Object
        ? T.Object(
            Object.fromEntries(Object.entries(props).map(([k, v]) => [k, req.includes(k) ? v : opt(v)])),
            { additionalProperties: false },
          )
        : { type: "object", properties: props, required: req, additionalProperties: false },
  };
}

function extractForegroundUsage(ctx: any): UsageSummary | null {
  const direct = normalizeUsageSummary(ctx?.getLastAssistantMessage?.()?.usage);
  if (direct) return direct;
  const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i], msg = e?.type === "message" ? e.message : e;
    if (msg?.role === "assistant" && msg?.usage) {
      const u = normalizeUsageSummary(msg.usage);
      if (u) return u;
    }
  }
  return null;
}

const toolResult = (payload: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}),
});
const toolError = (error: unknown) => toolResult({ error: error instanceof Error ? error.message : String(error) }, true);

function executeMandateParams(
  store: EnhanceStore, params: Record<string, unknown>, scope?: { sessionId?: string | null; lockedMandate?: Mandate },
) {
  const action = asString(params.action) ?? "get";
  if (action === "get") {
    const mandate = scope?.lockedMandate
      ? (store.getMandate(scope.lockedMandate.id) ?? scope.lockedMandate)
      : store.getActiveMandate({ sessionId: scope?.sessionId });
    return { mandate, epistemicItems: mandate ? store.listEpistemicItems(mandate.id) : [] };
  }
  if (action === "set") {
    const goal = asString(params.goal) ?? scope?.lockedMandate?.goal;
    if (!goal) throw new Error("enhance_mandate set requires a goal.");
    const status = asString(params.status);
    if (status && !MANDATE_STATUSES.includes(status as MandateStatus)) throw new Error(`Invalid mandate status "${status}".`);
    const mandateId = scope?.lockedMandate?.id ?? asString(params.mandateId);
    const mandate = store.upsertMandate({
      ...(mandateId ? { id: mandateId } : {}),
      ...(scope?.sessionId && !scope?.lockedMandate ? { sessionId: scope.sessionId } : {}),
      goal, constraints: asStringArray(params.constraints), acceptance: asStringArray(params.acceptance),
      ...(status ? { status: status as MandateStatus } : {}),
    });
    return { mandate, epistemicItems: store.listEpistemicItems(mandate.id) };
  }
  if (action === "add_item") {
    const mandateId = scope?.lockedMandate?.id ?? asString(params.mandateId) ?? store.getActiveMandate({ sessionId: scope?.sessionId })?.id;
    if (!mandateId) throw new Error("enhance_mandate add_item requires an active mandate.");
    const kind = asString(params.kind), statement = asString(params.statement), status = asString(params.status);
    if (!kind || !EPISTEMIC_KINDS.includes(kind as EpistemicKind)) throw new Error("add_item requires kind fact|hypothesis|inquiry|decision.");
    if (!statement) throw new Error("enhance_mandate add_item requires a statement.");
    if (status && !EPISTEMIC_STATUSES.includes(status as EpistemicStatus)) throw new Error(`Invalid epistemic status "${status}".`);
    return {
      item: store.addEpistemicItem({
        mandateId, kind: kind as EpistemicKind, statement,
        evidenceRef: asString(params.evidenceRef), verificationPlan: asString(params.verificationPlan),
        ...(status ? { status: status as EpistemicStatus } : {}),
      }),
    };
  }
  if (action === "update_item") {
    const itemId = asString(params.itemId), status = asString(params.status);
    if (!itemId || !status || !EPISTEMIC_STATUSES.includes(status as EpistemicStatus)) throw new Error("update_item requires itemId and a valid status.");
    return { item: store.updateEpistemicStatus(itemId, status as EpistemicStatus, asString(params.evidenceRef)) };
  }
  throw new Error(`Unknown enhance_mandate action "${action}".`);
}

async function executeJobParams(input: {
  store: EnhanceStore; cwd: string; role: RoleSpec | null; params: Record<string, unknown>;
  settings: EnhanceSettings; supervisor?: RoleSupervisorConfig;
  defaultMandateId?: string | null; defaultGoal?: string; signal?: AbortSignal;
  onJobStarted?: (jobId: string) => void;
}) {
  const action = asString(input.params.action);
  const perm = canRoleUseCompanionTool(input.role, "enhance_job", action ?? "start");
  if (!perm.allowed) throw new Error(perm.reason);

  if (action === "start") {
    const command = asString(input.params.command);
    if (!command) throw new Error("enhance_job start requires a command.");
    const job = startBackgroundJob({
      store: input.store, cwd: input.cwd, command,
      mandateId: asString(input.params.mandateId) ?? input.defaultMandateId ?? null,
      hypothesisId: asString(input.params.hypothesisId),
    });
    input.onJobStarted?.(job.jobId);
    return { job };
  }
  if (action === "list" || action === "reconcile") { reconcileJobs(input.store); return { jobs: input.store.listJobs() }; }
  if (action === "tail") {
    reconcileJobs(input.store);
    const job = asString(input.params.jobId) ? input.store.getJob(asString(input.params.jobId)!) : null;
    if (!job) throw new Error("enhance_job tail requires a known jobId.");
    return { job, tail: readJobLogTail(job) };
  }
  if (action === "cancel") {
    const jobId = asString(input.params.jobId);
    if (!jobId) throw new Error("enhance_job cancel requires a jobId.");
    return { job: cancelJob(input.store, jobId) };
  }
  if (action === "watch") {
    const jobId = asString(input.params.jobId), command = asString(input.params.command);
    const job = jobId ? input.store.getJob(jobId) : command
      ? startBackgroundJob({ store: input.store, cwd: input.cwd, command, mandateId: asString(input.params.mandateId) ?? input.defaultMandateId ?? null, hypothesisId: asString(input.params.hypothesisId) })
      : null;
    if (!job) throw new Error(jobId ? `Unknown jobId "${jobId}".` : "enhance_job watch requires a jobId or command.");
    if (!jobId) input.onJobStarted?.(job.jobId);
    const supEnabled = input.settings.supervisorEnabled !== false && Boolean(input.supervisor);
    const delaySec = typeof input.params.initialDelaySec === "number" && Number.isFinite(input.params.initialDelaySec)
      ? Math.max(0, input.params.initialDelaySec) : input.settings.supervisorInitialDelaySec;
    const result = await watchBackgroundJob({
      store: input.store, jobId: job.jobId, supervisorEnabled: supEnabled,
      ...(supEnabled && input.supervisor ? { supervisorRole: input.supervisor.role, inspector: input.supervisor.inspector as SupervisorInspector } : {}),
      goal: asString(input.params.goal) ?? input.defaultGoal ?? job.command,
      initialDelayMs: delaySec * 1000, signal: input.signal,
    });
    return { started: !jobId, ...result };
  }
  throw new Error(`Unknown enhance_job action "${action}".`);
}

export function buildStageCompanionTools(
  pi: any,
  stepCtx: RoleStepContext,
  settings: EnhanceSettings,
  onJobStarted?: (jobId: string) => void,
): any[] {
  const kit = schemaKit(pi);
  const tools: any[] = [{
    name: "enhance_mandate", label: "Stage Mandate & Epistemic Board", loadMode: "essential",
    description: "Read the active Mandate or add/update epistemic-board items inside this stage.",
    parameters: kit.obj({
      action: kit.en(["set", "get", "add_item", "update_item"]), goal: kit.str(),
      constraints: kit.arr(kit.str()), acceptance: kit.arr(kit.str()),
      status: kit.en([...MANDATE_STATUSES, ...EPISTEMIC_STATUSES]), kind: kit.en(EPISTEMIC_KINDS),
      statement: kit.str(), evidenceRef: kit.str(), verificationPlan: kit.str(), itemId: kit.str(),
    }, ["action"]),
    async execute(_id: string, params: Record<string, unknown>) {
      try { return toolResult(executeMandateParams(stepCtx.store, params, { lockedMandate: stepCtx.mandate })); }
      catch (err) { return toolError(err); }
    },
  }];
  if (canRoleUseCompanionTool(stepCtx.role, "enhance_job", "start").allowed) {
    tools.push({
      name: "enhance_job", label: "Stage Background Job", loadMode: "essential", approval: "exec",
      description: "Start, watch, list, reconcile, tail, or cancel background jobs inside this stage.",
      parameters: kit.obj({
        action: kit.en(["start", "watch", "list", "reconcile", "tail", "cancel"]),
        command: kit.str(), jobId: kit.str(), mandateId: kit.str(), hypothesisId: kit.str(), initialDelaySec: kit.num(), goal: kit.str(),
      }, ["action"]),
      async execute(_id: string, params: Record<string, unknown>, toolSignal?: unknown) {
        try {
          const sig = toolSignal instanceof AbortSignal ? toolSignal : stepCtx.signal;
          return toolResult(await executeJobParams({
            store: stepCtx.store, cwd: stepCtx.cwd, role: stepCtx.role, params, settings,
            supervisor: stepCtx.supervisor, defaultMandateId: stepCtx.mandate.id, defaultGoal: stepCtx.mandate.goal,
            signal: sig, onJobStarted,
          }));
        } catch (err) { return toolError(err); }
      },
    });
  }
  return tools;
}

export function registerEnhanceTools(pi: any, getWorkspace: (ctx: any) => WorkspaceRuntime): void {
  const kit = schemaKit(pi);
  const registerTool = (input: {
    name: string; label: string; description: string; approval?: "read" | "write" | "exec"; parameters: unknown;
    execute: (params: Record<string, unknown>, ctx: any, signal?: AbortSignal) => Promise<unknown>;
  }): void => {
    pi.registerTool({
      name: input.name, label: input.label, description: input.description,
      loadMode: "essential", ...(input.approval ? { approval: input.approval } : {}), parameters: input.parameters,
      execute: (_id: string, params: Record<string, unknown>, signal: unknown, _onUpdate: unknown, ctx: any) =>
        input.execute(params, ctx, signal instanceof AbortSignal ? signal : undefined),
    });
  };

  registerTool({
    name: "enhance_mandate", label: "Enhance Mandate",
    description: "Set or read the active Mandate, and add/update epistemic-board items.",
    parameters: kit.obj({
      action: kit.en(["set", "get", "add_item", "update_item"]), goal: kit.str(),
      constraints: kit.arr(kit.str()), acceptance: kit.arr(kit.str()), mandateId: kit.str(),
      status: kit.en([...MANDATE_STATUSES, ...EPISTEMIC_STATUSES]), kind: kit.en(EPISTEMIC_KINDS),
      statement: kit.str(), evidenceRef: kit.str(), verificationPlan: kit.str(), itemId: kit.str(),
    }, ["action"]),
    async execute(params, ctx) {
      try { const ws = getWorkspace(ctx); return toolResult(executeMandateParams(ws.store, params, { sessionId: ws.getSessionId(ctx) })); }
      catch (err) { return toolError(err); }
    },
  });

  registerTool({
    name: "enhance_handoff", label: "Enhance Handoff",
    description: "Create a verified HandoffEnvelope for the active role; optionally delegate immediately.",
    parameters: kit.obj({
      verdict: kit.en(VERDICTS), summary: kit.str(), toTarget: kit.str(), artifactPaths: kit.arr(kit.str()),
      verifiedFacts: kit.arr(kit.obj({ claim: kit.str(), evidenceRef: kit.str() }, ["claim", "evidenceRef"])),
      openRisks: kit.arr(kit.str()), feedbackForUpstream: kit.str(), delegateNow: kit.bool(),
    }, ["verdict", "summary"]),
    async execute(params, ctx, signal) {
      try {
        const ws = getWorkspace(ctx); ws.refresh(ctx);
        const active = ws.getActiveRole(ctx), role = active ?? ws.roles.get("general") ?? ws.roles.get("dev");
        if (!role) throw new Error("No active role and no builtin fallback role available.");
        const verdict = asString(params.verdict), summary = asString(params.summary);
        if (!verdict || !VERDICTS.includes(verdict as HandoffVerdict)) throw new Error("enhance_handoff requires verdict ready|rejected|blocked.");
        if (!summary) throw new Error("enhance_handoff requires a summary.");
        const toTarget = asString(params.toTarget) ?? "user", wantDelegate = params.delegateNow === true && toTarget !== "user";
        let targetRole: RoleSpec | undefined;

        if (wantDelegate) {
          targetRole = ws.roles.get(toTarget);
          const delCheck = canRoleDelegateTo(active ?? role, targetRole);
          if (!delCheck.allowed) throw new Error(delCheck.reason ?? `Unknown delegation target role "${toTarget}".`);
          if (ws.settings.flowRoutingMode === "manual" && targetRole!.id !== "vision") {
            return toolResult({
              started: false, blockedByRoutingMode: "manual",
              suggestion: `Automatic delegation is disabled (flowRoutingMode=manual). Ask the user to run /enhance-handoff ${toTarget}`,
            });
          }
        }

        const sid = ws.getSessionId(ctx), tracker = ws.trackers.get(sid), mandate = ws.store.getActiveMandate({ sessionId: sid });
        const envelope = createAndVerifyHandoff({
          store: ws.store, role, cwd: ws.cwd, mandate, sessionId: sid, toTarget,
          parentHandoffId: mandate ? ws.store.getLatestHandoff(mandate.id)?.id ?? null : null,
          verdict: verdict as HandoffVerdict, summary, artifactPaths: asStringArray(params.artifactPaths),
          baselineSnapshot: tracker.getBaselineSnapshot(ws.cwd), baselineConfigSnapshot: tracker.getBaselineConfigSnapshot(ws.cwd),
          observedCalls: tracker.getObservedCalls(), verifiedFacts: asVerifiedFacts(params.verifiedFacts),
          openRisks: asStringArray(params.openRisks), feedbackForUpstream: asString(params.feedbackForUpstream),
          observedUsage: extractForegroundUsage(ctx),
        });

        if (wantDelegate && targetRole) {
          const delegated = await executeRoleStep({
            cwd: ws.cwd, store: ws.store, role: targetRole, upstreamHandoff: envelope,
            mandate: ws.store.getMandate(envelope.mandateId)!, toTarget: active?.id ?? "user",
            runner: ws.runnerFor(ctx), supervisor: ws.supervisorFor(ctx), signal,
          });
          return toolResult({ handoff: envelope, delegated }, !delegated.ok);
        }
        return toolResult({ handoff: envelope });
      } catch (error) {
        if (error instanceof BoundaryViolationError) return toolResult({ error: error.message, status: "violation", violations: error.violations }, true);
        return toolError(error);
      }
    },
  });

  registerTool({
    name: "enhance_flow", label: "Enhance Flow", approval: "exec",
    description: "Start, resume, inspect status, steer, or cancel a Markov-isolated multi-role collaboration Flow.",
    parameters: kit.obj({
      action: kit.en(["start", "status", "steer", "cancel", "resume"]),
      roles: kit.arr(kit.str()), goal: kit.str(), message: kit.str(),
      maxRepairRounds: kit.num(), initialHandoffId: kit.str(), wait: kit.bool(),
    }, []),
    async execute(params, ctx, signal) {
      try {
        const ws = getWorkspace(ctx); ws.refresh(ctx);
        const action = asString(params.action) ?? "start", activeRole = ws.getActiveRole(ctx);
        if (action === "status") return toolResult({ ...ws.room.getSnapshot(), resumable: ws.room.isResumable() });
        if (action === "cancel") { const cancelled = await ws.room.cancelActiveFlow(ctx); ws.syncStatusBar(ctx); return toolResult({ cancelled, status: ws.room.getSnapshot().status }); }
        if (action === "resume") {
          const perm = canRoleUseCompanionTool(activeRole, "enhance_flow", "resume");
          if (!perm.allowed) throw new Error(perm.reason);
          const background = params.wait === true ? false : Boolean(ctx?.hasUI);
          return toolResult(await ws.resumeManagedFlow(ctx, background, background ? undefined : signal));
        }
        if (action === "steer") {
          const perm = canRoleUseCompanionTool(activeRole, "enhance_flow", "steer");
          if (!perm.allowed) throw new Error(perm.reason);
          const msg = asString(params.message) ?? asString(params.goal);
          if (!msg) throw new Error("enhance_flow steer requires a message.");
          const res = await ws.room.postUserSteer(msg, ctx);
          return toolResult({ ok: true, ...res, status: ws.room.getSnapshot().status });
        }
        if (action !== "start") throw new Error(`Unknown enhance_flow action "${action}".`);

        const roleIds = asStringArray(params.roles);
        if (!roleIds) throw new Error("enhance_flow start requires a non-empty roles array.");
        const roles = roleIds.map((id) => {
          if (id === "supervisor") throw new Error('Role "supervisor" is an internal monitor and cannot run as a Flow stage.');
          const r = ws.roles.get(id); if (!r) throw new Error(`Unknown role "${id}".`); return r;
        });
        const perm = canRoleUseCompanionTool(activeRole, "enhance_flow", "start", roles);
        if (!perm.allowed) throw new Error(perm.reason);
        if (ws.room.isRunning()) throw new Error("已有正在运行的协作 Flow；可通过 steer 插话、/flow 查看或 cancel 取消。");

        const sid = ws.getSessionId(ctx), goal = asString(params.goal);
        const existingMandate = goal ? null : ws.store.getActiveMandate({ sessionId: sid });
        const previewGoal = goal ?? existingMandate?.goal;
        if (!previewGoal) throw new Error("enhance_flow requires a goal or an active mandate.");

        if (ws.settings.flowRoutingMode === "manual") {
          return toolResult({
            started: false, blockedByRoutingMode: "manual",
            suggestion: `Automatic Flow dispatch is disabled (flowRoutingMode=manual). Handle directly or ask the user to run: /flow ${roleIds.join(",")} ${previewGoal}`,
          });
        }
        if (ws.settings.flowRoutingMode === "ask" && ctx?.hasUI) {
          if (typeof ctx?.ui?.confirm !== "function") return toolResult({ started: false, declined: true, reason: "Interactive confirmation unavailable under flowRoutingMode=ask." });
          const ok = (await ctx.ui.confirm("启动多角色协作 Flow？", `角色链: ${roleIds.join(" → ")}\n目标: ${previewGoal}\n(可在 /settings → Plugins → omp-enhance 切换 flowRoutingMode)`)) === true;
          if (!ok) return toolResult({ started: false, declined: true, reason: "User declined multi-role Flow dispatch; continue in single-agent mode." });
        }
        if (ws.room.isRunning()) throw new Error("已有正在运行的协作 Flow；可通过 steer 插话、/flow 查看或 cancel 取消。");

        const flowId = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const mandate = goal ? ws.store.upsertMandate({ goal, flowId }) : existingMandate!;
        const initialHandoffId = asString(params.initialHandoffId);
        const initialHandoff = initialHandoffId ? ws.store.getHandoff(initialHandoffId) : (!goal ? ws.store.getLatestHandoff(mandate.id) : null);
        const maxRepairRounds = typeof params.maxRepairRounds === "number" ? params.maxRepairRounds : ws.settings.flowMaxRepairRounds;
        const background = params.wait === true ? false : Boolean(ctx?.hasUI);
        return toolResult(await ws.startManagedFlow({ ctx, flowId, roles, mandate, initialHandoff, maxRepairRounds, background, ...(background ? {} : { signal }) }));
      } catch (error) { return toolError(error); }
    },
  });

  registerTool({
    name: "enhance_job", label: "Enhance Job", approval: "exec",
    description: "Start, watch with adaptive supervision, list, reconcile, tail, or cancel background jobs.",
    parameters: kit.obj({
      action: kit.en(["start", "watch", "list", "reconcile", "tail", "cancel"]),
      command: kit.str(), jobId: kit.str(), mandateId: kit.str(), hypothesisId: kit.str(), initialDelaySec: kit.num(), goal: kit.str(),
    }, ["action"]),
    async execute(params, ctx, signal) {
      try {
        const ws = getWorkspace(ctx); ws.refresh(ctx);
        const sid = ws.getSessionId(ctx), activeMandate = ws.store.getActiveMandate({ sessionId: sid });
        return toolResult(await executeJobParams({
          store: ws.store, cwd: ws.cwd, role: ws.getActiveRole(ctx), params, settings: ws.settings,
          supervisor: ws.supervisorFor(ctx), defaultMandateId: activeMandate?.id ?? null, defaultGoal: activeMandate?.goal, signal,
        }));
      } catch (error) { return toolError(error); }
    },
  });
}
