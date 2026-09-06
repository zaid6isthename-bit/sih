/**
 * state-sync.js — State Synchronization & Invalidation Manager.
 *
 * Tracks live DOM mutations, SPA navigation (pushState/replaceState/popstate),
 * scroll changes, and modal states. Maintains version tokens to detect stale
 * targets and race conditions, ensuring actions never execute on stale nodes.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  class StateSyncManager {
    constructor() {
      this.pageVersion = 1;
      this.invalidationVersion = 1;
      this.lastMutationTime = Date.now();
      this.isObserving = false;
      this.mutationCount = 0;
      this.observer = null;
      this.listeners = new Set();
      this.readinessState = "READY"; // READY | LOADING | NAVIGATING
      this.currentUrl = typeof location !== "undefined" ? location.href : "";

      this._init();
    }

    _init() {
      if (typeof window === "undefined" || typeof document === "undefined") return;

      // 1. DOM Mutation Observer
      if (typeof MutationObserver !== "undefined") {
        this.observer = new MutationObserver((mutations) => {
          this.mutationCount += mutations.length;
          this.lastMutationTime = Date.now();
          this.invalidationVersion++;
          this._notify("DOM_MUTATION", { mutationCount: mutations.length, invalidationVersion: this.invalidationVersion });
        });

        // Start observing when document body is available
        const attach = () => {
          if (document.body) {
            this.observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: false,
              attributeFilter: ["class", "style", "disabled", "aria-disabled", "hidden", "value"],
            });
            this.isObserving = true;
          }
        };

        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", attach, { once: true });
        } else {
          attach();
        }
      }

      // 2. SPA Navigation Interceptor (pushState / replaceState / popstate)
      const origPushState = history.pushState;
      if (origPushState) {
        history.pushState = (...args) => {
          const res = origPushState.apply(history, args);
          this._onUrlChange("pushState");
          return res;
        };
      }

      const origReplaceState = history.replaceState;
      if (origReplaceState) {
        history.replaceState = (...args) => {
          const res = origReplaceState.apply(history, args);
          this._onUrlChange("replaceState");
          return res;
        };
      }

      window.addEventListener("popstate", () => this._onUrlChange("popstate"));
      window.addEventListener("hashchange", () => this._onUrlChange("hashchange"));
    }

    _onUrlChange(trigger) {
      if (typeof location === "undefined") return;
      if (location.href !== this.currentUrl) {
        const prev = this.currentUrl;
        this.currentUrl = location.href;
        this.pageVersion++;
        this.invalidationVersion++;
        this._notify("SPA_NAVIGATION", { trigger, from: prev, to: this.currentUrl, pageVersion: this.pageVersion });
      }
    }

    _notify(event, data) {
      for (const fn of this.listeners) {
        try {
          fn(event, data);
        } catch (_) {}
      }
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    /**
     * Check if a target registered at a given invalidation version is still fresh.
     */
    isTargetFresh(targetInvalidationVersion, maxAllowedDrift = 1) {
      if (!targetInvalidationVersion) return true;
      return this.invalidationVersion - targetInvalidationVersion <= maxAllowedDrift;
    }

    /**
     * Shorthand: isFresh(version) — returns false if version is stale.
     */
    isFresh(version) {
      return this.isTargetFresh(version, 0);
    }

    /**
     * Programmatically trigger a mutation event (for testing or forced invalidation).
     */
    handleMutation() {
      this.mutationCount++;
      this.lastMutationTime = Date.now();
      this.invalidationVersion++;
      this._notify("DOM_MUTATION", { mutationCount: 1, invalidationVersion: this.invalidationVersion });
    }

    /**
     * Programmatically trigger a navigation event (for testing or forced invalidation).
     * Sets readinessState to LOADING and increments invalidation version.
     */
    handleNavigation(url) {
      const prev = this.currentUrl;
      if (url) this.currentUrl = url;
      this.pageVersion++;
      this.invalidationVersion++;
      this.readinessState = "LOADING";
      this._notify("NAVIGATION", { from: prev, to: this.currentUrl, pageVersion: this.pageVersion });
    }

    /**
     * Returns an opaque freshness token representing the current sync state.
     * Changes whenever the DOM is mutated or navigated.
     */
    getFreshnessToken() {
      return `v${this.invalidationVersion}-p${this.pageVersion}`;
    }

    /**
     * Mark DOM as fully interactive after navigation.
     */
    setReady() {
      this.readinessState = "READY";
      this._notify("READY", { invalidationVersion: this.invalidationVersion });
    }

    /**
     * Wait for DOM quiescence (no mutations for quiescentMs, bounded by timeoutMs).
     * Prevents acting mid-render during React/Vue updates or animation frames.
     */
    async waitForQuiescence(quiescentMs = 150, timeoutMs = 2000) {
      const startTime = Date.now();
      return new Promise((resolve) => {
        const check = () => {
          const elapsedSinceLastMutation = Date.now() - this.lastMutationTime;
          const totalElapsed = Date.now() - startTime;

          if (elapsedSinceLastMutation >= quiescentMs || totalElapsed >= timeoutMs) {
            resolve({ quiescent: elapsedSinceLastMutation >= quiescentMs, totalElapsed });
          } else {
            setTimeout(check, 40);
          }
        };
        check();
      });
    }

    destroy() {
      if (this.observer) {
        this.observer.disconnect();
        this.isObserving = false;
      }
      this.listeners.clear();
    }
  }

  PBA.StateSyncManager = StateSyncManager;
  // Shared in-page singleton
  PBA.stateSync = new StateSyncManager();
})();
