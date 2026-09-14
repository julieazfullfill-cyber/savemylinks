"""Bước scoring: momentum + opportunity, ghi bảng `candidates`. Đúng công thức
docs/DATA_MODEL.md:

    momentum    = 0.5*norm(accel) + 0.3*norm(n_sources) + 0.2*recency(first_seen_at)
    opportunity = 0.6*(1 - saturation_score) + 0.4*commercial_signal

KHÔNG gộp hai trục thành một số — `candidates.momentum` và `candidates.opportunity`
lưu riêng, đọc riêng. Điểm vào hàng đợi (DATA_MODEL.md): `accel > 0 và n_sources >= 2`
— chỉ term thoả điều kiện này mới được tạo/cập nhật candidate.

`norm()`/`recency()` không có công thức cụ thể trong DATA_MODEL.md, tự chọn:
    - norm(accel): sigmoid quanh 0 — accel âm/dương lớn tuỳ ý đều vào (0,1), không
      cần biết trước biên trên/dưới thực tế của accel (không giống min-max, ổn định
      dù chạy trên tập term khác nhau mỗi lần).
    - norm(n_sources): tuyến tính trên số nguồn ĐÃ ĐĂNG KÝ (REGISTRY), không hardcode.
    - recency(first_seen_at): suy giảm nửa chu kỳ 30 ngày — term mới xuất hiện hôm nay
      recency=1, 30 ngày trước recency=0.5, giảm dần nhưng không bao giờ về 0.

`opportunity` là NULL nếu term chưa qua `pipeline/enrich.py` (chưa có saturation_score)
— không suy ra bằng 0 hay giá trị mặc định, đúng tinh thần fail-closed: chưa biết thì
để trống, không đoán.
"""

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.adapters import REGISTRY
from scanner.core.log import get_logger
from scanner.core.models import Candidate, Term, TermEnrichment, TermMetricsDaily

log = get_logger(__name__)

ACCEL_SIGMOID_K = 0.3
RECENCY_HALF_LIFE_DAYS = 30.0
MOMENTUM_W_ACCEL = 0.5
MOMENTUM_W_SOURCES = 0.3
MOMENTUM_W_RECENCY = 0.2
OPPORTUNITY_W_SATURATION = 0.6
OPPORTUNITY_W_COMMERCIAL = 0.4
DEFAULT_TOP_N = 200


def norm_accel(accel: float) -> float:
    """Sigmoid quanh 0 -> (0,1). accel=0 -> 0.5, accel dương lớn -> gần 1."""
    return 1.0 / (1.0 + math.exp(-ACCEL_SIGMOID_K * accel))


def norm_n_sources(n_sources: int, max_sources: int) -> float:
    if max_sources <= 0:
        return 0.0
    return max(0.0, min(n_sources / max_sources, 1.0))


def recency(first_seen_at: datetime, as_of: datetime) -> float:
    """1.0 nếu first_seen_at = as_of, giảm nửa mỗi RECENCY_HALF_LIFE_DAYS ngày."""
    days = max((as_of - first_seen_at).total_seconds() / 86400.0, 0.0)
    return float(0.5 ** (days / RECENCY_HALF_LIFE_DAYS))


def _round4(value: float) -> Decimal:
    return Decimal(str(round(value, 4)))


def compute_momentum(
    accel: float, n_sources: int, first_seen_at: datetime, max_sources: int, as_of: datetime
) -> Decimal:
    value = (
        MOMENTUM_W_ACCEL * norm_accel(accel)
        + MOMENTUM_W_SOURCES * norm_n_sources(n_sources, max_sources)
        + MOMENTUM_W_RECENCY * recency(first_seen_at, as_of)
    )
    return _round4(value)


def compute_opportunity(
    saturation_score: Decimal | None, commercial_signal: bool | None
) -> Decimal | None:
    """None nếu chưa enrich (saturation_score chưa có) — không đoán."""
    if saturation_score is None:
        return None
    commercial = 1.0 if commercial_signal else 0.0
    value = OPPORTUNITY_W_SATURATION * (1.0 - float(saturation_score)) + (
        OPPORTUNITY_W_COMMERCIAL * commercial
    )
    return _round4(value)


@dataclass
class ScoreStats:
    scored: int = 0
    new_candidates: int = 0
    updated_candidates: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "scored": self.scored,
            "new_candidates": self.new_candidates,
            "updated_candidates": self.updated_candidates,
        }


async def score_candidates(session: AsyncSession, top_n: int = DEFAULT_TOP_N) -> ScoreStats:
    """Tính momentum/opportunity cho term đạt điều kiện vào hàng đợi, ghi `candidates`.

    Term đã có candidate `status='pending'` thì cập nhật điểm (chưa ai duyệt/từ chối).
    Term chưa có, hoặc candidate cũ đã approved/rejected/exported, thì tạo dòng mới —
    không đụng vào lịch sử các candidate đã qua xử lý.
    """
    stats = ScoreStats()
    latest_date = await session.scalar(select(func.max(TermMetricsDaily.date)))
    if latest_date is None:
        return stats

    stmt = (
        select(TermMetricsDaily, Term, TermEnrichment)
        .join(Term, Term.id == TermMetricsDaily.term_id)
        .outerjoin(TermEnrichment, TermEnrichment.term_id == Term.id)
        .where(
            TermMetricsDaily.date == latest_date,
            TermMetricsDaily.accel > 0,
            TermMetricsDaily.n_sources >= 2,
        )
        .order_by(TermMetricsDaily.accel.desc())
        .limit(top_n)
    )
    rows = (await session.execute(stmt)).all()
    if not rows:
        return stats

    max_sources = len(REGISTRY)
    as_of = datetime.now(UTC)

    for metrics_row, term, enrichment in rows:
        momentum = compute_momentum(
            float(metrics_row.accel), metrics_row.n_sources, term.first_seen_at, max_sources, as_of
        )
        opportunity = compute_opportunity(
            enrichment.saturation_score if enrichment else None,
            enrichment.commercial_signal if enrichment else None,
        )

        existing = await session.scalar(
            select(Candidate).where(Candidate.term_id == term.id, Candidate.status == "pending")
        )
        if existing is not None:
            existing.momentum = momentum
            existing.opportunity = opportunity
            stats.updated_candidates += 1
        else:
            session.add(Candidate(term_id=term.id, momentum=momentum, opportunity=opportunity))
            stats.new_candidates += 1
        stats.scored += 1

    log.info("score.done", **stats.as_dict())
    return stats
