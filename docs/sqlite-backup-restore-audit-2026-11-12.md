# SQLite 一致性备份与恢复只读核对（S4）

- 日期：2026-11-12
- 基线：`7cca2df3a709e00f5712edfa34de543457b4fedb`
- 本轮范围：**只读核对 + 可执行备份 / 隔离恢复方案**。未写生产库、未建定时任务、未做生产恢复演练。
- 状态：**PARTIAL** —— 只读核对与方法验证完成；生产备份写入、恢复演练、定时任务均需单独授权，未执行。

## 一、结论摘要

| 核对项 | 结论 |
| --- | --- |
| 现有可靠 SQLite 在线备份 | **无**（代码、脚本、crontab、systemd timer 均无；stateDir 无历史备份文件） |
| 原生在线备份能力 | 可用 `VACUUM INTO`；`node:sqlite`(`DatabaseSync`) **无** `backup()`，系统**未装** `sqlite3` CLI |
| 现有文档指引是否安全 | **不安全**：升级步骤让服务运行中直接复制 `orchestrator.sqlite` 主文件，在 WAL 模式下会丢数据（见第二节实测） |
| 可执行方案 | 已用临时库端到端验证：在线快照 + 完整性检查 + 隔离恢复校验均通过 |
| 生产实际备份 / 恢复演练 / 定时任务 | **未执行**（需单独授权） |

## 二、现状核对（只读）

- 存储：单文件 `<stateDir>/orchestrator.sqlite`，仅 `Store` 打开（`docs/007-architecture.md:472`）。本机 `stateDir=/home/superagent/.dsh/state/superagent`。
- 打开方式：`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL`（`src/app/store.ts:64`）；目录以 `0o700` 创建（`src/app/runtime.ts:92`），文件 `chmod 0o600`（`src/app/store.ts:63`）。
- 并发保护：启动前用 `proper-lockfile` 锁住 stateDir（`src/app/runtime.ts:94`），关闭库后释放。
- 实测文件（2026-11-12 17:08，服务运行中）：

  | 文件 | 大小 | 权限 | 属主 | mtime |
  | --- | --- | --- | --- | --- |
  | `orchestrator.sqlite` | 557,056 B | 600 | superagent:superagent | 16:24 |
  | `orchestrator.sqlite-wal` | 1,590,352 B | 600 | superagent:superagent | 17:08 |
  | `orchestrator.sqlite-shm` | 32,768 B | 600 | superagent:superagent | 17:08 |
  | stateDir 目录 | — | 755 | superagent:superagent | — |

- 只读诊断（`readOnly:true` 连接，未写库）：`journal_mode=wal`、`page_size=4096`、`page_count=153`、`freelist=0`、`kv.schema=11`、`integrity_check=ok`、`quick_check=ok`。
- 只读行数：`trigger` 38 / `disposition` 38 / `thread` 34 / `ticket` 23 / `decision` 41 / `outbox` 48 / `effect` 0 / `kv` 122。
- 现有备份机制：`scripts/` 无备份脚本；`crontab` 无相关项；`systemd` 无相关 timer；stateDir 内无历史备份文件（仅 `settings.before-role-split-20261108.json`，是 2026-11-08 的手工配置导出，非数据库备份）。
- 现存文档：`docs/006-deployment.md:236` 升级步骤仅写 "Back up `<stateDir>/orchestrator.sqlite`"，未提及 WAL，且在服务运行中执行。

## 三、一致性风险（关键发现）

WAL + `synchronous=FULL` 下，**直接复制 `orchestrator.sqlite` 主文件不是一致备份**：已提交但尚未 checkpoint 的数据只在 `-wal` 中，主文件可能几乎不含数据；服务运行中复制还可能拿到撕裂的中间状态。

临时库实测（WAL + `synchronous=FULL`，已提交 2000 行）：

```
主文件: 4,096 B      -wal: 564,472 B
仅复制主文件后打开: ERROR: no such table: ticket   ← 相当于全部丢失
VACUUM INTO 快照: 2000 行（快照时刻一致）, integrity_check=ok
```

即现有升级指引中的“运行中复制主文件”有真实数据丢失风险。

## 四、推荐方案：SQLite 原生在线快照（`VACUUM INTO`）

- Node v22.23.4 的 `node:sqlite`（SQLite 3.53.4）`DatabaseSync` **没有** `backup()` 方法；系统**没有** `sqlite3` 命令行，无法用 `.backup`。
- 唯一可用的原生在线一致性备份是 SQL `VACUUM INTO '<file>'`：在单个读事务上生成独立、紧凑的快照，包含已提交的 WAL 内容，**不修改源库、无需停服、无需新二进制或守护进程**。
- 实测特性：快照 `journal_mode=delete`、`integrity_check=ok`、旁无 `-wal/-shm`；快照后继续写源库不影响快照；对只读源连接执行亦可。
- 约束：目标文件必须不存在；并发写用 `busy_timeout`；输出为普通单文件库，可直接用于恢复或只读核查。

## 五、可执行备份方案

- 存储位置：独立于 stateDir，避免与库同目录被误删 —— `/home/superagent/.dsh/backups/superagent/`。
- 命名：`orchestrator-<UTC 时间戳>.sqlite`（如 `orchestrator-20261112T091023Z.sqlite`）。
- 权限：备份目录 `700`，备份文件 `600`，属主 `superagent`。
- 保留：建议保留最近若干份 + 每次升级前一份（具体份数属运维策略，本轮未配置）。
- 一次性命令（不常驻、不建框架；已在临时库端到端验证）：

```sh
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR=${1:?usage: backup-recipe.sh <stateDir> [backupDir]}
BACKUP_DIR=${2:-/home/superagent/.dsh/backups/superagent}
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$BACKUP_DIR/orchestrator-$STAMP.sqlite"
[ ! -e "$DEST" ] || { echo "refusing to overwrite $DEST" >&2; exit 1; }
DSH_SRC="$STATE_DIR/orchestrator.sqlite" DSH_DEST="$DEST" node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite'
const { DSH_SRC: src, DSH_DEST: dest } = process.env
const db = new DatabaseSync(src, { readOnly: true })
try { db.exec('PRAGMA busy_timeout=10000'); db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`) } finally { db.close() }
NODE
chmod 600 "$DEST"
DSH_DEST="$DEST" node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.env.DSH_DEST, { readOnly: true })
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check
const schema = db.prepare("SELECT value FROM kv WHERE key='schema'").get()?.value
db.close()
if (integrity !== 'ok') { console.error('integrity_check failed:', integrity); process.exit(1) }
console.log(JSON.stringify({ file: process.env.DSH_DEST, integrity, schema }))
NODE
echo "backup ok: $DEST"
```

验证结果：

```
{"file":".../orchestrator-20261112T091023Z.sqlite","integrity":"ok","schema":"11"}
backup ok: .../orchestrator-20261112T091023Z.sqlite
独立复核: rows 3000, schema 11, integrity ok
目录 700 / 文件 600
```

## 六、隔离恢复验证方案（不碰生产）

轻量校验（对备份文件只读打开，零风险）：

```sh
node --input-type=module - "$BACKUP" <<'NODE'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2], { readOnly: true })
console.log('integrity:', db.prepare('PRAGMA integrity_check').get().integrity_check)
console.log('quick:', db.prepare('PRAGMA quick_check').get().quick_check)
console.log('schema:', db.prepare("SELECT value FROM kv WHERE key='schema'").get()?.value)
db.close()
NODE
```

应用级隔离演练（**恢复演练，需单独授权后执行**，绝不指向生产 stateDir）：

1. `export DSH_HOME=/tmp/s4-restore-<ts>`，按 `docs/006` 生成**新** profile（不要用 profile 创建命令覆盖现有 profile）。
2. 把备份复制到新 stateDir 下的 `orchestrator.sqlite`（`600`）。
3. 禁用全部 Source、暂停处理、移除 master Session id（`docs/007-architecture.md:632` 列有同样步骤）。
4. 用只读 stand-in 的 GitHub / Feishu CLI 启动，确认 Overview 能读取且不写生产。
   本轮未执行该演练。

## 七、生产恢复步骤（需单独授权后由运维执行）

1. `scripts/dsh-superagent stop`，确认进程已退出（优雅关闭会在关闭时 checkpoint 并清 WAL）。
2. 把现有 `orchestrator.sqlite`、`orchestrator.sqlite-wal`、`orchestrator.sqlite-shm` 移入隔离目录保留回滚（不要直接删除）。
3. 将选定备份复制为 `<stateDir>/orchestrator.sqlite`，`chmod 600`，属主 `superagent`，并确认旁边无残留 `-wal/-shm`。
4. `scripts/dsh-superagent start`，用 `status` 检查；对恢复库做只读 `integrity_check` 与 `kv.schema` 校验。
5. 注意：被新版本迁移过的库旧版本无法打开，回滚必须使用升级前备份（`docs/006-deployment.md` 已述）。

## 八、未执行事项（需单独授权）

- 对生产库执行实际 `VACUUM INTO` 备份写入。
- 生产数据恢复演练。
- 任何定时 / 自动备份任务（cron / systemd timer）的新增或修改。

本 S4 仅完成只读核对与方法验证（临时库）。

## 九、验证证据

在线快照与“裸复制不安全”的对照（临时库，`/tmp/s4-*`）：

```
writer committed initial rows: 2000
files after first commit: orchestrator.sqlite, orchestrator.sqlite-shm, orchestrator.sqlite-wal
main db bytes: 4096  wal bytes: 564472
VACUUM INTO produced snapshot: true bytes: 532480
writer rows after later commits: 2500
naive main-file-only copy rows: ERROR: no such table: ticket
snapshot journal_mode: delete
snapshot integrity_check: ok
snapshot rapid_check: ok
snapshot rows (expect 2000, the point-in-time count): 2000
snapshot schema kv: 11
snapshot has no -wal/-shm beside it: true
restored-from-snapshot integrity_check: ok
restored-from-snapshot rows: 2000
VACUUM INTO over read-only source connection: true (file created)
```

生产库只读诊断（未写库）：

```
journal_mode: wal
page_size: 4096 page_count: 153 freelist: 0
schema_version(kv): 11
integrity_check: ok
quick_check: ok
table row counts: trigger 38 / disposition 38 / thread 34 / ticket 23 / decision 41 / outbox 48 / effect 0 / kv 122
```
