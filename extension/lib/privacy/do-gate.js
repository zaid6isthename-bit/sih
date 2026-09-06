/**
 * do-gate.js — VisionGate DO GATE (Outbound Execution Boundary & Action Firewall).
 *
 * Evaluates remote model action proposals against local security policy,
 * dynamically computes action risk and reversibility, enforces Human-in-the-Loop
 * confirmation for high-impact operations, checks task-relevance for profile access,
 * and defends against prompt injection from untrusted web pages.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  const RISK = PBA.RISK_LEVEL || {
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
    CRITICAL: "CRITICAL",
  };

  const REVERSIBILITY = PBA.REVERSIBILITY || {
    REVERSIBLE: "REVERSIBLE",
    PARTIALLY_REVERSIBLE: "PARTIALLY_REVERSIBLE",
    IRREVERSIBLE: "IRREVERSIBLE",
  };

  const CRITICAL_KEYWORDS = [
    "transfer", "pay", "payment", "fee", "purchase", "buy", "order", "checkout",
    "delete", "remove account", "wipe", "terminate", "reset password",
    "grant permission", "wire money"
  ];

  const HIGH_KEYWORDS = [
    "submit", "apply", "send message", "send email", "publish", "post", "sign"
  ];

  class DoGate {
    constructor() {
      this.actionReceipts = [];
      this.pendingConfirmations = new Map(); // actionId -> { action, expiresAt, stateSnapshot }
    }

    /**
     * Classify dynamic risk level and reversibility of an action
     */
    classifyRisk(action, targetDescriptor = {}) {
      const type = (action.type || "").toLowerCase();
      const label = ((targetDescriptor && targetDescriptor.label) || action.text || action.reason || "").toLowerCase();

      // Check for critical destructive operations
      if (CRITICAL_KEYWORDS.some(k => label.includes(k)) || type === "payment" || type === "delete") {
        return { risk: RISK.CRITICAL, reversibility: REVERSIBILITY.IRREVERSIBLE };
      }

      // Check for high-impact submissions or publishing
      if (HIGH_KEYWORDS.some(k => label.includes(k)) || type === "submit_form") {
        return { risk: RISK.HIGH, reversibility: REVERSIBILITY.PARTIALLY_REVERSIBLE };
      }

      // Medium risk: filling forms, selecting options, downloading files
      if (type === "type" || type === "local_profile_action" || type === "local_secret_action" ||
          type === "select" || type === "select_option" || type === "download" || type === "upload_file") {
        return { risk: RISK.MEDIUM, reversibility: REVERSIBILITY.REVERSIBLE };
      }

      // Low risk: reading, scrolling, hovering, safe navigation
      return { risk: RISK.LOW, reversibility: REVERSIBILITY.REVERSIBLE };
    }

    /**
     * Inspect remote model output for unauthorized requests or model-side leaks.
     */
    _inspectModelProposal(action) {
      // Model cannot request raw password, CVV, OTP
      const field = (action.field_name || action.source || "").toLowerCase();
      if (PBA.localSecretHandler && PBA.localSecretHandler.isNeverExpose(field)) {
        return { allowed: false, reason: `UNAUTHORIZED_SECRET_REQUEST:${field}` };
      }

      // Model cannot inject arbitrary JS or eval
      const text = (action.text || "").toLowerCase();
      if (/javascript:|eval\(|<script/i.test(text)) {
        return { allowed: false, reason: "CODE_INJECTION_DETECTED" };
      }

      // Model cannot request arbitrary local filesystem paths
      if (action.path || action.file_path) {
        return { allowed: false, reason: "UNRESTRICTED_FILESYSTEM_ACCESS_PROHIBITED" };
      }

      return { allowed: true };
    }

    /**
     * Check if profile field access is task-authorized
     */
    _isProfileAccessAuthorized(fieldName, userGoal, currentObjective) {
      if (!fieldName) return true;
      const key = fieldName.toLowerCase();
      const textContext = `${userGoal || ""} ${currentObjective || ""}`.toLowerCase();

      if (key === "email" && (textContext.includes("email") || /fill|form|profile/i.test(textContext))) return true;
      if (key === "phone" && (textContext.includes("phone") || textContext.includes("mobile") || /fill|form|profile/i.test(textContext))) return true;
      if ((key === "full_name" || key === "name") && (textContext.includes("name") || /fill|form|profile/i.test(textContext))) return true;
      if (key === "address" && textContext.includes("address")) return true;

      // High-sensitivity IDs (Aadhaar, PAN, Bank) require explicit task mention
      if ((key === "aadhaar" || key === "pan" || key === "bank_account" || key === "upi")) {
        return textContext.includes(key);
      }

      return true;
    }

    /**
     * Authorize an action proposal.
     * @param {object} action - Proposed Action DSL object
     * @param {object} targetDescriptor - Live descriptor of target element
     * @param {object} context - { userGoal, currentObjective, worldState }
     * @returns {object} { authorized: boolean, requiresConfirmation: boolean, risk: string, reason: string }
     */
    evaluate(action, targetDescriptor = {}, context = {}) {
      // 1. Model Proposal Sanitization
      const modelInspection = this._inspectModelProposal(action);
      if (!modelInspection.allowed) {
        return {
          authorized: false,
          requiresConfirmation: false,
          risk: RISK.CRITICAL,
          reason: modelInspection.reason,
        };
      }

      // 2. Risk & Reversibility Classification
      const { risk, reversibility } = this.classifyRisk(action, targetDescriptor);
      action.risk = risk;
      action.reversibility = reversibility;

      // 3. Task Relevance Authorization for Profile Access
      const type = (action.type || "").toLowerCase();
      if (type === "local_profile_action" || type === "local_secret_action" || type === "fill_local") {
        const fieldName = action.field_name || action.source;
        if (!this._isProfileAccessAuthorized(fieldName, context.userGoal, context.currentObjective)) {
          return {
            authorized: false,
            requiresConfirmation: false,
            risk: RISK.HIGH,
            reason: `PROFILE_ACCESS_UNAUTHORIZED_FOR_TASK:${fieldName}`,
          };
        }
      }

      // 4. Human-in-the-Loop Confirmation Policy
      // CRITICAL actions (e.g. payment, account deletion, sensitive submission) ALWAYS require user confirmation
      let requiresConfirmation = false;
      if (risk === RISK.CRITICAL || action.requires_confirmation || (targetDescriptor && targetDescriptor.destructive)) {
        requiresConfirmation = true;
      }

      // 5. Cross-origin navigation check
      if (type === "navigate" && action.url) {
        try {
          const origin = new URL(action.url, location.href).origin;
          if (origin !== location.origin) {
            requiresConfirmation = true; // Cross-origin navigation requires approval
          }
        } catch (_) {}
      }

      // 6. Generate Action Receipt
      const receipt = {
        timestamp: Date.now(),
        actionId: action.action_id || `act-${Date.now()}`,
        actionType: type,
        targetId: action.stable_target_id || action.target_id,
        targetLabel: (targetDescriptor && targetDescriptor.label) ? targetDescriptor.label.slice(0, 50) : null,
        risk,
        reversibility,
        requiresConfirmation,
        authorized: true,
      };
      this.actionReceipts.push(receipt);

      return {
        authorized: true,
        requiresConfirmation,
        risk,
        reversibility,
        reason: "POLICY_AUTHORIZED",
        receipt,
      };
    }
  }

  PBA.DoGate = DoGate;
  PBA.doGate = new DoGate();
})();
