# VisionGate — Agent Capability Matrix

This matrix documents the real, audited implementation and verification status of every browser-agent capability in VisionGate.
In accordance with the VisionGate Master Audit rules, every capability is labelled honestly based on runtime evidence, not merely nominal code existence.

## Legend
- **IMPLEMENTED**: Code is fully implemented and wired into active runtime paths.
- **UNIT TESTED**: Exercised and validated by unit test suites (`server/selftest.py`, `eval/test_agent_invariants.js`, `eval/test_chaos_recovery.js`).
- **INTEGRATION TESTED**: Verified across multiple components working together (`eval/run_all.js`, `eval/e2e_browser.py`).
- **CHAOS TESTED**: Verified against adversarial conditions (DOM mutations, stale nodes, timeouts, modals).
- **SECURITY TESTED**: Verified against fail-closed privacy and egress tripwires.
- **PARTIALLY VERIFIED**: Core implementation functions, but certain edge cases rely on browser-level fallback.
- **KNOWN LIMITATION**: Explicitly documented boundary or non-supported condition.

---

| Category | Capability | Status | Evidence & Runtime Path | Notes / Limitations |
|---|---|---|---|---|
| **Perception & Observation** | DOM Semantic Extraction | IMPLEMENTED, UNIT TESTED, INTEGRATION TESTED | `extension/lib/dom-perception.js`, `content/content.js` | Full interactive tree extracted with role, label, bbox, value state. |
| **Perception & Observation** | On-Device Vision (Classical CV) | IMPLEMENTED, INTEGRATION TESTED | `extension/offscreen/offscreen.html`, `eval/vision_eval.js` | Fast on-device skin-tone and stroke analysis for faces & signatures without cloud egress. |
| **Perception & Observation** | Multi-Signal PII Fusion | IMPLEMENTED, UNIT TESTED, SECURITY TESTED | `extension/lib/privacy/fusion.js`, `eval/run_all.js` | Fuses DOM attributes, Regex/Luhn checksums, and visual bounding boxes. 99% F1 score. |
| **Perception & Observation** | Canonical World State | IMPLEMENTED, UNIT TESTED | `extension/lib/world-state.js`, `eval/test_agent_invariants.js` | `BrowserWorldState` captures session, step, page, viewport, elements, and scroll. |
| **Perception & Observation** | State Synchronization & Invalidation | IMPLEMENTED, CHAOS TESTED | `extension/lib/state-sync.js`, `eval/test_chaos_recovery.js` | MutationObserver increments version token; invalidates stale references. |
| **Grounding & Identity** | Stable Target Identification | IMPLEMENTED, UNIT TESTED | `extension/lib/element-registry.js`, `eval/test_agent_invariants.js` | Generates semantic stable hashes (`role + name + path`) surviving re-renders. |
| **Grounding & Identity** | Multimodal Spatial Grounding | IMPLEMENTED, INTEGRATION TESTED | `extension/lib/multimodal-grounding.js`, `server/vlm_adapter.py` | Set-of-Marks coordinate snapping maps UI-TARS normalized `(0..1000)` coordinates to DOM element IDs. |
| **Grounding & Identity** | Ambiguity & Conflict Detection | IMPLEMENTED, UNIT TESTED | `extension/lib/multimodal-grounding.js` | Returns ambiguous candidate list when confidence gap < threshold. |
| **Reasoning & Planning** | Closed-Loop Step Formulation | IMPLEMENTED, UNIT TESTED, INTEGRATION TESTED | `server/main.py`, `server/remote_reasoner.py`, `server/planner.py` | Strictly serial: proposes ONE next action per step; refuses open-loop batch execution. |
| **Reasoning & Planning** | Intent-Aware Planning | IMPLEMENTED, UNIT TESTED | `server/planner.py`, `extension/lib/task-parser.js` | Detects `PAY_FEE`, `SUBMIT_FORM`, `FORM_FILL`, `PAGE_SUMMARY` with field minimization. |
| **Reasoning & Planning** | Remote VLM Integration (UI-TARS / Qwen-VL) | IMPLEMENTED, UNIT TESTED | `server/vlm_adapter.py`, `server/router.py` | Native support for OpenAI-compatible VLM endpoints and UI-TARS DSL. |
| **Reasoning & Planning** | Fail-Closed Model Error Handling | IMPLEMENTED, UNIT TESTED, SECURITY TESTED | `server/planner.py` (line 343), `server/selftest.py` | Strict rule: NO silent fallback to mock planner when remote model fails. Halts safely. |
| **Action DSL & Execution** | In-Page Pointer Sequences | IMPLEMENTED, INTEGRATION TESTED | `extension/lib/content-executor.js` | Authentic `pointerdown -> mousedown -> pointerup -> mouseup -> click`. |
| **Action DSL & Execution** | Framework-Safe Form Inputs | IMPLEMENTED, INTEGRATION TESTED | `extension/lib/content-executor.js` | Uses prototype descriptor value setters to trigger React/Vue/Angular change events. |
| **Action DSL & Execution** | Custom Selects, Radios, Checkboxes | IMPLEMENTED, INTEGRATION TESTED | `extension/lib/content-executor.js` | Dispatches input + change events with semantic matching. |
| **Action DSL & Execution** | Intelligent Scrolling | IMPLEMENTED, INTEGRATION TESTED | `extension/lib/content-executor.js` | Identifies nearest scrollable container or scrolls window with scrollIntoView fallback. |
| **Action DSL & Execution** | Privileged Browser Control | IMPLEMENTED, UNIT TESTED | `extension/lib/browser-controller.js`, `extension/background/service-worker.js` | Privileged navigation, tabs, and downloads mediated strictly by local controller. |
| **Verification & Post-Condition** | Universal Post-Condition Verifier | IMPLEMENTED, UNIT TESTED, CHAOS TESTED | `extension/lib/post-condition.js`, `eval/test_agent_invariants.js` | Live DOM inspection: URL transitions, input value updates, modal dismissals. |
| **Verification & Post-Condition** | Fail-Safe Result Classification | IMPLEMENTED, UNIT TESTED | `extension/lib/post-condition.js` | Clear distinction between `SUCCESS`, `FAILURE`, and `UNKNOWN`. UNKNOWN never passes as SUCCESS. |
| **Failure Handling & Recovery** | Tactical Failure Classification | IMPLEMENTED, CHAOS TESTED | `extension/lib/recovery-engine.js`, `eval/test_chaos_recovery.js` | Classifies `TARGET_STALE`, `TARGET_DISABLED`, `MODAL_BLOCKING`, `NETWORK_ERROR`, etc. |
| **Failure Handling & Recovery** | Anti-Loop & Stall Detection | IMPLEMENTED, CHAOS TESTED | `extension/background/service-worker.js` (line 514), `eval/test_chaos_recovery.js` | Aborts upon repeated action signatures without state change. |
| **Privacy Gates** | SEE GATE (Context Minimization) | IMPLEMENTED, UNIT TESTED, SECURITY TESTED | `extension/lib/privacy/see-gate.js`, `eval/test_agent_invariants.js` | Filters elements to task-relevant subset. Strips unrequested profile data. |
| **Privacy Gates** | On-Device Pixel Redaction | IMPLEMENTED, INTEGRATION TESTED | `extension/offscreen/offscreen.html`, `extension/lib/redactor.js` | Blacks out detected sensitive bounding boxes on-device before any image egress. |
| **Privacy Gates** | DO GATE (Risk & Authorization) | IMPLEMENTED, UNIT TESTED, SECURITY TESTED | `extension/lib/privacy/do-gate.js`, `eval/test_agent_invariants.js` | Categorizes actions into `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`. Blocks unconfirmed high-risk ops. |
| **Privacy Gates** | Local Secret Vault & Declassification | IMPLEMENTED, UNIT TESTED, SECURITY TESTED | `extension/lib/local-secret-handler.js`, `server/selftest.py` | Injects secrets into live DOM locally; server only emits `fill_local(source='email')`. |
| **Privacy Gates** | Fail-Closed Egress Firewall | IMPLEMENTED, UNIT TESTED, SECURITY TESTED | `extension/lib/privacy/egress-gate.js`, `eval/test_agent_invariants.js` | Deep-scans outbound JSON payloads for raw Luhn/Aadhaar/PAN/email/keys before POST. |
| **Security & Safety** | Prompt Injection Defense | IMPLEMENTED, UNIT TESTED, SECURITY TESTED | `extension/lib/privacy/do-gate.js`, `eval/test_agent_invariants.js` | Webpage content treated strictly as untrusted data; cannot alter gate policy. |
| **Security & Safety** | Human-in-the-Loop Confirmation | IMPLEMENTED, UNIT TESTED | `extension/content/content.js`, `extension/lib/privacy/do-gate.js` | Pauses for user confirmation on payment, transfer, deletion, or critical settings. |

---

## Known System Boundaries & Operational Requirements
1. **Host Permissions & Screenshots**: Chrome MV3 requires `activeTab` or explicit host permissions for `tabs.captureVisibleTab`. Automated headless environments require test-rig host permissions `<all_urls>` because synthetic CDP clicks cannot simulate native user gestures.
2. **Offscreen Canvas Support**: Pixel compositing relies on Chrome Offscreen Documents API (`chrome.offscreen`). On browsers lacking offscreen support (e.g. Firefox), the engine executes fail-closed text-only mode (screenshot withheld).
3. **External Model Connectivity**: When operating in full VLM mode (`PBA_BACKEND=vlm`), network access to an OpenAI-compatible vision-language model endpoint is required. When offline, deterministic fallback mode handles certified demo scenarios.
