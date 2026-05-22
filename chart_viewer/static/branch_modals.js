/**
 * branch_modals.js — Promise-based modal flows for branching replay.
 *
 * Spec: docs/specs/branching-replay-spec.md §4. Three modals total:
 *   §4.1  Fork-or-discard  (Phase 3 — passive trigger from step-back)
 *   §4.2  Manual fork      (Phase 2 — this file)
 *   §4.3  Promotion (3-step)  (Phase 6 — heaviest, with cooldown +
 *                              type-to-confirm + ≥20-char reason)
 *   §4.4  Delete branch    (Phase 5)
 *
 * Pattern: each modal function returns a Promise that resolves to the
 * user's choice. The opener does not need to manage DOM cleanup —
 * cancel / confirm / ESC / backdrop-click all cleanup automatically.
 *
 *     const r = await BranchModals.manualFork({ parentName, forkBar });
 *     if (r.confirmed) BranchEngine.createBranch({...r});
 *
 * Visual style matches bracket-ux-polish-spec.md modals: dark card on
 * 50%-opaque backdrop, ESC closes, primary button only enables when
 * inputs satisfy the modal's gate (e.g. kind selected for fork modals).
 */
(function () {
  // Spec i18n §3.5: KIND_OPTIONS now stores i18n KEYS for title +
  // subtitle. Each modal that renders the picker resolves these via
  // t_() at render time, so reopening the modal in the new language
  // shows the translated copy. Modals are short-lived per spec §4.3
  // ("no listener needed; next open will be in current language").
  const KIND_OPTIONS = [
    { kind: 'exec',      icon: '⚙',  titleKey: 'branch.modalExecTitle',      subKey: 'branch.modalExecSub' },
    { kind: 'direction', icon: '⇄',  titleKey: 'branch.modalDirectionTitle', subKey: 'branch.modalDirectionSub' },
    { kind: 'sandbox',   icon: '🧪', titleKey: 'branch.modalSandboxTitle',   subKey: 'branch.modalSandboxSub' },
  ];

  const t_ = (key, vars) => (window.I18n && window.I18n.t)
    ? window.I18n.t(key, vars)
    : key;

  function _renderKindButton(k) {
    const title = t_(k.titleKey);
    const subtitle = t_(k.subKey).replace('\n', '<br>');
    return `
      <button type="button" class="branch-kind-btn kind-${k.kind}"
              data-kind="${k.kind}" role="radio" aria-checked="false">
        <span class="branch-kind-icon">${k.icon}</span>
        <span class="branch-kind-title">${_escape(title)}</span>
        <span class="branch-kind-subtitle">${subtitle}</span>
      </button>
    `;
  }

  function _displayBranchName(branch) {
    if (!branch) return t_('branch.kindMain');
    if (typeof branch === 'string') {
      // Some callers pass just the name string already.
      if (branch === '主線' || branch === 'Main') return t_('branch.kindMain');
      return branch;
    }
    if (branch.kind === 'main' && (branch.name === '主線' || branch.name === 'Main')) {
      return t_('branch.kindMain');
    }
    return branch.name;
  }

  // Renders "步驟 {cur} / 3" / "Step {cur} / 3" with the {cur} as an
  // updatable <span class="step-cur"> so promotionFlow can swap the
  // number across step transitions without re-translating the label.
  function _renderStepLabel(cur) {
    const lang = (window.I18n && window.I18n.lang) || 'zh';
    const tpl = lang === 'en' ? 'Step {cur} / 3' : '步驟 {cur} / 3';
    const idx = tpl.indexOf('{cur}');
    const before = tpl.slice(0, idx);
    const after  = tpl.slice(idx + 5);
    return `${_escape(before)}<span class="step-cur">${cur}</span>${_escape(after)}`;
  }

  // Singleton root — one container that all modals share. Created on
  // first use, never removed (keeps body DOM stable for stylesheets).
  let _root = null;
  function _ensureRoot() {
    if (_root) return _root;
    _root = document.createElement('div');
    _root.id = 'branch-modal-root';
    document.body.appendChild(_root);
    return _root;
  }

  // ------------------------------------------------------------------
  // §4.2 Manual fork modal
  //
  // Opts:
  //   parentName       — display name of the branch we're forking from
  //   forkBarLabel     — "第 N 根" string for the description
  //   defaultName      — auto-generated default for the name input
  //
  // Resolves to:
  //   { confirmed: true, kind, name, note }   on 建立分支
  //   { confirmed: false }                    on 取消 / ESC / backdrop click
  // ------------------------------------------------------------------
  function manualFork(opts = {}) {
    return new Promise((resolve) => {
      const root = _ensureRoot();
      const parentName = _displayBranchName(opts.parentName);
      const forkBarLabel = opts.forkBarLabel || t_('branch.barLabel', { n: '?' });
      // Solution A: show the K-bar's actual ET time prominently in the
      // subtitle so the user knows EXACTLY when on the timeline they
      // are forking. Falls back to bar index if timestamp wasn't passed
      // (older callers).
      const forkBarTimestamp = opts.forkBarTimestamp;
      const tsLabel = (Number.isFinite(forkBarTimestamp) && window.formatBarTime)
        ? window.formatBarTime(forkBarTimestamp)
        : null;
      const defaultName = opts.defaultName || 'branch-N';

      // Modal copy not in spec §3.5 master dictionary — translate inline.
      const lang = (window.I18n && window.I18n.lang) || 'zh';
      const L = lang === 'en' ? {
        title:        'Create New Branch',
        subtitle:     (parent, when) => `Fork from <strong>${parent}</strong> @ ${when}.<br>The new branch starts here; the original timeline is unchanged.`,
        kindQuestion: 'What kind of exploration?',
        required:     'required',
        nameLabel:    'Branch name',
        noteLabel:    'Note',
        confirm:      'Create Branch',
      } : {
        title:        '建立新分支',
        subtitle:     (parent, when) => `從 <strong>${parent}</strong> @ ${when} K 棒分支。<br>新分支從這裡開始，原始時間線不變。`,
        kindQuestion: '這次探索的類型？',
        required:     '必選',
        nameLabel:    '分支名稱',
        noteLabel:    '備註',
        confirm:      '建立分支',
      };
      const whenStr = tsLabel
        ? `<strong>${_escape(tsLabel)}</strong> (${_escape(forkBarLabel)})`
        : _escape(forkBarLabel);

      const overlay = document.createElement('div');
      overlay.className = 'branch-modal-overlay';
      overlay.innerHTML = `
        <div class="branch-modal-backdrop"></div>
        <div class="branch-modal-card" role="dialog" aria-modal="true">
          <header class="branch-modal-header">
            <div class="branch-modal-icon icon-fork" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 4 L12 14 L19 4"/>
                <line x1="12" y1="14" x2="12" y2="20"/>
              </svg>
            </div>
            <div class="branch-modal-titles">
              <h3 class="branch-modal-title">${_escape(L.title)}</h3>
              <p class="branch-modal-subtitle">${L.subtitle(_escape(parentName), whenStr)}</p>
            </div>
          </header>

          <div class="branch-modal-body">
            <div class="branch-modal-section">
              <label class="branch-modal-label">
                ${_escape(L.kindQuestion)}
                <span class="branch-modal-required">${_escape(L.required)}</span>
              </label>
              <div class="branch-kind-picker" role="radiogroup">
                ${KIND_OPTIONS.map(_renderKindButton).join('')}
              </div>
            </div>

            <div class="branch-modal-section">
              <label class="branch-modal-label" for="branch-modal-name">${_escape(L.nameLabel)}</label>
              <input id="branch-modal-name" type="text" class="branch-modal-input"
                     value="${_escape(defaultName)}" autocomplete="off" maxlength="40">
            </div>

            <div class="branch-modal-section">
              <label class="branch-modal-label" for="branch-modal-note">${_escape(L.noteLabel)} <span class="branch-modal-hint">${_escape(t_('branch.noteOptional'))}</span></label>
              <textarea id="branch-modal-note" class="branch-modal-textarea" rows="2"
                        placeholder="${_escape(t_('branch.placeholderExec'))}"></textarea>
            </div>
          </div>

          <footer class="branch-modal-actions">
            <button type="button" class="branch-modal-btn branch-modal-btn-secondary" data-action="cancel">${_escape(t_('common.cancel'))}</button>
            <button type="button" class="branch-modal-btn branch-modal-btn-primary" data-action="confirm" disabled>${_escape(L.confirm)}</button>
          </footer>
        </div>
      `;
      root.appendChild(overlay);

      // -- State --
      let selectedKind = null;
      const card    = overlay.querySelector('.branch-modal-card');
      const primary = overlay.querySelector('[data-action="confirm"]');
      const cancel  = overlay.querySelector('[data-action="cancel"]');
      const backdrop = overlay.querySelector('.branch-modal-backdrop');
      const nameInp = overlay.querySelector('#branch-modal-name');
      const noteInp = overlay.querySelector('#branch-modal-note');
      const kindBtns = Array.from(overlay.querySelectorAll('.branch-kind-btn'));

      // -- Kind selection (radio behavior) --
      for (const btn of kindBtns) {
        btn.addEventListener('click', () => {
          for (const b of kindBtns) {
            b.classList.remove('selected');
            b.setAttribute('aria-checked', 'false');
          }
          btn.classList.add('selected');
          btn.setAttribute('aria-checked', 'true');
          selectedKind = btn.dataset.kind;
          primary.disabled = false;
        });
      }

      // -- Confirm / cancel paths --
      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(result);
      };
      const onCancel = () => close({ confirmed: false });
      const onConfirm = () => {
        if (!selectedKind) return;
        const name = nameInp.value.trim() || defaultName;
        const note = noteInp.value.trim();
        close({ confirmed: true, kind: selectedKind, name, note });
      };
      cancel.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onCancel);
      primary.addEventListener('click', onConfirm);

      // -- Keyboard: ESC closes; Enter on name input confirms --
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
          return;
        }
        if (e.key === 'Enter' && document.activeElement !== noteInp) {
          if (!primary.disabled) {
            e.preventDefault();
            onConfirm();
          }
        }
      };
      document.addEventListener('keydown', onKey, true);

      // Don't let backdrop clicks inside the card bubble out
      card.addEventListener('click', (e) => e.stopPropagation());

      // Auto-focus the name input (deferred so the modal animation
      // doesn't fight the focus) — pre-selected so the user can
      // immediately retype to override the default.
      requestAnimationFrame(() => {
        nameInp.focus();
        nameInp.select();
      });
    });
  }

  // ------------------------------------------------------------------
  // §4.1 Fork-or-discard modal (Phase 3 — passive trigger from step-back)
  //
  // Shown when Replay.stepBack would lose recent activity. Three exits:
  //
  //   { confirmed: true, action: 'fork', kind, name, note }
  //                         — create a new branch at the new cursor
  //                           preserving the trades-in-danger as the
  //                           branch's own history
  //   { confirmed: true, action: 'discard' }
  //                         — engine.rollbackToBarTs(cutoff) wipes the
  //                           trades; cursor steps back as if they
  //                           never happened
  //   { confirmed: false }  — Cancel / ESC / backdrop — cursor stays
  //
  // Opts:
  //   parentName, forkBarLabel, forkBarTimestamp, defaultName
  //                         — same shape as manualFork (4.2)
  //   tradeCount            — number of trades in the danger zone
  //   netPnLLabel           — pre-formatted "+$Y" / "-$Y" string
  //   lastTradeSummary      — optional one-line description of the
  //                           most recent trade about to be lost
  // ------------------------------------------------------------------
  function forkOrDiscard(opts = {}) {
    return new Promise((resolve) => {
      const root = _ensureRoot();
      const parentName = _displayBranchName(opts.parentName);
      const forkBarLabel = opts.forkBarLabel || t_('branch.barLabel', { n: '?' });
      const forkBarTimestamp = opts.forkBarTimestamp;
      const tsLabel = (Number.isFinite(forkBarTimestamp) && window.formatBarTime)
        ? window.formatBarTime(forkBarTimestamp)
        : null;
      const defaultName = opts.defaultName || 'branch-N';
      const tradeCount  = Number.isFinite(opts.tradeCount) ? opts.tradeCount : 0;
      const netPnLLabel = opts.netPnLLabel || '—';
      const lastTradeSummary = opts.lastTradeSummary || '';

      // Spec §4.1 copy not in master dictionary §3.5 — translate inline.
      const lang = (window.I18n && window.I18n.lang) || 'zh';
      const L = lang === 'en' ? {
        title:        'Step-back will overwrite recent activity',
        subtitle:     (when) => `Stepping back to ${when} will discard recent trades.<br>Create a branch to keep them, or discard.`,
        willLose:     'Will lose',
        loseValue:    `${tradeCount} trade${tradeCount === 1 ? '' : 's'} · net P&L`,
        lastTrade:    'Last trade',
        kindQuestion: 'What kind of exploration?',
        required:     'required (when creating a branch)',
        nameLabel:    'Branch name',
        noteLabel:    'Note',
        confirm:      'Create Branch',
        discard:      'Discard recent trades',
      } : {
        title:        '回退會覆蓋近期活動',
        subtitle:     (when) => `回到 ${when} K 棒會丟掉這之間的近期交易。<br>建立分支保留現有交易，或直接丟棄。`,
        willLose:     '將會丟失',
        loseValue:    `${tradeCount} 筆交易 · 淨損益`,
        lastTrade:    '最後一筆',
        kindQuestion: '這次探索的類型？',
        required:     '必選（建立分支時）',
        nameLabel:    '分支名稱',
        noteLabel:    '備註',
        confirm:      '建立分支',
        discard:      '丟棄近期交易',
      };
      const whenStr = tsLabel
        ? `<strong>${_escape(tsLabel)}</strong> (${_escape(forkBarLabel)})`
        : _escape(forkBarLabel);

      const overlay = document.createElement('div');
      overlay.className = 'branch-modal-overlay';
      overlay.innerHTML = `
        <div class="branch-modal-backdrop"></div>
        <div class="branch-modal-card branch-modal-fod" role="dialog" aria-modal="true">
          <header class="branch-modal-header">
            <div class="branch-modal-icon icon-fork" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 4 L12 14 L19 4"/>
                <line x1="12" y1="14" x2="12" y2="20"/>
              </svg>
            </div>
            <div class="branch-modal-titles">
              <h3 class="branch-modal-title">${_escape(L.title)}</h3>
              <p class="branch-modal-subtitle">${L.subtitle(whenStr)}</p>
            </div>
          </header>

          <div class="branch-modal-body">
            <div class="branch-modal-stats">
              <div class="branch-modal-stat-row">
                <span class="branch-modal-stat-label">${_escape(L.willLose)}</span>
                <span class="branch-modal-stat-value">${_escape(L.loseValue)} <strong>${_escape(netPnLLabel)}</strong></span>
              </div>
              ${lastTradeSummary ? `
                <div class="branch-modal-stat-row branch-modal-stat-sub">
                  <span class="branch-modal-stat-label">${_escape(L.lastTrade)}</span>
                  <span class="branch-modal-stat-value">${_escape(lastTradeSummary)}</span>
                </div>` : ''}
            </div>

            <div class="branch-modal-section">
              <label class="branch-modal-label">
                ${_escape(L.kindQuestion)}
                <span class="branch-modal-required">${_escape(L.required)}</span>
              </label>
              <div class="branch-kind-picker" role="radiogroup">
                ${KIND_OPTIONS.map(_renderKindButton).join('')}
              </div>
            </div>

            <div class="branch-modal-section">
              <label class="branch-modal-label" for="branch-fod-name">${_escape(L.nameLabel)}</label>
              <input id="branch-fod-name" type="text" class="branch-modal-input"
                     value="${_escape(defaultName)}" autocomplete="off" maxlength="40">
            </div>

            <div class="branch-modal-section">
              <label class="branch-modal-label" for="branch-fod-note">${_escape(L.noteLabel)} <span class="branch-modal-hint">${_escape(t_('branch.noteOptional'))}</span></label>
              <textarea id="branch-fod-note" class="branch-modal-textarea" rows="2"
                        placeholder="${_escape(t_('branch.placeholderTimeline'))}"></textarea>
            </div>
          </div>

          <footer class="branch-modal-actions branch-modal-actions-three">
            <button type="button" class="branch-modal-btn branch-modal-btn-secondary" data-action="cancel">${_escape(t_('common.cancel'))}</button>
            <button type="button" class="branch-modal-btn branch-modal-btn-danger"    data-action="discard">${_escape(L.discard)}</button>
            <button type="button" class="branch-modal-btn branch-modal-btn-primary"   data-action="fork" disabled>${_escape(L.confirm)}</button>
          </footer>
        </div>
      `;
      root.appendChild(overlay);

      let selectedKind = null;
      const card     = overlay.querySelector('.branch-modal-card');
      const primary  = overlay.querySelector('[data-action="fork"]');
      const discard  = overlay.querySelector('[data-action="discard"]');
      const cancel   = overlay.querySelector('[data-action="cancel"]');
      const backdrop = overlay.querySelector('.branch-modal-backdrop');
      const nameInp  = overlay.querySelector('#branch-fod-name');
      const noteInp  = overlay.querySelector('#branch-fod-note');
      const kindBtns = Array.from(overlay.querySelectorAll('.branch-kind-btn'));

      for (const btn of kindBtns) {
        btn.addEventListener('click', () => {
          for (const b of kindBtns) {
            b.classList.remove('selected');
            b.setAttribute('aria-checked', 'false');
          }
          btn.classList.add('selected');
          btn.setAttribute('aria-checked', 'true');
          selectedKind = btn.dataset.kind;
          primary.disabled = false;
        });
      }

      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(result);
      };
      const onCancel  = () => close({ confirmed: false });
      const onDiscard = () => close({ confirmed: true, action: 'discard' });
      const onFork    = () => {
        if (!selectedKind) return;
        const name = nameInp.value.trim() || defaultName;
        const note = noteInp.value.trim();
        close({ confirmed: true, action: 'fork', kind: selectedKind, name, note });
      };
      cancel.addEventListener('click',   onCancel);
      backdrop.addEventListener('click', onCancel);
      discard.addEventListener('click',  onDiscard);
      primary.addEventListener('click',  onFork);

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          onCancel();
          return;
        }
        if (e.key === 'Enter' && document.activeElement !== noteInp) {
          if (!primary.disabled) {
            e.preventDefault();
            onFork();
          }
        }
      };
      document.addEventListener('keydown', onKey, true);

      card.addEventListener('click', (e) => e.stopPropagation());

      requestAnimationFrame(() => {
        nameInp.focus();
        nameInp.select();
      });
    });
  }

  // ------------------------------------------------------------------
  // §4.4 Delete-branch modal (Phase 5)
  //
  // Single-step destructive confirmation. The `mainBranchId` cannot be
  // deleted — caller is responsible for not opening this modal in
  // that case (or for disabling the delete entry in the menu).
  //
  // Opts:
  //   branchName       — for the confirm title
  //   parentName       — child branches re-parent to this branch
  //   tradeCount       — own trades that'll be wiped
  //
  // Resolves:
  //   { confirmed: true }   on 刪除
  //   { confirmed: false }  on 取消 / ESC / backdrop
  // ------------------------------------------------------------------
  function deleteBranch(opts = {}) {
    return new Promise((resolve) => {
      const root = _ensureRoot();
      const branchName = opts.branchName || '?';
      const parentName = _displayBranchName(opts.parentName);
      const tradeCount = Number.isFinite(opts.tradeCount) ? opts.tradeCount : 0;

      // Modal copy not in spec §3.5 — translate inline.
      const lang = (window.I18n && window.I18n.lang) || 'zh';
      const L = lang === 'en' ? {
        title:    t_('branch.ctxDelete'),
        subtitle: (n) => `Delete "<strong>${n}</strong>"?`,
        bullet1:  (c) => `This branch's <strong>${c}</strong> trade${c === 1 ? '' : 's'} will be permanently deleted`,
        bullet2:  (p) => `Child branches will be re-parented to <strong>${p}</strong>`,
        bullet3:  'This action cannot be undone',
      } : {
        title:    '刪除分支',
        subtitle: (n) => `確定要刪除「<strong>${n}</strong>」？`,
        bullet1:  (c) => `此分支的 <strong>${c}</strong> 筆交易將被永久刪除`,
        bullet2:  (p) => `此分支的子分支將自動重新指向 <strong>${p}</strong>`,
        bullet3:  '此操作無法還原',
      };

      const overlay = document.createElement('div');
      overlay.className = 'branch-modal-overlay';
      overlay.innerHTML = `
        <div class="branch-modal-backdrop"></div>
        <div class="branch-modal-card branch-modal-delete" role="dialog" aria-modal="true">
          <header class="branch-modal-header">
            <div class="branch-modal-icon icon-danger" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6 H21"/>
                <path d="M5 6 V20 a2 2 0 0 0 2 2 H17 a2 2 0 0 0 2 -2 V6"/>
                <path d="M9 6 V4 a1 1 0 0 1 1 -1 H14 a1 1 0 0 1 1 1 V6"/>
              </svg>
            </div>
            <div class="branch-modal-titles">
              <h3 class="branch-modal-title">${_escape(L.title)}</h3>
              <p class="branch-modal-subtitle">${L.subtitle(_escape(branchName))}</p>
            </div>
          </header>

          <div class="branch-modal-body">
            <ul class="branch-modal-bullets">
              <li>${L.bullet1(tradeCount)}</li>
              <li>${L.bullet2(_escape(parentName))}</li>
              <li>${_escape(L.bullet3)}</li>
            </ul>
          </div>

          <footer class="branch-modal-actions">
            <button type="button" class="branch-modal-btn branch-modal-btn-secondary" data-action="cancel">${_escape(t_('common.cancel'))}</button>
            <button type="button" class="branch-modal-btn branch-modal-btn-danger-primary" data-action="confirm">${_escape(t_('common.delete'))}</button>
          </footer>
        </div>
      `;
      root.appendChild(overlay);

      const card     = overlay.querySelector('.branch-modal-card');
      const cancel   = overlay.querySelector('[data-action="cancel"]');
      const confirm  = overlay.querySelector('[data-action="confirm"]');
      const backdrop = overlay.querySelector('.branch-modal-backdrop');

      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(result);
      };
      cancel.addEventListener('click',   () => close({ confirmed: false }));
      backdrop.addEventListener('click', () => close({ confirmed: false }));
      confirm.addEventListener('click',  () => close({ confirmed: true }));

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          close({ confirmed: false });
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          close({ confirmed: true });
        }
      };
      document.addEventListener('keydown', onKey, true);

      card.addEventListener('click', (e) => e.stopPropagation());

      requestAnimationFrame(() => confirm.focus());
    });
  }

  // ------------------------------------------------------------------
  // §4.x Note editor modal (Phase 5 — view + edit branch note)
  //
  // Note shape: `{ title, body }`. Same modal serves as the "view"
  // path (open with current values pre-filled) and the "edit" path
  // (user changes fields, clicks 確認). Confirms resolve with the
  // new shape; cancel resolves with confirmed:false.
  //
  // Draggable header (same pattern as the chart-settings modal —
  // mousedown on header switches the centered transform to explicit
  // top/left so subsequent drags work in pixel space).
  //
  // Opts:
  //   branchName  — display name for the modal title
  //   title       — pre-fill for title field
  //   body        — pre-fill for body field
  //
  // Resolves:
  //   { confirmed: true, title, body }   on 確認
  //   { confirmed: false }                 on 取消 / ESC / backdrop
  // ------------------------------------------------------------------
  function editNote(opts = {}) {
    return new Promise((resolve) => {
      const root = _ensureRoot();
      const branchName = opts.branchName || '?';
      const initialTitle = String(opts.title || '');
      const initialBody  = String(opts.body  || '');

      const overlay = document.createElement('div');
      // `branch-modal-overlay-clear` modifier — the editNote modal
      // intentionally leaves the chart visible (no dim, no blur) so
      // the user can keep eyes on the K-bars they're describing.
      overlay.className = 'branch-modal-overlay branch-modal-overlay-clear';
      const lang = (window.I18n && window.I18n.lang) || 'zh';
      const L = lang === 'en' ? {
        title:    t_('branch.ctxNote'),
        subtitle: (n) => `Record a title and body for "<strong>${n}</strong>".`,
        titleField: 'Title',
        bodyField:  'Body',
      } : {
        title:    '編輯備註',
        subtitle: (n) => `為「<strong>${n}</strong>」記下標題與內文。`,
        titleField: '標題',
        bodyField:  '內文',
      };

      overlay.innerHTML = `
        <div class="branch-modal-backdrop"></div>
        <div class="branch-modal-card branch-modal-note" role="dialog" aria-modal="true">
          <header class="branch-modal-header branch-modal-header-drag">
            <div class="branch-modal-titles">
              <h3 class="branch-modal-title">${_escape(L.title)}</h3>
              <p class="branch-modal-subtitle">${L.subtitle(_escape(branchName))}</p>
            </div>
          </header>

          <div class="branch-modal-body">
            <div class="branch-modal-section">
              <label class="branch-modal-label" for="branch-note-title">${_escape(L.titleField)}</label>
              <input id="branch-note-title" type="text" class="branch-modal-input"
                     value="${_escape(initialTitle)}" autocomplete="off"
                     maxlength="60" placeholder="${_escape(t_('branch.placeholderShortDesc'))}">
            </div>
            <div class="branch-modal-section">
              <label class="branch-modal-label" for="branch-note-body">${_escape(L.bodyField)}</label>
              <textarea id="branch-note-body" class="branch-modal-textarea branch-modal-textarea-tall"
                        rows="8" placeholder="${_escape(t_('branch.placeholderLongDesc'))}"
              >${_escape(initialBody)}</textarea>
            </div>
          </div>

          <footer class="branch-modal-actions">
            <button type="button" class="branch-modal-btn branch-modal-btn-secondary" data-action="cancel">${_escape(t_('common.cancel'))}</button>
            <button type="button" class="branch-modal-btn branch-modal-btn-primary"   data-action="confirm">${_escape(t_('common.confirm'))}</button>
          </footer>
        </div>
      `;
      root.appendChild(overlay);

      const card     = overlay.querySelector('.branch-modal-card');
      const header   = overlay.querySelector('.branch-modal-header-drag');
      const cancel   = overlay.querySelector('[data-action="cancel"]');
      const confirm  = overlay.querySelector('[data-action="confirm"]');
      const backdrop = overlay.querySelector('.branch-modal-backdrop');
      const titleInp = overlay.querySelector('#branch-note-title');
      const bodyInp  = overlay.querySelector('#branch-note-body');

      // Drag the modal by its header. Same approach as the
      // chart-settings card: snapshot rect, replace transform with
      // pixel left/top, then track mouse delta.
      _installModalDrag(header, card);

      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(result);
      };
      const onCancel  = () => close({ confirmed: false });
      const onConfirm = () => {
        const title = titleInp.value.trim();
        const body  = bodyInp.value;     // preserve user's whitespace in body
        close({ confirmed: true, title, body });
      };
      cancel.addEventListener('click',   onCancel);
      backdrop.addEventListener('click', onCancel);
      confirm.addEventListener('click',  onConfirm);

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          onCancel();
          return;
        }
        // Cmd/Ctrl + Enter inside body = save (Enter alone leaves room
        // for line breaks). Plain Enter on title input also saves.
        if (e.key === 'Enter') {
          if (document.activeElement === titleInp) {
            e.preventDefault();
            onConfirm();
          } else if ((e.metaKey || e.ctrlKey) && document.activeElement === bodyInp) {
            e.preventDefault();
            onConfirm();
          }
        }
      };
      document.addEventListener('keydown', onKey, true);

      card.addEventListener('click', (e) => e.stopPropagation());

      requestAnimationFrame(() => {
        // Focus only — no .select(). Auto-selecting the existing title
        // means an accidental keystroke wipes the user's saved note in
        // one tap. Cursor lands at end of existing text → typing appends.
        titleInp.focus();
      });
    });
  }

  // Drag helper — the card is `position: relative` inside a flex-
  // centered overlay, so left/top here are OFFSETS from the natural
  // (flex-centered) position, not viewport coords. Using accumulated
  // deltas is the only way that maths out: each drag picks up where
  // the previous left/top ended.
  function _installModalDrag(header, card) {
    if (!header || !card) return;
    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, textarea')) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      // Pick up wherever the card's already been dragged to (defaults
      // to 0 / 0 = natural flex-centered position on first drag).
      const startLeft = parseFloat(card.style.left) || 0;
      const startTop  = parseFloat(card.style.top)  || 0;
      document.body.style.userSelect = 'none';
      const onMove = (ev) => {
        card.style.left = (startLeft + ev.clientX - startX) + 'px';
        card.style.top  = (startTop  + ev.clientY - startY) + 'px';
      };
      const onUp = () => {
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup',   onUp,   true);
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup',   onUp,   true);
    });
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function _escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;',
      '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  // ------------------------------------------------------------------
  // §4.3 Promotion flow (Phase 6 — the 3-step gauntlet)
  //
  // Spec §1.3 lays out the rationale: branching itself encourages
  // overfitting unless every promotion is friction-heavy. This modal
  // is the friction. Three steps in one overlay (swap content rather
  // than open/close):
  //
  //   Step 1 — Warning + 3-second cooldown on 我了解，繼續
  //   Step 2 — Type the exact branch name to confirm
  //   Step 3 — Reason ≥ 20 chars
  //
  // ANY step's 取消 / Esc / backdrop click resolves cancel and
  // unwinds the whole flow. Only completing step 3 resolves with
  // { confirmed: true, reason }.
  //
  // Opts:
  //   branchName       — display name of the branch being promoted
  //   currentMainName  — display name of the branch currently in main
  //                      (will become archived-main-N after promotion)
  //   contamCountAfter — what contaminationCount would be after this
  //                      promotion succeeds; used to render the
  //                      future "archived-main-N" name in the warning
  //
  // Resolves:
  //   { confirmed: true, reason }    on completing step 3
  //   { confirmed: false }            on 取消 / ESC / backdrop click
  // ------------------------------------------------------------------
  const PROMOTION_COOLDOWN_MS = 3000;
  const PROMOTION_REASON_MIN  = 20;

  function promotionFlow(opts = {}) {
    return new Promise((resolve) => {
      const root = _ensureRoot();
      const branchName       = opts.branchName || '?';
      const currentMainName  = _displayBranchName(opts.currentMainName);
      const contamCountAfter = Number.isFinite(opts.contamCountAfter)
        ? opts.contamCountAfter : 1;

      const lang = (window.I18n && window.I18n.lang) || 'zh';
      const PL = lang === 'en' ? {
        modalTitle: 'Promote branch to new Main',
        // step 1
        s1Lead: (n) => `You're about to promote "<strong>${n}</strong>" to the new Main. This action will:`,
        s1B1: (cur, n) => `Permanently archive the current main "${cur}" as <strong>archived-main-${n}</strong>`,
        s1B2: (n) => `Permanently flag the stats panel: "⚠ Main has been edited ${n} time${n === 1 ? '' : 's'}"`,
        s1B3: 'Real net P&L no longer reflects your real performance',
        s1WarnHead: '⚠ Note',
        s1WarnBody: 'Promotion is usually an overfitting decision. Unless you have observed this pattern over a long time, "the branch worked out so I promote it" is classic hindsight bias.<br>This tool permanently records each promotion — history cannot be deleted.',
        s1Cancel:  '← Cancel',
        s1Confirm: 'I understand, continue',
        // step 2
        s2Lead: 'Type the branch name to confirm:',
        s2Expected: (n) => `Expected: <strong>${n}</strong>`,
        s2Hint: 'GitHub-style: full branch name required, prevents accidental muscle-memory clicks.',
        s2Next: 'Next',
        // step 3
        s3Lead: 'Why promote?',
        s3Body: 'Explain your reason. This is permanently saved in promotion history and cannot be deleted.',
        s3Examples: 'Examples',
        s3GoodLead: '✓',
        s3Good: '"After watching SNR on NQ for 6 months, the entry/exit on this branch is the most consistent — going to use it as new baseline."',
        s3BadLead: '✗',
        s3Bad1: '"Good performance"',
        s3Bad2: '"Promote try"',
        s3Bad3: '"Best so far"',
        s3CounterFmt: (cur, min) => `${cur} / ${min} chars`,
        s3Confirm: 'Promote',
      } : {
        modalTitle: '升格分支為新主線',
        s1Lead: (n) => `你正在把分支「<strong>${n}</strong>」升格為新主線。這個動作會：`,
        s1B1: (cur, n) => `永久將舊主線「${cur}」歸檔為 <strong>archived-main-${n}</strong>`,
        s1B2: (n) => `在統計面板永久顯示「⚠ 主線已被人為修改 ${n} 次」`,
        s1B3: '真實淨損益不再代表你的真實績效',
        s1WarnHead: '⚠ 注意',
        s1WarnBody: '升格在大部分情況下是個過擬合的決定。除非你對這個 pattern 已經觀察很久，否則「事後看到分支結果好就升格」是經典的事後諸葛 (hindsight bias)。<br>工具會永久記錄此次升格，無法刪除歷史。',
        s1Cancel:  '← 取消',
        s1Confirm: '我了解，繼續',
        s2Lead: '請輸入分支名稱以確認：',
        s2Expected: (n) => `預期輸入：<strong>${n}</strong>`,
        s2Hint: 'GitHub 風格：必須完整輸入分支名稱才能繼續，避免肌肉記憶順手按過。',
        s2Next: '下一步',
        s3Lead: '為什麼升格？',
        s3Body: '請說明升格的理由。這段理由會永久存在升格歷史中，無法刪除。',
        s3Examples: '理由範例',
        s3GoodLead: '✓',
        s3Good: '「過去 6 個月在 NQ 上觀察 SNR，這個分支的進出場是最一致的，要拿來當作新的 baseline」',
        s3BadLead: '✗',
        s3Bad1: '「績效不錯」',
        s3Bad2: '「升格試試」',
        s3Bad3: '「Best so far」',
        s3CounterFmt: (cur, min) => `${cur} / ${min} 字`,
        s3Confirm: '升格',
      };

      const overlay = document.createElement('div');
      overlay.className = 'branch-modal-overlay';
      overlay.innerHTML = `
        <div class="branch-modal-backdrop"></div>
        <div class="branch-modal-card branch-modal-promotion" role="dialog" aria-modal="true">
          <header class="branch-modal-header">
            <div class="branch-modal-icon icon-danger" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3 L12 13"/>
                <circle cx="12" cy="17" r="1"/>
                <path d="M12 3 L22 21 L2 21 Z"/>
              </svg>
            </div>
            <div class="branch-modal-titles">
              <h3 class="branch-modal-title">${_escape(PL.modalTitle)}</h3>
              <p class="branch-modal-subtitle promotion-subtitle">
                <span class="promotion-step-label">${_renderStepLabel(1)}</span>
              </p>
            </div>
          </header>
          <div class="branch-modal-body promotion-body"></div>
          <footer class="branch-modal-actions promotion-actions"></footer>
        </div>
      `;
      root.appendChild(overlay);

      const card     = overlay.querySelector('.branch-modal-card');
      const backdrop = overlay.querySelector('.branch-modal-backdrop');
      const body     = overlay.querySelector('.promotion-body');
      const actions  = overlay.querySelector('.promotion-actions');
      const stepCur  = overlay.querySelector('.step-cur');

      let step = 1;
      let cooldownTimer = null;

      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        if (cooldownTimer) clearInterval(cooldownTimer);
        overlay.remove();
        resolve(result);
      };
      const onCancel = () => close({ confirmed: false });
      backdrop.addEventListener('click', onCancel);
      card.addEventListener('click', (e) => e.stopPropagation());

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          onCancel();
        }
      };
      document.addEventListener('keydown', onKey, true);

      // ---- Step 1: warning + 3-second cooldown -----------------------
      function renderStep1() {
        step = 1;
        const stepLabel = overlay.querySelector('.promotion-step-label');
        if (stepLabel) stepLabel.innerHTML = _renderStepLabel(1);
        body.innerHTML = `
          <div class="promotion-warning">
            <p>${PL.s1Lead(_escape(branchName))}</p>
            <ul class="branch-modal-bullets">
              <li>${PL.s1B1(_escape(currentMainName), contamCountAfter)}</li>
              <li>${PL.s1B2(contamCountAfter)}</li>
              <li>${_escape(PL.s1B3)}</li>
            </ul>
            <p class="promotion-warn-note">
              <strong>${_escape(PL.s1WarnHead)}</strong>：${PL.s1WarnBody}
            </p>
          </div>
        `;
        actions.innerHTML = `
          <button type="button" class="branch-modal-btn branch-modal-btn-secondary" data-action="cancel">${_escape(PL.s1Cancel)}</button>
          <button type="button" class="branch-modal-btn branch-modal-btn-danger-primary" data-action="next" disabled>
            <span class="next-label">${_escape(PL.s1Confirm)}</span>
            <span class="cooldown-suffix"> (${(PROMOTION_COOLDOWN_MS / 1000).toFixed(0)})</span>
          </button>
        `;
        const cancelBtn = actions.querySelector('[data-action="cancel"]');
        const nextBtn   = actions.querySelector('[data-action="next"]');
        const cooldownLabel = actions.querySelector('.cooldown-suffix');
        cancelBtn.addEventListener('click', onCancel);
        nextBtn.addEventListener('click', () => {
          if (nextBtn.disabled) return;
          renderStep2();
        });
        // Cooldown countdown — primary stays disabled for
        // PROMOTION_COOLDOWN_MS ms. The button shows " (3)" → " (2)" →
        // " (1)" then enables and the suffix vanishes.
        const startedAt = Date.now();
        cooldownTimer = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          const remaining = Math.max(0, PROMOTION_COOLDOWN_MS - elapsed);
          if (remaining <= 0) {
            clearInterval(cooldownTimer);
            cooldownTimer = null;
            nextBtn.disabled = false;
            cooldownLabel.textContent = '';
          } else {
            cooldownLabel.textContent = ` (${Math.ceil(remaining / 1000)})`;
          }
        }, 100);
      }

      // ---- Step 2: type-to-confirm branch name -----------------------
      function renderStep2() {
        step = 2;
        const stepLabel = overlay.querySelector('.promotion-step-label');
        if (stepLabel) stepLabel.innerHTML = _renderStepLabel(2);
        body.innerHTML = `
          <div class="promotion-typeconfirm">
            <p>${_escape(PL.s2Lead)}</p>
            <p class="promotion-expected">${PL.s2Expected(_escape(branchName))}</p>
            <input type="text" class="branch-modal-input promotion-name-input"
                   autocomplete="off" placeholder="${_escape(t_('branch.placeholderName'))}">
            <p class="branch-modal-hint">${_escape(PL.s2Hint)}</p>
          </div>
        `;
        actions.innerHTML = `
          <button type="button" class="branch-modal-btn branch-modal-btn-secondary" data-action="cancel">${_escape(PL.s1Cancel)}</button>
          <button type="button" class="branch-modal-btn branch-modal-btn-danger-primary" data-action="next" disabled>${_escape(PL.s2Next)}</button>
        `;
        const cancelBtn = actions.querySelector('[data-action="cancel"]');
        const nextBtn   = actions.querySelector('[data-action="next"]');
        const input     = body.querySelector('.promotion-name-input');
        cancelBtn.addEventListener('click', onCancel);
        const refresh = () => {
          nextBtn.disabled = input.value !== branchName;
        };
        input.addEventListener('input', refresh);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !nextBtn.disabled) {
            e.preventDefault();
            renderStep3();
          }
        });
        nextBtn.addEventListener('click', () => {
          if (nextBtn.disabled) return;
          renderStep3();
        });
        requestAnimationFrame(() => input.focus());
      }

      // ---- Step 3: mandatory reason (≥ 20 chars) ---------------------
      function renderStep3() {
        step = 3;
        const stepLabel = overlay.querySelector('.promotion-step-label');
        if (stepLabel) stepLabel.innerHTML = _renderStepLabel(3);
        const reasonPlaceholder = t_('branch.placeholderReason', { n: PROMOTION_REASON_MIN });
        const counterText = lang === 'en'
          ? `<span class="reason-char-count">0</span> / ${PROMOTION_REASON_MIN} chars entered`
          : `已輸入 <span class="reason-char-count">0</span> / ${PROMOTION_REASON_MIN} 字`;
        const finishLabel = lang === 'en' ? 'Promote' : '完成升格';
        body.innerHTML = `
          <div class="promotion-reason">
            <p>${_escape(PL.s3Lead)}</p>
            <p class="promotion-reason-note">${_escape(PL.s3Body)}</p>
            <textarea class="branch-modal-textarea promotion-reason-input"
                      rows="4" placeholder="${_escape(reasonPlaceholder)}"></textarea>
            <div class="promotion-reason-counter">
              ${counterText}
            </div>
            <details class="promotion-reason-examples">
              <summary>${_escape(PL.s3Examples)}</summary>
              <ul>
                <li class="ok">${_escape(PL.s3GoodLead)} ${_escape(PL.s3Good)}</li>
                <li class="bad">${_escape(PL.s3BadLead)} ${_escape(PL.s3Bad1)}</li>
                <li class="bad">${_escape(PL.s3BadLead)} ${_escape(PL.s3Bad2)}</li>
                <li class="bad">${_escape(PL.s3BadLead)} ${_escape(PL.s3Bad3)}</li>
              </ul>
            </details>
          </div>
        `;
        actions.innerHTML = `
          <button type="button" class="branch-modal-btn branch-modal-btn-secondary" data-action="cancel">${_escape(PL.s1Cancel)}</button>
          <button type="button" class="branch-modal-btn branch-modal-btn-danger-primary" data-action="finish" disabled>${_escape(finishLabel)}</button>
        `;
        const cancelBtn   = actions.querySelector('[data-action="cancel"]');
        const finishBtn   = actions.querySelector('[data-action="finish"]');
        const textarea    = body.querySelector('.promotion-reason-input');
        const charCounter = body.querySelector('.reason-char-count');
        cancelBtn.addEventListener('click', onCancel);
        const refresh = () => {
          const len = textarea.value.trim().length;
          charCounter.textContent = String(len);
          finishBtn.disabled = len < PROMOTION_REASON_MIN;
        };
        textarea.addEventListener('input', refresh);
        finishBtn.addEventListener('click', () => {
          if (finishBtn.disabled) return;
          close({ confirmed: true, reason: textarea.value.trim() });
        });
        requestAnimationFrame(() => textarea.focus());
      }

      renderStep1();
    });
  }

  // ------------------------------------------------------------------
  // §5.5 Promotion-history modal — read-only audit trail of every
  // promotion that has happened in this layout's branch session.
  // Triggered from the summary footer's [查看] link (when
  // contaminationCount > 0).
  //
  // Layout per spec:
  //   - Top row    = original main (the branch that was main BEFORE
  //                  the very first promotion; takes the .from of
  //                  promotionHistory[0]).
  //   - For each entry in promotionHistory: a "↓ 第 N 次升格 from X
  //     at TS — 理由：<reason>" arrow row, followed by the resulting
  //     "Promoted main #N" row.
  //   - Last row   = "Current main (現行)" = the branch that is
  //                  currently kind:'main' (mainBranchId).
  //
  // Each branch row is clickable → setActiveBranch(branchId) so the
  // user can inspect what that branch's chart looked like at any
  // historical state. Closes after switching (user can re-open via
  // [查看] if they want to see a different node).
  //
  // No opts. Resolves undefined when the user closes the modal.
  // ------------------------------------------------------------------
  function promotionHistory() {
    return new Promise((resolve) => {
      const Engine = window.BranchEngine;
      if (!Engine || !Engine.getSession) { resolve(); return; }
      const session = Engine.getSession();
      const history = (session && session.promotionHistory) || [];
      const currentMainId = session && session.mainBranchId;
      const fmtTs = window.formatBarTime
        || ((t) => Number.isFinite(t) ? new Date(t).toLocaleString() : '?');

      // Build the chain of branch nodes shown vertically. When the
      // session has no promotions yet (contaminationCount === 0) the
      // [查看] link wouldn't even be visible — but we still handle
      // the edge case so direct API calls don't crash.
      const lang = (window.I18n && window.I18n.lang) || 'zh';
      const HL = lang === 'en' ? {
        currentMain:    'Current main',
        promotedMain:   (i) => `Promoted main #${i}`,
        originalMain:   'Original main',  // spec §3.5 drops parenthetical for en
        arrowFmt:       (n, name, when) => `↓ Promotion #${n} from <strong>${name}</strong> · ${when}`,
        miniLabel:      'Mini',
        unmini:         'Remove mini',
        promote:        'Promote',
        tradesSuffix:   (c) => `${c} trade${c === 1 ? '' : 's'}`,
        title:          'Promotion History',
        subtitle:       (n) => `Main has been edited <strong>${n}</strong> time${n === 1 ? '' : 's'}. None of these reasons can be deleted.`,
        footerNote:     'If a past promotion turns out to be wrong, you can re-promote from archived-main-N (this adds another contamination record).<br>Click any node to switch the main pane to that branch.',
        close:          t_('common.close'),
      } : {
        currentMain:    '現行主線',
        promotedMain:   (i) => `Promoted main #${i}`,
        originalMain:   'Original main (初始)',
        arrowFmt:       (n, name, when) => `↓ 第 ${n} 次升格 from <strong>${name}</strong> · ${when}`,
        miniLabel:      '副圖',
        unmini:         '移出副圖',
        promote:        '升格',
        tradesSuffix:   (c) => `${c} 筆`,
        title:          '升格歷史',
        subtitle:       (n) => `主線已被人為修改 <strong>${n}</strong> 次。每次理由都不可刪除。`,
        footerNote:     '如果你看完歷史後覺得某次升格是錯誤的，可以從 archived-main-N 重新升格回去（這會再加一筆汙染紀錄）。<br>點任一節點可切換主圖到該分支查看當時的狀態。',
        close:          t_('common.close'),
      };

      const chain = [];
      if (history.length === 0) {
        chain.push({ branchId: currentMainId, role: HL.currentMain, via: null });
      } else {
        chain.push({ branchId: history[0].from, role: HL.originalMain, via: null });
        for (let i = 0; i < history.length; i++) {
          const isLast = i === history.length - 1;
          chain.push({
            branchId: history[i].to,
            role:     isLast ? `${HL.currentMain}${lang === 'en' ? '' : ' (現行)'}` : HL.promotedMain(i + 1),
            via:      history[i],
          });
        }
      }

      const miniBranchId = Engine.miniBranchId;
      const renderNode = (node, idx) => {
        const branch = Engine.getBranch ? Engine.getBranch(node.branchId) : null;
        const branchName = branch ? _displayBranchName(branch) : (node.branchId || '?');
        const kind       = branch ? branch.kind : 'archived';
        const tradeCount = Engine.getOwnTrades
          ? Engine.getOwnTrades(node.branchId).length : 0;
        const pnl = Engine.getNetPL ? (Engine.getNetPL(node.branchId) || 0) : 0;
        const sign = pnl >= 0 ? '+' : '−';
        const pnlText = `${sign}$${Math.abs(pnl).toFixed(0)}`;
        const pnlClass = pnl > 0 ? 'pos' : (pnl < 0 ? 'neg' : 'zero');
        const isCurrent = node.branchId === currentMainId;
        const isMini    = node.branchId === miniBranchId;

        let arrow = '';
        if (node.via) {
          const fromBranch = Engine.getBranch ? Engine.getBranch(node.via.from) : null;
          const fromName = fromBranch ? _displayBranchName(fromBranch) : node.via.from;
          arrow = `
            <div class="history-arrow">
              <div class="history-arrow-line">${HL.arrowFmt(idx, _escape(fromName), _escape(fmtTs(node.via.at)))}</div>
              <div class="history-arrow-reason">${_escape(node.via.reason || '')}</div>
            </div>
          `;
        }
        let actions = '';
        if (!isCurrent) {
          const miniBtn = isMini
            ? `<button type="button" class="history-node-btn" data-act="unmini" data-branch-id="${_escape(node.branchId)}">${_escape(HL.unmini)}</button>`
            : `<button type="button" class="history-node-btn" data-act="mini"   data-branch-id="${_escape(node.branchId)}">${_escape(HL.miniLabel)}</button>`;
          actions = `
            <div class="history-node-actions">
              ${miniBtn}
              <button type="button" class="history-node-btn promote" data-act="promote" data-branch-id="${_escape(node.branchId)}">${_escape(HL.promote)}</button>
            </div>
          `;
        }
        return `
          ${arrow}
          <div class="history-node kind-${_escape(kind)}${isCurrent ? ' is-current' : ''}${isMini ? ' is-mini' : ''}"
               role="button" tabindex="0" data-act="view"
               data-branch-id="${_escape(node.branchId || '')}">
            <span class="history-dot kind-${_escape(kind)}" aria-hidden="true"></span>
            <div class="history-node-info">
              <div class="history-node-name">${_escape(branchName)}</div>
              <div class="history-node-role">${_escape(node.role)}</div>
            </div>
            <div class="history-node-stats">
              <span class="history-trade-count">${_escape(HL.tradesSuffix(tradeCount))}</span>
              <span class="history-pnl ${pnlClass}">${_escape(pnlText)}</span>
            </div>
            ${actions}
          </div>
        `;
      };

      const root = _ensureRoot();
      const overlay = document.createElement('div');
      overlay.className = 'branch-modal-overlay';
      overlay.innerHTML = `
        <div class="branch-modal-backdrop"></div>
        <div class="branch-modal-card branch-modal-history" role="dialog" aria-modal="true">
          <header class="branch-modal-header">
            <div class="branch-modal-icon icon-history" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9"/>
                <path d="M12 7 V12 L15 14"/>
              </svg>
            </div>
            <div class="branch-modal-titles">
              <h3 class="branch-modal-title">${_escape(HL.title)}</h3>
              <p class="branch-modal-subtitle">${HL.subtitle(history.length)}</p>
            </div>
          </header>
          <div class="branch-modal-body history-body">
            <div class="history-timeline">
              ${chain.map(renderNode).join('')}
            </div>
            <p class="history-footer-note">${HL.footerNote}</p>
          </div>
          <footer class="branch-modal-actions">
            <button type="button" class="branch-modal-btn branch-modal-btn-secondary" data-action="close">${_escape(HL.close)}</button>
          </footer>
        </div>
      `;
      root.appendChild(overlay);

      const card     = overlay.querySelector('.branch-modal-card');
      const backdrop = overlay.querySelector('.branch-modal-backdrop');
      const closeBtn = overlay.querySelector('[data-action="close"]');

      const close = () => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve();
      };
      backdrop.addEventListener('click', close);
      closeBtn.addEventListener('click', close);
      card.addEventListener('click', (e) => e.stopPropagation());

      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
      };
      document.addEventListener('keydown', onKey, true);

      // Click delegate inside the timeline. Three actions:
      //   data-act="view"     (row body)         → setActiveBranch
      //   data-act="mini"     (副圖 button)      → setMiniBranch
      //   data-act="unmini"   (移出副圖 button)  → setMiniBranch(null)
      //   data-act="promote"  (升格 button)      → close + open
      //                                            promotionFlow → on
      //                                            confirm call
      //                                            promoteBranch
      // Action buttons stopPropagation so they don't ALSO trigger
      // the row-body's view click.
      const timeline = overlay.querySelector('.history-timeline');
      if (timeline) {
        timeline.addEventListener('click', (e) => {
          const target = e.target;
          if (!(target instanceof Element)) return;
          // Find the closest [data-act] — could be the row itself
          // or one of the action buttons.
          const actEl = target.closest('[data-act]');
          if (!actEl) return;
          const act = actEl.getAttribute('data-act');
          const branchId = actEl.getAttribute('data-branch-id');
          if (!act || !branchId) return;
          // Action buttons live INSIDE row divs — stop the row's
          // own listener from also firing.
          if (actEl.classList.contains('history-node-btn')) {
            e.stopPropagation();
          }
          if (act === 'view') {
            if (Engine.setActiveBranch) Engine.setActiveBranch(branchId);
            close();
            return;
          }
          if (act === 'mini') {
            if (Engine.setMiniBranch) Engine.setMiniBranch(branchId);
            close();
            return;
          }
          if (act === 'unmini') {
            if (Engine.setMiniBranch) Engine.setMiniBranch(null);
            close();
            return;
          }
          if (act === 'promote') {
            // Close history first, then open promotion modal so the
            // user is back to a single-modal context. The promotion
            // flow is async — fire-and-forget; engine update happens
            // in the .then handler if confirmed.
            close();
            const tgt = Engine.getBranch && Engine.getBranch(branchId);
            if (!tgt) return;
            const currentMain = Engine.getMainBranch && Engine.getMainBranch();
            const currentMainName = (currentMain && currentMain.name) || '主線';
            const contamCountAfter = (Engine.contaminationCount || 0) + 1;
            window.BranchModals.promotionFlow({
              branchName: tgt.name,
              currentMainName,
              contamCountAfter,
            }).then((result) => {
              if (result && result.confirmed) {
                Engine.promoteBranch(branchId, result.reason);
              }
            });
            return;
          }
        });
        // Keyboard support for the row-body view click — Enter / Space
        // on a focused row triggers the same path. Standard a11y.
        timeline.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          const target = e.target;
          if (!(target instanceof Element)) return;
          if (!target.classList.contains('history-node')) return;
          e.preventDefault();
          const id = target.getAttribute('data-branch-id');
          if (id && Engine.setActiveBranch) Engine.setActiveBranch(id);
          close();
        });
      }
    });
  }

  // ------------------------------------------------------------------
  // §3.2.3 Cursor-jump fork modal (Phase 3 — passive trigger from order
  // placement after the user navigated cursor backward without losing
  // any trades).
  //
  // Why this exists: spec §3.2.3 catches the hindsight-bias attack
  // surface that §4.1 (fork-or-discard) doesn't. If the user pulls
  // cursor back and the new position has no trades after it,
  // fork-or-discard never fires — there's nothing to lose. But the
  // user has SEEN future bars during their forward play; placing a new
  // order on the main timeline after that knowledge is lookahead bias.
  // We intercept at the placeOrder call site and force a fork, so the
  // suspect order goes to a non-main exploration branch.
  //
  // Two buttons only: cancel / 建立分支. No discard option (no trades
  // to discard — that's the whole reason §4.1 didn't fire). Same kind
  // picker as manualFork / forkOrDiscard for visual consistency.
  //
  // Opts:
  //   parentName       — display name of branch we're forking from (the main)
  //   forkBarLabel     — "第 N 根" string (cursor's current position)
  //   forkBarTimestamp — cursor timestamp (rendered in title)
  //   maxCursorLabel   — formatted ts of the highest seen position
  //                      ("已看到的最遠位置")
  //   defaultName      — auto-generated default for the name input
  //
  // Resolves:
  //   { confirmed: true, kind, name, note }   on 建立分支
  //   { confirmed: false }                    on 取消 / ESC / backdrop
  // ------------------------------------------------------------------
  function cursorJumpFork(opts = {}) {
    return new Promise((resolve) => {
      const root = _ensureRoot();
      const parentName = _displayBranchName(opts.parentName);
      const forkBarLabel = opts.forkBarLabel || t_('branch.barLabel', { n: '?' });
      const forkBarTimestamp = opts.forkBarTimestamp;
      const tsLabel = (Number.isFinite(forkBarTimestamp) && window.formatBarTime)
        ? window.formatBarTime(forkBarTimestamp)
        : null;
      const maxCursorLabel = opts.maxCursorLabel || '';
      const defaultName = opts.defaultName || 'branch-N';

      const lang = (window.I18n && window.I18n.lang) || 'zh';
      const CL = lang === 'en' ? {
        title:        'Trading in the past will fork',
        subtitle:     (where, parent) => `Cursor is at ${where},<br>but you've already seen the future bars.<br>This trade will create a new branch, isolating it from <strong>${parent}</strong>'s real timeline.`,
        seenLabel:    'Already seen',
        seenValue:    (max) => `up to <strong>${max}</strong>`,
        kindQuestion: 'What kind of exploration?',
        required:     'required',
        nameLabel:    'Branch name',
        noteLabel:    'Note',
        confirm:      'Create Branch',
      } : {
        title:        '回到過去下單會 fork',
        subtitle:     (where, parent) => `目前 cursor 在 ${where}，<br>但你已經看過後面的市場走勢。<br>這次下單會建立新分支，把這筆交易跟 <strong>${parent}</strong> 的真實時間線隔開。`,
        seenLabel:    '已看到',
        seenValue:    (max) => `最遠到 <strong>${max}</strong>`,
        kindQuestion: '這次探索的類型？',
        required:     '必選',
        nameLabel:    '分支名稱',
        noteLabel:    '備註',
        confirm:      '建立分支',
      };
      const whereStr = tsLabel
        ? `<strong>${_escape(tsLabel)}</strong> (${_escape(forkBarLabel)})`
        : _escape(forkBarLabel);

      const overlay = document.createElement('div');
      overlay.className = 'branch-modal-overlay';
      overlay.innerHTML = `
        <div class="branch-modal-backdrop"></div>
        <div class="branch-modal-card branch-modal-fod" role="dialog" aria-modal="true">
          <header class="branch-modal-header">
            <div class="branch-modal-icon icon-fork" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 4 L12 14 L19 4"/>
                <line x1="12" y1="14" x2="12" y2="20"/>
              </svg>
            </div>
            <div class="branch-modal-titles">
              <h3 class="branch-modal-title">${_escape(CL.title)}</h3>
              <p class="branch-modal-subtitle">${CL.subtitle(whereStr, _escape(parentName))}</p>
            </div>
          </header>

          <div class="branch-modal-body">
            ${maxCursorLabel ? `
              <div class="branch-modal-stats">
                <div class="branch-modal-stat-row">
                  <span class="branch-modal-stat-label">${_escape(CL.seenLabel)}</span>
                  <span class="branch-modal-stat-value">${CL.seenValue(_escape(maxCursorLabel))}</span>
                </div>
              </div>` : ''}

            <div class="branch-modal-section">
              <label class="branch-modal-label">
                ${_escape(CL.kindQuestion)}
                <span class="branch-modal-required">${_escape(CL.required)}</span>
              </label>
              <div class="branch-kind-picker" role="radiogroup">
                ${KIND_OPTIONS.map(_renderKindButton).join('')}
              </div>
            </div>

            <div class="branch-modal-section">
              <label class="branch-modal-label" for="branch-cjf-name">${_escape(CL.nameLabel)}</label>
              <input id="branch-cjf-name" type="text" class="branch-modal-input"
                     value="${_escape(defaultName)}" autocomplete="off" maxlength="40">
            </div>

            <div class="branch-modal-section">
              <label class="branch-modal-label" for="branch-cjf-note">${_escape(CL.noteLabel)} <span class="branch-modal-hint">${_escape(t_('branch.noteOptional'))}</span></label>
              <textarea id="branch-cjf-note" class="branch-modal-textarea" rows="2"
                        placeholder="${_escape(t_('branch.placeholderEntry'))}"></textarea>
            </div>
          </div>

          <footer class="branch-modal-actions">
            <button type="button" class="branch-modal-btn branch-modal-btn-secondary" data-action="cancel">${_escape(t_('common.cancel'))}</button>
            <button type="button" class="branch-modal-btn branch-modal-btn-primary"   data-action="fork" disabled>${_escape(CL.confirm)}</button>
          </footer>
        </div>
      `;
      root.appendChild(overlay);

      let selectedKind = null;
      const card     = overlay.querySelector('.branch-modal-card');
      const primary  = overlay.querySelector('[data-action="fork"]');
      const cancel   = overlay.querySelector('[data-action="cancel"]');
      const backdrop = overlay.querySelector('.branch-modal-backdrop');
      const nameInp  = overlay.querySelector('#branch-cjf-name');
      const noteInp  = overlay.querySelector('#branch-cjf-note');
      const kindBtns = Array.from(overlay.querySelectorAll('.branch-kind-btn'));

      for (const btn of kindBtns) {
        btn.addEventListener('click', () => {
          for (const b of kindBtns) {
            b.classList.remove('selected');
            b.setAttribute('aria-checked', 'false');
          }
          btn.classList.add('selected');
          btn.setAttribute('aria-checked', 'true');
          selectedKind = btn.dataset.kind;
          primary.disabled = false;
        });
      }

      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(result);
      };
      const onCancel = () => close({ confirmed: false });
      const onFork   = () => {
        if (!selectedKind) return;
        const name = nameInp.value.trim() || defaultName;
        const note = noteInp.value.trim();
        close({ confirmed: true, kind: selectedKind, name, note });
      };
      cancel.addEventListener('click',   onCancel);
      backdrop.addEventListener('click', onCancel);
      primary.addEventListener('click',  onFork);

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          onCancel();
          return;
        }
        if (e.key === 'Enter' && document.activeElement !== noteInp) {
          if (!primary.disabled) {
            e.preventDefault();
            onFork();
          }
        }
      };
      document.addEventListener('keydown', onKey, true);

      card.addEventListener('click', (e) => e.stopPropagation());

      requestAnimationFrame(() => {
        nameInp.focus();
        nameInp.select();
      });
    });
  }

  // Expose.
  window.BranchModals = {
    manualFork,
    forkOrDiscard,
    cursorJumpFork,
    deleteBranch,
    editNote,
    promotionFlow,
    promotionHistory,
    KIND_OPTIONS,    // exposed so other code can render kind labels consistently
  };
})();
