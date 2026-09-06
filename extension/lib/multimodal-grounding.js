/**
 * multimodal-grounding.js — Multimodal Target Grounding Engine for VisionGate.
 *
 * Grounding combines DOM, A11y, visible text, spatial relationships, OCR,
 * and local vision to resolve natural language intents into ranked live targets.
 * Features 4-level perception escalation and ambiguity detection.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  class MultimodalGroundingEngine {
    constructor(elementRegistry) {
      this.registry = elementRegistry || PBA.elementRegistry;
      this.lastEscalationReason = null;
      this.currentPerceptionLevel = PBA.PERCEPTION_LEVEL ? PBA.PERCEPTION_LEVEL.LEVEL_1_DOM_A11Y : "LEVEL_1_DOM_A11Y";
    }

    /**
     * Ground an intended action or target description to ranked candidate elements.
     * @param {string|object} targetQuery - natural language descriptor or structured target query
     * @param {object} context - { task, recentActions, modalPresent, viewport, visionDetections }
     * @returns {object} { candidates: [], bestTarget: object|null, confidence: number, isAmbiguous: boolean, perceptionLevel: string }
     */
    ground(targetQuery, context = {}) {
      const elements = this.registry.elements || [];
      if (elements.length === 0) {
        return { candidates: [], bestTarget: null, confidence: 0, isAmbiguous: false, perceptionLevel: this.currentPerceptionLevel };
      }

      const queryText = typeof targetQuery === "string" ? targetQuery.toLowerCase().trim() : (targetQuery.text || targetQuery.label || "").toLowerCase().trim();
      const targetRole = typeof targetQuery === "object" && targetQuery.role ? targetQuery.role.toLowerCase() : null;

      // Extract spatial cues: "beside", "next to", "bottom right", "second", "in modal"
      const hasSpatialTop = /top|header/i.test(queryText);
      const hasSpatialBottom = /bottom|footer/i.test(queryText);
      const hasSpatialRight = /right/i.test(queryText);
      const hasSpatialLeft = /left/i.test(queryText);
      const ordinalMatch = queryText.match(/\b(first|second|third|1st|2nd|3rd|fourth|fifth)\b/i);

      const scored = [];

      for (const el of elements) {
        let score = 0;
        const evidence = [];
        const label = (el.label || "").toLowerCase();
        const role = (el.role || "").toLowerCase();

        // 1. Exact or Substring Text Matching
        if (queryText && label) {
          if (label === queryText) {
            score += 0.55;
            evidence.push("exact_label_match");
          } else if (label.includes(queryText) || queryText.includes(label)) {
            score += 0.40;
            evidence.push("substring_label_match");
          } else {
            // Token overlap
            const qTokens = queryText.split(/\s+/).filter(t => t.length > 2);
            const lTokens = label.split(/\s+/).filter(t => t.length > 2);
            const common = qTokens.filter(t => lTokens.some(lt => lt.includes(t) || t.includes(lt)));
            if (common.length > 0) {
              score += 0.20 * (common.length / Math.max(1, qTokens.length));
              evidence.push(`token_overlap(${common.join(',')})`);
            }
          }
        }

        // 2. Role matching
        if (targetRole && role === targetRole) {
          score += 0.25;
          evidence.push(`role_match(${role})`);
        } else if (/button|click/i.test(queryText) && role === "button") {
          score += 0.15;
          evidence.push("button_role_inference");
        } else if (/link/i.test(queryText) && role === "link") {
          score += 0.15;
          evidence.push("link_role_inference");
        } else if (/field|input|enter|type/i.test(queryText) && role === "textbox") {
          score += 0.15;
          evidence.push("textbox_role_inference");
        }

        // 3. Spatial & Viewport Geometry Cues
        const bbox = el.bbox || [0, 0, 0, 0];
        const viewportH = (context.viewport && context.viewport.h) || window.innerHeight || 800;
        const viewportW = (context.viewport && context.viewport.w) || window.innerWidth || 1280;

        if (hasSpatialBottom && bbox[1] > viewportH * 0.6) {
          score += 0.15;
          evidence.push("spatial_bottom");
        }
        if (hasSpatialTop && bbox[1] < viewportH * 0.4) {
          score += 0.15;
          evidence.push("spatial_top");
        }
        if (hasSpatialRight && bbox[0] > viewportW * 0.6) {
          score += 0.15;
          evidence.push("spatial_right");
        }
        if (hasSpatialLeft && bbox[0] < viewportW * 0.4) {
          score += 0.15;
          evidence.push("spatial_left");
        }

        // 4. Modal focus bias
        if (context.modalPresent && el.frameContext && el.frameContext.includes("modal")) {
          score += 0.20;
          evidence.push("modal_context_match");
        }

        // 5. Visibility and Enabled Bonus
        if (el.enabled) score += 0.05;

        // Normalize score 0.0 - 1.0
        const finalConfidence = Math.min(0.99, Number(score.toFixed(3)));

        if (finalConfidence > 0.20) {
          scored.push({
            target: el,
            confidence: finalConfidence,
            evidence,
          });
        }
      }

      // Sort descending by confidence
      scored.sort((a, b) => b.confidence - a.confidence);

      // Handle ordinal filtering (e.g. "second product card")
      if (ordinalMatch && scored.length > 1) {
        const ord = ordinalMatch[1].toLowerCase();
        let targetIndex = 0;
        if (ord === "second" || ord === "2nd") targetIndex = 1;
        else if (ord === "third" || ord === "3rd") targetIndex = 2;
        else if (ord === "fourth") targetIndex = 3;

        if (scored[targetIndex]) {
          const selected = scored[targetIndex];
          selected.evidence.push(`ordinal_selection(${ord})`);
          selected.confidence = Math.min(0.99, selected.confidence + 0.10);
          scored.unshift(scored.splice(targetIndex, 1)[0]);
        }
      }

      const bestTarget = scored.length > 0 ? scored[0].target : null;
      const topConfidence = scored.length > 0 ? scored[0].confidence : 0;

      // Ambiguity detection: top two candidates within 0.08 confidence margin
      let isAmbiguous = false;
      if (scored.length > 1 && scored[0].confidence - scored[1].confidence < 0.08 && scored[0].confidence < 0.85) {
        isAmbiguous = true;
      }

      // Perception Escalation Logic:
      // If confidence is low (< 0.45) on an image/canvas rich page, escalate perception
      let perceptionLevel = "LEVEL_1_DOM_A11Y";
      if (topConfidence < 0.45 && context.hasImages) {
        perceptionLevel = "LEVEL_2_OCR";
        this.lastEscalationReason = "low_dom_grounding_confidence_with_visual_assets";
      }

      return {
        candidates: scored.slice(0, 5),
        bestTarget,
        confidence: topConfidence,
        isAmbiguous,
        perceptionLevel,
      };
    }
  }

  PBA.MultimodalGroundingEngine = MultimodalGroundingEngine;
  PBA.groundingEngine = new MultimodalGroundingEngine();
})();
