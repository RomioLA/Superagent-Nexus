# 26111602 生产故障修复与交付记录

日期：2026-11-16（北京时间）。结论：本地整合与通知修复已验证；生产部署受 Magpie 凭证阻塞，未切换版本。

## 交付基线与隔离

- 独立本地仓库：`/home/superagent/jobs/superagent-dev/nexus-production-fix-26111602`。
- 分支：`codex/26111602-production-fix`。
- 生产基线：`24fe97d3d65b02351eac2efdeb3c5c0af58cbf6f`。
- 26111601 的 15 文件整合来自 `/home/superagent/jobs/tickets/model-scan-page-8843ae99fc95`，未经重写、重复合并或覆盖。
- 整合提交：`22d55ec3166a8ed1dec449696ef05e9df132edbe`（15 文件，289 行增加、35 行删除）。
- 原目录 `git diff --binary HEAD` 与该提交相对生产基线的补丁逐字节一致；SHA-256：`64926e3802ae1114e479adf14a179f354554c5f90ed522233bd3e257a337aa66`。
- 主仓库、聊天附带工作区和其他工单的未提交成果均未修改。未向 GitHub 推送。

## 子代理 A：401 与 Router 超时

只读核查生产 profile、PID 355 的必要环境变量、指定凭证文件、生产 DB 与相关 Session 事件；未输出凭证或错误中的 Key 片段。

- `scripts/dsh-superagent:176-187` 从两份独立文件加载 `MAGPIE_ROUTER_KEY` 与 `MAGPIE_WORKER_KEY`。
- 生产 profile `cordis.patch.yml:11-27` 的 `magpie` / `magpie-worker` provider 分别以这两个变量作 LLM API Key。它们同时供已有 Magpie 遥测读取器使用。
- Router 模型：`magpie/auto/deepseek-v4.1-flash`；Worker 模型：`magpie-worker/auto/deepseek-v4.1-flash`。
- 生产进程中的两变量均非空，分别与当前指定文件一致；两份文件内容不同。没有加载错位或旧环境残留证据。
- 分别以这两份现有凭证 GET 当前配置网关 `/models`，均返回 HTTP 401。未发模型推理请求、替换 Key 或切换账号。
- 可确认的根因是网关拒绝当前配置凭证；无法仅凭 401 确定管理端为何使其失效（例如禁用、删除等）。现有已授权配置未提供可验证有效的替代值，单纯重启不能恢复。凭证阻塞未解决。

以下时间均为 UTC，避免和北京时间混淆：

- 早先 Eval 在 `02:15:38.592Z` 记录 timeout；相应模型事件是 timeout 类，早于 `02:28` 的 Worker 401。不能将它确定归因于后来的认证失败。
- 26111602 的 Worker 在 `02:28:13.708Z` 记录认证失败。随后主 Session 多次出现 Router AUTH/401。
- 用户指出的随后普通消息（Thread 尾部 `om_x100b6092130dccb4dfb85c5833af1dc`）：候选于 `03:35:15.530Z` 到达主 Session（seq 5253），`03:35:15.579Z` 开始评估（seq 5257）；`03:35:15.659Z` Router 请求即 AUTH/401（seq 5258），下一事件以 AUTH 结束该轮。
- 相同 Eval 于 `03:37:16.074Z` 记录 `unavailable/timeout`（Decision `13b0cd…`，Eval `f101f…`，Trigger `eebce3…`）。候选投递后立即认证失败，主 Session 无法完成评估，最终 deadline 超时；这是这一次后续超时由 Router 认证拒绝阻塞的直接运行证据。

因此，当前 Worker 与 Router 都受同一类网关认证故障影响，但使用不同 Key；没有证据表明 Worker 的 401 本身导致 Router 超时。未发现必须单独修改 Router 的可复现代码缺陷，本次未改 Router 超时逻辑。

## 子代理 B：失败通知断点

以 SQLite `mode=ro` / `query_only=ON` 和指定主 Session 的持久事件核对：

- 工单 26111602：`e3d4226005548eecd740f35b800b756f`；Assignment `9880fcad4329c8c9707ad721feea3be3`。
- Assignment 状态仍为 running，其 report 已是 failed，时间 `02:28:13.708Z`；Ticket 尚未 ended。这是当前项目的失败等待人工生命周期。
- Outbox 对该 Ticket 只有已 sent 的 acknowledgement，没有 result 或故障 notice。
- 主 Session `orchestrator-7f8fa96b1001d68c0806237e5232a650` 的 seq 5232 确实保存了该 Ticket 的 `worker_report` relay；seq 5233 模型请求 AUTH，后续 seq 5242、5250、5258 也为 AUTH。
- 对照工单 26111601 已 completed，Outbox 有 sent acknowledgement 和 result。

实际断点为：Worker error → Engine failed report → relay → Router Session 均已发生；Router 模型认证失败，无法调用 reply 生成 Outbox result。relay 已被 Session 接收，所以 effect/relay 显示 ready 并不意味着用户已获通知。

相关调用链：整合目录 `src/executor/dsh.ts:466-474,620-625`；`src/core/assignments.ts:99-126`；`src/app/notices.ts` 的 resultRelay/reportRelay；`src/app/sessions.ts` 的 relay effect handler；`src/core/replies.ts` 的 result 规则和 ID；`src/app/outbox.ts` 的持久回执与投递。

另一个幂等缺口：每次重复失败都会刷新 report.at，而 relay/result ID 包含这个时间，原代码不能仅靠 Outbox 去重重复的 agent/error。

## 最小修复

- `src/executor/dsh.ts`：ExecutorHost 复用已有 Engine.reply；不可自动恢复的 Executor 失败在原事务中写 report、直接排入安全的飞书 result，再保留原 relay。
- 只对原有 result 规则允许的 explicit Feishu 请求通知；固定文案含工单编号、失败状态、Worker 执行异常类别、已停止自动处理和需要人工处理。文案不复制原始异常、API Key、内部路径或任意标题。
- 复用 `Replies` 的 result ID 与原 Outbox；同一 stalled Assignment 重复错误保留原 report.at，因而保留相同回执 ID。Router 后续对同一失败 report 的 result 也复用该回执。
- 显式 retry 创建的新 Assignment 可独立产生自己的失败回执；正常 progress、blocked 技术报告、成功回复、完成和 PR 通知路径保持原机制。
- `tests/notification-integration.spec.ts`：新增完整 Runtime/真实本地 Store/Outbox 回归。阻止主 Session 接收 relay，仍能投递失败回执；覆盖脱敏、原话题、跨时间重复错误、Router 补回复去重、新 Assignment 合法重试。
- 本记录为第三个新增修复相关文件。没有新增通知服务、轮询、凭证切换、Fallback 或重试框架。

## 验证结果

- `pnpm test tests/notification-integration.spec.ts tests/runtime.spec.ts tests/runtime-concurrency.spec.ts`：3 文件、172 项通过。
- `pnpm test tests/models.spec.ts tests/model-surface.spec.ts tests/routing.spec.ts tests/native-routing-integration.spec.ts tests/panel-routing.spec.tsx`：5 文件、84 项通过，保留原整合验收覆盖（含真实 Codex 安装路径检测、扫描视图、授权、自主选模及页面）。
- 共 256 项不同定向测试通过。新增回归另单独运行通过，未计为额外独立用例。
- `pnpm typecheck`：通过。
- `pnpm build`：通过（既有客户端 CJS 建议提示，不影响构建）。
- `git diff --check`：通过。

## 生产与工单处置

- 已审阅原项目服务脚本及最近生产部署脚本、备份/回滚流程；执行会话独立于 Superagent 服务。
- 在凭证预检阶段停止，未调用版本切换/重启脚本，未修改 production profile、发布目录或生产 DB，未触发自动恢复与补发。
- 最后只读复核：生产仍指向 `/home/superagent/.dsh/releases/dsh-superagent/24fe97d-p2-phase2-20261115T151434Z`；runtime ready；12/13 健康项 ready，evals error；running=0，queued=0，paused=false。
- 新版模型扫描 API、Codex 发现与通知修复均已本地验证；由于未切换生产版本，不声称新版生产接口或真实飞书通知已验收。
- 没有制造生产故障，也没有向真实飞书发送测试消息。
- 26111602 保留为 failed / 等待人工处理，不关闭、不在无效凭证下重试。有效凭证恢复并通过生产调用预检后，才能恢复同一工单的部署；本轮未擅自改写其生产记录。
