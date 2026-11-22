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

# 可选：物理工具与路径边界（整块省略表示沿用常规全量权限）
permissions:
  # 可选：允许的宿主工具列表；只读脚手架 (--readonly) 默认收敛为只读工具白名单
  tools: [read, grep, glob, find, lsp, edit, write, apply_patch, bash, task, wait]
  # 可选：允许被写入或改动的相对路径 glob（支持 {a,b} 花括号语法）；[] 表示纯只读
  writable: ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"]
  # 可选：运行期间严禁发生任何字节变更的相对路径 glob（落库前自动校验 protected + writable + .omp 完整性）
  protected: ["src/**"]
  # 可选：纯总控派单权（默认 false；coordinator 设为 true 时物理拦截一切直接文件写/Shell 命令、禁用 enhance_handoff 与 enhance_job(action="start")，仅开放跨项目 enhance_flow 派单、enhance_job 状态巡检/取消与 enhance_mandate）
  dispatch: false

# 可选：准出硬判据
exit:
  # 声明 ready 时，本轮是否必须至少有一次非报错的真实执行证据（含常规工具或 enhance_job，默认 false）
  require_tool_evidence: true
  # 交付前必须逐条核对的准出条件列表
  criteria:
    - 核心验收条件均有本轮真实测试运行记录支撑
    - 受保护目录 src/** 未发生任何字节变动
```

### 1.2 最小合法自定义专员示例（30 秒手写）

> **设计建议（`Role × Project Context/Skills`）**：项目专属的框架规范、代码风格、接口约定与常用命令应写在项目根目录的 `AGENTS.md` 或领域 `Skills` 中（后台专员进入该目录时会自动加载）。仅当需要**新的认知立场或硬物理权限锁**时，才新建 `Role YAML`。

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
```

### 1.3 三级发现目录与内置第一性编制

按以下优先级从高到低合并（支持指向合法 YAML 文件的符号链接；单文件语法错误隔离记录告警，绝不阻塞其余角色加载）：
1. **项目级 (`project`)**：`<目标工作区>/.omp/roles/*.{yaml,yml}`（**仅在工作区通过 OMP `ctx.isProjectTrusted()` 信任校验时加载**）
2. **个人全局级 (`global`)**：`~/.omp/enhance/roles/*.{yaml,yml}`（支持 OMP `--profile` 隔离目录，`/role create` 默认保存位置）
3. **插件内置 (`builtin`)**：`<omp-enhance>/roles/*.yaml`，共 **8 个内置文件**（默认开机会话处于 `"off"` 标准模式，敲 `/coord` 激活 `coordinator`）：
   - **总控入口（1 个）**：`coordinator`（`dispatch: true`，纯只读探路 + 跨项目派发专员链）
   - **正交后台专员（6 个）**：`planner`（探查与规划）、`dev`（构建与修改）、`algo`（带真值防泄漏实验与四道报告门禁）、`qa`（测试目录限定动态证伪）、`reviewer`（代码与架构方案静态盲审）、`vision`（默认 `@vision` 视觉图表诊断）
   - **内部巡检角色（1 个）**：`supervisor`（`internal: true`、默认 `@advisor` + `thinking: inherit`）

### 1.4 内部监督角色 (`supervisor`) 裁决契约

`roles/supervisor.yaml` 是隐藏的无工具运行期巡检角色（`internal: true`、`model: "@advisor"`、`thinking: inherit`、`permissions.tools: []`）。它周期性读取 `SupervisorPulse`（包含巡检序号、总耗时、静默时长、阶段权限 `roleId` / `readOnly` / `allowedTools`、原生异步任务数 `activeAsyncJobs`、定界隔离的 `untrusted_log_tail`、运行中 `activeTool` 及最近 5 次 `priorDecisions`），严禁要求只读或无 `bash` 阶段执行 Shell 命令，并输出单个 JSON 对象：

| 裁决 | 适用目标 | 行为 |
| --- | --- | --- |
| `continue` | `role_session` / `job` | 保持任务运行；`nextCheckSec` 钳制到 `[5, 600]` 秒作为下次巡检间隔 |
| `steer` | 仅 `role_session` | 保持子会话运行，将纠偏指令以 `[Supervisor]: ...` 前缀注入 `session.steer` |
| `abort` | `role_session` / `job` | 必须提供非空异常依据；后台作业经进程启动指纹核验后终止进程组（超时升级 `SIGKILL`），专员子会话中止并清理其启动的残留 `enhance_job` |

---

## 2. 标准交接包 (`HandoffEnvelope`)

所有后台专员收束阶段结论、中途咨询 `vision`（`delegateNow: true`）或挂起请示用户时，均在通过物理读写边界核验后生成同一结构：

| 字段 | 类型 | 含义与校验规则 |
| --- | --- | --- |
| `id` | `string` | 唯一交接包 UUID |
| `mandateId` / `mandateRev` | `string` / `number` | 绑定的原始用户需求契约及修订版本号 |
| `parentHandoffId` | `string \| null` | 上游交接包 ID（构成可追溯的完整交接链） |
| `fromRole` | `string` | 产出该交接包的角色 ID |
| `toTarget` | `"user" \| string` | 接收目标（`"user"`、下游角色 ID，或 `rejected` 时指向首个可写返修角色） |
| `verdict` | `"ready" \| "needs_input" \| "rejected" \| "blocked"` | `ready`：完成并向下游推进；`needs_input`：遇业务分叉点挂起为 `waiting_input`（0 Token 空耗）并唤醒 `coordinator` 请示用户；`rejected`：发现阻断缺陷——若前序存在可写专员（如 `dev → qa`）则自动打回返修，若整条前序均为只读审计专员（如单跑 `reviewer` 或 `planner → reviewer`）则审计流程本身正常完结为 `status: "completed"` 并完整保留 `rejected` 审查结论交付汇报；`blocked`：外部前置条件缺失 |
| `summary` | `string` | 交付成果、挂起背景或打回结论的精炼摘要 |
| `questionsForUser` | `string[] \| undefined` | 当 `verdict === "needs_input"` 时附带的简明通俗待决策问题列表，自动透传唤醒 `coordinator` 并在用户答复 `resume` 后注入续跑上下文 |
| `artifacts` | `ArtifactRecord[]` | 自动扫描工作区新增/修改文件并记录 `{ path, sha256, byteSize, role }`（`role` 支持 `"input" \| "inspected" \| "changed" \| "test" \| "report" \| "metrics"`；只读专员引用未发生 `sha256` 变更的被审文件时精准标为 `"inspected"` 而非 `"changed"`） |
| `deletedFiles` | `string[] \| undefined` | 本阶段相对基线被删除的文件路径列表，随条件块同步告知下游 |
| `verifiedFacts` | `{ claim, evidenceRef }[]` | 已验证结论列表，`evidenceRef` 必须命中本轮**非报错真实执行 `toolCallId`** 或有效工作区路径/选择器（支持 `:line`、`#Lline`、`:raw` 与目录前缀） |
| `openRisks` | `string[]` | 诚实披露的未覆盖边界、已知限制或待下游重点核查的疑点 |
| `feedbackForUpstream` | `string \| null` | 当 `verdict === "rejected"` 时必填最小复现步骤与期望/实际差异 |
| `observedUsage` | `UsageSummary \| null` | 被动归一化的实测 `{ inputTokens, outputTokens, costUsd }`（不作阻断限制） |

---

## 3. SQLite 持久化表结构 (`.omp-enhance/state.sqlite`)

每个目标项目下的 `.omp-enhance/state.sqlite` 按需惰性创建（纯只读查询不建空库、不脏写 WAL；首次创建 `.omp-enhance/` 目录时自动写入 `.omp-enhance/.gitignore` `*` 防止污染目标仓库 `git status`；跨子项目路径索引单独保存在 `~/.omp/enhance/hub-projects.json`），启用 `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;` 及二级索引，共包含 **6 张表**：

1. **`mandates`**：保存原始目标、硬约束数组、验收标准数组、版本号 `rev`、状态（`active` | `completed` | `archived`）以及 `session_id` / `flow_id` 作用域隔离字段。
2. **`epistemic_items`**：外键关联 `mandates(id)` 的认知黑板条目（`fact` | `hypothesis` | `inquiry` | `decision`）；数据库级 `CHECK` 约束强制 `fact` 必须附带非空 `evidence_ref`。
3. **`artifacts`**：外键关联 `mandates(id)`，按 `(mandate_id, path, sha256)` 记录文件指纹，读取时按路径聚合最新快照版本。
4. **`handoffs`**：外键关联 `mandates(id)`，完整持久化历次 `HandoffEnvelope`（含 `deleted_files`、`verified_facts`、`questions_for_user` 与 `observed_usage`）及父子链路。
5. **`jobs`**：记录后台无时限长作业（`job_id, mandate_id, hypothesis_id, command, cwd, pid, pgid, owner_pid, process_start_token, log_path, exit_file_path, status, exit_code, started_at, ended_at`），通过原子 `.exit` 写入与进程启动指纹支撑跨重启精准对账。
6. **`flow_runs`**：外键关联 `mandates(id)`，持久化后台 Flow 检查点（支持 `running`、`waiting_input`、`interrupted`、`failed` 等状态及 `cwd` 记录），自动保留最近 50 条历史记录并保护活跃属主进程不被其他终端误标为中断。
