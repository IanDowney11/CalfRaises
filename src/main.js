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

  // Two timed sessions a day; each is one to-failure set for both legs together, then left, then right.
  const LEGS = ['both', 'left', 'right'];
  const SESSIONS_PER_DAY = 2;
  const HOLDS_PER_LEG = 1;
  // Old data was 3 holds per leg per session; only used to place pre-session entries.
  const LEGACY_HOLDS_PER_LEG = 3;

  // Untimed strength work, every other day: 3 sets of 15 single-leg raises.
  // Stored in the same list (and NOSTR backup) as holds, flagged kind: 'strength'.
  const STRENGTH_SETS = 3;
  const STRENGTH_REPS = 15;
  const STRENGTH_INTERVAL_DAYS = 2;

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
    return { both: 'Both', left: 'Left', right: 'Right' }[leg];
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
      if (e.session || e.kind === 'strength') return;
      const k = `${dateKey(e.ts)}|${e.leg}`;
      const n = counters.get(k) || 0;
      counters.set(k, n + 1);
      e.session = Math.min(SESSIONS_PER_DAY, Math.floor(n / LEGACY_HOLDS_PER_LEG) + 1);
      changed = true;
    });
    if (changed) saveEntries(list);
    return list;
  }

  entries = migrateEntries(loadEntries());

  const isStrength = e => e.kind === 'strength';
  // Timed holds only; every stat, chart and session card works off this.
  const holds = () => entries.filter(e => !isStrength(e));

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

  // ---------- metronome ----------
  // Clicks via Web Audio, scheduled slightly ahead so the beat stays steady even
  // if the main thread stutters. Runs while the timer is running.
  let entryLeg = null; // which set is open; picks the metronome pace
  const METRONOME_KEY = 'calfMetronome';
  const metronomeSettings = (() => {
    // Both-leg sets are paced faster than single-leg sets.
    const defaults = { both: 120, single: 100, on: true };
    const okBpm = v => Number.isInteger(v) && v >= 20 && v <= 200;
    try {
      const s = JSON.parse(localStorage.getItem(METRONOME_KEY)) || {};
      return {
        both: okBpm(s.both) ? s.both : defaults.both,
        single: okBpm(s.single) ? s.single : defaults.single,
        on: typeof s.on === 'boolean' ? s.on : defaults.on,
      };
    } catch {
      return defaults;
    }
  })();

  const bpmValueEl = document.getElementById('bpm-value');
  const metronomeOnEl = document.getElementById('metronome-on');
  const beatDotEl = document.getElementById('beat-dot');

  function saveMetronome() {
    localStorage.setItem(METRONOME_KEY, JSON.stringify(metronomeSettings));
  }

  // The pace follows whichever set is open: both-leg or single-leg.
  const bpmKey = () => (entryLeg === 'both' ? 'both' : 'single');
  const currentBpm = () => metronomeSettings[bpmKey()];

  function renderMetronomeSettings() {
    bpmValueEl.textContent = currentBpm();
    metronomeOnEl.checked = metronomeSettings.on;
  }

  function setBpm(bpm) {
    metronomeSettings[bpmKey()] = Math.min(200, Math.max(20, bpm));
    saveMetronome();
    renderMetronomeSettings();
  }

  document.getElementById('bpm-down').addEventListener('click', () => setBpm(currentBpm() - 2));
  document.getElementById('bpm-up').addEventListener('click', () => setBpm(currentBpm() + 2));
  metronomeOnEl.addEventListener('change', () => {
    metronomeSettings.on = metronomeOnEl.checked;
    saveMetronome();
  });

  const metronome = (() => {
    const LOOKAHEAD_S = 0.12;
    let ctx = null;
    let timer = null;
    let nextBeat = 0;

    function click(when) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 1000;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.6, when + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      osc.connect(gain).connect(ctx.destination);
      osc.start(when);
      osc.stop(when + 0.06);
      // Flash the dot in time with the click.
      setTimeout(() => {
        beatDotEl.classList.add('is-beat');
        setTimeout(() => beatDotEl.classList.remove('is-beat'), 90);
      }, Math.max(0, (when - ctx.currentTime) * 1000));
    }

    function schedule() {
      while (nextBeat < ctx.currentTime + LOOKAHEAD_S) {
        click(nextBeat);
        nextBeat += 60 / currentBpm();
      }
    }

    return {
      // Create/resume the audio context inside a user gesture (Start tap) so mobile allows sound.
      prime() {
        if (!metronomeSettings.on) return;
        try {
          ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
          if (ctx.state === 'suspended') ctx.resume();
        } catch { ctx = null; }
      },
      start() {
        if (!metronomeSettings.on || !ctx || timer) return;
        nextBeat = ctx.currentTime + 0.05;
        schedule();
        timer = setInterval(schedule, 25);
      },
      stop() {
        clearInterval(timer);
        timer = null;
      },
    };
  })();

  // ---------- entry form + helper stopwatch ----------
  // The stopwatch is purely an optional aid: while running it live-fills the
  // duration field, but the field stays freely editable and nothing is saved
  // until the user taps Save.
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

  // Big centred number during the get-ready countdown (replaces the duration box).
  const countdownBigEl = document.getElementById('countdown-big');
  function setCounting(on) {
    entryOverlay.classList.toggle('entry-overlay--counting', on);
  }

  function beginRunning(startAt) {
    setCounting(false);
    swPhase = 'running';
    swSegmentStart = startAt;
    btnStopwatchToggle.textContent = 'Stop timer';
    metronome.start();
  }

  function swTick() {
    if (swPhase === 'countdown') {
      const remainingMs = swCountdownEnd - Date.now();
      if (remainingMs <= 0) {
        beginRunning(swCountdownEnd);
      } else {
        const n = Math.ceil(remainingMs / 1000);
        countdownBigEl.textContent = n;
        stopwatchDisplay.textContent = 'Get ready';
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
    metronome.prime();
    if (timerSettings.delay > 0) {
      swPhase = 'countdown';
      entryInput.blur();
      setCounting(true);
      swCountdownEnd = Date.now() + timerSettings.delay * 1000;
      btnStopwatchToggle.textContent = 'Cancel';
      metronome.start(); // beat starts with the countdown so you can settle into the pace
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
    setCounting(false);
    clearTimeout(swRaf);
    metronome.stop();
    releaseWakeLock();
    btnStopwatchToggle.textContent = 'Start timer';
  }

  function resetStopwatch() {
    swPhase = 'idle';
    setCounting(false);
    swAccumulatedMs = 0;
    swSegmentStart = null;
    swCountdownEnd = null;
    clearTimeout(swRaf);
    metronome.stop();
    releaseWakeLock();
    stopwatchDisplay.textContent = '0.0s';
    btnStopwatchToggle.textContent = 'Start timer';
  }

  function openEntry(leg, session) {
    entryLeg = leg;
    renderMetronomeSettings();
    entrySession = session;
    entryLegLabel.textContent = `Session ${session} · ${leg === "both" ? "Both legs" : legLabel(leg) + " leg"}`;
    entryOverlay.classList.remove('entry-overlay--both', 'entry-overlay--left', 'entry-overlay--right');
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
    lastSavedEl.textContent = `Saved: Session ${entry.session} · ${entry.leg === "both" ? "Both legs" : legLabel(entry.leg) + " leg"} — ${entry.duration.toFixed(1)}s`;

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
    const what = isStrength(e) ? "strength day" : `${legLabel(e.leg)} leg hold of ${e.duration.toFixed(1)}s`;
    if (!confirm(`Delete ${what}?`)) return;
    entries = entries.filter(x => x.id !== id);
    saveEntries(entries);
    renderAll();
    backupDelete(id);
  }

  // ---------- session cards ----------
  // One card per session; each leg gets a row of hold slots (1 by default).
  // Filled slots tap-to-delete; the first empty slot (when editable) logs a hold.
  function sessionsHtml(dayEntries, editable) {
    const sessionNums = editable
      ? Array.from({ length: SESSIONS_PER_DAY }, (_, i) => i + 1)
      : [...new Set(dayEntries.map(e => e.session))].sort((a, b) => a - b);

    return sessionNums.map(n => {
      const inSession = dayEntries.filter(e => e.session === n);
      const legRows = LEGS.map(leg => {
        const holds = inSession.filter(e => e.leg === leg);
        const slotCount = Math.max(HOLDS_PER_LEG, holds.length);
        const slots = [];
        for (let i = 0; i < slotCount; i++) {
          const h = holds[i];
          if (h) {
            slots.push(`<button type="button" class="slot slot--filled slot--${leg}" data-delete="${h.id}" aria-label="Delete ${legLabel(leg)} hold">${h.duration.toFixed(1)}s</button>`);
          } else if (editable) {
            const isNext = i === holds.length;
            slots.push(`<button type="button" class="slot slot--empty slot--${leg}${isNext ? ' slot--next' : ''}" ${isNext ? `data-log-leg="${leg}" data-log-session="${n}"` : 'disabled'} aria-label="Log ${legLabel(leg)} hold">${isNext ? '+' : ''}</button>`);
          }
        }
        return `<div class="session-leg"><span class="session-leg__name session-leg__name--${leg}">${legLabel(leg)}</span><div class="slots">${slots.join('')}</div></div>`;
      }).join('');

      const done = inSession.length;
      const total = HOLDS_PER_LEG * LEGS.length;
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

  // ---------- strength card ----------
  function addDays(key, n) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  // Strength is due again STRENGTH_INTERVAL_DAYS after the last day it was logged
  // (and stays "due" for the rest of a day it was started on).
  function strengthStatus(todayKey) {
    const days = [...new Set(entries.filter(isStrength).map(e => dateKey(e.ts)))].sort();
    if (!days.length) return { due: true, text: 'Strength day' };
    const last = days[days.length - 1];
    if (last === todayKey) return { due: true, text: 'Strength day' };
    const next = addDays(last, STRENGTH_INTERVAL_DAYS);
    if (next <= todayKey) return { due: true, text: 'Strength day' };
    return { due: false, text: `Rest day · next strength ${formatDayLabel(next)}` };
  }

  // One tick per strength day. The card only appears on a due day (or once done
  // today, so it can be undone); tap to tick, tap the tick to undo.
  function strengthHtml(dayEntries, editable, todayKey) {
    const done = dayEntries.filter(isStrength);
    if (!editable) {
      return done.length ? `
      <div class="session-card session-card--done">
        <div class="session-card__head"><span class="session-card__title">Strength</span><span class="session-card__count">done</span></div>
      </div>` : '';
    }
    if (!done.length && !strengthStatus(todayKey).due) return '';
    const button = done.length
      ? `<button type="button" class="slot slot--filled slot--strength" data-delete="${done[0].id}" aria-label="Undo strength">✓ Done</button>`
      : `<button type="button" class="slot slot--empty slot--strength slot--next" data-log-strength="1" aria-label="Mark strength done">Mark done</button>`;
    return `
      <div class="session-card${done.length ? ' session-card--done' : ''}">
        <div class="session-card__head">
          <span class="session-card__title">Strength day</span>
        </div>
        <p class="strength-note">${STRENGTH_SETS} sets of ${STRENGTH_REPS} single-leg raises</p>
        <div class="slots">${button}</div>
      </div>`;
  }

  function logStrengthSet(setNo) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'strength',
      set: setNo,
      ts: new Date().toISOString(),
    };
    entries.push(entry);
    saveEntries(entries);
    renderAll();
    backupHold(entry);
  }

  function attachSessionHandlers(root) {
    root.querySelectorAll('[data-log-strength]').forEach(btn => {
      btn.addEventListener('click', () => logStrengthSet(Number(btn.dataset.logStrength)));
    });
    root.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteEntry(btn.getAttribute('data-delete')));
    });
    root.querySelectorAll('[data-log-leg]').forEach(btn => {
      btn.addEventListener('click', () =>
        openEntry(btn.dataset.logLeg, Number(btn.dataset.logSession)));
    });
  }

  // ---------- today summary ----------
  function renderTodaySummary() {
    const todayKey = dateKey(new Date().toISOString());
    const todays = entries.filter(e => dateKey(e.ts) === todayKey);
    const both = todays.filter(e => e.leg === 'both');
    const left = todays.filter(e => e.leg === 'left');
    const right = todays.filter(e => e.leg === 'right');
    const bothAvg = average(both.map(e => e.duration));
    const leftAvg = average(left.map(e => e.duration));
    const rightAvg = average(right.map(e => e.duration));
    const target = SESSIONS_PER_DAY * HOLDS_PER_LEG;

    todaySummaryEl.innerHTML = `
      <div class="stat stat--both">
        <div class="stat__label">Both</div>
        <div class="stat__value">${both.length}/${target}</div>
        <div class="stat__sub">${bothAvg ? `avg ${bothAvg.toFixed(1)}s` : 'no holds yet'}</div>
      </div>
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

    todaySessionsEl.innerHTML = sessionsHtml(todays, true) + strengthHtml(todays, true, todayKey);
    attachSessionHandlers(todaySessionsEl);
  }

  // ---------- history list ----------
  function renderHistoryDays() {
    if (entries.length === 0) {
      historyDaysEl.innerHTML = `<p class="empty-note">Nothing logged yet. Start on the Log tab.</p>`;
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
          ${sessionsHtml(byDay.get(key), false)}${strengthHtml(byDay.get(key), false)}
        </div>`)
      .join('');

    attachSessionHandlers(historyDaysEl);
  }

  // ---------- progress stats ----------
  // "Increase" compares the first logged day's average with the latest day's,
  // so it needs at least two days with holds for that leg.
  function legTrend(leg) {
    const byDay = new Map();
    holds().filter(e => e.leg === leg).forEach(e => {
      const k = dateKey(e.ts);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e.duration);
    });
    const keys = [...byDay.keys()].sort();
    if (keys.length < 2) return null;
    const first = average(byDay.get(keys[0]));
    const last = average(byDay.get(keys[keys.length - 1]));
    return { delta: last - first, pct: (last - first) / first * 100 };
  }

  function formatDelta(t) {
    if (!t) return { value: '–', sub: 'needs 2+ days' };
    const sign = t.delta > 0 ? '+' : t.delta < 0 ? '−' : '';
    return {
      value: `${sign}${Math.abs(t.delta).toFixed(1)}s`,
      sub: `${sign}${Math.abs(t.pct).toFixed(0)}% since first day`,
    };
  }

  // Per-day signed gap (left avg − right avg) for days with both legs logged.
  function dailyGaps() {
    const byDay = new Map();
    holds().forEach(e => {
      const k = dateKey(e.ts);
      if (!byDay.has(k)) byDay.set(k, { both: [], left: [], right: [] });
      byDay.get(k)[e.leg].push(e.duration);
    });
    return [...byDay.keys()].sort()
      .filter(k => byDay.get(k).left.length && byDay.get(k).right.length)
      .map(k => {
        const signed = average(byDay.get(k).left) - average(byDay.get(k).right);
        return { key: k, signed, gap: Math.abs(signed) };
      });
  }

  function renderProgressStats() {
    const el = document.getElementById('progress-stats');
    const avgOf = leg => average(holds().filter(e => e.leg === leg).map(e => e.duration));
    const bothAvg = avgOf('both');
    const leftAvg = avgOf('left');
    const rightAvg = avgOf('right');

    const groups = new Map();
    holds().forEach(e => {
      const k = `${dateKey(e.ts)}|${e.session}`;
      groups.set(k, (groups.get(k) || 0) + 1);
    });
    const completed = [...groups.values()].filter(n => n >= HOLDS_PER_LEG * LEGS.length).length;

    // Latest day's gap, so it matches the end of the gap chart.
    let diffValue = '–', diffSub = 'needs both legs';
    const gaps = dailyGaps();
    if (gaps.length) {
      const latest = gaps[gaps.length - 1];
      const stronger = latest.gap < 0.05 ? 'legs are even' : `${latest.signed > 0 ? 'Left' : 'Right'} stronger`;
      diffValue = `${latest.gap.toFixed(1)}s`;
      diffSub = gaps.length > 1 ? `${stronger} · was ${gaps[0].gap.toFixed(1)}s` : stronger;
    }

    const bt = formatDelta(legTrend('both'));
    const lt = formatDelta(legTrend('left'));
    const rt = formatDelta(legTrend('right'));
    const tile = (cls, label, value, sub) =>
      `<div class="stat ${cls}"><div class="stat__label">${label}</div><div class="stat__value">${value}</div><div class="stat__sub">${sub}</div></div>`;

    el.innerHTML =
      tile('stat--both', 'Both average', bothAvg === null ? '–' : `${bothAvg.toFixed(1)}s`, 'all holds') +
      tile('stat--both', 'Both increase', bt.value, bt.sub) +
      tile('stat--left', 'Left average', leftAvg === null ? '–' : `${leftAvg.toFixed(1)}s`, 'all holds') +
      tile('stat--right', 'Right average', rightAvg === null ? '–' : `${rightAvg.toFixed(1)}s`, 'all holds') +
      tile('stat--left', 'Left increase', lt.value, lt.sub) +
      tile('stat--right', 'Right increase', rt.value, rt.sub) +
      tile('', 'Latest leg gap', diffValue, diffSub) +
      tile('', 'Sessions done', completed, `of ${groups.size} started`);
  }

  // ---------- chart ----------
  const SERIES_COLOR = { both: 'var(--series-both)', left: 'var(--series-left)', right: 'var(--series-right)' };

  function buildChart() {
    if (holds().length === 0) {
      chartCardEl.innerHTML = `<p class="empty-note">Log a few timed sessions to see your progress chart here.</p>`;
      return;
    }

    const byDay = new Map();
    holds().forEach(e => {
      const key = dateKey(e.ts);
      if (!byDay.has(key)) byDay.set(key, { both: [], left: [], right: [] });
      byDay.get(key)[e.leg].push(e.duration);
    });

    const days = [...byDay.keys()].sort();
    const bothSeries = days.map(k => average(byDay.get(k).both));
    const leftSeries = days.map(k => average(byDay.get(k).left));
    const rightSeries = days.map(k => average(byDay.get(k).right));

    const allVals = [...bothSeries, ...leftSeries, ...rightSeries].filter(v => v !== null);
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
          <path d="${seriesPath(bothSeries)}" fill="none" stroke="var(--series-both)" stroke-width="2" stroke-linecap="round"></path>
          <path d="${seriesPath(leftSeries)}" fill="none" stroke="var(--series-left)" stroke-width="2" stroke-linecap="round"></path>
          <path d="${seriesPath(rightSeries)}" fill="none" stroke="var(--series-right)" stroke-width="2" stroke-linecap="round"></path>
          ${markers(bothSeries, 'both')}
          ${markers(leftSeries, 'left')}
          ${markers(rightSeries, 'right')}
          ${xLabels}
        </svg>
        <div class="chart-tooltip" id="chart-tooltip"></div>
      </div>
      <div class="chart-legend">
        <span class="chart-legend__item"><span class="chart-legend__swatch" style="background:var(--series-both)"></span>Both legs</span>
        <span class="chart-legend__item"><span class="chart-legend__swatch" style="background:var(--series-left)"></span>Left leg</span>
        <span class="chart-legend__item"><span class="chart-legend__swatch" style="background:var(--series-right)"></span>Right leg</span>
      </div>`;

    attachChartHover(days, bothSeries, leftSeries, rightSeries, { W, H, padL, padR, xAt });
  }

  // Daily gap between leg averages (absolute), for days with both legs logged.
  function buildGapChart() {
    const el = document.getElementById('gap-card');
    const pts = dailyGaps();

    if (pts.length < 2) {
      el.innerHTML = `<p class="empty-note">Log both legs on at least two days to see whether the gap is closing.</p>`;
      return;
    }

    const first = pts[0].gap, last = pts[pts.length - 1].gap;
    const change = last - first;
    const summary = Math.abs(change) < 0.05
      ? `Gap is steady at ${last.toFixed(1)}s`
      : `Gap has ${change < 0 ? 'narrowed' : 'widened'} from ${first.toFixed(1)}s to ${last.toFixed(1)}s`;

    const W = 300, H = 160, padL = 28, padR = 10, padT = 14, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxVal = Math.max(...pts.map(p => p.gap)) * 1.15 || 1;
    const xAt = i => padL + (i * plotW) / (pts.length - 1);
    const yAt = v => padT + plotH - (v / maxVal) * plotH;

    const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${xAt(i).toFixed(1)} ${yAt(p.gap).toFixed(1)}`).join(' ');
    const dots = pts.map((p, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.gap).toFixed(1)}" r="4" fill="var(--text-secondary)"><title>${formatDayLabel(p.key)}: ${p.gap.toFixed(1)}s</title></circle>`).join('');
    const grid = [0.5, 1].map(f => {
      const y = padT + plotH * (1 - f);
      return `<line x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--gridline)" stroke-width="1"></line>`;
    }).join('');
    const step = Math.max(1, Math.ceil(pts.length / 6));
    const labels = pts.map((p, i) => (i % step === 0 || i === pts.length - 1)
      ? `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" font-size="9" fill="var(--text-muted)" text-anchor="middle">${formatDayLabel(p.key).replace('Today', 'Tdy')}</text>` : '').join('');
    const yTop = `<text x="${padL - 4}" y="${padT + 3}" font-size="9" fill="var(--text-muted)" text-anchor="end">${maxVal.toFixed(0)}s</text>`;

    el.innerHTML = `
      <p class="gap-summary">${summary}</p>
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
        ${grid}
        <line x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="var(--baseline)" stroke-width="1"></line>
        <path d="${path}" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round"></path>
        ${dots}${yTop}${labels}
      </svg>`;
  }

  function attachChartHover(days, bothSeries, leftSeries, rightSeries, geom) {
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
      const b = bothSeries[i], l = leftSeries[i], r = rightSeries[i];
      const parts = [formatDayLabel(days[i])];
      if (b !== null) parts.push(`Both ${b.toFixed(1)}s`);
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

  // ---------- strength progress ----------
  // Tiles for totals and consistency, plus a strip of the last 14 days (filled = done).
  function renderStrengthProgress() {
    const el = document.getElementById('strength-card');
    const doneDays = new Set(entries.filter(isStrength).map(e => dateKey(e.ts)));
    const todayKey = dateKey(new Date().toISOString());

    const strip = [];
    let recent = 0;
    for (let i = 13; i >= 0; i--) {
      const key = addDays(todayKey, -i);
      const done = doneDays.has(key);
      if (done) recent++;
      strip.push(`<span class="day-dot${done ? ' day-dot--done' : ''}${i === 0 ? ' day-dot--today' : ''}" title="${formatDayLabel(key)}"></span>`);
    }

    const sorted = [...doneDays].sort();
    const last = sorted[sorted.length - 1];
    const possible = Math.ceil(14 / STRENGTH_INTERVAL_DAYS);
    const status = strengthStatus(todayKey);
    const next = last ? addDays(last, STRENGTH_INTERVAL_DAYS) : todayKey;
    const tile = (label, value, sub) =>
      `<div class="stat"><div class="stat__label">${label}</div><div class="stat__value">${value}</div><div class="stat__sub">${sub}</div></div>`;

    el.innerHTML = `
      <div class="progress-stats progress-stats--inner">
        ${tile('Days done', doneDays.size, 'in total')}
        ${tile('Last 14 days', `${recent}/${possible}`, 'goal: every other day')}
        ${tile('Last done', last ? formatDayLabel(last) : '–', last ? '' : 'none yet')}
        ${tile('Next due', status.due ? 'Today' : formatDayLabel(next), status.due ? 'not done yet' : 'rest day until then')}
      </div>
      <div class="day-strip" aria-label="Strength days, last 14">${strip.join('')}</div>
      <p class="hint day-strip__caption">Last 14 days · filled = strength done</p>`;
  }

  // ---------- render all ----------
  function renderAll() {
    renderStrengthProgress();
    renderTodaySummary();
    renderHistoryDays();
    renderProgressStats();
    buildChart();
    buildGapChart();
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
    if (confirm('Delete everything you have logged, including your NOSTR backup? This cannot be undone.')) {
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
    if (h && h.kind === 'strength') {
      return Number.isInteger(h.set) && h.set >= 1 && typeof h.ts === 'string' && !isNaN(new Date(h.ts));
    }
    return h && (h.leg === 'both' || h.leg === 'left' || h.leg === 'right')
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

    entries.push(hold.kind === 'strength'
      ? { id, kind: 'strength', set: hold.set, ts: hold.ts }
      : { id, leg: hold.leg, session: hold.session, duration: hold.duration, ts: hold.ts });
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
    const detail = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} stored locally and on relays.`
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
