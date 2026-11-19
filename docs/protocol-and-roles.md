# 交接协议与 YAML 角色编写指南

本文定义 `omp-enhance` 的纯 YAML 角色规范（`RoleSpec`）、三级角色发现机制、跨主体标准交接包（`HandoffEnvelope`）以及 SQLite 持久化表结构。

---

## 1. 纯 YAML 角色规范 (`RoleSpec`)

每个角色定义为一个 `.yaml`（或 `.yml`）文件，由 Bun 原生 `Bun.YAML.parse()` 解析。

### 1.1 完整字段说明

```yaml
# 必填：唯一角色标识（字母、数字、连字符或下划线，需与文件名一致）
id: qa

# 可选：人类可读名称与一句话简介（省略 name 时默认取 id）
name: 独立测试与证伪工程师
description: 基于原始需求独立构造正常、边界与异常测试，证伪上游实现

# 可选：为该角色绑定专属模型与推理档位（省略或设为 inherit 表示沿用当前会话模型）
# 支持 OMP 模型角色别名（@advisor, @default, @smol, @slow, @plan, @task）或精确 provider/model-id
model: "@slow"
thinking: high

# 必填：认知立场（决定模型默认关注点与怀疑先验，推荐使用 | 多行字面量块）
stance: |
  证伪优先：在看到本轮真实测试运行输出前，默认上游实现存在未覆盖边界或缺陷；
  不采信上游自评，禁止顺着业务实现代码抄写必过断言。

# 必填：有序方法论步骤（至少 1 条非空字符串）
method:
  - 对照原始 Mandate 独立列出正常、边界与异常测试点
  - 编写或补充测试代码并真实执行，获取退出码与输出证据
  - 发现缺陷时附最小复现命令标为 rejected 打回；全部通过标为 ready

# 可选：物理工具与路径边界（整块省略表示沿用当前常规权限）
permissions:
  # 可选：允许的内置工具列表（插件自身的 enhance_* 伴随工具始终保留）
  tools: [read, grep, lsp, edit, write, bash]
  # 可选：允许被 write / edit / apply_patch 写入的相对路径 glob；[] 表示纯只读
  writable: ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"]
  # 可选：运行期间严禁发生任何字节变更的相对路径 glob（执行前后自动校验 sha256）
  protected: ["src/**"]

# 可选：准出硬判据
exit:
  # 声明 ready 时，本轮是否必须至少有一次非报错的真实工具执行记录（默认 false）
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
stance: |
  优先保证接口最小惊讶原则、向后兼容与错误码语义清晰。
method:
  - 明确调用方场景、输入不变量与失败模式
  - 给出清晰的类型签名与边界示例
  - 标注潜在破坏性变更风险
```

### 1.3 三级发现目录与优先级

按以下优先级从高到低合并（同名 `id` 上层覆盖下层）：
1. **项目级 (`project`)**：`<当前工作区>/.omp/roles/*.{yaml,yml}`
2. **个人全局级 (`global`)**：`~/.omp/enhance/roles/*.{yaml,yml}`（`/role create` 默认保存位置，跨项目通用）
3. **插件内置 (`builtin`)**：`<omp-enhance>/roles/{dev,qa,reviewer,ml-engineer,supervisor}.yaml`

### 1.4 内置监督角色 (`supervisor`) 与 `@advisor` 默认继承

`roles/supervisor.yaml` 是只读、无工具的运行期巡检角色：`model: "@advisor"`、`thinking: off`、`permissions.tools: []`、`permissions.writable: []`、`permissions.protected: ["**"]`。默认继承用户在 OMP 中配置的 **`@advisor`** 模型角色（若未配置 `@advisor` 则自动回退至当前会话模型），用户也可在系统默认 **`/settings → Plugins → omp-enhance`** 修改 `supervisorModel`，或在 `/role edit supervisor` 中单独覆盖。它不参与业务交付，只周期性读取一个紧凑 `SupervisorPulse`（目标、巡检序号、总耗时、静默时长、本周期新增日志字节/工具调用、日志尾部摘录），并严格输出单个 JSON：

```json
{ "action": "continue", "reason": "...", "nextCheckSec": 60, "evidence": "...", "steerMessage": "..." }
```

| 裁决 | 行为 |
| --- | --- |
| `continue` | 保持任务运行；`nextCheckSec` 钳制到 `[5, 600]` 秒，作为下一次巡检间隔 |
| `steer` | 保持任务运行，并把 `steerMessage`（缺省用 `reason`）注入角色子会话 `session.steer` |
| `abort` | 必须提供非空异常依据；后台作业终止整个进程组，角色会话调用 `session.abort()`，流程返回 `aborted_by_supervisor` |

运行期安全语义：初始延迟默认 30 秒，任务在首次巡检前结束则不产生任何监督模型调用；监督模型报错或返回非法 JSON 时 **fail-open**（任务继续，约 30 秒后重试），不以监控故障终止健康任务。

---

## 2. 标准交接包 (`HandoffEnvelope`)

无论是日常单角色向用户收尾（`toTarget: "user"`），还是多角色接力转手（如 `toTarget: "qa"`），均生成并验证同一结构：

| 字段 | 类型 | 含义与校验规则 |
| --- | --- | --- |
| `id` | `string` | 唯一交接包 UUID |
| `mandateId` / `mandateRev` | `string` / `number` | 绑定的原始用户需求契约及修订版本号 |
| `parentHandoffId` | `string \| null` | 上游交接包 ID（构成可追溯的完整交接链） |
| `fromRole` | `string` | 产出该交接包的角色 ID |
| `toTarget` | `"user" \| string` | 接收目标（`"user"` 或下游角色 ID） |
| `verdict` | `"ready" \| "rejected" \| "blocked"` | `ready`：完成可向下游推进；`rejected`：测试/审查不通过打回上游；`blocked`：外部前置条件缺失 |
| `summary` | `string` | 交付成果或打回结论的精炼摘要 |
| `artifacts` | `ArtifactRecord[]` | 插件自动扫描工作区改动并计算 `{ path, sha256, byteSize, role }` |
| `verifiedFacts` | `{ claim, evidenceRef }[]` | 已验证结论列表，`evidenceRef` 必须命中本轮真实 `toolCallId` 或已登记文件 `sha256` |
| `openRisks` | `string[]` | 诚实披露的未覆盖边界、已知限制或待下游重点核查的疑点 |
| `feedbackForUpstream` | `string \| null` | 当 `verdict === "rejected"` 时必填最小复现步骤与期望/实际差异 |
| `observedUsage` | `UsageSummary \| null` | 被动记录的实测 Token 与费用（不作阻断限制） |

---

## 3. SQLite 持久化表结构 (`.omp-enhance/state.sqlite`)

数据库启用 `PRAGMA journal_mode = WAL;` 与 `PRAGMA foreign_keys = ON;`，包含 5 张表：

1. **`mandates`**：保存原始用户目标、硬约束数组、验收标准数组、版本号 `rev` 与状态。
2. **`epistemic_items`**：认知黑板条目（`fact` | `hypothesis` | `inquiry` | `decision`）；数据库级 `CHECK (kind != 'fact' OR (evidence_ref IS NOT NULL AND length(evidence_ref) > 0))` 保证无证据断言绝不混入事实库。
3. **`artifacts`**：按 `(mandate_id, path, sha256)` 记录输入与产出文件快照。
4. **`handoffs`**：完整持久化历次 `HandoffEnvelope` 及父子链路。
5. **`jobs`**：记录后台无时限长作业（`job_id, mandate_id, hypothesis_id, command, pid, pgid, log_path, exit_file_path, status, exit_code, started_at, ended_at`），支撑终端关闭重开后的状态对账。
