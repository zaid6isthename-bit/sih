/**
 * test_chaos_recovery.js — Adversarial Chaos & Recovery Test Suite.
 *
 * Enforces Final Amendment 58: Tests adversarial runtime conditions:
 * - DOM mutation before click
 * - Target removal before execution
 * - Target disabled before click
 * - Popup / Modal appearance before execution
 * - CAPTCHA / 2FA boundary detection
 * - Login / Auth boundary detection
 * - Model timeout & network disconnect
 * - Content script disconnect & recovery
 * - Post-condition verification mismatch
 * - Pathological loop / stall detection
 */
const assert = require("assert");
const path = require("path");

if (typeof self === "undefined") globalThis.self = globalThis;
if (typeof window === "undefined") globalThis.window = globalThis;

const extRoot = path.join(__dirname, "..", "extension");
require(path.join(extRoot, "lib", "protocol.js"));
require(path.join(extRoot, "lib", "world-state.js"));
require(path.join(extRoot, "lib", "element-registry.js"));
require(path.join(extRoot, "lib", "post-condition.js"));
require(path.join(extRoot, "lib", "recovery-engine.js"));
require(path.join(extRoot, "lib", "state-sync.js"));

const PBA = globalThis.PBA;

console.log("============================================================");
console.log("     VISIONGATE — ADVERSARIAL CHAOS & RECOVERY SUITE        ");
console.log("============================================================");

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ✓ [PASS] Chaos Scenario ${total}: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ [FAIL] Chaos Scenario ${total}: ${name}`);
    console.error(`    Error: ${err.message}`);
  }
}

// 1. Target removal before execution (node disconnected)
test("Target Removal Before Execution -> TARGET_STALE recovery", () => {
  const registry = new PBA.LiveElementRegistry();
  const recovery = new PBA.RecoveryEngine();

  // Element registered but disconnected right before execution
  const node = { isConnected: false };
  registry.numericIdMap.set(10, node);

  const targetCheck = registry.resolveAndValidate(10);
  assert.strictEqual(targetCheck.valid, false);
  assert.strictEqual(targetCheck.reason, "TARGET_STALE");

  const failureType = recovery.classifyFailure({ type: "click", target_id: 10 }, { errors: ["node_disconnected"] });
  assert.strictEqual(failureType, "TARGET_STALE");

  const strategy = recovery.formulateStrategy(failureType, { type: "click", target_id: 10 });
  assert.strictEqual(strategy.canRecover, true);
  assert.strictEqual(strategy.strategy, "REFRESH_AND_REGROUND");
});

// 2. DOM Mutation invalidating target (version mismatch)
test("DOM Mutation Prior to Click -> Invalidation detection", () => {
  const syncManager = new PBA.StateSyncManager();
  const v1 = syncManager.invalidationVersion;

  // Simulate DOM mutation event
  syncManager.handleMutation();
  const v2 = syncManager.invalidationVersion;

  assert.ok(v2 > v1, "DOM mutation must increment invalidation version");
  assert.strictEqual(syncManager.isFresh(v1), false, "Older observation version must be marked stale");
});

// 3. Target disabled mid-task
test("Target Becomes Disabled -> TARGET_DISABLED classification", () => {
  const recovery = new PBA.RecoveryEngine();
  const failureType = recovery.classifyFailure(
    { type: "click", target_id: 5 },
    { errors: ["target_disabled"] },
    { status: "FAILURE", reason: "button_disabled" }
  );
  assert.strictEqual(failureType, "TARGET_DISABLED");

  const strategy = recovery.formulateStrategy(failureType, { type: "click", target_id: 5 });
  assert.strictEqual(strategy.strategy, "WAIT_OR_REPLAN");
});

// 4. Modal / Popup blocking execution
test("Unexpected Modal / Overlay Appears -> MODAL_BLOCKING recovery", () => {
  const recovery = new PBA.RecoveryEngine();
  const failureType = recovery.classifyFailure(
    { type: "click", target_id: 7 },
    { errors: ["element_obscured_by_modal"] },
    { status: "FAILURE", reason: "modal_blocking" }
  );
  assert.strictEqual(failureType, "MODAL_BLOCKING");

  const strategy = recovery.formulateStrategy(failureType, { type: "click", target_id: 7 });
  assert.strictEqual(strategy.canRecover, true);
  assert.strictEqual(strategy.strategy, "DISMISS_MODAL");
});

// 5. CAPTCHA Encounter (Boundary, not error to bypass)
test("CAPTCHA Boundary -> USER_INPUT_REQUIRED handoff", () => {
  const recovery = new PBA.RecoveryEngine();
  const failureType = recovery.classifyFailure(
    { type: "click", target_id: 12 },
    { errors: ["recaptcha_challenge_visible"] }
  );
  assert.strictEqual(failureType, "CAPTCHA_REQUIRED");

  const strategy = recovery.formulateStrategy(failureType, { type: "click", target_id: 12 });
  assert.strictEqual(strategy.canRecover, false, "Must not attempt automated bypass on CAPTCHA");
  assert.strictEqual(strategy.strategy, "HANDOFF_CAPTCHA");
  assert.strictEqual(strategy.action.type, "ask_user");
});

// 6. Login / Auth Boundary
test("Authentication Wall -> LOGIN_REQUIRED handoff", () => {
  const recovery = new PBA.RecoveryEngine();
  const failureType = recovery.classifyFailure(
    { type: "navigate", url: "https://example.com/account" },
    { errors: ["sign in required", "auth_required"] }
  );
  assert.strictEqual(failureType, "LOGIN_REQUIRED");

  const strategy = recovery.formulateStrategy(failureType, { type: "navigate" });
  assert.strictEqual(strategy.canRecover, false);
  assert.strictEqual(strategy.strategy, "HANDOFF_AUTHENTICATION");
});

// 7. Network / Model Timeout
test("Network / Model Timeout -> Bounded retry with backoff", () => {
  const recovery = new PBA.RecoveryEngine({ maxRetries: 2 });
  const failureType = recovery.classifyFailure(
    { type: "type", target_id: 3 },
    { errors: ["network_timeout_504"] }
  );
  assert.strictEqual(failureType, "TIMEOUT");

  // Attempt 1
  const s1 = recovery.formulateStrategy(failureType, { type: "type", target_id: 3 });
  assert.strictEqual(s1.canRecover, true);
  assert.strictEqual(s1.strategy, "BACKOFF_AND_RETRY");
  assert.strictEqual(s1.action.type, "wait");

  // Attempt 2
  const s2 = recovery.formulateStrategy(failureType, { type: "type", target_id: 3 });
  assert.strictEqual(s2.canRecover, true);

  // Attempt 3: limit exceeded -> ABORT
  const s3 = recovery.formulateStrategy(failureType, { type: "type", target_id: 3 });
  assert.strictEqual(s3.canRecover, false);
  assert.strictEqual(s3.strategy, "ABORT_RETRY_EXHAUSTED");
  assert.strictEqual(s3.action.type, "need_user");
});

// 8. Verification Mismatch (Executor says ok, but verifier catches failure)
test("Post-Condition Mismatch -> POSTCONDITION_FAILED detection", () => {
  const verifier = new PBA.PostConditionVerifier();
  const recovery = new PBA.RecoveryEngine();

  // Model proposed typing, executor returned success, but state had no change
  const verification = verifier.verify(
    { type: "type", target_id: 4, text: "hello" },
    { page: { url: "https://example.com" } },
    { page: { url: "https://example.com" } },
    { success: true, changedState: false }
  );

  assert.strictEqual(verification.status, "FAILURE");
  assert.strictEqual(verification.reason, "field_value_unmutated");

  const failureType = recovery.classifyFailure(
    { type: "type", target_id: 4 },
    { success: true },
    verification
  );
  assert.strictEqual(failureType, "POSTCONDITION_FAILED");
});

// 9. Anti-Loop & Pathological Stall Detection
test("Oscillation / Anti-Loop Defense -> STALLED classification", () => {
  const recovery = new PBA.RecoveryEngine({ maxRetries: 2 });
  const action = { type: "click", target_id: 8 };

  // formulateStrategy auto-records each call
  const strat1 = recovery.formulateStrategy("POSTCONDITION_FAILED", action);
  assert.strictEqual(strat1.canRecover, true);

  const strat2 = recovery.formulateStrategy("POSTCONDITION_FAILED", action);
  assert.strictEqual(strat2.canRecover, true);

  // Third call should hit retry limit
  const strat3 = recovery.formulateStrategy("POSTCONDITION_FAILED", action);
  assert.strictEqual(strat3.canRecover, false, "Must detect infinite retry loop");
  assert.strictEqual(strat3.strategy, "ABORT_RETRY_EXHAUSTED");
  assert.strictEqual(strat3.action.type, "need_user");
});

// 10. Reconnection Lifecycle -> State invalidation token reset
test("Reconnection Lifecycle -> State invalidation token reset", () => {
  const syncManager = new PBA.StateSyncManager();
  const oldToken = syncManager.getFreshnessToken();

  // Background controller detects content script reconnect
  syncManager.handleNavigation("https://example.com/new_page");
  const newToken = syncManager.getFreshnessToken();

  assert.notStrictEqual(oldToken, newToken, "Navigation or reconnect must generate a new freshness token");
  assert.strictEqual(syncManager.readinessState, "LOADING");
});

console.log("============================================================");
console.log(`  RESULTS: ${passed}/${total} Chaos Scenarios Handled.`);
console.log("============================================================");

if (passed !== total) {
  process.exit(1);
}
