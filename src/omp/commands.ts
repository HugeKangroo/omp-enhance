import path from "node:path";
import type { FlowRunResult } from "../core/types.ts";
import { createAndVerifyHandoff } from "../flow/handoff.ts";
import { executeRoleStep } from "../flow/orchestrator.ts";
import { reconcileJobs } from "../jobs/runner.ts";
import {
  cloneRoleSpec, deleteCustomRole, discoverRoles, hasBuiltinRole, scaffoldRoleFile,
} from "../roles/loader.ts";
import { openFlowRoomOverlay } from "../ui/flow-room.ts";
import { openRoleEditor, openRoleStudioHome, type RoleStudioDeps } from "../ui/role-studio.ts";
import type { WorkspaceRuntime } from "./tools.ts";

const KNOWN_CREATE_FLAGS = new Set(["--project", "--readonly", "--overwrite"]);
const KNOWN_COPY_FLAGS = new Set(["--project", "--overwrite"]);

function splitHeadAndRest(raw: string): { head: string; rest: string } {
  const trimmed = raw.trim();
  const idx = trimmed.search(/\s/);
  return idx < 0 ? { head: trimmed, rest: "" } : { head: trimmed.slice(0, idx), rest: trimmed.slice(idx).trim() };
}

export function registerEnhanceCommands(
  pi: any,
  getWorkspace: (ctx: any) => WorkspaceRuntime,
  options: { globalRolesDir: string; builtinRolesDir?: string },
): void {
  const completeRoleIds = (prefix: string, extras: readonly string[] = []) => {
    try {
      const roles = discoverRoles({
        cwd: pi?.cwd ?? process.cwd(),
        globalRolesDir: options.globalRolesDir,
        builtinRolesDir: options.builtinRolesDir,
      });
      const q = prefix.trim().toLowerCase();
      return [
        ...extras.map((v) => ({ value: v, label: v })),
        ...[...roles.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((r) => ({ value: r.id, label: r.id, description: `[${r.source}] ${r.description || r.name}` })),
      ].filter((item) => !q || item.value.toLowerCase().startsWith(q));
    } catch {
      return [];
    }
  };

  const handoffHandler = async (args: string, ctx: any): Promise<void> => {
    const ws = getWorkspace(ctx);
    ws.refresh(ctx);
    let targetId = args.trim().split(/\s+/)[0] ?? "";
    if (!targetId && ctx?.hasUI && typeof ctx?.ui?.select === "function") {
      const candidates = [...ws.roles.values()]
        .filter((r) => r.id !== "supervisor")
        .sort((a, b) => a.id.localeCompare(b.id));
      const picked: string | undefined = await ctx.ui.select(
        "Handoff current work to which isolated stage role?",
        candidates.map((r) => `${r.id} — ${r.description || r.name}`),
        { outline: true },
      );
      if (!picked) return;
      targetId = picked.split(" — ", 1)[0]?.trim() ?? "";
    }
    if (targetId === "supervisor") {
      return ws.emitMessage(ctx, 'Role "supervisor" is an internal monitor and cannot be a handoff target.');
    }
    const target = ws.roles.get(targetId);
    if (!target) {
      return ws.emitMessage(ctx, targetId ? `Unknown role "${targetId}".` : "Usage: /enhance-handoff [targetRole]");
    }
    try {
      const sid = ws.getSessionId(ctx);
      const tracker = ws.trackers.get(sid);
      const mandate =
        ws.store.getActiveMandate({ sessionId: sid }) ??
        ws.store.upsertMandate({ goal: "Handoff initiated from current workspace state", sessionId: sid });
      const seedRole = ws.getActiveRole(ctx) ?? ws.roles.get("dev") ?? ws.roles.get("general")!;
      const upstream =
        ws.store.getLatestHandoff(mandate.id) ??
        createAndVerifyHandoff({
          store: ws.store,
          role: { ...seedRole, exit: { requireToolEvidence: false, criteria: [] } },
          cwd: ws.cwd,
          mandate,
          sessionId: sid,
          toTarget: target.id,
          verdict: "ready",
          summary: "Automatic workspace snapshot handoff",
          baselineSnapshot: tracker.getBaselineSnapshot(ws.cwd),
          baselineConfigSnapshot: tracker.getBaselineConfigSnapshot(ws.cwd),
          observedCalls: tracker.getObservedCalls(),
        });
      const result = await executeRoleStep({
        cwd: ws.cwd,
        store: ws.store,
        role: target,
        mandate: ws.store.getMandate(upstream.mandateId) ?? mandate,
        upstreamHandoff: upstream,
        toTarget: "user",
        runner: ws.runnerFor(ctx),
        supervisor: ws.supervisorFor(ctx),
      });
      ws.emitMessage(
        ctx,
        JSON.stringify(
          {
            ok: result.ok,
            targetRole: target.id,
            upstreamHandoffId: upstream.id,
            ...(result.ok ? { envelope: result.envelope } : { status: result.status, reason: result.reason }),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      ws.emitMessage(ctx, JSON.stringify({ ok: false, targetRole: target.id, error: String(error) }, null, 2));
    }
  };

  pi.registerCommand("role", {
    description: "Open split-pane Role Studio, or switch, copy, delete, edit, create, list, show, and disable YAML roles.",
    getArgumentCompletions: (prefix: string) => {
      if (/^(?:show|edit|copy)\s+/i.test(prefix)) {
        const head = prefix.match(/^(?:show|edit|copy)\s+/i)![0];
        const rest = prefix.slice(head.length);
        if (rest.includes(" ")) return [];
        return completeRoleIds(rest).map((c) => ({ ...c, value: `${head}${c.value}` }));
      }
      if (/^delete\s+/i.test(prefix)) {
        const head = prefix.match(/^delete\s+/i)![0];
        return completeRoleIds(prefix.slice(head.length))
          .filter((c) => !hasBuiltinRole(c.value, options.builtinRolesDir))
          .map((c) => ({ ...c, value: `${head}${c.value}` }));
      }
      return completeRoleIds(prefix, ["off", "list", "studio", "edit ", "copy ", "delete ", "show ", "create "]);
    },
    handler: async (args: string, ctx: any) => {
      try {
        const ws = getWorkspace(ctx);
        ws.refresh(ctx);
        const studioDeps = (): RoleStudioDeps => ({
          cwd: ws.cwd,
          globalRolesDir: ws.globalRolesDir,
          builtinRolesDir: ws.builtinRolesDir,
          pi,
          ctx,
          getRoles: () => ws.roles,
          refreshRoles: () => ws.refresh(ctx),
          getSettings: () => ws.settings,
          getActiveRoleId: () => ws.getSessionRoleId(ctx),
          activateRole: (id) => ws.applyActiveRole(id, ctx, true),
          runHandoff: (id) => handoffHandler(id, ctx),
        });
        const { head, rest } = splitHeadAndRest(args);
        const trimmed = args.trim();
        if (ctx?.hasUI && (!trimmed || head === "studio")) return openRoleStudioHome(studioDeps());
        if (head === "edit") {
          if (!ctx?.hasUI) return ws.emitMessage(ctx, "Interactive UI required for /role edit.");
          return rest && ws.roles.has(rest) ? openRoleEditor(rest, studioDeps()) : openRoleStudioHome(studioDeps());
        }
        if (!trimmed || head === "list") {
          const activeId = ws.getSessionRoleId(ctx);
          const lines = [`Roles (${ws.roles.size})`];
          for (const r of [...ws.roles.values()].sort((a, b) => a.id.localeCompare(b.id))) {
            lines.push(
              `${activeId === r.id ? "*" : " "} ${r.id} [${r.source}]${r.model ? ` (${r.model})` : ""} ${r.description}`.trimEnd(),
            );
          }
          return ws.emitMessage(ctx, lines.join("\n"));
        }
        if (head === "show") {
          const r = ws.roles.get(rest);
          if (!r) return ws.emitMessage(ctx, `Unknown role "${rest}".`);
          return ws.emitMessage(
            ctx,
            JSON.stringify(
              {
                id: r.id, name: r.name, description: r.description, source: r.source,
                model: r.model ?? null, thinking: r.thinking ?? null, filePath: r.filePath,
                stance: r.stance, method: r.method, permissions: r.permissions, exit: r.exit,
              },
              null,
              2,
            ),
          );
        }
        if (head === "create") {
          const tokens = rest.split(/\s+/).filter(Boolean);
          const flags = new Set(tokens.filter((t) => KNOWN_CREATE_FLAGS.has(t)));
          const positional = tokens.filter((t) => !KNOWN_CREATE_FLAGS.has(t));
          const [roleId, ...desc] = positional;
          if (!roleId || desc.length === 0) {
            return ws.emitMessage(ctx, "Usage: /role create <id> [--project] [--readonly] <description>");
          }
          try {
            const targetDir = flags.has("--project") ? path.join(ws.cwd, ".omp", "roles") : ws.globalRolesDir;
            const created = scaffoldRoleFile({
              id: roleId,
              description: desc.join(" "),
              targetDir,
              globalRolesDir: ws.globalRolesDir,
              readOnly: flags.has("--readonly"),
              overwrite: flags.has("--overwrite"),
            });
            ws.refresh(ctx);
            return ws.emitMessage(ctx, `Created role "${created.role.id}" [${created.source}] at ${created.filePath}`);
          } catch (err) {
            return ws.emitMessage(ctx, err instanceof Error ? err.message : String(err));
          }
        }
        if (head === "copy") {
          const tokens = rest.split(/\s+/).filter(Boolean);
          const flags = new Set(tokens.filter((t) => KNOWN_COPY_FLAGS.has(t)));
          const [srcId, newId, ...desc] = tokens.filter((t) => !KNOWN_COPY_FLAGS.has(t));
          if (!srcId || !newId) return ws.emitMessage(ctx, "Usage: /role copy <sourceId> <newId> [--project] [description]");
          const srcRole = ws.roles.get(srcId);
          if (!srcRole) return ws.emitMessage(ctx, `Unknown source role "${srcId}".`);
          try {
            const targetDir = flags.has("--project") ? path.join(ws.cwd, ".omp", "roles") : ws.globalRolesDir;
            const cloned = cloneRoleSpec({
              sourceRole: srcRole, newId, description: desc.join(" "), targetDir,
              globalRolesDir: ws.globalRolesDir, overwrite: flags.has("--overwrite"),
            });
            ws.refresh(ctx);
            return ws.emitMessage(ctx, `Copied "${srcId}" to "${cloned.role.id}" [${cloned.source}] at ${cloned.filePath}`);
          } catch (err) {
            return ws.emitMessage(ctx, err instanceof Error ? err.message : String(err));
          }
        }
        if (head === "delete") {
          if (!rest) return ws.emitMessage(ctx, "Usage: /role delete <customRoleId>");
          try {
            deleteCustomRole({ id: rest, cwd: ws.cwd, globalRolesDir: ws.globalRolesDir, builtinRolesDir: ws.builtinRolesDir });
            ws.refresh(ctx);
            if (ws.getSessionRoleId(ctx) === rest) {
              const fb = ws.settings.defaultRole === null
                ? null
                : ws.roles.has(ws.settings.defaultRole)
                  ? ws.settings.defaultRole
                  : ws.roles.has("general")
                    ? "general"
                    : null;
              await ws.applyActiveRole(fb, ctx, true);
            }
            return ws.emitMessage(ctx, `Deleted custom role "${rest}".`);
          } catch (err) {
            return ws.emitMessage(ctx, err instanceof Error ? err.message : String(err));
          }
        }
        if (head === "off") {
          await ws.applyActiveRole(null, ctx, true);
          return ws.emitMessage(ctx, "Role conditioning disabled.");
        }
        const role = ws.roles.get(trimmed);
        if (!role) return ws.emitMessage(ctx, `Unknown role "${trimmed}". Use /role list.`);
        await ws.applyActiveRole(role.id, ctx, true);
        ws.emitMessage(ctx, `Active role: ${role.id} [${role.source}]`);
      } catch (err) {
        getWorkspace(ctx).emitMessage(ctx, err instanceof Error ? err.message : String(err));
      }
    },
  });

  pi.registerCommand("enhance-handoff", {
    description: "Hand the latest verified work (or a workspace snapshot) to an isolated stage role.",
    getArgumentCompletions: (prefix: string) =>
      prefix.includes(" ") ? [] : completeRoleIds(prefix).filter((c) => c.value !== "supervisor"),
    handler: handoffHandler,
  });

  pi.registerCommand("flow", {
    description: "Open split-pane Flow Room & Action Inspector (/flow), or start, continue, steer, inspect, and cancel multi-role Flows.",
    getArgumentCompletions: (prefix: string) => {
      if (prefix.includes(" ")) return [];
      const idx = prefix.lastIndexOf(",");
      if (idx >= 0) {
        const head = prefix.slice(0, idx + 1), tail = prefix.slice(idx + 1);
        return completeRoleIds(tail).filter((c) => c.value !== "supervisor").map((c) => ({ ...c, value: `${head}${c.value}` }));
      }
      return completeRoleIds(prefix, ["hub", "continue", "resume", "status", "steer ", "cancel"]).filter((c) => c.value !== "supervisor");
    },
    handler: async (args: string, ctx: any) => {
      const ws = getWorkspace(ctx);
      ws.refresh(ctx);
      const { head: first, rest: restRaw } = splitHeadAndRest(args);
      if (!first || first === "hub" || first === "room") {
        return ctx?.hasUI
          ? openFlowRoomOverlay({
              ctx, room: ws.room,
              onFollowUp: (msg) => ws.dispatchFollowUpFromRoom(ctx, msg),
              onResume: async () => { await ws.resumeManagedFlow(ctx, true); },
            })
          : ws.emitMessage(ctx, JSON.stringify({ ...ws.room.getSnapshot(), resumable: ws.room.isResumable() }, null, 2));
      }
      if (first === "status") {
        return ws.emitMessage(ctx, JSON.stringify({ ...ws.room.getSnapshot(), resumable: ws.room.isResumable() }, null, 2));
      }
      if (first === "continue" || first === "resume") {
        try {
          if (ctx?.hasUI) {
            const r = (await ws.resumeManagedFlow(ctx, true)) as { startIndex: number; roleChain: string[] };
            ctx?.ui?.notify?.(`已从阶段 ${r.startIndex + 1}/${r.roleChain.length} (${r.roleChain[r.startIndex]}) 断点续跑 Flow`, "info");
            return;
          }
          const result = (await ws.resumeManagedFlow(ctx, false)) as FlowRunResult;
          return ws.emitMessage(ctx, JSON.stringify({
            status: result.status, reason: result.reason,
            steps: result.steps.map((s) => ({
              stepIndex: s.stepIndex, roleId: s.roleId, round: s.round,
              verdict: s.envelope.verdict, summary: s.envelope.summary, envelopeId: s.envelope.id,
            })),
            finalEnvelopeId: result.finalEnvelope?.id ?? null,
          }, null, 2));
        } catch (error) {
          return ws.emitMessage(ctx, JSON.stringify({ status: "error", error: String(error) }, null, 2));
        }
      }
      if (first === "cancel" || first === "stop") {
        const ok = await ws.room.cancelActiveFlow(ctx);
        ws.syncStatusBar(ctx);
        return ws.emitMessage(ctx, ok ? "已中止当前协作 Flow。" : "当前没有运行中的协作 Flow。");
      }
      if (first === "steer") {
        if (!restRaw) return ws.emitMessage(ctx, "Usage: /flow steer <message>");
        const res = await ws.room.postUserSteer(restRaw, ctx);
        const label = res.delivered
          ? `已实时插话至当前阶段 (${res.activeStageId}): ${restRaw}`
          : res.queuedForRole
            ? `已为 @${res.queuedForRole} 排队定向留言: ${restRaw}`
            : `已记录群聊留言: ${restRaw}`;
        return ws.emitMessage(ctx, label);
      }

      const roleIds = first.split(",").map((id) => id.trim()).filter(Boolean);
      if (roleIds.length === 0) {
        return ws.emitMessage(ctx, "Usage: /flow [hub|continue|status|steer <msg>|cancel|<role1,role2,...> [goal]]");
      }
      try {
        const roles = roleIds.map((id) => {
          if (id === "supervisor") throw new Error('Role "supervisor" cannot run as a Flow stage.');
          const r = ws.roles.get(id);
          if (!r) throw new Error(`Unknown role "${id}".`);
          return r;
        });
        if (ws.room.isRunning()) {
          throw new Error("已有正在运行的协作 Flow；可通过 steer 插话、/flow 查看或 cancel 取消。");
        }
        const sid = ws.getSessionId(ctx);
        const existingMandate = restRaw ? null : ws.store.getActiveMandate({ sessionId: sid });
        if (!restRaw && !existingMandate) throw new Error("Provide a goal or set an active mandate first.");
        const flowId = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const mandate = restRaw ? ws.store.upsertMandate({ goal: restRaw, flowId }) : existingMandate!;
        const initialHandoff = !restRaw ? ws.store.getLatestHandoff(mandate.id) : null;
        if (ctx?.hasUI) {
          await ws.startManagedFlow({
            ctx, flowId, roles, mandate, initialHandoff,
            maxRepairRounds: ws.settings.flowMaxRepairRounds, background: true, initiatorText: restRaw || mandate.goal,
          });
          ctx?.ui?.notify?.(`已启动协作 Flow: ${roleIds.join(" → ")} (输入 /flow 打开双栏群聊与检查器)`, "info");
          return;
        }
        const result = (await ws.startManagedFlow({
          ctx, flowId, roles, mandate, initialHandoff,
          maxRepairRounds: ws.settings.flowMaxRepairRounds, background: false, initiatorText: restRaw || mandate.goal,
        })) as FlowRunResult;
        ws.emitMessage(ctx, JSON.stringify({
          status: result.status, reason: result.reason,
          steps: result.steps.map((s) => ({
            stepIndex: s.stepIndex, roleId: s.roleId, round: s.round,
            verdict: s.envelope.verdict, summary: s.envelope.summary, envelopeId: s.envelope.id,
          })),
          finalEnvelopeId: result.finalEnvelope?.id ?? null,
        }, null, 2));
      } catch (error) {
        ws.emitMessage(ctx, JSON.stringify({ status: "error", error: String(error) }, null, 2));
      }
    },
  });

  pi.registerCommand("enhance-status", {
    description: "Show active role, settings, mandate, epistemic board, latest handoff, flow room, and jobs.",
    handler: async (_args: string, ctx: any) => {
      const ws = getWorkspace(ctx);
      ws.refresh(ctx);
      reconcileJobs(ws.store);
      const sid = ws.getSessionId(ctx);
      const mandate = ws.store.getActiveMandate({ sessionId: sid }) ?? ws.store.getActiveMandate();
      const latest = mandate ? ws.store.getLatestHandoff(mandate.id) : ws.store.getLatestHandoff();
      const flowSnap = ws.room.getSnapshot();
      ws.emitMessage(ctx, JSON.stringify({
        activeRoleId: ws.getSessionRoleId(ctx),
        roleCount: ws.roles.size,
        settings: ws.settings,
        flow: {
          flowId: flowSnap.flowId, status: flowSnap.status, currentIndex: flowSnap.currentIndex,
          resumable: ws.room.isResumable(), roleChain: flowSnap.roleChain,
        },
        activeMandate: mandate ? { id: mandate.id, rev: mandate.rev, goal: mandate.goal, status: mandate.status } : null,
        epistemicCount: mandate ? ws.store.listEpistemicItems(mandate.id).length : 0,
        latestHandoff: latest ? {
          id: latest.id, fromRole: latest.fromRole, toTarget: latest.toTarget,
          verdict: latest.verdict, summary: latest.summary, createdAt: latest.createdAt,
        } : null,
        jobs: ws.store.listJobs().map((j) => ({ jobId: j.jobId, status: j.status, exitCode: j.exitCode, command: j.command })),
      }, null, 2));
    },
  });
}
