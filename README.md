# 节点排空演练模拟器

机房检修前的排空演练：选一台节点“排空”，系统先把每个业务的新副本**预留**到目标节点，模拟新副本就绪后才停掉旧副本；容量不够或模拟启动失败时旧副本继续服务，并将容器列为受阻。所有状态存在 SQLite，重启后可继续未完成的排空（含在途业务请求与待切换迁移）。

此外可在网页上对任意业务发起**模拟长请求**，演练“请求还在处理时节点开始排空”的场景：每个在服副本同时最多承接一笔；排空中的旧副本、启动中/待切换的副本不接新请求；新副本就绪但旧副本仍在处理请求时进入「待切换」，目标 CPU 持续预留，等请求结束的同一事务内才完成唯一一次切换。

## 快速启动

```bash
docker compose up --build
# 打开 http://localhost:8000  （可用 APP_PORT=8080 docker compose up --build 改端口）
```

首次启动若数据库为空，会自动载入 `examples/cluster.json` 作为示例拓扑。数据位于命名卷 `simulator-data` 中的 `/data/rehearsal.db`。

停止容器后数据仍在；`docker compose down -v` 会连同卷一起删除。

不使用 Docker 时：

```bash
python3 -m pip install -r requirements.txt
DATABASE_PATH=./data/rehearsal.db SEED_TOPOLOGY=./examples/cluster.json \
  python3 -m uvicorn app.main:app --port 8000
```

## 网页操作

1. 左侧「导入集群」粘贴或上传 JSON（最多 4 个节点、8 个容器），导入会清空当前演练状态与历史。
2. 节点卡片点「排空」：立即为可迁移副本在目标节点预留 CPU，并列出“新副本启动中”。
3. 对每个启动中的迁移点「新副本就绪」（切换完成后旧副本才停止）或「模拟启动失败」（保留旧副本，列为受阻）。
4. 「受阻容器」面板列出旧副本仍在服务的容器及原因；修正容量后点节点上的「继续」重试。
5. 节点上没有任何服务副本后才会显示「已空」；进度条与“节点上剩余副本”分开统计，未就绪的新副本不计入业务就绪数。
6. 演练后点「恢复」可把已空节点放回可用池，便于反复演练。

### 长请求演练（「模拟业务请求」面板）

1. 选择业务后点「发起模拟请求」，系统在写锁内挑选一个**可接单**的在服副本承接，并显示承接副本与节点。可接单 = 节点处于可用、副本没有启动中/待切换迁移、且当前没有在处理请求。
2. 每个副本同时最多处理一笔；排空中节点上的旧副本、启动中与待切换副本都不接新请求；没有可接单副本时请求以 `rejected` 落库并在面板明确显示拒绝原因（不会静默丢弃）。
3. 先发起请求、再排空该副本所在节点并点「新副本就绪」：迁移进入**待切换**——新副本继续占用目标 CPU，旧副本仍在服务，排空进度、节点剩余副本数、业务就绪数都不变化。
4. 点「结束请求」：请求完成与副本切换在同一事务内完成，旧副本此刻才停止；每个迁移只切换一次，重复结束/重复就绪都会被拒绝（409）。
5. 若新副本「模拟启动失败」，预留立即释放，旧副本上的在途请求仍可正常结束。
6. 重启服务后，在途请求与待切换迁移都从 SQLite 恢复，可继续结束请求并完成切换。

## JSON 格式

```json
{
  "nodes": [
    {"id": "node-a", "name": "机房 A 机柜-01", "cpu_capacity": 16}
  ],
  "containers": [
    {"id": "api-1", "name": "api-1", "service": "api",
     "min_ready": 2, "node_id": "node-a", "cpu_request": 2}
  ]
}
```

校验规则：

- `nodes` 1–4 个，`containers` 0–8 个；`id` 唯一，容器必须引用已声明的节点。
- 节点上所有容器的 `cpu_request` 之和不得超过 `cpu_capacity`。
- 同一 `service` 的所有容器 `min_ready` 必须一致，且不超过该业务的容器数。
- CPU 单位为整数（如“核”）；单值上限 100000。

## HTTP API（网页同源使用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 完整读模型：节点、容器、业务就绪度、排空进度、受阻容器、模拟请求、历史 |
| POST | `/api/topology` | 导入并重置拓扑 |
| GET | `/api/topology/example` | 示例拓扑（网页“载入示例”按钮使用） |
| POST | `/api/reset` | 清空全部演练状态 |
| POST | `/api/nodes/{node_id}/drain` | 发起排空 |
| POST | `/api/nodes/{node_id}/resume` | 重试未完成排空的受阻副本 |
| POST | `/api/nodes/{node_id}/restore` | 把已空节点恢复为可用 |
| POST | `/api/migrations/{migration_id}/resolve` | `{"outcome":"ready"\|"failed","reason":"..."}` |
| POST | `/api/requests` | `{"service":"..."}` 发起模拟长请求；无可接单副本时返回 200 且最新请求为 `rejected` |
| POST | `/api/requests/{request_id}/complete` | `{"result":"..."}`（body 可省略）；若迁移在待切换则同事务完成唯一一次切换 |
| GET | `/api/drains/{drain_id}` | 单个排空任务进度 |
| GET | `/healthz` | 健康检查 |

错误统一返回 `{"error": {"code": "...", "message": "..."}}`，校验失败时额外带 `details` 列表。

## 迁移语义与安全约束

- **容量口径**：节点已用 = 正在服务副本的请求 + 启动中/待切换新副本的预留。旧副本在切换前始终计入源节点。
- **先预留后切换**：`drain` 在同一事务内挑选目标并写入 `starting` 预留；`resolve ready` 在同一事务内把新副本落到目标并移走旧副本，就绪数不会中途下跌。
- **长请求不中断（待切换）**：`resolve ready` 时若旧副本仍有 `running` 请求，迁移转为 `awaiting_cutover` 而不是切换——目标 CPU 预留保留、旧副本继续服务，排空进度与业务就绪数均不变化；请求结束（`/api/requests/{id}/complete`）的同一事务内才提升新副本、停掉旧副本，迁移状态本身是“只切换一次”的并发闸门。
- **请求接单口径**：只有 `ready` 节点上、没有未决迁移（`starting`/`awaiting_cutover`）且没有在途请求的 `serving` 副本能接单；部分唯一索引保证每个副本至多一笔 `running` 请求，并发提交由 `BEGIN IMMEDIATE` 串行化。无副本可接单时写入 `rejected` 请求并给出原因码（`SERVICE_DRAINING` / `REPLICA_STARTING` / `REPLICA_PARKED` / `REPLICA_BUSY` / `NO_REPLICA`）。
- **不重复占容量**：所有写操作走 SQLite `BEGIN IMMEDIATE`，在锁内重新读取节点用量；两个并发排空不会对同一空闲容量各预留一次。
- **失败/无落点**：预留释放，旧副本继续服务，容器进入受阻列表（`INSUFFICIENT_CAPACITY` / `NO_USABLE_TARGET` / `REPLICA_START_FAILED`）；新副本启动失败不影响旧副本上在途请求的完成。
- **自上而下**：正在排空或已空的节点不会成为目标；有入库预留（含待切换）的节点不允许被发起排空，直到这些新副本被决策。
- **重启续作**：所有状态都在 SQLite 中，启动时只做派生状态校正（`reconcile`）与旧版 schema 就地升级（`PRAGMA user_version`），不重放、不丢失预留、在途请求或待切换迁移；未完成排空显示“未完成”并带「继续」入口。
- **节点已空**：仅当节点没有任何服务副本、没有预留、且排空已完成时才为 `drained`，前端 `is_empty` 同样由事实推导。

## 自测

```bash
python3 -m pip install -r requirements.txt pytest httpx
python3 -m pytest tests -q
```

- `tests/test_flow.py` 覆盖：导入校验、预留与就绪口径、成功切换、启动失败保底、无可行落点、并发排空不超额、重启续作、未完成排空不误报“已空”、受阻重试、已空节点恢复。
- `tests/test_requests.py` 覆盖：请求绑定单一副本、每副本一笔、排空中/待切换明确拒绝、就绪后待切换且进度与就绪数不变、请求结束触发唯一一次切换、启动失败释放预留且原请求可完成、多请求交错各切换一次、重启后续作在途请求与待切换、并发提交不重复占用副本。
- `tests/test_schema_migration.py` 覆盖：v1 数据库就地升级后历史状态保留、新功能可用、外键完整性。
