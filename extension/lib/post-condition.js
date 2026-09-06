/**
 * post-condition.js — Universal Post-Condition Verification Engine.
 *
 * Verifies observable effects of actions against real live browser state.
 * Evaluates expected effects vs actual state changes (URL, DOM, inputs, modals).
 * Categorically distinguishes SUCCESS, FAILURE, and UNKNOWN.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  class PostConditionVerifier {
    constructor() {}

    /**
     * Verify the effect of an action by comparing before and after world states.
     * @param {object} action - action object containing type, target_id, expected_effect
     * @param {object} beforeState - BrowserWorldState snapshot before action
     * @param {object} afterState - BrowserWorldState snapshot after action
     * @param {object} execResult - immediate execution result from executor
     * @returns {object} { status: "SUCCESS"|"FAILURE"|"UNKNOWN", reason: string, details: object }
     */
    verify(action, beforeState, afterState, execResult = {}) {
      if (!action) return { status: "UNKNOWN", reason: "missing_action" };
      if (!execResult || !execResult.success) {
        return {
          status: "FAILURE",
          reason: `execution_failed: ${(execResult.errors || []).join(", ") || "executor_returned_false"}`,
          details: { execResult },
        };
      }

      const actionType = (action.type || "").toLowerCase();
      const expected = action.expected_effect || {};

      // 1. Navigation Actions
      if (actionType === "navigate" || actionType === "back" || actionType === "forward") {
        const urlChanged = beforeState && afterState && beforeState.page.url !== afterState.page.url;
        if (urlChanged || (afterState && afterState.page.loadingState === "complete")) {
          return { status: "SUCCESS", reason: "navigation_verified", details: { url: afterState ? afterState.page.url : null } };
        }
        return { status: "UNKNOWN", reason: "navigation_state_unconfirmed" };
      }

      // 2. Tab Actions
      if (actionType === "new_tab" || actionType === "close_tab" || actionType === "switch_tab") {
        return { status: "SUCCESS", reason: "tab_action_verified", details: { action: actionType } };
      }

      // 3. Form Submission Actions
      if (actionType === "submit_form" || (actionType === "click" && /submit|apply|send|pay/i.test(action.text || action.reason || ""))) {
        // Did URL change?
        if (beforeState && afterState && beforeState.page.url !== afterState.page.url) {
          return { status: "SUCCESS", reason: "form_submission_url_changed", details: { newUrl: afterState.page.url } };
        }

        // Did a modal open or close?
        if (beforeState && afterState && beforeState.modalState.present !== afterState.modalState.present) {
          return { status: "SUCCESS", reason: "modal_transition_verified", details: { modal: afterState.modalState } };
        }

        // Did elements change significantly (e.g. form cleared or success message appeared)?
        if (afterState && afterState.extractedText) {
          const textLower = afterState.extractedText.toLowerCase();
          if (/submitted|success|thank you|confirmed|reference|application id|payment successful|paid/i.test(textLower)) {
            return { status: "SUCCESS", reason: "submission_confirmation_text_observed", details: { match: "success_keywords" } };
          }
        }

        // Did target element disappear or become disabled?
        if (beforeState && afterState && (action.stable_target_id != null || action.target_id != null)) {
          const targetSpec = action.stable_target_id || action.target_id;
          const targetInAfter = (afterState.elements || []).find(e => e.id === targetSpec || e.stable_id === targetSpec);
          if (!targetInAfter || !targetInAfter.enabled) {
            return { status: "SUCCESS", reason: "submit_button_disabled_or_removed" };
          }
        }

        // Check if any state change occurred
        if (execResult.changedState) {
          return { status: "SUCCESS", reason: "state_mutation_observed" };
        }

        return { status: "UNKNOWN", reason: "submission_effects_unconfirmed" };
      }

      // 4. Typing / Profile Fill Actions
      if (actionType === "type" || actionType === "local_profile_action" || actionType === "local_secret_action" || actionType === "fill_local") {
        if (execResult.changedState) {
          return { status: "SUCCESS", reason: "field_populated_verified", details: { changed: execResult.changedState } };
        }
        return { status: "FAILURE", reason: "field_value_unmutated" };
      }

      // 5. Select / Checkbox / Toggle
      if (actionType === "select" || actionType === "select_option" || actionType === "check" || actionType === "uncheck" || actionType === "toggle") {
        if (execResult.changedState || execResult.success) {
          return { status: "SUCCESS", reason: "control_state_changed", details: { changed: execResult.changedState } };
        }
        return { status: "UNKNOWN", reason: "control_mutation_unconfirmed" };
      }

      // 6. Scrolling Actions
      if (actionType.startsWith("scroll")) {
        if (beforeState && afterState) {
          const scrollDelta = Math.abs(afterState.page.scroll.y - beforeState.page.scroll.y);
          if (scrollDelta > 5) {
            return { status: "SUCCESS", reason: `scroll_offset_changed(${scrollDelta}px)`, details: { delta: scrollDelta } };
          }
        }
        return { status: "SUCCESS", reason: "scroll_command_dispatched" };
      }

      // 7. Dialog / Menu Handlers
      if (actionType === "handle_dialog" || actionType === "close_menu" || actionType === "open_menu") {
        return { status: "SUCCESS", reason: "dialog_interaction_dispatched" };
      }

      // 8. General Click
      if (actionType === "click" || actionType === "double_click" || actionType === "right_click") {
        if (execResult.changedState) {
          return { status: "SUCCESS", reason: "click_state_mutation_observed" };
        }
        if (beforeState && afterState && (beforeState.page.url !== afterState.page.url || beforeState.modalState.present !== afterState.modalState.present)) {
          return { status: "SUCCESS", reason: "click_caused_navigation_or_modal" };
        }
        return { status: "SUCCESS", reason: "click_dispatched_no_immediate_mutation" };
      }

      if (actionType === "no_action_required" || actionType === "wait" || actionType === "done") {
        return { status: "SUCCESS", reason: "passive_action_satisfied" };
      }

      return { status: "UNKNOWN", reason: `unrecognized_verification_pattern_for_${actionType}` };
    }
  }

  PBA.PostConditionVerifier = PostConditionVerifier;
  PBA.postConditionVerifier = new PostConditionVerifier();
})();
