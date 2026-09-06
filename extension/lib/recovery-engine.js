/**
 * recovery-engine.js — Intelligent Failure Recovery & Replanning Engine.
 *
 * Systematically classifies execution and post-condition failures, determines
 * root causes, formulates bounded recovery strategies using NEW information,
 * and maintains failure history to prevent pathological retry loops.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  const FAILURE_TYPE = PBA.FAILURE_TYPE || {
    TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
    TARGET_STALE: "TARGET_STALE",
    TARGET_CHANGED: "TARGET_CHANGED",
    TARGET_DISABLED: "TARGET_DISABLED",
    PAGE_NAVIGATED: "PAGE_NAVIGATED",
    POPUP_BLOCKING: "POPUP_BLOCKING",
    MODAL_BLOCKING: "MODAL_BLOCKING",
    LOGIN_REQUIRED: "LOGIN_REQUIRED",
    CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
    PERMISSION_REQUIRED: "PERMISSION_REQUIRED",
    NETWORK_ERROR: "NETWORK_ERROR",
    TIMEOUT: "TIMEOUT",
    VALIDATION_ERROR: "VALIDATION_ERROR",
    UNEXPECTED_PAGE: "UNEXPECTED_PAGE",
    ACTION_REJECTED: "ACTION_REJECTED",
    POSTCONDITION_FAILED: "POSTCONDITION_FAILED",
    STALLED: "STALLED",
    UNKNOWN: "UNKNOWN",
  };

  class RecoveryEngine {
    constructor(options = {}) {
      this.maxRetriesPerStrategy = options.maxRetries || 2;
      this.failureHistory = []; // list of { step, failureType, target, action, strategy, timestamp }
      this.strategyAttempts = new Map(); // strategyKey -> count
    }

    /**
     * Classify failure type from error, execution result, or post-condition verification
     */
    classifyFailure(action, execResult = {}, verification = {}, worldState = {}) {
      const errorStr = (execResult.errors || []).join(" ").toLowerCase();
      const reasonStr = (verification.reason || "").toLowerCase();

      if (/captcha|recaptcha|hcaptcha|turnstile/i.test(errorStr) || /captcha/i.test(reasonStr)) {
        return FAILURE_TYPE.CAPTCHA_REQUIRED;
      }
      if (/login|sign in|unauthorized|auth_required/i.test(errorStr) || /login/i.test(reasonStr)) {
        return FAILURE_TYPE.LOGIN_REQUIRED;
      }
      if (/target_stale|node_disconnected/i.test(errorStr) || /stale/i.test(reasonStr)) {
        return FAILURE_TYPE.TARGET_STALE;
      }
      if (/target_not_found|missing_target/i.test(errorStr)) {
        return FAILURE_TYPE.TARGET_NOT_FOUND;
      }
      if (/target_invisible/i.test(errorStr)) {
        return FAILURE_TYPE.TARGET_NOT_FOUND;
      }
      if (/target_disabled/i.test(errorStr)) {
        return FAILURE_TYPE.TARGET_DISABLED;
      }
      if (/modal|popup|overlay/i.test(errorStr) || /modal_blocking/i.test(reasonStr)) {
        return FAILURE_TYPE.MODAL_BLOCKING;
      }
      if (/timeout/i.test(errorStr) || /timed_out/i.test(reasonStr)) {
        return FAILURE_TYPE.TIMEOUT;
      }
      if (/network|fetch|connection/i.test(errorStr)) {
        return FAILURE_TYPE.NETWORK_ERROR;
      }
      if (verification.status === "FAILURE") {
        return FAILURE_TYPE.POSTCONDITION_FAILED;
      }
      if (execResult.rejected) {
        return FAILURE_TYPE.ACTION_REJECTED;
      }

      return FAILURE_TYPE.UNKNOWN;
    }

    /**
     * Formulate an actionable recovery strategy based on failure classification.
     */
    formulateStrategy(failureType, action, worldState = {}) {
      const targetSpec = action.stable_target_id || action.target_id;
      const strategyKey = `${failureType}:${targetSpec || 'notarget'}`;
      const previousAttempts = this.strategyAttempts.get(strategyKey) || 0;

      if (previousAttempts >= this.maxRetriesPerStrategy) {
        return {
          canRecover: false,
          strategy: "ABORT_RETRY_EXHAUSTED",
          action: { type: "need_user", reason: `Recovery exhausted for ${failureType}. Manual interaction required.` },
          reason: "max_recovery_attempts_reached",
        };
      }

      // Auto-record this attempt
      this.strategyAttempts.set(strategyKey, previousAttempts + 1);

      let strategy = null;

      switch (failureType) {
        case FAILURE_TYPE.TARGET_STALE: {
          // Re-observe and re-ground target against current live DOM
          strategy = {
            canRecover: true,
            strategy: "REFRESH_AND_REGROUND",
            immediateAction: { type: "wait", ms: 100 },
            needsReobservation: true,
            needsRegrounding: true,
            reason: "Target node disconnected or mutated; refreshing element registry and regrounding.",
          };
          break;
        }

        case FAILURE_TYPE.TARGET_NOT_FOUND: {
          // Attempt scrolling into view or checking scroll containers
          strategy = {
            canRecover: true,
            strategy: "SCROLL_AND_REOBSERVE",
            immediateAction: { type: "scroll_down", amount: 400 },
            needsReobservation: true,
            needsRegrounding: true,
            reason: "Target element not in current viewport; scrolling down to locate it.",
          };
          break;
        }

        case FAILURE_TYPE.MODAL_BLOCKING:
        case FAILURE_TYPE.POPUP_BLOCKING: {
          strategy = {
            canRecover: true,
            strategy: "DISMISS_MODAL",
            immediateAction: { type: "handle_dialog" },
            needsReobservation: true,
            needsRegrounding: true,
            reason: "Modal or popup is blocking interaction; attempting safe dismissal.",
          };
          break;
        }

        case FAILURE_TYPE.CAPTCHA_REQUIRED: {
          strategy = {
            canRecover: false,
            strategy: "HANDOFF_CAPTCHA",
            action: {
              type: "ask_user",
              reason: "Security check / CAPTCHA detected. Please solve it in the browser to continue.",
            },
            needsUserHandoff: true,
            reason: "Human-only boundary: CAPTCHA.",
          };
          break;
        }

        case FAILURE_TYPE.LOGIN_REQUIRED: {
          strategy = {
            canRecover: false,
            strategy: "HANDOFF_AUTHENTICATION",
            action: {
              type: "ask_user",
              reason: "Authentication required. Please log in to continue.",
            },
            needsUserHandoff: true,
            reason: "Human-only boundary: authentication wall.",
          };
          break;
        }

        case FAILURE_TYPE.POSTCONDITION_FAILED: {
          strategy = {
            canRecover: true,
            strategy: "REOBSERVE_AND_REPLAN",
            action: { type: "wait", ms: 300 },
            immediateAction: { type: "wait", ms: 300 },
            needsReobservation: true,
            needsReplanning: true,
            reason: "Action did not produce expected effect; re-observing actual state.",
          };
          break;
        }

        case FAILURE_TYPE.STALLED: {
          strategy = {
            canRecover: true,
            strategy: "BREAK_STALL",
            immediateAction: { type: "scroll_up", amount: 300 },
            needsReobservation: true,
            needsReplanning: true,
            reason: "Agent loop stalled with no state change; shifting perspective.",
          };
          break;
        }

        case FAILURE_TYPE.TARGET_DISABLED: {
          strategy = {
            canRecover: true,
            strategy: "WAIT_OR_REPLAN",
            action: { type: "wait", ms: 500 },
            immediateAction: { type: "wait", ms: 500 },
            needsReobservation: true,
            needsReplanning: true,
            reason: "Target is disabled; waiting or replanning.",
          };
          break;
        }

        case FAILURE_TYPE.TIMEOUT:
        case FAILURE_TYPE.NETWORK_ERROR: {
          strategy = {
            canRecover: true,
            strategy: "BACKOFF_AND_RETRY",
            action: { type: "wait", ms: 1000 },
            immediateAction: { type: "wait", ms: 1000 },
            needsReobservation: false,
            needsReplanning: false,
            reason: "Transient network/timeout failure; retrying with backoff.",
          };
          break;
        }

        default: {
          strategy = {
            canRecover: true,
            strategy: "GENERAL_REOBSERVE",
            action: { type: "wait", ms: 200 },
            immediateAction: { type: "wait", ms: 200 },
            needsReobservation: true,
            needsReplanning: true,
            reason: "Unclassified failure; performing fresh observation to determine next step.",
          };
        }
      }

      this.failureHistory.push({
        failureType,
        action,
        strategy: strategy.strategy,
        timestamp: Date.now(),
      });

      return strategy;
    }

  /** No-op: formulateStrategy auto-records. Kept as an external hook contract point. */
    recordAttempt() {}

    reset() {
      this.failureHistory = [];
      this.strategyAttempts.clear();
    }
  }

  PBA.RecoveryEngine = RecoveryEngine;
  PBA.recoveryEngine = new RecoveryEngine();
})();
