/**
 * local-secret-handler.js — Local Profile & Secret Management for VisionGate.
 *
 * Stores sensitive credentials and profile fields strictly on the local device.
 * Never exposes raw secret values to remote reasoning models, outbound network
 * requests, debug logs, or telemetry streams.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});
  const ext = root.browser || root.chrome;

  // Categories that are strictly NEVER_EXPOSE under any circumstance
  const NEVER_EXPOSE = new Set([
    "password", "otp", "cvv", "api_key", "session_token",
    "private_key", "banking_secret", "passcode"
  ]);

  class LocalSecretHandler {
    constructor() {
      this.vault = {}; // local in-memory cache of profile
      this.lastFilledField = null;
      this.refresh();
    }

    async refresh() {
      try {
        if (ext && ext.storage && ext.storage.local) {
          const res = await ext.storage.local.get("vault");
          if (res && res.vault && typeof res.vault === "object") {
            this.vault = { ...res.vault };
          }
        }
      } catch (_) {}
    }

    /**
     * Check if a field name represents a strictly non-transmissible secret
     */
    isNeverExpose(fieldName) {
      if (!fieldName) return false;
      const lower = String(fieldName).toLowerCase();
      for (const cat of NEVER_EXPOSE) if (lower.includes(cat)) return true;
      return false;
    }

    set(key, value) {
      this.vault[key] = value;
    }

    get(key) {
      return this.vault[key];
    }

    /**
     * Get available field keys (metadata only — never values)
     */
    getAvailableKeys() {
      return Object.keys(this.vault);
    }

    /**
     * Fill a live DOM element directly with a local secret/profile value.
     * The raw value remains in this local scope and is never returned in observations.
     */
    async fillField(targetNode, fieldName) {
      if (!targetNode) {
        return { success: false, reason: "TARGET_NODE_MISSING" };
      }
      await this.refresh();

      const key = (fieldName || "").toLowerCase();
      // Normalize common synonyms
      let resolvedKey = key;
      if (key === "mobile" || key === "telephone") resolvedKey = "phone";
      if (key === "full_name" || key === "fullname") resolvedKey = "full_name";
      if (key === "e-mail") resolvedKey = "email";

      const val = this.vault[resolvedKey] || this.vault[key];
      if (val === undefined || val === null) {
        return {
          success: false,
          reason: `FIELD_NOT_IN_LOCAL_PROFILE:${fieldName}`,
          observation: "profile_key_missing",
        };
      }

      // Framework-safe value injection
      try {
        targetNode.focus();
        const tag = targetNode.tagName.toUpperCase();
        const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) {
          desc.set.call(targetNode, String(val));
        } else {
          targetNode.value = String(val);
        }
        targetNode.dispatchEvent(new Event("input", { bubbles: true }));
        targetNode.dispatchEvent(new Event("change", { bubbles: true }));

        this.lastFilledField = resolvedKey;

        // Return only safe metadata — NEVER val
        return {
          success: true,
          observation: `filled_locally_from_vault(${resolvedKey})`,
          field: resolvedKey,
        };
      } catch (err) {
        return {
          success: false,
          reason: `INJECTION_FAILED: ${err.message}`,
        };
      }
    }
  }

  PBA.LocalSecretHandler = LocalSecretHandler;
  PBA.localSecretHandler = new LocalSecretHandler();
})();
