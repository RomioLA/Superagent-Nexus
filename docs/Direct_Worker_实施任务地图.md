# Direct Worker 执行架构改造 · 实施任务地图

> 本文件是本工单唯一的持久化任务地图。施工进度以本文件 + 实际 Git 状态为准。
> 每完成一个阶段更新「完成状态 / 测试证据 / 遗留问题」。

## 0. 工单与交付边界

- 工单：Direct Worker 执行架构改造与完整交付（ticket `040072afbe96eada59f0478ad075d05d`）。
- 开发执行模型（owner 规定）：Grok Build via `orchestrator_grok`，模型 `grok-4.7-build-fast`；不使用 4a；不切换到 Codex/AGY 作为开发模型。
- 基线：生产 Commit `739bd09`（ticket 分支已对齐到该 commit；含 M1–M6 的模型发现、逐模型授权、额度、动态排序与 DSH Provider+Model 选择能力，必须保留）。
- **交付约束（本工单 assignment 明确覆盖触发文本中的部署要求）**：`local work only; do not commit, push, merge, deploy or create a PR`。AGY / Codex / Grok 执行允许。
  - 因此 M7（本地提交、生产部署、生产验收）在本工单**不执行**，状态记为 `UNVERIFIED / NOT PERFORMED (delivery=local-only)`。
  - M6 的「生产链路验收、真实飞书入口」在本工单**无法完成**，只能做本地确定性验证；如实记录。

## 1. 目标（原任务）

将 `Router → DSH DeepSeek Worker → Codex/Grok/AGY CLI` 改为 `Router → 被选中的 Worker（DSH/Codex/Grok/AGY）`：
Router 负责理解、动态选模、建工单与调度；所选模型直接承担 Worker（理解、调查、编码、测试、迭代、产出）。
程序层保留 Ticket/Assignment 生命周期、项目识别与 Worktree、授权/并发/暂停/取消、完整上下文、
执行记录/资源消耗/真实模型身份、失败恢复/续接、飞书回执与 PR 追踪。**不再用 DeepSeek 作为所有外部 Harness 的必经协调层。**

## 2. M0 调查结论（只读现有直接关联代码）

### 2.1 现有调用链
- 入口：`src/app/runtime.ts` 组合根 → `DshExecutor`（`src/executor/dsh.ts`）。
- `DshExecutor.launch()`：`prepareDirectory()` → `sessions.ensure(worker-<ticketId>, workspace, title, 'worker', ticketWorkerModel(ticket))` →
  `sessions.prompt(...)`，即**总是**创建一个 DSH(DeepSeek) Worker Session，把 assignment/trigger 交付给它。
- `ticketWorkerModel()`（dsh.ts:50）：仅当 `ticket.execution.harness.harness === 'dsh'` 才按 Provider+Model 重新落座；外部 Harness 的工单仍创建 DSH 会话并使用默认模型 —— 这就是「DeepSeek 中间层」。
- 外部 CLI 目前是 DSH Worker 的工具：`src/app/tools/executor.ts` 的 `orchestrator_codex/grok/agy`，实际执行在
  `runTicketCodex`（codex.ts）、`runTicketGrok`（grok.ts）、`runTicketAgy`（agy.ts）。
- 结果证据：`executor.ts` 的 `recordHarnessRun()` 写入 `ticket.execution.harnessRuns[]`（真实模型/用量/写证据）。
- 会话/工具/提示装饰：`src/app/sessions.ts`（`ensure/decorate/prompt/relay`）。
- 生命周期回调：`src/core/engine.ts` 的 `assignmentStarted/inputsDelivered/inputsRead/turnEnded/deliveryFailed/assignmentInterrupted/report`。
- 类型：`HarnessSpec`（`src/core/ports.ts`），`Execution.harness/harnessRuns`（`src/core/model.ts`）。

### 2.2 可复用机制（不重写）
- `Effects` 持久队列（launch/delivery 已是持久 effect）。
- `Store`/`Engine`/Assignment 生命周期、`Outbox`/回执、`DshExecutor` 的 WorkerSlots 并发、resume 重启恢复骨架。
- 三个 CLI 适配器 `runTicketCodex/Grok/Agy`：启动、隔离、权限、结果读取、取消、错误分类均已实现。
- `recordHarnessRun` 证据结构。
- 模型选择/授权/额度/排序（`routing.ts`、`role-models.ts`、`main.ts`），不改。

### 2.3 关键差异
- 外部 CLI 是**一次性进程**（Codex `exec --ephemeral`、Grok `-p`、AGY `--print`），无原生持续会话。续接需基于 Ticket 上下文/历史/工作目录/检查点重建，不得谎称同一原生会话。
- 外部 CLI 无法调用 `orchestrator_report` 等 DSH 工具。故需要一个「结果上报」约定 + 安全兜底。

## 3. 实施决定（最小改动、最大复用）

1. **共享证据记录器**：把 `recordHarnessRun`/`harnessError` 抽到 `src/app/harness-evidence.ts`，供工具路径与直连路径共用，保证真实模型/用量记录一致（M5）。
2. **直连执行模块** `src/executor/direct.ts`（纯逻辑 + 可注入 runner，便于测试）：
   - `directHarnessOf(ticket)`：返回外部 Harness（codex/grok/agy）或 undefined。
   - `buildDirectTask(ticket, store)`：构造**完整**任务上下文（原始触发原文全量、assignment、历史输入、上次执行摘要/写证据、项目目录与约束），写入工作区持久文件并内联引用；不静默截断原始需求（M2）。
   - `runDirectWorker()`：按 Harness 分派到 `runTicketCodex/Grok/Agy`，归一化结果。
   - `parseWorkerReport(summary)`：解析约定的末行报告标记；无标记时**安全兜底为 progress**（未完成不得标记成功）。
3. **DshExecutor 分流**（`src/executor/dsh.ts`）：当 `execution.harness.harness ∈ {codex,grok,agy}` 时，
   `launch` 不再 `sessions.ensure`，改为运行直连 Worker；`deliver` 触发继续运行；`stop` 中止进程；`resume` 重启续接；`running` 计入直连运行。
4. **不引入**通用插件框架或第二套任务系统；外部 Worker 仍受 Ticket 授权、并发、暂停、取消约束。
5. Git/PR/部署仍服从工单授权（本工单 local-only，不授予外部操作）。

## 4. 阶段与验收（状态表）

| 阶段 | 内容 | 验收 | 当前状态 |
|---|---|---|---|
| M0 | 限域调查 | 明确可复用机制与最小改动 | **PASS**（见 §2） |
| M1 | 统一 Worker 执行入口 | Router 指定 Codex → 直接运行 Codex Worker，无中间 DSH 推理 | 见 §6 |
| M2 | 完整上下文交付与持续执行 | 原飞书话题补充要求，直接 Worker 能收到并执行 | 见 §6 |
| M3 | 恢复完整 Worker 工作能力 | Grok/Codex 同一任务内调查→改→测→修 | 见 §6（有限制） |
| M4 | 工单生命周期与自动续接 | 中断后同 Ticket/同工作目录恢复 | 见 §6 |
| M5 | 授权/路由/质量/真实模型记录 | 可从 Ticket 看出选型/实启/结果/额外调用 | 见 §6 |
| M6 | 跨 Harness 集成验收 | 真实调用链、无额外 DSH 推理 | 见 §6（生产项 UNVERIFIED） |
| M7 | 提交/部署/生产验收 | 部署+健康+烟雾 | **NOT PERFORMED**（delivery=local-only） |

## 5. 测试与证据（随施工更新）

- 本地确定性检查：`pnpm typecheck` / `pnpm test` / `pnpm build`。
- 直连路径单测：上下文完整交付、报告标记解析与兜底、无 DSH 会话创建、取消、重启重建上下文。
- 真实 CLI 冒烟：Grok Build 可用（`grok 1.0.80`，`grok-4.7-build-fast` 已验证）；Codex / AGY 在宿主未安装（`command not found`）→ 真实冒烟 UNVERIFIED。

## 6. 完成状态与遗留问题（2026-11-16）

> 交付更新（2026-11-16）：来源方已授权「设为默认、迁移旧测试、部署时打开开关」，并解除首轮 local-only 限制，允许提交与验收。下列为启用默认后的最终状态。

### 阶段结论
- **M0 调查：PASS**（见 §2）。
- **M1 统一 Worker 执行入口：PASS（已设为默认：`executor.directWorkers` 默认 true）**。新增 `src/executor/direct.ts`、`src/executor/direct-runner.ts`；`DshExecutor.launch` 在开关开启且 Harness 为 codex/grok/agy 时直接运行 CLI，**不创建中间 DSH(DeepSeek) 会话**。`tests/direct-worker-integration.spec.ts` 证明：启用后 `worker-<id>` DSH 会话不存在，CLI 被直接调用一次，并写入真实 Harness 证据。
- **M2 完整上下文与持续执行：PASS（机制）/ UNVERIFIED（真实飞书端到端）**。`buildDirectTask` 原样注入原始触发全文（不截断）、assignment、全部后续输入；`directLoop` 每轮交付并标记等待中的 Inputs，随后再循环。「原文/后续消息进入任务」由单测覆盖；真实飞书追加消息端到端需部署，UNVERIFIED。
- **M3 恢复完整 Worker 能力：PARTIAL**。Grok 可真实读写文件（已用 search_replace 建文件验证）；但适配器当前安全姿态不允许 `run_terminal_cmd`，故 CLI 内构建/测试执行未启用；Codex/AGY 宿主未安装（`command not found`）。未以模拟冒充真实通过。
- **M4 生命周期与续接：PARTIAL / UNVERIFIED**。`stop` 中止直连进程；`resume` 对运行中的外部工单以恢复注记重启并保留工作区；取消、重启恢复的端到端未在生产演练。
- **M5 授权/路由/真实模型记录：PASS（本地）**。证据经共享 `src/app/harness-evidence.ts` 写入 `harnessRuns`，含 requestedModel/servedModel/usage/写证据。
- **M6 跨 Harness 集成：UNVERIFIED（真实 CLI）**。真实 Codex/AGY 仍不可用；默认直连行为由 `tests/direct-worker-integration.spec.ts` 在默认设置下证明（无 DSH 会话、CLI 直连一次、写入证据、无标记不臆造 ready）。真实跨 Harness 冒烟待宿主安装 CLI。
- **M7 提交/验收：PARTIAL**。已提交分支并发起 PR、本地 typecheck/build/测试通过；生产部署与生产验收由运维执行（仓库无 merge CLI 与部署脚本）。

### 默认启用与旧测试迁移
- `executor.directWorkers` 默认 `true`：外部 Harness（codex/grok/agy）工单默认由选中 CLI 直接作为 Worker 运行，不再创建中间 DSH(DeepSeek) 会话。
- `tests/native-routing-integration.spec.ts` 的 26 个用例验证的是 `orchestrator_grok/codex/agy` 工具层、evaluation 与 routing，与 Executor 的分流无关；改为在该 spec 内显式 `directWorkers:false`（保留旧 DSH 会话的被测环境），从而在新默认下继续通过。
- 新增 `tests/direct-worker-integration.spec.ts`（2 例）在**默认设置**下验证新架构：无 `worker-<id>` DSH 会话、CLI 直连一次、写入 Harness 证据、且无报告标记时安全兜底为 `progress` 而非 `ready`。

### 测试证据
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- 新增 `tests/direct-worker.spec.ts`（7 例）、`tests/direct-worker-integration.spec.ts`（2 例）：通过。
- 相关回归 `tests/native-routing-integration.spec.ts`、`tests/docs.spec.ts`、`tests/policy.spec.ts`、`tests/panel-settings.spec.tsx`、`tests/tools.spec.ts`：通过。
- 全量套件：`1530 passed`，仅既有 `tests/cards.spec.ts`(5)、`tests/runtime.spec.ts`(2) 失败（与本次改动无关）；`tests/docs.spec.ts` 由失败转为通过。`tests/tools.spec.ts` 在并行负载下偶发 5s 超时，单独运行 26 例通过。

### 遗留问题（真实限制）
1. 未真实验证 Codex/AGY（宿主无 CLI）；Grok 终端/测试执行未启用（适配器安全姿态）。
2. 真实飞书追加消息端到端、服务重启恢复、生产部署与生产验收需运维在部署环境执行。

## 7. 变更文件清单
- 新增 `src/app/harness-evidence.ts` — 共享 Harness 运行证据记录（自 `tools/executor.ts` 抽出）。
- 新增 `src/executor/direct.ts` — 直连 Worker 纯逻辑（Harness 选择、完整任务上下文、报告标记解析与安全兜底）。
- 新增 `src/executor/direct-runner.ts` — 直连 Runner（按 Harness 分派 Codex/Grok/AGY 适配器并归一化结果）。
- 修改 `src/app/tools/executor.ts` — 改用共享证据记录器。
- 修改 `src/executor/dsh.ts` — 外部 Harness 直连分流（launch/deliver/stop/resume/running + directLoop），受 `executor.directWorkers` 控制。
- 修改 `src/policy.ts` — 新增 `executor.directWorkers`（默认 true，默认直连）。
- 修改 `docs/007-architecture.md` — 补齐新模块与测试行（并修复既有表格漂移）。
- 新增 `tests/direct-worker.spec.ts`、`tests/direct-worker-integration.spec.ts`。
