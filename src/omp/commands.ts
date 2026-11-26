import path from "node:path";
import { canRoleDispatch, isInternalRole } from "../core/policy.ts";
import { reconcileJobs } from "../jobs/runner.ts";
import {
  cloneRoleSpec, deleteCustomRole, discoverRoles, hasBuiltinRole, listUserVisibleRoles,
  scaffoldRoleFile, serializeRoleYaml,
} from "../roles/loader.ts";
import { openFlowRoomOverlay } from "../ui/flow-room.ts";
import { openRoleEditor, openRoleStudioHome, type RoleStudioDeps } from "../ui/role-studio.ts";
import { executeCancelFlow } from "./flow-tool.ts";
import type { WorkspaceHub } from "./hub.ts";
import { defaultRoleId, type ManagedWorkspace } from "./workspace.ts";

const KNOWN_CREATE_FLAGS = new Set(["--project", "--readonly", "--overwrite"]);
const KNOWN_COPY_FLAGS = new Set(["--project", "--overwrite"]);

function splitHeadAndRest(raw: string): { head: string; rest: string } {
  const trimmed = raw.trim();
  const idx = trimmed.search(/\s/);
  return idx < 0 ? { head: trimmed, rest: "" } : { head: trimmed.slice(0, idx), rest: trimmed.slice(idx).trim() };
}

function renderMultiProjectFlowStatus(hub: WorkspaceHub, primaryWs: ManagedWorkspace): string {
  hub.getMonitorTargets(primaryWs);
  const summaries = hub.getAllFlowSummaries();
  const lines = ["跨项目后台专员监控 (/flow status)"];
  for (const s of summaries) {
    const chain = s.roleChain.length > 0 ? s.roleChain.join(" → ") : "待命";
    const stageInfo = s.graphProgress
      ? ` · 节点 ${s.graphProgress.done}/${s.graphProgress.total}`
      : (s.roleChain.length > 0 ? ` · 阶段 ${s.currentIndex + 1}/${s.roleChain.length}` : "");
    lines.push(`• ${s.cwd}`);
    lines.push(`  状态: ${s.status}${s.resumable ? " (可续跑)" : ""} · Flow: ${s.flowId ?? "无"} · 专员链: ${chain}${stageInfo}`);
    if (s.mergedRef) lines.push(`  交付引用: ${s.mergedRef}${s.mergedCommitSha ? ` (${s.mergedCommitSha.slice(0, 12)})` : ""}`);
    if (s.goal) lines.push(`  目标: ${s.goal}`);
    if (s.reason) lines.push(`  说明: ${s.reason}`);
  }
  lines.push("提示: 派发或续跑任务请敲 /coord 用自然语言吩咐总秘书 · 紧急停止敲 /flow cancel [flowId]");
  return lines.join("\n");
}

function renderCoordStatusCard(
  hub: WorkspaceHub, ws: ManagedWorkspace, ctx: any,
): { uiText: string; cmdOutText: string } {
  const activeId = ws.getSessionRoleId(ctx);
  const visible = listUserVisibleRoles(ws.roles);
  const s = ws.settings;
  const targets = hub.getMonitorTargets(ws);
  const uiProjects: string[] = [];
  const metaProjects: string[] = [];

  for (const t of targets) {
    const w = hub.getWorkspace(t.cwd, ctx);
    if (!w.store.isClosed()) {
      try { reconcileJobs(w.store); } catch {}
    }
    const snap = w.room.getSnapshot();
    const jobs = !w.store.isClosed() ? w.store.listJobs() : [];
    const runningJobs = jobs.filter((j) => j.status === "running").length;
    const flowDetail = snap.flowId ? `${snap.status} (${snap.roleChain.join(" → ")})` : snap.status;
    const trustTag = w.isTrusted ? "trusted" : "untrusted";
    uiProjects.push(`  - ${w.cwd} [${w.isTrusted ? "已信任" : "待信任"}] · 协作流=${flowDetail} · 后台任务=${runningJobs}/${jobs.length}`);
    metaProjects.push(`- ${w.cwd} [${trustTag}] · flow=${snap.flowId ? `${snap.status} (${snap.flowId}: ${snap.roleChain.join("→")})` : snap.status} · jobs=${runningJobs}/${jobs.length}`);
  }

  const modeDesc = activeId === "coordinator"
    ? "总秘书运行中 (coordinator)"
    : activeId
      ? `前台覆写角色 (${activeId})`
      : "标准原生 OMP (off)";

  const uiText = [
    "SuperAgent 总控状态",
    `• 当前模式: ${modeDesc}`,
    `• 可用编制: ${visible.length} 个角色 (${visible.map((r) => r.id).join(", ")})`,
    `• 运行设置: 默认模式=${s.defaultRole ?? "off"} · 督导模型=${s.supervisorModel} (${s.supervisorThinking}) · 最大返修=${s.flowMaxRepairRounds}轮 · 派单确认=${s.flowRoutingMode}`,
    "• 受管项目:",
    ...uiProjects,
    "提示: /coord 开启总秘书 · /coord off 退回标准 OMP · /coord trust <dir> 授权子项目配置 · /role 配置专员模型 · /flow 打开只读监控窗",
  ].join("\n");

  const cmdOutText = [
    uiText,
    `Active role: ${activeId ?? "off"}`,
    `Visible roles: ${visible.length} (${visible.map((r) => r.id).join(", ")})`,
    `Settings: defaultRole=${s.defaultRole ?? "off"}, supervisorModel=${s.supervisorModel}, supervisorThinking=${s.supervisorThinking}, flowMaxRepairRounds=${s.flowMaxRepairRounds}, flowRoutingMode=${s.flowRoutingMode}`,
    "Projects:",
    ...metaProjects,
  ].join("\n");

  return { uiText, cmdOutText };
}

export function registerEnhanceCommands(
  pi: any,
  hub: WorkspaceHub,
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
        ...listUserVisibleRoles(roles).map((r) => ({
          value: r.id, label: r.id, description: `[${r.source}] ${r.description || r.name}`,
        })),
      ].filter((item) => !q || item.value.toLowerCase().startsWith(q));
    } catch {
      return [];
    }
  };

  pi.registerCommand("coord", {
    description: "开启或退出 SuperAgent 总秘书模式 (/coord, /coord off, /coord status, /coord trust <dir>).",
    getArgumentCompletions: (prefix: string) => {
      if (/^(?:trust|untrust)\s+/i.test(prefix)) {
        const head = prefix.match(/^(?:trust|untrust)\s+/i)![0];
        const q = prefix.slice(head.length).trim().toLowerCase();
        return hub.listWorkspaces()
          .filter((w) => !q || w.cwd.toLowerCase().includes(q))
          .map((w) => ({ value: `${head}${w.cwd}`, label: w.cwd, description: w.isTrusted ? "trusted" : "untrusted" }));
      }
      const q = prefix.trim().toLowerCase();
      const base = q ? ["on", "off", "status", "toggle", "trust ", "untrust "] : ["on", "off", "status", "toggle"];
      return base
        .filter((v) => !q || v.startsWith(q))
        .map((v) => ({ value: v, label: v.trim() }));
    },
    handler: async (args: string, ctx: any) => {
      try {
        const ws = hub.getWorkspace(ctx);
        ws.refresh(ctx);
        const { head, rest } = splitHeadAndRest(args);
        const sub = head.toLowerCase();
        if (sub === "status") {
          const { uiText, cmdOutText } = renderCoordStatusCard(hub, ws, ctx);
          return ws.emitMessage(ctx, uiText, { cmdOutText });
        }
        if (sub === "trust") {
          const targetWs = hub.grantProjectTrust(rest || undefined, ws, ctx);
          hub.syncGlobalUi(ctx, ws);
          const uiText = `✓ 已信任项目目录: ${targetWs.cwd}（已启用项目级 .omp/* 角色与设置覆盖）`;
          return ws.emitMessage(ctx, uiText, { cmdOutText: `${uiText}\nTrusted project: ${targetWs.cwd}` });
        }
        if (sub === "untrust") {
          const targetWs = hub.revokeProjectTrust(rest || undefined, ws, ctx);
          hub.syncGlobalUi(ctx, ws);
          const uiText = `○ 已撤销项目目录信任: ${targetWs.cwd}（仅使用内置与全局角色及设置）`;
          return ws.emitMessage(ctx, uiText, { cmdOutText: `${uiText}\nUntrusted project: ${targetWs.cwd}` });
        }
        const curRoleId = ws.getSessionRoleId(ctx);
        if (sub === "off" || (sub === "toggle" && curRoleId === "coordinator")) {
          await ws.applyActiveRole(null, ctx, true);
          const uiText = "○ 已关闭总秘书模式，退回标准原生 OMP。";
          return ws.emitMessage(ctx, uiText, { cmdOutText: `${uiText}\nActive role: off` });
        }
        if (!sub || sub === "on" || sub === "toggle") {
          const coord = ws.roles.get("coordinator");
          if (!coord) return ws.emitMessage(ctx, '未找到内置角色 "coordinator"。');
          if (curRoleId === coord.id) {
            ws.syncStatusBar(ctx);
            const uiText = "✓ 总秘书模式已在运行中 — 直接用自然语言吩咐任务即可（输入 /coord off 退回标准 OMP）。";
            return ws.emitMessage(ctx, uiText, { cmdOutText: `${uiText}\nActive role: ${coord.id} [${coord.source}]` });
          }
          await ws.applyActiveRole(coord.id, ctx, true);
          const uiText = "✓ 总秘书模式已开启 — 直接用自然语言描述需求，方案确认后自动派发后台专员（输入 /coord off 退回标准 OMP）。";
          return ws.emitMessage(ctx, uiText, { cmdOutText: `${uiText}\nActive role: ${coord.id} [${coord.source}]` });
        }
        return ws.emitMessage(ctx, "用法: /coord | /coord off | /coord status | /coord trust <dir> | /coord untrust <dir>");
      } catch (err) {
        hub.getWorkspace(ctx).emitMessage(ctx, err instanceof Error ? err.message : String(err));
      }
    },
  });

  pi.registerCommand("role", {
    description: "打开专员配置工作台 (/role)，或创建、拷贝、删除、查看角色编制.",
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
        const ws = hub.getWorkspace(ctx);
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
        });
        const { head, rest } = splitHeadAndRest(args);
        const trimmed = args.trim();
        if (ctx?.hasUI && (!trimmed || head === "studio")) return openRoleStudioHome(studioDeps());
        if (head === "edit") {
          if (!ctx?.hasUI) return ws.emitMessage(ctx, "Interactive UI required for /role edit.");
          const candidate = rest ? ws.roles.get(rest) : undefined;
          if (rest && (rest === "supervisor" || isInternalRole(candidate))) {
            return ws.emitMessage(ctx, '角色 "supervisor" 为内部督导组件，请在 /settings → Plugins → omp-enhance 中配置。');
          }
          return candidate ? openRoleEditor(rest, studioDeps()) : openRoleStudioHome(studioDeps());
        }
        if (!trimmed || head === "list") {
          const activeId = ws.getSessionRoleId(ctx);
          const visible = listUserVisibleRoles(ws.roles);
          const lines = [`专员与总控编制 (${visible.length}) · 当前前台: ${activeId ?? "off"}`];
          for (const r of visible) {
            const tag = canRoleDispatch(r) ? "[总控入口]" : "[后台专员]";
            lines.push(
              `${activeId === r.id ? "*" : " "} ${r.id} ${tag} [${r.source}]${r.model ? ` (${r.model})` : ""} — ${r.description || r.name}`.trimEnd(),
            );
          }
          return ws.emitMessage(ctx, lines.join("\n"));
        }
        if (head === "show") {
          const r = ws.roles.get(rest);
          if (rest === "supervisor" || (r && isInternalRole(r))) {
            return ws.emitMessage(ctx, '角色 "supervisor" 为内部督导组件，不可直接查看或激活；请在 /settings → Plugins → omp-enhance 中配置。');
          }
          if (!r) return ws.emitMessage(ctx, `Unknown role "${rest}".`);
          const header = `# Role: ${r.id} [${r.source}] (${r.filePath})`;
          return ws.emitMessage(ctx, `${header}\n${serializeRoleYaml(r).trimEnd()}`);
        }
        if (head === "create") {
          const tokens = rest.split(/\s+/).filter(Boolean);
          const flags = new Set(tokens.filter((t) => KNOWN_CREATE_FLAGS.has(t)));
          const positional = tokens.filter((t) => !KNOWN_CREATE_FLAGS.has(t));
          const [roleId, ...desc] = positional;
          if (!roleId || desc.length === 0) {
            return ws.emitMessage(ctx, "Usage: /role create <id> [--project] [--readonly] <description>");
          }
          if (roleId === "supervisor") {
            return ws.emitMessage(ctx, 'Role id "supervisor" is reserved for the internal supervisor.');
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
          if (!srcRole || isInternalRole(srcRole)) return ws.emitMessage(ctx, `Unknown source role "${srcId}".`);
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
              await ws.applyActiveRole(defaultRoleId(ws.roles, ws.settings), ctx, true);
            }
            return ws.emitMessage(ctx, `Deleted custom role "${rest}".`);
          } catch (err) {
            return ws.emitMessage(ctx, err instanceof Error ? err.message : String(err));
          }
        }
        if (head === "off") {
          await ws.applyActiveRole(null, ctx, true);
          const uiText = "○ 已关闭总秘书模式，退回标准原生 OMP。";
          return ws.emitMessage(ctx, uiText, { cmdOutText: `${uiText}\nActive role: off` });
        }

        const rawTokens = trimmed.split(/\s+/).filter(Boolean);
        const forceForeground = rawTokens.includes("--foreground");
        const roleIdToken = rawTokens.find((t) => t !== "--foreground") ?? "";
        const role = ws.roles.get(roleIdToken);
        if (roleIdToken === "supervisor" || (role && isInternalRole(role))) {
          return ws.emitMessage(ctx, '角色 "supervisor" 为内部督导组件，不可直接激活；请在 /settings → Plugins → omp-enhance 中配置。');
        }
        if (!role) return ws.emitMessage(ctx, `Unknown role "${roleIdToken}". Use /role list.`);

        if (!canRoleDispatch(role) && !forceForeground) {
          if (ctx?.hasUI && typeof ctx?.ui?.select === "function") return openRoleEditor(role.id, studioDeps());
          return ws.emitMessage(
            ctx,
            [
              `# Role: ${role.id} [${role.source}] — ${role.description || role.name}`,
              `模型=${role.model ?? "inherit"} · 推理=${role.thinking ?? "inherit"}`,
              "提示: 后台专员由 /coord 总秘书自动调度，不会接管当前前台会话；如需定制模型请在 /role 面板配置。",
            ].join("\n"),
          );
        }

        await ws.applyActiveRole(role.id, ctx, true);
        if (canRoleDispatch(role)) {
          const uiText = "✓ 总秘书模式已开启 — 直接用自然语言描述需求，方案确认后自动派发后台专员（输入 /coord off 退回标准 OMP）。";
          return ws.emitMessage(ctx, uiText, { cmdOutText: `${uiText}\nActive role: ${role.id} [${role.source}]` });
        }
        ws.emitMessage(ctx, `Active role: ${role.id} [${role.source}]`);
      } catch (err) {
        hub.getWorkspace(ctx).emitMessage(ctx, err instanceof Error ? err.message : String(err));
      }
    },
  });

  pi.registerCommand("flow", {
    description: "打开跨项目只读监控窗 (/flow)、查看进度 (/flow status) 或紧急停止 (/flow cancel [flowId]).",
    getArgumentCompletions: (prefix: string) => {
      if (/^cancel\s+/i.test(prefix)) {
        const head = prefix.match(/^cancel\s+/i)![0];
        const q = prefix.slice(head.length).trim().toLowerCase();
        return hub.getAllFlowSummaries()
          .filter((s) => (s.status === "running" || s.resumable) && s.flowId && (!q || s.flowId.toLowerCase().startsWith(q)))
          .map((s) => ({ value: `${head}${s.flowId}`, label: s.flowId!, description: `${s.cwd} [${s.status}]` }));
      }
      const q = prefix.trim().toLowerCase();
      return ["status", "cancel"]
        .filter((v) => !q || v.startsWith(q))
        .map((v) => ({ value: v, label: v }));
    },
    handler: async (args: string, ctx: any) => {
      try {
        const ws = hub.getWorkspace(ctx);
        ws.refresh(ctx);
        const { head: first, rest: restRaw } = splitHeadAndRest(args);
        if (!first || first === "hub" || first === "room" || first === "monitor") {
          return ctx?.hasUI
            ? openFlowRoomOverlay({ ctx, getTargets: () => hub.getMonitorTargets(ws) })
            : ws.emitMessage(ctx, renderMultiProjectFlowStatus(hub, ws));
        }
        if (first === "status") {
          return ws.emitMessage(ctx, renderMultiProjectFlowStatus(hub, ws));
        }
        if (first === "cancel" || first === "stop") {
          const res = await executeCancelFlow(hub, ws, { flowId: restRaw || undefined }, ctx);
          return ws.emitMessage(
            ctx,
            res.cancelled
              ? `已中止项目 ${res.cwd} 的协作 Flow (${res.flowId ?? "flow"})。`
              : (res.reason ?? "当前没有正在运行的协作 Flow。"),
          );
        }
        return ws.emitMessage(
          ctx,
          "用法: /flow (打开跨项目只读监控窗) | /flow status | /flow cancel [flowId] — 派发或续跑任务请敲 /coord 用自然语言吩咐总秘书。",
        );
      } catch (err) {
        hub.getWorkspace(ctx).emitMessage(ctx, err instanceof Error ? err.message : String(err));
      }
    },
  });
}
