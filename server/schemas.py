"""
schemas.py — Strict server-side mirror of the v1 wire protocol.

These pydantic models are a SECURITY BOUNDARY, not just serialization helpers:

  * Inbound  (SanitizedContext): we reject any payload that smuggles a raw value
    where only a category/token/enum is allowed. If the client is doing its job,
    no PII value can even be represented here.
  * Outbound (ActionPlan): the model's output is constrained to a closed action
    vocabulary via Literal types, so a hallucinated or injected "action" like
    `eval` or `exfiltrate` fails validation before it can ever reach the client.
"""
from __future__ import annotations

from typing import List, Optional, Literal, Dict
from pydantic import BaseModel, Field, field_validator

PROTOCOL_VERSION = "1.0"

# --- categories / enums kept in lockstep with extension/lib/protocol.js -------
PII_TYPES = {
    "password", "otp", "api_key", "credit_card", "bank_account", "aadhaar",
    "pan", "upi", "email", "phone", "person", "address", "dob", "face",
    "signature", "id_document", "ip", "generic_secret",
}
VALUE_STATES = {"empty", "filled", "redacted"}

ActionType = Literal[
    # Navigation
    "navigate", "back", "forward", "reload",
    # Tabs
    "new_tab", "close_tab", "switch_tab",
    # Mouse & Pointer
    "click", "double_click", "right_click", "hover", "focus",
    # Keyboard & Text
    "type", "clear", "press_key", "key_combination",
    # Scrolling
    "scroll", "scroll_up", "scroll_down", "scroll_to", "scroll_to_element", "scroll_container",
    # Form Controls
    "select", "select_option", "check", "uncheck", "toggle", "submit_form",
    # Drag & Drop
    "drag", "drop",
    # Files & Clipboard
    "upload_file", "download", "copy", "paste",
    # Timing & Sync
    "wait", "wait_for_element", "wait_for_navigation", "wait_for_idle",
    # Menus & Dialogs
    "open_menu", "close_menu", "handle_dialog",
    # Local Vault & Profile
    "fill_local", "local_profile_action", "local_secret_action",
    # Flow & Control
    "no_action_required", "done", "need_user", "abort",
]

Status = Literal["continue", "done", "need_user", "abort", "blocked", "paused"]
RiskLevel = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
Reversibility = Literal["REVERSIBLE", "PARTIALLY_REVERSIBLE", "IRREVERSIBLE"]


# --- inbound ------------------------------------------------------------------
class Element(BaseModel):
    id: int
    role: str
    label: str = ""
    bbox: List[int] = Field(..., min_length=4, max_length=4)
    enabled: bool = True
    value_state: str = "empty"
    sensitive: bool = False
    pii_type: Optional[str] = None
    destructive: bool = False
    stable_id: Optional[str] = None
    selector: Optional[str] = None

    @field_validator("value_state")
    @classmethod
    def _vs(cls, v):
        return v if v in VALUE_STATES else "empty"


class Redaction(BaseModel):
    pii_type: str
    token: str
    method: str
    bbox: List[int] = Field(..., min_length=4, max_length=4)
    confidence: float = 0.0

    @field_validator("token")
    @classmethod
    def _token_is_placeholder(cls, v):
        # A redaction entry may ONLY carry a <CATEGORY_n> placeholder, never a value.
        if not (v.startswith("<") and v.endswith(">")):
            raise ValueError("redaction token must be a <PLACEHOLDER>, not a raw value")
        return v


class Viewport(BaseModel):
    w: int
    h: int
    scroll_x: int = 0
    scroll_y: int = 0
    dpr: float = 1.0


class PrivacyReceipt(BaseModel):
    detected: int = 0
    redacted: int = 0
    residual_risk: str = "unknown"
    send_screenshot: bool = True
    fail_closed_triggered: bool = False
    categories: dict = {}


class SanitizedContext(BaseModel):
    protocol_version: str = PROTOCOL_VERSION
    session_id: str
    step: int
    task: str
    url_origin: str = ""
    viewport: Viewport
    screenshot: Optional[str] = None  # data URL of the REDACTED image, or None
    screenshot_included: bool = True
    elements: List[Element] = []
    redactions: List[Redaction] = []
    privacy_receipt: Optional[PrivacyReceipt] = None
    executed_actions: List[str] = []  # action signatures already executed (e.g. "click|11")
    profile_keys: List[str] = []  # vault keys available for fill_local (e.g. ["email", "phone"])
    # Structured task intent (from client-side task parser, no raw PII)
    task_intent: Optional[str] = None        # e.g. "PAY_FEE", "PAGE_SUMMARY", "SUBMIT_FORM"
    task_operations: List[str] = []          # e.g. ["LOCATE_FEE_SECTION", "CLICK"]
    task_profile_requirements: List[str] = [] # e.g. ["payment_method", "upi"]
    task_confidence: Optional[float] = None
    task_object: Optional[str] = None        # e.g. "application_fee", "application", "page"
    # Objective context from GoalManager
    current_objective: Optional[str] = None
    completed_objectives: List[str] = []
    page_semantic_summary: Optional[str] = None

    @field_validator("url_origin")
    @classmethod
    def _origin_only(cls, v):
        # Defense in depth: reject anything with a path/query — origin only.
        if v and ("?" in v or v.count("/") > 2):
            raise ValueError("url_origin must be an origin, not a full URL")
        return v


# --- outbound -----------------------------------------------------------------
class ExpectedEffect(BaseModel):
    type: str = "STATE_CHANGE"
    description: str = ""
    expected_url: Optional[str] = None
    expected_element: Optional[str] = None
    expected_value: Optional[str] = None


class Action(BaseModel):
    type: ActionType
    action_id: Optional[str] = None
    target_id: Optional[int] = None
    stable_target_id: Optional[str] = None
    text: Optional[str] = None          # literal, non-sensitive only
    source: Optional[str] = None        # vault key for fill_local (value resolved on client)
    field_name: Optional[str] = None    # for local_profile_action / local_secret_action
    option: Optional[str] = None
    amount: Optional[int] = None
    direction: Optional[Literal["up", "down"]] = None
    url: Optional[str] = None
    tab_id: Optional[int] = None
    key: Optional[str] = None
    keys: Optional[List[str]] = None
    file_path: Optional[str] = None
    ms: Optional[int] = None
    dialog_action: Optional[Literal["accept", "dismiss", "prompt"]] = None
    dialog_text: Optional[str] = None
    requires_confirmation: bool = False
    risk: RiskLevel = "LOW"
    reversibility: Reversibility = "REVERSIBLE"
    reason: Optional[str] = None
    expected_effect: Optional[ExpectedEffect] = None


class ActionPlan(BaseModel):
    protocol_version: str = PROTOCOL_VERSION
    session_id: str
    step: int
    reasoning: str = ""
    actions: List[Action] = []
    status: Status = "continue"
    confidence: float = 0.5
    reasoningMode: str = "UNKNOWN"  # REMOTE_LLM | FALLBACK | UNKNOWN
    current_objective: Optional[str] = None


# --- QUERY path (read-only summarization over sanitized records) --------------
# Query mode never sends a screenshot, raw DOM, or raw page text. It sends a
# MASKED, typed view of the page's tables: identifier columns were dropped and
# replaced by <CATEGORY_n> tokens IN THE BROWSER (extension/lib/record-extraction.js),
# inline PII in retained cells was tokenized, and amounts/dates were parsed to
# typed arrays. These models are the server-side mirror of that shape — a security
# boundary: /query independently residual-scans every cell and fails closed on any
# raw identifier (main.py), exactly like /plan does for the action path.
class QueryColumn(BaseModel):
    name: str = ""
    kind: str = "other"  # identifier | metric | date | dimension | other


class QueryTable(BaseModel):
    caption: str = ""
    columns: List[QueryColumn] = []
    rows: List[List[str]] = []
    # Column-index lists (indices into `columns`); JSON object keys below are the
    # same indices stringified (JSON has no int keys).
    numericColumns: List[int] = []
    dateColumns: List[int] = []
    dimensionColumns: List[int] = []
    numeric: Dict[str, List[Optional[float]]] = {}   # colIdx(str) -> parsed amounts (null where unparsable)
    dates: Dict[str, List[Optional[str]]] = {}        # colIdx(str) -> ISO dates   (null where unparsable)
    truncated: bool = False


class MaskedSummary(BaseModel):
    count: int = 0
    categories: dict = {}


class QueryContext(BaseModel):
    protocol_version: str = PROTOCOL_VERSION
    session_id: str
    query: str = ""
    url_origin: str = ""
    viewport: Optional[Viewport] = None
    # Data URL of the REDACTED raster, or None. Query mode NEVER sends the original
    # screenshot; when present this is the on-device composite with every detected
    # region (including identifier columns no regex catches) already blacked out into
    # the pixels. The server does not OCR it — the redaction happened in the browser.
    screenshot: Optional[str] = None
    screenshot_included: bool = False
    tables: List[QueryTable] = []
    masked: MaskedSummary = MaskedSummary()
    privacy_receipt: Optional[PrivacyReceipt] = None
    # Structured task intent (from client-side task parser)
    task_intent: Optional[str] = None

    @field_validator("url_origin")
    @classmethod
    def _origin_only(cls, v):
        if v and ("?" in v or v.count("/") > 2):
            raise ValueError("url_origin must be an origin, not a full URL")
        return v


class Group(BaseModel):
    key: str
    count: int = 0
    sum: float = 0.0
    avg: float = 0.0
    min: float = 0.0
    max: float = 0.0


class Totals(BaseModel):
    count: int = 0
    sum: float = 0.0
    avg: float = 0.0
    min: float = 0.0
    max: float = 0.0


class DateRange(BaseModel):
    min: Optional[str] = None
    max: Optional[str] = None


class QueryAnswer(BaseModel):
    protocol_version: str = PROTOCOL_VERSION
    session_id: str
    answer: str = ""                       # human-readable summary the panel shows
    metric: Optional[str] = None           # name of the aggregated amount column
    dimension: Optional[str] = None         # name of the group-by column, if any
    groups: List[Group] = []                # per-dimension breakdown (the "calc steps")
    totals: Optional[Totals] = None         # grand totals across all rows
    date_range: Optional[DateRange] = None
    row_count: int = 0
    status: Status = "done"
    confidence: float = 0.6
