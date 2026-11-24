# 交接协议与 YAML 角色编写指南

本文定义 `omp-enhance` 的纯 YAML 角色规范（`RoleSpec`）、三级角色发现与跨目录信任门禁、跨主体标准交接包（`HandoffEnvelope`）以及 SQLite **7 张表**持久化结构。

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

# 可选：标记为系统内部角色（默认 false；设为 true 时如 supervisor 从用户角色选择器、Role Studio 与 /role 激活入口中隐藏）
internal: false

# 必填：认知立场（决定模型默认关注点与怀疑先验，序列化统一采用 |2 块标量无损保留前导空格）
stance: |2
  证伪优先：在看到本轮真实测试运行输出前，默认上游实现存在未覆盖边界或缺陷；
  不采信上游自评，禁止顺着业务实现代码抄写必过断言。

# 必填：有序方法论步骤（至少 1 条非空字符串）
method:
  - 对照原始 Mandate 独立列出正常、边界与异常测试点
  - 编写或补充测试代码并真实执行，获取退出码与输出证据
  - 发现缺陷时附最小复现命令标为 rejected 打回；全部通过标为 ready

# 可选：工具与目录边界（整块省略表示沿用常规全量权限）
# 保护机制分两层：编辑工具 (write/edit/apply_patch/ast_edit) 执行事前路径拦截；
# 开放 bash 的角色在阶段结束交接时执行全目录内容摘要快照比对（越界修改判 violation 拒收；若需命令运行期间源码全程严格只读，请在隔离工作区或只读挂载下执行）
permissions:
  # 可选：允许的宿主工具列表；只读脚手架 (--readonly) 默认收敛为只读工具白名单
  tools: [read, grep, glob, find, lsp, edit, write, apply_patch, bash, task, wait]
  # 可选：允许被写入或改动的相对路径 glob（支持 {a,b} 花括号语法）；[] 表示纯只读
  writable: ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"]
  # 可选：运行期间严禁发生任何字节变更的相对路径 glob（落库前自动校验 protected + writable + .omp 完整性）
  protected: ["src/**"]
  # 可选：纯总控派单权（默认 false；coordinator 设为 true 时事前拦截一切直接文件写/Shell 命令、禁用 enhance_handoff 与 enhance_job(action="start")，仅开放跨项目 enhance_flow 派单、enhance_job 状态巡检/取消与 enhance_mandate）
  dispatch: false

# 可选：准出硬判据（仅在 verdict === "ready" 时强制校验；verdict === "needs_input" 或 "blocked" 可在材料未齐时合法挂起/阻断）
exit:
  # 声明 ready 时，本轮是否必须至少有一次非报错的真实工具执行证据（默认 false）
  require_tool_evidence: true
  # 可选：声明 ready 时必须在本轮非报错调用过的工具名列表（如 qa 要求 ["bash"]，非报错 bash 或 enhance_job 均可满足）
  required_tools: ["bash"]
  # 可选：声明 ready 时工作区快照必须存在的交付产物 glob 列表（如 algo 要求 ["algo_work/REPORT.md", "algo_work/runs/**/metrics.json"]，缺件时精确报错指出缺失模式）
  required_artifacts: []
  # 交付前必须逐条核对的准出条件列表
  criteria:
    - 核心验收条件均有本轮真实测试运行记录支撑
    - 受保护目录 src/** 未发生任何字节变动
```

### 1.2 最小合法自定义专员示例（30 秒手写）

> **设计建议（`Role × Project Context/Skills`）**：项目专属的框架规范、代码风格、接口约定与常用命令应写在项目根目录的 `AGENTS.md` 或领域 `Skills` 中（后台专员进入该目录时会自动加载）。仅当需要**新的工作立场或硬目录边界规则**时，才新建 `Role YAML`。

```yaml
id: docs-writer
description: 只读源码核实契约、仅允许修改文档目录的技术文档专员
stance: |2
  文档中的每个配置项、命令与参数必须与真实源码逐一核对，绝不凭印象编造未实现特性。
method:
  - 使用只读工具核对目标源码中的真实接口、默认值与错误提示
  - 在 docs/** 与 README.md 范围内完成精确更新
  - 调用 enhance_handoff 提交变更产物与核实依据
permissions:
  tools: [read, grep, glob, find, ls, lsp, edit, write, apply_patch]
  writable: ["README.md", "docs/**"]
  protected: ["src/**", "test/**"]
exit:
  require_tool_evidence: true
  required_artifacts: ["README.md"]
```

### 1.3 三级发现目录与跨目录独立信任门禁

按以下优先级从高到低合并（支持指向合法 YAML 文件的符号链接；单文件语法错误隔离记录告警，绝不阻塞其余角色加载）：
1. **项目级 (`project`)**：`<目标工作区>/.omp/roles/*.{yaml,yml}`
   - **按目标目录独立校验信任状态**：主工作区使用宿主 `ctx.isProjectTrusted()` 判定；跨目录派单至外部目录 `B` 时，绝不继承发起目录 `A` 的信任状态——若宿主未对 `B` 提供路径级信任判定，须由用户显式执行 `/coord trust <B>`（持久化于 `~/.omp/enhance/trusted-projects.json`，可用 `/coord untrust <B>` 撤销）后才加载 `B/.omp/*` 项目覆盖，否则仅使用全局与内置配置并给出未启用提示。
2. **个人全局级 (`global`)**：`~/.omp/enhance/roles/*.{yaml,yml}`（支持 OMP `--profile` 隔离目录，`/role create` 默认保存位置）
3. **插件内置 (`builtin`)**：`<omp-enhance>/roles/*.yaml`，共 **8 个内置文件**（默认开机会话处于 `"off"` 标准模式，敲 `/coord` 激活 `coordinator`）：
   - **总控入口（1 个）**：`coordinator`（`dispatch: true`，只读探路 + 跨项目派发专员链）
   - **后台专员（6 个）**：`planner`（探查与规划）、`dev`（构建与修改）、`algo`（防泄漏实验调优，准出强制核验 `algo_work/REPORT.md` 与 `metrics.json`）、`qa`（测试目录限定证伪，准出强制核验 `required_tools: ["bash"]`）、`reviewer`（代码与架构方案静态盲审）、`vision`（默认 `@vision` 视觉图表诊断）
   - **内部巡检角色（1 个）**：`supervisor`（`internal: true`、默认 `@advisor` + `thinking: inherit`）

### 1.4 内部监督角色 (`supervisor`) 裁决契约

`roles/supervisor.yaml` 是隐藏的无工具运行期巡检角色（`internal: true`、`model: "@advisor"`、`thinking: inherit`、`permissions.tools: []`）。它周期性读取 `SupervisorPulse`（含巡检序号、总耗时、静默时长、阶段权限 `roleId` / `readOnly` / `allowedTools`、原生异步任务数 `activeAsyncJobs`、定界隔离的 `untrusted_log_tail`、运行中 `activeTool` 及最近 5 次 `priorDecisions`），严禁要求只读或无 `bash` 阶段执行 Shell 命令，并输出单个 JSON 对象（`continue` | `steer` | `abort`）。

---

## 2. 标准交接包 (`HandoffEnvelope`)

所有后台专员收束阶段结论、中途咨询 `vision`（`delegateNow: true`）或挂起请示用户时，均在通过目录边界与准出条件核验后生成同一结构：

| 字段 | 类型 | 含义与校验规则 |
| --- | --- | --- |
| `id` | `string` | 唯一交接包 UUID |
| `mandateId` / `mandateRev` | `string` / `number` | 绑定的原始用户需求契约及修订版本号 |
| `parentHandoffId` | `string \| null` | 上游交接包 ID（构成可追溯的完整交接链） |
| `fromRole` | `string` | 产出该交接包的角色 ID |
| `toTarget` | `"user" \| string` | 接收目标（`"user"`、下游角色 ID，或 `rejected` 时指向首个可写返修角色） |
| `verdict` | `"ready" \| "needs_input" \| "rejected" \| "blocked"` | `ready`：通过 `required_tools` / `required_artifacts` 核验后向下游推进；`needs_input`：遇业务分叉点挂起为 `waiting_input`（0 Token 空耗，释放项目租约）并唤醒 `coordinator` 请示用户；`rejected`：发现阻断缺陷——前序含可写专员（如 `dev → qa`）则自动打回返修，整条链均为纯只读审计（如单跑 `reviewer`）则审计完结为 `status: "completed"`，若存在尚未执行的下游可写交付阶段（如 `planner → dev → qa` 中 `planner` 首轮 `rejected`）则收束为 `status: "blocked"` 并保持 `Mandate` 活跃；`blocked`：外部前置条件缺失 |
| `summary` | `string` | 交付成果、挂起背景或打回结论的精炼摘要 |
| `questionsForUser` | `string[] \| undefined` | 当 `verdict === "needs_input"` 时附带的简明通俗待决策问题列表，支持按 `flowId` 接收用户答复并在 `resume` 后注入续跑上下文 |
| `artifacts` | `ArtifactRecord[]` | 自动扫描工作区新增/修改/匹配交付文件并记录 `{ path, sha256, digestKind, byteSize, role }`：`<= 512 MiB` 文件采用 64 KiB 分块流式计算真实 `sha256`（`digestKind: "sha256"`），`> 512 MiB` 文件记录 `stat:<size>:<mtime>` 并明确标为 `digestKind: "stat_fingerprint"`；未变被审文件 `role` 标为 `"inspected"` |
| `deletedFiles` | `string[] \| undefined` | 本阶段相对基线被删除的文件路径列表，随条件块同步告知下游 |
| `verifiedFacts` | `{ claim, evidenceRef }[]` | 已验证结论列表，`evidenceRef` 必须命中本轮**非报错真实执行 `toolCallId`** 或有效工作区路径/行号选择器（带 `:line` / `:start-end` / `#Lstart-Lend` 行号引用时强制核验 `1 <= start <= end <= 文件实际总行数`，越界行号直接拒收） |
| `openRisks` | `string[]` | 诚实披露的未覆盖边界、已知限制或待下游重点核查的疑点 |
| `feedbackForUpstream` | `string \| null` | 当 `verdict === "rejected"` 时必填最小复现步骤与期望/实际差异 |
| `observedUsage` | `UsageSummary \| null` | 被动归一化的实测 `{ inputTokens, outputTokens, costUsd }`（不作阻断限制） |

---

## 3. SQLite 持久化表结构 (`.omp-enhance/state.sqlite`)

每个目标项目下的 `.omp-enhance/state.sqlite` 按需惰性创建（纯只读查询不建空库、不脏写 WAL；首次建目录时自动写入 `.omp-enhance/.gitignore` `*`；跨子项目索引与信任记录分别存于 `~/.omp/enhance/{hub-projects,trusted-projects}.json`），启用 `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;`，共包含 **7 张表**：

1. **`mandates`**：保存原始目标、硬约束数组、验收标准数组、版本号 `rev`、状态（`active` | `completed` | `archived`）及 `session_id` / `flow_id` 作用域字段。
2. **`epistemic_items`**：外键关联 `mandates(id)` 的认知黑板条目（`fact` | `hypothesis` | `inquiry` | `decision`）；`CHECK` 约束强制 `fact` 附带非空 `evidence_ref`。
3. **`artifacts`**：外键关联 `mandates(id)`，按 `(mandate_id, path, sha256)` 记录文件指纹与 `digest_kind`（`"sha256"` 或 `"stat_fingerprint"`）。
4. **`handoffs`**：外键关联 `mandates(id)`，完整持久化历次 `HandoffEnvelope`（含 `deleted_files`、`verified_facts`、`questions_for_user` 与 `observed_usage`）及父子链路。
5. **`jobs`**：**先校验外键并落库登记（`pid=0, status="running"`）再派生子进程**——登记失败时零命令副作用，派生失败时记录 `[spawn_error]` 并置为 `status: "failed"` 可查询；正常作业通过原子 `.exit` 与进程启动指纹支撑跨重启对账。
6. **`flow_runs`**：外键关联 `mandates(id)`，持久化各 `flow_id` 检查点（区分可恢复的 `waiting_input` / `interrupted` / `failed` 与不可恢复的 `violation`），支持通过 `appendFlowCheckpointSteer` 与 `cancelFlowCheckpoint` 按指定 `flowId` 独立留言或取消而不干扰同项目其他在途任务。
7. **`project_leases`**：以 `BEGIN IMMEDIATE` 事务维护单项目执行互斥租约（`lease_key = 'active_flow'`, `flow_id`, `owner_pid`, `owner_start_token`, `acquired_at`），阻断跨进程或双实例同目录并发双跑，并在原属主进程异常退出后自动将孤儿 `running` 记录转为 `interrupted` 并安全移交执行权。
