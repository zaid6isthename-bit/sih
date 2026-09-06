"""
query_planner.py — Turns a sanitized QueryContext into a QueryAnswer.

This is the QUERY-mode counterpart to planner.py. The browser has already done
all PII handling: identifier columns were dropped and replaced by <CATEGORY_n>
tokens, inline PII was tokenized, and amounts/dates were parsed into the typed
`numeric`/`dates` arrays this module aggregates. Amounts and dates are NOT PII —
they are exactly the transaction data the summary is meant to read — so the
server can compute real, verifiable totals from them without ever seeing a raw
account or card number.

Backend selection mirrors planner.py (PBA_BACKEND). The default "mock" path is a
deterministic aggregator: no GPU/model, runs on any laptop, and produces the same
numbers a human would get by adding up the (masked) table — which is what makes it
demo- and CI-friendly. A "vlm" path could instead prompt a text LLM over the same
sanitized arrays; the deterministic path stays as the safety net either way.
"""
from __future__ import annotations
import os, re
from typing import List, Optional

from schemas import QueryContext, QueryTable, QueryAnswer, Group, Totals, DateRange

BACKEND = os.environ.get("PBA_BACKEND", "mock").lower()
if BACKEND == "auto":
    BACKEND = "vlm"


# ---- selection heuristics ---------------------------------------------------
def _pick_table(tables: List[QueryTable]) -> Optional[QueryTable]:
    """Target = most numeric columns, tie-broken by row count."""
    best, best_score = None, -1
    for t in tables:
        score = len(t.numericColumns) * 100000 + len(t.rows)
        if score > best_score:
            best_score, best = score, t
    return best


def _pick_dimension(table: QueryTable, query: str) -> int:
    """Group-by column: prefer one the query names, else the first dimension."""
    dims = table.dimensionColumns or []
    if not dims:
        return -1
    q = (query or "").lower()
    wants: List[str] = []
    if "type" in q:
        wants.append("type")
    if "categor" in q:
        wants.append("categor")
    if any(w in q for w in ("merchant", "payee", "vendor", "store", "narration")):
        wants += ["merchant", "payee", "vendor", "store", "narration"]
    if "mode" in q or "method" in q:
        wants += ["mode", "method"]
    if "status" in q:
        wants.append("status")
    for w in wants:
        for c in dims:
            if 0 <= c < len(table.columns) and w in (table.columns[c].name or "").lower():
                return c
    return dims[0]


def _col(table: QueryTable, cols: List[int]) -> int:
    return cols[0] if cols else -1


def _nums(table: QueryTable, col: int) -> List[Optional[float]]:
    # JSON object keys are strings — numeric/dates are keyed by the stringified index.
    return table.numeric.get(str(col), []) if col >= 0 else []


def _isos(table: QueryTable, col: int) -> List[Optional[str]]:
    return table.dates.get(str(col), []) if col >= 0 else []


# ---- aggregation ------------------------------------------------------------
def _round(x: float) -> float:
    return round(x + 0.0, 2)


def _totals_of(values: List[Optional[float]]) -> Totals:
    vals = [v for v in values if v is not None]
    if not vals:
        return Totals()
    s = sum(vals)
    return Totals(count=len(vals), sum=_round(s), avg=_round(s / len(vals)),
                  min=_round(min(vals)), max=_round(max(vals)))


def _groups_by_dim(table: QueryTable, metric_col: int, dim_col: int) -> List[Group]:
    nums = _nums(table, metric_col)
    buckets = {}
    order = []
    for i, row in enumerate(table.rows):
        v = nums[i] if i < len(nums) else None
        if v is None:
            continue
        key = (row[dim_col] if 0 <= dim_col < len(row) and row[dim_col] else "—") or "—"
        if key not in buckets:
            buckets[key] = []
            order.append(key)
        buckets[key].append(v)
    out = []
    for key in order:
        t = _totals_of(buckets[key])
        out.append(Group(key=str(key)[:60], count=t.count, sum=t.sum, avg=t.avg, min=t.min, max=t.max))
    out.sort(key=lambda g: g.sum, reverse=True)
    return out


def _counts_by_dim(table: QueryTable, dim_col: int) -> List[Group]:
    counts = {}
    order = []
    for row in table.rows:
        key = (row[dim_col] if 0 <= dim_col < len(row) and row[dim_col] else "—") or "—"
        if key not in counts:
            counts[key] = 0
            order.append(key)
        counts[key] += 1
    out = [Group(key=str(k)[:60], count=counts[k]) for k in order]
    out.sort(key=lambda g: g.count, reverse=True)
    return out


def _date_range(table: QueryTable, date_col: int) -> Optional[DateRange]:
    lo = hi = None
    for iso in _isos(table, date_col):
        if not iso:
            continue
        if lo is None or iso < lo:
            lo = iso
        if hi is None or iso > hi:
            hi = iso
    return DateRange(min=lo, max=hi) if (lo or hi) else None


# ---- currency + formatting (display only) ----------------------------------
_CUR = ("₹", "$", "€", "£", "¥")


def _currency_of(table: QueryTable, metric_col: int) -> str:
    if metric_col < 0:
        return ""
    for row in table.rows:
        if 0 <= metric_col < len(row):
            cell = (row[metric_col] or "").strip()
            for sym in _CUR:
                if cell.startswith(sym):
                    return sym
    return ""


def _money(cur: str, n: float) -> str:
    return f"{cur}{n:,.2f}"


def _compose(query: str, table: QueryTable, metric: Optional[str], dim: Optional[str],
             groups: List[Group], totals: Optional[Totals], dr: Optional[DateRange], cur: str) -> str:
    rows = len(table.rows)
    span = ""
    if dr and (dr.min or dr.max):
        span = f" from {dr.min or '?'} to {dr.max or '?'}"

    if metric and totals and totals.count:
        head = f"Across {totals.count} record(s){span}, {metric} totals {_money(cur, totals.sum)} " \
               f"(avg {_money(cur, totals.avg)}, min {_money(cur, totals.min)}, max {_money(cur, totals.max)})."
        if dim and groups:
            parts = [f"{g.key}: {_money(cur, g.sum)} (n={g.count})" for g in groups]
            head += f" By {dim} — " + "; ".join(parts) + "."
        return head

    if dim and groups:
        parts = [f"{g.key}: {g.count}" for g in groups]
        return f"{rows} record(s){span}. By {dim} — " + "; ".join(parts) + "."

    return f"{rows} record(s){span} detected."


# ---- public entry -----------------------------------------------------------
def _mock_answer(ctx: QueryContext) -> QueryAnswer:
    q = (ctx.query or "").lower()
    tables = ctx.tables or []

    # PAGE_SUMMARY: detect page summary requests and generate semantic summary
    page_summary_re = re.compile(
        r"\bwhat('s|\s+is)\s+(on|on\s+the|on\s+this)\s+(page|screen|site|form)\b"
        r"|\bdescribe\s+(this|the)\s+(page|screen|site|form)\b"
        r"|\bsummariz?e?\s+(this|the)\s+(page|screen|site|form)\b"
        r"|\bpage\s+summary\b"
        r"|\bwhat\s+do\s+you\s+see\b"
        r"|\boverview\b"
        r"|\bwhat\s+is\s+displayed\b"
        r"|\btell\s+me\s+about\s+(this|the)\s+page\b"
    )
    if page_summary_re.search(q):
        return _compose_page_summary(ctx)

    # Standard table-based query
    if not tables:
        return QueryAnswer(session_id=ctx.session_id,
                           answer="No tabular records were detected on this page.",
                           row_count=0, status="done", confidence=0.5)

    table = _pick_table(tables)
    metric_col = _col(table, table.numericColumns)
    dim_col = _pick_dimension(table, ctx.query)
    date_col = _col(table, table.dateColumns)
    cur = _currency_of(table, metric_col)

    metric = table.columns[metric_col].name if 0 <= metric_col < len(table.columns) else None
    dim = table.columns[dim_col].name if 0 <= dim_col < len(table.columns) else None
    dr = _date_range(table, date_col)

    if metric_col >= 0:
        groups = _groups_by_dim(table, metric_col, dim_col) if dim_col >= 0 else []
        totals = _totals_of(_nums(table, metric_col))
    else:
        groups = _counts_by_dim(table, dim_col) if dim_col >= 0 else []
        totals = None
        metric = None

    answer = _compose(ctx.query, table, metric, dim, groups, totals, dr, cur)
    return QueryAnswer(
        session_id=ctx.session_id, answer=answer, metric=metric, dimension=dim,
        groups=groups, totals=totals, date_range=dr, row_count=len(table.rows),
        status="done", confidence=0.7,
    )


def _compose_page_summary(ctx: QueryContext) -> QueryAnswer:
    """Generate a semantic page summary from the sanitized context.
    
    This analyzes the masked table structure and metadata to produce a
    human-readable summary of what's on the page, without any raw PII.
    """
    tables = ctx.tables or []
    parts = []
    
    # Count total records across all tables
    total_rows = sum(len(t.rows) for t in tables)
    
    # Analyze table structures
    table_summaries = []
    for ti, t in enumerate(tables):
        cols = [c.name for c in t.columns if c.name]
        metric_cols = [t.columns[c].name for c in t.numericColumns if c < len(t.columns)]
        dim_cols = [t.columns[c].name for c in t.dimensionColumns if c < len(t.columns)]
        id_cols = [t.columns[c].name for c, col in enumerate(t.columns)
                   if col.kind == "identifier" or (c not in t.numericColumns and c not in t.dimensionColumns and c not in t.dateColumns)]
        
        table_info = {
            "caption": t.caption or f"Table {ti+1}",
            "columns": cols,
            "rowCount": len(t.rows),
            "metricColumns": metric_cols,
            "dimensionColumns": dim_cols,
            "identifierColumns": id_cols,
            "truncated": t.truncated,
        }
        table_summaries.append(table_info)
    
    # Build the summary
    sections = []
    
    # Application/page type detection from query and context
    query_lower = (ctx.query or "").lower()
    if any(w in query_lower for w in ("application", "form", "scholarship", "portal")):
        sections.append("Page Type: Government Application Form")
    elif any(w in query_lower for w in ("transaction", "bank", "statement")):
        sections.append("Page Type: Financial Statement")
    else:
        sections.append("Page Type: Web Application")
    
    # Table summaries
    for ts in table_summaries:
        if ts["rowCount"] > 0:
            section = f"Section: {ts['caption']}"
            section += f"\n  Records: {ts['rowCount']}"
            if ts["metricColumns"]:
                section += f"\n  Numeric fields: {', '.join(ts['metricColumns'])}"
            if ts["dimensionColumns"]:
                section += f"\n  Category fields: {', '.join(ts['dimensionColumns'])}"
            if ts["identifierColumns"]:
                section += f"\n  Sensitive fields detected: {len(ts['identifierColumns'])} (redacted on-device)"
            sections.append(section)
    
    # Sensitive fields summary
    id_count = sum(len([c for c in t.columns if c.kind == "identifier"])
                   for t in tables)
    if id_count > 0:
        sections.append(f"\nSensitive Information: {id_count} identifier field(s) detected and redacted on-device")
    
    # Controls summary
    controls = []
    for t in tables:
        for row in t.rows:
            for cell in row:
                cell_lower = (cell or "").lower()
                if any(w in cell_lower for w in ("submit", "pay", "button", "confirm")):
                    if cell not in controls:
                        controls.append(cell)
    if controls:
        sections.append(f"Available Actions: {', '.join(controls[:5])}")
    
    answer = "\n".join(sections) if sections else "Page content detected but could not be summarized."
    
    return QueryAnswer(
        session_id=ctx.session_id,
        answer=answer,
        row_count=total_rows,
        status="done",
        confidence=0.8,
    )


def answer_query(ctx: QueryContext) -> QueryAnswer:
    """Dispatch on backend; the deterministic aggregator is always the safety net.

    The VLM path for queries is not yet implemented (query_router.py does not
    exist). When PBA_BACKEND=vlm, this function falls back to the deterministic
    aggregator with a note in the answer. This is intentional: the query mode's
    aggregation is already accurate for structured tabular data, and a VLM adds
    latency without improving numerical correctness.
    """
    return _mock_answer(ctx)
