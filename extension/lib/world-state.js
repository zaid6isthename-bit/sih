/**
 * world-state.js — Canonical Browser World State representation for VisionGate.
 *
 * Implements structured BrowserWorldState capturing page, tabs, window, focus,
 * modals, authentication state, permission state, interactive elements, frames,
 * scroll containers, semantic summary, and world-state diff computation.
 *
 * Stored locally in the trusted client runtime.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  class BrowserWorldState {
    constructor(data = {}) {
      this.sessionId = data.sessionId || (PBA.newSessionId ? PBA.newSessionId() : "sess-" + Date.now());
      this.taskId = data.taskId || "task-0";
      this.stepId = data.stepId || 0;
      this.pageVersion = data.pageVersion || 1;
      this.tabVersion = data.tabVersion || 1;
      this.timestamp = data.timestamp || Date.now();

      // Page-level state
      this.page = Object.assign(
        {
          url: "",
          origin: "",
          title: "",
          favicon: "",
          loadingState: "complete", // loading, interactive, complete
          viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0, dpr: 1 },
          scroll: { x: 0, y: 0, maxScrollX: 0, maxScrollY: 0 },
          documentState: "ready",
        },
        data.page || {}
      );

      // Multi-tab / window state
      this.tabs = Array.isArray(data.tabs) ? data.tabs : [];
      this.activeTabId = data.activeTabId || null;
      this.window = Object.assign(
        { windowId: null, bounds: { x: 0, y: 0, w: 1280, h: 800 }, focused: true },
        data.window || {}
      );

      // Focus & Modals
      this.focus = Object.assign({ targetId: null, role: null, valueState: "empty" }, data.focus || {});
      this.modalState = Object.assign(
        { present: false, type: "none", targetIds: [], blocking: false, title: "" },
        data.modalState || {}
      );

      // Security / Auth State
      this.authenticationState = Object.assign(
        {
          status: "unknown", // none, logged_in, login_required, mfa_required, captcha_required
          formPresent: false,
          securityChallengePresent: false,
        },
        data.authenticationState || {}
      );

      this.permissionState = Object.assign(
        { activePermissions: [], pendingRequests: [] },
        data.permissionState || {}
      );

      // Structural Elements & Collections
      this.elements = Array.isArray(data.elements) ? data.elements : [];
      this.forms = Array.isArray(data.forms) ? data.forms : [];
      this.scrollContainers = Array.isArray(data.scrollContainers) ? data.scrollContainers : [];
      this.frames = Array.isArray(data.frames) ? data.frames : [];

      // Semantics & Summary
      this.extractedText = data.extractedText || "";
      this.pageSemanticSummary = data.pageSemanticSummary || "";
      this.previousAction = data.previousAction || null;
      this.previousActionResult = data.previousActionResult || null;
    }

    /**
     * Compute a structured diff against a previous world state.
     * Essential for generic post-condition verification and state sync.
     */
    static diff(before, after) {
      if (!before || !after) return { hasChanged: true, changes: ["initial_observation"] };

      const changes = [];
      const details = {};

      // URL / Navigation change
      if (before.page.url !== after.page.url) {
        changes.push("URL_CHANGED");
        details.url = { from: before.page.url, to: after.page.url };
      }
      if (before.page.origin !== after.page.origin) {
        changes.push("ORIGIN_CHANGED");
        details.origin = { from: before.page.origin, to: after.page.origin };
      }

      // Title change
      if (before.page.title !== after.page.title) {
        changes.push("TITLE_CHANGED");
        details.title = { from: before.page.title, to: after.page.title };
      }

      // Modal state change
      if (before.modalState.present !== after.modalState.present || before.modalState.type !== after.modalState.type) {
        changes.push(after.modalState.present ? "MODAL_OPENED" : "MODAL_CLOSED");
        details.modal = { from: before.modalState, to: after.modalState };
      }

      // Auth state change
      if (before.authenticationState.status !== after.authenticationState.status) {
        changes.push("AUTH_STATE_CHANGED");
        details.auth = { from: before.authenticationState.status, to: after.authenticationState.status };
      }

      // Scroll position change
      const scrollDiffY = Math.abs(after.page.scroll.y - before.page.scroll.y);
      if (scrollDiffY > 20) {
        changes.push("SCROLLED");
        details.scroll = { dy: after.page.scroll.y - before.page.scroll.y };
      }

      // Active Element / Focus change
      if (before.focus.targetId !== after.focus.targetId) {
        changes.push("FOCUS_CHANGED");
        details.focus = { from: before.focus.targetId, to: after.focus.targetId };
      }

      // Elements diff (appearance / disappearance / value changes)
      const beforeMap = new Map((before.elements || []).map((e) => [e.stable_id || e.id, e]));
      const afterMap = new Map((after.elements || []).map((e) => [e.stable_id || e.id, e]));

      let appeared = 0;
      let disappeared = 0;
      let valueChanged = 0;
      const changedElements = [];

      for (const [id, aEl] of afterMap.entries()) {
        const bEl = beforeMap.get(id);
        if (!bEl) {
          appeared++;
        } else if (bEl.value_state !== aEl.value_state || bEl.enabled !== aEl.enabled) {
          valueChanged++;
          changedElements.push({ id, role: aEl.role, label: aEl.label, from: bEl.value_state, to: aEl.value_state });
        }
      }

      for (const id of beforeMap.keys()) {
        if (!afterMap.has(id)) {
          disappeared++;
        }
      }

      if (appeared > 0) changes.push(`ELEMENTS_APPEARED_${appeared}`);
      if (disappeared > 0) changes.push(`ELEMENTS_DISAPPEARED_${disappeared}`);
      if (valueChanged > 0) {
        changes.push("VALUES_CHANGED");
        details.changedElements = changedElements;
      }

      return {
        hasChanged: changes.length > 0,
        changes,
        details,
        timestamp: Date.now(),
      };
    }
  }

  PBA.BrowserWorldState = BrowserWorldState;
})();
