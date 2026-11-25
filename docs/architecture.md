# `omp-enhance` 整体架构设计

`omp-enhance` 是构建在 **Oh My Pi (`omp`)** 公开扩展接口与官方 SDK 之上的第一性 **SuperAgent 单窗口跨项目协同内核**。系统默认保持 **100% 零侵入标准 OMP（`defaultRole: null` / `"off"`）**；当用户通过 `/coord` 激活总秘书模式后，全部多项目协同收敛为三个正交机制：**`Role × Project Context/Skills` 条件化 ($M_r \times C_{\text{cwd}}$)**、**马尔可夫屏障交接包络 ($H$)** 与 **带任务租约互斥的跨项目双向唤醒中枢（Multi-Project Hub）**。

---

## 1. 第一性设计公理

1. **零侵入与纯总控分离公理（Zero-Intrusion & Pure Dispatch）**
   未开启 `/coord` 且无后台活跃任务时，插件不注入任何系统提示词、不显示状态栏徽标、不收敛宿主原生工具，也不重写用户输入中的 `@` 符号。开启 `/coord` 后，前台 `coordinator` 持有 `permissions.dispatch = true` 与只读工具白名单（事前拦截一切直接文件写、Shell 命令、`enhance_job(start)` 与 `enhance_handoff`），专职与用户用自然语言对齐需求并向后台派发专员流水线，保持主会话上下文高信噪比。
2. **`Role × Project Context/Skills` 正交分解与诚实边界公理（Orthogonal Role Conditioning & Two-Layer Boundary）**
   将跨领域不变的**认知立场与目录权限边界（`RoleSpec`：`planner` / `dev` / `algo` / `qa` / `reviewer` / `vision`）**同项目特有的**技术栈与领域知识（`<targetCwd>/AGENTS.md`、`CLAUDE.md`、项目 `skills`、`rules` 与 `LSP`）**正交解耦。边界保护明确区分为两层：
   - **事前阻止**：编辑类工具（`write`/`edit`/`apply_patch`/`ast_edit`）在调用前解析真实符号链接路径并拦截任何非 `writable` 或命中 `protected` 的目标；子会话以 `restrictToolNames: true` + `preloadedPreparedExtensions` 严格收敛工具面。
   - **事后核验与拒收**：开放 `bash` 的角色在阶段结束交接时执行全目录内容摘要快照比对（`<= 512 MiB` 计算 64 KiB 分块流式 `sha256` 记为 `digestKind: "sha256"`；`> 512 MiB` 超大文件记录 `stat:<size>:<mtime>` 标为 `digestKind: "stat_fingerprint"`），一旦发现 `protected`、非 `writable` 或 `.omp/` 配置篡改，直接判为 `violation` 拒收且禁止续跑。若验收场景要求命令执行期间源码在操作系统层全程严格只读，应在隔离工作区副本或只读挂载目录下运行。
3. **马尔可夫交接屏障与零空耗挂起公理（Markov Barrier & Zero-Cost Suspension）**
   跨专员流转时，**必须直传**原始需求契约（`Mandate`）、自动核验的真实文件快照、行号在界内的已核验事实（`verifiedFacts`）、用户在途答复及真实执行证据；**必须截断**上游冗长试错对话。专员遇到关键业务分叉点时，以 `verdict: "needs_input"` + `questionsForUser` 将该 `flowId` 检查点挂起为 `waiting_input` 并释放项目执行租约（挂起期间 **0 Token 消耗**），待用户答复后按指定 `flowId` 无损续跑。
4. **个人主权与故障可区分公理（Sovereign Operation & Diagnostic Fidelity）**
   100% 继承 OMP 已登录账号与模型角色配置；实测用量被动统计，不设硬超时强杀。严格区分三类阶段异常：宿主/模型服务错误（如 `502 Bad Gateway` → `host_error`，Flow 记为可续跑的 `failed`）、正常结束未调用交接工具（`missing_handoff` → 可续跑的 `failed`）与真实越界篡改（`violation` → 不可续跑）。

---

## 2. 六层单向 DAG 模块拓扑

`scripts/check-loc.ts` 静态强制以下单向分层依赖（`core ← roles / jobs ← flow ← ui ← omp ← entry.ts`）、单文件 `≤ 450` 行与零 `@oh-my-pi/*/*` 私有子路径导入门禁：

```mermaid
flowchart TB
    subgraph Discovery["三级纯 YAML 角色发现 (按目标目录独立受信任门禁保护)"]
        P[".omp/roles/*.yaml (Project, per-target trust)"]
        G["~/.omp/enhance/roles/*.yaml (Global)"]
        B["roles/*.yaml (Built-in: coordinator + 6 专员 + internal supervisor)"]
    end

    subgraph Layers["omp-enhance 单向分层内核 (src/)"]
        Entry["src/entry.ts (生命周期协调器)"]
        OMP["src/omp/{hub,trust,workspace,session,tools,flow-tool,commands}.ts (跨项目池 / 信任隔离 / 3 命令)"]
        UI["src/ui/{kit,role-studio,flow-room}.ts (Role Studio 与跨项目只读监控窗)"]
        Flow["src/flow/{tracker,handoff,state,orchestrator}.ts (交接门禁、租约栅栏、挂起与返修编排)"]
        Jobs["src/jobs/{runner,supervisor}.ts (GO 握手幂等后台作业与自适应巡检)"]
        Roles["src/roles/{serializer,loader,conditioning}.ts (YAML 序列化、角色发现与总控条件块)"]
        Core["src/core/{types,fs,store-schema,store,policy,settings}.ts (契约、流式哈希、SQLite 8 表、单一设置)"]
    end

    P --> Roles
    G --> Roles
    B --> Roles
    Entry --> OMP
    OMP --> UI
    OMP --> Flow
    OMP --> Jobs
    OMP --> Roles
    OMP --> Core
    UI --> Flow
    UI --> Roles
    UI --> Core
    Flow --> Jobs
    Flow --> Roles
    Flow --> Core
    Jobs --> Core
    Roles --> Core
```

| 层级与模块 | 核心职责 | 严守边界 |
| --- | --- | --- |
| `src/core/types.ts` | 共享纯数据类型契约（含 `dispatch`、`internal`、`digestKind`、`verificationEvidence`、`requireTestExecution`/`requireAlgoDeliverables`、`host_error`/`missing_handoff`） | 零外部模块依赖与运行时副作用 |
| `src/core/fs.ts` | 遵循 `.gitignore` 的 64 KiB 分块流式 `sha256`（`<= 512 MiB`）与 `stat_fingerprint` 快照、符号链接真实路径校验与 `.omp/` 完整性封印 | 区分真实内容摘要与元数据指纹，杜绝阻塞或伪装哈希 |
| `src/core/{store-schema,store}.ts` | `bun:sqlite` WAL + `busy_timeout = 5000` **8 张表**事务存储（含 `project_leases` `lease_token` 栅栏、独立追加留言表 `flow_steers`、`idempotency_key` 作业复用与 `.omp-enhance/.gitignore`） | 纯读不建空库；`LeaseLostError` 阻止旧窗口覆写新持锁者 |
| `src/core/policy.ts` | `dispatch` 总控事前拦截、内部角色过滤、`write`/`edit`/`apply_patch`/`ast_edit` 路径守卫与 `0ms` 惰性 `TurnTracker` | 前台与子会话共享单一权限真源 |
| `src/core/settings.ts` | **单一原生设置源**：仅读取 OMP `/settings → Plugins → omp-enhance`（`omp-plugins.lock.json`）与受信任 `.omp/plugin-overrides.json`（历史 `.omp/enhance.yaml` 已退役告警） | 100% 复用 OMP 原生设置体系，零重复配置文件 |
| `src/roles/{serializer,loader,conditioning}.ts` | 无损 YAML 序列化（含 `require_test_execution`/`require_algo_deliverables`）、三级角色发现与 `coordinator` 在途负载条件块渲染 | 单个损坏 YAML 绝不拖垮宿主钩子 |
| `src/jobs/{runner,supervisor}.ts` | **四阶段 `stdin "GO"` 握手门禁**（预登记 → 阻塞派生 → 落盘真实 PID/指纹 → 写入 `"GO"` 放行）、`idempotencyKey` 幂等复用与竞态安全巡检 | 常规命令优先走 OMP 原生 `bash`/`bg_*`；`enhance_job` 专管跨重启长作业且零孤儿副作用 |
| `src/flow/{tracker,handoff,state,orchestrator}.ts` | `qa` 真实测试回执与 `algo` 实验血统硬核验、游标拉取消费 `flow_steers`、`lease_token` 版本栅栏、创建前后三段取消屏障与 `host_error` 故障归类 | 恢复前预验角色与租约；跨窗口留言每条严格只消费一次 |
| `src/ui/{kit,role-studio,flow-room}.ts` | Kitty CSI-u 键盘解析、ANSI 安全截断折行、纯配置导向 Role Studio 与跨项目只读 `/flow` 监控面板 | 纯 UI 渲染，不含草稿误触框、SQLite 或子进程逻辑 |
| `src/omp/{hub,trust,workspace,session,tools,flow-tool,commands}.ts` & `src/entry.ts` | 跨项目 `WorkspaceHub`、按目标目录独立的信任授权（`trusted-projects.json`）、区分“已保存 (`saved_pending_delivery`)”与“专员已收到 (`delivered_to_stage`)”留言路由及三命令 | 零 `@oh-my-pi/` 私有导入；跨目录未确认信任前绝不启用对方 `.omp` 覆盖 |

---

## 3. 任务身份隔离、跨窗口追加式留言与原生能力复用

1. **按 `flowId` 精准寻址、`lease_token` 栅栏与跨窗口追加留言表 `flow_steers`（P1-1 & P1-2 & GPT #1）**
   - 每个目标项目通过 `project_leases` 表授予带唯一 `lease_token` 与递增 `state_version` 的活跃执行权：所有检查点写入与释放均在同一事务内核对 `expectedLeaseToken`（不匹配即抛出 `LeaseLostError`），彻底杜绝已交出任务的旧窗口把陈旧快照写回或误释放新持锁窗口的租约。
   - 用户答复与插话独立存入追加表 **`flow_steers`**（绝不触发旧窗口 `room.persist()` 覆写）：若目标任务正在本窗口执行，实时送达并标记已消费（`deliveryState: "delivered_to_stage"`）；若任务正在另一窗口运行或处于挂起态，仅追加落库并返回 `deliveryState: "saved_pending_delivery"`，由持锁执行窗口在阶段前与运行中按游标拉取并幂等标记 `consumed_at`（跨保存进度与进程重启不丢失、不重复消费）。
2. **OMP 原生能力优先复用与 `enhance_job` 四阶段握手去重（GPT #2）**
   - **配置零重复**：插件设置统一收敛至 OMP 原生 `/settings → Plugins → omp-enhance` 与 `.omp/plugin-overrides.json`，不再维护独立 `.omp/enhance.yaml`。
   - **作业职责正交**：常规验证命令与同会话短异步作业直接使用 OMP 原生 `bash`、`bg_*` 与 `/jobs`；`enhance_job` 仅面向跨终端重启的脱机长时作业，子进程在收到父进程完成真实 `pid` 与启动指纹落库后发出的 `"GO\n"` 信号前绝不执行用户命令，并支持通过 `idempotencyKey` 在中断续跑时自动复用已有运行/完成作业（`reused: true`）。
3. **创建前后三段取消屏障与恢复前预校验（P1-3 & P2-3）**
   子阶段在 `createAgentSession` 调用前、返回后（若已取消立即 `dispose()` 且零次 `prompt()`）及首轮模型执行中全程绑定取消信号。执行 `resume` 前预先校验检查点状态、租约空闲及 `roleChain` 角色完整性。
4. **可复验交付证据、跨目录信任门禁与混合链完成判定（P1-4 & P1-6 & GPT #3）**
   `qa` 结项强制核验本轮真实测试/检查命令回执并固化 `verificationEvidence`（含 `testedTreeFingerprint`）；`algo` 结项强制核验非空 `REPORT.md` 与带实验血统且本轮产出的合法 JSON `metrics.json`（允许显式声明 `reusedBaseline: true` 复用历史基线对照）。外部目标目录默认不继承主目录信任状态（须经 `/coord trust <B>` 授权）；混合交付链上游只读角色返回 `rejected` 时进入 `status: "blocked"` 而非提前完结。

---

## 4. 运行期自适应监督（Adaptive Supervisor）

内置隐藏角色 `supervisor`（`internal: true`、默认 `model: "@advisor"`、`thinking: "inherit"`）通过无工具轻量内存会话周期性消费 `SupervisorPulse`（含 `roleId` / `readOnly` / `allowedTools` / `activeTool` / `activeAsyncJobs` / `priorDecisions`）：对只读或无 `bash` 阶段严禁误导执行 Shell/测试命令；`bg_*` 原生后台任务运行期自动将 `idleSec` 置零；巡检全程与自然完成事件竞态绑定，报错时 **fail-open** 指数退避；阶段中止时通过 `cancelJobsByIds` 自动清理残留后台进程组。
