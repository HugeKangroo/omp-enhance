# 交接协议与 YAML 角色编写指南

本文定义 `omp-enhance` 的纯 YAML 角色规范（`RoleSpec`）、三级角色发现机制、跨主体标准交接包（`HandoffEnvelope`）以及 SQLite 持久化表结构。

---

## 1. 纯 YAML 角色规范 (`RoleSpec`)

每个角色定义为一个 `.yaml`（或 `.yml`，同目录重名时优先 `.yaml` 并在保存时自动清理旧 `.yml`）文件，由 `src/roles/serializer.ts` 基于 Bun 原生 `Bun.YAML.parse()` 严格解析校验。

### 1.1 完整字段说明

```yaml
# 必填：唯一角色标识（字母、数字、连字符或下划线，需与文件名严格区分大小写一致）
id: qa

# 可选：人类可读名称与一句话简介（省略 name 时默认取 id）
name: 独立测试与证伪工程师
description: 基于原始需求独立构造正常、边界与异常测试，证伪上游实现

# 可选：为该角色绑定专属模型与推理档位（省略或显式设为 "inherit" 表示优先继承 @<role> 配置的 :thinking 后缀，否则沿用当前会话档位）
# 支持 OMP 模型角色别名（@advisor, @vision, @default, @smol, @slow, @plan, @task）或精确 provider/model-id
# thinking 支持：inherit | off | minimal | low | medium | high | xhigh | max | auto
model: "@slow"
thinking: high

# 必填：认知立场（决定模型默认关注点与怀疑先验，序列化统一采用 |2 块标量无损保留前导空格）
stance: |2
  证伪优先：在看到本轮真实测试运行输出前，默认上游实现存在未覆盖边界或缺陷；
  不采信上游自评，禁止顺着业务实现代码抄写必过断言。

# 必填：有序方法论步骤（至少 1 条非空字符串）
method:
  - 对照原始 Mandate 独立列出正常、边界与异常测试点
  - 编写或补充测试代码并真实执行，获取退出码与输出证据
  - 发现缺陷时附最小复现命令标为 rejected 打回；全部通过标为 ready

# 可选：物理工具与路径边界（整块省略表示沿用常规全量权限）
permissions:
  # 可选：允许的宿主工具列表；只读脚手架 (--readonly) 默认收敛为只读工具白名单
  # 伴随工具按角色边界同构授权：enhance_mandate / enhance_handoff 常驻可用；
  # enhance_job (start/watch/cancel) 仅对非只读且允许 bash 的角色开放；只读角色禁止通过委托提权修改文件
  tools: [read, grep, lsp, edit, write, apply_patch, bash]
  # 可选：允许被写入或改动的相对路径 glob（支持 {a,b} 花括号语法）；[] 表示纯只读
  writable: ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"]
  # 可选：运行期间严禁发生任何字节变更的相对路径 glob（落库前自动校验 protected + writable + .omp 完整性）
  protected: ["src/**"]

# 可选：准出硬判据
exit:
  # 声明 ready 时，本轮是否必须至少有一次非报错的真实执行证据（含常规工具或 enhance_job，默认 false）
  require_tool_evidence: true
  # 交付前必须逐条核对的准出条件列表
  criteria:
    - 核心验收条件均有本轮真实测试运行记录支撑
    - 受保护目录 src/** 未发生任何字节变动
```

### 1.2 最小合法角色示例（30 秒手写）

不需要物理限制时，仅写 `id`、`stance`、`method` 即可直接加载运行：

```yaml
id: api-designer
description: 接口契约与兼容性设计角色
stance: |2
  优先保证接口最小惊讶原则、向后兼容与错误码语义清晰。
method:
  - 明确调用方场景、输入不变量与失败模式
  - 给出清晰的类型签名与边界示例
  - 标注潜在破坏性变更风险
```

### 1.3 三级发现目录与安全优先级

按以下优先级从高到低合并（单文件语法错误隔离记录告警，绝不阻塞其余合法角色加载）：
1. **项目级 (`project`)**：`<当前工作区>/.omp/roles/*.{yaml,yml}`（**仅在当前工作区通过 OMP `ctx.isProjectTrusted()` 信任校验时加载**，防止克隆未信任仓库时被静默注入系统提示词或设置）
2. **个人全局级 (`global`)**：`~/.omp/enhance/roles/*.{yaml,yml}`（支持 OMP `--profile` 隔离目录，`/role create` 默认保存位置）
3. **插件内置 (`builtin`)**：`<omp-enhance>/roles/{general,algo,vision,dev,qa,reviewer,ml-engineer,supervisor}.yaml`（默认会话基态为 `general`）

### 1.4 内置监督角色 (`supervisor`) 与 `@advisor` 默认继承

`roles/supervisor.yaml` 是只读、无工具的运行期巡检角色：`model: "@advisor"`、`thinking: inherit`、`permissions.tools: []`、`permissions.writable: []`、`permissions.protected: ["**"]`（不参与 `/flow` 或 `/enhance-handoff` 业务阶段转手）。默认自动继承用户在 OMP 中配置的 **`@advisor`** 模型角色及其 `:thinking` 推理档位（`supervisorThinking: "inherit"`，支持 `off` 至 `max` / `auto` 全部档位），也可在 **`/settings → Plugins → omp-enhance`** 修改 `supervisorModel` / `supervisorThinking`，或在 `/role edit supervisor` 中单独覆盖。

它周期性读取 `SupervisorPulse`（包含目标、巡检序号、总耗时、静默时长、本周期增量、阶段权限元数据 `roleId` / `readOnly` / `allowedTools`、OMP 原生后台异步任务数 `activeAsyncJobs`、定界隔离的 `untrusted_log_tail`、正在运行的 `activeTool` 及最近 5 次 `priorDecisions`），严禁要求只读或无 `bash` 阶段运行 Shell 命令，并输出单个 JSON 对象：

| 裁决 | 适用目标 | 行为 |
| --- | --- | --- |
| `continue` | `role_session` / `job` | 保持任务运行；`nextCheckSec` 钳制到 `[5, 600]` 秒作为下次巡检间隔 |
| `steer` | 仅 `role_session` | 保持子会话运行，将纠偏指令以 `[Supervisor]: ...` 前缀注入 `session.steer` |
| `abort` | `role_session` / `job` | 必须提供非空异常依据；后台作业经进程启动指纹核验后终止进程组（超时自动升级 `SIGKILL`），角色子会话调用 `session.abort()`，若目标尚未自然完成则返回 `aborted_by_supervisor` |

运行期安全语义：初始延迟默认 30 秒，任务在首次巡检前结束则产生 **0 次**监督调用；监督模型报错或返回非法 JSON 时 **fail-open** 并按 `30s → 60s → 120s...` 指数退避重试。

---

## 2. 标准交接包 (`HandoffEnvelope`)

无论是日常单角色向用户收尾（`toTarget: "user"`），还是通过 `/enhance-handoff` / `/flow` 跨角色转手（如 `toTarget: "qa"`），均在通过边界完整性核验后生成同一结构：

| 字段 | 类型 | 含义与校验规则 |
| --- | --- | --- |
| `id` | `string` | 唯一交接包 UUID |
| `mandateId` / `mandateRev` | `string` / `number` | 绑定的原始用户需求契约及修订版本号 |
| `parentHandoffId` | `string \| null` | 上游交接包 ID（构成可追溯的完整交接链） |
| `fromRole` | `string` | 产出该交接包的角色 ID |
| `toTarget` | `"user" \| string` | 接收目标（`"user"`、下游角色 ID，或 `rejected` 时指向首个可写返修角色） |
| `verdict` | `"ready" \| "rejected" \| "blocked"` | `ready`：完成可向下游推进；`rejected`：证伪打回返修；`blocked`：外部前置条件缺失 |
| `summary` | `string` | 交付成果或打回结论的精炼摘要 |
| `artifacts` | `ArtifactRecord[]` | 自动扫描工作区新增/修改文件并计算 `{ path, sha256, byteSize, role }` |
| `deletedFiles` | `string[] \| undefined` | 本阶段相对基线被删除的文件路径列表，随条件块同步告知下游 |
| `verifiedFacts` | `{ claim, evidenceRef }[]` | 已验证结论列表，`evidenceRef` 必须命中本轮**非报错真实执行 `toolCallId`** 或当前有效产物哈希/路径，并透传注入下游条件块 |
| `openRisks` | `string[]` | 诚实披露的未覆盖边界、已知限制或待下游重点核查的疑点 |
| `feedbackForUpstream` | `string \| null` | 当 `verdict === "rejected"` 时必填最小复现步骤与期望/实际差异 |
| `observedUsage` | `UsageSummary \| null` | 被动归一化的实测 `{ inputTokens, outputTokens, costUsd }`（不作阻断限制） |

---

## 3. SQLite 持久化表结构 (`.omp-enhance/state.sqlite`)

数据库启用 `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;` 及二级索引，共包含 **6 张表**：

1. **`mandates`**：保存原始用户目标、硬约束数组、验收标准数组、版本号 `rev`、状态（`active` | `completed` | `archived`）以及 `session_id` / `flow_id` 作用域隔离字段（Flow 正常完成时自动收束为 `completed`，避免跨会话污染后续无关对话）。
2. **`epistemic_items`**：外键关联 `mandates(id)` 的认知黑板条目（`fact` | `hypothesis` | `inquiry` | `decision`）；数据库级 `CHECK` 约束强制 `fact` 必须附带非空 `evidence_ref`。
3. **`artifacts`**：外键关联 `mandates(id)`，按 `(mandate_id, path, sha256)` 记录文件指纹，读取时按路径聚合最新快照版本。
4. **`handoffs`**：外键关联 `mandates(id)`，完整持久化历次 `HandoffEnvelope`（含 `deleted_files`、`verified_facts` 与 `observed_usage`）及父子链路。
5. **`jobs`**：记录后台无时限长作业（`job_id, mandate_id, hypothesis_id, command, cwd, pid, pgid, owner_pid, process_start_token, log_path, exit_file_path, status, exit_code, started_at, ended_at`），通过原子 `.exit` 写入、条件状态迁移与进程启动指纹支撑跨重启精准对账。
6. **`flow_runs`**：外键关联 `mandates(id)`，持久化双流协同房间检查点（`flow_id, role_chain, status, current_index, repair_round, last_handoff_id, owner_pid, owner_start_token, next_stage_seq, last_rejection_sig, user_steers, snapshot_json`），自动保留最近 50 条历史记录并保护正在活跃运行的属主进程不被新开终端误标为中断。
