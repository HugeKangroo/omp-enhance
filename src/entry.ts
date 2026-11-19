import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  EnhanceSettings, EpistemicKind, EpistemicStatus, HandoffVerdict, Mandate, RoleSpec, VerifiedFact,
} from "./types.ts";
import { EnhanceStore } from "./store.ts";
import { discoverRoles, renderConditioningBlock, scaffoldRoleFile } from "./role-loader.ts";
import { resolveRoleActiveTools, TurnTracker } from "./session-tracker.ts";
import { createAndVerifyHandoff } from "./handoff.ts";
import {
  createOmpRoleSessionRunner, executeRoleFlow, executeRoleStep, type RoleSessionRunner,
  type RoleSupervisorConfig,
} from "./orchestrator.ts";
import { cancelJob, readJobLogTail, reconcileJobs, startBackgroundJob } from "./jobs.ts";
import { createOmpSupervisorInspector, watchBackgroundJob } from "./supervisor.ts";
import { loadEnhanceSettings, resolveModelSpec } from "./settings.ts";
import { openRoleEditor, openRoleStudioHome, type RoleStudioDeps } from "./role-studio.ts";
export interface EnhanceOptions {
  globalRolesDir?: string;
  builtinRolesDir?: string;
  pluginLockPath?: string;
  runnerFactory?: (pi: any, ctx: any) => RoleSessionRunner;
}
interface WorkspaceState {
  cwd: string; store: EnhanceStore; tracker: TurnTracker;
  roles: Map<string, RoleSpec>; settings: EnhanceSettings; activeRoleId: string | null;
}
const EPISTEMIC_KINDS: readonly EpistemicKind[] = ["fact", "hypothesis", "inquiry", "decision"];
const EPISTEMIC_STATUSES: readonly EpistemicStatus[] = ["open", "verified", "falsified", "deferred"];
const MANDATE_STATUSES: readonly Mandate["status"][] = ["active", "completed", "archived"];
const VERDICTS: readonly HandoffVerdict[] = ["ready", "rejected", "blocked"];

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}
function asVerifiedFacts(value: unknown): VerifiedFact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const facts = value.flatMap((item): VerifiedFact[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const claim = asString(record.claim), evidenceRef = asString(record.evidenceRef);
    return claim && evidenceRef ? [{ claim, evidenceRef }] : [];
  });
  return facts.length > 0 ? facts : undefined;
}
function globalRolesDir(options: EnhanceOptions): string {
  return options.globalRolesDir ?? process.env.OMP_ENHANCE_GLOBAL_ROLES_DIR ??
    path.join(homedir(), ".omp", "enhance", "roles");
}
function schemaKit(pi: any) {
  const T = pi?.typebox?.Type;
  const opt = (value: unknown): unknown => (T?.Optional ? T.Optional(value) : value);
  return {
    str: (): unknown => (T?.String ? T.String() : { type: "string" }),
    num: (): unknown => (T?.Number ? T.Number() : { type: "number" }),
    bool: (): unknown => (T?.Boolean ? T.Boolean() : { type: "boolean" }),
    arr: (item: unknown): unknown => (T?.Array ? T.Array(item) : { type: "array", items: item }),
    en: (values: readonly string[]): unknown => (T?.Union
      ? T.Union(values.map((value: string) => T.Literal(value))) : { type: "string", enum: values }),
    obj: (properties: Record<string, unknown>, required: string[]): unknown => (T?.Object
      ? T.Object(Object.fromEntries(Object.entries(properties).map(([key, value]) => [
        key, required.includes(key) ? value : opt(value),
      ])), { additionalProperties: false })
      : { type: "object", properties, required }),
  };
}
function toolResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}
function toolError(error: unknown) {
  return toolResult({ error: error instanceof Error ? error.message : String(error) }, true);
}
export default function ompEnhance(pi: any, options: EnhanceOptions = {}): void {
  const workspaces = new Map<string, WorkspaceState>();
  const kit = schemaKit(pi);
  const discover = (cwd: string): Map<string, RoleSpec> => discoverRoles({
    cwd, globalRolesDir: globalRolesDir(options), builtinRolesDir: options.builtinRolesDir,
  });

  const loadSettings = (cwd: string): EnhanceSettings =>
    loadEnhanceSettings({ cwd, pluginLockPath: options.pluginLockPath });

  function getWorkspace(ctx: any): WorkspaceState {
    const cwd = path.resolve(ctx?.cwd ?? process.cwd());
    const existing = workspaces.get(cwd);
    if (existing) { existing.settings = loadSettings(cwd); return existing; }
    const roles = discover(cwd), settings = loadSettings(cwd);
    const initialRole = settings.defaultRole === null ? null
      : (roles.has(settings.defaultRole) ? settings.defaultRole : (roles.has("dev") ? "dev" : null));
    const state: WorkspaceState = {
      cwd, store: new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite")),
      tracker: new TurnTracker(), roles, settings, activeRoleId: initialRole,
    };
    workspaces.set(cwd, state);
    return state;
  }
  function activeRole(ws: WorkspaceState): RoleSpec | null {
    return ws.activeRoleId ? ws.roles.get(ws.activeRoleId) ?? null : null;
  }
  function refreshRoles(ws: WorkspaceState): Map<string, RoleSpec> {
    ws.roles = discover(ws.cwd);
    ws.settings = loadSettings(ws.cwd);
    return ws.roles;
  }
  function syncStatusBar(ws: WorkspaceState, ctx: any): void {
    const role = activeRole(ws);
    const badge = ws.settings.showStatusBar
      ? (role ? `enhance:${role.id}${role.model ? ` (${role.model})` : ""}` : "enhance:off")
      : undefined;
    ctx?.ui?.setStatus?.("omp-enhance", badge);
  }
  async function applyActiveRole(ws: WorkspaceState, roleId: string | null, ctx: any): Promise<void> {
    ws.activeRoleId = roleId;
    const role = activeRole(ws);
    const allNames = pi.getAllTools?.().map((tool: any) => tool.name) ?? [];
    await pi.setActiveTools?.(role ? resolveRoleActiveTools(role, allNames) : allNames);
    if (role?.model && role.model !== "inherit" && typeof pi.setModel === "function") {
      const resolved = resolveModelSpec(role.model, ctx);
      if (resolved) await pi.setModel(resolved);
    }
    if (role?.thinking && role.thinking !== "inherit" && typeof pi.setThinkingLevel === "function") {
      pi.setThinkingLevel(role.thinking);
    }
    syncStatusBar(ws, ctx);
  }
  function runnerFor(ws: WorkspaceState, ctx: any): RoleSessionRunner {
    return options.runnerFactory?.(pi, ctx) ?? createOmpRoleSessionRunner(pi, ctx, ws.settings);
  }
  function supervisorFor(ws: WorkspaceState, ctx: any, force = false): RoleSupervisorConfig | undefined {
    if (!force && !ws.settings.supervisorEnabled) return undefined;
    const role = ws.roles.get("supervisor");
    return role ? {
      role, inspector: createOmpSupervisorInspector(pi, ctx, ws.settings),
      initialDelayMs: ws.settings.supervisorInitialDelaySec * 1000,
    } : undefined;
  }
  function emitMessage(ctx: any, text: string): void {
    const outPath = process.env.OMP_ENHANCE_CMD_OUT;
    if (outPath) {
      mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      appendFileSync(outPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    }
    try {
      if (typeof pi.sendMessage === "function") {
        pi.sendMessage({ customType: "omp-enhance", content: text, display: true }, { triggerTurn: false });
      } else ctx?.ui?.notify?.(text, "info");
    } catch {
      // Headless command runs have no renderer; the command output file remains authoritative.
    }
  }
  pi.on("input", (event: any, ctx: any) => {
    const text = typeof event.text === "string" ? event.text : "";
    const match = /^\/handoff\s+(\S+)/.exec(text);
    if (!match || !getWorkspace(ctx).roles.has(match[1]!)) return undefined;
    return { text: text.replace(/^\/handoff/, "/enhance-handoff") };
  });

  pi.on("session_start", (_event: any, ctx: any) => {
    const ws = getWorkspace(ctx);
    refreshRoles(ws);
    syncStatusBar(ws, ctx);
  });

  pi.on("session_shutdown", () => {
    for (const ws of workspaces.values()) ws.store.close();
    workspaces.clear();
  });

  pi.on("before_agent_start", (event: any, ctx: any) => {
    const ws = getWorkspace(ctx);
    reconcileJobs(ws.store);
    refreshRoles(ws);
    syncStatusBar(ws, ctx);
    ws.tracker.resetTurn(ws.cwd);
    const role = activeRole(ws);
    if (!role) return;
    const mandate = ws.store.getActiveMandate();
    const block = renderConditioningBlock({ role, mandate,
      epistemicItems: mandate ? ws.store.listEpistemicItems(mandate.id) : [],
      upstreamHandoff: mandate ? ws.store.getLatestHandoff(mandate.id) : null,
    });
    const existing = Array.isArray(event.systemPrompt)
      ? event.systemPrompt : event.systemPrompt ? [event.systemPrompt] : [];
    return { systemPrompt: [...existing, block] };
  });

  pi.on("tool_call", (event: any, ctx: any) => {
    const ws = getWorkspace(ctx);
    const decision = ws.tracker.checkToolCallAllowed(ws.cwd, activeRole(ws), {
      toolName: event.toolName ?? event.name ?? "", input: event.input ?? event.args,
    });
    return decision.block ? decision : undefined;
  });

  pi.on("tool_execution_end", (event: any, ctx: any) => {
    const ws = getWorkspace(ctx);
    ws.tracker.recordToolExecutionEnd(ws.cwd, {
      toolCallId: event.toolCallId ?? event.id ?? "call", toolName: event.toolName ?? event.name ?? "unknown",
      args: event.args ?? event.input, isError: Boolean(event.isError ?? event.result?.isError),
    });
  });

  function registerTool(input: {
    name: string; label: string; description: string; approval: "read" | "write" | "exec";
    parameters: unknown; execute: (params: Record<string, unknown>, ctx: any) => Promise<unknown>;
  }): void {
    pi.registerTool({
      name: input.name, label: input.label, description: input.description,
      loadMode: "essential", approval: input.approval, parameters: input.parameters,
      execute: (_id: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, ctx: any) =>
        input.execute(params, ctx),
    });
  }
  registerTool({
    name: "enhance_mandate", label: "Enhance Mandate", approval: "write",
    description: "Set or read the active Mandate, and add/update epistemic-board items.",
    parameters: kit.obj({
      action: kit.en(["set", "get", "add_item", "update_item"]), goal: kit.str(),
      constraints: kit.arr(kit.str()), acceptance: kit.arr(kit.str()), mandateId: kit.str(),
      status: kit.en([...MANDATE_STATUSES, ...EPISTEMIC_STATUSES]), kind: kit.en(EPISTEMIC_KINDS),
      statement: kit.str(), evidenceRef: kit.str(), verificationPlan: kit.str(), itemId: kit.str(),
    }, ["action"]),
    async execute(params, ctx) {
      try {
        const ws = getWorkspace(ctx);
        const action = asString(params.action) ?? "get";
        if (action === "get") {
          const mandate = ws.store.getActiveMandate();
          return toolResult({ mandate, epistemicItems: mandate ? ws.store.listEpistemicItems(mandate.id) : [] });
        }
        if (action === "set") {
          const goal = asString(params.goal);
          if (!goal) throw new Error("enhance_mandate set requires a goal.");
          const status = asString(params.status);
          if (status && !MANDATE_STATUSES.includes(status as Mandate["status"])) throw new Error(`Invalid mandate status "${status}".`);
          const mandateId = asString(params.mandateId);
          const mandate = ws.store.upsertMandate({
            ...(mandateId ? { id: mandateId } : {}), goal,
            constraints: asStringArray(params.constraints), acceptance: asStringArray(params.acceptance),
            ...(status ? { status: status as Mandate["status"] } : {}),
          });
          return toolResult({ mandate, epistemicItems: ws.store.listEpistemicItems(mandate.id) });
        }
        if (action === "add_item") {
          const mandateId = asString(params.mandateId) ?? ws.store.getActiveMandate()?.id;
          if (!mandateId) throw new Error("enhance_mandate add_item requires an active mandate.");
          const kind = asString(params.kind);
          if (!kind || !EPISTEMIC_KINDS.includes(kind as EpistemicKind)) throw new Error("add_item requires kind fact|hypothesis|inquiry|decision.");
          const statement = asString(params.statement);
          if (!statement) throw new Error("enhance_mandate add_item requires a statement.");
          const status = asString(params.status);
          if (status && !EPISTEMIC_STATUSES.includes(status as EpistemicStatus)) throw new Error(`Invalid epistemic status "${status}".`);
          const item = ws.store.addEpistemicItem({
            mandateId, kind: kind as EpistemicKind, statement,
            evidenceRef: asString(params.evidenceRef), verificationPlan: asString(params.verificationPlan),
            ...(status ? { status: status as EpistemicStatus } : {}),
          });
          return toolResult({ item });
        }
        if (action === "update_item") {
          const itemId = asString(params.itemId), status = asString(params.status);
          if (!itemId || !status || !EPISTEMIC_STATUSES.includes(status as EpistemicStatus)) throw new Error("update_item requires itemId and a valid status.");
          return toolResult({ item: ws.store.updateEpistemicStatus(itemId, status as EpistemicStatus, asString(params.evidenceRef)) });
        }
        throw new Error(`Unknown enhance_mandate action "${action}".`);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registerTool({
    name: "enhance_handoff", label: "Enhance Handoff", approval: "write",
    description: "Create a verified HandoffEnvelope for the active role; optionally delegate immediately.",
    parameters: kit.obj({
      verdict: kit.en(VERDICTS), summary: kit.str(), toTarget: kit.str(), artifactPaths: kit.arr(kit.str()),
      verifiedFacts: kit.arr(kit.obj({ claim: kit.str(), evidenceRef: kit.str() }, ["claim", "evidenceRef"])),
      openRisks: kit.arr(kit.str()), feedbackForUpstream: kit.str(), delegateNow: kit.bool(),
    }, ["verdict", "summary"]),
    async execute(params, ctx) {
      try {
        const ws = getWorkspace(ctx);
        const role = activeRole(ws) ?? ws.roles.get("dev");
        if (!role) throw new Error("No active role and no builtin dev role available.");
        const verdict = asString(params.verdict);
        if (!verdict || !VERDICTS.includes(verdict as HandoffVerdict)) throw new Error("enhance_handoff requires verdict ready|rejected|blocked.");
        const summary = asString(params.summary);
        if (!summary) throw new Error("enhance_handoff requires a summary.");
        const mandate = ws.store.getActiveMandate(), toTarget = asString(params.toTarget) ?? "user";
        const envelope = createAndVerifyHandoff({
          store: ws.store, role, cwd: ws.cwd, mandate, toTarget,
          parentHandoffId: mandate ? ws.store.getLatestHandoff(mandate.id)?.id ?? null : null,
          verdict: verdict as HandoffVerdict, summary, artifactPaths: asStringArray(params.artifactPaths),
          baselineSnapshot: ws.tracker.getBaselineSnapshot(), observedCalls: ws.tracker.getObservedCalls(),
          verifiedFacts: asVerifiedFacts(params.verifiedFacts), openRisks: asStringArray(params.openRisks),
          feedbackForUpstream: asString(params.feedbackForUpstream),
        });
        if (params.delegateNow === true && toTarget !== "user") {
          const target = ws.roles.get(toTarget);
          if (!target) throw new Error(`Unknown delegation target role "${toTarget}".`);
          const delegated = await executeRoleStep({
            cwd: ws.cwd, store: ws.store, role: target, upstreamHandoff: envelope,
            mandate: ws.store.getMandate(envelope.mandateId)!, toTarget: "user", runner: runnerFor(ws, ctx),
            supervisor: supervisorFor(ws, ctx),
          });
          return toolResult({ handoff: envelope, delegated }, !delegated.ok);
        }
        return toolResult({ handoff: envelope });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registerTool({
    name: "enhance_flow", label: "Enhance Flow", approval: "exec",
    description: "Run a Markov-isolated role chain with automatic rejection repair and stagnation guard.",
    parameters: kit.obj({
      roles: kit.arr(kit.str()), goal: kit.str(), maxRepairRounds: kit.num(), initialHandoffId: kit.str(),
    }, ["roles"]),
    async execute(params, ctx) {
      try {
        const ws = getWorkspace(ctx);
        const roleIds = asStringArray(params.roles);
        if (!roleIds) throw new Error("enhance_flow requires a non-empty roles array.");
        const roles = roleIds.map((roleId) => {
          const role = ws.roles.get(roleId);
          if (!role) throw new Error(`Unknown role "${roleId}".`);
          return role;
        });
        const goal = asString(params.goal);
        const mandate = goal ? ws.store.upsertMandate({ goal }) : ws.store.getActiveMandate();
        if (!mandate) throw new Error("enhance_flow requires a goal or an active mandate.");
        const initialHandoffId = asString(params.initialHandoffId);
        const result = await executeRoleFlow({
          cwd: ws.cwd, store: ws.store, roles, mandate, runner: runnerFor(ws, ctx),
          initialHandoff: initialHandoffId ? ws.store.getHandoff(initialHandoffId) : ws.store.getLatestHandoff(mandate.id),
          maxRepairRounds: typeof params.maxRepairRounds === "number" ? params.maxRepairRounds : ws.settings.flowMaxRepairRounds,
          supervisor: supervisorFor(ws, ctx),
        });
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registerTool({
    name: "enhance_job", label: "Enhance Job", approval: "exec",
    description: "Start, watch with adaptive supervision, list, reconcile, tail, or cancel background jobs.",
    parameters: kit.obj({
      action: kit.en(["start", "watch", "list", "reconcile", "tail", "cancel"]),
      command: kit.str(), jobId: kit.str(), mandateId: kit.str(), hypothesisId: kit.str(),
      initialDelaySec: kit.num(), goal: kit.str(),
    }, ["action"]),
    async execute(params, ctx) {
      try {
        const ws = getWorkspace(ctx);
        const action = asString(params.action);
        if (action === "start") {
          const command = asString(params.command);
          if (!command) throw new Error("enhance_job start requires a command.");
          const job = startBackgroundJob({
            store: ws.store, cwd: ws.cwd, command,
            mandateId: asString(params.mandateId), hypothesisId: asString(params.hypothesisId),
          });
          return toolResult({ job });
        }
        if (action === "list") return toolResult({ jobs: ws.store.listJobs() });
        if (action === "watch") {
          const jobId = asString(params.jobId), command = asString(params.command);
          const job = jobId ? ws.store.getJob(jobId) : command
            ? startBackgroundJob({
              store: ws.store, cwd: ws.cwd, command,
              mandateId: asString(params.mandateId), hypothesisId: asString(params.hypothesisId),
            }) : null;
          if (!job) throw new Error(jobId ? `Unknown jobId "${jobId}".` : "enhance_job watch requires a jobId or command.");
          const supervisor = supervisorFor(ws, ctx, true);
          if (!supervisor) throw new Error("Supervisor role is unavailable.");
          const delaySec = typeof params.initialDelaySec === "number" && Number.isFinite(params.initialDelaySec)
            ? Math.max(0, params.initialDelaySec) : ws.settings.supervisorInitialDelaySec;
          const result = await watchBackgroundJob({
            store: ws.store, jobId: job.jobId, supervisorRole: supervisor.role, inspector: supervisor.inspector,
            goal: asString(params.goal) ?? ws.store.getActiveMandate()?.goal ?? job.command,
            initialDelayMs: delaySec * 1000,
          });
          return toolResult({ started: !jobId, ...result });
        }
        if (action === "reconcile") return toolResult({ jobs: reconcileJobs(ws.store) });
        if (action === "tail") {
          const jobId = asString(params.jobId);
          const job = jobId ? ws.store.getJob(jobId) : null;
          if (!job) throw new Error("enhance_job tail requires a known jobId.");
          return toolResult({ job, tail: readJobLogTail(job) });
        }
        if (action === "cancel") {
          const jobId = asString(params.jobId);
          if (!jobId) throw new Error("enhance_job cancel requires a jobId.");
          return toolResult({ job: cancelJob(ws.store, jobId) });
        }
        throw new Error(`Unknown enhance_job action "${action}".`);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  pi.registerCommand("role", {
    description: "Open Role Studio, or list, show, edit, create, switch, and disable YAML roles.",
    handler: async (args: string, ctx: any) => {
      const ws = getWorkspace(ctx);
      refreshRoles(ws);
      const studioDeps = (): RoleStudioDeps => ({
        cwd: ws.cwd, globalRolesDir: globalRolesDir(options), pi, ctx,
        getRoles: () => ws.roles, refreshRoles: () => refreshRoles(ws),
        getActiveRoleId: () => ws.activeRoleId, activateRole: (id) => applyActiveRole(ws, id, ctx),
      });
      const trimmed = args.trim(), head = trimmed.split(/\s+/)[0] ?? "";
      if (ctx?.hasUI && (!trimmed || head === "studio")) return openRoleStudioHome(studioDeps());
      if (head === "edit") {
        if (!ctx?.hasUI) return emitMessage(ctx, "Interactive UI required for /role edit.");
        const editId = trimmed.slice(4).trim();
        return editId && ws.roles.has(editId)
          ? openRoleEditor(editId, studioDeps()) : openRoleStudioHome(studioDeps());
      }
      if (!trimmed || head === "list") {
        const lines = [`Roles (${ws.roles.size})`];
        for (const role of [...ws.roles.values()].sort((a, b) => a.id.localeCompare(b.id))) {
          const marker = ws.activeRoleId === role.id ? "*" : " ";
          const modelInfo = role.model ? ` (${role.model})` : "";
          lines.push(`${marker} ${role.id} [${role.source}]${modelInfo} ${role.description}`.trimEnd());
        }
        emitMessage(ctx, lines.join("\n"));
        return;
      }
      if (head === "show") {
        const role = ws.roles.get(trimmed.slice(4).trim());
        if (!role) return emitMessage(ctx, `Unknown role "${trimmed.slice(4).trim()}".`);
        emitMessage(ctx, JSON.stringify({
          id: role.id, name: role.name, description: role.description, source: role.source,
          model: role.model ?? null, thinking: role.thinking ?? null,
          filePath: role.filePath, stance: role.stance, method: role.method,
          permissions: role.permissions, exit: role.exit,
        }, null, 2));
        return;
      }
      if (head === "create") {
        const tokens = trimmed.slice(6).trim().split(/\s+/).filter(Boolean);
        const roleId = tokens.find((token) => !token.startsWith("--"));
        const description = tokens.filter((token) => !token.startsWith("--")).slice(1).join(" ");
        if (!roleId || !description) return emitMessage(ctx, "Usage: /role create <id> [--project] [--readonly] <description>");
        const targetDir = tokens.includes("--project") ? path.join(ws.cwd, ".omp", "roles") : globalRolesDir(options);
        const created = scaffoldRoleFile({
          id: roleId, description, targetDir, readOnly: tokens.includes("--readonly"),
        });
        refreshRoles(ws);
        emitMessage(ctx, `Created role "${created.role.id}" [${created.source}] at ${created.filePath}`);
        return;
      }
      if (head === "off") {
        await applyActiveRole(ws, null, ctx);
        emitMessage(ctx, "Role conditioning disabled.");
        return;
      }
      const role = ws.roles.get(trimmed);
      if (!role) return emitMessage(ctx, `Unknown role "${trimmed}". Use /role list.`);
      await applyActiveRole(ws, role.id, ctx);
      emitMessage(ctx, `Active role: ${role.id} [${role.source}]`);
    },
  });

  const handoffHandler = async (args: string, ctx: any): Promise<void> => {
    const ws = getWorkspace(ctx);
    refreshRoles(ws);
    const targetId = args.trim().split(/\s+/)[0] ?? "", target = ws.roles.get(targetId);
    if (!target) return emitMessage(ctx, targetId ? `Unknown role "${targetId}".` : "Usage: /handoff <targetRole>");
    try {
      const mandate = ws.store.getActiveMandate() ?? ws.store.upsertMandate({
        goal: "Handoff initiated from current workspace state",
      });
      const upstream = ws.store.getLatestHandoff(mandate.id) ?? createAndVerifyHandoff({
        store: ws.store, role: activeRole(ws) ?? ws.roles.get("dev")!, cwd: ws.cwd, mandate,
        toTarget: target.id, verdict: "ready", summary: "Automatic workspace snapshot handoff",
        baselineSnapshot: ws.tracker.getBaselineSnapshot(), observedCalls: ws.tracker.getObservedCalls(),
      });
      const result = await executeRoleStep({
        cwd: ws.cwd, store: ws.store, role: target,
        mandate: ws.store.getMandate(upstream.mandateId) ?? mandate, upstreamHandoff: upstream,
        toTarget: "user", runner: runnerFor(ws, ctx), supervisor: supervisorFor(ws, ctx),
      });
      emitMessage(ctx, JSON.stringify({
        ok: result.ok, targetRole: target.id, upstreamHandoffId: upstream.id,
        ...(result.ok ? { envelope: result.envelope } : { status: result.status, reason: result.reason }),
      }, null, 2));
    } catch (error) {
      emitMessage(ctx, JSON.stringify({ ok: false, targetRole: target.id, error: String(error) }, null, 2));
    }
  };
  const handoffDescription = "Hand the latest verified work (or a workspace snapshot) to an isolated role session.";
  pi.registerCommand("enhance-handoff", { description: handoffDescription, handler: handoffHandler });
  pi.registerCommand("handoff", { description: handoffDescription, handler: handoffHandler });

  pi.registerCommand("flow", {
    description: "Run a comma-separated role chain with automatic rejection repair.",
    handler: async (args: string, ctx: any) => {
      const ws = getWorkspace(ctx);
      refreshRoles(ws);
      const [roleList = "", ...goalParts] = args.trim().split(/\s+/);
      const roleIds = roleList.split(",").map((id) => id.trim()).filter(Boolean);
      if (roleIds.length === 0) return emitMessage(ctx, "Usage: /flow <role1,role2,...> [goal]");
      try {
        const roles = roleIds.map((roleId) => {
          const role = ws.roles.get(roleId);
          if (!role) throw new Error(`Unknown role "${roleId}".`);
          return role;
        });
        const goal = goalParts.join(" ").trim();
        const mandate = goal ? ws.store.upsertMandate({ goal }) : ws.store.getActiveMandate();
        if (!mandate) throw new Error("Provide a goal or set an active mandate first.");
        const result = await executeRoleFlow({
          cwd: ws.cwd, store: ws.store, roles, mandate,
          initialHandoff: ws.store.getLatestHandoff(mandate.id), runner: runnerFor(ws, ctx),
          maxRepairRounds: ws.settings.flowMaxRepairRounds,
          supervisor: supervisorFor(ws, ctx),
        });
        emitMessage(ctx, JSON.stringify({
          status: result.status, reason: result.reason,
          steps: result.steps.map((step) => ({
            stepIndex: step.stepIndex, roleId: step.roleId, round: step.round,
            verdict: step.envelope.verdict, summary: step.envelope.summary, envelopeId: step.envelope.id,
          })),
          finalEnvelopeId: result.finalEnvelope?.id ?? null,
        }, null, 2));
      } catch (error) {
        emitMessage(ctx, JSON.stringify({ status: "error", error: String(error) }, null, 2));
      }
    },
  });

  pi.registerCommand("enhance-status", {
    description: "Show active role, settings, mandate, epistemic board, latest handoff, and jobs.",
    handler: async (_args: string, ctx: any) => {
      const ws = getWorkspace(ctx);
      refreshRoles(ws);
      reconcileJobs(ws.store);
      const mandate = ws.store.getActiveMandate();
      const latest = mandate ? ws.store.getLatestHandoff(mandate.id) : ws.store.getLatestHandoff();
      emitMessage(ctx, JSON.stringify({
        activeRoleId: ws.activeRoleId, roleCount: ws.roles.size, settings: ws.settings,
        activeMandate: mandate
          ? { id: mandate.id, rev: mandate.rev, goal: mandate.goal, status: mandate.status } : null,
        epistemicCount: mandate ? ws.store.listEpistemicItems(mandate.id).length : 0,
        latestHandoff: latest
          ? {
            id: latest.id, fromRole: latest.fromRole, toTarget: latest.toTarget,
            verdict: latest.verdict, summary: latest.summary, createdAt: latest.createdAt,
          } : null,
        jobs: ws.store.listJobs().map((job) => ({
          jobId: job.jobId, status: job.status, exitCode: job.exitCode, command: job.command,
        })),
      }, null, 2));
    },
  });
}
