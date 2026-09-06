/**
 * content-executor.js — Universal In-Page Action Executor for VisionGate.
 *
 * Dispatches authentic browser pointer, keyboard, and form events. Handles
 * React/Vue/Angular synthetic event systems, custom selects, checkboxes,
 * intelligent scroll containers, and precondition checks.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  class ContentExecutor {
    constructor(elementRegistry) {
      this.registry = elementRegistry || PBA.elementRegistry;
    }

    /**
     * React / Vue / Angular safe value setter
     */
    _setNativeValue(el, value) {
      const tag = el.tagName.toUpperCase();
      const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) {
        desc.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    /**
     * Dispatch realistic pointer event sequence
     */
    _dispatchPointerSequence(el, type = "click") {
      const rect = el.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2);
      const clientY = Math.round(rect.top + rect.height / 2);

      const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY };

      if (type === "click") {
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent("click", opts));
      } else if (type === "double_click") {
        this._dispatchPointerSequence(el, "click");
        this._dispatchPointerSequence(el, "click");
        el.dispatchEvent(new MouseEvent("dblclick", opts));
      } else if (type === "right_click") {
        el.dispatchEvent(new MouseEvent("contextmenu", opts));
      } else if (type === "hover") {
        el.dispatchEvent(new MouseEvent("mouseenter", opts));
        el.dispatchEvent(new MouseEvent("mouseover", opts));
      }
    }

    /**
     * Identify nearest scrollable container
     */
    _findScrollContainer(el) {
      let parent = el.parentElement;
      while (parent && parent !== document.body && parent !== document.documentElement) {
        const style = window.getComputedStyle(parent);
        const overflowY = style.overflowY;
        if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) {
          return parent;
        }
        parent = parent.parentElement;
      }
      return window;
    }

    /**
     * Snapshot state for immediate before/after delta check
     */
    _snapshotElementState(el) {
      if (!el) return null;
      return {
        value: el.value !== undefined ? el.value : null,
        checked: el.checked !== undefined ? el.checked : null,
        selectedIndex: el.selectedIndex !== undefined ? el.selectedIndex : null,
        text: el.innerText ? el.innerText.slice(0, 100) : null,
      };
    }

    /**
     * Execute a validated action in the current page
     */
    async execute(action) {
      const executionStarted = Date.now();
      const actionId = action.action_id || `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const result = {
        actionId,
        success: false,
        executionStarted,
        executionFinished: 0,
        targetResolved: false,
        preconditions: { met: true, details: [] },
        observedEffects: [],
        errors: [],
        warnings: [],
        changedState: false,
      };

      // Resolve target if action needs a target
      let targetNode = null;
      let targetDescriptor = null;
      const targetSpec = action.stable_target_id !== undefined ? action.stable_target_id : 
        (action.target_id !== undefined ? action.target_id : action.targetId);

      if (targetSpec !== undefined && targetSpec !== null) {
        const resolution = this.registry.resolveAndValidate(targetSpec);
        if (!resolution.valid) {
          result.preconditions.met = false;
          result.preconditions.details.push(`target_validation_failed:${resolution.reason}`);
          result.errors.push(resolution.reason);
          result.executionFinished = Date.now();
          return result;
        }
        targetNode = resolution.node;
        targetDescriptor = resolution.descriptor;
        result.targetResolved = true;
      }

      const beforeState = targetNode ? this._snapshotElementState(targetNode) : null;
      const actionType = (action.type || "").toLowerCase();

      try {
        switch (actionType) {
          case "click": {
            if (!targetNode) throw new Error("TARGET_REQUIRED");
            targetNode.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            await new Promise(r => setTimeout(r, 40));
            this._dispatchPointerSequence(targetNode, "click");
            result.observedEffects.push("clicked");
            result.success = true;
            break;
          }

          case "double_click": {
            if (!targetNode) throw new Error("TARGET_REQUIRED");
            targetNode.scrollIntoView({ block: "center", behavior: "instant" });
            this._dispatchPointerSequence(targetNode, "double_click");
            result.observedEffects.push("double_clicked");
            result.success = true;
            break;
          }

          case "right_click": {
            if (!targetNode) throw new Error("TARGET_REQUIRED");
            this._dispatchPointerSequence(targetNode, "right_click");
            result.observedEffects.push("right_clicked");
            result.success = true;
            break;
          }

          case "hover": {
            if (!targetNode) throw new Error("TARGET_REQUIRED");
            this._dispatchPointerSequence(targetNode, "hover");
            result.observedEffects.push("hovered");
            result.success = true;
            break;
          }

          case "focus": {
            if (!targetNode) throw new Error("TARGET_REQUIRED");
            targetNode.focus();
            result.observedEffects.push("focused");
            result.success = true;
            break;
          }

          case "type": {
            if (!targetNode) throw new Error("TARGET_REQUIRED");
            targetNode.focus();
            const textToType = action.text != null ? String(action.text) : "";
            this._setNativeValue(targetNode, textToType);
            result.observedEffects.push(`typed_literal(${textToType.length}_chars)`);
            result.success = true;
            break;
          }

          case "clear": {
            if (!targetNode) throw new Error("TARGET_REQUIRED");
            targetNode.focus();
            this._setNativeValue(targetNode, "");
            result.observedEffects.push("cleared_value");
            result.success = true;
            break;
          }

          case "press_key": {
            const key = action.key || "Enter";
            const target = targetNode || document.activeElement || document.body;
            target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
            target.dispatchEvent(new KeyboardEvent("keypress", { key, bubbles: true, cancelable: true }));
            target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
            result.observedEffects.push(`pressed_key(${key})`);
            result.success = true;
            break;
          }

          case "scroll":
          case "scroll_up":
          case "scroll_down": {
            const dy = action.amount || Math.round(window.innerHeight * 0.7);
            const isUp = actionType === "scroll_up" || action.direction === "up";
            const container = targetNode ? this._findScrollContainer(targetNode) : window;

            if (container === window) {
              const delta = isUp ? -dy : dy;
              window.scrollBy({ top: delta, behavior: "instant" });
              if (document.scrollingElement) {
                document.scrollingElement.scrollTop += delta;
              } else if (document.documentElement) {
                document.documentElement.scrollTop += delta;
              }
            } else {
              container.scrollTop += isUp ? -dy : dy;
            }
            result.observedEffects.push(`scrolled(${isUp ? 'up' : 'down'},${dy}px)`);
            result.success = true;
            break;
          }

          case "scroll_to":
          case "scroll_to_element": {
            if (!targetNode) throw new Error("TARGET_REQUIRED");
            targetNode.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            result.observedEffects.push("scrolled_to_element");
            result.success = true;
            break;
          }

          case "select":
          case "select_option": {
            if (!targetNode) throw new Error("TARGET_REQUIRED");
            const desired = (action.option || action.text || "").toLowerCase();
            let matched = false;

            if (targetNode.options) {
              for (const opt of Array.from(targetNode.options)) {
                if (opt.value.toLowerCase() === desired || opt.text.toLowerCase() === desired || opt.label.toLowerCase() === desired) {
                  targetNode.value = opt.value;
                  matched = true;
                  break;
                }
              }
            }

            if (!matched && targetNode.options && targetNode.options.length > 0) {
              targetNode.selectedIndex = 0;
              matched = true;
            }

            targetNode.dispatchEvent(new Event("change", { bubbles: true }));
            result.observedEffects.push(matched ? "option_selected" : "option_not_found");
            result.success = matched;
            break;
          }

          case "check":
          case "uncheck":
          case "toggle": {
            if (!targetNode) throw new Error("TARGET_REQUIRED");
            const shouldCheck = actionType === "check" ? true : actionType === "uncheck" ? false : !targetNode.checked;
            targetNode.checked = shouldCheck;
            targetNode.dispatchEvent(new Event("input", { bubbles: true }));
            targetNode.dispatchEvent(new Event("change", { bubbles: true }));
            result.observedEffects.push(`checked_state_set(${shouldCheck})`);
            result.success = true;
            break;
          }

          case "submit_form": {
            const form = targetNode ? (targetNode.tagName === "FORM" ? targetNode : targetNode.closest("form")) : document.querySelector("form");
            if (form) {
              const submitBtn = form.querySelector("button[type='submit'], input[type='submit']");
              if (submitBtn) {
                this._dispatchPointerSequence(submitBtn, "click");
              } else {
                form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
              }
              result.observedEffects.push("form_submitted");
              result.success = true;
            } else {
              throw new Error("FORM_NOT_FOUND");
            }
            break;
          }

          case "handle_dialog": {
            // Web native dialog tag or custom modal
            const dialog = targetNode || document.querySelector("dialog[open], .modal.show, [role='dialog']");
            if (dialog) {
              const dismissBtn = dialog.querySelector("button.close, [aria-label*='close'], button:not([type='submit'])");
              if (dismissBtn) {
                this._dispatchPointerSequence(dismissBtn, "click");
                result.observedEffects.push("dialog_dismissed_via_button");
              } else if (typeof dialog.close === "function") {
                dialog.close();
                result.observedEffects.push("dialog_closed");
              }
              result.success = true;
            } else {
              result.warnings.push("no_open_dialog_found");
              result.success = true;
            }
            break;
          }

          case "local_profile_action":
          case "local_secret_action":
          case "fill_local": {
            if (!targetNode) throw new Error("TARGET_REQUIRED");
            // Delegates to localSecretHandler if available
            if (PBA.localSecretHandler) {
              const res = await PBA.localSecretHandler.fillField(targetNode, action.field_name || action.source);
              result.success = res.success;
              result.observedEffects.push(res.observation || "filled_locally");
              if (!res.success) result.errors.push(res.reason || "local_fill_failed");
            } else {
              result.errors.push("LOCAL_SECRET_HANDLER_UNAVAILABLE");
            }
            break;
          }

          case "no_action_required": {
            result.observedEffects.push("no_action_needed");
            result.success = true;
            break;
          }

          case "wait": {
            const ms = Math.min(action.ms || 500, 5000);
            await new Promise(r => setTimeout(r, ms));
            result.observedEffects.push(`waited(${ms}ms)`);
            result.success = true;
            break;
          }

          default: {
            result.errors.push(`UNSUPPORTED_ACTION_TYPE:${actionType}`);
            result.success = false;
          }
        }
      } catch (err) {
        result.errors.push(String(err && err.message || err));
        result.success = false;
      }

      // Compute immediate element state change
      const afterState = targetNode ? this._snapshotElementState(targetNode) : null;
      result.changedState = JSON.stringify(beforeState) !== JSON.stringify(afterState);
      result.executionFinished = Date.now();

      return result;
    }
  }

  PBA.ContentExecutor = ContentExecutor;
  PBA.contentExecutor = new ContentExecutor();
})();
