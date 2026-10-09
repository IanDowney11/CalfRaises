import { initKey, importNsec, getNsec, connect, disconnect, publishHold, tombstoneHold } from './nostr.js';

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

  const SESSIONS_PER_DAY = 3;
  const HOLDS_PER_LEG = 3;

  let entries;

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

  // Entries logged before sessions existed: per day and leg, fill sessions of 3 in order.
  function migrateEntries(list) {
    let changed = false;
    const counters = new Map();
    list.forEach(e => {
      if (e.session) return;
      const k = `${dateKey(e.ts)}|${e.leg}`;
      const n = counters.get(k) || 0;
      counters.set(k, n + 1);
      e.session = Math.min(SESSIONS_PER_DAY, Math.floor(n / HOLDS_PER_LEG) + 1);
      changed = true;
    });
    if (changed) saveEntries(list);
    return list;
  }

  entries = migrateEntries(loadEntries());

  // ---------- DOM refs ----------
  const todaySummaryEl = document.getElementById('today-summary');
  const todaySessionsEl = document.getElementById('today-sessions');
  const historyDaysEl = document.getElementById('history-days');
  const chartCardEl = document.getElementById('chart-card');
  const lastSavedEl = document.getElementById('last-saved');

  const entryOverlay = document.getElementById('entry-overlay');
  const entryLegLabel = document.getElementById('entry-leg-label');
  const entryInput = document.getElementById('entry-input');
  const stopwatchDisplay = document.getElementById('stopwatch-display');
  const btnStopwatchToggle = document.getElementById('btn-stopwatch-toggle');
  const btnStopwatchReset = document.getElementById('btn-stopwatch-reset');
  const btnSave = document.getElementById('btn-save');
  const btnEntryCancel = document.getElementById('btn-entry-cancel');

  // ---------- entry form + helper stopwatch ----------
  // The stopwatch is purely an optional aid: while running it live-fills the
  // duration field, but the field stays freely editable and nothing is saved
  // until the user taps Save.
  let entryLeg = null;
  let entrySession = null;
  let swPhase = 'idle'; // 'idle' | 'countdown' | 'running'
  let swAccumulatedMs = 0;
  let swSegmentStart = null;
  let swCountdownEnd = null;
  let swRaf = null;

  // ---------- timer settings (0-10 s each, remembered on this device) ----------
  // delay: get-ready countdown before the clock starts.
  // deduct: seconds removed on stop, to cover the time it takes to reach the button.
  const TIMER_SETTINGS_KEY = 'calfTimerSettings';
  const timerSettings = (() => {
    const defaults = { delay: 5, deduct: 2 };
    try {
      const s = JSON.parse(localStorage.getItem(TIMER_SETTINGS_KEY)) || {};
      const ok = v => Number.isInteger(v) && v >= 0 && v <= 10;
      return { delay: ok(s.delay) ? s.delay : defaults.delay, deduct: ok(s.deduct) ? s.deduct : defaults.deduct };
    } catch {
      return defaults;
    }
  })();

  [['setting-delay', 'delay'], ['setting-deduct', 'deduct']].forEach(([id, key]) => {
    const sel = document.getElementById(id);
    sel.innerHTML = Array.from({ length: 11 }, (_, n) => `<option value="${n}">${n}s</option>`).join('');
    sel.value = String(timerSettings[key]);
    sel.addEventListener('change', () => {
      timerSettings[key] = Number(sel.value);
      localStorage.setItem(TIMER_SETTINGS_KEY, JSON.stringify(timerSettings));
    });
  });

  // Keep the screen awake while the stopwatch runs. The browser drops the lock
  // whenever the page is hidden, so re-acquire when it becomes visible again.
  let wakeLock = null;

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* denied or unsupported; the timer still works, the screen may just sleep */ }
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && swPhase !== 'idle') {
      acquireWakeLock();
      clearTimeout(swRaf);
      swTick();
    }
  });

  function swElapsedSeconds() {
    const running = swPhase === 'running' ? Date.now() - swSegmentStart : 0;
    return (swAccumulatedMs + running) / 1000;
  }

  function beginRunning(startAt) {
    swPhase = 'running';
    swSegmentStart = startAt;
    btnStopwatchToggle.textContent = 'Stop timer';
  }

  function swTick() {
    if (swPhase === 'countdown') {
      const remainingMs = swCountdownEnd - Date.now();
      if (remainingMs <= 0) {
        beginRunning(swCountdownEnd);
      } else {
        stopwatchDisplay.textContent = `Get ready ${Math.ceil(remainingMs / 1000)}`;
        swRaf = setTimeout(swTick, 100);
        return;
      }
    }
    const secs = swElapsedSeconds();
    stopwatchDisplay.textContent = `${secs.toFixed(1)}s`;
    entryInput.value = secs.toFixed(1);
    swRaf = setTimeout(swTick, 100);
  }

  function startStopwatch() {
    if (swPhase !== 'idle') return;
    acquireWakeLock();
    if (timerSettings.delay > 0) {
      swPhase = 'countdown';
      swCountdownEnd = Date.now() + timerSettings.delay * 1000;
      btnStopwatchToggle.textContent = 'Cancel';
    } else {
      beginRunning(Date.now());
    }
    swTick();
  }

  // Stops the clock (or cancels the countdown). applyDeduction is true only
  // for the Stop button; typing into the field just pauses without altering it.
  function stopStopwatch(applyDeduction) {
    if (swPhase === 'idle') return;
    if (swPhase === 'running') {
      let total = swAccumulatedMs + (Date.now() - swSegmentStart);
      if (applyDeduction) total = Math.max(0, total - timerSettings.deduct * 1000);
      swAccumulatedMs = total;
      if (applyDeduction) {
        const secs = total / 1000;
        stopwatchDisplay.textContent = `${secs.toFixed(1)}s`;
        entryInput.value = secs > 0 ? secs.toFixed(1) : '';
      }
    } else {
      stopwatchDisplay.textContent = `${(swAccumulatedMs / 1000).toFixed(1)}s`;
    }
    swPhase = 'idle';
    clearTimeout(swRaf);
    releaseWakeLock();
    btnStopwatchToggle.textContent = 'Start timer';
  }

  function resetStopwatch() {
    swPhase = 'idle';
    swAccumulatedMs = 0;
    swSegmentStart = null;
    swCountdownEnd = null;
    clearTimeout(swRaf);
    releaseWakeLock();
    stopwatchDisplay.textContent = '0.0s';
    btnStopwatchToggle.textContent = 'Start timer';
  }

  function openEntry(leg, session, holdNo) {
    entryLeg = leg;
    entrySession = session;
    entryLegLabel.textContent = `Session ${session} · ${legLabel(leg)} leg · Hold ${holdNo}`;
    entryOverlay.classList.remove('entry-overlay--left', 'entry-overlay--right');
    entryOverlay.classList.add(`entry-overlay--${leg}`);
    entryInput.value = '';
    entryInput.classList.remove('is-invalid');
    resetStopwatch();
    entryOverlay.hidden = false;
    entryInput.focus();
  }

  function closeEntry() {
    resetStopwatch();
    entryOverlay.hidden = true;
  }

  function saveEntry() {
    const val = parseFloat(entryInput.value);
    if (!isFinite(val) || val <= 0) {
      entryInput.classList.add('is-invalid');
      entryInput.focus();
      return;
    }

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      leg: entryLeg,
      session: entrySession,
      duration: Math.round(val * 10) / 10,
      ts: new Date().toISOString(),
    };
    entries.push(entry);
    saveEntries(entries);

    lastSavedEl.hidden = false;
    lastSavedEl.textContent = `Saved: Session ${entry.session} · ${legLabel(entry.leg)} leg — ${entry.duration.toFixed(1)}s`;

    closeEntry();
    renderAll();
    backupHold(entry);
  }

  btnStopwatchToggle.addEventListener('click', () => (swPhase === 'idle' ? startStopwatch() : stopStopwatch(true)));
  btnStopwatchReset.addEventListener('click', resetStopwatch);
  btnSave.addEventListener('click', saveEntry);
  btnEntryCancel.addEventListener('click', closeEntry);
  entryInput.addEventListener('input', () => {
    entryInput.classList.remove('is-invalid');
    stopStopwatch(false);
  });

  // ---------- delete ----------
  function deleteEntry(id) {
    const e = entries.find(x => x.id === id);
    if (!e) return;
    if (!confirm(`Delete ${legLabel(e.leg)} leg hold of ${e.duration.toFixed(1)}s?`)) return;
    entries = entries.filter(x => x.id !== id);
    saveEntries(entries);
    renderAll();
    backupDelete(id);
  }

  // ---------- session cards ----------
  // One card per session; each leg gets a row of hold slots (3 by default).
  // Filled slots tap-to-delete; the first empty slot (when editable) logs a hold.
  function sessionsHtml(dayEntries, editable) {
    const sessionNums = editable
      ? Array.from({ length: SESSIONS_PER_DAY }, (_, i) => i + 1)
      : [...new Set(dayEntries.map(e => e.session))].sort((a, b) => a - b);

    return sessionNums.map(n => {
      const inSession = dayEntries.filter(e => e.session === n);
      const legRows = ['left', 'right'].map(leg => {
        const holds = inSession.filter(e => e.leg === leg);
        const slotCount = Math.max(HOLDS_PER_LEG, holds.length);
        const slots = [];
        for (let i = 0; i < slotCount; i++) {
          const h = holds[i];
          if (h) {
            slots.push(`<button type="button" class="slot slot--filled slot--${leg}" data-delete="${h.id}" aria-label="Delete ${legLabel(leg)} hold ${i + 1}">${h.duration.toFixed(1)}s</button>`);
          } else if (editable) {
            const isNext = i === holds.length;
            slots.push(`<button type="button" class="slot slot--empty slot--${leg}${isNext ? ' slot--next' : ''}" ${isNext ? `data-log-leg="${leg}" data-log-session="${n}" data-log-hold="${i + 1}"` : 'disabled'} aria-label="Log ${legLabel(leg)} hold ${i + 1}">${isNext ? '+' : ''}</button>`);
          }
        }
        return `<div class="session-leg"><span class="session-leg__name session-leg__name--${leg}">${legLabel(leg)}</span><div class="slots">${slots.join('')}</div></div>`;
      }).join('');

      const done = inSession.length;
      const total = HOLDS_PER_LEG * 2;
      return `
        <div class="session-card${editable && done >= total ? ' session-card--done' : ''}">
          <div class="session-card__head">
            <span class="session-card__title">Session ${n}</span>
            <span class="session-card__count">${done}/${total}</span>
          </div>
          ${legRows}
        </div>`;
    }).join('');
  }

  function attachSessionHandlers(root) {
    root.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteEntry(btn.getAttribute('data-delete')));
    });
    root.querySelectorAll('[data-log-leg]').forEach(btn => {
      btn.addEventListener('click', () =>
        openEntry(btn.dataset.logLeg, Number(btn.dataset.logSession), Number(btn.dataset.logHold)));
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
    const target = SESSIONS_PER_DAY * HOLDS_PER_LEG;

    todaySummaryEl.innerHTML = `
      <div class="stat stat--left">
        <div class="stat__label">Left</div>
        <div class="stat__value">${left.length}/${target}</div>
        <div class="stat__sub">${leftAvg ? `avg ${leftAvg.toFixed(1)}s` : 'no holds yet'}</div>
      </div>
      <div class="stat stat--right">
        <div class="stat__label">Right</div>
        <div class="stat__value">${right.length}/${target}</div>
        <div class="stat__sub">${rightAvg ? `avg ${rightAvg.toFixed(1)}s` : 'no holds yet'}</div>
      </div>`;

    todaySessionsEl.innerHTML = sessionsHtml(todays, true);
    attachSessionHandlers(todaySessionsEl);
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
      .map(key => `
        <div class="history-day">
          <div class="history-day__heading">${formatDayLabel(key)}</div>
          ${sessionsHtml(byDay.get(key), false)}
        </div>`)
      .join('');

    attachSessionHandlers(historyDaysEl);
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
    backup: document.getElementById('view-backup'),
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
    if (confirm('Delete all logged holds, including your NOSTR backup? This cannot be undone.')) {
      const ids = entries.map(e => e.id);
      entries = [];
      saveEntries(entries);
      renderAll();
      ids.forEach(backupDelete);
    }
  });

  // ---------- NOSTR backup ----------
  // Every hold is published as an encrypted event when saved. On load we pull
  // the backup and merge it in, then push anything the relays don't have yet.
  const PENDING_DELETES_KEY = 'calfHoldPendingDeletes';
  const syncDot = document.getElementById('sync-dot');
  const syncLabel = document.getElementById('sync-label');
  const syncDetail = document.getElementById('sync-detail');
  const keyDisplay = document.getElementById('key-display');
  const importKeyInput = document.getElementById('import-key-input');

  const remote = new Map(); // id -> { createdAt, deleted } newest event seen per hold

  function setSyncStatus(state, text, detail) {
    syncDot.className = `sync-dot ${state}`;
    syncLabel.textContent = text;
    if (detail !== undefined) syncDetail.textContent = detail;
  }

  function loadPendingDeletes() {
    try { return JSON.parse(localStorage.getItem(PENDING_DELETES_KEY)) || []; } catch { return []; }
  }

  function savePendingDeletes(ids) {
    localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(ids));
  }

  function backupHold(entry) {
    setSyncStatus('', 'Backing up…');
    publishHold(entry)
      .then(() => { remote.set(entry.id, { createdAt: Math.floor(Date.now() / 1000), deleted: false }); setSyncStatus('ok', 'Backed up'); })
      .catch(() => setSyncStatus('error', 'Backup pending', 'Will retry next time the app opens online.'));
  }

  function backupDelete(id) {
    savePendingDeletes([...new Set([...loadPendingDeletes(), id])]);
    tombstoneHold(id)
      .then(() => savePendingDeletes(loadPendingDeletes().filter(x => x !== id)))
      .catch(() => {});
  }

  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderAll, 60);
  }

  function validHold(h) {
    return h && (h.leg === 'left' || h.leg === 'right')
      && Number.isInteger(h.session) && h.session >= 1
      && isFinite(h.duration) && h.duration > 0
      && typeof h.ts === 'string' && !isNaN(new Date(h.ts));
  }

  function onRemoteEvent({ id, createdAt, deleted, hold }) {
    const prev = remote.get(id);
    if (prev && prev.createdAt >= createdAt) return;
    remote.set(id, { createdAt, deleted });

    if (deleted) {
      if (entries.some(e => e.id === id)) {
        entries = entries.filter(e => e.id !== id);
        saveEntries(entries);
        scheduleRender();
      }
      return;
    }
    if (entries.some(e => e.id === id) || loadPendingDeletes().includes(id) || !validHold(hold)) return;

    entries.push({ id, leg: hold.leg, session: hold.session, duration: hold.duration, ts: hold.ts });
    entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    saveEntries(entries);
    scheduleRender();
  }

  async function pushMissing() {
    for (const id of loadPendingDeletes()) {
      try { await tombstoneHold(id); savePendingDeletes(loadPendingDeletes().filter(x => x !== id)); } catch { /* retry next load */ }
    }
    const missing = entries.filter(e => !remote.has(e.id));
    let failed = 0;
    for (const e of missing) {
      try { await publishHold(e); remote.set(e.id, { createdAt: Math.floor(Date.now() / 1000), deleted: false }); } catch { failed++; }
    }
    return { pushed: missing.length - failed, failed };
  }

  async function onEose() {
    const { pushed, failed } = await pushMissing();
    const detail = `${entries.length} hold${entries.length === 1 ? '' : 's'} stored locally and on relays.`
      + (pushed ? ` Pushed ${pushed} new.` : '');
    setSyncStatus(failed ? 'error' : 'ok', failed ? `${failed} not backed up` : 'Backed up', detail);
  }

  function startSync() {
    remote.clear();
    setSyncStatus('', 'Connecting…', '');
    try {
      connect(onRemoteEvent, onEose);
    } catch (e) {
      setSyncStatus('error', 'Offline');
      console.warn('NOSTR connect failed:', e);
    }
  }

  function applyImportedKey(nsec) {
    if (importNsec(nsec)) {
      setSyncStatus('ok', 'Key imported — reloading…');
      setTimeout(() => location.reload(), 600);
    } else {
      importKeyInput.classList.add('is-invalid');
    }
  }

  document.getElementById('copy-key-btn').addEventListener('click', async e => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(getNsec());
      btn.textContent = 'Copied!';
    } catch {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => { btn.textContent = 'Copy key'; }, 2000);
  });

  document.getElementById('import-key-btn').addEventListener('click', () => {
    const val = importKeyInput.value.trim();
    if (val) applyImportedKey(val);
  });
  importKeyInput.addEventListener('input', () => importKeyInput.classList.remove('is-invalid'));

  document.getElementById('refetch-btn').addEventListener('click', () => {
    disconnect();
    startSync();
  });

  document.getElementById('push-all-btn').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Pushing…';
    remote.clear(); // forget what we think the relays have, so everything is re-sent
    let ok = 0, fail = 0;
    for (const entry of entries) {
      try { await publishHold(entry); remote.set(entry.id, { createdAt: Math.floor(Date.now() / 1000), deleted: false }); ok++; } catch { fail++; }
    }
    btn.disabled = false;
    btn.textContent = fail ? `Done (${ok} pushed, ${fail} failed)` : `Done — ${ok} pushed`;
    setTimeout(() => { btn.textContent = 'Push everything now'; }, 3000);
  });

  // ---------- service worker ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  initKey();
  keyDisplay.textContent = getNsec();
  renderAll();
  startSync();
})();
