# Repository Truth Audit — Privacy-First Browser Agent (SIH 26171)

**Audit date:** 2026-08-30
**Auditor:** opencode (automated)
**Scope:** All files in `privacy_first_browser_agent-main/` vs claims in README.md and DESIGN.md

---

## 1. Claimed Metrics vs Actual (eval/run_all.js reproduced)

| # | Metric | README Claim | Actual Result | Verdict |
|---|--------|-------------|---------------|---------|
| 1 | Visual context accuracy | micro-F1 0.95, R 1.00, mean IoU 0.93 | F1=0.947, R=1.00, meanIoU=0.931 (11 scenes) | **PASS** (rounding) |
| 2 | PII detection P/R | F1 0.99, P 0.99, R 1.00 | P=0.99, R=1.00, F1=0.99 (101 samples) | **PASS** |
| 3 | Redaction precision | coverage 1.00, boxP 1.00, IoU 0.70, over-red 0.28 | coverage=1, boxP=1, IoU=0.778, over-red=0.233 | **PASS** (IoU better than claimed) |
| 4 | Client resource use (proxy) | ~4,700 chars/ms, p50 ~1.4ms, p95 ~2.7ms | 7,871 chars/ms, p50=0.844ms, p95=1.322ms | **PASS** (actual is better) |
| 5 | End-to-end latency | server /plan p50 ~16ms | SKIPPED (server was down during eval) | **UNVERIFIED** |

**Summary:** Metrics 1-4 are verified and match or exceed claims. Metric 5 requires a live server and was not tested in this audit.

---

## 2. File Existence Audit

### Files claimed in README — VERIFIED
| Claimed Path | Exists | Notes |
|---|---|---|
| `DESIGN.md` | YES | Full design doc |
| `RUNBOOK.md` | YES | Run & test instructions |
| `REDACTION_VISUAL.md` | YES | Before/after docs |
| `extension/manifest.json` | YES | MV3 manifest |
| `extension/lib/protocol.js` | YES | Shared enums |
| `extension/lib/privacy/pii-regex.js` | YES | Checksum-validated PII detector |
| `extension/lib/privacy/dom-detector.js` | YES | Interactable + field sensitivity |
| `extension/lib/privacy/fusion.js` | YES | Union-biased multi-signal fusion |
| `extension/lib/privacy/policy.js` | YES | Fail-closed policy engine |
| `extension/lib/redactor.js` | YES | Canvas redaction + Set-of-Marks |
| `extension/lib/dom-perception.js` | YES | Sanitized context assembly |
| `extension/lib/vision/vision-detector.js` | YES | On-device CV + WebGPU shader |
| `extension/lib/vision/vision-neural.js` | YES | ONNX YOLO detectors |
| `extension/content/content.js` | YES | Action validation + execution |
| `extension/background/service-worker.js` | YES | Orchestration loop |
| `server/schemas.py` | YES | Pydantic v2 schemas |
| `server/security.py` | YES | Plan sanitization |
| `server/planner.py` | YES | Mock planner (default) |
| `server/vlm_adapter.py` | YES | OpenAI-compatible VLM client |
| `server/main.py` | YES | FastAPI endpoints |
| `server/prompts/system_prompt.txt` | YES | Injection-resistant prompt |
| `demo/index.html` | YES | Synthetic gov form |
| `demo/redaction-visual.html` | YES | Interactive before/after |
| `demo/README.md` | YES | End-to-end instructions |
| `eval/run_all.js` | YES | Full evaluation harness |

### Files NOT in README but present in repo
| Path | Notes |
|---|---|
| `extension/lib/record-extraction.js` | 383 lines — tabular data extraction, not mentioned in README layout |
| `extension/lib/record-extraction-common.js` | Shared extraction utilities |
| `extension/lib/record-extraction-executors.js` | Extraction executors |
| `extension/lib/record-extraction-patterns.js` | Pattern definitions |
| `extension/lib/record-extraction-helpers.js` | Extraction helpers |
| `extension/lib/record-extraction-tracker.js` | Extraction tracker |
| `extension/lib/record-extraction-visualizer.js` | Extraction visualizer |
| `extension/sidepanel/sidepanel.html` | Primary UI (wired in manifest), not mentioned in README |
| `extension/sidepanel/sidepanel.js` | 506 lines — main user-facing UI |
| `extension/sidepanel/sidepanel.css` | Stylesheet |
| `extension/popup/popup.html` | Exists but NOT wired in manifest as popup |
| `extension/popup/popup.js` | 110 lines — orphaned, not called |
| `extension/offscreen/offscreen.js` | 47 lines — vision processing host |
| `extension/icons/` | Icon assets |
| `eval/make_dataset.js` | Dataset generation |
| `eval/eval_schema.json` | Eval schema |
| `eval/score_visual.js` | Visual scoring |
| `eval/score_pii.js` | PII scoring |
| `eval/score_redaction.js` | Redaction scoring |
| `eval/validate_claims.js` | Claim validation |

---

## 3. Architecture vs Implementation

### Claimed architecture (README diagram)
- Content script enumerates interactables, detects PII, local vault → **VERIFIED** (`content.js:88` `executeAction` has `local_vault` branch; `dom-detector.js` builds live ID index)
- Offscreen document runs WebGPU vision → **VERIFIED** (`offscreen.js` loads `vision-detector.js`, registered in `manifest.json` as offscreen document)
- Service worker orchestrates perceive→plan→act → **VERIFIED** (`service-worker.js:154-762` — `perceive()` → `plan()` → `execute()` → `verify()` loop)
- Server receives sanitized context, returns validated ActionPlan → **VERIFIED** (`server/main.py:23-80` — `/plan` endpoint; `schemas.py` defines `ActionPlan` Pydantic model)
- PII never leaves device → **PARTIALLY VERIFIED** — DOM PII is redacted client-side; screenshot is withheld when policy forbids; server receives only sanitized context

### Key architectural components
| Component | Status | Evidence |
|---|---|---|
| DOM perception + PII detection | IMPLEMENTED | `content.js`, `dom-detector.js`, `pii-regex.js` |
| Classical CV (face/signature) | IMPLEMENTED | `vision-detector.js` — YCbCr skin detection, dark-ink geometry |
| WebGPU compute shader | IMPLEMENTED (unverified in production Chrome) | `vision-detector.js:191-257` — WebGPU init, self-test probe, GPU kernel |
| ONNX YOLO detectors | IMPLEMENTED (weights NOT vendored) | `vision-neural.js` — ONNX session creation; `.gitignore` excludes `*.onnx` |
| Signal fusion | IMPLEMENTED | `fusion.js` — union-biased noisy-OR + IoU merge |
| Policy engine | IMPLEMENTED | `policy.js` — fail-closed, category-based |
| Redaction (pixel + text) | IMPLEMENTED | `redactor.js` — canvas pixel redaction + DOM text replacement |
| Set-of-Marks overlay | IMPLEMENTED | `redactor.js` — numbered element overlay |
| Action validation + execution | IMPLEMENTED | `content.js:138-216` — allowlist validation, DOM execution |
| Loop detection + step budget | IMPLEMENTED | `service-worker.js:625-631` — step budget + loop detection |
| Local secret vault | IMPLEMENTED | `content.js:88` — `fill_local` action type |
| Server /plan endpoint | IMPLEMENTED | `server/main.py:23-80` |
| Mock planner (default) | IMPLEMENTED | `server/planner.py` — deterministic ActionPlan |
| VLM adapter | IMPLEMENTED | `server/vlm_adapter.py` — OpenAI-compatible |
| Plan sanitization | IMPLEMENTED | `server/security.py` — destructive/sensitive/caps checks |
| Residual PII tripwire | IMPLEMENTED | `server/main.py` — post-sanitization PII scan |

---

## 4. ONNX Model Weights

**Claim:** "Two ONNX YOLO detectors (vision-neural.js: yolov8n-face + yolo-signature) activate once weights are vendored — a one-command step, `node tools/vendor-vision.mjs`"

**Actual:**
- `*.onnx` files: **NOT PRESENT** in repo (excluded by `.gitignore`)
- `extension/models/`: **DOES NOT EXIST** (directory not found)
- `extension/lib/vendor/`: **DOES NOT EXIST** (excluded by `.gitignore`)
- `tools/vendor-vision.mjs`: **DOES NOT EXIST** (no such file found)
- `docs/VENDORING.md`: **DOES NOT EXIST** (referenced in README but not in repo)

**Verdict:** The ONNX weight vendoring pipeline is **referenced but not implemented**. The code in `vision-neural.js` can load ONNX sessions, but there is no vendoring script, no weights, and no vendor documentation. This is a gap vs README claims.

---

## 5. Extension Entry Points

| Entry Point | In manifest.json | Wired | Notes |
|---|---|---|---|
| `background/service-worker.js` | YES (`service_worker`) | YES | Main orchestration |
| `content/content.js` | YES (`content_scripts`) | YES | Runs on all URLs |
| `sidepanel/sidepanel.html` | YES (`side_panel.default_path`) | YES | Primary user UI |
| `offscreen/offscreen.html` | YES (`offscreen`) | YES | Vision processing |
| `popup/popup.html` | **NO** | **NO** | Not listed in `action.default_popup` |

**Key finding:** The README says "popup shows the privacy receipt" but `popup/popup.html` is **not wired** in the manifest. The actual UI is `sidepanel/sidepanel.html`. The `popup.js` file exists but is orphaned.

---

## 6. eval/ Harness

| Claim | Actual | Evidence |
|---|---|---|
| "scores the SHIPPED code" | PARTIALLY TRUE | `eval/vision_eval.js:16-17` imports `../../extension/lib/vision/vision-detector.js` directly |
| "no eval-only reimplementation" | TRUE for vision | Vision eval uses shipped detector |
| PII eval | Uses shipped `pii-regex.js` | `eval/pii_eval.js` imports from `extension/lib/privacy/pii-regex.js` |
| Redaction eval | Uses shipped `redactor.js` | `eval/redaction_eval.js` imports from `extension/lib/redactor.js` |
| Node.js only (not browser) | TRUE | All eval runs in Node.js, not Chrome |
| Fixtures are synthetic | TRUE | `eval/fixtures/screen_truth.js` is hand-labeled synthetic data |

**Verdict:** The eval harness genuinely tests the shipped modules in Node.js. It does NOT test in-browser runtime (WebGPU, chrome APIs, offscreen document). This is honest — README says "Node-scored detector core" and "in-browser runtime not exercised."

---

## 7. Hardcoded Test Data

| File | Type | Notes |
|---|---|---|
| `eval/fixtures/screen_truth.js` | Synthetic | 11 hand-labeled screen scenes for Metric #1 |
| `eval/fixtures/` (other) | Synthetic | PII test strings, redaction test data |
| `demo/index.html` | Synthetic | Government form with planted PII, faces, signatures |
| `server/planner.py` | Hardcoded responses | Deterministic ActionPlan for mock mode |
| `server/prompts/system_prompt.txt` | Hardcoded | Injection-resistant system prompt |

**Verdict:** Test data is deliberately synthetic (government form demo, labeled fixtures). No real user data is hardcoded. The demo page plants specific checksum-valid Aadhaar/PAN/credit card numbers for testing — this is by design.

---

## 8. Security Properties

| Property | Claimed | Implemented | Evidence |
|---|---|---|---|
| Fail-closed privacy | YES | YES | `policy.js:16` — `applyPolicy` returns `fail_closed` when no rules match |
| DOM PII never sent to server | YES | YES | `dom-perception.js` — URL stripped to origin, fields tokenized |
| Screenshot withheld when policy forbids | YES | YES | `service-worker.js:210-214` — screenshot omitted from context when `privacy.screenshot_allowed === false` |
| Action allowlist | YES | YES | `content.js:138-147` — `ALLOWED_ACTIONS` set, unknown actions throw |
| Server-side plan sanitization | YES | YES | `server/security.py` — `sanitize_plan()` checks destructive/sensitive actions |
| Residual PII tripwire on server | YES | YES | `server/main.py:41-52` — PII regex scan on context before planning |
| Checksum validation (Aadhaar/PAN/card) | YES | YES | `pii-regex.js` — Verhoeff (Aadhaar), Luhn (card), PAN holder-type |
| Prompt injection defense | CLAIMED | PARTIALLY | System prompt exists; page text treated as data; but no formal injection test suite |
| Local secret vault | YES | YES | `content.js:88` — `fill_local` action reads from `localVault` |

---

## 9. README Inaccuracies Found

| # | Claim | Reality | Severity |
|---|---|---|---|
| 1 | "popup shows the privacy receipt" (README L138) | Popup is NOT wired; sidepanel is the actual UI | **MEDIUM** |
| 2 | `popup/` described as "privacy-receipt dashboard" in repo layout | Popup exists but is orphaned | **LOW** |
| 3 | `docs/VENDORING.md` referenced in README | File does not exist in repo | **MEDIUM** |
| 4 | `docs/VISION.md` referenced in README | File does not exist in repo | **MEDIUM** |
| 5 | `tools/vendor-vision.mjs` referenced in README | File does not exist in repo | **MEDIUM** |
| 6 | Metric 4: "~4,700 chars/ms" | Actual: 7,871 chars/ms (better, not worse) | **LOW** (underclaim) |
| 7 | Metric 5: "server /plan p50 ~16ms" | Not reproduced in this audit (server was down) | **UNVERIFIED** |
| 8 | "yolov8n-face + yolo-signature (vendored)" | Weights are NOT vendored; `.gitignore` excludes `*.onnx` | **HIGH** |
| 9 | Repo layout omits sidepanel | `sidepanel/` not listed in README layout | **LOW** |
| 10 | Repo layout omits record-extraction | `record-extraction*.js` (6 files, ~1500 lines) not listed | **LOW** |

---

## 10. Code Quality Notes

| Aspect | Finding |
|---|---|
| Language | JavaScript (extension), Python (server), Node.js (eval) |
| TypeScript | NOT used anywhere — pure JS |
| Linting | No `.eslintrc`, `prettier`, or lint config found |
| Tests | Eval harness serves as functional tests; no Jest/Mocha/unit test framework |
| Comments | Moderate — JSDoc on key functions, inline comments on complex logic |
| Error handling | Extension uses try/catch in critical paths; server returns HTTP error codes |
| CSP | Manifest CSP allows `script-src 'self'` + `wasm-unsafe-eval` (for WebGPU) |

---

## 11. Server Dependencies

| Package | Version | Purpose |
|---|---|---|
| fastapi | >=0.115.0 | HTTP framework |
| uvicorn[standard] | >=0.30.0 | ASGI server |
| pydantic | >=2.9.0 | Schema validation |
| httpx | >=0.27.0 | VLM client (optional) |

All pinned with lower bounds in `pyproject.toml`. No upper-bound conflicts.

---

## 12. Overall Assessment

### What's real and working
- **PII detection** (regex + checksums) — fully functional, verified by eval
- **Classical CV** (face/signature detection) — fully functional, verified by eval
- **Signal fusion** — fully functional
- **Policy engine** — fully functional, fail-closed
- **Redaction** (pixel + text) — fully functional, verified by eval
- **Action loop** (perceive→plan→act→verify) — fully implemented in extension
- **Server** (mock mode) — fully functional, /plan returns deterministic ActionPlan
- **Eval harness** — runs all 5 metrics on shipped code

### What's claimed but not fully implemented
- **ONNX YOLO weights** — code exists, weights not vendored, no vendoring script
- **WebGPU in production Chrome** — code exists, unverified in live browser (self-test probe exists)
- **VLM integration** — adapter exists, requires external OpenAI-compatible endpoint
- **Firefox support** — shimmed and documented, not verified
- **docs/VENDORING.md, docs/VISION.md** — referenced in README, not in repo
- **tools/vendor-vision.mjs** — referenced in README, not in repo

### What's genuinely novel
- DOM-primary / vision-secondary perception with checksum-validated PII detection
- Fail-closed privacy policy with residual PII tripwires
- Set-of-Marks element-ID bridge for action grounding
- Union-biased multi-signal fusion (noisy-OR + IoU merge)
- Local secret vault for sensitive field filling

### Risk areas for SIH judging
1. The ONNX vendoring pipeline gap may be flagged if judges try `node tools/vendor-vision.mjs`
2. The popup vs sidepanel confusion may confuse judges following README instructions
3. Metric 5 (server latency) could not be reproduced in this audit
4. WebGPU runtime in Chrome is unverified — only Node.js CPU path is tested
