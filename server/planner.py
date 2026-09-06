"""
planner.py — Turns a sanitized context into a next-step ActionPlan.

Backends, selected by env var PBA_BACKEND:
  - "mock" (default): a deterministic heuristic planner. Requires no GPU/model,
    so the whole end-to-end loop runs on any laptop for demos and CI.
  - "vlm": the ROUTED chain of OpenAI-compatible endpoints (router.py) —
    e.g. OpenRouter UI-TARS-1.5-7B first, local vLLM second — with automatic
    failover, and the mock planner as final safety net.
  - "auto": alias of "vlm" (kept explicit in docs/ops tooling).

Whatever any backend proposes is passed through security.sanitize_plan() by the
caller, so planners are allowed to be optimistic.
"""
from __future__ import annotations
import os, re
from schemas import SanitizedContext, ActionPlan, Action

BACKEND = os.environ.get("PBA_BACKEND", "mock").lower()
if BACKEND == "auto":
    BACKEND = "vlm"

# task-intent -> vault key used by fill_local (value resolved on the CLIENT)
_PII_TO_SOURCE = {
    "email": "email", "phone": "phone", "person": "full_name",
    "dob": "dob", "address": "address",
    "aadhaar": "aadhaar", "pan": "pan",
    "bank_account": "bank_account", "credit_card": "bank_account",
    "upi": "upi",
}

def _vault_key_for(element):
    """Pick the right vault key for a person field based on its label."""
    if element.pii_type != "person":
        return _PII_TO_SOURCE.get(element.pii_type)
    label = (element.label or "").lower()
    if "first" in label:
        return "first_name"
    if "last" in label or "family" in label or "surname" in label:
        return "last_name"
    return _PII_TO_SOURCE.get(element.pii_type)

_PRIMARY_BTN_WORDS = ["submit", "continue", "next", "proceed", "login", "sign in",
                      "search", "send", "save", "apply", "confirm", "ok"]


def _find_unexecuted_button(elements, keywords, executed):
    """Return the first enabled button whose label contains any keyword
    and whose click signature has not already been executed."""
    for e in elements:
        if e.role == "button" and e.enabled:
            lab = (e.label or "").lower()
            if any(w in lab for w in keywords) and f"click|{e.id}" not in executed:
                return e
    return None


# ---- Task-aware intent parsing (LOCAL ONLY, runs on server for mock mode) ----
_TASK_FIELD_MAP = {
    "email":   {"email"},
    "e-mail":  {"email"},
    "phone":   {"phone"},
    "mobile":  {"phone"},
    "name":    {"person"},
    "address": {"address"},
    "dob":     {"dob"},
    "date of birth": {"dob"},
    "aadhaar": {"aadhaar"},
    "aadhar":  {"aadhaar"},
    "pan":     {"pan"},
    "bank":    {"bank_account"},
    "account": {"bank_account"},
    "upi":     {"upi"},
    "card":    {"credit_card"},
    "credit":  {"credit_card"},
    "debit":   {"credit_card"},
    "password":{"password"},
}

_TASK_ACTION_MAP = {
    "submit":  "submit",
    "apply":   "submit",
    "confirm": "submit",
    "send":    "submit",
    "pay":     "pay",
    "purchase":"pay",
    "buy":     "pay",
    "click":   "click",
    "scroll":  "scroll",
    "search":  "search",
    "find":    "search",
    "lookup":  "search",
}


def _parse_task_intent(task_text: str) -> dict:
    """Parse the raw task to determine what the user ACTUALLY wants done."""
    t = (task_text or "").lower()
    required_fields = set()
    required_actions = []
    is_query = False

    for keyword, fields in _TASK_FIELD_MAP.items():
        if keyword in t:
            required_fields.update(fields)

    for keyword, action in _TASK_ACTION_MAP.items():
        if keyword in t:
            if action not in required_actions:
                required_actions.append(action)

    query_re = re.compile(r'\b(summar\w*|totals?|how much|how many|count|breakdown|list|show|find|search|what|get)\b')
    if query_re.search(t):
        is_query = True

    return {
        "required_fields": required_fields,
        "required_actions": required_actions,
        "is_query": is_query,
    }


# ---- Intent-specific planners ------------------------------------------------

def _plan_pay_fee(ctx: SanitizedContext) -> ActionPlan:
    """Plan for PAY_FEE intent: scroll to fee section, click pay button.

    Two-step flow:
    1. If payment controls are not visible, scroll to them
    2. Click the pay button (requires_confirmation is set by security.py)
    """
    executed = set(ctx.executed_actions or [])

    # Primary: pay/fee/transfer labeled button; fallback: any destructive button
    btn = _find_unexecuted_button(
        ctx.elements, ("pay", "payment", "fee", "transfer", "proceed to pay"), executed
    ) or next(
        (e for e in ctx.elements if e.role == "button" and e.destructive and e.enabled
         and f"click|{e.id}" not in executed), None
    )

    if btn:
        bbox = btn.bbox or [0, 0, 0, 0]
        viewport_h = ctx.viewport.h if ctx.viewport else 800
        is_visible = 0 <= bbox[1] <= viewport_h and bbox[1] + bbox[3] <= viewport_h + 200
        actions = ([] if is_visible else [Action(type="scroll_to", target_id=btn.id)]) + [
            Action(type="click", target_id=btn.id)
        ]
        return ActionPlan(
            session_id=ctx.session_id, step=ctx.step,
            reasoning=f"Pay fee: identified '{btn.label[:50]}' button. "
                      f"Amount shown on page. Requires user confirmation before execution.",
            actions=actions, status="continue", confidence=0.9, reasoningMode="FALLBACK",
        )

    # Step 2: payment confirmation modal/dialog
    confirm_btn = _find_unexecuted_button(
        ctx.elements, ("confirm payment", "confirm", "proceed", "yes"), executed
    )
    if confirm_btn:
        return ActionPlan(
            session_id=ctx.session_id, step=ctx.step,
            reasoning=f"Payment confirmation dialog detected. Click '{confirm_btn.label[:50]}' to finalize payment.",
            actions=[Action(type="click", target_id=confirm_btn.id)],
            status="continue", confidence=0.85, reasoningMode="FALLBACK",
        )

    return ActionPlan(
        session_id=ctx.session_id, step=ctx.step,
        reasoning="Payment flow completed or no payment controls found.",
        actions=[], status="done", confidence=0.7, reasoningMode="FALLBACK",
    )


def _plan_submit_form(ctx: SanitizedContext) -> ActionPlan:
    """Plan for SUBMIT_FORM intent: find and click the submit button."""
    executed = set(ctx.executed_actions or [])
    btn = _find_unexecuted_button(
        ctx.elements, ("submit", "apply", "send", "finalize", "confirm"), executed
    )
    if btn:
        return ActionPlan(
            session_id=ctx.session_id, step=ctx.step,
            reasoning=f"Found submit button '{btn.label[:50]}'. Executing click to submit the application.",
            actions=[Action(type="click", target_id=btn.id)],
            status="continue", confidence=0.9, reasoningMode="FALLBACK",
        )
    return ActionPlan(
        session_id=ctx.session_id, step=ctx.step,
        reasoning="Could not identify a submit button on the page.",
        actions=[], status="need_user", confidence=0.3, reasoningMode="FALLBACK",
    )


def _plan_form_fill(ctx: SanitizedContext) -> ActionPlan:
    """Plan for FORM_FILL intent: fill only explicitly requested fields, or all if general fill."""
    intent = _parse_task_intent(ctx.task)
    required = intent["required_fields"]
    executed = set(ctx.executed_actions or [])
    available_keys = set(ctx.profile_keys or [])
    allow_all = not required and "fill" in (ctx.task or "").lower()

    # Fill required fields that are still empty and not yet executed
    for e in ctx.elements:
        vault_key = _vault_key_for(e)
        sig = f"fill_local|{e.id}|{vault_key}"
        if (e.sensitive and e.value_state == "empty" and vault_key
                and (allow_all or e.pii_type in required) and sig not in executed
                and (not available_keys or vault_key in available_keys)):
            return ActionPlan(
                session_id=ctx.session_id, step=ctx.step,
                reasoning=f"Fill the {e.pii_type} field from local vault.",
                actions=[Action(type="fill_local", target_id=e.id, source=vault_key)],
                status="continue", confidence=0.8,
                reasoningMode="FALLBACK",
            )

    # All required fields filled
    filled_types = [e.pii_type for e in ctx.elements
                    if e.sensitive and e.value_state == "filled" and (allow_all or e.pii_type in required)]
    return ActionPlan(
        session_id=ctx.session_id, step=ctx.step,
        reasoning=f"All requested fields filled: {', '.join(filled_types) or 'none'}.",
        actions=[], status="done", confidence=0.8,
        reasoningMode="FALLBACK",
    )


def _plan_action_with_submit(ctx: SanitizedContext) -> ActionPlan:
    """Plan for tasks that combine fill + submit/pay actions."""
    intent = _parse_task_intent(ctx.task)
    required = intent["required_fields"]
    actions_wanted = intent["required_actions"]
    executed = set(ctx.executed_actions or [])
    available_keys = set(ctx.profile_keys or [])
    allow_all = not required and "fill" in (ctx.task or "").lower()

    # Step 1: Fill required fields
    for e in ctx.elements:
        vault_key = _vault_key_for(e)
        sig = f"fill_local|{e.id}|{vault_key}"
        if (e.sensitive and e.value_state == "empty" and vault_key
                and (allow_all or e.pii_type in required) and sig not in executed
                and (not available_keys or vault_key in available_keys)):
            return ActionPlan(
                session_id=ctx.session_id, step=ctx.step,
                reasoning=f"Fill the {e.pii_type} field from local vault.",
                actions=[Action(type="fill_local", target_id=e.id, source=vault_key)],
                status="continue", confidence=0.8,
                reasoningMode="FALLBACK",
            )

    # Step 2: Execute requested actions (submit/pay)
    if "submit" in actions_wanted or "pay" in actions_wanted:
        target_label = "submit" if "submit" in actions_wanted else "pay"
        buttons = [e for e in ctx.elements if e.role == "button" and e.enabled]
        best = None
        for b in buttons:
            lab = (b.label or "").lower()
            if target_label in lab:
                best = b
                break
        if not best:
            for b in buttons:
                lab = (b.label or "").lower()
                if any(w in lab for w in _PRIMARY_BTN_WORDS):
                    best = b
                    break
        if best:
            sig = f"click|{best.id}"
            if sig not in executed:
                return ActionPlan(
                    session_id=ctx.session_id, step=ctx.step,
                    reasoning=f"Click '{best.label[:40]}' to complete the user-requested action.",
                    actions=[Action(type="click", target_id=best.id)],
                    status="continue", confidence=0.7,
                    reasoningMode="FALLBACK",
                )

    # All done
    filled_types = [e.pii_type for e in ctx.elements
                    if e.sensitive and e.value_state == "filled" and e.pii_type in required]
    return ActionPlan(
        session_id=ctx.session_id, step=ctx.step,
        reasoning=f"All requested operations complete. Filled: {', '.join(filled_types) or 'none'}.",
        actions=[], status="done", confidence=0.8,
        reasoningMode="FALLBACK",
    )


def _mock_plan(ctx: SanitizedContext) -> ActionPlan:
    """Intent-aware mock planner. Uses the structured task_intent from the client
    when available, falls back to keyword parsing."""
    
    # Use structured intent from client-side parser if available
    task_intent = ctx.task_intent
    
    if task_intent == "PAY_FEE":
        return _plan_pay_fee(ctx)
    elif task_intent == "SUBMIT_FORM":
        return _plan_submit_form(ctx)
    elif task_intent == "PAGE_SUMMARY":
        # Page summary is handled in query mode, but if it arrives here,
        # just acknowledge and return done
        return ActionPlan(
            session_id=ctx.session_id, step=ctx.step,
            reasoning="Page summary is handled in query mode. No actions needed.",
            actions=[], status="done", confidence=0.9,
            reasoningMode="FALLBACK",
        )
    
    # Fall back to keyword-based intent parsing
    intent = _parse_task_intent(ctx.task)
    required = intent["required_fields"]
    actions_wanted = intent["required_actions"]
    
    if actions_wanted:
        return _plan_action_with_submit(ctx)
    elif required:
        return _plan_form_fill(ctx)
    
    # Generic: check for submit/pay keywords in raw task text
    task_lower = (ctx.task or "").lower()
    if any(w in task_lower for w in ("submit", "pay", "click")):
        return _plan_action_with_submit(ctx)
    
    # Nothing recognizable
    return ActionPlan(
        session_id=ctx.session_id, step=ctx.step,
        reasoning="No actionable intent detected. Please specify what you'd like me to do.",
        actions=[], status="need_user", confidence=0.3,
        reasoningMode="FALLBACK",
    )


def plan(ctx: SanitizedContext) -> ActionPlan:
    if BACKEND in ("vlm", "remote", "llm"):
        from router import plan_with_fallback  # lazy so mock mode needs no deps
        try:
            p, used = plan_with_fallback(ctx)
            p.reasoning = f"[{used}] {p.reasoning}".strip()
            p.reasoningMode = "REMOTE_LLM"
            return p
        except Exception as e:
            # Final Amendments 3 & 57: NO FALLBACK TO MOCK IN PRODUCTION RUNTIME.
            # Return true failure state; do not fabricate actions or pretend success.
            err_str = str(e)
            failure_type = "MODEL_ERROR"
            if "timeout" in err_str.lower():
                failure_type = "MODEL_TIMEOUT"
            elif "rate" in err_str.lower() or "429" in err_str:
                failure_type = "RATE_LIMITED"
            elif "connect" in err_str.lower() or "network" in err_str.lower():
                failure_type = "NETWORK_ERROR"
            elif "schema" in err_str.lower() or "validation" in err_str.lower():
                failure_type = "INVALID_SCHEMA"
            
            return ActionPlan(
                session_id=ctx.session_id,
                step=ctx.step,
                reasoning=f"Remote model failure ({failure_type}): {err_str}. Halting without mock fabrication.",
                actions=[],
                status="need_user",
                confidence=0.0,
                reasoningMode=failure_type,
            )
    return _mock_plan(ctx)
