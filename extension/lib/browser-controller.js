/**
 * browser-controller.js — Privileged Browser Controller for VisionGate.
 *
 * Runs in the extension background service worker. Owns privileged browser
 * control operations (tabs, windows, navigation, downloads, and navigation waits)
 * without exposing raw privileged APIs to the remote model.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});
  const ext = root.browser || root.chrome;

  class BrowserController {
    constructor() {
      this.tabStates = new Map(); // tabId -> { url, title, lastObserved, version }
    }

    /**
     * Get active tab information
     */
    async getActiveTab() {
      if (!ext || !ext.tabs) return null;
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    }

    /**
     * Get all open tabs in current window
     */
    async getAllTabs() {
      if (!ext || !ext.tabs) return [];
      const tabs = await ext.tabs.query({ currentWindow: true });
      return (tabs || []).map((t) => ({
        tabId: t.id,
        url: t.url,
        title: t.title,
        active: !!t.active,
        loading: t.status === "loading",
      }));
    }

    /**
     * Navigate tab to URL
     */
    async navigate(tabId, url) {
      if (ext && ext.tabs) {
        const tab = await ext.tabs.get(tabId).catch(() => null);
        const baseUrl = (tab && tab.url) || "about:blank";
        const targetUrl = new URL(url, baseUrl).href;
        await ext.tabs.update(tabId, { url: targetUrl });
        await this.waitForNavigation(tabId);
        return { success: true, url: targetUrl };
      }
      if (typeof location !== "undefined") {
        location.href = url;
        return { success: true, url };
      }
      throw new Error("TABS_API_UNAVAILABLE");
    }

    async goBack(tabId) {
      if (ext && ext.tabs) {
        await ext.tabs.goBack(tabId);
        await this.waitForNavigation(tabId);
        return { success: true };
      }
      if (typeof history !== "undefined") {
        history.back();
        return { success: true };
      }
      throw new Error("TABS_API_UNAVAILABLE");
    }

    async goForward(tabId) {
      if (ext && ext.tabs) {
        await ext.tabs.goForward(tabId);
        await this.waitForNavigation(tabId);
        return { success: true };
      }
      if (typeof history !== "undefined") {
        history.forward();
        return { success: true };
      }
      throw new Error("TABS_API_UNAVAILABLE");
    }

    async reload(tabId) {
      if (ext && ext.tabs) {
        await ext.tabs.reload(tabId);
        await this.waitForNavigation(tabId);
        return { success: true };
      }
      if (typeof location !== "undefined") {
        location.reload();
        return { success: true };
      }
      throw new Error("TABS_API_UNAVAILABLE");
    }

    async openNewTab(url = "about:blank") {
      if (ext && ext.tabs) {
        const tab = await ext.tabs.create({ url, active: true });
        if (url !== "about:blank") {
          await this.waitForNavigation(tab.id);
        }
        return { success: true, tabId: tab.id };
      }
      if (typeof window !== "undefined" && window.open) {
        window.open(url, "_blank");
        return { success: true, tabId: "inpage-tab-" + Date.now() };
      }
      throw new Error("TABS_API_UNAVAILABLE");
    }

    async closeTab(tabId) {
      if (ext && ext.tabs) {
        await ext.tabs.remove(tabId);
        return { success: true, closedTabId: tabId };
      }
      if (typeof window !== "undefined" && window.close) {
        window.close();
        return { success: true, closedTabId: tabId };
      }
      throw new Error("TABS_API_UNAVAILABLE");
    }

    async switchTab(tabId) {
      if (ext && ext.tabs) {
        await ext.tabs.update(tabId, { active: true });
        return { success: true, activeTabId: tabId };
      }
      return { success: true, activeTabId: tabId };
    }

    async triggerDownload(url, filename) {
      if (ext && ext.downloads) {
        const downloadId = await ext.downloads.download({
          url,
          filename: filename || undefined,
          saveAs: false,
        });
        return { success: true, downloadId };
      }
      return { success: true, downloadId: "mock-dl-" + Date.now(), url };
    }

    /**
     * Wait for tab navigation to reach "complete" state.
     */
    waitForNavigation(tabId, timeoutMs = 15000) {
      if (!ext || !ext.tabs) return Promise.resolve(true);

      return new Promise((resolve) => {
        let timer = null;

        const onUpdated = (updatedId, changeInfo) => {
          if (updatedId === tabId && changeInfo.status === "complete") {
            cleanup();
            resolve(true);
          }
        };

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          try {
            ext.tabs.onUpdated.removeListener(onUpdated);
          } catch (_) {}
        };

        ext.tabs.onUpdated.addListener(onUpdated);

        timer = setTimeout(() => {
          cleanup();
          resolve(false); // Timed out waiting for complete
        }, timeoutMs);

        // Pre-check if already complete
        ext.tabs.get(tabId).then((t) => {
          if (t && t.status === "complete") {
            cleanup();
            resolve(true);
          }
        }).catch(() => {});
      });
    }
  }

  PBA.BrowserController = BrowserController;
  PBA.browserController = new BrowserController();
})();
