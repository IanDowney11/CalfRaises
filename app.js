(() => {
  const STORAGE_KEY = 'calfHoldEntries';

  // ---------- storage ----------
  function loadEntries() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  }

  function saveEntries(entries) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }

  let entries = loadEntries();

  // ---------- helpers ----------
  function dateKey(isoTs) {
    const d = new Date(isoTs);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatDayLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const today = new Date();
    const todayKey = dateKey(today.toISOString());
    if (key === todayKey) return 'Today';
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function formatClock(isoTs) {
    const d = new Date(isoTs);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function legLabel(leg) {
    return leg === 'left' ? 'Left' : 'Right';
  }

  function average(nums) {
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  // ---------- DOM refs ----------
  const todaySummaryEl = document.getElementById('today-summary');
  const todayListEl = document.getElementById('today-list');
  const historyDaysEl = document.getElementById('history-days');
  const chartCardEl = document.getElementById('chart-card');
  const lastSavedEl = document.getElementById('last-saved');

  const timerOverlay = document.getElementById('timer-overlay');
  const timerLegLabel = document.getElementById('timer-leg-label');
  const timerDisplay = document.getElementById('timer-display');
  const btnStop = document.getElementById('btn-stop');
  const btnCancel = document.getElementById('btn-cancel');

  // ---------- timer ----------
  let timerLeg = null;
  let timerStart = null;
  let timerRaf = null;

  function startTimer(leg) {
    timerLeg = leg;
    timerStart = performance.now();
    timerLegLabel.textContent = `${legLabel(leg)} leg hold`;
    timerDisplay.textContent = '0.0s';
    timerOverlay.hidden = false;
    tickTimer();
  }

  function tickTimer() {
    const elapsed = (performance.now() - timerStart) / 1000;
    timerDisplay.textContent = `${elapsed.toFixed(1)}s`;
    timerRaf = requestAnimationFrame(tickTimer);
  }

  function stopTimer() {
    const elapsed = (performance.now() - timerStart) / 1000;
    cancelAnimationFrame(timerRaf);
    timerOverlay.hidden = true;

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      leg: timerLeg,
      duration: Math.round(elapsed * 10) / 10,
      ts: new Date().toISOString(),
    };
    entries.push(entry);
    saveEntries(entries);

    lastSavedEl.hidden = false;
    lastSavedEl.textContent = `Saved: ${legLabel(entry.leg)} leg — ${entry.duration.toFixed(1)}s`;

    renderAll();
  }

  function cancelTimer() {
    cancelAnimationFrame(timerRaf);
    timerOverlay.hidden = true;
  }

  document.getElementById('btn-left').addEventListener('click', () => startTimer('left'));
  document.getElementById('btn-right').addEventListener('click', () => startTimer('right'));
  btnStop.addEventListener('click', stopTimer);
  btnCancel.addEventListener('click', cancelTimer);

  // ---------- delete ----------
  function deleteEntry(id) {
    entries = entries.filter(e => e.id !== id);
    saveEntries(entries);
    renderAll();
  }

  function entryRowHtml(entry) {
    return `
      <li class="entry-row" data-id="${entry.id}">
        <span class="entry-row__dot entry-row__dot--${entry.leg}"></span>
        <span class="entry-row__leg">${legLabel(entry.leg)}</span>
        <span class="entry-row__time">${formatClock(entry.ts)}</span>
        <span class="entry-row__duration">${entry.duration.toFixed(1)}s</span>
        <button class="entry-row__delete" data-delete="${entry.id}" type="button" aria-label="Delete entry">✕</button>
      </li>`;
  }

  function attachDeleteHandlers(root) {
    root.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteEntry(btn.getAttribute('data-delete')));
    });
  }

  // ---------- today summary ----------
  function renderTodaySummary() {
    const todayKey = dateKey(new Date().toISOString());
    const todays = entries.filter(e => dateKey(e.ts) === todayKey);
    const left = todays.filter(e => e.leg === 'left');
    const right = todays.filter(e => e.leg === 'right');
    const leftAvg = average(left.map(e => e.duration));
    const rightAvg = average(right.map(e => e.duration));

    todaySummaryEl.innerHTML = `
      <div class="stat stat--left">
        <div class="stat__label">Left</div>
        <div class="stat__value">${left.length}</div>
        <div class="stat__sub">${leftAvg ? `avg ${leftAvg.toFixed(1)}s` : 'no holds yet'}</div>
      </div>
      <div class="stat stat--right">
        <div class="stat__label">Right</div>
        <div class="stat__value">${right.length}</div>
        <div class="stat__sub">${rightAvg ? `avg ${rightAvg.toFixed(1)}s` : 'no holds yet'}</div>
      </div>`;

    if (todays.length === 0) {
      todayListEl.innerHTML = `<p class="empty-note">No holds logged today yet.</p>`;
    } else {
      todayListEl.innerHTML = todays
        .slice()
        .reverse()
        .map(entryRowHtml)
        .join('');
      attachDeleteHandlers(todayListEl);
    }
  }

  // ---------- history list ----------
  function renderHistoryDays() {
    if (entries.length === 0) {
      historyDaysEl.innerHTML = `<p class="empty-note">No holds logged yet. Start logging on the Log tab.</p>`;
      return;
    }

    const byDay = new Map();
    entries.forEach(e => {
      const key = dateKey(e.ts);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    });

    const sortedKeys = [...byDay.keys()].sort((a, b) => (a < b ? 1 : -1));

    historyDaysEl.innerHTML = sortedKeys
      .map(key => {
        const dayEntries = byDay.get(key).slice().reverse();
        return `
          <div class="history-day">
            <div class="history-day__heading">${formatDayLabel(key)}</div>
            <ul class="entry-list">
              ${dayEntries.map(entryRowHtml).join('')}
            </ul>
          </div>`;
      })
      .join('');

    attachDeleteHandlers(historyDaysEl);
  }

  // ---------- chart ----------
  const SERIES_COLOR = { left: 'var(--series-left)', right: 'var(--series-right)' };

  function buildChart() {
    if (entries.length === 0) {
      chartCardEl.innerHTML = `<p class="empty-note">Log a few holds to see your progress chart here.</p>`;
      return;
    }

    const byDay = new Map();
    entries.forEach(e => {
      const key = dateKey(e.ts);
      if (!byDay.has(key)) byDay.set(key, { left: [], right: [] });
      byDay.get(key)[e.leg].push(e.duration);
    });

    const days = [...byDay.keys()].sort();
    const leftSeries = days.map(k => average(byDay.get(k).left));
    const rightSeries = days.map(k => average(byDay.get(k).right));

    const allVals = [...leftSeries, ...rightSeries].filter(v => v !== null);
    const maxVal = Math.max(...allVals) * 1.15 || 10;

    const W = 300, H = 200;
    const padL = 28, padR = 10, padT = 14, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const xAt = i => (days.length === 1 ? padL + plotW / 2 : padL + (i * plotW) / (days.length - 1));
    const yAt = v => padT + plotH - (v / maxVal) * plotH;

    function seriesPath(series) {
      let path = '';
      let open = false;
      series.forEach((v, i) => {
        if (v === null) { open = false; return; }
        const x = xAt(i), y = yAt(v);
        path += open ? ` L ${x.toFixed(1)} ${y.toFixed(1)}` : `M ${x.toFixed(1)} ${y.toFixed(1)}`;
        open = true;
      });
      return path;
    }

    function markers(series, leg) {
      return series
        .map((v, i) => {
          if (v === null) return '';
          return `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="4" fill="${SERIES_COLOR[leg]}" data-idx="${i}"></circle>`;
        })
        .join('');
    }

    // gridlines (4 horizontal bands)
    const gridLines = [0.25, 0.5, 0.75, 1].map(f => {
      const y = padT + plotH * (1 - f);
      return `<line x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--gridline)" stroke-width="1"></line>`;
    }).join('');

    // x-axis labels: show at most 6, evenly spaced
    const labelStep = Math.max(1, Math.ceil(days.length / 6));
    const xLabels = days
      .map((key, i) => (i % labelStep === 0 || i === days.length - 1 ? i : null))
      .filter(i => i !== null)
      .map(i => `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" font-size="9" fill="var(--text-muted)" text-anchor="middle">${formatDayLabel(days[i]).replace('Today', 'Tdy')}</text>`)
      .join('');

    chartCardEl.innerHTML = `
      <div class="chart-wrap">
        <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block" id="chart-svg">
          ${gridLines}
          <line x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="var(--baseline)" stroke-width="1"></line>
          <path d="${seriesPath(leftSeries)}" fill="none" stroke="var(--series-left)" stroke-width="2" stroke-linecap="round"></path>
          <path d="${seriesPath(rightSeries)}" fill="none" stroke="var(--series-right)" stroke-width="2" stroke-linecap="round"></path>
          ${markers(leftSeries, 'left')}
          ${markers(rightSeries, 'right')}
          ${xLabels}
        </svg>
        <div class="chart-tooltip" id="chart-tooltip"></div>
      </div>
      <div class="chart-legend">
        <span class="chart-legend__item"><span class="chart-legend__swatch" style="background:var(--series-left)"></span>Left leg</span>
        <span class="chart-legend__item"><span class="chart-legend__swatch" style="background:var(--series-right)"></span>Right leg</span>
      </div>`;

    attachChartHover(days, leftSeries, rightSeries, { W, H, padL, padR, xAt });
  }

  function attachChartHover(days, leftSeries, rightSeries, geom) {
    const svg = document.getElementById('chart-svg');
    const tooltip = document.getElementById('chart-tooltip');
    if (!svg || !tooltip) return;

    function nearestIndex(clientX) {
      const rect = svg.getBoundingClientRect();
      const relX = ((clientX - rect.left) / rect.width) * geom.W;
      let best = 0, bestDist = Infinity;
      days.forEach((_, i) => {
        const dist = Math.abs(geom.xAt(i) - relX);
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      return best;
    }

    function show(clientX, clientY) {
      const i = nearestIndex(clientX);
      const l = leftSeries[i], r = rightSeries[i];
      const parts = [formatDayLabel(days[i])];
      if (l !== null) parts.push(`Left ${l.toFixed(1)}s`);
      if (r !== null) parts.push(`Right ${r.toFixed(1)}s`);
      tooltip.textContent = parts.join(' · ');

      const rect = svg.getBoundingClientRect();
      const wrapRect = svg.parentElement.getBoundingClientRect();
      const x = geom.xAt(i) / geom.W * rect.width + (rect.left - wrapRect.left);
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `0px`;
      tooltip.classList.add('is-visible');
    }

    function hide() { tooltip.classList.remove('is-visible'); }

    svg.addEventListener('pointermove', e => show(e.clientX, e.clientY));
    svg.addEventListener('pointerdown', e => show(e.clientX, e.clientY));
    svg.addEventListener('pointerleave', hide);
  }

  // ---------- render all ----------
  function renderAll() {
    renderTodaySummary();
    renderHistoryDays();
    buildChart();
  }

  // ---------- tabs ----------
  const views = {
    log: document.getElementById('view-log'),
    progress: document.getElementById('view-progress'),
  };

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      Object.entries(views).forEach(([name, el]) => { el.hidden = name !== btn.dataset.view; });
      if (btn.dataset.view === 'progress') buildChart();
    });
  });

  // ---------- clear all ----------
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (confirm('Delete all logged holds? This cannot be undone.')) {
      entries = [];
      saveEntries(entries);
      renderAll();
    }
  });

  // ---------- service worker ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  renderAll();
})();
