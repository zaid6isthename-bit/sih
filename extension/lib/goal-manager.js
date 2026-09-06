/**
 * goal-manager.js — Explicit Goal & Objective Manager for VisionGate.
 *
 * Implements hierarchical goal decomposition, objective lifecycle management,
 * distinction between observed facts vs assumptions, evidence-based completion,
 * progress tracking, stalled-loop detection, and task checkpoints.
 *
 * Runs locally in the trusted client runtime. Never leaks raw secrets.
 */
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const PBA = (root.PBA = root.PBA || {});

  const STATUS = PBA.OBJECTIVE_STATUS || {
    PENDING: "PENDING",
    IN_PROGRESS: "IN_PROGRESS",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    BLOCKED: "BLOCKED",
    NEEDS_USER: "NEEDS_USER",
  };

  class GoalManager {
    constructor(userGoal = "", options = {}) {
      this.sessionId = options.sessionId || (PBA.newSessionId ? PBA.newSessionId() : "sess-" + Date.now());
      this.taskId = options.taskId || "task-" + Date.now();
      this.userGoal = String(userGoal || "").trim();
      this.createdAt = Date.now();
      this.updatedAt = Date.now();

      // Hierarchical Task Structure
      this.subgoals = [];
      this.objectives = [];
      this.currentObjectiveIndex = 0;

      // Cognitive State: Facts vs Assumptions
      this.observedFacts = new Map(); // key -> { value, source, timestamp, confidence }
      this.assumptions = new Map();   // key -> { statement, invalidated: bool, timestamp }
      this.evidenceLog = [];          // list of verified observations linked to objectives

      // Budget & Limits
      this.stepCount = 0;
      this.maxSteps = options.maxSteps || 25;
      this.timeoutMs = options.timeoutMs || 180000; // 3 minutes default
      this.consecutiveNoProgressCount = 0;
      this.maxNoProgressLimit = options.maxNoProgressLimit || 3;
      this.isStalled = false;
      this.status = "ACTIVE"; // ACTIVE, PAUSED, COMPLETED, FAILED, CANCELLED, BLOCKED, NEEDS_USER

      // Initial task breakdown
      this._decomposeGoal(this.userGoal);
    }

    /**
     * Decompose user goal into structured objectives
     */
    _decomposeGoal(goalText) {
      if (!goalText) return;
      const lower = goalText.toLowerCase();

      // General intent pattern matching for initial objective hypothesis
      if (/search|find|compare|best|cheapest/i.test(lower)) {
        this.addObjective("Search for candidate items matching criteria", { type: "SEARCH" });
        this.addObjective("Collect and inspect candidate details", { type: "COLLECT" });
        this.addObjective("Compare candidates against constraints", { type: "COMPARE" });
        this.addObjective("Select and open/action the best candidate", { type: "FINALIZE" });
      } else if (/fill|complete|submit|apply/i.test(lower)) {
        this.addObjective("Inspect form fields and identify required inputs", { type: "INSPECT_FORM" });
        this.addObjective("Fill required fields from local profile safely", { type: "FILL_FIELDS" });
        this.addObjective("Locate and validate submission control", { type: "LOCATE_SUBMIT" });
        this.addObjective("Submit form and verify successful state", { type: "SUBMIT" });
      } else if (/pay|fee|payment/i.test(lower)) {
        this.addObjective("Locate fee and payment section on page", { type: "LOCATE_FEE" });
        this.addObjective("Verify fee amount and initiate payment", { type: "INITIATE_PAYMENT" });
        this.addObjective("Obtain user confirmation for payment", { type: "CONFIRM_PAYMENT" });
        this.addObjective("Verify payment completion status", { type: "VERIFY_PAYMENT" });
      } else if (/what\s+is\s+on|summar|describe|read/i.test(lower)) {
        this.addObjective("Observe page content and structure", { type: "OBSERVE" });
        this.addObjective("Extract and synthesize relevant information", { type: "SYNTHESIZE" });
      } else {
        // Universal default single/dual milestone
        this.addObjective("Observe interface and navigate to target", { type: "NAVIGATE" });
        this.addObjective("Execute intended task: " + goalText.slice(0, 60), { type: "EXECUTE" });
      }

      if (this.objectives.length > 0) {
        this.objectives[0].status = STATUS.IN_PROGRESS;
      }
    }

    addObjective(description, meta = {}) {
      const obj = {
        id: "obj-" + (this.objectives.length + 1),
        description,
        status: STATUS.PENDING,
        type: meta.type || "GENERAL",
        evidence: [],
        startedAt: null,
        completedAt: null,
        notes: "",
      };
      this.objectives.push(obj);
      return obj;
    }

    getCurrentObjective() {
      if (this.currentObjectiveIndex >= this.objectives.length) {
        return null;
      }
      return this.objectives[this.currentObjectiveIndex];
    }

    getCompletedObjectives() {
      return this.objectives.filter((o) => o.status === STATUS.COMPLETED);
    }

    getPendingObjectives() {
      return this.objectives.filter((o) => o.status === STATUS.PENDING);
    }

    /**
     * Record an observed fact from actual live browser state.
     * Facts are immutable truths grounded in evidence.
     */
    addObservedFact(key, value, source = "dom", confidence = 1.0) {
      this.observedFacts.set(key, {
        value,
        source,
        confidence,
        timestamp: Date.now(),
      });
      this.updatedAt = Date.now();
    }

    /**
     * Record an assumption made by reasoning.
     */
    addAssumption(key, statement) {
      this.assumptions.set(key, {
        statement,
        invalidated: false,
        timestamp: Date.now(),
      });
    }

    /**
     * Invalidate assumptions when page changes (e.g., navigation, mutation)
     */
    invalidateAssumptions(reason = "state_changed") {
      let count = 0;
      for (const [k, v] of this.assumptions.entries()) {
        if (!v.invalidated) {
          v.invalidated = true;
          v.invalidatedReason = reason;
          count++;
        }
      }
      return count;
    }

    /**
     * Mark an objective completed with verified observable evidence.
     * Never converts inferences to completed status without evidence.
     */
    completeCurrentObjective(evidenceDescription) {
      const curr = this.getCurrentObjective();
      if (!curr) return false;

      curr.status = STATUS.COMPLETED;
      curr.completedAt = Date.now();
      curr.evidence.push({
        description: evidenceDescription || "Verified through observable state change",
        timestamp: Date.now(),
      });

      this.evidenceLog.push({
        objectiveId: curr.id,
        evidence: evidenceDescription,
        timestamp: Date.now(),
      });

      this.consecutiveNoProgressCount = 0;
      this.isStalled = false;
      this.currentObjectiveIndex++;

      if (this.currentObjectiveIndex < this.objectives.length) {
        this.objectives[this.currentObjectiveIndex].status = STATUS.IN_PROGRESS;
        this.objectives[this.currentObjectiveIndex].startedAt = Date.now();
      } else {
        this.status = "COMPLETED";
      }

      this.updatedAt = Date.now();
      return true;
    }

    /**
     * Register action result and compute progress delta.
     * Detects stalled loops when multiple actions produce no objective progress.
     */
    registerStepResult(actionResult, verified = false) {
      this.stepCount++;
      const changed = actionResult && (actionResult.changed || actionResult.changedState || actionResult.success);

      if ((verified && changed) || (actionResult && actionResult.success)) {
        this.consecutiveNoProgressCount = 0;
        this.isStalled = false;
      } else {
        this.consecutiveNoProgressCount++;
        if (this.consecutiveNoProgressCount >= this.maxNoProgressLimit) {
          this.isStalled = true;
        }
      }

      // Check timeout
      if (Date.now() - this.createdAt > this.timeoutMs) {
        this.status = "TIMED_OUT";
      } else if (this.stepCount >= this.maxSteps) {
        this.status = "BUDGET_EXHAUSTED";
      }

      return {
        step: this.stepCount,
        progressDelta: verified && changed ? 1 : 0,
        stalled: this.isStalled,
        currentObjective: this.getCurrentObjective(),
      };
    }

    /**
     * Evaluate overall task completion
     */
    isGoalComplete() {
      return this.objectives.length > 0 && this.objectives.every((o) => o.status === STATUS.COMPLETED);
    }

    /**
     * Export non-sensitive summary for remote reasoner or checkpoint
     */
    toRemoteState() {
      return {
        userGoal: this.userGoal,
        currentObjective: this.getCurrentObjective() ? this.getCurrentObjective().description : null,
        objectiveIndex: this.currentObjectiveIndex,
        totalObjectives: this.objectives.length,
        completedObjectives: this.getCompletedObjectives().map((o) => o.description),
        pendingObjectives: this.getPendingObjectives().map((o) => o.description),
        step: this.stepCount,
        maxSteps: this.maxSteps,
        isStalled: this.isStalled,
      };
    }

    /**
     * Create checkpoint without any raw secrets
     */
    toCheckpoint() {
      return {
        sessionId: this.sessionId,
        taskId: this.taskId,
        userGoal: this.userGoal,
        stepCount: this.stepCount,
        currentObjectiveIndex: this.currentObjectiveIndex,
        objectives: this.objectives.map((o) => ({ ...o })),
        status: this.status,
        timestamp: Date.now(),
      };
    }

    /**
     * Restore from checkpoint
     */
    static fromCheckpoint(ckpt) {
      const gm = new GoalManager(ckpt.userGoal, {
        sessionId: ckpt.sessionId,
        taskId: ckpt.taskId,
      });
      gm.stepCount = ckpt.stepCount || 0;
      gm.currentObjectiveIndex = ckpt.currentObjectiveIndex || 0;
      gm.objectives = ckpt.objectives || [];
      gm.status = ckpt.status || "ACTIVE";
      return gm;
    }
  }

  PBA.GoalManager = GoalManager;
})();
