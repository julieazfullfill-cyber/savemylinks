"""Dashboard tối thiểu: trang HTML thô liệt kê top term theo accel.

Chỉ đọc dữ liệu có sẵn trong term_metrics_daily — không gọi LLM, không ghi DB
(rule 11 trong CLAUDE.md). Dashboard duyệt/từ chối đầy đủ là việc của Phase 2+.
"""

from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.db import get_sessionmaker
from scanner.core.models import (
    Candidate,
    RiskFlag,
    Seed,
    Term,
    TermMetricsDaily,
    TermObservation,
)

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
    """Hàng đợi chờ người duyệt (Lớp 4) — chỉ đọc, xem docstring review_queue()."""
    async with get_sessionmaker()() as session:
        rows = await review_queue(session)
    return templates.TemplateResponse(request, "review.html", {"rows": rows})
