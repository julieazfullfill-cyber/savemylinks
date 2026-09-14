"""Dashboard tương tác: FastAPI + Jinja2 + HTMX (CLAUDE.md — không dựng SPA).

Trang liệt kê (`/`, `/candidates`, `/review`) chỉ đọc. Từ Phase 4, một số hành động
CÓ ghi DB / gọi LLM khi người vận hành chủ động bấm nút (không tự động khi tải
trang) — xem `check_uspto_action`/`check_llm_action`/`generate_brief_action` bên
dưới. CLAUDE.md rule 11 ("không gọi LLM trong request path của dashboard") được hiểu
là "không tự động gọi LLM khi trang load" — một action POST do người dùng chủ động
bấm là cùng loại thao tác với `scanner risk`/`scanner brief` chạy qua CLI, chỉ khác
kênh kích hoạt; rule 11 đã cập nhật lại đúng ý này trong CLAUDE.md cùng commit."""

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import BackgroundTasks, FastAPI, Form, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.config import get_settings
from scanner.core.db import get_sessionmaker, session_scope
from scanner.core.log import get_logger
from scanner.core.models import Candidate
from scanner.core.models import DesignBrief as DesignBriefRow
from scanner.core.models import RiskFlag, Seed, Term, TermMetricsDaily, TermObservation
from scanner.pipeline.brief import (
    DEFAULT_PRODUCT_PRESET,
    PRODUCT_PRESETS,
    BriefBlockedError,
    BriefExportBlockedError,
    BriefLLMFailedError,
    export_brief,
    generate_brief,
)
from scanner.pipeline.risk import (
    ApprovalRequiredError,
    approve_candidate,
    check_uspto,
    classify_origin,
    determine_risk_tier,
    reject_candidate,
    write_risk_flag,
)
from scanner.pipeline.uspto_index import discover_bulk_paths, index_status, load_path

log = get_logger(__name__)

TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

app = FastAPI(title="POD Trend Scanner")


async def latest_metrics_date(session: AsyncSession) -> Any:
    """Ngày gần nhất đã có metrics — trang mặc định hiển thị ngày này."""
    return await session.scalar(select(func.max(TermMetricsDaily.date)))


async def top_terms_by_accel(
    session: AsyncSession, target_date: Any, limit: int
) -> list[dict[str, Any]]:
    """Top term theo accel giảm dần cho một ngày. accel NULL (chưa đủ lịch sử) xếp cuối."""
    stmt = (
        select(
            Term.id,
            Term.text_display,
            Term.niche,
            TermMetricsDaily.value_norm,
            TermMetricsDaily.velocity_7d,
            TermMetricsDaily.velocity_21d,
            TermMetricsDaily.accel,
            TermMetricsDaily.n_sources,
        )
        .join(Term, Term.id == TermMetricsDaily.term_id)
        .where(TermMetricsDaily.date == target_date)
        .order_by(TermMetricsDaily.accel.desc().nulls_last(), TermMetricsDaily.value_norm.desc())
        .limit(limit)
    )
    rows = (await session.execute(stmt)).all()
    return [dict(row._mapping) for row in rows]


@app.get("/", response_class=HTMLResponse)
async def top_terms_page(
    request: Request, limit: int = Query(100, ge=1, le=500)
) -> HTMLResponse:
    async with get_sessionmaker()() as session:
        target_date = await latest_metrics_date(session)
        rows = (
            await top_terms_by_accel(session, target_date, limit)
            if target_date is not None
            else []
        )
    return templates.TemplateResponse(
        request, "top_terms.html", {"rows": rows, "date": target_date, "limit": limit}
    )


async def distinct_niches(session: AsyncSession) -> list[str]:
    rows = (
        await session.execute(select(Term.niche).where(Term.niche.is_not(None)).distinct())
    ).scalars()
    return sorted(n for n in rows if n)


async def candidates_for_scatter(
    session: AsyncSession, niche: str | None, risk_tier: str | None
) -> list[dict[str, Any]]:
    """momentum/opportunity cho scatter — chỉ candidate đã có cả hai trục (opportunity
    NULL nghĩa là chưa qua enrich, chưa vẽ được điểm cho nó).

    risk_tier suy ra từ seed đã sinh ra observation của term đó (MAX theo chuỗi 'T0'..
    'T3' — so sánh string đúng thứ tự vì cùng độ dài, cùng tiền tố). Term không gắn
    seed nào (ví dụ pinterest_trends, etsy_csv_import) thì risk_tier là NULL — không
    suy đoán, không mặc định về T0.
    """
    risk_subq = (
        select(TermObservation.term_id, func.max(Seed.risk_tier).label("risk_tier"))
        .join(Seed, Seed.id == TermObservation.seed_id)
        .group_by(TermObservation.term_id)
        .subquery()
    )
    stmt = (
        select(
            Candidate.id,
            Candidate.term_id,
            Candidate.momentum,
            Candidate.opportunity,
            Candidate.status,
            Term.text_display,
            Term.niche,
            risk_subq.c.risk_tier,
        )
        .join(Term, Term.id == Candidate.term_id)
        .outerjoin(risk_subq, risk_subq.c.term_id == Term.id)
        .where(Candidate.momentum.is_not(None), Candidate.opportunity.is_not(None))
    )
    if niche:
        stmt = stmt.where(Term.niche == niche)
    if risk_tier:
        stmt = stmt.where(risk_subq.c.risk_tier == risk_tier)
    stmt = stmt.order_by(Candidate.momentum.desc())
    rows = (await session.execute(stmt)).all()
    return [dict(row._mapping) for row in rows]


@app.get("/candidates", response_class=HTMLResponse)
async def candidates_page(
    request: Request,
    niche: str | None = Query(None),
    risk_tier: str | None = Query(None),
) -> HTMLResponse:
    """Scatter plot momentum (x) / opportunity (y), 4 góc phần tư, filter niche + risk_tier."""
    async with get_sessionmaker()() as session:
        niches = await distinct_niches(session)
        rows = await candidates_for_scatter(session, niche, risk_tier)
    return templates.TemplateResponse(
        request,
        "candidates.html",
        {
            "rows": rows,
            "niches": niches,
            "risk_tiers": ["T0", "T1", "T2", "T3"],
            "selected_niche": niche,
            "selected_risk_tier": risk_tier,
        },
    )


async def review_queue(session: AsyncSession) -> list[dict[str, Any]]:
    """Candidate `status='pending'` có risk_level 'review' hoặc 'blocked' — Lớp 4
    (RISK_POLICY.md): chỉ HIỂN THỊ hàng đợi, nút duyệt/từ chối thật là việc Phase 4.
    """
    risk_subq = (
        select(TermObservation.term_id, func.max(Seed.risk_tier).label("risk_tier"))
        .join(Seed, Seed.id == TermObservation.seed_id)
        .group_by(TermObservation.term_id)
        .subquery()
    )
    stmt = (
        select(
            Candidate.id,
            Candidate.risk_level,
            Candidate.momentum,
            Candidate.opportunity,
            Term.id.label("term_id"),
            Term.text_display,
            Term.niche,
            risk_subq.c.risk_tier,
        )
        .join(Term, Term.id == Candidate.term_id)
        .outerjoin(risk_subq, risk_subq.c.term_id == Term.id)
        .where(Candidate.status == "pending", Candidate.risk_level.in_(("review", "blocked")))
        .order_by(Candidate.risk_level.desc(), Candidate.id.desc())
    )
    rows = [dict(r._mapping) for r in (await session.execute(stmt)).all()]
    if not rows:
        return rows

    term_ids = [r["term_id"] for r in rows]
    flags = (
        await session.execute(
            select(RiskFlag)
            .where(RiskFlag.term_id.in_(term_ids))
            .order_by(RiskFlag.term_id, RiskFlag.created_at.desc())
        )
    ).scalars().all()
    flags_by_term: dict[int, list[RiskFlag]] = {}
    for f in flags:
        if f.term_id is not None:
            flags_by_term.setdefault(f.term_id, []).append(f)
    for row in rows:
        row["flags"] = flags_by_term.get(row["term_id"], [])
    return rows


@app.get("/review", response_class=HTMLResponse)
async def review_page(request: Request) -> HTMLResponse:
    """Hàng đợi chờ người duyệt (Lớp 4) — đọc + nút duyệt/từ chối, xem
    approve_action/reject_action bên dưới."""
    async with get_sessionmaker()() as session:
        rows = await review_queue(session)
    return templates.TemplateResponse(request, "review.html", {"rows": rows})


@app.post("/candidates/{candidate_id}/approve")
async def approve_action(candidate_id: int, by: str = Form("")) -> RedirectResponse:
    async with session_scope() as session:
        candidate = await session.get(Candidate, candidate_id)
        if candidate is None:
            return RedirectResponse(url="/review?error=không+tìm+thấy+candidate", status_code=303)
        tier = await determine_risk_tier(session, candidate.term_id)
        try:
            await approve_candidate(session, candidate, tier, approved_by=by or None)
        except ApprovalRequiredError as exc:
            return RedirectResponse(url=f"/review?error={quote(str(exc))}", status_code=303)
    return RedirectResponse(url="/review", status_code=303)


@app.post("/candidates/{candidate_id}/reject")
async def reject_action(candidate_id: int, by: str = Form("")) -> RedirectResponse:
    async with session_scope() as session:
        candidate = await session.get(Candidate, candidate_id)
        if candidate is None:
            return RedirectResponse(url="/review?error=không+tìm+thấy+candidate", status_code=303)
        await reject_candidate(session, candidate, rejected_by=by or None)
    return RedirectResponse(url="/review", status_code=303)


# ---------------------------------------------------------------------------
# /terms/{id} — chi tiết + action risk gate/brief (Phase 4)
# ---------------------------------------------------------------------------


async def term_detail(session: AsyncSession, term_id: int) -> dict[str, Any] | None:
    term = await session.get(Term, term_id)
    if term is None:
        return None
    metrics = (
        await session.execute(
            select(TermMetricsDaily)
            .where(TermMetricsDaily.term_id == term_id)
            .order_by(TermMetricsDaily.date.desc())
            .limit(14)
        )
    ).scalars().all()
    flags = (
        await session.execute(
            select(RiskFlag)
            .where(RiskFlag.term_id == term_id)
            .order_by(RiskFlag.created_at.desc())
            .limit(20)
        )
    ).scalars().all()
    candidate = (
        await session.execute(
            select(Candidate)
            .where(Candidate.term_id == term_id)
            .order_by(Candidate.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    risk_tier = await determine_risk_tier(session, term_id)
    brief_row = None
    if candidate is not None:
        brief_row = (
            await session.execute(
                select(DesignBriefRow)
                .where(DesignBriefRow.candidate_id == candidate.id)
                .order_by(DesignBriefRow.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
    return {
        "term": term,
        "metrics": metrics,
        "flags": flags,
        "candidate": candidate,
        "risk_tier": risk_tier,
        "brief": brief_row,
        "product_presets": sorted(PRODUCT_PRESETS),
        "default_product_preset": DEFAULT_PRODUCT_PRESET,
    }


@app.get("/terms/{term_id}", response_class=HTMLResponse)
async def term_detail_page(request: Request, term_id: int) -> HTMLResponse:
    async with get_sessionmaker()() as session:
        data = await term_detail(session, term_id)
    if data is None:
        return HTMLResponse(f"không tìm thấy term id={term_id}", status_code=404)
    return templates.TemplateResponse(request, "term_detail.html", data)


@app.post("/terms/{term_id}/check-uspto", response_class=HTMLResponse)
async def check_uspto_action(request: Request, term_id: int) -> HTMLResponse:
    """Chủ động bấm mới chạy — xem ghi chú rule 11 ở docstring module. Lớp 2 tra local
    index (không mạng), an toàn để chạy trực tiếp trong request path."""
    async with session_scope() as session:
        term = await session.get(Term, term_id)
        if term is None:
            return HTMLResponse("không tìm thấy term", status_code=404)
        result = await check_uspto(session, term_id, term.text_norm)
        await write_risk_flag(session, term_id, "uspto", result.verdict, result.evidence)
    return templates.TemplateResponse(
        request,
        "_check_result.html",
        {"layer": "USPTO (Lớp 2)", "verdict": result.verdict, "evidence": result.evidence},
    )


@app.post("/terms/{term_id}/check-llm", response_class=HTMLResponse)
async def check_llm_action(request: Request, term_id: int) -> HTMLResponse:
    """Chủ động bấm mới gọi Anthropic API thật — xem ghi chú rule 11 ở docstring module."""
    async with session_scope() as session:
        term = await session.get(Term, term_id)
        if term is None:
            return HTMLResponse("không tìm thấy term", status_code=404)
        result = await classify_origin(term.text_norm)
        await write_risk_flag(session, term_id, "llm_origin", result.verdict, result.evidence)
    return templates.TemplateResponse(
        request,
        "_check_result.html",
        {"layer": "LLM origin (Lớp 3)", "verdict": result.verdict, "evidence": result.evidence},
    )


@app.post("/candidates/{candidate_id}/generate-brief")
async def generate_brief_action(
    candidate_id: int, product: str = Form(DEFAULT_PRODUCT_PRESET)
) -> RedirectResponse:
    async with session_scope() as session:
        candidate = await session.get(Candidate, candidate_id)
        if candidate is None:
            return RedirectResponse(url="/", status_code=303)
        term_id = candidate.term_id
        try:
            await generate_brief(session, candidate, product_preset=product)
        except (BriefBlockedError, BriefLLMFailedError, ValueError) as exc:
            return RedirectResponse(url=f"/terms/{term_id}?error={quote(str(exc))}", status_code=303)
    return RedirectResponse(url=f"/terms/{term_id}", status_code=303)


@app.post("/candidates/{candidate_id}/export-brief")
async def export_brief_action(candidate_id: int) -> RedirectResponse:
    async with session_scope() as session:
        candidate = await session.get(Candidate, candidate_id)
        if candidate is None:
            return RedirectResponse(url="/", status_code=303)
        term_id = candidate.term_id
        tier = await determine_risk_tier(session, term_id)
        try:
            await export_brief(session, candidate, tier)
        except BriefExportBlockedError as exc:
            return RedirectResponse(url=f"/terms/{term_id}?error={quote(str(exc))}", status_code=303)
    return RedirectResponse(url=f"/terms/{term_id}", status_code=303)


# ---------------------------------------------------------------------------
# /uspto — nạp bulk data + xem tiến độ (nền, poll qua HTMX)
# ---------------------------------------------------------------------------


@dataclass
class UsptoLoadState:
    running: bool = False
    current_file: str | None = None
    files_done: int = 0
    files_total: int = 0
    last_error: str | None = None
    last_finished_at: datetime | None = None


_uspto_load_state = UsptoLoadState()


async def _run_uspto_load(path_str: str, force: bool) -> None:
    """Chạy nền qua BackgroundTasks — 91 file ~21GB có thể mất nhiều phút, không được
    block request POST /uspto/load. Mỗi file dùng session riêng (load_path tự
    commit theo từng entry, xem pipeline/uspto_index.py)."""
    global _uspto_load_state
    paths = discover_bulk_paths([path_str])
    _uspto_load_state = UsptoLoadState(running=True, files_total=len(paths))
    try:
        for i, p in enumerate(paths):
            _uspto_load_state.current_file = p.name
            async with get_sessionmaker()() as session:
                await load_path(session, p, force=force)
            _uspto_load_state.files_done = i + 1
    except Exception as exc:  # noqa: BLE001 - hiển thị lỗi cho operator, không crash server
        _uspto_load_state.last_error = str(exc)
        log.warning("web.uspto_load_failed", error=str(exc))
    finally:
        _uspto_load_state.running = False
        _uspto_load_state.last_finished_at = datetime.now(UTC)


@app.get("/uspto", response_class=HTMLResponse)
async def uspto_page(request: Request) -> HTMLResponse:
    async with get_sessionmaker()() as session:
        status = await index_status(session)
    return templates.TemplateResponse(
        request,
        "uspto.html",
        {
            "status": status,
            "state": _uspto_load_state,
            "coverage_complete": get_settings().uspto_index_coverage_complete,
        },
    )


@app.post("/uspto/load")
async def uspto_load_action(background_tasks: BackgroundTasks, path: str = Form(...), force: bool = Form(False)) -> RedirectResponse:
    if _uspto_load_state.running:
        return RedirectResponse(
            url="/uspto?error=đang+có+lượt+nạp+khác+đang+chạy,+đợi+xong+rồi+thử+lại",
            status_code=303,
        )
    background_tasks.add_task(_run_uspto_load, path, force)
    return RedirectResponse(url="/uspto", status_code=303)


@app.get("/uspto/status-fragment", response_class=HTMLResponse)
async def uspto_status_fragment(request: Request) -> HTMLResponse:
    async with get_sessionmaker()() as session:
        status = await index_status(session)
    return templates.TemplateResponse(
        request, "_uspto_status.html", {"status": status, "state": _uspto_load_state}
    )
