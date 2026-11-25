# omp-enhance 下一步：任务可靠性、交付证据与可借鉴的 Agent 应用

2026-11-24，基于 `4df11c8`。建议先修跨窗口留言与后台作业登记，再用真实业务任务衡量多角色协作的收益。第一个产品试点选**只读 CI 故障诊断**：已有 `planner`、`reviewer`、跨项目调度与交接协议就能运行，历史故障有已知答案，结果也容易复核。

## 从当前版本出发

[上一轮评审及修复记录](review-2026-11-23.md)中的项目租约、按 Flow ID 查询、目标目录信任判定、宿主错误归类、QA 必需工具与 algo 必需产物均已进入代码。本次重跑 `bun run check`，86 个测试通过，0 失败。仓库现有的双进程 OMP 验收脚本覆盖 A 挂起、B 持锁、C 并行和跨窗口恢复；本次核对了脚本，未重跑完整模型 E2E。脚本指定角色、工具调用和预期文件内容，很适合验流程；陌生业务任务的质量和成本要另测。[真机验收脚本](../scripts/verify-omp-e2e.ts)

### 1. 让普通留言在跨窗口恢复后也可靠

在临时 SQLite 上用独立 Bun 进程、真实 Hub 与 Flow 工具复现了两种情况，均无模型参与。

| 触发条件 | 实际结果 | 修复后的验收条件 |
| --- | --- | --- |
| 窗口 A 将任务 X 挂起，窗口 B 恢复 X。A 从普通对话留言，工具调用没有显式传 `flowId`。 | A 把旧的 `waiting_input` 快照写回并释放 X 的租约。B 仍在执行，另一个执行者已能在同项目启动 Y。 | B 的租约与执行状态保持有效；若目标不明确则请求选择。B 结束前，Y 无法取得执行权。 |
| A 显式指定 X，给正在 B 中执行的 X 留言。 | 工具返回 `savedToCheckpoint: true`。数据库一度有 1 条留言，B 下次保存进度后变为 0。 | 留言在 B 保存进度和进程重启后仍可读；同一条消息只消费一次。前台区分“已保存”与“专员已收到”。 |

建议把用户答复作为带唯一 ID 的独立追加记录。执行者按游标读取；只有持有当前租约的执行者才能更新阶段状态或释放租约，并在同一事务核对所有者与版本。增加双进程回归：同一个任务跨窗口恢复后交错执行“写进度、发留言、读状态”，核对持锁者、留言数和实际收到的内容。保留用户在普通对话里直接答复的体验。[留言路由](../src/omp/flow-tool.ts) · [快照写入](../src/flow/state.ts) · [租约与检查点存储](../src/core/store.ts)

### 2. 作业登记成功后，还要处理 PID 回写失败

当前版本先保存作业意图，再创建进程，已修复无效任务关联导致命令意外启动的问题。仍有第二个失败点：在临时目录里，仅让创建进程后的那次 `saveJob` 抛错，保留真实 shell。调用返回失败，数据库记录 `failed, pid=0`，延迟写入的标记文件却实际出现。此时按“失败”重试可能重复执行。[后台作业启动与对账](../src/jobs/runner.ts)

建议让子进程在执行用户命令前等待登记确认。父进程成功持久化 PID 与启动指纹后才放行；确认失败或父进程提前退出时，子进程应自行结束。对结果已经不确定的旧记录，保留可对账状态。验收时分别在首次登记、创建进程、PID 回写和发出放行信号前后注入故障，同时查数据库、进程和实际副作用。

### 3. 把“运行过工具”推进到“能复验这次交付”

- **QA。** 给当前交接校验器一条成功的 `bash pwd` 记录，未运行测试也能提交 `ready`。建议对声称“测试通过”的交付，记录实际测试命令、退出码、输出摘要及受测代码版本。用已知失败用例验证：普通 shell 成功、刚启动的后台任务、旧版本的绿灯，都不能充当本次测试通过的依据。[QA 角色](../roles/qa.yaml) · [工具证据校验](../src/flow/handoff.ts)
- **algo。** 新任务开始前放置空 `REPORT.md` 与内容并非 JSON 的历史 `metrics.json`，提供一次成功读取记录，也能通过当前校验，两份产物都标为 `inspected`。建议把指标与本次实验 ID、基线、数据划分、评分器版本和实际运行关联。允许复用历史基线，同时记录来源；候选结果应可独立重跑。验收覆盖空报告、非法指标、旧实验误配，以及合法复用基线。[算法角色](../roles/algo.yaml) · [产物校验](../src/flow/handoff.ts)

## 四个值得借鉴的应用

| 应用与公开做法 | 可以直接在本项目试什么 | 取舍 |
| --- | --- | --- |
| **OpenHands 的生产异常排查**。团队将告警关联到已有或新建 issue，agent 跨仓寻找根因并把证据回填到同一处。[团队实践](https://www.openhands.dev/blog/introducing-the-openhands-software-agent-sdk) | 用户把失败 CI 的日志交给 `/coord`。planner 定位最早失败的步骤及相关提交，reviewer 核对证据是否支持根因，返回一条能区分候选原因的复验步骤。 | 第一版用离线日志即可。若缺关键日志，正确结果可以是“证据不足”及下一步取证动作。 |
| **GitHub Copilot cloud agent 的草稿 PR**。后台任务在分支上交付可审查的改动，由人决定是否合并。[GitHub 权限与审阅机制](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations) | 写任务可选择独立 Git worktree。协调器交付基线 SHA、结果 SHA 或补丁摘要、diff 和针对该版本的测试回执；用户在原对话里审阅或要求返修。先做本地预览即可。 | 适合 Git 项目。worktree 隔离工作副本；进程权限、凭据与网络需要单独控制。原工作区有未提交依赖时，应明确哪些内容进入基线。 |
| **Claude Research 的并行调查**。主 agent 把可独立调查的问题分给子 agent，汇总后再检查报告中的引用。[Anthropic 工程复盘](https://www.anthropic.com/research/multi-agent-research-system) | 用在跨仓接口盘点：前后端各在自己的项目读契约，按“接口、字段、版本、出处”回报；协调器合并差异，reviewer 只复核冲突项与关键引用。 | 可复用现有跨项目派单。相互依赖的编码步骤保持串行；在同一批任务上量出新增有效发现和额外 token，再决定是否扩大并行。 |
| **Karpathy 的 autoresearch**。固定评测程序和每轮训练预算，先跑基线，记录每次尝试的指标及保留、丢弃或失败结论。[项目说明](https://github.com/karpathy/autoresearch) · [实验协议](https://github.com/karpathy/autoresearch/blob/master/program.md) | 复用 `algo_work/`，先做一个可在 CPU 上廉价复跑的任务。预先固定划分、指标和预算；每个候选由同一评分器执行，保留失败和无提升的尝试。 | 原项目的单 GPU、五分钟和单一指标适配其训练问题。本项目应随任务设预算与指标，最终候选再过独立留出集，避免反复优化同一验证集。 |

## 两个可直接使用的设计模式

**恢复时按副作用去重。** LangGraph 的 interrupt 会保存状态，恢复时会从节点开头重新执行，因此其文档要求中断前的副作用可重复执行而不产生重复结果。OMP 已有阶段检查点，可先把这个原则应用于昂贵的 `enhance_job`：同一逻辑步骤先查已有运行，再决定复用或启动。验收场景是实验已提交、交接前进程退出，恢复后得到同一个实验的状态。这个做法可以单独采用，无需更换编排框架。[LangGraph 中断与恢复](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

**用外部结果给 agent 打分。** Anthropic 的评估方法把一次任务的多次尝试、执行轨迹和最终结果分别记录，并按任务选择代码、人工或模型评分。对本项目，隐藏测试可以判修复是否正确，程序可以核对用户答复去了哪个 Flow，独立复核者可以判断引用是否支持根因。运行轨迹用于解释失败，角色的自评保留作比较。[Agent 评估方法](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)

## 推荐试点与采纳标准

1. **先做只读诊断。** 取两个已查明根因的历史 CI 失败，加一个日志不足以定因的对照。冻结提交、日志、模型、可用工具与预算。普通 OMP 和 `/coord → planner → reviewer` 分别从干净会话重复执行，一轮不向另一轮传答案。
2. **独立评分。** 隐去方案来源，由知道真实根因的复核者评估定位是否正确、引用是否支持结论、复验步骤能否区分原因，以及是否在证据不足时诚实停下。同时记录端到端耗时、总 token 或可得费用、人工干预和所有失败。再加入单 planner 对照，可区分收益来自角色提示还是第二人复核。
3. **再决定扩展范围。** 小样本先用来发现失败模式。若多角色反复提供单角色遗漏的有效证据，且增量成本可接受，再扩充留出任务验证。后台写任务优先验证上面的并发与作业故障用例，再试一次隔离补丁交付；算法试点则以独立评分器能复跑出候选与基线之差为第一道验收。

---

## 实施与验证记录 (2026-11-25)

1. **单一原生设置收敛与宿主能力复用（消除重复配置面）**
   - 退役停用 `.omp/enhance.yaml`（存在时给出单次迁移提示），全量统一至 OMP 原生 `/settings → Plugins → omp-enhance`（`omp-plugins.lock.json`）与受信任 `.omp/plugin-overrides.json`。[设置加载](../src/core/settings.ts)
   - 明确工具职责边界：常规命令与同会话异步任务优先复用 OMP 原生 `bash`、`bg_*` 与 `/jobs`；`enhance_job` 专管跨终端重启的脱机长作业。[角色定义](../roles/dev.yaml) · [算法角色](../roles/algo.yaml)
2. **跨窗口追加式留言表 `flow_steers` 与 `lease_token` 版本栅栏（对应第 1 节）**
   - SQLite 新增独立追加留言表 `flow_steers`（`seq`, `steer_id`, `consumed_at`, `consumed_by_stage`），并在 `project_leases` 与 `flow_runs` 引入唯一 `lease_token` + `state_version`（`LeaseLostError` 栅栏）：旧窗口留言仅追加落库（返回 `deliveryState: "saved_pending_delivery"`），绝不覆写运行方快照或误释放其租约；当前持锁执行窗口在阶段前与执行中按游标拉取并幂等标记已消费（`deliveryState: "delivered_to_stage"`，每条消息严格只消费一次）。[存储与栅栏](../src/core/store.ts) · [留言路由](../src/omp/flow-tool.ts) · [双进程回归测试](../test/unit/phase7-resilience.test.ts)
3. **`enhance_job` 四阶段 `stdin "GO"` 握手与 `idempotencyKey` 幂等去重（对应第 2 节与恢复去重模式）**
   - `startBackgroundJob` 升级为四阶段门禁：① SQLite 预登记 `pid=0` → ② 派生阻塞在 `stdin` 等待 `"GO\n"` 的包装子进程 → ③ 持久化真实 `pid` 与启动指纹 → ④ 发送 `"GO\n"` 放行执行；PID 回写或放行前任一步骤失败均立即销毁管道终止子进程，杜绝无记录孤儿副作用。同时支持 `idempotencyKey` 复用在途或已完成的同键作业（`reused: true`）。[后台作业运行器](../src/jobs/runner.ts) · [故障注入单测](../test/unit/phase3-jobs.test.ts)
4. **`qa` 实测回执与 `algo` 结构化指标血统校验（对应第 3 节）**
   - **`qa`（`require_test_execution: true`）**：声明 `ready` 时强制核验本轮真实测试/类型检查命令完结且 `exitCode === 0`（拒绝 `bash pwd`/`echo`、刚拉起未完结的后台任务及旧轮次记录），自动将 `{ command, exitCode, outputSnippet, testedTreeFingerprint, toolCallId }` 写入 `HandoffEnvelope.verificationEvidence`。[交接校验](../src/flow/handoff.ts)
   - **`algo`（`require_algo_deliverables: true`）**：声明 `ready` 时校验非空 `algo_work/REPORT.md` 与本轮生成/更新的合法 JSON `metrics.json`（强制绑定实验 ID、数据划分、评分器版本与基线来源；合法复用历史基线时须显式声明 `reusedBaseline: true` 与 `baselineSource`）。[交接校验](../src/flow/handoff.ts) · [编排与证据单测](../test/unit/phase2-orchestrator.test.ts)
5. **只读 CI 故障诊断试点评测脚手架（对应推荐试点第 1～2 步）**
   - 新增 `bun run eval:ci-pilot`（`scripts/eval-ci-diagnosis.ts`）：在隔离临时 Git 沙箱中构建 **3 组冻结故障用例**（时区窗口回归、环境变量字符串强转回归、外层容器 `exit 137` 且分片日志缺失的诚实弃权对照），内置文件行号真实性核验器、客观评分器与匿名去标签盲评包生成器（`buildBlindReviewBundle`）；支持 `--dry-run`（`< 2s` 零模型自检）与 `--live`（对比 `vanilla-omp`、`single-planner`、`coord-planner-reviewer` 三组干净隔离运行并汇总准确率、耗时与 Token/费用）。[CI 诊断评测脚本](../scripts/eval-ci-diagnosis.ts)
