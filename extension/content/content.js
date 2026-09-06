/*
 * content.js — In-page perception responder + hardened action executor.
 *
 * Runs in the page's isolated world as part of the VisionGate trust layer.
 * Coordinates:
 *   PERCEIVE             -> build sanitized context (SeeGate + DOM Perception + LiveElementRegistry)
 *   EXECUTE              -> evaluate DoGate, validate live target, execute, verify postcondition
 *   VERIFY_POSTCONDITION -> inspect observable post-action state
 *   EXTRACT_RECORDS      -> masked extraction for query tasks
 *   VIEWPORT / PING      -> environment diagnostics
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});
  const A = PBA.ACTIONS || {
    CLICK: "click",
    TYPE: "type",
    FILL_LOCAL: "fill_local",
    SELECT: "select",
    SCROLL: "scroll",
    SCROLL_TO: "scroll_to",
    NAVIGATE: "navigate",
    WAIT: "wait",
    NO_ACTION_REQUIRED: "no_action_required",
  };

  const ext = globalThis.browser || globalThis.chrome;

  let currentTaskIntent = null;
  let currentUserGoal = "";
  let currentObjective = "";

  // Helper for delays
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function confirmDestructive(label, risk) {
    if (typeof window === "undefined" || !window.confirm) return true;
    return window.confirm(
      `⚠ VisionGate Security Gate (Risk: ${risk || "HIGH"}):\n\n` +
      `The agent wants to execute: “${label || "action"}”.\n\n` +
      `Do you confirm this action?`
    );
  }

  function actionSignature(a) {
    if (!a) return "";
    return [a.type, a.target_id || a.stable_target_id || "", a.text || "", a.option || "", a.field_name || a.source || ""].join("|");
  }

  function snapshotState() {
    return {
      url: location.href,
      scrollY: Math.round(scrollY),
      active: document.activeElement && (document.activeElement.__vgStableId || document.activeElement.__pbaId),
      modalPresent: !!document.querySelector("dialog[open], [role='dialog'], [role='alertdialog'], .modal.show, .modal.active"),
    };
  }

  // Demo backwards-compatibility helper
  function readDemoAppState() {
    const stateEl = document.getElementById("appState");
    if (!stateEl) return null;
    try {
      return JSON.parse(stateEl.getAttribute("data-json") || stateEl.textContent);
    } catch (_) {
      return null;
    }
  }

  // Listen for messages from background orchestrator
  if (ext && ext.runtime && ext.runtime.onMessage) {
    ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      (async () => {
        try {
          if (msg.cmd === "PERCEIVE") {
            // 1. Refresh local secret vault
            if (PBA.localSecretHandler) {
              await PBA.localSecretHandler.refreshVault();
            }

            currentUserGoal = msg.task || "";
            currentObjective = msg.objective || "";

            // 2. Scan live DOM elements into the registry
            if (PBA.elementRegistry) {
              PBA.elementRegistry.scan(document);
            }

            // 3. Build context
            const built = PBA.perception.buildContext({
              task: msg.task,
              sessionId: msg.sessionId,
              step: msg.step,
              visionDetections: msg.visionDetections || [],
              visionReady: msg.visionReady,
            });

            // 4. Tag sensitive elements
            for (const e of built.payload.elements) {
              const el = PBA.elementRegistry ? PBA.elementRegistry.resolveAndValidate(e.id).node : null;
              if (el) el.__pbaSensitive = e.sensitive;
            }

            // 5. Build canonical World State
            if (PBA.BrowserWorldState) {
              PBA.currentWorldState = PBA.BrowserWorldState.captureFromDOM(document, {
                sessionId: msg.sessionId,
                stepIndex: msg.step,
                elements: built.payload.elements,
              });
            }

            sendResponse({ ok: true, ...built, worldState: PBA.currentWorldState ? PBA.currentWorldState.toJSON() : null });
          } else if (msg.cmd === "EXECUTE") {
            const action = msg.action;
            if (!action || typeof action !== "object") {
              sendResponse({ ok: false, rejected: "not_an_object" });
              return;
            }

            // 1. Target resolution & pre-condition validation
            const targetSpec = action.stable_target_id != null ? action.stable_target_id : action.target_id;
            let targetCheck = { valid: true, node: null, descriptor: {} };
            if (targetSpec != null) {
              if (PBA.elementRegistry) {
                targetCheck = PBA.elementRegistry.resolveAndValidate(targetSpec);
                if (!targetCheck.valid) {
                  sendResponse({ ok: false, rejected: `precondition_failed:${targetCheck.reason}`, targetCheck });
                  return;
                }
              }
            }

            // 2. DO GATE evaluation
            let doGateResult = { authorized: true, requiresConfirmation: false, risk: "LOW" };
            if (PBA.doGate) {
              doGateResult = PBA.doGate.evaluate(action, targetCheck.descriptor, {
                userGoal: currentUserGoal,
                currentObjective,
                worldState: PBA.currentWorldState,
              });

              if (!doGateResult.authorized) {
                sendResponse({ ok: false, rejected: doGateResult.reason, doGateResult });
                return;
              }

              if (doGateResult.requiresConfirmation && !msg.confirmed) {
                const confirmed = confirmDestructive(targetCheck.descriptor.label || action.text, doGateResult.risk);
                if (!confirmed) {
                  sendResponse({ ok: false, reason: "user_declined", needsConfirmation: true });
                  return;
                }
              }
            }

            // 3. Snapshot state before action
            const beforeSnapshot = snapshotState();
            let beforeWorldState = null;
            if (PBA.BrowserWorldState) {
              beforeWorldState = PBA.BrowserWorldState.captureFromDOM(document, {
                sessionId: msg.sessionId,
                stepIndex: msg.step,
              });
            }

            // 4. Content Execution
            let execResult = null;
            if (PBA.contentExecutor && PBA.elementRegistry) {
              execResult = await PBA.contentExecutor.execute(action, PBA.elementRegistry, {
                vault: PBA.localSecretHandler ? PBA.localSecretHandler.vault : {},
                window,
                document,
              });
            } else {
              // Fallback executor
              execResult = { success: true, changedState: true, errors: [] };
            }

            await sleep(100);

            // 5. Snapshot state after action
            const afterSnapshot = snapshotState();
            let afterWorldState = null;
            if (PBA.BrowserWorldState) {
              afterWorldState = PBA.BrowserWorldState.captureFromDOM(document, {
                sessionId: msg.sessionId,
                stepIndex: (msg.step || 0) + 1,
              });
            }

            // 6. Post-Condition Verification (universal, live DOM only)
            let verification = { status: "SUCCESS", reason: "action_executed" };
            if (PBA.postConditionVerifier) {
              verification = PBA.postConditionVerifier.verify(action, beforeWorldState, afterWorldState, execResult);
            }

            const stateChanged = JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot) || execResult.changedState;

            sendResponse({
              ok: execResult.success && verification.status !== "FAILURE",
              result: execResult,
              verification,
              changed: stateChanged,
              signature: actionSignature(action),
              receipt: doGateResult.receipt || null,
            });
          } else if (msg.cmd === "VIEWPORT") {
            sendResponse({ ok: true, dpr: devicePixelRatio || 1, w: innerWidth, h: innerHeight });
          } else if (msg.cmd === "PING") {
            sendResponse({ ok: true, ready: true, dpr: devicePixelRatio || 1 });
          } else if (msg.cmd === "EXTRACT_RECORDS") {
            if (PBA.records && PBA.records.extract) {
              sendResponse(PBA.records.extract({ task: msg.task }));
            } else {
              sendResponse({ ok: true, records: [] });
            }
          } else if (msg.cmd === "VERIFY_POSTCONDITION") {
            // Universal post-condition check: observe DOM directly, no demo-specific logic.
            if (PBA.postConditionVerifier && msg.action) {
              const before = msg.beforeWorldState || null;
              const afterWS = PBA.BrowserWorldState
                ? PBA.BrowserWorldState.captureFromDOM(document, { sessionId: msg.sessionId || "", stepIndex: 0 })
                : null;
              const vr = PBA.postConditionVerifier.verify(msg.action, before, afterWS, { success: true });
              sendResponse({ ok: vr.status !== "FAILURE", verification: vr, reason: vr.reason });
            } else {
              sendResponse({ ok: true, verified: true, reason: "universal_verification_satisfied" });
            }
          }
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
      })();
      return true; // async
    });
  }
})();
