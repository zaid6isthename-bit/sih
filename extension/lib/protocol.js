/*
 * protocol.js — Shared client/server contract (v1).
 *
 * This file defines the ONLY vocabulary that crosses the network. Keeping it in
 * one place (mirrored by server/schemas.py) is what makes the system auditable:
 * if a value type isn't declared here, it must never be transmitted.
 *
 * Loaded first in the content_scripts list, so it establishes the global
 * namespace `self.PBA` that every other module hangs off of.
 */
(function () {
  const root = typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this);
  const PBA = (root.PBA = root.PBA || {});

  PBA.PROTOCOL_VERSION = "1.0";

  // Categories of sensitive data the privacy layer knows how to detect + redact.
  // The server receives ONLY the category + a stable placeholder token, never the value.
  PBA.PII = Object.freeze({
    PASSWORD: "password",
    OTP: "otp",
    API_KEY: "api_key",
    CREDIT_CARD: "credit_card",
    BANK_ACCOUNT: "bank_account",
    AADHAAR: "aadhaar",
    PAN: "pan",
    UPI: "upi",
    EMAIL: "email",
    PHONE: "phone",
    PERSON: "person",
    ADDRESS: "address",
    DOB: "dob",
    FACE: "face",
    SIGNATURE: "signature",
    ID_DOCUMENT: "id_document", // whole-region redaction (Aadhaar/PAN/passport photos & scans)
    IP: "ip",
    GENERIC_SECRET: "generic_secret",
  });

  // Redaction methods, ordered by strength. Reversible methods (blur/pixelate)
  // are NEVER used for high-sensitivity categories (see policy.js).
  PBA.REDACT = Object.freeze({
    REMOVE: "remove", // element/value dropped entirely from payload
    BLACKOUT: "blackout", // opaque solid fill on pixels (irreversible)
    TOKENIZE: "tokenize", // text replaced with <CATEGORY_n> placeholder
    PIXELATE: "pixelate", // reversible-ish; low sensitivity only
    BLUR: "blur", // reversible-ish; low sensitivity only (e.g. background faces)
    PRESERVE: "preserve", // safe UI element, kept as-is
  });

  // The closed set of actions the server may request. The client validates every
  // incoming action against this list and executes NOTHING else. No eval, ever.
  PBA.ACTIONS = Object.freeze({
    // Navigation
    NAVIGATE: "navigate", // guarded: same-origin or user-approved only
    BACK: "back",
    FORWARD: "forward",
    RELOAD: "reload",

    // Tabs
    NEW_TAB: "new_tab",
    CLOSE_TAB: "close_tab",
    SWITCH_TAB: "switch_tab",

    // Mouse & Pointer
    CLICK: "click",
    DOUBLE_CLICK: "double_click",
    RIGHT_CLICK: "right_click",
    HOVER: "hover",
    FOCUS: "focus",

    // Keyboard & Text
    TYPE: "type", // literal, non-sensitive text (e.g. a search query)
    CLEAR: "clear",
    PRESS_KEY: "press_key",
    KEY_COMBINATION: "key_combination",

    // Scrolling
    SCROLL: "scroll",
    SCROLL_UP: "scroll_up",
    SCROLL_DOWN: "scroll_down",
    SCROLL_TO: "scroll_to",
    SCROLL_TO_ELEMENT: "scroll_to_element",
    SCROLL_CONTAINER: "scroll_container",

    // Form Controls
    SELECT: "select",
    SELECT_OPTION: "select_option",
    CHECK: "check",
    UNCHECK: "uncheck",
    TOGGLE: "toggle",
    SUBMIT_FORM: "submit_form",

    // Drag & Drop
    DRAG: "drag",
    DROP: "drop",

    // Files & Clipboard
    UPLOAD_FILE: "upload_file",
    DOWNLOAD: "download",
    COPY: "copy",
    PASTE: "paste",

    // Timing & Synchronization
    WAIT: "wait",
    WAIT_FOR_ELEMENT: "wait_for_element",
    WAIT_FOR_NAVIGATION: "wait_for_navigation",
    WAIT_FOR_IDLE: "wait_for_idle",

    // Menus & Dialogs
    OPEN_MENU: "open_menu",
    CLOSE_MENU: "close_menu",
    HANDLE_DIALOG: "handle_dialog",

    // Local Vault & Profile (sensitive values stay in local browser storage)
    FILL_LOCAL: "fill_local", // legacy alias
    LOCAL_PROFILE_ACTION: "local_profile_action",
    LOCAL_SECRET_ACTION: "local_secret_action",

    // Control & Negative Actions
    NO_ACTION_REQUIRED: "no_action_required",
    DONE: "done",
    NEED_USER: "need_user",
    ABORT: "abort",
  });

  // Action Risk Classification (DO GATE & confirmation)
  PBA.RISK_LEVEL = Object.freeze({
    LOW: "LOW",         // read, scroll, open safe page
    MEDIUM: "MEDIUM",   // filter, fill ordinary non-sensitive field, download document
    HIGH: "HIGH",       // send message, submit application, publish content
    CRITICAL: "CRITICAL" // payment, purchase, delete account/data, credentials, sensitive permissions
  });

  // Action Reversibility
  PBA.REVERSIBILITY = Object.freeze({
    REVERSIBLE: "REVERSIBLE",
    PARTIALLY_REVERSIBLE: "PARTIALLY_REVERSIBLE",
    IRREVERSIBLE: "IRREVERSIBLE",
  });

  // Action Lifecycle
  PBA.ACTION_LIFECYCLE = Object.freeze({
    PROPOSED: "PROPOSED",
    VALIDATED: "VALIDATED",
    AUTHORIZED: "AUTHORIZED",
    EXECUTING: "EXECUTING",
    EXECUTED: "EXECUTED",
    VERIFIED: "VERIFIED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
  });

  // Expected Effects for Post-Condition Verification
  PBA.EXPECTED_EFFECT = Object.freeze({
    URL_CHANGED: "URL_CHANGED",
    ELEMENT_APPEARED: "ELEMENT_APPEARED",
    ELEMENT_DISAPPEARED: "ELEMENT_DISAPPEARED",
    VALUE_CHANGED: "VALUE_CHANGED",
    CHECKBOX_CHANGED: "CHECKBOX_CHANGED",
    SELECTION_CHANGED: "SELECTION_CHANGED",
    MODAL_OPENED: "MODAL_OPENED",
    MODAL_CLOSED: "MODAL_CLOSED",
    FORM_SUBMITTED: "FORM_SUBMITTED",
    PAGE_STATE_CHANGED: "PAGE_STATE_CHANGED",
    DOWNLOAD_STARTED: "DOWNLOAD_STARTED",
    DOWNLOAD_COMPLETED: "DOWNLOAD_COMPLETED",
    TASK_OBJECTIVE_PROGRESS: "TASK_OBJECTIVE_PROGRESS",
    STATE_CHANGE: "STATE_CHANGE",
  });

  // Failure Types for Systematic Classification and Recovery
  PBA.FAILURE_TYPE = Object.freeze({
    TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
    TARGET_STALE: "TARGET_STALE",
    TARGET_CHANGED: "TARGET_CHANGED",
    TARGET_DISABLED: "TARGET_DISABLED",
    PAGE_NAVIGATED: "PAGE_NAVIGATED",
    POPUP_BLOCKING: "POPUP_BLOCKING",
    MODAL_BLOCKING: "MODAL_BLOCKING",
    LOGIN_REQUIRED: "LOGIN_REQUIRED",
    CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
    PERMISSION_REQUIRED: "PERMISSION_REQUIRED",
    NETWORK_ERROR: "NETWORK_ERROR",
    TIMEOUT: "TIMEOUT",
    VALIDATION_ERROR: "VALIDATION_ERROR",
    UNEXPECTED_PAGE: "UNEXPECTED_PAGE",
    ACTION_REJECTED: "ACTION_REJECTED",
    POSTCONDITION_FAILED: "POSTCONDITION_FAILED",
    STALLED: "STALLED",
    UNKNOWN: "UNKNOWN",
  });

  // Page Readiness States
  PBA.PAGE_READINESS = Object.freeze({
    NAVIGATING: "NAVIGATING",
    LOADING: "LOADING",
    DOM_READY: "DOM_READY",
    VISUALLY_STABLE: "VISUALLY_STABLE",
    INTERACTIVE: "INTERACTIVE",
    IDLE: "IDLE",
    BLOCKED: "BLOCKED",
  });

  // Objective Status
  PBA.OBJECTIVE_STATUS = Object.freeze({
    PENDING: "PENDING",
    IN_PROGRESS: "IN_PROGRESS",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    BLOCKED: "BLOCKED",
    NEEDS_USER: "NEEDS_USER",
  });

  // Perception Escalation Levels
  PBA.PERCEPTION_LEVEL = Object.freeze({
    LEVEL_1_DOM_A11Y: "LEVEL_1_DOM_A11Y",
    LEVEL_2_OCR: "LEVEL_2_OCR",
    LEVEL_3_LOCAL_VISION: "LEVEL_3_LOCAL_VISION",
    LEVEL_4_VISUAL_DOMINANT: "LEVEL_4_VISUAL_DOMINANT",
  });

  // Privacy Exposure Policy
  PBA.PRIVACY_EXPOSURE = Object.freeze({
    ALLOW_RAW: "ALLOW_RAW",
    ALLOW_SEMANTIC: "ALLOW_SEMANTIC",
    TOKENIZE: "TOKENIZE",
    GENERALIZE: "GENERALIZE",
    LOCAL_ONLY: "LOCAL_ONLY",
    NEVER_EXPOSE: "NEVER_EXPOSE",
    REQUIRE_CONFIRMATION: "REQUIRE_CONFIRMATION",
  });

  // Target Specifiers
  PBA.TARGET_SPECIFIER = Object.freeze({
    BY_TARGET_ID: "BY_TARGET_ID",
    BY_TEXT: "BY_TEXT",
    BY_ROLE: "BY_ROLE",
    BY_LABEL: "BY_LABEL",
    BY_ACCESSIBLE_NAME: "BY_ACCESSIBLE_NAME",
    BY_FORM_FIELD: "BY_FORM_FIELD",
    BY_COORDINATE: "BY_COORDINATE",
    BY_SPATIAL_RELATION: "BY_SPATIAL_RELATION",
    BY_VISUAL_REGION: "BY_VISUAL_REGION",
  });

  // Actions/labels that mutate money, data, or identity require an explicit human
  // click-through regardless of what the server says. The client owns this list.
  PBA.DESTRUCTIVE_HINTS = [
    "transfer", "send money", "pay", "payment", "delete", "remove account",
    "withdraw", "confirm order", "place order", "buy now", "unsubscribe",
    "close account", "deactivate", "wire", "authorize", "sign", "submit payment",
    "checkout", "purchase", "order", "terminate", "wipe", "reset password",
  ];

  PBA.STATUS = Object.freeze({
    CONTINUE: "continue",
    DONE: "done",
    NEED_USER: "need_user",
    ABORT: "abort",
  });

  // Task intent types (from client-side task parser)
  PBA.INTENTS = Object.freeze({
    PAY_FEE: "PAY_FEE",
    PAGE_SUMMARY: "PAGE_SUMMARY",
    SUBMIT_FORM: "SUBMIT_FORM",
    FORM_FILL: "FORM_FILL",
    SUBMIT: "SUBMIT",
    QUERY: "QUERY",
    NAVIGATE: "NAVIGATE",
    CLICK: "CLICK",
    PURCHASE: "PURCHASE",
    SCROLL: "SCROLL",
    UNKNOWN: "UNKNOWN",
  });

  // Local action firewall decisions
  PBA.FIREWALL = Object.freeze({
    ALLOW: "ALLOW",
    ALLOW_LOCAL: "ALLOW_LOCAL",
    BLOCK: "BLOCK",
    CONFIRM: "CONFIRM",
    LOCALIZE: "LOCALIZE",
  });

  // Value-state enum: the server learns whether a field is filled, never its content.
  PBA.VALUE_STATE = Object.freeze({
    EMPTY: "empty",
    FILLED: "filled",
    REDACTED: "redacted",
  });

  PBA.newSessionId = function () {
    return "sess-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  };
})();
