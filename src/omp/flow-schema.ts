export interface SchemaKitLike {
  str: () => unknown;
  num: () => unknown;
  bool: () => unknown;
  arr: (item: unknown) => unknown;
  en: (values: readonly string[]) => unknown;
  anyOf?: (variants: readonly unknown[]) => unknown;
  rec?: (value: unknown) => unknown;
  obj: (props: Record<string, unknown>, req: string[]) => unknown;
}

export function buildFlowToolParameters(kit: SchemaKitLike): unknown {
  const briefObj = kit.obj(
    { owns: kit.str(), nonGoals: kit.arr(kit.str()), acceptance: kit.arr(kit.str()), contextRefs: kit.arr(kit.str()) },
    ["owns", "acceptance"],
  );
  const brief = kit.anyOf ? kit.anyOf([kit.str(), briefObj]) : kit.str();
  const landingEnum = kit.en(["apply", "branch_preview"]);
  const conflictEnum = kit.en(["ask_human", "fail"]);
  const wsEnum = kit.en(["inherit", "worktree"]);

  const gateCfg = kit.obj({
    id: kit.str(), command: kit.str(), cwd: kit.str(), timeoutSec: kit.num(),
    expectExitCode: kit.num(), parseJsonMetricsPath: kit.str(), repairTargetNodeId: kit.str(),
  }, ["command"]);
  const mergeProps = {
    id: kit.str(), sourceNodeIds: kit.arr(kit.str()), landingMode: landingEnum, conflictPolicy: conflictEnum,
  };
  const nodeMergeCfg = kit.obj(mergeProps, ["sourceNodeIds"]);
  const presetMergeCfg = kit.obj(mergeProps, []);
  const humanActionEnum = kit.en(["proceed", "hold", "cancel"]);
  const humanCfg = kit.obj({
    prompt: kit.str(),
    options: kit.arr(kit.str()),
    allowFreeText: kit.bool(),
    mode: kit.en(["approval", "input"]),
    ...(kit.rec ? { optionActions: kit.rec(humanActionEnum) } : {}),
  }, ["prompt"]);

  const nodeSchema = kit.obj({
    id: kit.str(), title: kit.str(), kind: kit.en(["role", "gate", "merge", "human"]),
    role: kit.str(), dependsOn: kit.arr(kit.str()), join: kit.en(["all", "any"]), brief,
    tools: kit.arr(kit.str()), writableScope: kit.arr(kit.str()), requiredChecks: kit.arr(kit.str()),
    workspace: wsEnum, sessionMode: kit.en(["fresh", "reuse"]), sessionGroup: kit.str(),
    fallbackModels: kit.arr(kit.str()), repairTargetNodeId: kit.str(), maxAttempts: kit.num(),
    stallTimeoutSec: kit.num(), skipOnUpstreamFail: kit.bool(),
    gate: gateCfg, merge: nodeMergeCfg, human: humanCfg,
  }, ["id"]);

  const shardSchema = kit.obj({
    id: kit.str(), title: kit.str(), role: kit.str(), brief, tools: kit.arr(kit.str()),
    writableScope: kit.arr(kit.str()), workspace: wsEnum, fallbackModels: kit.arr(kit.str()),
  }, ["role", "brief"]);

  const policiesSchema = kit.obj({
    maxConcurrency: kit.num(), maxRepairRounds: kit.num(),
    workspaceStrategy: kit.en(["auto_worktree", "strict_scope", "inherit_only"]),
    pauseOnWaitingInput: kit.en(["branch_only", "whole_flow"]), enableSessionReuse: kit.bool(),
  }, []);

  const patchSchema = kit.obj({
    addNodes: kit.arr(nodeSchema), skipNodeIds: kit.arr(kit.str()),
    rewireDeps: kit.arr(kit.obj({ nodeId: kit.str(), dependsOn: kit.arr(kit.str()) }, ["nodeId", "dependsOn"])),
  }, []);

  const contractSchema = kit.obj({ id: kit.str(), role: kit.str(), brief, writableScope: kit.arr(kit.str()) }, ["brief"]);
  const joinRoleSchema = kit.obj({ id: kit.str(), role: kit.str(), title: kit.str(), brief }, ["role"]);

  return kit.obj({
    action: kit.en(["start", "status", "list", "steer", "cancel", "resume", "patch"]),
    cwd: kit.str(), flowId: kit.str(), nodeId: kit.str(), roles: kit.arr(kit.str()), goal: kit.str(),
    preset: kit.en(["linear", "fan_out_join", "contract_parallel_verify", "experiment_loop", "custom"]),
    nodes: kit.arr(nodeSchema), policies: policiesSchema, patch: patchSchema,
    shards: kit.arr(shardSchema), workers: kit.arr(shardSchema), contract: contractSchema,
    merge: presetMergeCfg, gate: gateCfg, joinRole: joinRoleSchema, landingMode: landingEnum,
    gateCommand: kit.str(), reviewerRole: kit.str(), scorerCommand: kit.str(),
    workerRole: kit.str(), workerBrief: brief, metricsPath: kit.str(),
    message: kit.str(), maxRepairRounds: kit.num(), initialHandoffId: kit.str(), wait: kit.bool(), confirmed: kit.bool(),
  }, []);
}
