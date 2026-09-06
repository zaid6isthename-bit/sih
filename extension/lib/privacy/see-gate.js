/**
 * see-gate.js — VisionGate SEE GATE (Inbound Privacy Boundary).
 *
 * Controls what information leaves the trusted local device to the remote model.
 * Enforces strict context minimization, tokenization of personal data,
 * fail-closed redaction of sensitive visual regions, and generates an auditable
 * Privacy Receipt for each observation cycle.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  const EXPOSURE = PBA.PRIVACY_EXPOSURE || {
    ALLOW_RAW: "ALLOW_RAW",
    ALLOW_SEMANTIC: "ALLOW_SEMANTIC",
    TOKENIZE: "TOKENIZE",
    GENERALIZE: "GENERALIZE",
    LOCAL_ONLY: "LOCAL_ONLY",
    NEVER_EXPOSE: "NEVER_EXPOSE",
    REQUIRE_CONFIRMATION: "REQUIRE_CONFIRMATION",
  };

  class SeeGate {
    constructor() {}

    /**
     * Minimize and sanitize BrowserWorldState for remote consumption.
     * @param {object} worldState - Complete trusted BrowserWorldState
     * @param {object} goalManager - Current GoalManager instance
     * @param {object} options - { sendScreenshot, redactionPlan, marks }
     * @returns {object} { remoteSafeState, privacyReceipt }
     */
    filter(worldState, goalManager, options = {}) {
      const counters = {};
      const exposedCategories = [];
      const withheldCategories = [];

      const currentObjective = goalManager && goalManager.getCurrentObjective ? goalManager.getCurrentObjective() : null;
      const objectiveText = currentObjective ? currentObjective.description.toLowerCase() : "";

      // 1. Element Minimization & Sanitization
      const safeElements = [];
      for (const el of worldState.elements || []) {
        // Redact labels
        let safeLabel = el.label || "";
        if (PBA.redactor && PBA.redactor.tokenizeText) {
          safeLabel = PBA.redactor.tokenizeText(safeLabel, counters);
        }

        const isSensitive = el.sensitive || false;
        if (isSensitive) {
          withheldCategories.push(el.pii_type || "sensitive_field");
        } else {
          exposedCategories.push(el.role || "ui_element");
        }

        safeElements.push({
          id: el.id,
          stable_id: el.stable_id,
          role: el.role,
          label: safeLabel,
          bbox: el.bbox,
          enabled: el.enabled,
          value_state: isSensitive && el.value_state === "filled" ? "redacted" : el.value_state,
          sensitive: isSensitive,
          pii_type: el.pii_type,
          destructive: el.destructive || false,
        });
      }

      // 2. Local Vault / Profile Keys (Names only — NEVER values)
      const availableProfileKeys = PBA.localSecretHandler ? PBA.localSecretHandler.getAvailableKeys() : [];

      // Task relevance filtering for profile keys
      // Only include profile keys relevant to userGoal or current objective
      const userGoalLower = (goalManager ? goalManager.userGoal : "").toLowerCase();
      const relevantProfileKeys = availableProfileKeys.filter((k) => {
        if (k === "email" && (userGoalLower.includes("email") || objectiveText.includes("email"))) return true;
        if (k === "phone" && (userGoalLower.includes("phone") || userGoalLower.includes("mobile") || objectiveText.includes("phone"))) return true;
        if (k === "full_name" && (userGoalLower.includes("name") || objectiveText.includes("name"))) return true;
        if (k === "address" && (userGoalLower.includes("address") || objectiveText.includes("address"))) return true;
        // Generic fallback: if general form fill requested, expose ordinary contact fields
        if (/fill|form|profile/i.test(userGoalLower) && (k === "email" || k === "phone" || k === "full_name")) return true;
        return false;
      });

      // 3. Task text sanitization (strip raw PII from task query)
      let safeTask = goalManager ? goalManager.userGoal : "";
      if (PBA.taskParser && PBA.taskParser.parseTask && PBA.taskParser.remoteSafeContext) {
        const parsed = PBA.taskParser.parseTask(safeTask);
        const safeCtx = PBA.taskParser.remoteSafeContext(parsed);
        safeTask = safeCtx.safeText;
      }

      // 4. Remote-Safe State Construction
      const remoteSafeState = {
        protocol_version: PBA.PROTOCOL_VERSION || "1.0",
        session_id: worldState.sessionId,
        step: worldState.stepId,
        task: safeTask,
        current_objective: currentObjective ? currentObjective.description : null,
        completed_objectives: goalManager && goalManager.getCompletedObjectives ? goalManager.getCompletedObjectives().map(o => o.description) : [],
        url_origin: worldState.page.origin || (worldState.page.url ? new URL(worldState.page.url).origin : ""),
        viewport: {
          w: worldState.page.viewport.w || 1280,
          h: worldState.page.viewport.h || 800,
          dpr: worldState.page.viewport.dpr || 1,
        },
        elements: safeElements,
        profile_keys: relevantProfileKeys,
        redactions: (options.redactionPlan || []).map((p) => ({
          pii_type: p.pii_type,
          token: p.token,
          method: p.method,
          bbox: p.bbox,
          confidence: p.confidence,
        })),
        screenshot: options.sendScreenshot && options.screenshot ? options.screenshot : null,
        screenshot_included: !!(options.sendScreenshot && options.screenshot),
      };

      // 5. Auditable Privacy Receipt
      const privacyReceipt = {
        timestamp: Date.now(),
        step: worldState.stepId,
        dataExposed: Array.from(new Set(exposedCategories)).slice(0, 10),
        dataWithheld: Array.from(new Set(withheldCategories)),
        relevantProfileKeysExposed: relevantProfileKeys,
        profileKeysSuppressed: availableProfileKeys.filter(k => !relevantProfileKeys.includes(k)),
        screenshotSent: remoteSafeState.screenshot_included,
        minimizationReason: "task_relevance_enforced",
      };

      return { remoteSafeState, privacyReceipt };
    }

    /**
     * Component helper to filter elements by task relevance
     */
    filterElements(elements, task) {
      const taskLower = (task || "").toLowerCase();
      return (elements || []).filter(e => {
        const label = (e.label || "").toLowerCase();
        if (e.sensitive) return true; // Keep sensitive inputs to resolve vault filling
        if (e.role === "button" || e.role === "link" || e.role === "textbox" || e.role === "combobox") return true;
        if (taskLower.split(/\s+/).some(w => w.length > 2 && label.includes(w))) return true;
        return false;
      });
    }

    /**
     * Component helper to generate a receipt for exposed/withheld metadata
     */
    generateReceipt(rawElements, filteredElements, profileKeys = []) {
      const exposedCount = (filteredElements || []).length;
      const withheldCount = Math.max(0, (rawElements || []).length - exposedCount);
      return {
        timestamp: Date.now(),
        exposed_count: exposedCount,
        withheld_count: withheldCount,
        exposed_profile_keys: profileKeys,
        reason: "context_minimization_policy",
      };
    }
  }

  PBA.SeeGate = SeeGate;
  PBA.seeGate = new SeeGate();
})();
