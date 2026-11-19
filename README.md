# omp-enhance

面向 **Oh My Pi (`omp`)** 的轻量级第一性增强插件：基于同一套 **“纯 YAML 角色内规范条件化 ($M_r$) + 马尔可夫屏障交接包 ($H$)”** 统一日常单 Agent 工作与多角色协同工作流，100% 自动继承你在 OMP 中已登录的账号、模型选择与设置。

文档：[整体架构设计](docs/architecture.md) · [交接协议与 YAML 角色编写指南](docs/protocol-and-roles.md)

---

## 核心特性

1. **双范式同构（日常 `N = 1` 与协同 `N > 1` 统一）**
   - **内规范 (`RoleSpec`)**：采用纯 YAML 定义**认知立场 (`stance`)、工作方法步骤 (`method`)、工具与读写边界 (`permissions`)、准出判据 (`exit`)**，使用 Bun 1.4 原生 `Bun.YAML.parse` 零外部依赖解析。默认激活全能力通用基态 `general`，并内置 `dev`、`qa`、`reviewer`、`ml-engineer`、`supervisor` 共六个标准角色。
   - **外规范 (`HandoffEnvelope`)**：无论日常向用户收尾，还是跨角色转手（如 `dev → qa`），统一传递**原始需求 (`Mandate`) + 自动计算的产物 `sha256` 快照 + 本轮已核验真实工具证据 + 未决风险**，自动截断上游冗长的试错对话历史，杜绝上下文锚定污染。
2. **100% 原生继承 OMP 生态，零重复配置**
   - 仅使用 OMP 公开 `ExtensionAPI` 与官方根 SDK `pi.pi.createAgentSession`，自动复用已登录的 `/login` OAuth 订阅账号、API Key、当前选中模型、Thinking 档位及内置 Rust 工具链。
3. **个人主权优先：无预扣预算、无源头硬超时**
   - 费用与耗时仅做被动实测记录，不设预扣额度锁或固定时长强杀；仅保留连续同错无进展熔断（Stagnation Guard）防止死循环。
4. **原生融入系统 `/settings` 与内聚 `Role Studio`（零多余斜杠命令）**
   - 自动发现优先级：项目级 `.omp/roles/*.yaml` > 个人全局库 `~/.omp/enhance/roles/*.yaml` > 插件内置 `roles/*.yaml`。
   - 插件全局参数直接集成在 OMP 系统默认 **`/settings → Plugins → omp-enhance`**（及 `omp plugin config`），不额外占用斜杠命令；交互式 TUI 下执行 `/role`、`/role studio` 或 `/role edit <id>` 即可打开可视化 **Role Studio**（新建角色向导、绑定角色专属模型、勾选工具复选框、Copy-on-Write 覆盖与一键恢复默认）。
5. **无时限后台长作业管理与跨重启对账**
   - 面向模型训练、批量评测等未知时长任务，独立进程组后台执行，状态持久化至 `.omp-enhance/state.sqlite`（WAL 事务模式），终端重开后自动对账真实进程与完成状态。
6. **运行期自适应巡检与止损（Supervisor 默认继承 `@advisor`）**
   - 内置 `supervisor` 默认自动继承你在 OMP 中配置的 **`@advisor`（Advisor 模型角色）**，也可在 `/settings → Plugins → omp-enhance`（`supervisorModel`）或 `/role edit supervisor` 中自由改绑任意模型。
   - 周期性消费增量脉搏（新增日志 / 新增工具调用 / 静默时长），只输出 `continue`、`steer` 或 `abort` 三种裁决，并按 `nextCheckSec` 自适应拉长巡检间隔。
   - 快速任务在初始延迟（默认 30 秒）内结束时不产生任何监督模型调用；监督模型自身报错时 **fail-open**，绝不误杀健康任务。
   - `abort` 仅由明确异常证据触发（数值 `NaN`/`Inf`、等待交互输入死锁、重复同错原地打转等），并立即终止后台作业进程组或中止角色子会话。

---

## 快速开始

### 安装 / 软链挂载为原生 OMP 插件（推荐）

```sh
omp plugin link .
```

挂载后启动 `omp`，输入系统内置 `/settings` 并切换到 **`Plugins → omp-enhance`** 标签页，即可直接在系统设置面板中调整默认激活角色、`supervisorModel`（默认 `@advisor`）、巡检初始延迟、返修轮次上限与底部状态栏徽标开关。

也可单次临时加载：

```sh
omp --extension .
```

### 交互命令速查

| 命令 | 说明 |
| --- | --- |
| `/settings` → `Plugins` → `omp-enhance` | 在 OMP 系统默认设置面板中配置插件参数（`defaultRole`、`supervisorModel`、`supervisorEnabled`、`flowMaxRepairRounds` 等） |
| `/role` 或 `/role studio` | 打开**单屏左右分栏 Role 面板**（`Enter` 切换会话角色，`e/→` 修改配置，`c` 基于当前角色拷贝新角色，`d` 删除自定义角色（6 个内置默认角色受保护不可删），`h` 独立阶段交接，`n` 新建，`Esc` 退出） |
| `/role copy <src> <newId> [--project]` | 以现有内置或自定义角色为模板一键拷贝生成新角色 YAML |
| `/role delete <customId>` | 删除自定义角色（内置默认角色受保护不可删除；若删除当前激活角色会自动回退至默认基态 `general`） |
| `/role edit <id>` | 在交互式 TUI 中直接打开指定角色的配置页（内置角色修改时自动 Copy-on-Write 保存至覆盖目录，支持一键恢复默认） |
| `/role list` | 文本列出当前激活角色及所有可用角色（显示来源与绑定模型） |
| `/role <id>` / `/role off` | 切换主会话当前激活角色（若角色绑定了专属模型/推理档位会同步切换），或暂时关闭角色条件化注入 |
| `/role show <id>` | 查看指定角色的完整 YAML 规范、专属模型、读写保护边界与文件路径 |
| `/role create <id> [--project] <描述>` | CLI 快速生成规范 YAML 角色文件（默认存入 `~/.omp/enhance/roles/`） |
| `/handoff [role]` | 将当前成果转手给独立隔离的阶段角色（如 `/handoff qa`；不带参数敲 `/handoff` 会直接弹出目标角色选择器，支持 `Tab` 补全，执行时底部实时显示正在运行的阶段与工具；`-p` 模式下请用 `/enhance-handoff <role>`） |
| `/flow <r1,r2,...> [任务说明]` | 按角色序列（如 `/flow dev,qa,reviewer`，支持逗号后 `Tab` 补全）执行马尔可夫隔离接力与自动打回返修 |
| `/enhance-status` | 本地只读查看当前角色、当前生效插件设置、有效 `Mandate`、认知黑板计数、最近交接链与后台作业 |

### 模型可调用工具

- `enhance_mandate`：建立/更新原始需求契约（目标、硬约束、验收条件）及读写认知黑板（`fact` 强制绑定真实证据引用、`hypothesis`、`inquiry`、`decision`）。
- `enhance_handoff`：收束本轮工作生成标准 `HandoffEnvelope`（自动计算变更文件 `sha256` 并核验真实工具调用证据），可选直接委托下一角色。
- `enhance_flow`：按角色序列触发多角色协同与自动返修回路。
- `enhance_job`：启动、`watch`（自适应巡检直到完成/失败/被止损）、读取日志尾部、跨重启对账（`reconcile`）或取消后台无时限长作业。

---

## 开发与验证

```sh
bun run probe:phase0 # 真机验证本机 OMP 公开 SDK、账号继承与隔离会话生命周期
bun run check        # 类型检查 + 核心代码行数/零私有导入门禁 (≤ 2,900 LoC) + 单元测试
bun run verify:omp   # 调用本机真实 omp 执行端到端集成验收
```
