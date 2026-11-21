# `algo` 实验工作目录与渐进式报告规范

本文档定义内置角色 **[algo.yaml](../roles/algo.yaml)**（引导型有监督算法优化专家）与 **[vision.yaml](../roles/vision.yaml)**（`@vision` 视觉诊断专员）的工程方法论契约。该规范通过角色内规范条件化（`stance` / `method` / `exit.criteria`）配合 `require_tool_evidence: true` 真实执行取证与产物 `sha256` 快照追踪，引导 Agent 在带真值 $(X, Y)$ 的算法调优中遵循**三区工作目录约定**与**四道渐进式报告门禁**——不跳步、不覆写旧实验、不暗改评测脚本、不凭记忆编造指标。（注：若需对原始数据目录或定稿后的基准目录施加硬物理写拦截，可在项目覆盖角色 `.omp/roles/algo.yaml` 中按实际目录配置 `permissions.protected` 与 `permissions.writable`。）

---

## 1. 标准三区隔离工作目录 (`algo_work/`)

所有实验脚本、切分索引、图表与报告统一收敛在项目下的 `algo_work/` 目录内，**避免修改或污染用户的原始输入数据目录**：

```text
algo_work/
├── REPORT.md                     # 【主实验报告】按四道门禁随进度实时更新（支持 Markdown 相对路径嵌图）
├── ledger.jsonl                  # 【机器可读总台账】每完成一个实验件追加 1 行 JSON
├── benchmark/                    # 【1. 宪法基准区 —— 门禁 1 定稿后保持不变】
│   ├── data_profile.json         # 输入 X / 真值 Y 样本量、维度、缺失率、极值与分布统计
│   ├── splits.json               # 防同源泄漏切分索引（Train / Val / 封存的 Holdout Test）
│   ├── eval.py                   # 唯一法定评估入口（输出统一结构的 metrics.json）
│   └── vis/                      # 原始样本+真值叠加抽检图、特征-真值分布图
├── runs/                         # 【2. 独立实验件区 —— 一轮一目录，Keep / Discard 均完整保留】
│   ├── exp_000_baseline/         # 0 号极简基线实验件
│   │   ├── spec.yaml             # 实验立项卡（parent_exp、假设、唯一改动点、随机种子）
│   │   ├── run.py (或 code/)     # 本实验件独立可复现的实现/配置快照
│   │   ├── metrics.json          # 由 benchmark/eval.py 产出的标准成绩单
│   │   ├── vis/                  # 本轮专属错例拼图 / 残差散点图 / 曲线图
│   │   └── summary.md            # 单件微报告（假设 → 改动 → 实测指标 → 看图结论 → Keep/Discard）
│   ├── exp_001_<slug>/           # 1 号单变量改进实验件
│   └── exp_002_<slug>/           # 2 号实验件（若 Discard，保留本目录备查，下一轮退回最近 Keep 父版本）
└── best/                         # 【3. 最优交付区 —— 供用户直接拿走运行的干净成品】
    ├── README.md                 # 面向非算法用户的大白话使用说明与边界兜底指南
    └── ...                       # 最优 Keep 实验件的推理入口与模型/参数副本
```

长耗时训练或超参搜索无论在主会话（`/role algo`）还是隔离阶段（`/flow`、`/enhance-handoff algo`、`@algo`）中，均可调用 `enhance_job`（`start` / `watch`：支持跨会话持久化、`@advisor` 巡检止损，且阶段被中止时自动清理残留后台进程组）或 OMP 原生 `bash` 后台异步任务（`bg_*`，自动计入 `SupervisorPulse.activeAsyncJobs` 活跃进展），并使用 `enhance_mandate` 在认知黑板登记假设与已核验指标证据。

---

## 2. 运行时自适应看图准则 + 高可读出图铁律

### 2.1 运行时自动分流 (`RuntimeVision`)
当宿主模型公开了 `model.input` 模态元数据时，`omp-enhance` 自动注入 `RuntimeVision` 提示标识（对 `vision` 角色自身自动抑制自指委托提示）：
- **`native-multimodal`（当前模型原生支持图像输入）**：`algo` 必须**自己调用 `read` 亲眼读取**关键体检图、错例图与首尾对比图，将像素级现象直接关联回刚编写的算法逻辑；仅在大批量初筛（如数十张图）或结项独立盲审时按需委托 `vision`。
- **`text-only`（当前模型为纯文本推理/代码模型）**：直接 `read` 图像看不到像素，**必须**调用 `enhance_handoff(toTarget="vision", delegateNow=true, artifactPaths=[...])`（或交互式执行 `/enhance-handoff vision`）委托绑定了 `@vision` 的只读角色 `vision`（允许 `read`、`glob`、`find`）读取图像并返回结构化观察事实（`verifiedFacts`）。

### 2.2 诊断图绘制规范（防止 VLM 误读与乱码）
1. **防方块乱码**：图像标题、坐标轴、图例统一使用清晰的 **英文 / ASCII 与数字**（避免跨环境缺少中文字体产生 `□□□` 乱码；面向用户的通俗中文解读写在 `REPORT.md` 与 `summary.md` 中）。
2. **控制密度与字号**：单张样本拼图最多 **`3×3` 或 `4×4` 格**（分辨率建议 `>= 1200px`，字号 `>= 10pt`），禁止一张图塞几十个无法辨认的缩略图。
3. **强制可追溯标注**：每个子图格子必须印上 `sample_id` 以及对应的 `GT`（真值）、`Pred`（预测值）与 `Err`（误差值），且对比不同实验件时必须**锁定统一坐标轴范围与色标尺度**。

---

## 3. 核心元数据契约 (`spec.yaml` / `metrics.json` / `ledger.jsonl`)

### 3.1 `runs/exp_NNN_<slug>/spec.yaml`（跑前必填）
```yaml
exp_id: exp_002_huber_loss
parent_exp: exp_001_outlier_clip   # exp_000_baseline 为 null；改进轮必须指向某个 Keep 实验件
target_error_bucket: "高幅值脉冲段的尾部大误差 (占 exp_001 P95 误差的 65%)"
hypothesis: "MSE 对约 3% 的毛刺真值平方放大导致整体回归线被拉偏；改用 Huber(delta=1.5) 可抑制离群梯度同时保持平滑段精度"
single_change: "损失函数由 L2 替换为 Huber(delta=1.5)，其余特征、切分与超参完全不变"
seed: 42
```

### 3.2 `runs/exp_NNN_<slug>/metrics.json`（由 `benchmark/eval.py` 统一生成）
```json
{
  "exp_id": "exp_002_huber_loss",
  "split": "val",
  "primary_metric": { "name": "MAE", "value": 0.0412, "higher_is_better": false },
  "guardrails": {
    "p95_abs_err": 0.118,
    "p99_abs_err": 0.245,
    "latency_ms_per_sample": 1.4
  },
  "slices": {
    "normal_regime": 0.031,
    "high_spike_regime": 0.089
  }
}
```

### 3.3 `algo_work/ledger.jsonl`（每轮跑完追加 1 行）
```json
{"exp_id":"exp_000_baseline","parent_exp":null,"single_change":"linear baseline","primary":0.0685,"p95":0.291,"decision":"keep","reason":"端到端自检通过，确立基线"}
{"exp_id":"exp_001_outlier_clip","parent_exp":"exp_000_baseline","single_change":"input 3-sigma clip","primary":0.0540,"p95":0.210,"decision":"keep","reason":"MAE 下降 21%，尾部同步改善"}
{"exp_id":"exp_002_poly3_feat","parent_exp":"exp_001_outlier_clip","single_change":"3阶多项式展开","primary":0.0538,"p95":0.380,"decision":"discard","reason":"均值微降但极值外推爆炸导致 P95 恶化，回退至 exp_001"}
```

---

## 4. `algo_work/REPORT.md` 四道渐进式门禁模板

`REPORT.md` 必须随实验推进逐步更新，严禁全部跑完后凭印象一次性编造：

```markdown
# 算法优化实验报告：<任务名称>

## 1. 业务诉求与评测标尺对齐（门禁 1）
- **用户核心诉求（通俗表述）**：<例如：宁可轻微多报，绝不能漏掉高风险异常；单次处理不超过 10ms>
- **主优化指标**：`<指标名与方向>`
- **护栏约束指标**：`<P95/P99 尾部误差、特定子集、耗时/资源上限>`

## 2. 数据与真值健康度体检（门禁 1）
- **数据规模与字段概况**：<引用 `benchmark/data_profile.json`>
- **真值质量与分布看图诊断**：
  ![数据体检图](./benchmark/vis/data_sanity_grid.png)
  - 看图结论：<对齐是否正常、是否存在疑似脏标/漏标样本编号、分布偏斜情况>
- **防泄漏切分方案**：<说明按什么分组/时间切分写入 `benchmark/splits.json`，确认独立测试集封存情况>

## 3. 基线立靶与主导错因分桶（门禁 2：`exp_000_baseline`）
- **极简基线方法与管线自检结果**：<真值满分自检 / 小样本拟合自检是否通过>
- **基线成绩单**：主指标 `...` | P95 `...` | 耗时 `...`
- **基线错例看图归因**：
  ![基线错例图](./runs/exp_000_baseline/vis/badcases_grid.png)
  1. 错因桶 A（占比约 `..%`，代表样本 `#id`）：<通俗机理描述>
  2. 错因桶 B（占比约 `..%`，代表样本 `#id`）：<通俗机理描述>

## 4. 实验件演进对照总表（门禁 3：每轮实时追加）
| 实验件 ID | 父版本 | 针对错因与单点假设改动 | 主指标 (较父版 Δ) | P95 / 护栏指标 | 看图复核要点 | 裁决 |
| --- | --- | --- | --- | --- | --- | --- |
| `exp_000_baseline` | - | 极简可解释基线 | `...` | `...` | 定位两类主要错因 | ✓ Keep |
| `exp_001_...` | `exp_000` | ... | `... (-..%)` | `...` | ... | ✓ Keep |
| `exp_002_...` | `exp_001` | ... | `...` | `... (退化)` | 极值外推失真 | ✕ Discard |

## 5. 最优方案首尾对比与消融复盘（门禁 4）
![首尾同批样本对比](./runs/exp_003_.../vis/vs_baseline_grid.png)
- **整体净提升**：`<exp_000 -> best 关键指标变化>`
- **真正起效的关键改动**：<1..N 条通俗解释>
- **被证伪的无效方向（避坑记录）**：<简述 Discard 实验件给我们的启示>

## 6. 落地使用说明与失效边界兜底建议（门禁 4）
- **一键运行方式**：见 `./best/README.md`
- **稳定适用范围**：<哪些常规场景下表现可靠>
- **已知边界与业务兜底建议**：<受限于真值噪声或缺失特征仍可能失准的极端情况，以及建议的阈值报警/人工复核/补数方向>
```
