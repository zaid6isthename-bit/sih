/**
 * task-parser.js — LOCAL-ONLY task parser.
 *
 * Runs entirely in the trusted browser environment. Parses the raw user task
 * into a structured representation, extracts any PII values embedded in the
 * task text, and produces a REMOTE-SAFE task context that contains only
 * semantic intent — never raw PII values.
 *
 * The raw task string NEVER crosses the network boundary.
 * Only the RemoteTaskContext produced by remoteSafeContext() may be sent.
 */
(function () {
  "use strict";

  const PBA = (globalThis.PBA = globalThis.PBA || {});

  // ---- Intent patterns ---------------------------------------------------
  const INTENTS = [
    {
      id: "FORM_FILL",
      re: /\b(fill|complete|enter|input|provide|update|write|type)\b.*\b(field|form|detail|info|profile|data)\b/i,
      score: 3,
    },
    {
      id: "SUBMIT",
      re: /\b(submit|send|apply|confirm|proceed|finalize)\b/i,
      score: 2,
    },
    {
      id: "QUERY",
      re: /\b(summar\w*|totals?|sum|average|how much|how many|count|breakdown|group|list|show|find|search|what|get)\b/i,
      score: 2,
    },
    {
      id: "NAVIGATE",
      re: /\b(go to|open|navigate|visit|load|switch to)\b/i,
      score: 2,
    },
    {
      id: "CLICK",
      re: /\b(click|press|tap|hit|select|choose|pick)\b/i,
      score: 2,
    },
    {
      id: "PURCHASE",
      re: /\b(buy|purchase|order|book|checkout|pay|cart)\b/i,
      score: 3,
    },
    {
      id: "SCROLL",
      re: /\b(scroll|swipe|drag)\b/i,
      score: 1,
    },
  ];

  // ---- PII value extraction patterns (detects values EMBEDDED in task text) ---
  const PII_PATTERNS = [
    {
      type: "PHONE",
      re: /(\+?91[\s\-]?)?(\b[6-9]\d{9}\b)/g,
      confidence: 0.9,
    },
    {
      type: "EMAIL",
      re: /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g,
      confidence: 0.95,
    },
    {
      type: "AADHAAR",
      re: /\b([2-9]\d{3}[\s\-]?\d{4}[\s\-]?\d{4})\b/g,
      confidence: 0.9,
    },
    {
      type: "PAN",
      re: /\b([A-Z]{5}[0-9]{4}[A-Z])\b/g,
      confidence: 0.85,
    },
    {
      type: "CREDIT_CARD",
      re: /\b(\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4})\b/g,
      confidence: 0.8,
    },
    {
      type: "UPI",
      re: /\b([a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,16})\b/g,
      confidence: 0.8,
    },
    {
      type: "PASSWORD",
      re: /\b(password|passwd|pwd)\s*[:=]\s*(\S+)/gi,
      confidence: 0.95,
    },
    {
      type: "ADDRESS",
      re: /\b(\d{1,5}\s+[A-Za-z\s,]+(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|colony|nagar|sector|phase|block|flat|apt|house|hsno|no)[\s,]*[A-Za-z\s]*\d{5,6})\b/gi,
      confidence: 0.7,
    },
    {
      type: "PERSON",
      re: /\b(my name is|i am|this is|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g,
      confidence: 0.8,
    },
  ];

  // ---- Field type detection (what the task NEEDS, not what value it has) ----
  const FIELD_HINTS = [
    { type: "EMAIL", re: /\bemail\b/i },
    { type: "PHONE", re: /\bphone\b|\bmobile\b|\bnumber\b/i },
    { type: "NAME", re: /\bname\b/i },
    { type: "PASSWORD", re: /\bpassword\b|\bpasswd\b/i },
    { type: "ADDRESS", re: /\baddress\b|\blocation\b|\bdeliver(?:y)?\s+to\b/i },
    { type: "AADHAAR", re: /\baadhaar\b|\baadhar\b|\buid\b/i },
    { type: "PAN", re: /\bpan\b/i },
    { type: "CARD", re: /\bcard\b|\bcredit\b|\bdebit\b/i },
    { type: "UPI", re: /\bupi\b/i },
    { type: "DOB", re: /\bdate of birth\b|\bdob\b|\bbirthday\b/i },
    { type: "SUBMIT", re: /\bsubmit\b/i },
    { type: "CLICK", re: /\bclick\b/i },
  ];

  /**
   * Parse a raw user task into a structured task representation.
   * Everything stays LOCAL — nothing crosses the network.
   *
   * @param {string} rawTask — the exact text the user typed
   * @returns {object} parsed task with intent, embedded PII, required fields
   */
  function parseTask(rawTask) {
    if (!rawTask || typeof rawTask !== "string") {
      return {
        raw: "",
        intent: "UNKNOWN",
        intentScore: 0,
        embeddedPII: [],
        requiredFields: [],
        semanticSummary: "",
      };
    }

    const text = rawTask.trim();

    // 1. Detect intent
    let bestIntent = "UNKNOWN";
    let bestScore = 0;
    for (const def of INTENTS) {
      const m = text.match(def.re);
      if (m && def.score > bestScore) {
        bestIntent = def.id;
        bestScore = def.score;
      }
    }

    // 2. Extract PII values embedded in the task text
    const embeddedPII = [];
    for (const pat of PII_PATTERNS) {
      const seen = new Set();
      let m;
      const re = new RegExp(pat.re.source, pat.re.flags);
      while ((m = re.exec(text)) !== null) {
        const value = m[1] || m[0];
        const key = pat.type + ":" + value;
        if (!seen.has(key)) {
          seen.add(key);
          embeddedPII.push({
            type: pat.type,
            value: value,
            index: m.index,
            length: m[0].length,
            confidence: pat.confidence,
          });
        }
      }
    }

    // 3. Detect required fields (what the task NEEDS)
    const requiredFields = [];
    const seenTypes = new Set();
    for (const hint of FIELD_HINTS) {
      if (hint.re.test(text) && !seenTypes.has(hint.type)) {
        seenTypes.add(hint.type);
        // Determine source: if PII of this type was embedded, it's LOCAL_PROFILE
        const hasEmbedded = embeddedPII.some(
          (p) => p.type === hint.type || (hint.type === "NAME" && p.type === "PERSON")
        );
        requiredFields.push({
          type: hint.type,
          source: hasEmbedded ? "LOCAL_PROFILE" : "LOCAL_PROFILE",
          exposure: "LOCAL_ONLY",
        });
      }
    }

    // 4. Build semantic summary (no raw values)
    const fieldList = requiredFields.map((f) => f.type).join(", ");
    const semanticSummary = fieldList
      ? `Intent: ${bestIntent}. Required fields: ${fieldList}.`
      : `Intent: ${bestIntent}.`;

    return {
      raw: text,
      intent: bestIntent,
      intentScore: bestScore,
      embeddedPII,
      requiredFields,
      semanticSummary,
    };
  }

  /**
   * Produce a REMOTE-SAFE task context from a parsed task.
   * The raw task text is NEVER included.
   * PII values are replaced with semantic tokens.
   *
   * @param {object} parsed — output of parseTask()
   * @returns {object} remoteSafeContext — safe to send over network
   */
  function remoteSafeContext(parsed) {
    const localOnlyFields = [];
    const remoteAllowedFields = [];

    for (const field of parsed.requiredFields) {
      if (field.exposure === "LOCAL_ONLY") {
        localOnlyFields.push(field.type);
        remoteAllowedFields.push({
          type: field.type,
          token: `<${field.type}_01>`,
          exposure: "LOCAL_ONLY",
          action: "LOCAL_SECRET_ACTION",
        });
      } else {
        remoteAllowedFields.push({
          type: field.type,
          exposure: "REMOTE_ALLOWED",
        });
      }
    }

    // Build a safe text summary: strip all PII values from the task
    let safeText = parsed.raw;
    // Remove PII values by replacing them with tokens (back-to-front to preserve indices)
    const sorted = [...parsed.embeddedPII].sort((a, b) => b.index - a.index);
    for (const pii of sorted) {
      safeText =
        safeText.slice(0, pii.index) +
        `<${pii.type}_01>` +
        safeText.slice(pii.index + pii.length);
    }
    // Also remove name patterns like "My name is X Y Z"
    safeText = safeText.replace(
      /\b(my name is|i am|i'm|this is)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/gi,
      "$1 <PERSON_01>"
    );

    return {
      intent: parsed.intent,
      safeText: safeText,
      requiredFields: remoteAllowedFields,
      localOnlyFields: localOnlyFields,
      embeddedPIICount: parsed.embeddedPII.length,
      embeddedPIITypes: [...new Set(parsed.embeddedPII.map((p) => p.type))],
    };
  }

  // Expose on PBA namespace
  PBA.taskParser = {
    parseTask,
    remoteSafeContext,
    INTENTS,
    PII_PATTERNS,
    FIELD_HINTS,
  };
})();
