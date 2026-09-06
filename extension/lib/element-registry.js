/**
 * element-registry.js — Live Element Registry for VisionGate.
 *
 * Implements deep DOM traversal (open Shadow DOM, iframes, Web Components),
 * generates resilient multi-attribute locators, assigns stable IDs, and performs
 * strict pre-execution node validation to prevent acting on stale nodes.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  const INTERACTABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY"]);
  const INTERACTABLE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
    "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "option"
  ]);

  class LiveElementRegistry {
    constructor() {
      this.elements = [];
      this.nodeMap = new Map();       // stableId -> live DOM node
      this.numericIdMap = new Map();  // numeric id -> live DOM node (for protocol compatibility)
      this.invalidationVersion = 1;
      this.scannedAt = 0;
    }

    /**
     * Compute a structural CSS selector for an element
     */
    _getCssPath(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
      if (el.id) return `#${CSS.escape(el.id)}`;

      const parts = [];
      let curr = el;
      while (curr && curr.nodeType === Node.ELEMENT_NODE && curr !== document.body && curr !== document.documentElement) {
        let sel = curr.tagName.toLowerCase();
        if (curr.className && typeof curr.className === "string") {
          const validClasses = curr.className.trim().split(/\s+/).filter(c => !/^[\d_-]/.test(c) && c.length < 30);
          if (validClasses.length > 0) {
            sel += "." + CSS.escape(validClasses[0]);
          }
        }
        let sibIndex = 1;
        let sib = curr.previousElementSibling;
        while (sib) {
          if (sib.tagName === curr.tagName) sibIndex++;
          sib = sib.previousElementSibling;
        }
        sel += `:nth-of-type(${sibIndex})`;
        parts.unshift(sel);
        curr = curr.parentElement || (curr.getRootNode && curr.getRootNode().host);
      }
      return parts.join(" > ");
    }

    /**
     * Determine role
     */
    _getRole(el) {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit.toLowerCase();
      const tag = el.tagName.toUpperCase();
      if (tag === "A" && el.hasAttribute("href")) return "link";
      if (tag === "BUTTON") return "button";
      if (tag === "SELECT") return "combobox";
      if (tag === "TEXTAREA") return "textbox";
      if (tag === "INPUT") {
        const t = (el.type || "text").toLowerCase();
        if (["button", "submit", "reset", "image"].includes(t)) return "button";
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        return "textbox";
      }
      if (el.isContentEditable) return "textbox";
      return "generic";
    }

    /**
     * Extract accessible name / label
     */
    _getAccessibleLabel(el) {
      // 1. aria-labelledby
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map(id => {
          const l = document.getElementById(id);
          return l ? l.innerText : "";
        }).join(" ").trim();
        if (text) return text.slice(0, 100);
      }

      // 2. aria-label
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 100);

      // 3. HTML label association
      if (el.labels && el.labels.length > 0 && el.labels[0].innerText) {
        return el.labels[0].innerText.trim().slice(0, 100);
      }

      // 4. placeholder
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, 100);

      // 5. Title / Alt
      const title = el.getAttribute("title");
      if (title && title.trim()) return title.trim().slice(0, 100);
      const alt = el.getAttribute("alt");
      if (alt && alt.trim()) return alt.trim().slice(0, 100);

      // 6. Direct button / link visible text
      const inner = (el.innerText || el.textContent || "").trim();
      if (inner) return inner.replace(/\s+/g, " ").slice(0, 100);

      return "";
    }

    /**
     * Check if element is interactable
     */
    _isInteractable(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      const tag = el.tagName.toUpperCase();
      if (INTERACTABLE_TAGS.has(tag)) return true;
      const role = el.getAttribute("role");
      if (role && INTERACTABLE_ROLES.has(role.toLowerCase())) return true;
      if (el.hasAttribute("onclick") || el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") return true;
      if (el.isContentEditable) return true;
      return false;
    }

    /**
     * Deep DOM scan including Shadow DOM and accessible iframes
     */
    scan(rootNode = document) {
      this.elements = [];
      this.nodeMap.clear();
      this.numericIdMap.clear();
      this.scannedAt = Date.now();
      this.invalidationVersion = PBA.stateSync ? PBA.stateSync.invalidationVersion : 1;

      let numericId = 0;

      const traverse = (node, frameContext = "top") => {
        if (!node) return;

        // Process element
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node;
          if (this._isInteractable(el)) {
            const rect = el.getBoundingClientRect();
            // Basic visibility check
            if (rect.width >= 2 && rect.height >= 2) {
              const style = window.getComputedStyle(el);
              if (style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0") {
                const role = this._getRole(el);
                const label = this._getAccessibleLabel(el);
                const cssPath = this._getCssPath(el);
                const stableId = `vg-${role}-${numericId}`;

                // Form context
                let formId = null;
                const formEl = el.closest("form");
                if (formEl) formId = formEl.id || formEl.name || "form-unnamed";

                const descriptor = {
                  id: numericId,
                  stable_id: stableId,
                  role,
                  label,
                  selector: cssPath,
                  bbox: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
                  enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
                  value_state: el.value ? (PBA.VALUE_STATE ? PBA.VALUE_STATE.FILLED : "filled") : "empty",
                  sensitive: false,
                  pii_type: null,
                  destructive: PBA.DESTRUCTIVE_HINTS ? PBA.DESTRUCTIVE_HINTS.some(h => label.toLowerCase().includes(h)) : false,
                  formId,
                  frameContext,
                  invalidationVersion: this.invalidationVersion,
                };

                // Check sensitivity via dom-detector if available
                if (PBA.dom && PBA.dom.fieldSensitivity) {
                  const sens = PBA.dom.fieldSensitivity(el);
                  if (sens) {
                    descriptor.sensitive = true;
                    descriptor.pii_type = sens.pii_type;
                  }
                }

                el.__vgStableId = stableId;
                el.__pbaId = numericId;

                this.nodeMap.set(stableId, el);
                this.numericIdMap.set(numericId, el);
                this.elements.push(descriptor);
                numericId++;
              }
            }
          }

          // Traverse open Shadow Root
          if (el.shadowRoot) {
            traverse(el.shadowRoot, `${frameContext}:shadow`);
          }

          // Traverse accessible iFrames
          if (el.tagName === "IFRAME") {
            try {
              if (el.contentDocument) {
                traverse(el.contentDocument.body, `${frameContext}:iframe[${el.id || el.name || 'unnamed'}]`);
              }
            } catch (_) {
              // Cross-origin iframe blocked by SOP - caught cleanly
            }
          }
        }

        // Traverse children
        let child = node.firstElementChild;
        while (child) {
          traverse(child, frameContext);
          child = child.nextElementSibling;
        }
      };

      traverse(rootNode.body || rootNode);

      return this.elements;
    }

    /**
     * Resolve and strictly validate a live DOM element before action execution.
     * Prevents executing against detached, invisible, or mutated nodes.
     */
    resolveAndValidate(targetIdOrDescriptor) {
      let targetNode = null;
      let descriptor = null;

      if (typeof targetIdOrDescriptor === "number") {
        targetNode = this.numericIdMap.get(targetIdOrDescriptor);
        descriptor = this.elements.find(e => e.id === targetIdOrDescriptor);
      } else if (typeof targetIdOrDescriptor === "string") {
        targetNode = this.nodeMap.get(targetIdOrDescriptor);
        descriptor = this.elements.find(e => e.stable_id === targetIdOrDescriptor);
      } else if (targetIdOrDescriptor && typeof targetIdOrDescriptor === "object") {
        descriptor = targetIdOrDescriptor;
        targetNode = this.nodeMap.get(descriptor.stable_id) || this.numericIdMap.get(descriptor.id);
      }

      if (!targetNode && descriptor && descriptor.selector) {
        try {
          targetNode = document.querySelector(descriptor.selector);
        } catch (_) {}
      }

      if (!targetNode) {
        return { valid: false, reason: "TARGET_NOT_FOUND", node: null };
      }

      // Strict Pre-condition Validation
      if (!targetNode.isConnected) {
        return { valid: false, reason: "TARGET_STALE", node: null, detail: "node_disconnected" };
      }

      const rect = targetNode.getBoundingClientRect();
      const style = window.getComputedStyle(targetNode);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || rect.width < 1 || rect.height < 1) {
        return { valid: false, reason: "TARGET_INVISIBLE", node: targetNode };
      }

      if (targetNode.disabled || targetNode.getAttribute("aria-disabled") === "true") {
        return { valid: false, reason: "TARGET_DISABLED", node: targetNode };
      }

      return { valid: true, node: targetNode, descriptor };
    }
  }

  PBA.LiveElementRegistry = LiveElementRegistry;
  PBA.elementRegistry = new LiveElementRegistry();
})();
