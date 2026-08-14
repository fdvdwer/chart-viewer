/* ============================================================================
 * event_log.js — Real-time structural-event log panel
 * ============================================================================
 * Right-side panel that streams BOS / CHoCh / supply-demand-zone state
 * changes as they happen during replay (or backfills from current chart
 * state when opened in normal mode).
 *
 * Data sources (all polled from indicator public APIs):
 *   - window.BOSChoChDetector.getEventsForChart()  → BOS / CHoCh events
 *   - window.SupplyDemandZones.getZonesForChart()  → zone state transitions
 *
 * Update mechanism:
 *   - On replay tick / step-back: Replay calls EventLog.onReplayTick() →
 *     polls current state, diffs against last-seen, appends new entries.
 *   - On panel open: backfills the full event/zone history visible in
 *     the current chart so the log isn't empty.
 *   - On symbol switch: clears the log (different symbol = different
 *     event stream).
 *
 * APPEND-ONLY semantics: even if the user steps back past an event, the
 * log entry stays. The chart UI shows current-cursor state; the log
 * shows the chronological PATH the cursor took. User can clear manually
 * via the 🗑 button.
 * ========================================================================== */

(function () {
  const EL = {
    el: null,             // panel root (#event-log-panel)
    bodyEl: null,         // scrollable entries list
    toggleBtnEl: null,    // toolbar toggle button
    open: false,
    _wired: false,

    entries: [],          // log entries, oldest first
    seenEventIds: new Set(),    // dedupe BOS/CHoCh by event.id
    seenZoneStatus: new Map(),  // zone.id → last seen status, dedupe transitions

    filter: {
      bos:    true,
      choch:  true,
      zone:   true,
    },
    autoScroll: true,     // stick to bottom when new entries arrive (unless user scrolled up)
  };

  function _t(key, fallback) {
    return (window.I18n && window.I18n.t)
      ? (window.I18n.t(key) || fallback)
      : fallback;
  }

  // ---- DOM build ----
  function _ensurePanel() {
    if (EL.el) return EL.el;
    // The panel is created in index.html. Locate it here.
    EL.el = document.getElementById('event-log-panel');
    if (!EL.el) {
      console.warn('[EventLog] #event-log-panel not in DOM — was index.html updated?');
      return null;
    }
    EL.bodyEl = EL.el.querySelector('.event-log-body');
    return EL.el;
  }

  // ---- Wire / init ----
  function init() {
    if (EL._wired) return;
    _ensurePanel();
    if (!EL.el) return;
    EL._wired = true;

    // Close button
    const closeBtn = EL.el.querySelector('.event-log-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    // Clear button
    const clearBtn = EL.el.querySelector('.event-log-clear');
    if (clearBtn) clearBtn.addEventListener('click', clear);

    // Filter checkboxes
    EL.el.querySelectorAll('.event-log-filter input').forEach(cb => {
      cb.addEventListener('change', () => {
        const key = cb.dataset.filter;
        EL.filter[key] = cb.checked;
        _render();
      });
    });

    // Toolbar toggle button
    EL.toggleBtnEl = document.getElementById('btn-event-log');
    if (EL.toggleBtnEl) {
      EL.toggleBtnEl.addEventListener('click', toggle);
    }

    // Auto-scroll detection: if user scrolls up, suspend auto-scroll;
    // when they reach the bottom again, resume.
    if (EL.bodyEl) {
      EL.bodyEl.addEventListener('scroll', () => {
        const nearBottom = EL.bodyEl.scrollTop + EL.bodyEl.clientHeight >= EL.bodyEl.scrollHeight - 8;
        EL.autoScroll = nearBottom;
      });
    }

    // Symbol switch → clear log (events from old symbol irrelevant)
    window.addEventListener('app:symbolChanged', clear);
  }

  function toggle() {
    if (EL.open) close();
    else open();
  }

  function open() {
    if (!_ensurePanel()) return;
    EL.open = true;
    EL.el.classList.remove('hidden');
    if (EL.toggleBtnEl) EL.toggleBtnEl.classList.add('active');
    // Backfill from current indicator state. The log might be empty (first
    // open) or stale (user had it closed, time moved on). Re-poll.
    onReplayTick();
    _scrollToBottom();
  }

  function close() {
    if (!_ensurePanel()) return;
    EL.open = false;
    EL.el.classList.add('hidden');
    if (EL.toggleBtnEl) EL.toggleBtnEl.classList.remove('active');
  }

  function clear() {
    EL.entries.length = 0;
    EL.seenEventIds.clear();
    EL.seenZoneStatus.clear();
    _render();
  }

  // ---- Polling: pull events + zones, append new entries ----
  function onReplayTick() {
    if (!EL.open) return;   // skip when panel closed (cheap no-op)
    _pollAndDiff();
    _render();
  }

  function _pollAndDiff() {
    const chart = window.App && window.App.chart;
    if (!chart) return;

    // BOS / CHoCh events
    if (window.BOSChoChDetector && window.BOSChoChDetector.getEventsForChart) {
      const events = window.BOSChoChDetector.getEventsForChart(chart) || [];
      for (const ev of events) {
        const id = `${ev.type}_${ev.direction}_${ev.eventBarIdx}`;
        if (EL.seenEventIds.has(id)) continue;
        EL.seenEventIds.add(id);
        EL.entries.push({
          ts:   ev.eventTs,
          kind: ev.type === 'BOS' ? 'bos' : 'choch',
          dir:  ev.direction,
          text: `${ev.type}${ev.direction === 'up' ? '↑' : '↓'}  level=${_fmtPrice(ev.level)}`,
          eventBarIdx: ev.eventBarIdx,
          trendBefore: ev.trendBefore,
        });
      }
    }

    // Supply / Demand zones — log each status transition
    if (window.SupplyDemandZones && window.SupplyDemandZones.getZonesForChart) {
      const zones = window.SupplyDemandZones.getZonesForChart(chart) || [];
      for (const z of zones) {
        const lastStatus = EL.seenZoneStatus.get(z.id);
        if (lastStatus === z.status) continue;
        EL.seenZoneStatus.set(z.id, z.status);
        // Skip the initial 'untested' state (logged when zone is created — noise)
        if (z.status === 'untested' && lastStatus == null) {
          // Log creation as a separate type — useful but quieter
          EL.entries.push({
            ts:   z.triggeredBy.eventTs,
            kind: 'zone',
            sub:  'framed',
            side: z.side,
            text: `${z.side === 'supply' ? 'SUPPLY' : 'DEMAND'} zone framed`,
            eventBarIdx: z.triggeredBy.eventBarIdx,
          });
          continue;
        }
        EL.entries.push({
          ts:   _zoneTransitionTs(z),
          kind: 'zone',
          sub:  z.status,
          side: z.side,
          text: `${z.side === 'supply' ? 'SUPPLY' : 'DEMAND'} zone → ${z.status}`,
          eventBarIdx: _zoneTransitionBar(z),
        });
      }
    }

    // Re-sort entries by timestamp so backfill is in chronological order
    EL.entries.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  function _zoneTransitionTs(z) {
    const chart = window.App && window.App.chart;
    const bars = (window.App && window.App.currentBars) || [];
    let bi = null;
    if (z.status === 'tested')      bi = z.testedAtBarIdx;
    else if (z.status === 'invalidated') bi = z.sweptAtBarIdx;
    else if (z.status === 'expired')     bi = z.expiredAtBarIdx;
    if (bi != null && bars[bi]) return bars[bi].timestamp;
    return z.triggeredBy.eventTs;
  }

  function _zoneTransitionBar(z) {
    if (z.status === 'tested')      return z.testedAtBarIdx;
    if (z.status === 'invalidated') return z.sweptAtBarIdx;
    if (z.status === 'expired')     return z.expiredAtBarIdx;
    return z.triggeredBy.eventBarIdx;
  }

  // ---- Render ----
  function _render() {
    if (!EL.bodyEl) return;
    EL.bodyEl.innerHTML = '';
    if (!EL.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'event-log-empty';
      empty.textContent = _t('eventLog.empty', '(尚無事件)');
      EL.bodyEl.appendChild(empty);
      return;
    }
    for (const entry of EL.entries) {
      if (!_passesFilter(entry)) continue;
      EL.bodyEl.appendChild(_renderEntry(entry));
    }
    if (EL.autoScroll) _scrollToBottom();
  }

  function _passesFilter(entry) {
    if (entry.kind === 'bos')   return EL.filter.bos;
    if (entry.kind === 'choch') return EL.filter.choch;
    if (entry.kind === 'zone')  return EL.filter.zone;
    return true;
  }

  function _renderEntry(entry) {
    const row = document.createElement('div');
    row.className = `event-log-row event-log-${entry.kind}`;
    if (entry.sub) row.classList.add(`event-log-${entry.kind}-${entry.sub}`);

    const tsEl = document.createElement('span');
    tsEl.className = 'event-log-ts';
    tsEl.textContent = _fmtTs(entry.ts);
    row.appendChild(tsEl);

    const dot = document.createElement('span');
    dot.className = `event-log-dot event-log-dot-${entry.kind}`;
    if (entry.sub) dot.classList.add(`event-log-dot-${entry.sub}`);
    if (entry.side) dot.classList.add(`event-log-dot-${entry.side}`);
    row.appendChild(dot);

    const textEl = document.createElement('span');
    textEl.className = 'event-log-text';
    textEl.textContent = entry.text;
    row.appendChild(textEl);

    // Click row → jump replay cursor to this event's bar (if replay active)
    if (entry.eventBarIdx != null) {
      row.classList.add('event-log-row-clickable');
      row.addEventListener('click', () => _jumpToBar(entry.eventBarIdx));
    }
    return row;
  }

  function _scrollToBottom() {
    if (!EL.bodyEl) return;
    EL.bodyEl.scrollTop = EL.bodyEl.scrollHeight;
  }

  function _jumpToBar(barIdx) {
    const R = window.Replay;
    if (!R || !R.active) return;
    // Use the public cursor-setter if available
    if (R.setCursorAtBarIdx) {
      R.setCursorAtBarIdx(barIdx).catch(() => {});
    }
  }

  // ---- Formatters ----
  function _fmtTs(ts) {
    if (!ts) return '--:--';
    try {
      const d = new Date(ts);
      return d.toLocaleString('zh-TW', {
        timeZone: 'America/New_York',
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
        hour12: false,
      }).replace(/^.*?(\d{2}\/\d{2}).*?(\d{2}:\d{2}).*$/, '$1 $2');
    } catch (e) {
      return new Date(ts).toISOString().slice(5, 16).replace('T', ' ');
    }
  }

  function _fmtPrice(p) {
    if (p == null || !Number.isFinite(p)) return '--';
    // Match the chart's price-axis precision roughly. TXF whole numbers,
    // XAUUSD 2 decimals. Pragmatic default: 2 decimals max, strip trailing zeros.
    return Number(p.toFixed(2)).toString();
  }

  // ---- Public API ----
  window.EventLog = {
    init,
    open, close, toggle,
    clear,
    onReplayTick,
    // For testing / future consumers:
    getEntries: () => EL.entries.slice(),
    isOpen: () => EL.open,
  };
})();
