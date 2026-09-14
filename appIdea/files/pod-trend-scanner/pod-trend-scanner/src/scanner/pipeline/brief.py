"""LLM sinh `design_brief` — docs/DESIGN_BRIEF_SPEC.md. LLM chỉ ĐIỀN brief (JSON có
schema), KHÔNG viết prompt — render.py (code thuần) mới ghép brief thành image prompt.

Enforce fail-closed (TASKS.md Phase 3 mục còn lại "enforce fail-closed ở
pipeline/brief.py", RISK_POLICY.md rule 13-14):
    - `generate_brief()` từ chối thẳng nếu `candidate.risk_level == "blocked"` — không
      tốn tiền LLM sinh design cho thứ chắc chắn bị chặn.
    - `export_brief()` gọi lại `is_eligible_for_export()` (risk.py) — kiểm tra ĐỘC LẬP
      lần nữa trước khi đánh dấu `exported_at`, không tin một điểm chặn duy nhất.

Gọi thẳng Anthropic Messages API qua httpx, giống pattern `classify_origin()` trong
risk.py (không thêm SDK mới — CLAUDE.md "hỏi trước khi thêm dependency"). CLAUDE.md rule
12 khuyến nghị Batch API cho job đêm — CHƯA làm (cùng giới hạn đã ghi nhận ở Lớp 3
risk.py: môi trường build này không có SDK, dùng Messages API đồng bộ; nâng cấp lên
Batch API để sau, không chặn Phase 4)."""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.config import get_settings
from scanner.core.log import get_logger
from scanner.core.models import Candidate
from scanner.core.models import DesignBrief as DesignBriefRow
from scanner.core.models import Source as SourceRow
from scanner.core.models import Term, TermEnrichment, TermMetricsDaily, TermObservation
from scanner.pipeline.design_brief_schema import DesignBrief, SourceEvidence
from scanner.pipeline.render import render
from scanner.pipeline.risk import (
    ANTHROPIC_MAX_RETRIES,
    ANTHROPIC_MESSAGES_URL,
    ANTHROPIC_MODEL,
    determine_risk_tier,
    is_eligible_for_export,
)

log = get_logger(__name__)

# (type, print_area) khớp đúng key trong render.PRODUCT_CONSTRAINTS — docs/DESIGN_BRIEF_SPEC.md mục 6.
PRODUCT_PRESETS: dict[str, dict[str, Any]] = {
    "tshirt_front": {
        "type": "tshirt",
        "print_area": "front_center",
        "canvas_px": (4500, 5400),
        "print_method": "dtg",
    },
    "tshirt_pocket": {
        "type": "tshirt",
        "print_area": "front_pocket",
        "canvas_px": (1200, 1200),
        "print_method": "dtg",
    },
    "mug_11oz": {
        "type": "mug",
        "print_area": "full_wrap",
        "canvas_px": (2475, 1155),
        "print_method": "sublimation",
    },
    "blanket": {
        "type": "blanket",
        "print_area": "full_wrap",
        "canvas_px": (6000, 8000),
        "print_method": "sublimation",
    },
    "poster_18x24": {
        "type": "poster",
        "print_area": "full_wrap",
        "canvas_px": (5400, 7200),
        "print_method": "uv",
    },
    "ornament": {
        "type": "ornament",
        "print_area": "full_wrap",
        "canvas_px": (1200, 1200),
        "print_method": "uv",
    },
    "tumbler_20oz": {
        "type": "tumbler",
        "print_area": "full_wrap",
        "canvas_px": (2850, 1500),
        "print_method": "sublimation",
    },
}
DEFAULT_PRODUCT_PRESET = "tshirt_front"

# Nguyên văn docs/DESIGN_BRIEF_SPEC.md mục 3.
BRIEF_SYSTEM_PROMPT = """Bạn là art director cho một xưởng print-on-demand. Đầu vào là một trend term kèm dữ liệu
thị trường. Đầu ra là một design_brief JSON hợp lệ, không có gì khác — không markdown,
không giải thích, không code fence.

QUY TẮC:

1. concept.buyer phải cụ thể tới mức hình dung được một con người. "Phụ nữ 28-35 vừa được
   chọn làm phù dâu lần thứ ba trong năm" là đúng. "Người thích đám cưới" là sai.

2. text_layer.headline tối đa 6 từ với sản phẩm mặc. Người ta đọc áo từ khoảng cách 2 mét.

3. TUYỆT ĐỐI KHÔNG dùng: tên nhân vật, tên phim, tên bài hát, lời bài hát, tên thương hiệu,
   tên người thật, tên đội thể thao, khẩu hiệu chiến dịch chính trị. Nếu trend term chứa
   những thứ này, đặt risk.level = "blocked" và giải thích trong risk.origin_classification.

4. Nếu headline là một cụm bạn từng nghe ở đâu đó, đặt origin_classification =
   "derived_from_media" và risk.level = "review". Thà báo động nhầm còn hơn bỏ sót.

5. art_layer.palette.colors: tối đa 5 màu với DTG, dùng mã hex. Chọn màu tương phản tốt
   trên cả áo trắng và áo đen, hoặc ghi rõ trong constraints nếu chỉ hợp một loại.

6. Nếu design mạnh hơn khi chỉ có chữ, đặt art_layer.enabled = false. Đừng nhét minh hoạ
   vào chỉ vì trường đó tồn tại.

7. personalization_slots: với niche wedding / birthday / custom_photo, luôn cố gắng có ít
   nhất một slot. Sản phẩm cá nhân hoá khó bị copy và bán giá cao hơn.

8. listing.title bắt đầu bằng keyword người ta thực sự gõ, không bắt đầu bằng tên brand.

Đầu vào:
{term, niche, risk_tier, evidence, product_type, seasonality}

Trả về CHỈ phần JSON từ "source" tới "risk" theo đúng schema — KHÔNG bao gồm brief_id
hay created_at, hệ thống tự sinh hai trường đó."""


class BriefBlockedError(Exception):
    """candidate risk_level=blocked -- không sinh brief (RISK_POLICY.md fail-closed)."""


class BriefLLMFailedError(Exception):
    """LLM lỗi/trả JSON sai schema 2 lần liên tiếp -- candidate.status='llm_failed'."""


class BriefExportBlockedError(Exception):
    """Chưa đủ điều kiện export (risk_level/status/approved_by) -- xem is_eligible_for_export()."""


async def gather_evidence(session: AsyncSession, term_id: int) -> SourceEvidence:
    """velocity_7d từ bản ghi term_metrics_daily gần nhất; sources từ tên nguồn đã
    từng sinh observation cho term; saturation = competing_listings (Lớp enrich.py),
    không phải saturation_score đã chuẩn hoá -- khớp ví dụ spec ("saturation": 1240,
    một số nguyên đếm listing, không phải điểm 0-1)."""
    latest = (
        await session.execute(
            select(TermMetricsDaily)
            .where(TermMetricsDaily.term_id == term_id)
            .order_by(TermMetricsDaily.date.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    source_names = (
        await session.execute(
            select(SourceRow.name)
            .join(TermObservation, TermObservation.source_id == SourceRow.id)
            .where(TermObservation.term_id == term_id)
            .distinct()
        )
    ).scalars().all()

    enrichment = await session.get(TermEnrichment, term_id)

    return SourceEvidence(
        velocity_7d=float(latest.velocity_7d) if latest and latest.velocity_7d is not None else None,
        sources=sorted(source_names),
        saturation=enrichment.competing_listings if enrichment else None,
    )


def _build_user_message(
    term_text: str, niche: str | None, risk_tier: str, evidence: SourceEvidence, preset: dict[str, Any]
) -> str:
    return json.dumps(
        {
            "term": term_text,
            "niche": niche or "unknown",
            "risk_tier": risk_tier,
            "evidence": evidence.model_dump(),
            "product_type": preset["type"],
            "seasonality": None,
        },
        ensure_ascii=False,
    )


@dataclass(frozen=True)
class BriefCallResult:
    brief: DesignBrief | None
    last_error: str


async def _call_llm_for_brief(
    user_message: str, http_client: httpx.AsyncClient
) -> BriefCallResult:
    settings = get_settings()
    last_error = ""
    for attempt in range(ANTHROPIC_MAX_RETRIES + 1):
        try:
            response = await http_client.post(
                ANTHROPIC_MESSAGES_URL,
                headers={
                    "x-api-key": settings.anthropic_api_key or "",
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": ANTHROPIC_MODEL,
                    "max_tokens": 2000,
                    "system": BRIEF_SYSTEM_PROMPT,
                    "messages": [{"role": "user", "content": user_message}],
                },
            )
            response.raise_for_status()
            body = response.json()
            text = body["content"][0]["text"]
            parsed = DesignBrief.model_validate_json(text)
            return BriefCallResult(brief=parsed, last_error="")
        except (httpx.HTTPError, ValidationError, KeyError, IndexError, ValueError) as exc:
            last_error = str(exc)
            log.warning("brief.llm_attempt_failed", attempt=attempt, error=last_error)
    return BriefCallResult(brief=None, last_error=last_error)


async def generate_brief(
    session: AsyncSession,
    candidate: Candidate,
    *,
    product_preset: str = DEFAULT_PRODUCT_PRESET,
    http_client: httpx.AsyncClient | None = None,
) -> DesignBriefRow:
    """Sinh + validate + render + ghi 1 dòng design_briefs. Raise BriefBlockedError
    nếu risk_level=blocked, BriefLLMFailedError nếu LLM fail 2 lần (candidate.status
    ='llm_failed', đúng CLAUDE.md rule 10)."""
    if candidate.risk_level == "blocked":
        raise BriefBlockedError(
            f"candidate {candidate.id} risk_level=blocked, không sinh brief (fail-closed)"
        )
    if product_preset not in PRODUCT_PRESETS:
        raise ValueError(f"product_preset không hợp lệ: {product_preset!r}")

    term = await session.get(Term, candidate.term_id)
    if term is None:
        raise ValueError(f"không có term cho candidate id={candidate.id}")

    settings = get_settings()
    if not settings.anthropic_api_key:
        candidate.status = "llm_failed"
        raise BriefLLMFailedError("ANTHROPIC_API_KEY chưa cấu hình")

    risk_tier = await determine_risk_tier(session, term.id)
    evidence = await gather_evidence(session, term.id)
    preset = PRODUCT_PRESETS[product_preset]
    user_message = _build_user_message(term.text_display, term.niche, risk_tier, evidence, preset)

    owns_client = http_client is None
    client = http_client or httpx.AsyncClient(timeout=60.0)
    try:
        result = await _call_llm_for_brief(user_message, client)
    finally:
        if owns_client:
            await client.aclose()

    if result.brief is None:
        candidate.status = "llm_failed"
        raise BriefLLMFailedError(f"llm_failed: {result.last_error}")

    brief = result.brief
    rendered = render(brief)
    if rendered is not None:
        brief.constraints = list(rendered.constraints)

    row = DesignBriefRow(
        candidate_id=candidate.id,
        payload=brief.model_dump(mode="json"),
        image_prompt=rendered.prompt if rendered else None,
    )
    session.add(row)
    await session.flush()
    log.info("brief.generated", candidate_id=candidate.id, typography_only=rendered is None)
    return row


async def export_brief(session: AsyncSession, candidate: Candidate, risk_tier: str) -> dict[str, Any]:
    """Đánh dấu `exported_at`, trả payload đầy đủ (kèm image_prompt) cho người vận
    hành copy sang pipeline sinh ảnh. Kiểm tra fail-closed ĐỘC LẬP với approve_candidate
    (risk.py) -- không tin một điểm chặn duy nhất."""
    if not is_eligible_for_export(candidate, risk_tier):
        raise BriefExportBlockedError(
            f"candidate {candidate.id} chưa đủ điều kiện export "
            f"(risk_level={candidate.risk_level}, status={candidate.status}, "
            f"approved_by={candidate.approved_by!r})"
        )
    row = (
        await session.execute(
            select(DesignBriefRow)
            .where(DesignBriefRow.candidate_id == candidate.id)
            .order_by(DesignBriefRow.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        raise BriefExportBlockedError(f"chưa có design_brief nào cho candidate id={candidate.id}")

    row.exported_at = datetime.now(UTC)
    await session.flush()
    return {**row.payload, "image_prompt": row.image_prompt, "brief_row_id": row.id}
