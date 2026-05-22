/**
 * branch_engine.js — Branching replay session manager (counterfactual
 * what-if timelines).
 *
 * Pure data + persistence, no DOM. Sits alongside sim_engine.js: this
 * module owns the "which timeline am I on" state, sim_engine.js owns
 * order matching + position lifecycle. Trades are physically stored in
 * sim_engine.js but tagged with `branchId` so we can filter / aggregate
 * them per branch.
 *
 * Spec: docs/specs/branching-replay-spec.md (read §1.3 first — this
 * feature's whole point is to keep the user aware of overfitting risk;
 * the safeguards in §4.3 are NOT optional).
 *
 * Data model (spec §2):
 *
 *   class Branch {
 *     id;              // 'main' | 'b1' | 'b2' | ... | 'archived-main-N' | ...
 *     name;            // user-editable display name
 *     kind;            // 'main' | 'exec' | 'direction' | 'sandbox' | 'archived'
 *     parentId;        // null for original main; branch id otherwise
 *     forkBar;         // bar index where this branch diverges from parent
 *     forkBarTimestamp;// timestamp of the fork bar (TF-invariant lookup)
 *     createdAt;       // unix ms
 *     note;            // free-text user note (optional but encouraged)
 *     promotionMeta;   // null | { promotedFrom, promotedAt, reason, promotedBy }
 *   }
 *
 *   class BranchSession {
 *     branches;            // Map<id, Branch>
 *     activeBranchId;      // currently *viewed* branch
 *     mainBranchId;        // canonical "real" timeline (changes only on promotion)
 *     miniBranchId;        // displayed in the mini chart (null if closed)
 *     promotionHistory;    // [{ from, to, at, reason }]
 *     contaminationCount;  // = promotionHistory.length
 *   }
 *
 * Trade attribution: every order placed via SimController is stamped
 * with `branchId: BranchEngine.activeBranchId` and the resulting
 * SimPosition inherits that branchId. Filter helpers below walk the
 * sim engine's history and bucket by branchId.
 *
 * Phase 1 scope: data model + CRUD + persistence + getOwn/Inherited/AllTrades.
 * Promotion (§4.3) is Phase 6 — deliberately out of scope here.
 */
(function () {
  const STORAGE_KEY = 'chart_viewer.branch_session';
  const SESSION_VERSION = 1;

  // Listener registry for branchCreated / branchDeleted / branchRenamed /
  // branchPromoted / activeBranchChanged / miniBranchChanged events. The
  // panel + chart-side ⋎ markers subscribe to re-render.
  const _listeners = new Map();

  let _session = null;
  // Branch IDs (the b1, b2, ...). Reset on import. The sentinel `main`
  // is always present and never numbered.
  let _nextBranchSeq = 1;

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------
  function emit(event, data) {
    const set = _listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try { handler(data); }
      catch (e) { console.warn('[branch_engine] listener for', event, 'threw', e); }
    }
  }

  function on(event, handler) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(handler);
    return () => {
      const set = _listeners.get(event);
      if (set) set.delete(handler);
    };
  }

  function _allocBranchId() {
    return 'b' + (_nextBranchSeq++);
  }

  /** Normalize a note value to the `{ title, body }` schema. Accepts:
   *    - string  → { title: '', body: <string> }   (legacy)
   *    - object  → { title, body } with empty defaults
   *    - null/undefined → { title: '', body: '' }
   *  Centralizing here keeps load(), createBranch, updateNote, and
   *  forkOrDiscard create paths consistent. */
  function _normalizeNote(note) {
    if (note == null) return { title: '', body: '' };
    if (typeof note === 'string') return { title: '', body: note };
    if (typeof note === 'object') {
      return {
        title: String(note.title || ''),
        body:  String(note.body  || ''),
      };
    }
    return { title: '', body: '' };
  }

  function _makeBranch(opts) {
    return {
      id: opts.id,
      name: opts.name || opts.id,
      kind: opts.kind || 'exec',
      parentId: opts.parentId == null ? null : opts.parentId,
      forkBar: Number.isFinite(opts.forkBar) ? opts.forkBar : null,
      forkBarTimestamp: Number.isFinite(opts.forkBarTimestamp)
        ? opts.forkBarTimestamp : null,
      createdAt: Number.isFinite(opts.createdAt) ? opts.createdAt : Date.now(),
      note: _normalizeNote(opts.note),
      promotionMeta: opts.promotionMeta || null,
    };
  }

  function _newSession() {
    _nextBranchSeq = 1;
    const main = _makeBranch({
      id: 'main',
      name: '主線',
      kind: 'main',
      parentId: null,
      forkBar: null,
      forkBarTimestamp: null,
    });
    return {
      branches: new Map([[main.id, main]]),
      activeBranchId: 'main',
      mainBranchId: 'main',
      miniBranchId: null,
      promotionHistory: [],
      contaminationCount: 0,
    };
  }

  // ------------------------------------------------------------------
  // Persistence (server-backed, layout-scoped)
  //
  // Branch metadata only — actual trades live in sim_engine and persist
  // separately via SimController.loadForLayout / _markDirty. The two
  // storage layers are independent: BranchEngine writes
  // `user_data/layouts/<id>/branch_session.json`; SimEngine writes
  // `user_data/layouts/<id>/sim/<symbol>.json`. They join on `branchId`
  // tags carried on each order/position.
  //
  // Boot rule: `init()` seeds a default empty session synchronously
  // (so any code touching `BranchEngine.activeBranchId` early in boot
  // gets 'main' instead of crashing). `loadForLayout(layoutId)` is
  // called async by app.js once the layout id is known and overwrites
  // the seeded session with whatever the server has.
  //
  // Save path: every mutation already calls `save()`; we keep that
  // call site shape but route through a 250ms debounce →
  // `PUT /api/branch?layout=<id>`. localStorage is no longer used —
  // user requested no migration (existing localStorage state was test
  // data only).
  // ------------------------------------------------------------------
  let _layoutId = null;
  let _saveTimer = null;
  let _saveDelayMs = 250;
  let _saving = false;
  let _dirty = false;

  function _serialize() {
    if (!_session) return null;
    return {
      version: SESSION_VERSION,
      activeBranchId: _session.activeBranchId,
      mainBranchId: _session.mainBranchId,
      miniBranchId: _session.miniBranchId,
      promotionHistory: _session.promotionHistory.slice(),
      contaminationCount: _session.contaminationCount,
      branches: Array.from(_session.branches.values()),
      _nextBranchSeq,
    };
  }

  function _deserialize(json) {
    if (!json || json.version !== SESSION_VERSION) return _newSession();
    _nextBranchSeq = Number.isFinite(json._nextBranchSeq) ? json._nextBranchSeq : 1;
    const branches = new Map();
    for (const b of (json.branches || [])) {
      // _makeBranch normalizes any missing fields from older serializations.
      const branch = _makeBranch(b);
      // Migration: clear stale fork data on any branch that was once
      // promoted to main. Two trigger conditions:
      //   - kind === 'main'           — current main can never have
      //                                 a fork point (it's root).
      //   - promotionMeta !== null    — this branch was promoted at
      //                                 least once. Even if it has
      //                                 since been re-archived, the
      //                                 forkBar from its pre-first-
      //                                 promotion era is meaningless
      //                                 ("從哪裡 fork" lost relevance
      //                                 the moment it took the main
      //                                 role).
      // Without this, sessions promoted before the engine's
      // fork-clear fix shipped (commit 82cae60) still render a
      // chart-side ⋎ marker on archived-main-N at the bar where
      // they originally forked from their parent — the user-visible
      // bug reported after Phase 6 went live.
      if (branch.kind === 'main' || branch.promotionMeta) {
        branch.forkBar = null;
        branch.forkBarTimestamp = null;
        branch.parentId = null;
      }
      branches.set(branch.id, branch);
    }
    // Defensive: ensure 'main' branch always exists, regardless of save state.
    // Spec §2 invariant 1: "There is always exactly one branch with kind: 'main'."
    if (!branches.has('main')) {
      const main = _makeBranch({ id: 'main', name: '主線', kind: 'main' });
      branches.set('main', main);
    }
    return {
      branches,
      activeBranchId: json.activeBranchId && branches.has(json.activeBranchId)
        ? json.activeBranchId : 'main',
      mainBranchId: json.mainBranchId && branches.has(json.mainBranchId)
        ? json.mainBranchId : 'main',
      miniBranchId: json.miniBranchId && branches.has(json.miniBranchId)
        ? json.miniBranchId : null,
      promotionHistory: Array.isArray(json.promotionHistory)
        ? json.promotionHistory.slice() : [],
      contaminationCount: Number.isFinite(json.contaminationCount)
        ? json.contaminationCount : 0,
    };
  }

  /** Mark dirty and schedule a debounced PUT. All existing call sites
   *  (createBranch / deleteBranch / setActiveBranch / etc.) keep
   *  calling `save()` exactly as before — we just changed where the
   *  bytes end up. */
  function save() {
    if (!_session) return;
    _dirty = true;
    if (_saveTimer != null) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      _flush();
    }, _saveDelayMs);
  }

  async function _flush() {
    if (!_dirty) return;
    if (_saving) { save(); return; }     // re-queue mid-flight
    if (!_layoutId || !_session) return;
    const body = _serialize();
    _dirty = false;
    _saving = true;
    try {
      await fetch(`/api/branch?layout=${encodeURIComponent(_layoutId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.warn('[branch_engine] PUT failed', e);
      _dirty = true;
    } finally {
      _saving = false;
    }
  }

  /** Return the current serialized session iff there's a pending
   *  unsaved change. Used by app.js beforeunload — sendBeacon needs
   *  the bytes synchronously, so we can't await _flush. Returns null
   *  when nothing is dirty (caller skips the beacon). */
  function snapshotForBeacon() {
    if (!_dirty || !_session || !_layoutId) return null;
    return _serialize();
  }

  /** Force-flush any pending save synchronously-ish. Awaited by
   *  layout switch + before-unload to make sure the outgoing layout's
   *  branch session lands on disk before we either swap or close. */
  async function flushNow() {
    if (_saveTimer != null) {
      clearTimeout(_saveTimer);
      _saveTimer = null;
    }
    if (!_dirty) return;
    await _flush();
  }

  /** Async load — called by app.js after openLayout resolves a real
   *  layout id. Replaces the default-empty session seeded by `init()`.
   *  Emits 'sessionLoaded' so the panel + mini + markers redraw. */
  async function loadForLayout(layoutId) {
    await flushNow();                    // save outgoing first
    _layoutId = layoutId || null;
    _session = _newSession();            // start clean
    if (!layoutId) {
      emit('sessionLoaded', { id: null });
      return;
    }
    try {
      const r = await fetch(`/api/branch?layout=${encodeURIComponent(layoutId)}`,
        { cache: 'no-store' });
      if (r.ok) {
        const json = await r.json();
        if (json) _session = _deserialize(json);
      }
    } catch (e) {
      console.warn('[branch_engine] loadForLayout fetch failed', e);
    }
    _dirty = false;
    emit('sessionLoaded', { id: layoutId });
    // Existing listeners (BranchPanel, MiniChart, fork markers) are
    // wired to 'activeBranchChanged' / 'miniBranchChanged' to redraw.
    // After a fresh load we want them to redraw too — emit those
    // events with the just-loaded ids so consumers refresh without
    // having to add a new subscription.
    emit('activeBranchChanged', { id: _session.activeBranchId });
    emit('miniBranchChanged',   { id: _session.miniBranchId });
  }

  // ------------------------------------------------------------------
  // Public API — bootstrapping
  // ------------------------------------------------------------------
  function init() {
    // Seed an empty session synchronously so any early access (before
    // app.js has called loadForLayout) returns sensible defaults.
    if (_session) return;
    _session = _newSession();
  }

  /** Wipe the session back to a single 'main' branch. Test/debug aid;
   *  user-facing reset would go through individual deleteBranch calls. */
  function _resetForTests() {
    _session = _newSession();
    save();
  }

  // ------------------------------------------------------------------
  // Public API — read accessors
  // ------------------------------------------------------------------
  function getSession() { return _session; }
  function getBranches() { return _session ? Array.from(_session.branches.values()) : []; }
  function getBranch(id) { return _session ? (_session.branches.get(id) || null) : null; }
  function getActiveBranch() { return _session ? getBranch(_session.activeBranchId) : null; }
  function getMainBranch() { return _session ? getBranch(_session.mainBranchId) : null; }

  // ------------------------------------------------------------------
  // Public API — mutators
  // ------------------------------------------------------------------
  function setActiveBranch(id) {
    if (!_session || !_session.branches.has(id)) return false;
    if (_session.activeBranchId === id) return false;
    _session.activeBranchId = id;
    emit('activeBranchChanged', { id });
    save();
    return true;
  }

  function setMiniBranch(id) {
    if (!_session) return false;
    // Allow null to clear. Otherwise must be an existing branch.
    if (id != null && !_session.branches.has(id)) return false;
    if (_session.miniBranchId === id) return false;
    _session.miniBranchId = id;
    emit('miniBranchChanged', { id });
    save();
    return true;
  }

  /** Create a new branch.
   *
   *  Required: kind. Optional: name (auto-generated from sequence if
   *  missing), parentId (defaults to current activeBranchId), forkBar
   *  + forkBarTimestamp (defaults to null — for branches that don't
   *  diverge at a specific bar, e.g. the original main; non-main
   *  branches typically supply both).
   *
   *  Returns the new Branch object. Emits 'branchCreated'.
   */
  function createBranch(opts = {}) {
    if (!_session) init();
    const id = opts.id || _allocBranchId();
    const parentId = opts.parentId || _session.activeBranchId;
    if (!_session.branches.has(parentId)) {
      throw new Error('[branch_engine] createBranch: parent does not exist: ' + parentId);
    }
    const branch = _makeBranch({
      id,
      name: opts.name || ('branch-' + (_session.branches.size)),
      kind: opts.kind || 'exec',
      parentId,
      forkBar: opts.forkBar,
      forkBarTimestamp: opts.forkBarTimestamp,
      note: opts.note,
    });
    _session.branches.set(id, branch);
    emit('branchCreated', { id, branch });
    save();
    return branch;
  }

  /** Delete a branch.
   *
   *  Spec §2 invariants:
   *  - The 'main' branch (kind === 'main') CANNOT be deleted (return false).
   *  - Children re-parent to the deleted branch's parent (git-style).
   *  - If the deleted branch was active or in the mini chart, those
   *    references fall back to mainBranchId / null respectively.
   */
  function deleteBranch(id) {
    if (!_session) return false;
    const b = _session.branches.get(id);
    if (!b) return false;
    if (b.kind === 'main') return false;            // immortal — see spec §2
    // Re-parent children
    for (const child of _session.branches.values()) {
      if (child.parentId === id) {
        child.parentId = b.parentId || _session.mainBranchId;
      }
    }
    _session.branches.delete(id);
    let activeChanged = false, miniChanged = false;
    if (_session.activeBranchId === id) {
      _session.activeBranchId = _session.mainBranchId;
      activeChanged = true;
    }
    if (_session.miniBranchId === id) {
      _session.miniBranchId = null;
      miniChanged = true;
    }
    emit('branchDeleted', { id });
    if (activeChanged) emit('activeBranchChanged', { id: _session.activeBranchId });
    if (miniChanged) emit('miniBranchChanged', { id: null });
    save();
    return true;
  }

  /** Promote a branch to be the canonical 'main' timeline.
   *
   *  Per spec §4.3 — heaviest mutation in the engine. The old main
   *  is archived (not deleted; trades on it stay attributed there
   *  forever per spec §2.1). The target's `promotionMeta` records
   *  the audit trail (who was promoted from, when, why). Session-
   *  level `contaminationCount` increments — this number can never
   *  decrease, even via subsequent promotion / archive operations.
   *
   *  Validation rules (engine layer; the modal also enforces these
   *  client-side but final defense lives here):
   *  - `targetId` must exist.
   *  - target.kind must NOT already be 'main' (no-op).
   *  - target cannot be the current `mainBranchId`.
   *  - `reason` must be a string of ≥20 trimmed chars (spec §4.3).
   *
   *  Behavior:
   *  - oldMain.kind         → 'archived' (name preserved)
   *  - target.kind          → 'main'
   *  - target.promotionMeta → snapshot (promotedFrom, at, reason)
   *  - session.mainBranchId → targetId
   *  - session.contaminationCount += 1
   *  - session.promotionHistory.push({ from, to, at, reason })
   *
   *  Re-promoting an archived branch back to main is allowed (spec
   *  §5.5 mentions "從 archived-main-N 重新升格回去") — same code
   *  path; the branch's kind flips from 'archived' to 'main'. Each
   *  promotion adds a new contaminationCount + history row.
   *
   *  Returns `true` on success, `false` if any validation fails.
   *  Caller (modal) is expected to surface specific error messages
   *  via its own validation pass before calling this. */
  function promoteBranch(targetId, reason) {
    if (!_session) return false;
    if (!targetId) return false;
    if (typeof reason !== 'string') return false;
    const trimmed = reason.trim();
    if (trimmed.length < 20) return false;
    const target = _session.branches.get(targetId);
    if (!target) return false;
    if (target.kind === 'main') return false;
    const oldMainId = _session.mainBranchId;
    if (target.id === oldMainId) return false;
    const oldMain = _session.branches.get(oldMainId);
    if (!oldMain) return false;     // §2 invariant violation; bail safely

    const ts = Date.now();
    const newContamCount = (_session.contaminationCount || 0) + 1;

    oldMain.kind = 'archived';
    // spec §4.3: 「Old main → renamed to `archived-main-${N}`」.
    // The user's original main name (e.g. "主線" or "我的策略") is
    // intentionally overwritten — once the branch loses its main role
    // its identity is the "Nth historical main", not whatever the
    // user used to call it. The history still preserves the old name
    // implicitly via the original main being branch id 'main' at
    // session creation; if you need it back you can rename via the
    // panel after promotion.
    oldMain.name = `archived-main-${newContamCount}`;
    // The promoted branch keeps its user-given name. spec phrasing
    // "renamed to `main`" reads strictly as "given the main role" —
    // the kind flip below is what carries that semantic. Renaming
    // the user's "緊停損測試" to "main" would lose the audit trail
    // ("I promoted *that specific tested idea* to main", not just
    // "I have a main branch").
    target.kind = 'main';
    // spec §5.2 says we render a ⋎ chart marker at every branch's
    // forkBar. After promotion the target IS the new main — it has
    // no parent fork point any more, conceptually it's now a root.
    // Without clearing these, the chart shows a stale ⋎ on the bar
    // where the now-main branched off (visible bug user reported).
    // Same logic applies to the panel row's "自 X 起" meta line.
    // The forkBar of an archived branch we re-promote later was
    // already null from creation (main has no fork), so this clear
    // is idempotent across re-promotions.
    target.forkBar = null;
    target.forkBarTimestamp = null;
    target.parentId = null;
    target.promotionMeta = {
      promotedFrom: oldMainId,
      promotedAt:   ts,
      reason:       trimmed,
      promotedBy:   null,            // reserved for future user identity
    };

    _session.mainBranchId       = target.id;
    _session.contaminationCount = newContamCount;
    if (!Array.isArray(_session.promotionHistory)) {
      _session.promotionHistory = [];
    }
    _session.promotionHistory.push({
      from:   oldMainId,
      to:     target.id,
      at:     ts,
      reason: trimmed,
    });

    // The two `branchUpdated` emits fire BEFORE branchPromoted so
    // listeners that incrementally re-render (panel rows, fork
    // markers) see the updated `kind` colors before any
    // promotion-specific UI like the contamination warning paints.
    emit('branchUpdated', { id: oldMainId });
    emit('branchUpdated', { id: target.id });
    emit('branchPromoted', {
      from: oldMainId, to: target.id, at: ts, reason: trimmed,
    });
    save();
    return true;
  }

  function renameBranch(id, newName) {
    if (!_session) return false;
    const b = _session.branches.get(id);
    if (!b) return false;
    if (!newName || !newName.trim()) return false;
    b.name = newName.trim();
    emit('branchRenamed', { id, name: b.name });
    save();
    return true;
  }

  /** Update a branch's note. Accepts a string (legacy → body only) or
   *  a `{ title, body }` object. Either way it's normalized to the
   *  object schema so downstream consumers (panel render, modals)
   *  can treat `branch.note.title` / `branch.note.body` directly. */
  function updateNote(id, note) {
    if (!_session) return false;
    const b = _session.branches.get(id);
    if (!b) return false;
    b.note = _normalizeNote(note);
    emit('branchUpdated', { id });
    save();
    return true;
  }

  // ------------------------------------------------------------------
  // Trade attribution
  //
  // Trades physically live in sim_engine.js (positionHistory + open
  // positions). Each carries `branchId` set at creation time. The
  // helpers below filter the engine's view by branchId.
  // ------------------------------------------------------------------

  /** Walk parentId chain from `id` up to root. Returns [self, parent,
   *  grandparent, ...]. */
  function getAncestorChain(id) {
    if (!_session) return [];
    const chain = [];
    let cur = _session.branches.get(id);
    while (cur) {
      chain.push(cur.id);
      if (!cur.parentId) break;
      cur = _session.branches.get(cur.parentId);
    }
    return chain;
  }

  function _enginePositions() {
    const eng = window.SimController && window.SimController.engine;
    if (!eng) return [];
    return eng.getPositionHistory().concat(eng.getPositions());
  }

  /** Trades placed *on* this branch (branchId === id). */
  function getOwnTrades(id) {
    return _enginePositions().filter(p => p.branchId === id);
  }

  /** Trades inherited from ancestor branches up to this branch's
   *  forkBarTimestamp. Spec §2.1: ancestor trades that closed at-or-
   *  before the fork bar are visible to this branch as inherited
   *  history. Trades that occurred on the parent AFTER the fork are
   *  invisible (different timeline).
   *
   *  For the original main branch (forkBarTimestamp == null), there's
   *  no parent timeline to inherit from — returns []. */
  function getInheritedTrades(id) {
    if (!_session) return [];
    const branch = _session.branches.get(id);
    if (!branch || !Number.isFinite(branch.forkBarTimestamp)) return [];
    const ancestors = getAncestorChain(id).slice(1); // exclude self
    if (!ancestors.length) return [];
    const ancestorSet = new Set(ancestors);
    return _enginePositions().filter(p => {
      if (!p.branchId || !ancestorSet.has(p.branchId)) return false;
      // openedAtBarTs is the entry timestamp; closed-or-still-open both
      // count as "ancestral" if entered ≤ forkBarTimestamp. (Open
      // positions at the fork are cloned per spec §2.1, but for now we
      // just visualize them as inherited history.)
      return p.openedAtBarTs != null && p.openedAtBarTs <= branch.forkBarTimestamp;
    });
  }

  function getAllTrades(id) {
    return getInheritedTrades(id).concat(getOwnTrades(id));
  }

  /** Compute the maximum visible-trade-timestamp for every branch in
   *  `branchId`'s ancestor chain (spec §2.1).
   *
   *  Returns Map<branchId, cutoffTimestamp>. The cutoff for any
   *  ancestor is the running min of forkBarTimestamps from active down
   *  to (but not including) the ancestor — because at every fork, only
   *  trades up to the forking branch's fork-point carry forward.
   *
   *  Example chain  C ← B ← main
   *    - C has its own trades (no cutoff, returned as `Infinity`)
   *    - B trades visible to C iff opened ≤ C.forkBarTimestamp
   *    - main trades visible to C iff opened ≤ min(C.forkBarTs, B.forkBarTs)
   *
   *  Branches NOT in the ancestor chain are absent from the result —
   *  callers should treat "missing branchId" as "different timeline,
   *  invisible".
   *
   *  Used by sim_overlays.js _syncTradeArrows to decide which trade
   *  arrows to render and which to skip when the user is viewing a
   *  branch other than the trade's home branch. */
  function getVisibleTradeCutoffs(branchId) {
    const out = new Map();
    if (!_session) return out;
    const chain = getAncestorChain(branchId);
    if (!chain.length) return out;
    // chain[0] = self → own trades, no cutoff
    out.set(chain[0], Infinity);
    let runningMin = Infinity;
    for (let i = 1; i < chain.length; i++) {
      // The branch one step closer to active (chain[i-1]) is the link
      // that needed to "see" the trade. Its forkBarTimestamp is the
      // limit applied at this step.
      const closer = _session.branches.get(chain[i - 1]);
      if (closer && Number.isFinite(closer.forkBarTimestamp)) {
        runningMin = Math.min(runningMin, closer.forkBarTimestamp);
      }
      out.set(chain[i], runningMin);
    }
    return out;
  }

  /** Sum realised + unrealised PnL net of commission for every trade
   *  on (or inherited by) this branch. */
  function getNetPL(id) {
    let sum = 0;
    for (const p of getAllTrades(id)) {
      const realised = Number.isFinite(p.realisedPnL) ? p.realisedPnL : 0;
      const unreal = Number.isFinite(p.unrealisedPnL) ? p.unrealisedPnL : 0;
      const comm = Number.isFinite(p.commissionPaid) ? p.commissionPaid : 0;
      sum += realised + unreal - comm;
    }
    return sum;
  }

  // ------------------------------------------------------------------
  // Expose
  // ------------------------------------------------------------------
  window.BranchEngine = {
    init,
    loadForLayout,
    flushNow,
    snapshotForBeacon,
    on,
    save,
    // Read
    getSession,
    getBranches,
    getBranch,
    getActiveBranch,
    getMainBranch,
    getAncestorChain,
    // Mutate
    setActiveBranch,
    setMiniBranch,
    createBranch,
    deleteBranch,
    renameBranch,
    updateNote,
    promoteBranch,
    // Trade attribution
    getOwnTrades,
    getInheritedTrades,
    getAllTrades,
    getNetPL,
    getVisibleTradeCutoffs,
    // Convenience getters (spec §7.5: sim_engine consults these)
    get activeBranchId() { return _session ? _session.activeBranchId : 'main'; },
    get mainBranchId() { return _session ? _session.mainBranchId : 'main'; },
    get miniBranchId() { return _session ? _session.miniBranchId : null; },
    get contaminationCount() { return _session ? _session.contaminationCount : 0; },
    // Test aids
    _resetForTests,
    _STORAGE_KEY: STORAGE_KEY,
  };
})();
