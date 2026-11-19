import { writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";

/**
 * Phase 0 live runtime probe extension for Oh My Pi.
 * Verifies official public ExtensionAPI, Bun.YAML, bun:sqlite,
 * credential/model inheritance via ctx.modelRegistry, and isolated
 * helper session lifecycle via pi.pi.createAgentSession + dispose().
 */
export default function phase0ProbeExtension(pi: any): void {
  const eventsSeen: string[] = [];

  pi.on("session_start", () => {
    eventsSeen.push("session_start");
  });

  pi.on("before_agent_start", (event: any) => {
    eventsSeen.push("before_agent_start");
    return {
      systemPrompt: [...(event.systemPrompt ?? []), "PHASE0_CONDITIONING_MARKER"],
    };
  });

  pi.on("tool_call", () => {
    eventsSeen.push("tool_call");
    return undefined;
  });

  pi.registerCommand("phase0-verify", {
    description: "Run Phase 0 live host capability probe and write JSON report",
    async handler(_args: string, ctx: any) {
      const reportPath = process.env.OMP_ENHANCE_PROBE_OUT;
      const report: Record<string, unknown> = {
        ok: false,
        eventsSeen,
      };

      try {
        // 1. Verify Bun.YAML native parser inside OMP runtime
        const parsedYaml = Bun.YAML.parse("id: qa\nmethod:\n  - step1\n") as Record<string, unknown>;
        report.bunYamlOk = parsedYaml?.id === "qa" && Array.isArray(parsedYaml?.method);

        // 2. Verify bun:sqlite WAL inside OMP runtime
        const db = new Database(":memory:");
        db.exec("CREATE TABLE probe (id TEXT PRIMARY KEY, val TEXT NOT NULL);");
        db.query("INSERT INTO probe (id, val) VALUES (?, ?)").run("k1", "v1");
        const row = db.query("SELECT val FROM probe WHERE id = ?").get("k1") as { val: string } | null;
        db.close();
        report.bunSqliteOk = row?.val === "v1";

        // 3. Verify public SDK & inherited modelRegistry / model / settings
        const sdk = pi.pi;
        const hasCreateAgentSession = typeof sdk?.createAgentSession === "function";
        report.hasCreateAgentSession = hasCreateAgentSession;
        report.hasSetActiveTools = typeof pi.setActiveTools === "function";
        report.currentModel = ctx.model
          ? { provider: ctx.model.provider, id: ctx.model.id }
          : null;
        report.hasModelRegistry = Boolean(ctx.modelRegistry);
        report.hasAuthStorage = Boolean(ctx.modelRegistry?.authStorage);

        // 4. Spin up an isolated child session inheriting ctx.modelRegistry & ctx.model
        let childCreated = false;
        let childModelMatch = false;
        let childDisposed = false;
        if (hasCreateAgentSession) {
          const created = await sdk.createAgentSession({
            cwd: ctx.cwd,
            modelRegistry: ctx.modelRegistry,
            ...(ctx.model ? { model: ctx.model } : {}),
            settings: sdk.settings,
            bindProcessState: false,
            disableExtensionDiscovery: true,
            noContextFiles: true,
            enableMCP: false,
            enableLsp: false,
            toolNames: ["read"],
            restrictToolNames: true,
          });
          childCreated = Boolean(created?.session);
          const childModel = created?.session?.model;
          childModelMatch = ctx.model
            ? childModel?.provider === ctx.model.provider && childModel?.id === ctx.model.id
            : true;
          await created.session.dispose();
          childDisposed = true;
        }

        report.childCreated = childCreated;
        report.childModelMatch = childModelMatch;
        report.childDisposed = childDisposed;
        report.ok = Boolean(
          report.bunYamlOk &&
            report.bunSqliteOk &&
            report.hasCreateAgentSession &&
            report.hasSetActiveTools &&
            report.hasModelRegistry &&
            report.hasAuthStorage &&
            childCreated &&
            childModelMatch &&
            childDisposed,
        );
      } catch (error) {
        report.error = error instanceof Error ? error.stack ?? error.message : String(error);
      }

      if (reportPath) {
        writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
      }
    },
  });
}
