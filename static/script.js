const AREAS = ["bathroom", "kitchen", "laundry", "gardening"];
const TANK_TOP = 20, TANK_BOTTOM = 250, TANK_H = TANK_BOTTOM - TANK_TOP;
const $ = (id) => document.getElementById(id);

let myName = localStorage.getItem("waterUser") || "";
let period = "all";
let lastSummary = null;

const fmt = (n) => Math.round(n).toLocaleString();
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------- Toast Notifications ---------- */
function showToast(message, type = "info") {
  const container = $("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

/* ---------- Sliders <-> Number Inputs Synchronization ---------- */
function paintSlider(r) {
  const min = parseFloat(r.min) || 0;
  const max = parseFloat(r.max) || 100;
  const val = parseFloat(r.value) || 0;
  const pct = Math.min(Math.max(((val - min) / (max - min)) * 100, 0), 100);
  r.style.setProperty("--fill", pct + "%");
}

function updateAreaStatus(area) {
  const statusEl = $(area + "-status");
  if (!statusEl) return;
  const num = parseFloat($(area + "-num").value) || 0;
  const avg = (window.WATER && window.WATER.avg && window.WATER.avg[area.charAt(0).toUpperCase() + area.slice(1)]) || 100;

  statusEl.className = "slider-pct";
  if (num > avg * 1.2) {
    const overPct = Math.round(((num - avg) / avg) * 100);
    statusEl.textContent = `+${overPct}% High`;
    statusEl.classList.add("high");
  } else if (num < avg * 0.85) {
    statusEl.textContent = "Low / Eco";
    statusEl.classList.add("low");
  } else {
    statusEl.textContent = "Normal";
    statusEl.classList.add("medium");
  }
}

function updateSum() {
  const total = AREAS.reduce((s, a) => s + (parseFloat($(a + "-num").value) || 0), 0);
  $("sum-live").textContent = Math.round(total).toLocaleString() + " L";
}

AREAS.forEach((a) => {
  const range = $(a), num = $(a + "-num");
  if (!range || !num) return;

  paintSlider(range);
  updateAreaStatus(a);

  range.addEventListener("input", () => {
    num.value = range.value;
    paintSlider(range);
    updateAreaStatus(a);
    updateSum();
  });

  num.addEventListener("input", () => {
    const val = parseFloat(num.value);
    if (!isNaN(val)) {
      range.value = Math.min(Math.max(val, range.min), range.max);
      paintSlider(range);
    }
    updateAreaStatus(a);
    updateSum();
  });
});

updateSum();
if ($("username")) {
  $("username").value = myName;
  $("username").addEventListener("input", (e) => {
    myName = e.target.value.trim();
    localStorage.setItem("waterUser", myName);
  });
}

/* ---------- Preset Scenarios ---------- */
const PRESETS = {
  eco: { bathroom: 75, kitchen: 48, laundry: 38, gardening: 45, label: "Eco Saver" },
  avg: { bathroom: 119, kitchen: 70, laundry: 59, gardening: 78, label: "Average Household" },
  high: { bathroom: 180, kitchen: 115, laundry: 95, gardening: 165, label: "High Usage" }
};

document.querySelectorAll(".btn-preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    const presetKey = btn.dataset.preset;
    const p = PRESETS[presetKey];
    if (!p) return;

    AREAS.forEach((a) => {
      const range = $(a), num = $(a + "-num");
      if (range && num && p[a] !== undefined) {
        num.value = p[a];
        range.value = p[a];
        paintSlider(range);
        updateAreaStatus(a);
      }
    });

    updateSum();
    showToast(`Loaded ${p.label} preset values`, "info");
  });
});

/* ---------- SVG Water Tank Rendering ---------- */
function setTank(litres, target, scale, level) {
  const h = Math.min(litres / scale, 1) * TANK_H;
  const yWater = TANK_BOTTOM - h;

  const water = $("water");
  water.setAttribute("y", yWater);
  water.setAttribute("height", h);

  const wave = $("wave");
  wave.style.transform = `translateY(${-h}px)`;

  // Scale target line
  const ty = TANK_BOTTOM - Math.min(target / scale, 1) * TANK_H;
  const line = $("target-line");
  const targetLabel = $("target-label");
  if (line && targetLabel) {
    line.style.display = "block";
    line.setAttribute("y1", ty);
    line.setAttribute("y2", ty);
    targetLabel.style.display = "block";
    targetLabel.setAttribute("y", Math.max(ty - 6, 26));
    targetLabel.textContent = `Target ${Math.round(target)} L`;
  }

  // Position benchmark line
  const bench = (window.WATER && window.WATER.benchmark) || 299.5;
  const by = TANK_BOTTOM - Math.min(bench / scale, 1) * TANK_H;
  const benchLine = $("bench-line");
  const benchLabel = $("bench-label");
  if (benchLine && benchLabel) {
    benchLine.setAttribute("y1", by);
    benchLine.setAttribute("y2", by);
    benchLabel.setAttribute("y", Math.max(by - 6, 26));
  }

  const col = document.querySelector(".tank-col");
  if (col) {
    col.classList.remove("low", "medium", "high");
    col.classList.add(level.toLowerCase());
  }
}

/* ---------- Number Count-Up Animation ---------- */
function countUp(el, to) {
  const start = performance.now(), dur = 750;
  const tick = (t) => {
    const p = Math.min((t - start) / dur, 1);
    el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))).toLocaleString();
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- Result Card Rendering ---------- */
function render(d) {
  $("empty-state").hidden = true;
  $("result").hidden = false;
  ["breakdown-panel", "tips-panel", "rewards-panel"].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = false;
  });

  countUp($("pred-val"), d.predicted);

  const chip = $("level-chip");
  chip.className = "chip level " + d.level.toLowerCase();
  chip.textContent = `${d.level} Consumption Pattern`;

  $("top-chip").textContent = "Highest Area: " + d.top_area;
  $("advice").textContent = d.recommended.advice;
  $("actual-val").textContent = fmt(d.actual_total) + " L";
  $("limit-val").textContent = fmt(d.recommended.limit) + " L";
  $("bench-val").textContent = fmt(d.benchmark) + " L";
  $("waste-val").textContent = fmt(d.wastage) + " L";

  const wasteTile = document.querySelector(".facts .waste");
  if (wasteTile) {
    wasteTile.classList.toggle("zero", d.wastage === 0);
  }

  setTank(d.predicted, d.recommended.limit, d.scale, d.level);

  // Breakdown Bars
  const maxVal = Math.max(...d.breakdown.map((b) => Math.max(b.value, b.avg))) * 1.15 || 1;
  $("bars").innerHTML = d.breakdown.map((b) => {
    const isOver = b.value > b.avg * 1.2;
    const diffPct = Math.round(((b.value - b.avg) / b.avg) * 100);
    const diffBadge = isOver
      ? `<span class="slider-pct high">+${diffPct}%</span>`
      : `<span class="slider-pct low">OK</span>`;

    return `
      <div class="bar-row">
        <div class="bar-label">
          <span>${b.area} ${diffBadge}</span>
          <span><b>${Math.round(b.value)} L</b> vs ${Math.round(b.avg)} L avg</span>
        </div>
        <div class="track">
          <div class="fill ${isOver ? "over" : ""}" data-w="${Math.min((b.value / maxVal) * 100, 100)}"></div>
          <div class="avg-mark" style="left:calc(${(b.avg / maxVal) * 100}% - 1.5px)" title="Average ${Math.round(b.avg)} L"></div>
        </div>
      </div>`;
  }).join("");

  requestAnimationFrame(() => {
    document.querySelectorAll("#bars .fill").forEach((f) => {
      f.style.width = f.dataset.w + "%";
    });
  });

  // Tips
  if (d.tips && d.tips.length) {
    $("tips").innerHTML = d.tips.map((t) => `
      <li>
        <b>${t.area}</b>
        <span>${t.tip}</span>
        ${t.ratio > 1.05 ? `<span class="pct">+${Math.round((t.ratio - 1) * 100)}% above typical household baseline</span>` : ""}
      </li>`).join("");
  } else {
    $("tips").innerHTML = `
      <li class="good">
        <b>Optimal Household Efficiency</b>
        <span>All activity categories are within balanced consumption limits. Great job conserving water!</span>
      </li>`;
  }

  // Daily Rewards
  const r = d.rewards;
  $("pts-earned").textContent = "+" + r.earned;

  const goalLabel = !r.goal.set
    ? "Daily Goal Bonus (set a personal goal below)"
    : r.goal.met
      ? `Within your ${fmt(r.goal.target)} L goal`
      : `Exceeded your ${fmt(r.goal.target)} L goal`;

  const lines = [
    [d.wastage === 0 ? "Zero wastage today (+50 max)" : `Wastage efficiency score (${Math.round(d.wastage)} L above benchmark)`, r.usage],
    [r.reduction > 0 ? `Reduced ${r.reduction_pct}% compared to prior entry` : "Daily reduction bonus", r.reduction],
    [r.streak > 1 ? `${r.streak}-day zero-wastage streak bonus` : "Streak bonus (active on 2+ consecutive zero-wastage days)", r.streak_bonus],
    [goalLabel, r.goal_bonus],
  ];

  $("reward-lines").innerHTML = lines.map(([title, pts]) => `
    <li class="${pts > 0 ? "" : "off"}">
      <span>${title}</span>
      <b>+${pts}</b>
    </li>`).join("");

  $("reward-detail").textContent = r.updated
    ? "You previously logged today, so today's entry was updated with your latest figures."
    : "Awesome effort! Log again tomorrow to maintain your conservation streak.";

  $("pts-total").textContent = fmt(r.total);
  $("badge").textContent = r.badge;
}

/* ---------- Community Leaderboard ---------- */
async function loadBoard() {
  const boardEl = $("board");
  if (!boardEl) return;

  try {
    const res = await fetch("/api/leaderboard?period=" + period);
    const { leaders } = await res.json();

    if (!leaders || !leaders.length) {
      boardEl.innerHTML = `<li class="muted">${period === "all" ? "No entries recorded yet. Be the first to log a day!" : "No active entries in this timeframe yet."}</li>`;
      return;
    }

    boardEl.innerHTML = leaders.map((l) => {
      const isMe = myName && l.username.toLowerCase() === myName.toLowerCase();
      let rankDisplay = l.rank;
      if (l.rank === 1) rankDisplay = "🥇";
      else if (l.rank === 2) rankDisplay = "🥈";
      else if (l.rank === 3) rankDisplay = "🥉";

      return `
        <li class="${isMe ? "me" : ""}">
          <span class="rank">${rankDisplay}</span>
          <div class="who">
            <span>${escapeHtml(l.username)} ${isMe ? "<small style='display:inline;color:var(--deep);font-weight:700'>(You)</small>" : ""}</span>
            <small>${l.badge} &bull; ${l.days} day${l.days === 1 ? "" : "s"} logged${l.streak > 1 ? " &bull; " + l.streak + "-day streak" : ""}</small>
          </div>
          <span class="lvl ${l.level}">${l.level}</span>
          <span class="score">${l.points.toLocaleString()} <small style="font-size:0.75rem;font-weight:500;color:var(--muted)">pts</small></span>
        </li>`;
    }).join("");
  } catch (err) {
    boardEl.innerHTML = `<li class="muted">Could not load leaderboard entries.</li>`;
  }
}

document.querySelectorAll(".tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs .tab").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    period = btn.dataset.period;
    loadBoard();
  });
});

/* ---------- Interactive History Chart (SVG + Tooltip) ---------- */
function drawChart(days, benchmark, goal) {
  const box = $("history-chart");
  if (!box) return;

  if (!days || !days.length) {
    box.innerHTML = `<p class="muted" style="padding:40px 0;text-align:center;">No history recorded yet. Run your first analysis to begin tracking your usage trend.</p>`;
    return;
  }

  const W = 620, H = 240, pl = 44, pr = 16, pt = 20, pb = 28;
  const max = Math.max(...days.map((d) => d.total), benchmark, goal || 0) * 1.15;
  const x = (i) => days.length === 1 ? pl + (W - pl - pr) / 2 : pl + (i * (W - pl - pr)) / (days.length - 1);
  const y = (v) => pt + (1 - v / max) * (H - pt - pb);

  // Background Grid
  let gridLines = "";
  for (let k = 0; k <= 4; k++) {
    const val = (max / 4) * k;
    const yPos = y(val);
    gridLines += `
      <line x1="${pl}" x2="${W - pr}" y1="${yPos}" y2="${yPos}" class="grid"/>
      <text x="${pl - 8}" y="${yPos + 4}" text-anchor="end" class="axis">${Math.round(val)}</text>`;
  }

  // Reference lines
  const hline = (v, cls, label) => `
    <line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" class="${cls}"/>
    <text x="${W - pr}" y="${Math.max(y(v) - 5, 14)}" text-anchor="end" class="axis ${cls}-t">${label}</text>`;

  let marks = hline(benchmark, "bench", "Benchmark " + Math.round(benchmark) + " L");
  if (goal) marks += hline(goal, "goal", "Goal " + Math.round(goal) + " L");

  // Trend line & Data Points
  const pts = days.map((d, i) => `${x(i)},${y(d.total)}`).join(" ");
  const dots = days.map((d, i) => `
    <circle cx="${x(i)}" cy="${y(d.total)}" r="5"
      class="${d.wastage > 0 ? "pt-bad" : "pt-ok"}"
      data-date="${d.date}"
      data-total="${Math.round(d.total)}"
      data-waste="${Math.round(d.wastage)}"
      data-pts="${d.points}"
      data-level="${d.level}">
    </circle>`).join("");

  const short = (s) => s.slice(5);
  const xLabels = `
    <text x="${x(0)}" y="${H - 6}" text-anchor="${days.length === 1 ? "middle" : "start"}" class="axis">${short(days[0].date)}</text>` +
    (days.length > 1 ? `<text x="${x(days.length - 1)}" y="${H - 6}" text-anchor="end" class="axis">${short(days[days.length - 1].date)}</text>` : "");

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily water consumption history trend">
      ${gridLines}
      ${marks}
      <polyline points="${pts}" class="trend"/>
      ${dots}
      ${xLabels}
    </svg>
    <div id="chart-tooltip" class="chart-tooltip" style="opacity:0"></div>`;

  // Attach interactive hover tooltips
  const tooltip = $("chart-tooltip");
  box.querySelectorAll("circle").forEach((circle) => {
    circle.addEventListener("mouseenter", (e) => {
      const r = circle.getBoundingClientRect();
      const wrapRect = box.getBoundingClientRect();
      tooltip.innerHTML = `
        <strong>${circle.dataset.date}</strong><br>
        Usage: <b>${circle.dataset.total} L</b> (${circle.dataset.level})<br>
        Wastage: ${circle.dataset.waste} L &bull; +${circle.dataset.pts} pts`;
      tooltip.style.left = (r.left - wrapRect.left + r.width / 2) + "px";
      tooltip.style.top = (r.top - wrapRect.top) + "px";
      tooltip.style.opacity = "1";
    });
    circle.addEventListener("mouseleave", () => {
      tooltip.style.opacity = "0";
    });
  });
}

/* ---------- Monthly Billing & Projections ---------- */
function computeBill() {
  const s = lastSummary, out = $("bill-line");
  if (!out) return;
  if (!s || !s.has_data) { out.textContent = ""; return; }

  const rate = parseFloat($("rate").value) || 0;
  const sym = $("sym").value || "$";
  localStorage.setItem("waterRate", $("rate").value);
  localStorage.setItem("waterSym", sym);

  const cost = (litres) => sym + ((litres / 1000) * rate).toFixed(2);

  let html = `Estimated bill this month: <b>${cost(s.projected)}</b>`;
  if (s.potential_saving > 0) {
    html += `<br><span class="muted">Maintaining efficient benchmark usage could save ~${fmt(s.potential_saving)} L (${cost(s.potential_saving)}).</span>`;
  } else {
    html += `<br><span class="muted" style="color:var(--low-text)">Your projected monthly consumption is comfortably within the efficient benchmark band.</span>`;
  }
  out.innerHTML = html;
}

function renderMonth(s) {
  lastSummary = s;
  const factsEl = $("month-facts");
  if (!factsEl) return;

  if (!s.has_data) {
    factsEl.innerHTML = `<p class="muted">Log your first usage entry to calculate monthly projections.</p>`;
  } else {
    const f = (label, val) => `<div><dt>${label}</dt><dd>${val}</dd></div>`;
    factsEl.innerHTML =
      f("Volume Logged", fmt(s.month_total) + " L") +
      f("Days Logged", s.days_logged) +
      f("Daily Average", fmt(s.avg_daily) + " L") +
      f("Month Projected", fmt(s.projected) + " L");
  }
  computeBill();

  // Update Goal Progress Card
  const fill = $("goal-fill"), txt = $("goal-text");
  if (s.goal) {
    $("goal-input").value = s.goal;
    const t = s.today_total;
    const pct = t == null ? 0 : Math.min((t / s.goal) * 100, 100);
    if (fill) {
      fill.style.width = pct + "%";
      fill.classList.toggle("over", t != null && t > s.goal);
    }
    let line = t == null ? `No entry logged today yet. Target: ${fmt(s.goal)} L.` : `Today: ${fmt(t)} of ${fmt(s.goal)} L goal.`;
    if (s.has_data) line += ` Target met on ${s.goal_days_met} of ${s.days_logged} days this month`;
    if (s.goal_streak > 1) line += ` (${s.goal_streak}-day goal streak!)`;
    if (txt) txt.textContent = line;
  } else {
    $("goal-input").value = "";
    if (fill) fill.style.width = "0%";
    if (txt) txt.textContent = "Set a daily goal to earn +10 bonus points on days you stay within your limit.";
  }
}

/* ---------- Load User Progress ---------- */
async function loadProgress() {
  if (!myName) return;
  const panel = $("progress-panel");
  if (panel) panel.hidden = false;

  const q = "?user=" + encodeURIComponent(myName);
  try {
    const [h, s] = await Promise.all([
      fetch("/api/history" + q).then((r) => r.json()),
      fetch("/api/summary" + q).then((r) => r.json()),
    ]);
    drawChart(h.days, h.benchmark, h.goal);
    renderMonth(s);
  } catch (err) {
    console.error("Error loading progress:", err);
  }
}

if ($("rate") && $("sym")) {
  $("rate").value = localStorage.getItem("waterRate") || $("rate").value;
  $("sym").value = localStorage.getItem("waterSym") || $("sym").value;
  ["rate", "sym"].forEach((id) => $(id).addEventListener("input", computeBill));
}

if ($("goal-btn")) {
  $("goal-btn").addEventListener("click", async () => {
    const err = $("goal-error");
    if (err) err.hidden = true;
    const name = ($("username").value || myName || "").trim();
    if (!name) {
      if (err) { err.textContent = "Please enter your name first."; err.hidden = false; }
      return;
    }

    try {
      const res = await fetch("/api/goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name, goal: $("goal-input").value || 0 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      myName = name;
      localStorage.setItem("waterUser", myName);
      showToast(data.goal ? `Daily goal set to ${data.goal} L` : "Daily goal removed", "success");
      await loadProgress();
    } catch (ex) {
      if (err) { err.textContent = ex.message; err.hidden = false; }
    }
  });
}

/* ---------- Form Submission Handler ---------- */
$("usage-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("form-error"), btn = $("submit-btn");
  if (err) err.hidden = true;

  const usernameInput = $("username").value.trim();
  if (!usernameInput) {
    if (err) {
      err.textContent = "Please enter your name or household ID to track your score.";
      err.hidden = false;
    }
    $("username").focus();
    return;
  }

  const payload = { username: usernameInput };
  AREAS.forEach((a) => (payload[a] = parseFloat($(a + "-num").value) || 0));

  btn.disabled = true;
  const btnText = btn.querySelector(".btn-text");
  if (btnText) btnText.textContent = "Calculating ML Prediction...";

  try {
    const res = await fetch("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Prediction request failed.");

    myName = data.username;
    localStorage.setItem("waterUser", myName);

    render(data);
    showToast(`Analysis completed for ${myName}!`, "success");

    await Promise.all([loadBoard(), loadProgress()]);

    if (window.innerWidth < 920) {
      $("main-result-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (ex) {
    if (err) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  } finally {
    btn.disabled = false;
    if (btnText) btnText.textContent = "Run ML Prediction & Analysis";
  }
});

/* ---------- Initial Application Load ---------- */
loadBoard();
if (myName) {
  loadProgress();
}
