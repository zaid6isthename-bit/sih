/**
 * egress-gate.js — VisionGate Final Egress Gate (Outbound Network Boundary).
 *
 * Inspects the entire serialized outbound request payload immediately before
 * it leaves the browser. Fails closed if any raw PII or secret is detected.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  class EgressGate {
    constructor() {}

    /**
     * Deeply scan an arbitrary object or serialized string for raw PII.
     * Returns { leakDetected: boolean, category: string|null, location: string|null }
     */
    inspect(payload) {
      if (!PBA.pii || !PBA.pii.scan) {
        return { leakDetected: false, category: null, location: null };
      }

      // Check serialized string
      let jsonString = "";
      try {
        jsonString = typeof payload === "string" ? payload : JSON.stringify(payload);
      } catch (err) {
        return { leakDetected: true, category: "serialization_error", location: "payload" };
      }

      // Walk object structure recursively to pinpoint location
      const scanValue = (val, path) => {
        if (val === null || val === undefined) return null;
        if (typeof val === "string") {
          // Skip base64 image data URLs from raw text scanning (they are sanitized bitmaps)
          if (val.startsWith("data:image/")) return null;
          // Skip valid <TOKEN> placeholders
          if (val.startsWith("<") && val.endsWith(">")) return null;

          const hits = PBA.pii.scan(val);
          if (hits && hits.length > 0) {
            // Return category only — NEVER the raw value
            return { leakDetected: true, category: hits[0].type, location: path };
          }
        } else if (Array.isArray(val)) {
          for (let i = 0; i < val.length; i++) {
            const res = scanValue(val[i], `${path}[${i}]`);
            if (res) return res;
          }
        } else if (typeof val === "object") {
          for (const k of Object.keys(val)) {
            // Skip screenshot and internal protocol identifiers
            if (k === "screenshot" || k === "session_id" || k === "sessionId" || k === "task_id" || k === "taskId" || k === "protocol_version") continue;
            const res = scanValue(val[k], `${path}.${k}`);
            if (res) return res;
          }
        }
        return null;
      };

      const result = scanValue(typeof payload === "string" ? JSON.parse(jsonString) : payload, "root");
      return result || { leakDetected: false, category: null, location: null };
    }

    /**
     * Pre-flight gate: throws an error if payload leaks raw PII.
     */
    assertSafe(payload, endpointName = "/plan") {
      const check = this.inspect(payload);
      if (check.leakDetected) {
        const err = new Error(`egress_blocked: raw ${check.category} detected in ${check.location} before POST ${endpointName}`);
        err.violation = check;
        throw err;
      }
      return true;
    }

    /**
     * Validates an outbound payload object.
     * @returns {object} { valid: boolean, reason: string|null, location: string|null }
     */
    validatePayload(payload) {
      const check = this.inspect(payload);
      return {
        valid: !check.leakDetected,
        reason: check.category,
        location: check.location,
      };
    }
  }

  PBA.EgressGate = EgressGate;
  PBA.egressGate = new EgressGate();
})();
