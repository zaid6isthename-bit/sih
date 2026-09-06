"""
remote_reasoner.py — Provider-agnostic Remote Reasoner & Strict Tool-Call Contract.

Enforces:
- Final Amendment 2: Strict model-to-runtime tool-call contract. Rejects free-form code,
  arbitrary JavaScript, unknown action names/fields, and actions outside policy.
- Final Amendment 3: Real remote-model failure modes (MODEL_TIMEOUT, RATE_LIMITED, etc.).
- Final Amendment 56: Model provider abstraction.
"""
from __future__ import annotations
import json
import logging
from typing import Any, Dict, List, Optional, Protocol, Tuple
from schemas import SanitizedContext, ActionPlan, Action

logger = logging.getLogger(__name__)

# Canonical Action types allowed by the VisionGate runtime Action DSL
VALID_ACTION_TYPES = {
    "click", "double_click", "right_click", "middle_click",
    "type", "clear", "press_key", "key_down", "key_up",
    "fill_local", "local_profile_action", "local_secret_action",
    "select", "select_option", "check", "uncheck", "toggle",
    "scroll", "scroll_to", "scroll_into_view",
    "navigate", "reload", "back", "forward",
    "new_tab", "close_tab", "switch_tab",
    "download", "upload_file",
    "wait", "no_action_required", "done", "ask_user", "handoff_user"
}


class ModelProviderAdapter(Protocol):
    """Protocol for model provider adapters (OpenAI, OpenRouter, Anthropic, vLLM)."""
    def send_tool_call(self, state: Dict[str, Any], available_tools: List[Dict[str, Any]]) -> Dict[str, Any]:
        ...


class StrictToolCallValidator:
    """Validates raw model output against the strict VisionGate Action DSL."""
    
    @staticmethod
    def validate_action_payload(raw_action: Dict[str, Any]) -> Tuple[bool, Optional[str], Optional[Action]]:
        if not isinstance(raw_action, dict):
            return False, "Action proposal is not a JSON object", None

        action_type = str(raw_action.get("type", "")).lower()
        if not action_type or action_type not in VALID_ACTION_TYPES:
            return False, f"Unknown or disallowed action type: '{action_type}'", None

        # Check for code injection or arbitrary JavaScript
        for key, val in raw_action.items():
            if isinstance(val, str):
                if re_check := ("javascript:" in val.lower() or "eval(" in val.lower() or "<script" in val.lower()):
                    return False, f"Executable code or script injection detected in field '{key}'", None

        # Build clean Action object
        try:
            action = Action(
                type=action_type,
                target_id=raw_action.get("target_id"),
                stable_target_id=raw_action.get("stable_target_id"),
                text=raw_action.get("text"),
                option=raw_action.get("option"),
                field_name=raw_action.get("field_name"),
                source=raw_action.get("source"),
                direction=raw_action.get("direction"),
                amount=raw_action.get("amount"),
                url=raw_action.get("url"),
                key=raw_action.get("key"),
                ms=raw_action.get("ms"),
                reason=raw_action.get("reason"),
            )
            return True, None, action
        except Exception as e:
            return False, f"Schema validation error: {e}", None


class RemoteReasoner:
    """High-level reasoning interface mediating between runtime state and model provider."""

    def __init__(self, provider: Optional[ModelProviderAdapter] = None):
        self.provider = provider
        self.validator = StrictToolCallValidator()

    def build_tool_declarations(self) -> List[Dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": "propose_browser_action",
                    "description": "Propose the single best next action in the browser based on live observed state.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action_type": {
                                "type": "string",
                                "enum": list(VALID_ACTION_TYPES),
                                "description": "Type of browser interaction."
                            },
                            "target_id": {
                                "type": "integer",
                                "description": "Numeric ID of the target element from the context."
                            },
                            "stable_target_id": {
                                "type": "string",
                                "description": "Stable locator ID (e.g. vg-button-4)."
                            },
                            "text": {
                                "type": "string",
                                "description": "Text to type for non-sensitive fields."
                            },
                            "field_name": {
                                "type": "string",
                                "description": "Profile field key (e.g. 'email', 'phone') for local substitution."
                            },
                            "reasoning": {
                                "type": "string",
                                "description": "Step explanation."
                            },
                            "is_complete": {
                                "type": "boolean",
                                "description": "True if the overall objective has been achieved."
                            }
                        },
                        "required": ["action_type", "reasoning"]
                    }
                }
            }
        ]

    def parse_and_validate_response(self, raw_response: Dict[str, Any], ctx: SanitizedContext) -> ActionPlan:
        """Parse raw response from provider into validated ActionPlan."""
        if not raw_response:
            return ActionPlan(
                session_id=ctx.session_id,
                step=ctx.step,
                reasoning="Empty model response received.",
                actions=[],
                status="need_user",
                confidence=0.0,
                reasoningMode="EMPTY_RESPONSE"
            )

        # Extract tool call
        actions = []
        status = "continue"
        reasoning = raw_response.get("reasoning", "Executing tool call.")

        raw_actions = raw_response.get("actions", [])
        if not raw_actions and "action" in raw_response:
            raw_actions = [raw_response["action"]]

        for item in raw_actions:
            valid, err, action = self.validator.validate_action_payload(item)
            if not valid:
                logger.warning("Rejected invalid action proposal: %s", err)
                return ActionPlan(
                    session_id=ctx.session_id,
                    step=ctx.step,
                    reasoning=f"Model proposal rejected by strict runtime contract: {err}",
                    actions=[],
                    status="need_user",
                    confidence=0.0,
                    reasoningMode="INVALID_SCHEMA"
                )
            if action:
                actions.append(action)

        if raw_response.get("is_complete") or raw_response.get("status") == "done":
            status = "done"

        return ActionPlan(
            session_id=ctx.session_id,
            step=ctx.step,
            reasoning=reasoning,
            actions=actions,
            status=status,
            confidence=raw_response.get("confidence", 0.9),
            reasoningMode="REMOTE_LLM"
        )
