(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SHEET = matchMedia("(max-width: 1180px)");

  const ROLES = {
    queen: {
      name: "Queen", desc: "PRIMARY COORDINATOR", cn: "规划、分派与最终验收",
      tier: "STRONG", thinking: "HIGH", tools: ["read", "time"],
    },
    scout: {
      name: "Scout", desc: "READ-ONLY INVESTIGATOR", cn: "只读探索与上下文交接",
      tier: "FAST", thinking: "LOW", tools: ["read", "grep", "glob"],
    },
    worker: {
      name: "Worker", desc: "BOUNDED IMPLEMENTER", cn: "最小改动与验证",
      tier: "FAST", thinking: "MEDIUM", tools: ["read", "write_file", "edit_file", "bash"],
    },
    reviewer: {
      name: "Reviewer", desc: "INDEPENDENT REVIEWER", cn: "独立复核与回归检查",
      tier: "STRONG", thinking: "HIGH", tools: ["read", "bash", "util"],
    },
    guard: {
      name: "Guard", desc: "SAFETY REVIEWER", cn: "权限、敏感数据与回滚",
      tier: "STRONG", thinking: "MEDIUM", tools: ["read", "bash", "util"],
    },
    merger: {
      name: "Merger", desc: "RESULT SYNTHESIZER", cn: "合并交接并解决冲突",
      tier: "FAST", thinking: "LOW", tools: ["read", "glob"],
    },
  };

  const ROLE_ORDER = ["queen", "scout", "worker", "reviewer", "guard", "merger"];
  const ROLE_CODE = { queen: "Q", scout: "SC", worker: "WK", reviewer: "RV", guard: "GD", merger: "MG" };
  const STAGE_LABEL = { scout: "EXPLORE", worker: "IMPLEMENT", reviewer: "REVIEW", guard: "GUARD", merger: "MERGE" };
  const STAGE_DURATION = { plan: 1500, scout: 2000, worker: 2600, reviewer: 1800, guard: 1600, merger: 1800 };

  const PATTERNS = {
    "fan-out-fan-in": {
      label: "扇出 / 扇入", en: "FAN-OUT-FAN-IN",
      stages: [
        { role: "scout", count: 1, desc: "分析代码库并规划工作分区" },
        { role: "worker", count: 3, desc: "在并行分区中执行实现" },
        { role: "merger", count: 1, desc: "合并并行结果并解决冲突" },
      ],
    },
    pipeline: {
      label: "流水线", en: "PIPELINE",
      stages: [
        { role: "scout", count: 1, desc: "探索代码库并收集上下文" },
        { role: "worker", count: 1, desc: "根据 Scout 的发现实现更改" },
        { role: "reviewer", count: 1, desc: "审查 Worker 更改的正确性和质量" },
        { role: "guard", count: 1, desc: "安全性与权限验证" },
      ],
    },
    ensemble: {
      label: "集成", en: "ENSEMBLE",
      stages: [
        { role: "worker", count: 3, desc: "每个 Worker 独立生成一个解决方案" },
        { role: "reviewer", count: 1, desc: "审查所有解决方案并推荐最佳方案" },
      ],
    },
    debate: {
      label: "辩论", en: "DEBATE",
      stages: [
        { role: "scout", count: 1, desc: "收集决策的事实和上下文" },
        { role: "worker", count: 2, desc: "分别提出方案 A 和方案 B" },
        { role: "reviewer", count: 1, desc: "分析权衡并给出建议" },
      ],
    },
    exploratory: {
      label: "探索", en: "EXPLORATORY",
      stages: [
        { role: "scout", count: 3, desc: "每个 Scout 并行探索一个不同区域" },
        { role: "merger", count: 1, desc: "将发现综合为连贯的理解" },
      ],
    },
  };

  const PATTERN_ORDER = ["fan-out-fan-in", "pipeline", "ensemble", "debate", "exploratory"];
  const KIND_LABEL = { plan: "PLAN", tool: "TOOL", handoff: "HANDOFF", check: "CHECK" };
  const PHASE_TEXT = {
    idle: "READY", running: "LIVE", paused: "HOLD",
    awaiting: "REVIEW", accepted: "ACCEPTED", rejected: "REJECTED",
  };
  const RUN_LABEL = {
    idle: "RUN", running: "HOLD", paused: "RESUME",
    awaiting: "WAIT", accepted: "REPLAY", rejected: "REPLAY",
  };
  const NODE_TEXT = { idle: "IDLE", queued: "QUEUED", ready: "READY", active: "LIVE", done: "DONE", blocked: "BLOCKED" };
  const CHECKS = [
    "交接与路径核对",
    "类型检查与回归",
    "独立复核与安全边界",
    "审计日志与回滚",
  ];

  const $ = (id) => document.getElementById(id);
  const dom = {
    statusDot: $("statusDot"),
    statusText: $("statusText"),
    order: document.querySelector(".order"),
    elapsed: $("elapsed"),
    orderState: $("orderState"),
    yardPattern: $("yardPattern"),
    patternSelect: $("patternSelect"),
    runBtn: $("runBtn"),
    runBtnText: $("runBtnText"),
    speedBtn: $("speedBtn"),
    resetBtn: $("resetBtn"),
    yardInner: $("yardInner"),
    edges: $("edges"),
    yardGrid: $("yardGrid"),
    roleRail: $("roleRail"),
    patternList: $("patternList"),
    log: $("log"),
    ledgerCount: $("ledgerCount"),
    inspector: $("inspector"),
    inspectorScroll: document.querySelector(".inspector-scroll"),
    roleHead: document.querySelector(".role-head"),
    inspectorIndex: $("inspectorIndex"),
    inspectorName: $("inspectorName"),
    inspectorDesc: $("inspectorDesc"),
    inspectorCn: $("inspectorCn"),
    inspectorState: $("inspectorState"),
    inspectorNow: $("inspectorNow"),
    inspTier: $("inspTier"),
    inspThinking: $("inspThinking"),
    inspTools: $("inspTools"),
    inspNodes: $("inspNodes"),
    inspToolList: $("inspToolList"),
    ctxValue: $("ctxValue"),
    ctxFill: $("ctxFill"),
    ctxTokens: $("ctxTokens"),
    ctxCache: $("ctxCache"),
    acceptValue: $("acceptValue"),
    checks: $("checks"),
    approval: $("approval"),
    acceptBtn: $("acceptBtn"),
    rejectBtn: $("rejectBtn"),
    cmd: $("cmd"),
    composerForm: $("composerForm"),
    commandMenu: $("commandMenu"),
    sheetBackdrop: $("sheetBackdrop"),
    sheetClose: $("sheetClose"),
    filters: [...document.querySelectorAll(".filters button")],
    quick: [...document.querySelectorAll(".quick [data-command]")],
    themeButtons: [...document.querySelectorAll("[data-theme-set]")],
  };

  const state = {
    patternKey: "fan-out-fan-in",
    plan: null,
    phase: "idle",
    speed: 1,
    elapsedMs: 0,
    lastClock: "",
    stageIndex: -1,
    stageStartedAt: 0,
    stageDuration: 0,
    stageRemaining: 0,
    selectedRole: "queen",
    filter: "all",
    context: 48,
    cacheRead: 12400,
    tokensIn: 12400,
    tokensOut: 2600,
    eventTotal: 0,
    autoTimer: 0,
    replyTimer: 0,
    generation: 0,
    menuItems: [],
    menuIndex: 0,
    menuButtons: [],
  };

  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtClock = (ms) => `${pad2(Math.floor(ms / 60000))}:${pad2(Math.floor(ms / 1000) % 60)}`;
  const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(Math.round(n)));
  const nodeById = (id) => state.plan.byId.get(id);

  // 方案：Queen 先规划，随后按模式展开，最后由 Queen 验收。
  function buildPlan(patternKey) {
    const pattern = PATTERNS[patternKey];
    const nodes = [];
    const stages = [];

    const planNode = {
      id: "queen-plan", role: "queen", kind: "plan", index: 0,
      label: "Queen", sub: "Q·PLAN", tag: "QUEEN", state: "ready",
      desc: "读取 AGENTS.md、仓库与会话状态，建立执行 DAG。",
    };
    nodes.push(planNode);
    stages.push({
      kind: "plan", label: "PLAN", ids: [planNode.id], desc: planNode.desc,
      duration: STAGE_DURATION.plan,
    });

    pattern.stages.forEach((stage) => {
      const ids = [];
      for (let i = 0; i < stage.count; i += 1) {
        const letter = stage.count > 1 ? ` ${String.fromCharCode(65 + i)}` : "";
        const node = {
          id: `${stage.role}-${i + 1}`,
          role: stage.role,
          kind: "pattern",
          index: i,
          label: `${ROLES[stage.role].name}${letter}`,
          sub: `${ROLE_CODE[stage.role]}·${pad2(i + 1)}`,
          tag: `${ROLES[stage.role].name}${letter}`.toUpperCase(),
          state: "queued",
          desc: stage.desc,
        };
        nodes.push(node);
        ids.push(node.id);
      }
      stages.push({
        kind: "pattern",
        label: STAGE_LABEL[stage.role],
        ids,
        desc: stage.desc,
        duration: STAGE_DURATION[stage.role] + (stage.count - 1) * 220,
      });
    });

    const acceptNode = {
      id: "queen-accept", role: "queen", kind: "accept", index: 0,
      label: "Queen", sub: "Q·FINAL", tag: "QUEEN", state: "queued",
      desc: "核对交接证据与验收项，做出最终确认。",
    };
    nodes.push(acceptNode);
    stages.push({ kind: "accept", label: "ACCEPT", ids: [acceptNode.id], desc: acceptNode.desc, duration: 0 });

    const edges = [];
    for (let i = 1; i < stages.length; i += 1) {
      stages[i - 1].ids.forEach((from) => {
        stages[i].ids.forEach((to) => edges.push({ from, to }));
      });
    }

    return { nodes, stages, edges, byId: new Map(nodes.map((node) => [node.id, node])) };
  }

  // ── 角色与模式 ─────────────────────────────────────────────

  function buildRoleRail() {
    ROLE_ORDER.forEach((roleKey, index) => {
      const role = ROLES[roleKey];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "role";
      button.dataset.role = roleKey;
      button.setAttribute("aria-pressed", "false");
      button.innerHTML = `
        <span class="role-index mono">${pad2(index + 1)}</span>
        <span class="hex-mark" aria-hidden="true"><i class="hex-lamp"></i></span>
        <span class="role-name">${role.name}</span>
        <span class="role-state mono">READY</span>`;
      button.addEventListener("click", () => selectRole(roleKey, true));
      dom.roleRail.append(button);
    });
  }

  function buildPatternList() {
    PATTERN_ORDER.forEach((key, index) => {
      const pattern = PATTERNS[key];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pattern";
      button.dataset.pattern = key;
      button.setAttribute("aria-pressed", "false");
      button.innerHTML = `
        <span class="pattern-index mono">${pad2(index + 1)}</span>
        <span class="pattern-copy">
          <span class="pattern-label">${pattern.label}</span>
          <span class="pattern-en">${pattern.en}</span>
        </span>
        <span class="pattern-dot" aria-hidden="true"></span>`;
      button.addEventListener("click", () => setPattern(key));
      dom.patternList.append(button);

      const option = document.createElement("option");
      option.value = key;
      option.textContent = `${pattern.label} · ${pattern.en}`;
      dom.patternSelect.append(option);
    });

    dom.patternSelect.addEventListener("change", () => setPattern(dom.patternSelect.value));
  }

  function buildChecks() {
    CHECKS.forEach((label, index) => {
      const item = document.createElement("li");
      item.dataset.check = String(index);
      item.innerHTML = `
        <span class="check-box" aria-hidden="true">✓</span>
        <span class="check-label">${label}</span>
        <span class="check-state mono">WAIT</span>`;
      dom.checks.append(item);
    });
  }

  function selectRole(roleKey, fromUser = false) {
    if (!ROLES[roleKey]) return;
    state.selectedRole = roleKey;
    syncRoleStates();
    syncYardStates();
    syncInspector();
    dom.inspectorScroll.scrollTop = 0;
    if (fromUser) openInspectorSheet();
  }

  function setPattern(key) {
    if (!PATTERNS[key] || key === state.patternKey) return;
    const wasActive = state.phase === "running" || state.phase === "awaiting" || state.phase === "paused";
    state.patternKey = key;
    resetRun();
    addEvent({
      tag: "QUEEN", role: "queen", kind: "plan",
      text: `重新编排 · ${PATTERNS[key].en}${wasActive ? " · 旧运行已停止" : ""}`,
    });
  }

  function syncPatternUI() {
    dom.patternList.querySelectorAll(".pattern").forEach((button) => {
      const on = button.dataset.pattern === state.patternKey;
      button.classList.toggle("is-selected", on);
      button.setAttribute("aria-pressed", String(on));
    });
    dom.patternSelect.value = state.patternKey;
    dom.yardPattern.textContent = PATTERNS[state.patternKey].en;
  }

  // ── 渲染 / 同步 ────────────────────────────────────────────

  let renderedInspectorRole = "";

  function roleAggregate(roleKey) {
    const nodes = state.plan ? state.plan.nodes.filter((node) => node.role === roleKey) : [];
    const total = nodes.length;
    if (total === 0) {
      return { nodes, total: 0, done: 0, active: false, ready: false, stateName: "idle" };
    }
    const done = nodes.filter((node) => node.state === "done").length;
    const active = nodes.some((node) => node.state === "active");
    const ready = nodes.some((node) => node.state === "ready");
    const blocked = nodes.some((node) => node.state === "blocked");
    const stateName = blocked ? "blocked"
      : active ? "active"
        : ready ? "ready"
          : done === total ? "done"
            : done > 0 ? "partial" : "queued";
    return { nodes, total, done, active, ready, stateName };
  }

  function aggregateText(agg) {
    if (agg.stateName === "partial") return `${agg.done}/${agg.total}`;
    return NODE_TEXT[agg.stateName] ?? "QUEUED";
  }

  function syncRoleStates() {
    dom.roleRail.querySelectorAll(".role").forEach((button) => {
      const roleKey = button.dataset.role;
      const agg = roleAggregate(roleKey);
      button.dataset.state = agg.stateName;
      button.classList.toggle("is-selected", roleKey === state.selectedRole);
      button.setAttribute("aria-pressed", String(roleKey === state.selectedRole));
      button.querySelector(".role-state").textContent = aggregateText(agg);
    });
  }

  function syncYardStates() {
    if (!state.plan) return;
    state.plan.nodes.forEach((node) => {
      const element = dom.yardGrid.querySelector(`[data-node-id="${node.id}"]`);
      if (!element) return;
      element.dataset.state = node.state;
      element.classList.toggle("is-selected", node.role === state.selectedRole);
      element.setAttribute("aria-label", `${node.tag} · ${NODE_TEXT[node.state]}`);
    });

    const columns = dom.yardGrid.querySelectorAll(".stage");
    state.plan.stages.forEach((stage, index) => {
      const column = columns[index];
      if (!column) return;
      const nodes = stage.ids.map((id) => nodeById(id));
      const active = nodes.some((node) => node.state === "active");
      const done = nodes.every((node) => node.state === "done");
      const ready = nodes.some((node) => node.state === "ready");
      column.dataset.state = active ? "active" : done ? "done" : ready ? "ready" : "queued";
    });
  }

  function syncInspector() {
    if (!state.plan) return;
    const roleKey = state.selectedRole;
    const role = ROLES[roleKey];
    const agg = roleAggregate(roleKey);
    const activeNode = agg.nodes.find((node) => node.state === "active");

    dom.inspectorIndex.textContent = `${pad2(ROLE_ORDER.indexOf(roleKey) + 1)} / 06`;
    dom.inspectorName.textContent = role.name;
    dom.inspectorDesc.textContent = role.desc;
    dom.inspectorCn.textContent = role.cn;
    dom.roleHead.dataset.state = agg.stateName;
    dom.inspectorState.textContent = aggregateText(agg);

    let nowText;
    if (agg.stateName === "blocked") {
      nowText = "运行被拒绝，等待重新编排。";
    } else if (activeNode) {
      nowText = state.phase === "paused" ? `已挂起 · ${activeNode.desc}` : activeNode.desc;
    } else if (agg.stateName === "ready") {
      nowText = roleKey === "queen" ? "待命，等待运行开始。" : "待命，等待 Queen 分派。";
    } else if (agg.stateName === "done") {
      nowText = state.phase === "accepted"
        ? (roleKey === "queen" ? "验收完成，运行已关闭。" : "交接已提交，运行已关闭。")
        : state.phase === "rejected"
          ? "交接已提交，运行已终止。"
          : "交接已提交，等待下游。";
    } else if (roleKey === "queen" && agg.done > 0) {
      nowText = "等待下游交接，保留最终验收。";
    } else if (agg.done > 0) {
      nowText = "部分交接已提交，等待其余节点。";
    } else if (agg.stateName === "idle") {
      nowText = "本运行未启用此角色。";
    } else {
      nowText = "已排队，等待依赖完成。";
    }
    dom.inspectorNow.textContent = nowText;
    dom.inspectorNow.closest(".now").classList.toggle(
      "is-live",
      Boolean(activeNode) && state.phase === "running",
    );

    dom.inspTier.textContent = role.tier;
    dom.inspThinking.textContent = role.thinking;
    dom.inspTools.textContent = pad2(role.tools.length);
    dom.inspNodes.textContent = `${pad2(agg.done)} / ${pad2(agg.total)}`;

    if (renderedInspectorRole !== roleKey) {
      renderedInspectorRole = roleKey;
      dom.inspToolList.textContent = "";
      role.tools.forEach((tool) => {
        const item = document.createElement("li");
        item.textContent = tool;
        dom.inspToolList.append(item);
      });
    }
  }

  function syncContext() {
    const pct = Math.max(0, Math.min(100, state.context));
    dom.ctxFill.style.width = `${pct}%`;
    dom.ctxValue.textContent = `${Math.round(pct)}%`;
    const used = (128 * pct) / 100;
    dom.ctxTokens.textContent = `${used.toFixed(1)}k / 128k`;
    dom.ctxCache.textContent = fmtTokens(state.cacheRead);
    dom.ctxFill.parentElement.setAttribute("aria-label", `上下文占用 ${Math.round(pct)}%`);
  }

  function getPatternDone() {
    if (!state.plan) return 0;
    return state.plan.stages
      .filter((stage) => stage.kind === "pattern")
      .filter((stage) => stage.ids.every((id) => nodeById(id).state === "done"))
      .length;
  }

  function getChecksDone() {
    if (!state.plan) return 0;
    if (state.phase === "awaiting" || state.phase === "accepted") return 4;
    return Math.min(3, getPatternDone());
  }

  function syncChecks() {
    const done = getChecksDone();
    dom.checks.querySelectorAll("li").forEach((item, index) => {
      const isDone = index < done;
      item.classList.toggle("is-done", isDone);
      item.querySelector(".check-state").textContent = isDone
        ? "OK"
        : state.phase === "rejected" ? "HOLD" : "WAIT";
    });
    dom.acceptValue.textContent = `${done} / 4`;
  }

  function syncClock() {
    const text = fmtClock(state.elapsedMs);
    if (text === state.lastClock) return;
    state.lastClock = text;
    dom.elapsed.textContent = text;
  }

  function syncStatus() {
    const phase = state.phase;
    dom.statusText.textContent = PHASE_TEXT[phase];
    dom.orderState.textContent = PHASE_TEXT[phase];
    dom.order.dataset.phase = phase;
    dom.statusDot.className = "live-dot";
    if (phase === "paused") dom.statusDot.classList.add("is-paused");
    if (phase === "awaiting") dom.statusDot.classList.add("is-awaiting");
    if (phase === "accepted") dom.statusDot.classList.add("is-accepted");
    if (phase === "rejected") dom.statusDot.classList.add("is-rejected");
    dom.runBtnText.textContent = RUN_LABEL[phase];
    dom.runBtn.disabled = phase === "awaiting";
    dom.runBtn.classList.toggle("is-running", phase === "running");
    dom.approval.hidden = phase !== "awaiting";
  }

  function syncAll() {
    syncRoleStates();
    syncYardStates();
    syncInspector();
    syncEdges();
    syncContext();
    syncChecks();
    syncStatus();
    syncClock();
  }

  function renderYard() {
    dom.yardGrid.textContent = "";
    const stages = state.plan.stages;
    dom.yardGrid.style.setProperty("--cols", stages.length);

    stages.forEach((stage, stageIndex) => {
      const column = document.createElement("div");
      column.className = "stage";

      const label = document.createElement("div");
      label.className = "stage-label";
      label.innerHTML = `<b>${pad2(stageIndex + 1)}</b> · ${stage.label}`;

      const body = document.createElement("div");
      body.className = "stage-body";

      stage.ids.forEach((id) => {
        const node = nodeById(id);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "node";
        button.dataset.nodeId = node.id;
        button.dataset.state = node.state;
        button.innerHTML = `
          <span class="hex-mark" aria-hidden="true"><i class="hex-lamp"></i></span>
          <span class="node-copy">
            <span class="node-role">${node.label}</span>
            <span class="node-id mono">${node.sub}</span>
          </span>`;
        button.addEventListener("click", () => selectRole(node.role, true));
        body.append(button);
      });

      column.append(label, body);
      dom.yardGrid.append(column);
    });

    syncYardStates();
    requestAnimationFrame(() => buildEdges(true));
  }

  let edgeGroups = [];

  function syncEdges() {
    if (!state.plan) return;
    edgeGroups.forEach((group) => {
      const from = nodeById(group.dataset.from);
      const to = nodeById(group.dataset.to);
      group.classList.remove("is-live", "is-done");
      if (!from || !to) return;
      if (to.state === "active") group.classList.add("is-live");
      else if (from.state === "done" && to.state === "done") group.classList.add("is-done");
    });
  }

  function buildEdges(animate) {
    if (!state.plan) return;
    const inner = dom.yardInner.getBoundingClientRect();
    dom.edges.textContent = "";
    dom.edges.setAttribute("viewBox", `0 0 ${Math.max(1, inner.width)} ${Math.max(1, inner.height)}`);
    edgeGroups = [];

    state.plan.edges.forEach((edge, index) => {
      const fromEl = dom.yardGrid.querySelector(`[data-node-id="${edge.from}"]`);
      const toEl = dom.yardGrid.querySelector(`[data-node-id="${edge.to}"]`);
      if (!fromEl || !toEl) return;

      const a = fromEl.getBoundingClientRect();
      const b = toEl.getBoundingClientRect();
      const x1 = a.right - inner.left + 1;
      const y1 = a.top + a.height / 2 - inner.top;
      const x2 = b.left - inner.left - 1;
      const y2 = b.top + b.height / 2 - inner.top;
      const bend = Math.max(14, (x2 - x1) * 0.5);
      const d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;

      const group = document.createElementNS(SVG_NS, "g");
      group.setAttribute("class", "edge-group");
      group.dataset.from = edge.from;
      group.dataset.to = edge.to;

      const base = document.createElementNS(SVG_NS, "path");
      base.setAttribute("class", "edge");
      base.setAttribute("d", d);

      const pulse = document.createElementNS(SVG_NS, "path");
      pulse.setAttribute("class", "edge-pulse");
      pulse.setAttribute("d", d);

      group.append(base, pulse);
      dom.edges.append(group);
      edgeGroups.push(group);

      if (animate && !REDUCED) {
        const length = base.getTotalLength();
        base.style.strokeDasharray = `${length}`;
        base.style.strokeDashoffset = `${length}`;
        const delay = index * 45;
        requestAnimationFrame(() => {
          base.style.transition = `stroke-dashoffset .72s cubic-bezier(.2, .7, .2, 1) ${delay}ms`;
          base.style.strokeDashoffset = "0";
        });
      }
    });

    syncEdges();
  }

  function observeYard() {
    let frame = 0;
    const rebuild = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => buildEdges(false));
    };
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(rebuild).observe(dom.yardInner);
    }
    addEventListener("resize", rebuild);
  }

  // ── ledger ─────────────────────────────────────────────────

  const nearBottom = () => dom.log.scrollHeight - dom.log.scrollTop - dom.log.clientHeight < 72;

  function renderFilter() {
    const rows = [...dom.log.querySelectorAll(".log-row")];
    rows.forEach((row) => {
      row.classList.toggle("is-hidden", state.filter !== "all" && row.dataset.kind !== state.filter);
    });
    const visible = rows.some((row) => !row.classList.contains("is-hidden"));
    let empty = dom.log.querySelector(".log-empty");
    if (!visible) {
      if (!empty) {
        empty = document.createElement("li");
        empty.className = "log-empty";
        dom.log.append(empty);
      }
      empty.textContent = `NO ENTRIES / ${state.filter.toUpperCase()}`;
    } else if (empty) {
      empty.remove();
    }
  }

  function addEvent({ tag, role = "system", kind = "check", text, at }) {
    const wasAtBottom = nearBottom();
    const item = document.createElement("li");
    item.className = "log-row is-new";
    item.dataset.kind = kind;
    item.dataset.role = role;

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = fmtClock(at ?? state.elapsedMs);

    const roleLabel = document.createElement("span");
    roleLabel.className = "log-role";
    roleLabel.textContent = tag;

    const message = document.createElement("span");
    message.className = "log-text";
    message.textContent = text;

    const kindLabel = document.createElement("span");
    kindLabel.className = "log-kind";
    kindLabel.textContent = KIND_LABEL[kind] ?? kind.toUpperCase();

    item.append(time, roleLabel, message, kindLabel);
    if (state.filter !== "all" && kind !== state.filter) item.classList.add("is-hidden");
    dom.log.append(item);

    state.eventTotal += 1;
    dom.ledgerCount.textContent = pad2(state.eventTotal);
    renderFilter();
    if (wasAtBottom || state.eventTotal <= 3) dom.log.scrollTop = dom.log.scrollHeight;
  }

  function seedLedger() {
    dom.log.textContent = "";
    state.eventTotal = 0;
    addEvent({ tag: "SYSTEM", role: "system", kind: "check", text: "NDJSON · RPC v1 · permission reversible", at: 0 });
    addEvent({ tag: "QUEEN", role: "queen", kind: "plan", text: "WORK ORDER 0142 装载 · 6 角色待命", at: 0 });
    dom.ledgerCount.textContent = pad2(state.eventTotal);
  }

  function startEvent(node) {
    switch (node.role) {
      case "queen":
        return node.kind === "plan"
          ? { kind: "plan", text: "read AGENTS.md · 读取仓库与会话状态" }
          : { kind: "handoff", text: "核对交接证据 · 准备最终验收" };
      case "scout": {
        const files = [
          "src/server/session-status-payloads.ts",
          "gui/shared/rpc.ts",
          "tests/session",
        ];
        return { kind: "tool", text: `read_file ${files[node.index % files.length]}` };
      }
      case "worker": {
        const files = [
          "gui/state/sessionStore.ts",
          "gui/lib/api.ts",
          "gui/shared/rpc.ts",
        ];
        return { kind: "tool", text: `edit_file ${files[node.index % files.length]}` };
      }
      case "reviewer":
        return { kind: "tool", text: "grep turn.ended src/server · gui" };
      case "guard":
        return { kind: "tool", text: "read src/permissions/types.ts" };
      case "merger":
        return { kind: "tool", text: "read 3 份交接 · 解析冲突" };
      default:
        return { kind: "tool", text: "读取上下文" };
    }
  }

  function doneEvent(node) {
    switch (node.role) {
      case "queen":
        return node.kind === "plan"
          ? { kind: "plan", text: `DAG READY · ${state.plan.stages.length} 个阶段` }
          : { kind: "handoff", text: "ACCEPTED · RUN 0142 已关闭" };
      case "scout": {
        const texts = ["交接 6 条证据 · 0 风险", "交接 4 个路径 · 0 风险", "交接 3 个测试 · 0 风险"];
        return { kind: "handoff", text: texts[node.index % texts.length] };
      }
      case "worker": {
        const texts = [
          { kind: "check", text: "typecheck:tui · PASS" },
          { kind: "check", text: "vitest session-store · PASS" },
          { kind: "handoff", text: "3 files · +126 −38 · 0 blockers" },
        ];
        return texts[node.index % texts.length];
      }
      case "reviewer":
        return { kind: "check", text: "独立复核 · 2 处修正 · 0 blocker" };
      case "guard":
        return { kind: "check", text: "PASS · 0 破坏性命令 · 回滚可用" };
      case "merger":
        return { kind: "handoff", text: "1 处冲突已解 · 4 个路径" };
      default:
        return { kind: "check", text: "PASS" };
    }
  }

  // ── 运行引擎 ───────────────────────────────────────────────

  function addUsage(stage) {
    const count = stage.ids.length;
    state.tokensIn += 700 + count * 520;
    state.tokensOut += 160 + count * 110;
    state.cacheRead += 600 + count * 240;
    state.context = Math.min(76, state.context + (stage.kind === "plan" ? 3 : 5));
  }

  function beginStage(index) {
    const stage = state.plan.stages[index];
    if (!stage) return;
    state.stageIndex = index;
    stage.ids.forEach((id) => {
      const node = nodeById(id);
      if (node.state !== "done") node.state = "active";
    });
    stage.ids.forEach((id) => {
      const node = nodeById(id);
      const event = startEvent(node);
      addEvent({ tag: node.tag, role: node.role, kind: event.kind, text: event.text });
    });

    if (stage.kind === "accept") {
      state.phase = "awaiting";
      syncAll();
      return;
    }

    state.phase = "running";
    state.stageStartedAt = performance.now();
    state.stageDuration = Math.max(500, stage.duration / state.speed);
    state.stageRemaining = state.stageDuration;
    syncAll();
  }

  function finishStage() {
    const stage = state.plan.stages[state.stageIndex];
    if (!stage || stage.kind === "accept") return;
    stage.ids.forEach((id) => {
      const node = nodeById(id);
      node.state = "done";
      const event = doneEvent(node);
      addEvent({ tag: node.tag, role: node.role, kind: event.kind, text: event.text });
    });
    addUsage(stage);
    const next = state.stageIndex + 1;
    if (next < state.plan.stages.length) beginStage(next);
    else syncAll();
  }

  function clearAuto() {
    if (!state.autoTimer) return;
    clearTimeout(state.autoTimer);
    state.autoTimer = 0;
  }

  function startRun() {
    clearAuto();
    if (state.phase === "accepted" || state.phase === "rejected") {
      resetRun({ start: true });
      return;
    }
    if (state.phase === "running" || state.phase === "awaiting") return;
    if (state.phase === "paused") {
      resumeRun();
      return;
    }
    beginStage(0);
  }

  function pauseRun() {
    if (state.phase !== "running") return;
    state.stageRemaining = Math.max(300, state.stageDuration - (performance.now() - state.stageStartedAt));
    state.phase = "paused";
    syncAll();
  }

  function resumeRun() {
    if (state.phase !== "paused") return;
    const stage = state.plan.stages[state.stageIndex];
    const hasActive = stage && stage.ids.some((id) => nodeById(id).state === "active");
    if (stage && hasActive) {
      state.phase = "running";
      state.stageStartedAt = performance.now() - (state.stageDuration - state.stageRemaining);
      syncAll();
      return;
    }
    const next = state.stageIndex + 1;
    if (next < state.plan.stages.length) beginStage(next);
  }

  function resetRun({ start = false } = {}) {
    clearAuto();
    if (state.replyTimer) {
      clearTimeout(state.replyTimer);
      state.replyTimer = 0;
    }
    state.generation += 1;
    state.phase = "idle";
    state.elapsedMs = 0;
    state.lastClock = "";
    state.stageIndex = -1;
    state.stageStartedAt = 0;
    state.stageDuration = 0;
    state.stageRemaining = 0;
    state.context = 48;
    state.cacheRead = 12400;
    state.tokensIn = 12400;
    state.tokensOut = 2600;
    state.plan = buildPlan(state.patternKey);
    state.plan.byId.get("queen-plan").state = "ready";
    renderYard();
    seedLedger();
    syncPatternUI();
    syncAll();
    dom.approval.hidden = true;
    if (start) requestAnimationFrame(() => startRun());
  }

  function acceptRun() {
    if (state.phase !== "awaiting") return;
    nodeById("queen-accept").state = "done";
    state.phase = "accepted";
    addEvent({ tag: "QUEEN", role: "queen", kind: "handoff", text: "ACCEPTED · 4/4 · RUN 0142 已关闭" });
    syncAll();
  }

  function rejectRun() {
    if (state.phase !== "awaiting") return;
    nodeById("queen-accept").state = "blocked";
    state.phase = "rejected";
    addEvent({ tag: "QUEEN", role: "queen", kind: "check", text: "REJECTED · 运行已终止，保留待办" });
    syncAll();
  }

  function rewindStage() {
    if (!state.plan) return;
    const stages = state.plan.stages;
    let target = -1;
    for (let i = stages.length - 2; i >= 1; i -= 1) {
      const stage = stages[i];
      if (stage.kind === "pattern" && stage.ids.every((id) => nodeById(id).state === "done")) {
        target = i;
        break;
      }
    }
    if (target === -1) {
      addEvent({ tag: "QUEEN", role: "queen", kind: "check", text: "REWIND · 无可回退阶段" });
      return;
    }

    state.phase = "paused";
    state.stageStartedAt = 0;
    state.stageDuration = 0;
    state.stageRemaining = 0;

    for (let i = target; i < stages.length; i += 1) {
      stages[i].ids.forEach((id) => { nodeById(id).state = "queued"; });
    }
    const targetStage = stages[target];
    nodeById(targetStage.ids[0]).state = "ready";
    state.stageIndex = target - 1;
    state.context = Math.max(20, state.context - 4);

    addEvent({
      tag: "QUEEN", role: "queen", kind: "check",
      text: `REWIND · ${targetStage.label} 回退到队列`,
    });
    syncAll();
  }

  function toggleSpeed() {
    const now = performance.now();
    if (state.phase === "running" && state.stageDuration > 0) {
      const ratio = Math.min(1, (now - state.stageStartedAt) / state.stageDuration);
      state.speed = state.speed === 1 ? 2 : 1;
      const base = state.plan.stages[state.stageIndex]?.duration ?? 1600;
      state.stageDuration = Math.max(400, base / state.speed);
      state.stageStartedAt = now - ratio * state.stageDuration;
    } else if (state.phase === "paused" && state.stageDuration > 0) {
      const ratio = Math.max(0, Math.min(1, state.stageRemaining / state.stageDuration));
      state.speed = state.speed === 1 ? 2 : 1;
      const base = state.plan.stages[state.stageIndex]?.duration ?? 1600;
      state.stageDuration = Math.max(400, base / state.speed);
      state.stageRemaining = ratio * state.stageDuration;
    } else {
      state.speed = state.speed === 1 ? 2 : 1;
    }
    dom.speedBtn.textContent = `${state.speed}×`;
    dom.speedBtn.setAttribute("aria-label", `播放速度 ${state.speed} 倍`);
  }

  // ── inspector sheet ────────────────────────────────────────

  function openInspectorSheet() {
    if (!SHEET.matches) return;
    dom.inspector.classList.add("is-open");
    dom.sheetBackdrop.hidden = false;
    document.body.classList.add("sheet-open");
  }

  function closeInspectorSheet() {
    dom.inspector.classList.remove("is-open");
    dom.sheetBackdrop.hidden = true;
    document.body.classList.remove("sheet-open");
  }

  // ── commands ───────────────────────────────────────────────

  function addSystem(text, kind = "check") {
    addEvent({ tag: "SYSTEM", role: "system", kind, text });
  }

  function cmdStatus() {
    const total = state.plan ? state.plan.nodes.length : 0;
    const done = state.plan ? state.plan.nodes.filter((node) => node.state === "done").length : 0;
    addSystem(
      `${PHASE_TEXT[state.phase]} · ${PATTERNS[state.patternKey].en} · ${done}/${total} 节点 · CTX ${Math.round(state.context)}% · IN ${fmtTokens(state.tokensIn)}`,
    );
  }

  function cmdAgents() {
    selectRole("queen");
    const strong = ROLE_ORDER.filter((key) => ROLES[key].tier === "STRONG").length;
    addSystem(`角色配置 · ${strong} STRONG / ${ROLE_ORDER.length - strong} FAST · 思考深度独立`, "check");
    openInspectorSheet();
  }

  function cmdCompact() {
    const before = Math.round(state.context);
    state.context = Math.max(18, state.context - 34);
    state.cacheRead += 8200;
    syncContext();
    addSystem(`COMPACT · sealed 42 turns · context ${before}% → ${Math.round(state.context)}%`);
  }

  function cmdRewind() {
    rewindStage();
  }

  function cmdDiff() {
    addSystem("DIFF · 4 files · +126 −38 · gui/state · gui/lib · gui/shared", "handoff");
  }

  function cmdTheme() {
    const next = document.documentElement.dataset.theme === "day" ? "night" : "day";
    applyTheme(next);
    addSystem(`THEME → ${next.toUpperCase()}`);
  }

  function cmdHelp() {
    addSystem(`命令 · ${COMMANDS.map((item) => item.cmd).join(" ")}`, "check");
  }

  const COMMANDS = [
    { cmd: "/status", desc: "输出运行、上下文与角色状态", run: cmdStatus },
    { cmd: "/agents", desc: "查看六角色配置与检查器", run: cmdAgents },
    { cmd: "/compact", desc: "压缩上下文，释放预算", run: cmdCompact },
    { cmd: "/rewind", desc: "回退最近一个已完成阶段", run: cmdRewind },
    { cmd: "/diff", desc: "查看本轮改动概览", run: cmdDiff },
    { cmd: "/theme", desc: "切换 NIGHT / DAY", run: cmdTheme },
    { cmd: "/help", desc: "列出可用命令", run: cmdHelp },
  ];

  function executeCommand(text) {
    const command = COMMANDS.find((item) => item.cmd === text);
    closeCommandMenu();
    if (command) command.run();
    else addSystem(`未知命令 ${text} · 输入 /help`, "check");
  }

  function runUserMessage(text) {
    addEvent({ tag: "YOU", role: "system", kind: "plan", text });
    const generation = state.generation;
    const reply = {
      running: "已收指令 · 当前阶段后评估。",
      paused: "指令已记录 · RESUME 后纳入本轮。",
      awaiting: "指令已记录 · 验收后处理。",
      accepted: "指令已记录 · 作为下一轮输入。",
      rejected: "指令已记录 · 重新编排前保留。",
      idle: "指令已记录 · RUN 后纳入本轮。",
    }[state.phase] ?? "指令已记录。";
    if (state.replyTimer) clearTimeout(state.replyTimer);
    state.replyTimer = window.setTimeout(() => {
      state.replyTimer = 0;
      if (generation !== state.generation) return;
      addEvent({ tag: "QUEEN", role: "queen", kind: "handoff", text: reply });
    }, 420);
  }

  // ── command menu ───────────────────────────────────────────

  function closeCommandMenu() {
    dom.commandMenu.hidden = true;
    dom.commandMenu.textContent = "";
    dom.cmd.setAttribute("aria-expanded", "false");
    dom.cmd.removeAttribute("aria-activedescendant");
    state.menuItems = [];
    state.menuButtons = [];
    state.menuIndex = 0;
  }

  function setMenuActive(index) {
    if (!state.menuButtons.length) return;
    state.menuIndex = (index + state.menuButtons.length) % state.menuButtons.length;
    state.menuButtons.forEach((button, itemIndex) => {
      const active = itemIndex === state.menuIndex;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    dom.cmd.setAttribute("aria-activedescendant", state.menuButtons[state.menuIndex].id);
    state.menuButtons[state.menuIndex].scrollIntoView({ block: "nearest" });
  }

  function renderCommandMenu(items) {
    state.menuItems = items;
    state.menuButtons = [];
    dom.commandMenu.textContent = "";
    if (!items.length) {
      closeCommandMenu();
      return;
    }
    items.forEach((command, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "command";
      button.id = `cmd-option-${index}`;
      button.setAttribute("role", "option");
      button.innerHTML = `<span class="command-key">${command.cmd}</span><span class="command-desc">${command.desc}</span>`;
      button.addEventListener("mousemove", () => setMenuActive(index));
      button.addEventListener("click", () => {
        dom.cmd.value = "";
        executeCommand(command.cmd);
      });
      dom.commandMenu.append(button);
      state.menuButtons.push(button);
    });
    dom.commandMenu.hidden = false;
    dom.cmd.setAttribute("aria-expanded", "true");
    setMenuActive(0);
  }

  function openCommandMenu() {
    const value = dom.cmd.value.trim();
    if (!value.startsWith("/")) {
      closeCommandMenu();
      return;
    }
    renderCommandMenu(COMMANDS.filter((command) => value === "/" || command.cmd.startsWith(value)));
  }

  function onCommandKeydown(event) {
    if (!dom.commandMenu.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setMenuActive(state.menuIndex + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (!dom.commandMenu.hidden && event.key === "Enter" && state.menuItems.length) {
      event.preventDefault();
      const command = state.menuItems[state.menuIndex];
      dom.cmd.value = "";
      executeCommand(command.cmd);
      return;
    }
    if (event.key === "Escape") closeCommandMenu();
    if (event.key === "Tab") closeCommandMenu();
  }

  // ── theme & bindings ───────────────────────────────────────

  function applyTheme(theme) {
    const next = theme === "day" ? "day" : "night";
    document.documentElement.dataset.theme = next;
    dom.themeButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.themeSet === next));
    });
    try { localStorage.setItem("sf.console.theme", next); } catch {}
  }

  function onSubmit(event) {
    event.preventDefault();
    const raw = dom.cmd.value.trim();
    if (!raw) return;
    clearAuto();
    dom.cmd.value = "";
    closeCommandMenu();
    if (raw.startsWith("/")) {
      if (COMMANDS.some((command) => command.cmd === raw)) executeCommand(raw);
      else addSystem(`未知命令 ${raw} · 输入 /help`, "check");
    } else {
      runUserMessage(raw);
    }
  }

  function bind() {
    dom.runBtn.addEventListener("click", () => {
      if (state.phase === "running") pauseRun();
      else startRun();
    });
    dom.resetBtn.addEventListener("click", () => resetRun());
    dom.speedBtn.addEventListener("click", toggleSpeed);
    dom.acceptBtn.addEventListener("click", acceptRun);
    dom.rejectBtn.addEventListener("click", rejectRun);

    dom.filters.forEach((button) => {
      button.addEventListener("click", () => {
        state.filter = button.dataset.filter;
        dom.filters.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        renderFilter();
      });
    });

    dom.themeButtons.forEach((button) => {
      button.addEventListener("click", () => applyTheme(button.dataset.themeSet));
    });

    dom.quick.forEach((button) => {
      button.addEventListener("click", () => {
        clearAuto();
        executeCommand(button.dataset.command);
      });
    });

    dom.cmd.addEventListener("focus", clearAuto);
    dom.cmd.addEventListener("input", () => {
      clearAuto();
      openCommandMenu();
    });
    dom.cmd.addEventListener("keydown", onCommandKeydown);
    dom.composerForm.addEventListener("submit", onSubmit);

    dom.sheetClose.addEventListener("click", closeInspectorSheet);
    dom.sheetBackdrop.addEventListener("click", closeInspectorSheet);
    SHEET.addEventListener("change", (event) => {
      if (!event.matches) closeInspectorSheet();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      closeCommandMenu();
      closeInspectorSheet();
    });

    document.addEventListener("click", (event) => {
      if (dom.commandMenu.hidden) return;
      if (!(event.target instanceof Element) || !event.target.closest(".composer-shell")) {
        closeCommandMenu();
      }
    });
  }

  function init() {
    buildRoleRail();
    buildPatternList();
    buildChecks();
    observeYard();
    bind();

    const initial = document.documentElement.dataset.theme === "day" ? "day" : "night";
    dom.themeButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.themeSet === initial));
    });
    dom.speedBtn.textContent = `${state.speed}×`;

    resetRun();
    setInterval(() => {
      const now = performance.now();
      const delta = now - lastTick;
      lastTick = now;
      if (state.phase !== "running") return;
      state.elapsedMs += delta;
      syncClock();
      if (state.stageStartedAt && now - state.stageStartedAt >= state.stageDuration) {
        finishStage();
      }
    }, 100);

    if (!REDUCED) {
      state.autoTimer = window.setTimeout(() => {
        state.autoTimer = 0;
        if (state.phase === "idle") startRun();
      }, 1200);
    }
  }

  let lastTick = performance.now();
  init();
})();
