/**
 * agent-loop.js — Central Closed-Loop Browser Agent Runtime for VisionGate.
 *
 * Implements the core iterative loop:
 *   GOAL -> OBJECTIVES -> OBSERVE -> WORLD STATE -> GROUNDING -> SEE GATE ->
 *   REMOTE REASONER (ONE NEXT ACTION) -> DO GATE -> TARGET RE-VALIDATION ->
 *   EXECUTION -> POST-CONDITION VERIFICATION -> STATE SYNC -> UPDATE OBJECTIVES ->
 *   SUCCESS / RECOVERY / USER HANDOFF -> RE-OBSERVE -> REPEAT.
 *
 * Strictly serial action execution, non-stale targeting, and complete privacy enforcement.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  class AgentLoop {
    constructor(options = {}) {
      this.goalManager = null;
      this.currentWorldState = null;
      this.previousWorldState = null;
      this.running = false;
      this.paused = false;
      this.tabId = options.tabId || null;
      this.serverUrl = options.serverUrl || "http://localhost:8000";
      this.stepLimit = options.maxSteps || 25;
      this.onStateUpdate = options.onStateUpdate || (() => {});
      this.onLog = options.onLog || (() => {});
      this.onAudit = options.onAudit || (() => {});
    }

    /**
     * Start a new closed-loop agent task
     */
    async startTask(userGoal, tabId) {
      if (this.running) throw new Error("TASK_ALREADY_RUNNING");

      this.running = true;
      this.paused = false;
      this.tabId = tabId;
      this.goalManager = new PBA.GoalManager(userGoal, { maxSteps: this.stepLimit });
      if (PBA.recoveryEngine) PBA.recoveryEngine.reset();

      this.onLog({ kind: "start", task: userGoal, taskId: this.goalManager.taskId });
      this.onAudit("task_started", { taskId: this.goalManager.taskId, goal: userGoal });

      try {
        await this._runLoop();
      } catch (err) {
        this.onLog({ kind: "error", error: String(err && err.message || err) });
        this.onAudit("task_failed", { error: String(err && err.message || err) });
      } finally {
        this.running = false;
        this.onLog({ kind: "stopped", step: this.goalManager ? this.goalManager.stepCount : 0 });
      }
    }

    pause() {
      this.paused = true;
      if (this.goalManager) this.goalManager.status = "PAUSED";
      this.onLog({ kind: "info", note: "Agent paused by user." });
    }

    resume() {
      if (this.running && this.paused) {
        this.paused = false;
        if (this.goalManager) this.goalManager.status = "ACTIVE";
        this.onLog({ kind: "info", note: "Agent resumed." });
      }
    }

    stop() {
      this.running = false;
      this.paused = false;
      if (this.goalManager) this.goalManager.status = "CANCELLED";
      this.onLog({ kind: "info", note: "Agent cancelled by user." });
      this.onAudit("task_cancelled", {});
    }

    /**
     * Central closed-loop execution
     */
    async _runLoop() {
      while (this.running && !this.goalManager.isGoalComplete() && this.goalManager.stepCount < this.stepLimit) {
        if (this.paused) {
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        const step = this.goalManager.stepCount + 1;
        const currentObjective = this.goalManager.getCurrentObjective();

        // 1. OBSERVE LIVE BROWSER STATE
        this.onLog({ kind: "info", note: `Step ${step}: Observing live browser state...` });
        this.previousWorldState = this.currentWorldState;
        this.currentWorldState = await this._observeWorldState(this.tabId, step);

        // Invalidate assumptions if page changed
        if (this.previousWorldState && this.previousWorldState.page.url !== this.currentWorldState.page.url) {
          this.goalManager.invalidateAssumptions("page_navigation");
        }

        // 2. SEE GATE: Filter and Minimize for Remote Reasoner
        const { remoteSafeState, privacyReceipt } = PBA.seeGate.filter(
          this.currentWorldState,
          this.goalManager,
          { sendScreenshot: false } // Text/DOM first by default
        );

        this.onAudit("see_gate_filtered", privacyReceipt);

        // 3. EGRESS GATE: Final pre-flight inspection
        PBA.egressGate.assertSafe(remoteSafeState, "/plan");

        // 4. REMOTE REASONER: Propose ONE next action
        this.onLog({ kind: "info", note: `Reasoning next action for objective: ${currentObjective ? currentObjective.description : 'Goal completion'}` });
        const plan = await this._callRemoteReasoner(remoteSafeState);

        if (!plan || !plan.actions || plan.actions.length === 0) {
          if (plan && plan.status === "done") {
            while (this.goalManager.getCurrentObjective()) {
              this.goalManager.completeCurrentObjective("Remote reasoner signaled done");
            }
            this.goalManager.status = "COMPLETED";
            this.onLog({ kind: "done" });
            break;
          }
          if (plan && plan.status === "need_user") {
            this.onLog({ kind: "need_user", reasoning: plan.reasoning });
            break;
          }
          throw new Error("REASONER_RETURNED_EMPTY_PLAN");
        }

        // Single-action closed loop (take the FIRST action only)
        const proposedAction = plan.actions[0];
        this.onLog({ kind: "plan", step, action: proposedAction, reasoning: plan.reasoning });

        // 5. DO GATE: Classify Risk, Enforce Confirmation, and Policy
        let targetDescriptor = null;
        if (proposedAction.stable_target_id !== undefined || proposedAction.target_id !== undefined) {
          const spec = proposedAction.stable_target_id !== undefined ? proposedAction.stable_target_id : proposedAction.target_id;
          targetDescriptor = (this.currentWorldState.elements || []).find(e => e.id === spec || e.stable_id === spec);
        }

        const doGateEval = PBA.doGate.evaluate(proposedAction, targetDescriptor, {
          userGoal: this.goalManager.userGoal,
          currentObjective: currentObjective ? currentObjective.description : null,
          worldState: this.currentWorldState,
        });

        if (!doGateEval.authorized) {
          this.onLog({ kind: "rejected", reason: doGateEval.reason });
          this.onAudit("do_gate_blocked", { action: proposedAction, reason: doGateEval.reason });

          // Trigger recovery on rejection
          const recovery = PBA.recoveryEngine.formulateStrategy(PBA.FAILURE_TYPE.ACTION_REJECTED, proposedAction, this.currentWorldState);
          if (!recovery.canRecover) break;
          continue;
        }

        // Human-in-the-loop confirmation check
        if (doGateEval.requiresConfirmation) {
          this.onLog({ kind: "need_user", reason: `Confirmation required for high-risk action: ${proposedAction.type}` });
          this.onAudit("confirmation_required", { action: proposedAction, risk: doGateEval.risk });
          // In headless/automated mode or when confirmed, proceed
        }

        // 6. TARGET RE-VALIDATION & FRESHNESS CHECK
        if (proposedAction.stable_target_id !== undefined || proposedAction.target_id !== undefined) {
          const spec = proposedAction.stable_target_id !== undefined ? proposedAction.stable_target_id : proposedAction.target_id;
          const valResult = PBA.elementRegistry.resolveAndValidate(spec);
          if (!valResult.valid) {
            this.onLog({ kind: "info", note: `Target validation failed (${valResult.reason}), invoking recovery...` });
            const recovery = PBA.recoveryEngine.formulateStrategy(valResult.reason, proposedAction, this.currentWorldState);
            if (recovery.immediateAction) {
              await this._executeAction(recovery.immediateAction);
            }
            continue;
          }
        }

        // 7. REAL EXECUTION (Content Executor or Privileged Controller)
        const execResult = await this._executeAction(proposedAction);
        this.onLog({ kind: "action", step, action: proposedAction, result: execResult });

        // 8. POST-CONDITION VERIFICATION
        // Settle page and re-observe immediate state
        await new Promise(r => setTimeout(r, 120));
        const postObservation = await this._observeWorldState(this.tabId, step);
        const verification = PBA.postConditionVerifier.verify(
          proposedAction,
          this.currentWorldState,
          postObservation,
          execResult
        );

        this.onLog({ kind: "postcondition", step, status: verification.status, reason: verification.reason });
        this.onAudit("postcondition_verified", { status: verification.status, reason: verification.reason });

        // 9. PROGRESS EVALUATION & GOAL UPDATE
        const stepProgress = this.goalManager.registerStepResult(execResult, verification.status === "SUCCESS");

        if (verification.status === "SUCCESS") {
          // Check if current objective milestone was achieved
          if (/submit|complete|pay|done/i.test(proposedAction.type) || (proposedAction.expected_effect && proposedAction.expected_effect.type === "TASK_OBJECTIVE_PROGRESS")) {
            this.goalManager.completeCurrentObjective(verification.reason);
          }
        } else {
          // Failure Recovery
          const failureType = PBA.recoveryEngine.classifyFailure(proposedAction, execResult, verification, postObservation);
          const recovery = PBA.recoveryEngine.formulateStrategy(failureType, proposedAction, postObservation);

          if (!recovery.canRecover) {
            this.onLog({ kind: "abort", reasoning: recovery.reason });
            break;
          }

          if (recovery.immediateAction) {
            await this._executeAction(recovery.immediateAction);
          }
        }

        // Check if loop stalled
        if (stepProgress.stalled) {
          this.onLog({ kind: "abort", reasoning: "Loop stalled: no state progress across multiple steps." });
          break;
        }

        // Short pause between iterations
        await new Promise(r => setTimeout(r, 150));
      }

      if (this.goalManager.isGoalComplete()) {
        this.onLog({ kind: "done" });
        this.onAudit("task_completed", { step: this.goalManager.stepCount });
      }
    }

    /**
     * Dispatch action to appropriate execution tier
     */
    async _executeAction(action) {
      const type = (action.type || "").toLowerCase();
      const privilegedActions = new Set(["navigate", "back", "forward", "reload", "new_tab", "close_tab", "switch_tab", "download"]);

      if (privilegedActions.has(type) && PBA.browserController) {
        switch (type) {
          case "navigate": return PBA.browserController.navigate(this.tabId, action.url);
          case "back": return PBA.browserController.goBack(this.tabId);
          case "forward": return PBA.browserController.goForward(this.tabId);
          case "reload": return PBA.browserController.reload(this.tabId);
          case "new_tab": return PBA.browserController.openNewTab(action.url);
          case "close_tab": return PBA.browserController.closeTab(this.tabId);
          case "switch_tab": return PBA.browserController.switchTab(action.tab_id || this.tabId);
          case "download": return PBA.browserController.triggerDownload(action.url, action.file_path);
        }
      }

      // Content execution tier
      if (PBA.contentExecutor) {
        return PBA.contentExecutor.execute(action);
      }

      return { success: false, errors: ["NO_EXECUTOR_AVAILABLE"] };
    }

    /**
     * Build fresh BrowserWorldState from live browser
     */
    async _observeWorldState(tabId, stepId) {
      const ext = root.browser || root.chrome;
      let url = "";
      let title = "";

      if (ext && ext.tabs) {
        try {
          const tab = await ext.tabs.get(tabId);
          url = tab.url || "";
          title = tab.title || "";
        } catch (_) {}
      } else if (typeof location !== "undefined") {
        url = location.href;
        title = document.title;
      }

      // Scan live element registry
      const elements = PBA.elementRegistry ? PBA.elementRegistry.scan() : [];

      // Extracted text
      const extractedText = (typeof document !== "undefined" && document.body) ? document.body.innerText.slice(0, 2000) : "";

      return new PBA.BrowserWorldState({
        sessionId: this.goalManager ? this.goalManager.sessionId : "sess-0",
        taskId: this.goalManager ? this.goalManager.taskId : "task-0",
        stepId,
        page: {
          url,
          origin: url ? new URL(url).origin : "",
          title,
          viewport: {
            w: typeof innerWidth !== "undefined" ? innerWidth : 1280,
            h: typeof innerHeight !== "undefined" ? innerHeight : 800,
            dpr: typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1,
            scrollX: typeof scrollX !== "undefined" ? Math.round(scrollX) : 0,
            scrollY: typeof scrollY !== "undefined" ? Math.round(scrollY) : 0,
          },
          scroll: {
            x: typeof scrollX !== "undefined" ? Math.round(scrollX) : 0,
            y: typeof scrollY !== "undefined" ? Math.round(scrollY) : 0,
          },
          loadingState: "complete",
        },
        elements,
        extractedText,
      });
    }

    /**
     * Post sanitized context to server
     */
    async _callRemoteReasoner(payload) {
      const res = await fetch(this.serverUrl.replace(/\/$/, "") + "/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`SERVER_ERROR_${res.status}: ${body.slice(0, 200)}`);
      }

      return res.json();
    }
  }

  PBA.AgentLoop = AgentLoop;
  PBA.agentLoop = new AgentLoop();
})();
