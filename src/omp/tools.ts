import { canRoleDelegateTo, canRoleUseCompanionTool } from "../core/policy.ts";
import { normalizeUsageSummary } from "../core/settings.ts";
import type { EnhanceStore } from "../core/store.ts";
import type {
  EnhanceSettings, EpistemicKind, EpistemicStatus, HandoffVerdict, Mandate, MandateStatus,
  ReworkCategory, RoleSpec, UsageSummary, VerificationScope, VerifiedFact,
} from "../core/types.ts";
import { BoundaryViolationError, createAndVerifyHandoff } from "../flow/handoff.ts";
import { executeRoleStep, type RoleStepContext, type RoleSupervisorConfig } from "../flow/orchestrator.ts";
import { cancelJob, readJobLogTail, reconcileJobs, startBackgroundJob } from "../jobs/runner.ts";
import { watchBackgroundJob, type SupervisorInspector } from "../jobs/supervisor.ts";
import { registerFlowTool } from "./flow-tool.ts";
import type { WorkspaceHub } from "./hub.ts";
import type { ForegroundWorkflowController } from "./workflow-fg.ts";
import type { WorkspaceRuntime } from "./workspace.ts";
export type { WorkspaceRuntime };

const EPISTEMIC_KINDS: readonly EpistemicKind[] = ["fact", "hypothesis", "inquiry", "decision"];
const EPISTEMIC_STATUSES: readonly EpistemicStatus[] = ["open", "verified", "falsified", "deferred"];
const MANDATE_STATUSES: readonly MandateStatus[] = ["active", "completed", "archived"];
const VERDICTS: readonly HandoffVerdict[] = ["ready", "needs_input", "rejected", "blocked"];
const REWORK_CATEGORIES: readonly ReworkCategory[] = ["goal_revision", "artifact_fix", "rubric_revision"];

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const asStringArray = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((it): it is string => typeof it === "string" && it.trim().length > 0);
  return items.length > 0 ? items : undefined;
};
const asVerifiedFacts = (v: unknown): VerifiedFact[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const facts = v.flatMap((it): VerifiedFact[] => {
    if (typeof it !== "object" || it === null) return [];
    const r = it as Record<string, unknown>, claim = asString(r.claim), evidenceRef = asString(r.evidenceRef);
    return claim && evidenceRef ? [{ claim, evidenceRef }] : [];
  });
  return facts.length > 0 ? facts : undefined;
};

export function parseVerificationScopeParam(v: unknown): VerificationScope | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const checked = asStringArray(r.checked) ?? [];
  const unchecked = asStringArray(r.unchecked);
  const environmentGaps = asStringArray(r.environmentGaps);
  if (checked.length === 0 && !unchecked && !environmentGaps) return undefined;
  return { checked, ...(unchecked ? { unchecked } : {}), ...(environmentGaps ? { environmentGaps } : {}) };
}

export function parseReworkCategoryParam(v: unknown): ReworkCategory | undefined {
  const s = asString(v);
  return s && REWORK_CATEGORIES.includes(s as ReworkCategory) ? (s as ReworkCategory) : undefined;
}

export function schemaKit(pi: any) {
  const T = pi?.typebox?.Type;
  const opt = (v: unknown): unknown => (!T?.Optional ? v : (T.Union && T.Null ? T.Optional(T.Union([v, T.Null()])) : T.Optional(v)));
  return {
    str: (): unknown => (T?.String ? T.String() : { type: "string" }),
    num: (): unknown => (T?.Number ? T.Number() : { type: "number" }),
    bool: (): unknown => (T?.Boolean ? T.Boolean() : { type: "boolean" }),
    arr: (item: unknown): unknown => (T?.Array ? T.Array(item) : { type: "array", items: item }),
    en: (values: readonly string[]): unknown => (T?.Union ? T.Union(values.map((v: string) => T.Literal(v))) : { type: "string", enum: values }),
    anyOf: (variants: readonly unknown[]): unknown => (T?.Union ? T.Union([...variants]) : { anyOf: [...variants] }),
    rec: (value: unknown): unknown => (T?.Record ? T.Record(T.String(), value) : { type: "object", additionalProperties: value }),
    obj: (props: Record<string, unknown>, req: string[]): unknown =>
      T?.Object
        ? T.Object(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, req.includes(k) ? v : opt(v)])), { additionalProperties: false })
        : { type: "object", properties: props, required: req, additionalProperties: false },
  };
}

function extractForegroundUsage(ctx: any): UsageSummary | null {
  const direct = normalizeUsageSummary(ctx?.getLastAssistantMessage?.()?.usage);
  if (direct) return direct;
  const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i], msg = e?.type === "message" ? e.message : e;
    const u = msg?.role === "assistant" && msg?.usage ? normalizeUsageSummary(msg.usage) : null;
    if (u) return u;
  }
  return null;
}

const toolResult = (payload: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) });
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
      idempotencyKey: asString(input.params.idempotencyKey),
    });
    if (!job.reused) input.onJobStarted?.(job.jobId);
    return { job, ...(job.reused ? { reused: true } : {}) };
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
      ? startBackgroundJob({
          store: input.store, cwd: input.cwd, command,
          mandateId: asString(input.params.mandateId) ?? input.defaultMandateId ?? null,
          hypothesisId: asString(input.params.hypothesisId),
          idempotencyKey: asString(input.params.idempotencyKey),
        })
      : null;
    if (!job) throw new Error(jobId ? `Unknown jobId "${jobId}".` : "enhance_job watch requires a jobId or command.");
    if (!jobId && !job.reused) input.onJobStarted?.(job.jobId);
    const supEnabled = input.settings.supervisorEnabled !== false && Boolean(input.supervisor);
    const delaySec = typeof input.params.initialDelaySec === "number" && Number.isFinite(input.params.initialDelaySec)
      ? Math.max(0, input.params.initialDelaySec) : input.settings.supervisorInitialDelaySec;
    const result = await watchBackgroundJob({
      store: input.store, jobId: job.jobId, supervisorEnabled: supEnabled,
      ...(supEnabled && input.supervisor ? { supervisorRole: input.supervisor.role, inspector: input.supervisor.inspector as SupervisorInspector } : {}),
      goal: asString(input.params.goal) ?? input.defaultGoal ?? job.command,
      initialDelayMs: delaySec * 1000, signal: input.signal,
    });
    return { started: !jobId && !job.reused, ...(job.reused ? { reused: true } : {}), ...result };
  }
  throw new Error(`Unknown enhance_job action "${action}".`);
}

export function buildStageCompanionTools(
  pi: any, stepCtx: RoleStepContext, settings: EnhanceSettings, onJobStarted?: (jobId: string) => void,
): any[] {
  const kit = schemaKit(pi);
  const tools: any[] = [{
    name: "enhance_mandate", label: "Stage Mandate, Epistemic & Flow Board", loadMode: "essential",
    description: "Read the active Mandate, update epistemic-board items, or post/read shared Flow Board findings inside this stage.",
    parameters: kit.obj({
      action: kit.en(["set", "get", "add_item", "update_item", "post_board", "read_board"]), goal: kit.str(),
      constraints: kit.arr(kit.str()), acceptance: kit.arr(kit.str()),
      status: kit.en([...MANDATE_STATUSES, ...EPISTEMIC_STATUSES]), kind: kit.en(EPISTEMIC_KINDS),
      statement: kit.str(), evidenceRef: kit.str(), verificationPlan: kit.str(), itemId: kit.str(),
      text: kit.str(), target: kit.str(), afterSeq: kit.num(), limit: kit.num(),
    }, ["action"]),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const action = asString(params.action);
        if (action === "post_board") {
          const text = asString(params.text) ?? asString(params.statement);
          if (!text) throw new Error("enhance_mandate post_board requires non-empty text.");
          if (!stepCtx.flowId) throw new Error("post_board is only available inside an active Flow.");
          const entry = stepCtx.store.appendFlowBoardEvent(stepCtx.flowId, {
            nodeId: stepCtx.nodeId ?? stepCtx.role.id, kind: "finding",
            speaker: stepCtx.nodeId ?? stepCtx.role.id, target: asString(params.target) ?? "all", text,
          });
          return toolResult({ entry });
        }
        if (action === "read_board") {
          if (!stepCtx.flowId) return toolResult({ entries: [] });
          const entries = stepCtx.store.listFlowBoardEvents(stepCtx.flowId, {
            afterSeq: typeof params.afterSeq === "number" ? params.afterSeq : undefined,
            limit: typeof params.limit === "number" ? params.limit : 30,
          });
          return toolResult({ entries });
        }
        return toolResult(executeMandateParams(stepCtx.store, params, { lockedMandate: stepCtx.mandate }));
      }
      catch (err) { return toolError(err); }
    },
  }];
  if (canRoleUseCompanionTool(stepCtx.role, "enhance_job", "start").allowed) {
    tools.push({
      name: "enhance_job", label: "Stage Background Job", loadMode: "essential", approval: "exec",
      description: "Start, watch, list, reconcile, tail, or cancel background jobs inside this stage.",
      parameters: kit.obj({
        action: kit.en(["start", "watch", "list", "reconcile", "tail", "cancel"]),
        command: kit.str(), jobId: kit.str(), mandateId: kit.str(), hypothesisId: kit.str(),
        idempotencyKey: kit.str(), initialDelaySec: kit.num(), goal: kit.str(),
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

export function registerEnhanceTools(pi: any, hub: WorkspaceHub, fgWorkflow?: ForegroundWorkflowController): void {
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
    description: "Set or read the active Mandate, and add/update epistemic-board items (optionally scoped to cwd).",
    parameters: kit.obj({
      action: kit.en(["set", "get", "add_item", "update_item"]), cwd: kit.str(), goal: kit.str(),
      constraints: kit.arr(kit.str()), acceptance: kit.arr(kit.str()), mandateId: kit.str(),
      status: kit.en([...MANDATE_STATUSES, ...EPISTEMIC_STATUSES]), kind: kit.en(EPISTEMIC_KINDS),
      statement: kit.str(), evidenceRef: kit.str(), verificationPlan: kit.str(), itemId: kit.str(),
    }, ["action"]),
    async execute(params, ctx) {
      try {
        const originWs = hub.getWorkspace(ctx), ws = hub.resolveTargetWorkspace(originWs, asString(params.cwd), ctx);
        return toolResult({ cwd: ws.cwd, ...executeMandateParams(ws.store, params, { sessionId: originWs.getSessionId(ctx) }) });
      } catch (err) { return toolError(err); }
    },
  });

  registerTool({
    name: "enhance_handoff", label: "Enhance Handoff",
    description: "Create a verified HandoffEnvelope for the active role; optionally delegate immediately.",
    parameters: kit.obj({
      verdict: kit.en(VERDICTS), summary: kit.str(), toTarget: kit.str(), artifactPaths: kit.arr(kit.str()),
      verifiedFacts: kit.arr(kit.obj({ claim: kit.str(), evidenceRef: kit.str() }, ["claim", "evidenceRef"])),
      verificationScope: kit.obj({ checked: kit.arr(kit.str()), unchecked: kit.arr(kit.str()), environmentGaps: kit.arr(kit.str()) }, ["checked"]),
      reworkCategory: kit.en(REWORK_CATEGORIES),
      openRisks: kit.arr(kit.str()), questionsForUser: kit.arr(kit.str()),
      feedbackForUpstream: kit.str(), delegateNow: kit.bool(),
    }, ["verdict", "summary"]),
    async execute(params, ctx, signal) {
      try {
        const ws = hub.getWorkspace(ctx); ws.refresh(ctx);
        const active = ws.getActiveRole(ctx), role = active ?? ws.roles.get("dev");
        if (!role) throw new Error("No active role and no builtin fallback role available.");
        const handoffPerm = canRoleUseCompanionTool(active, "enhance_handoff");
        if (!handoffPerm.allowed) throw new Error(handoffPerm.reason);
        const verdict = asString(params.verdict), summary = asString(params.summary);
        if (!verdict || !VERDICTS.includes(verdict as HandoffVerdict)) {
          throw new Error("enhance_handoff requires verdict ready|needs_input|rejected|blocked.");
        }
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
              suggestion: "Automatic delegation is disabled (flowRoutingMode=manual). Enable auto or ask in /settings → Plugins → omp-enhance.",
            });
          }
        }

        const sid = ws.getSessionId(ctx), tracker = ws.trackers.get(sid), mandate = ws.store.getActiveMandate({ sessionId: sid });
        const fgPhase = !targetRole ? fgWorkflow?.getActivePhaseContext(sid, ws.cwd, role, mandate?.goal) : null;
        const effectiveRole = fgPhase?.effectiveRole ?? role;
        const envelope = createAndVerifyHandoff({
          store: ws.store, role: effectiveRole, cwd: ws.cwd, mandate, sessionId: sid, toTarget,
          parentHandoffId: mandate ? ws.store.getLatestHandoff(mandate.id)?.id ?? null : null,
          verdict: verdict as HandoffVerdict, summary, artifactPaths: asStringArray(params.artifactPaths),
          baselineSnapshot: tracker.getBaselineSnapshot(ws.cwd), baselineConfigSnapshot: tracker.getBaselineConfigSnapshot(ws.cwd),
          observedCalls: tracker.getObservedCalls(), verifiedFacts: asVerifiedFacts(params.verifiedFacts),
          verificationScope: parseVerificationScopeParam(params.verificationScope),
          reworkCategory: parseReworkCategoryParam(params.reworkCategory),
          openRisks: asStringArray(params.openRisks), questionsForUser: asStringArray(params.questionsForUser),
          feedbackForUpstream: asString(params.feedbackForUpstream), observedUsage: extractForegroundUsage(ctx),
          isConsultation: Boolean(targetRole),
        });

        if (wantDelegate && targetRole) {
          const delegated = await executeRoleStep({
            cwd: ws.cwd, store: ws.store, role: targetRole, upstreamHandoff: envelope,
            mandate: ws.store.getMandate(envelope.mandateId)!, toTarget: active?.id ?? "user",
            runner: ws.runnerFor(ctx), supervisor: ws.supervisorFor(ctx), signal,
          });
          return toolResult({ handoff: envelope, delegated }, !delegated.ok);
        }
        if (fgPhase && fgWorkflow) {
          const prog = fgWorkflow.onPhaseHandoff({ sessionId: sid, cwd: ws.cwd, role, handoff: envelope });
          if (prog.gateError) {
            return toolResult({
              handoff: envelope, error: prog.gateError, phaseAdvanced: false,
              ...(prog.cancelled ? { cancelled: true } : {}),
              ...(prog.held ? { held: true } : {}),
            }, true);
          }
          return toolResult({ handoff: envelope, workflowProgress: prog });
        }
        return toolResult({ handoff: envelope });
      } catch (error) {
        if (error instanceof BoundaryViolationError) return toolResult({ error: error.message, status: "violation", violations: error.violations }, true);
        return toolError(error);
      }
    },
  });

  registerFlowTool(registerTool, kit, hub);

  registerTool({
    name: "enhance_job", label: "Enhance Job", approval: "exec",
    description: "Start, watch with adaptive supervision, list, reconcile, tail, or cancel background jobs (optionally scoped to cwd).",
    parameters: kit.obj({
      action: kit.en(["start", "watch", "list", "reconcile", "tail", "cancel"]),
      cwd: kit.str(), command: kit.str(), jobId: kit.str(), mandateId: kit.str(),
      hypothesisId: kit.str(), idempotencyKey: kit.str(), initialDelaySec: kit.num(), goal: kit.str(),
    }, ["action"]),
    async execute(params, ctx, signal) {
      try {
        const originWs = hub.getWorkspace(ctx); originWs.refresh(ctx);
        const reqCwd = asString(params.cwd), reqJobId = asString(params.jobId), action = asString(params.action);
        const targetWs = reqCwd
          ? hub.resolveTargetWorkspace(originWs, reqCwd, ctx)
          : (reqJobId ? (hub.findWorkspaceByJobId(reqJobId) ?? originWs) : originWs);
        targetWs.refresh(ctx);
        if ((action === "list" || action === "reconcile") && !reqCwd && hub.listWorkspaces().length > 1) {
          const perm = canRoleUseCompanionTool(originWs.getActiveRole(ctx), "enhance_job", action);
          if (!perm.allowed) throw new Error(perm.reason);
          return toolResult({ jobs: hub.getAllJobs() });
        }
        const sid = originWs.getSessionId(ctx), activeMandate = targetWs.store.getActiveMandate({ sessionId: sid });
        const res = await executeJobParams({
          store: targetWs.store, cwd: targetWs.cwd, role: originWs.getActiveRole(ctx), params, settings: targetWs.settings,
          supervisor: targetWs.supervisorFor(ctx), defaultMandateId: activeMandate?.id ?? null, defaultGoal: activeMandate?.goal, signal,
        });
        hub.syncGlobalUi(ctx, originWs);
        return toolResult(res);
      } catch (error) { return toolError(error); }
    },
  });
}
