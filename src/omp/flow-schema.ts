export interface SchemaKitLike {
  str: () => unknown;
  num: () => unknown;
  bool: () => unknown;
  arr: (item: unknown) => unknown;
  en: (values: readonly string[]) => unknown;
  anyOf?: (variants: readonly unknown[]) => unknown;
  obj: (props: Record<string, unknown>, req: string[]) => unknown;
}

export function buildFlowToolParameters(kit: SchemaKitLike): unknown {
  const briefObj = kit.obj(
    { owns: kit.str(), nonGoals: kit.arr(kit.str()), acceptance: kit.arr(kit.str()), contextRefs: kit.arr(kit.str()) },
    ["owns", "acceptance"],
  );
  const brief = kit.anyOf ? kit.anyOf([kit.str(), briefObj]) : kit.str();
  const landingEnum = kit.en(["apply", "branch_preview"]);
  const conflictEnum = kit.en(["spawn_resolver", "ask_human", "fail"]);
  const wsEnum = kit.en(["inherit", "worktree"]);

  const gateProps = {
    id: kit.str(), command: kit.str(), cwd: kit.str(), timeoutSec: kit.num(),
    expectExitCode: kit.num(), parseJsonMetricsPath: kit.str(), repairTargetNodeId: kit.str(),
  };
  const mergeProps = {
    id: kit.str(), sourceNodeIds: kit.arr(kit.str()), landingMode: landingEnum,
    conflictPolicy: conflictEnum, resolverRoleId: kit.str(),
  };
  const gateCfg = kit.obj(gateProps, ["command"]);
  const nodeMergeCfg = kit.obj(mergeProps, ["sourceNodeIds"]);
  const presetMergeCfg = kit.obj(mergeProps, []);
  const humanCfg = kit.obj({ prompt: kit.str(), options: kit.arr(kit.str()), allowFreeText: kit.bool() }, ["prompt"]);
  const nativeTaskCfg = kit.obj(
    { agent: kit.str(), tasks: kit.arr(kit.obj({ id: kit.str(), prompt: kit.str() }, ["id", "prompt"])) },
    ["agent", "tasks"],
  );

  const nodeSchema = kit.obj({
    id: kit.str(), title: kit.str(), kind: kit.en(["role", "gate", "merge", "human", "native_task"]),
    role: kit.str(), dependsOn: kit.arr(kit.str()), join: kit.en(["all", "any"]), brief,
    writableScope: kit.arr(kit.str()), workspace: wsEnum, sessionMode: kit.en(["fresh", "reuse", "fork"]),
    forkFromNodeId: kit.str(), fallbackModels: kit.arr(kit.str()), repairTargetNodeId: kit.str(),
    maxAttempts: kit.num(), stallTimeoutSec: kit.num(), skipOnUpstreamFail: kit.bool(),
    gate: gateCfg, merge: nodeMergeCfg, human: humanCfg, nativeTask: nativeTaskCfg,
  }, ["id"]);

  const shardSchema = kit.obj({
    id: kit.str(), title: kit.str(), role: kit.str(), brief,
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
    message: kit.str(), maxRepairRounds: kit.num(), initialHandoffId: kit.str(), wait: kit.bool(),
  }, []);
}
