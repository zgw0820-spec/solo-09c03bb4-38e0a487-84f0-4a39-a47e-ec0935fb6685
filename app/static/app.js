"use strict";

const SAMPLE = {
  nodes: [
    { id: "node-a", name: "机房 A 机柜-01", cpu_capacity: 16 },
    { id: "node-b", name: "机房 A 机柜-02", cpu_capacity: 16 },
    { id: "node-c", name: "机房 A 机柜-03", cpu_capacity: 8 },
    { id: "node-d", name: "机房 A 机柜-04", cpu_capacity: 4 },
  ],
  containers: [
    { id: "api-1", name: "api-1", service: "api", min_ready: 2, node_id: "node-a", cpu_request: 2 },
    { id: "api-2", name: "api-2", service: "api", min_ready: 2, node_id: "node-a", cpu_request: 2 },
    { id: "api-3", name: "api-3", service: "api", min_ready: 2, node_id: "node-b", cpu_request: 2 },
    { id: "web-1", name: "web-1", service: "web", min_ready: 1, node_id: "node-a", cpu_request: 1 },
    { id: "web-2", name: "web-2", service: "web", min_ready: 1, node_id: "node-b", cpu_request: 1 },
    { id: "worker-1", name: "worker-1", service: "workers", min_ready: 1, node_id: "node-a", cpu_request: 3 },
    { id: "worker-2", name: "worker-2", service: "workers", min_ready: 1, node_id: "node-b", cpu_request: 3 },
    { id: "cache-1", name: "cache-1", service: "cache", min_ready: 1, node_id: "node-d", cpu_request: 4 },
  ],
};

const STATE = {
  data: null,
  selectedNode: null,
  busy: false,
  lastRefresh: null,
  reasonDrafts: {},
  requestResultDrafts: {},
  pausedUntil: 0,
};

const $ = (id) => document.getElementById(id);

const STATUS_LABELS = {
  ready: "就绪",
  draining: "排空中",
  drained: "已空",
  serving: "服务中",
  starting: "新副本启动中",
  awaiting_cutover: "待切换",
  completed: "已完成",
  failed: "启动失败",
  blocked: "受阻",
  active: "进行中",
  incomplete: "未完成",
  running: "处理中",
  rejected: "已拒绝",
};

const REASON_LABELS = {
  INSUFFICIENT_CAPACITY: "目标节点容量不足",
  NO_USABLE_TARGET: "没有可用目标节点",
  REPLICA_START_FAILED: "新副本模拟启动失败",
  RESERVATION_LOST: "目标容量预留失效",
  NO_REPLICA: "业务没有可接单的在服副本",
  SERVICE_DRAINING: "节点排空中的旧副本不接新请求",
  REPLICA_STARTING: "副本的新副本启动中，暂不接新请求",
  REPLICA_PARKED: "副本等待请求结束后切换，不接新请求",
  REPLICA_BUSY: "副本正忙（同时最多一笔）",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function statusBadge(status) {
  const label = STATUS_LABELS[status] || status;
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

let toastTimer = null;
function toast(message, kind = "ok") {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
}

function setBusy(busy) {
  STATE.busy = busy;
  document.body.classList.toggle("busy", busy);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(formatApiError(payload, response.status));
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function formatApiError(payload, status) {
  if (!payload || !payload.error) return `请求失败 (${status})`;
  const details = payload.error.details;
  if (Array.isArray(details) && details.length) {
    const lines = details
      .map((item) => `${item.field}: ${item.message}`)
      .join("\n");
    return `导入失败 (${payload.error.code})\n${lines}`;
  }
  return `${payload.error.code}: ${payload.error.message}`;
}

function applyState(data) {
  // Keep any half-typed failure reason across the periodic re-render.
  document.querySelectorAll("[data-reason-for]").forEach((input) => {
    STATE.reasonDrafts[input.dataset.reasonFor] = input.value;
  });
  document.querySelectorAll("[data-request-result-for]").forEach((input) => {
    STATE.requestResultDrafts[input.dataset.requestResultFor] = input.value;
  });
  STATE.data = data;
  STATE.lastRefresh = new Date();
  if (STATE.selectedNode) {
    const exists = data.nodes.some((node) => node.id === STATE.selectedNode);
    if (!exists) STATE.selectedNode = null;
  }
  const liveIds = new Set(
    data.open_drains.flatMap((drain) => drain.pending_decisions.map((m) => String(m.id)))
  );
  Object.keys(STATE.reasonDrafts).forEach((id) => {
    if (!liveIds.has(id)) delete STATE.reasonDrafts[id];
  });
  const liveRequests = new Set(
    (data.requests || []).filter((r) => r.status === "running").map((r) => String(r.id))
  );
  Object.keys(STATE.requestResultDrafts).forEach((id) => {
    if (!liveRequests.has(id)) delete STATE.requestResultDrafts[id];
  });
  render();
  document.querySelectorAll("[data-reason-for]").forEach((input) => {
    const draft = STATE.reasonDrafts[input.dataset.reasonFor];
    if (draft && !input.value) input.value = draft;
  });
}

async function refresh({ silent = true } = {}) {
  try {
    const data = await api("/api/state");
    applyState(data);
  } catch (error) {
    if (!silent) toast(error.message, "error");
  }
}

async function mutate(path, body) {
  if (STATE.busy) return;
  setBusy(true);
  document.body.classList.add("busy");
  try {
    const data = await api(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    applyState(data);
    return data;
  } catch (error) {
    toast(error.message, "error");
    return null;
  } finally {
    STATE.busy = false;
    document.body.classList.remove("busy");
    if (STATE.data) render();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const data = STATE.data;
  if (!data) return;
  renderTopbar(data);
  renderNodes(data);
  renderServices(data);
  renderDrains(data);
  renderRequests(data);
  renderBlocked(data);
  renderContainers(data);
  renderHistory(data);
  $("import-btn").disabled = STATE.busy;
  $("sample-btn").disabled = STATE.busy;
  $("import-btn").title = data.topology_loaded
    ? "导入会清空当前演练进度和历史"
    : "导入集群拓扑";
}

function renderTopbar(data) {
  const host = $("topbar-status");
  const chips = [];
  if (!data.topology_loaded) {
    chips.push(`<span class="pill">未导入拓扑</span>`);
  } else {
    chips.push(
      `<span class="pill info">${data.nodes.length} 节点 · ${data.containers.length} 容器</span>`
    );
    const unhealthy = data.services.filter((s) => !s.healthy);
    if (unhealthy.length) {
      chips.push(
        `<span class="pill danger">${unhealthy.length} 个业务低于最小就绪</span>`
      );
    } else {
      chips.push(`<span class="pill ok">所有业务满足最小就绪</span>`);
    }
    if (data.active_drain_count) {
      chips.push(`<span class="pill warn">${data.active_drain_count} 个排空进行中</span>`);
    }
    if (data.unfinished_drain_count) {
      chips.push(
        `<span class="pill danger">${data.unfinished_drain_count} 个排空未完成，可继续</span>`
      );
    }
    if (data.blocked_containers.length) {
      chips.push(
        `<span class="pill danger">${data.blocked_containers.length} 个容器受阻</span>`
      );
    }
  }
  if (STATE.lastRefresh) {
    chips.push(
      `<span class="pill">刷新 ${STATE.lastRefresh.toLocaleTimeString("zh-CN")}</span>`
    );
  }
  host.innerHTML = chips.join("");
}

function capacityBar(node) {
  const capacity = node.cpu_capacity || 1;
  const serving = Math.min(100, (node.serving_cpu / capacity) * 100);
  const reserved = Math.min(100 - serving, (node.reserved_cpu / capacity) * 100);
  return `
    <div class="bar" role="img" aria-label="已用 ${node.used_cpu} / ${node.cpu_capacity} CPU">
      <span class="serving" style="width:${serving}%"></span>
      <span class="reserved" style="width:${reserved}%"></span>
    </div>`;
}

function renderNodes(data) {
  const host = $("node-list");
  $("node-count").textContent = `${data.nodes.length} / 4`;
  if (!data.nodes.length) {
    host.innerHTML = "";
    $("node-empty").classList.remove("hidden");
    return;
  }
  $("node-empty").classList.add("hidden");
  host.innerHTML = data.nodes
    .map((node) => {
      const selected = STATE.selectedNode === node.id ? "selected" : "";
      const drain = node.drain;
      const canDrain = node.can_drain && !STATE.busy;
      const canResume = node.can_resume && !STATE.busy;
      const canRestore = node.can_restore && !STATE.busy;
      const inbound = node.inbound_reservations.length;
      const statusChip = node.is_empty
        ? `<span class="badge drained">已空</span>`
        : statusBadge(node.status);
      return `
        <article class="node-card ${escapeHtml(node.status)} ${selected}" data-node="${escapeHtml(node.id)}">
          <div class="node-head">
            <div class="node-title">
              <strong>${escapeHtml(node.name)}</strong>
              <small>${escapeHtml(node.id)} · ${node.serving_containers} 个副本${inbound ? ` · ${inbound} 个入库预留` : ""}${node.running_requests ? ` · ${node.running_requests} 笔在途请求` : ""}</small>
            </div>
            <div class="node-actions">
              ${statusChip}
              <button class="btn small" data-action="drain" data-node-id="${escapeHtml(node.id)}"
                ${canDrain ? "" : "disabled"} title="预留容量并开始迁移副本">排空</button>
              <button class="btn small ghost" data-action="resume" data-node-id="${escapeHtml(node.id)}"
                ${canResume ? "" : "disabled"} title="重试受阻容器">继续</button>
              <button class="btn small ghost" data-action="restore" data-node-id="${escapeHtml(node.id)}"
                ${canRestore ? "" : "disabled"} title="把已排空节点恢复为可用，便于再次演练">恢复</button>
            </div>
          </div>
          ${capacityBar(node)}
          <div class="bar-legend">
            <span><i class="dot serving"></i>已用 ${node.used_cpu} / ${node.cpu_capacity}</span>
            <span><i class="dot reserved"></i>预留 ${node.reserved_cpu}</span>
            <span><i class="dot free"></i>剩余 ${node.remaining_cpu}</span>
          </div>
          ${drain ? `<p class="hint" style="margin:8px 0 0">排空 #${drain.id}：${STATUS_LABELS[drain.status] || drain.status} ${drain.moved}/${drain.total}，节点上还剩 ${drain.remaining_on_node} 个副本</p>` : ""}
        </article>`;
    })
    .join("");
}

function renderServices(data) {
  const body = $("service-body");
  if (!data.services.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty-cell">暂无数据</td></tr>`;
    return;
  }
  body.innerHTML = data.services
    .map((service) => {
      const healthy = service.healthy;
      const parked = service.awaiting_cutover_replicas || 0;
      const running = service.running_requests || 0;
      return `
        <tr>
          <td><b>${escapeHtml(service.name)}</b></td>
          <td>${service.ready} / ${service.min_ready}</td>
          <td>${service.starting_replicas || "—"}</td>
          <td>${parked ? `<span class="badge reserved">待切换 ${parked}</span>` : "—"}</td>
          <td>${running ? `<span class="badge starting">在途 ${running}</span>` : "—"}</td>
          <td>${healthy
            ? `<span class="badge ready">满足</span>`
            : `<span class="badge blocked">不足</span>`}</td>
        </tr>`;
    })
    .join("");
}

function findContainer(data, id) {
  return data.containers.find((container) => container.id === id);
}

function migrationCard(data, migration, drain, { allowActions }) {
  const container = findContainer(data, migration.container_id);
  const sourceNode = data.nodes.find((n) => n.id === migration.source_node_id);
  const targetNode = data.nodes.find((n) => n.id === migration.target_node_id);
  const state = migration.state;
  const reason =
    REASON_LABELS[migration.error_code] || migration.error || "";
  const actionBlock =
    state === "starting" && allowActions
      ? `<div class="migration-actions">
           <input type="text" maxlength="200" placeholder="可填写失败原因（可选）"
             data-reason-for="${migration.id}" />
           <button class="btn small ok" data-action="resolve-ready" data-migration="${migration.id}">新副本就绪</button>
           <button class="btn small danger" data-action="resolve-failed" data-migration="${migration.id}">模拟启动失败</button>
         </div>`
      : "";
  const retryBlock =
    (state === "failed" || state === "blocked") && allowActions && drain.status === "incomplete"
      ? `<div class="migration-actions">
           <button class="btn small ghost" data-action="resume" data-node-id="${escapeHtml(drain.node_id)}">重试该节点的受阻副本</button>
         </div>`
      : "";
  const parkedHint =
    state === "awaiting_cutover"
      ? `<p class="hint" style="margin:0">新副本已就绪并继续占用目标 CPU；旧副本仍在处理请求，请求结束后才会停止并完成切换。</p>`
      : "";
  return `
    <div class="migration-card ${escapeHtml(state)}">
      <div class="migration-head">
        <div>
          <b>${escapeHtml(container?.name || migration.container_id)}</b>
          ${statusBadge(state)}
        </div>
        <div class="migration-meta">
          <span>${escapeHtml(container?.service || "")}</span>
          <span>CPU ${migration.reserved_cpu}</span>
        </div>
      </div>
      <div class="kv">
        <span>源：<b>${escapeHtml(sourceNode?.name || migration.source_node_id)}</b></span>
        <span>目标：<b>${escapeHtml(targetNode?.name || (migration.target_node_id || "无可行落点"))}</b></span>
        ${reason ? `<span>原因：<b>${escapeHtml(reason)}</b></span>` : ""}
      </div>
      ${parkedHint}
      ${actionBlock}
      ${retryBlock}
    </div>`;
}

function renderDrains(data) {
  const host = $("drain-body");
  const drains = data.open_drains;
  const hint = $("drain-hint");

  if (!drains.length) {
    const completed = data.drains.find((d) => d.status === "completed");
    hint.textContent = "选择左侧节点发起排空";
    host.innerHTML = completed
      ? `<p class="empty">当前没有进行中的排空。最近完成：节点 <b>${escapeHtml(
          completed.node_name
        )}</b>（#${completed.id}，迁移 ${completed.moved} 个副本，结束于 ${escapeHtml(
          completed.finished_at || ""
        )}）。</p>`
      : `<p class="empty">尚未发起排空。选择节点后点击“排空”，系统会先预留目标容量，再推进新副本就绪。</p>`;
    return;
  }

  hint.textContent = `${drains.length} 个排空任务`;
  host.innerHTML = drains
    .map((drain) => {
      const pct = Math.max(0, Math.min(100, drain.progress_percent));
      const pending = drain.pending_decisions;
      const parked = drain.awaiting_cutover_migrations || [];
      const attempts = drain.attempts || [];
      const handledIds = new Set([
        ...pending.map((m) => m.id),
        ...parked.map((m) => m.id),
      ]);
      const recent = attempts
        .filter((m) => !handledIds.has(m.id))
        .slice(-6)
        .reverse();
      return `
        <div class="drain-block" data-drain="${drain.id}">
          <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
            <div><b>排空 #${drain.id} · ${escapeHtml(drain.node_name)}</b> ${statusBadge(drain.status)}</div>
            <div class="hint">开始于 ${escapeHtml(drain.created_at)}</div>
          </div>
          <div class="drain-grid">
            <div class="stat"><div class="label">已迁移</div><div class="value">${drain.moved}<small> / ${drain.total}</small></div></div>
            <div class="stat"><div class="label">节点上剩余副本</div><div class="value">${drain.remaining_on_node}</div></div>
            <div class="stat"><div class="label">启动中新副本</div><div class="value">${drain.starting}</div></div>
            <div class="stat"><div class="label">待切换（请求在途）</div><div class="value">${drain.awaiting_cutover || 0}</div></div>
            <div class="stat"><div class="label">受阻 / 失败</div><div class="value">${drain.blocked + drain.failed}</div></div>
          </div>
          <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
            <div style="width:${pct}%"></div>
          </div>
          <p class="hint" style="margin:6px 0 0">${pct}% · 未就绪的新副本不计入就绪数；待切换期间旧副本继续服务，排空进度不提前变化</p>
          ${
            pending.length
              ? `<div class="migration-list">${pending
                  .map((m) => migrationCard(data, m, drain, { allowActions: true }))
                  .join("")}</div>`
              : `<p class="empty">没有等待决策的新副本。</p>`
          }
          ${
            parked.length
              ? `<div class="migration-list parked-list">
                   <p class="hint" style="margin:0">待切换：新副本已就绪并预留目标 CPU，等旧副本的在途请求结束后自动切换（每笔只切换一次）。</p>
                   ${parked
                     .map((m) => migrationCard(data, m, drain, { allowActions: false }))
                     .join("")}
                 </div>`
              : ""
          }
          ${
            drain.status === "incomplete"
              ? `<div class="row gap"><button class="btn small ghost" data-action="resume" data-node-id="${escapeHtml(
                  drain.node_id
                )}">继续排空（重试受阻容器）</button></div>`
              : ""
          }
          ${
            recent.length
              ? `<details class="schema-help"><summary>最近尝试记录（${recent.length}）</summary>
                   <div class="migration-list">${recent
                     .map((m) => migrationCard(data, m, drain, { allowActions: false }))
                     .join("")}</div>
                 </details>`
              : ""
          }
        </div>`;
    })
    .join("");
}

function requestReasonLabel(note) {
  if (!note) return "";
  const code = note.split(":")[0];
  return REASON_LABELS[code] || note;
}

function renderRequests(data) {
  const select = $("request-service");
  const hint = $("request-hint");
  const body = $("request-body");

  // Preserve the current selection across re-renders.
  const previous = select.value;
  const serviceNames = data.services.map((s) => s.name);
  select.innerHTML = serviceNames.length
    ? serviceNames
        .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
        .join("")
    : `<option value="">（无业务）</option>`;
  if (previous && serviceNames.includes(previous)) select.value = previous;
  select.disabled = !serviceNames.length || STATE.busy;
  $("request-submit").disabled = !serviceNames.length || STATE.busy;

  const requests = data.requests || [];
  const running = requests.filter((r) => r.status === "running");
  hint.textContent = data.running_request_count
    ? `${data.running_request_count} 笔在途，旧副本不会在请求结束前停止`
    : "选择业务后发起，系统挑一个可接单的在服副本承接";

  if (!requests.length) {
    body.innerHTML = `<p class="empty">尚未发起模拟请求。</p>`;
    return;
  }

  body.innerHTML = `
    <div class="request-list">
      ${requests
        .map((req) => {
          const node = data.nodes.find((n) => n.id === req.node_id);
          const container = data.containers.find((c) => c.id === req.container_id);
          if (req.status === "rejected") {
            return `
              <div class="request-card rejected">
                <div class="request-head">
                  <div><b>请求 #${req.id} · ${escapeHtml(req.service)}</b> ${statusBadge("rejected")}</div>
                  <span class="hint">${escapeHtml(req.created_at)}</span>
                </div>
                <div class="kv"><span>拒绝原因：<b>${escapeHtml(requestReasonLabel(req.note))}</b></span></div>
              </div>`;
          }
          const parked = container?.migration?.state === "awaiting_cutover";
          const completeAction = req.status === "running"
            ? `<div class="migration-actions">
                 <input type="text" maxlength="200" placeholder="可填写完成结果（可选）" data-request-result-for="${req.id}" />
                 <button class="btn small ok" data-action="complete-request" data-request="${req.id}">
                   ${parked ? "结束请求并完成切换" : "结束请求"}
                 </button>
               </div>`
            : "";
          return `
            <div class="request-card ${escapeHtml(req.status)}">
              <div class="request-head">
                <div>
                  <b>请求 #${req.id} · ${escapeHtml(req.service)}</b>
                  ${statusBadge(req.status)}
                  ${parked ? `<span class="badge reserved">待切换</span>` : ""}
                </div>
                <span class="hint">${escapeHtml(req.created_at)}</span>
              </div>
              <div class="kv">
                <span>承接副本：<b>${escapeHtml(container?.name || req.container_id || "—")}</b></span>
                <span>节点：<b>${escapeHtml(node?.name || req.node_id || "—")}</b></span>
                ${parked ? `<span>新副本已就绪，保留目标 CPU，等请求结束后切换</span>` : ""}
                ${req.cutover_migration_id ? `<span>触发切换 #${req.cutover_migration_id}</span>` : ""}
                ${req.result ? `<span>结果：<b>${escapeHtml(req.result)}</b></span>` : ""}
              </div>
              ${completeAction}
            </div>`;
        })
        .join("")}
    </div>`;

  document.querySelectorAll("[data-request-result-for]").forEach((input) => {
    const draft = STATE.requestResultDrafts?.[input.dataset.requestResultFor];
    if (draft && !input.value) input.value = draft;
  });
}

function renderBlocked(data) {
  const host = $("blocked-body");
  if (!data.blocked_containers.length) {
    host.innerHTML = `<p class="empty">没有受阻容器。</p>`;
    return;
  }
  host.innerHTML = data.blocked_containers
    .map((item) => `
      <div class="blocked-item">
        <div class="blocked-head">
          <div><b>${escapeHtml(item.name)}</b> <span class="hint">(${escapeHtml(item.container_id)})</span></div>
          <span class="badge blocked">${escapeHtml(item.reason_code)}</span>
        </div>
        <div class="migration-meta">
          <span>业务 ${escapeHtml(item.service)}</span>
          <span>CPU ${item.cpu_request}</span>
          <span>仍在节点 ${escapeHtml(item.node_id)} 服务</span>
          <span>排空 #${item.drain_id}</span>
        </div>
        <div class="blocked-reason">${escapeHtml(item.reason)}</div>
        ${
          item.retryable
            ? `<div class="migration-actions"><button class="btn small ghost" data-action="resume" data-node-id="${escapeHtml(
                item.node_id
              )}">重试</button></div>`
            : ""
        }
      </div>`)
    .join("");
}

function renderContainers(data) {
  const body = $("container-body");
  $("container-count").textContent = `${data.containers.length} / 8`;
  if (!data.containers.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty-cell">暂无数据</td></tr>`;
    return;
  }
  body.innerHTML = data.containers
    .map((container) => {
      const node = data.nodes.find((n) => n.id === container.node_id);
      let migrationCell = "—";
      if (container.migration) {
        const target = data.nodes.find((n) => n.id === container.migration.target_node_id);
        const targetName = target?.name || container.migration.target_node_id || "?";
        migrationCell =
          container.migration.state === "awaiting_cutover"
            ? `<span class="badge reserved" title="新副本已就绪，等在途请求结束后切换">待切换 → ${escapeHtml(targetName)}</span>`
            : `<span class="badge starting">启动中 → ${escapeHtml(targetName)}</span>`;
      } else if (container.blocked_attempt) {
        const reason =
          REASON_LABELS[container.blocked_attempt.error_code] ||
          container.blocked_attempt.error_code;
        migrationCell = `<span class="badge blocked" title="${escapeHtml(
          container.blocked_attempt.error || ""
        )}">${escapeHtml(reason)}</span>`;
      }
      const requestCell = container.active_request
        ? `<span class="badge starting" title="请求 #${container.active_request.id} 处理中">处理中 #${container.active_request.id}</span>`
        : container.accepting_requests
          ? `<span class="badge ready">可接单</span>`
          : `<span class="hint">不接单</span>`;
      return `
        <tr>
          <td><b>${escapeHtml(container.name)}</b><br><span class="hint">${escapeHtml(container.id)}</span></td>
          <td>${escapeHtml(container.service)}</td>
          <td>${container.cpu_request}</td>
          <td>${escapeHtml(node?.name || container.node_id)}</td>
          <td>${statusBadge(container.status)}</td>
          <td>${requestCell}</td>
          <td>${migrationCell}</td>
        </tr>`;
    })
    .join("");
}

function renderHistory(data) {
  const body = $("history-body");
  const drains = data.drains || [];
  $("history-count").textContent = drains.length ? `最近 ${drains.length} 条` : "";
  if (!drains.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty-cell">暂无记录</td></tr>`;
    return;
  }
  body.innerHTML = drains
    .map((drain) => `
      <tr>
        <td>#${drain.id}</td>
        <td>${escapeHtml(drain.node_name)}</td>
        <td>${statusBadge(drain.status)}</td>
        <td>${drain.moved}/${drain.total} · ${drain.progress_percent}%</td>
        <td>${drain.starting}</td>
        <td class="hint">${escapeHtml(drain.created_at)}</td>
        <td class="hint">${escapeHtml(drain.finished_at || "—")}</td>
      </tr>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function parseJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("JSON 顶层必须是对象");
  }
  return parsed;
}

async function importTopology(raw, { confirmReplace = true } = {}) {
  if (STATE.busy) return;
  let payload;
  try {
    payload = parseJson(raw);
  } catch (error) {
    showImportError(`JSON 解析失败：${error.message}`);
    return;
  }
  const state = STATE.data;
  if (
    confirmReplace &&
    state &&
    state.topology_loaded &&
    (state.open_drains.length || state.drains.length)
  ) {
    const ok = window.confirm(
      "导入会清空现有演练进度与历史，确定继续吗？"
    );
    if (!ok) return;
  }
  setBusy(true);
  document.body.classList.add("busy");
  hideImportError();
  try {
    const data = await api("/api/topology", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    STATE.selectedNode = null;
    applyState(data);
    toast("拓扑已导入，演练状态已重置", "ok");
  } catch (error) {
    showImportError(error.message);
  } finally {
    STATE.busy = false;
    document.body.classList.remove("busy");
    if (STATE.data) render();
  }
}

function showImportError(message) {
  const el = $("import-error");
  el.textContent = message;
  el.classList.remove("hidden", "ok");
}

function hideImportError() {
  const el = $("import-error");
  el.classList.add("hidden");
  el.textContent = "";
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function wireTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll("[data-tab-body]").forEach((body) => {
        body.classList.toggle("hidden", body.dataset.tabBody !== tab.dataset.tab);
      });
    });
  });
}

function wireFileInput() {
  const input = $("json-file");
  const drop = $("file-drop");
  const name = $("file-name");

  const read = (file) => {
    if (!file) return;
    name.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
    const reader = new FileReader();
    reader.onload = () => {
      $("json-input").value = String(reader.result || "");
      const tab = document.querySelector('.tab[data-tab="paste"]');
      if (tab) tab.click();
      importTopology(String(reader.result || ""));
    };
    reader.onerror = () => showImportError("读取文件失败");
    reader.readAsText(file);
  };

  input.addEventListener("change", () => read(input.files?.[0]));
  ["dragenter", "dragover"].forEach((evt) =>
    drop.addEventListener(evt, (event) => {
      event.preventDefault();
      drop.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    drop.addEventListener(evt, (event) => {
      event.preventDefault();
      drop.classList.remove("dragover");
    })
  );
  drop.addEventListener("drop", (event) => read(event.dataTransfer?.files?.[0]));
}

function wireActions() {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;

    if (action === "drain") {
      const nodeId = button.dataset.nodeId;
      STATE.selectedNode = nodeId;
      render();
      const data = await mutate(`/api/nodes/${encodeURIComponent(nodeId)}/drain`);
      if (data) {
        const node = data.nodes.find((n) => n.id === nodeId);
        const drain = node?.drain;
        if (drain && drain.starting) {
          toast(`排空已开始：已预留容量，等待 ${drain.starting} 个新副本就绪`, "ok");
        } else if (drain && drain.remaining_on_node === 0) {
          toast(`节点已排空，已无服务副本`, "ok");
        } else {
          toast(`排空已开始，但有 ${drain?.blocked + drain?.failed || 0} 个容器受阻，旧副本继续服务`, "ok");
        }
      }
      return;
    }

    if (action === "resume") {
      const nodeId = button.dataset.nodeId;
      STATE.selectedNode = nodeId;
      const data = await mutate(`/api/nodes/${encodeURIComponent(nodeId)}/resume`);
      if (data) toast("已重试受阻容器", "ok");
      return;
    }

    if (action === "restore") {
      const nodeId = button.dataset.nodeId;
      const data = await mutate(`/api/nodes/${encodeURIComponent(nodeId)}/restore`);
      if (data) toast("节点已恢复可用", "ok");
      return;
    }

    if (action === "resolve-ready" || action === "resolve-failed") {
      const id = button.dataset.migration;
      const reasonInput = document.querySelector(`[data-reason-for="${id}"]`);
      const reason = (reasonInput?.value || STATE.reasonDrafts[id] || "").trim() || null;
      const outcome = action === "resolve-ready" ? "ready" : "failed";
      const data = await mutate(`/api/migrations/${id}/resolve`, {
        outcome,
        reason,
      });
      if (data) {
        if (outcome === "ready") {
          const attempt = data.open_drains
            .flatMap((d) => d.attempts || [])
            .find((m) => String(m.id) === String(id));
          toast(
            attempt?.state === "awaiting_cutover"
              ? "新副本已就绪：旧副本仍在处理请求，进入待切换"
              : "新副本已就绪，旧副本已停止",
            "ok"
          );
        } else {
          toast("已模拟启动失败，预留已释放，旧副本继续服务", "ok");
        }
      }
      return;
    }

    if (action === "complete-request") {
      const id = button.dataset.request;
      const resultInput = document.querySelector(`[data-request-result-for="${id}"]`);
      const result = (resultInput?.value || "").trim() || null;
      const before = STATE.data;
      const request = before.requests.find((r) => String(r.id) === String(id));
      const container = before.containers.find((c) => c.id === request?.container_id);
      const willCutOver = container?.migration?.state === "awaiting_cutover";
      const data = await mutate(`/api/requests/${id}/complete`, { result });
      if (data) {
        toast(
          willCutOver
            ? "请求已结束，旧副本停止并完成切换（仅切换一次）"
            : "请求已结束",
          "ok"
        );
      }
      return;
    }
  });
}

function wireRequests() {
  $("request-submit").addEventListener("click", async () => {
    const service = $("request-service").value;
    if (!service) {
      toast("请先导入包含业务的拓扑", "error");
      return;
    }
    const data = await mutate("/api/requests", { service });
    if (!data) return;
    const latest = data.requests[0];
    if (latest && latest.status === "rejected") {
      toast(`请求被明确拒绝：${requestReasonLabel(latest.note)}`, "error");
    } else if (latest) {
      const node = data.nodes.find((n) => n.id === latest.node_id);
      const container = data.containers.find((c) => c.id === latest.container_id);
      toast(
        `请求 #${latest.id} 已由副本 ${container?.name || latest.container_id}（${node?.name || latest.node_id}）承接`,
        "ok"
      );
    }
  });
}

function wireImport() {
  $("import-btn").addEventListener("click", () => {
    const raw = $("json-input").value.trim();
    if (!raw) {
      showImportError("请粘贴或选择 JSON 文件");
      return;
    }
    importTopology(raw);
  });
  $("sample-btn").addEventListener("click", async () => {
    let sample = SAMPLE;
    try {
      // Prefer the server's copy so the demo matches examples/cluster.json.
      sample = await api("/api/topology/example");
    } catch {
      /* fall back to the built-in sample */
    }
    $("json-input").value = JSON.stringify(sample, null, 2);
    document.querySelector('.tab[data-tab="paste"]')?.click();
  });
}

async function init() {
  wireTabs();
  wireFileInput();
  wireActions();
  wireImport();
  wireRequests();
  await refresh({ silent: false });
  // Pause auto-refresh briefly after any interaction so re-rendering cannot
  // swallow a click that is already in flight.
  document.addEventListener(
    "pointerdown",
    () => {
      STATE.pausedUntil = Date.now() + 5000;
    },
    { capture: true }
  );
  setInterval(() => {
    if (STATE.busy) return;
    if (Date.now() < STATE.pausedUntil) return;
    // Never re-render under a focused input (it would steal the caret).
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      return;
    }
    refresh();
  }, 4000);
}

document.addEventListener("DOMContentLoaded", init);
