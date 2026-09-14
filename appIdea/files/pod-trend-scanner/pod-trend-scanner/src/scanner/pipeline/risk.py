"""Risk gate — docs/RISK_POLICY.md. Bốn lớp, fail-closed:

    Term chỉ đi tiếp khi ĐỦ các lớp bắt buộc theo risk_tier đều có verdict "pass" rõ
    ràng. Lớp không chạy được (API down, thiếu key, timeout) trả "review", KHÔNG BAO
    GIỜ "pass". Code luôn viết dạng `if verdict != "pass": chặn`, không viết
    `if verdict == "block": chặn` — thiếu key/API lỗi phải rơi vào nhánh chặn.

Bốn lớp (chi tiết xem RISK_POLICY.md):
    1. Blocklist regex — data/blocklist.yaml, rẻ/nhanh, không cần mạng.
    2. USPTO — tra local index (bảng `uspto_trademarks`), KHÔNG gọi live API. Live API
       (api.uspto.gov) và cả trang browse bulk data (data.uspto.gov) đòi tài khoản
       USPTO.gov + MFA kể từ 2026-06-18 (xác nhận thật qua Playwright, không phải
       đoán). Thay vào đó nạp bulk data XML chính thức ("Trademark Full Text XML
       Data") bằng `pipeline/uspto_index.py` rồi tra local. Xem chi tiết fail-closed
       khi index chưa đủ phủ ở docstring `check_uspto` bên dưới.
    3. LLM phân loại nguồn gốc — gọi thẳng Anthropic Messages API qua httpx (không
       thêm SDK mới, rule "hỏi trước khi thêm dependency"). Không có ANTHROPIC_API_KEY
       trong phiên build này -> luôn "review", đúng fail-closed.
    4. Người duyệt — không có check tự động; `approve_candidate()` enforce cứng T2/T3
       không được approved_by rỗng, `is_eligible_for_export()` kiểm tra lại lần nữa
       (belt-and-suspenders, không tin một điểm chặn duy nhất).

**Cache USPTO:** RISK_POLICY.md nói "cache 30 ngày trong term_enrichment", nhưng bảng
`term_enrichment` (DATA_MODEL.md, không đổi từ Phase 0) không có cột nào cho USPTO —
chỉ có competing_listings/saturation_score/commercial_signal cho enrich.py. Dùng
`risk_flags` làm cache thay thế: tìm risk_flags layer='uspto' gần nhất trong 30 ngày,
có thì dùng lại, không gọi API lần nữa. `risk_flags` vốn đã đúng mục đích này (evidence
theo từng lớp, theo thời gian) nên không cần đổi schema.

**risk_tier của một term:** term không có cột risk_tier riêng — suy từ MAX(risk_tier)
của mọi seed đã sinh ra observation cho term đó (chuỗi 'T0'..'T3' so sánh string đúng
thứ tự). Term không gắn seed nào (từ pinterest_trends, etsy_csv_import, …) thì
KHÔNG suy đoán về phía lỏng — mặc định T2 (yêu cầu đủ 4 lớp + người duyệt), đúng
fail-closed: không biết nguồn gốc thì coi như rủi ro cao.
"""

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

import httpx
import yaml
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.config import get_settings
from scanner.core.log import get_logger
from scanner.core.models import (
    Candidate,
    RiskFlag,
    Seed,
    Term,
    TermObservation,
    UsptoTrademark,
)
from scanner.core.normalize import normalize

log = get_logger(__name__)

Verdict = Literal["pass", "review", "block"]

BLOCKLIST_PATH = Path("data/blocklist.yaml")
PHRASE_CATEGORIES = ("franchises", "music", "people", "sports", "registered_marks")
PATTERN_CATEGORY = "political"

USPTO_CACHE_DAYS = 30
USPTO_TRADEMARK_CLASSES = ("021", "020", "025")  # mug/đồ gỗ (20/21), may mặc (25)

ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = "claude-sonnet-5"
ANTHROPIC_MAX_RETRIES = 1  # rule 10: retry đúng 1 lần, fail lần hai -> llm_failed

# Layer bắt buộc theo tier — đúng bảng trong RISK_POLICY.md.
REQUIRED_LAYERS: dict[str, tuple[int, ...]] = {
    "T0": (1,),
    "T1": (1, 2),
    "T2": (1, 2, 3, 4),
    "T3": (1, 2, 3, 4),
}
AUTO_APPROVE_TIERS = ("T0", "T1")
DEFAULT_TIER_WHEN_UNKNOWN = "T2"

_PROPER_NOUN_RE = re.compile(r"(?<!^)(?<!\. )\b[A-Z][a-z]+\b")


# ---------------------------------------------------------------------------
# Lớp 1 — blocklist
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BlocklistMatch:
    category: str
    matched: str


@dataclass(frozen=True)
class BlocklistResult:
    verdict: Verdict  # chỉ "pass" hoặc "block" — lớp 1 không có "review"
    matches: tuple[BlocklistMatch, ...] = ()


@dataclass(frozen=True)
class CompiledBlocklist:
    phrase_patterns: tuple[tuple[str, re.Pattern[str]], ...]
    political_patterns: tuple[re.Pattern[str], ...]


def load_blocklist(path: str | Path = BLOCKLIST_PATH) -> CompiledBlocklist:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    phrase_patterns: list[tuple[str, re.Pattern[str]]] = []
    for category in PHRASE_CATEGORIES:
        for phrase in raw.get(category) or []:
            norm, _ = normalize(str(phrase))
            if not norm:
                continue
            phrase_patterns.append(
                (category, re.compile(r"\b" + re.escape(norm) + r"\b"))
            )
    political_patterns = tuple(
        re.compile(str(p), re.IGNORECASE) for p in (raw.get(PATTERN_CATEGORY) or [])
    )
    return CompiledBlocklist(tuple(phrase_patterns), political_patterns)


def check_blocklist(text: str, blocklist: CompiledBlocklist) -> BlocklistResult:
    """Chạy trên `term` VÀ trên headline LLM sinh ra (rule: LLM có thể tự đưa cụm dính
    bản quyền mà term gốc không có) — nhận `text` bất kỳ, không riêng gì term."""
    norm, _ = normalize(text)
    matches = [
        BlocklistMatch(category=category, matched=pattern.pattern)
        for category, pattern in blocklist.phrase_patterns
        if pattern.search(norm)
    ]
    matches += [
        BlocklistMatch(category=PATTERN_CATEGORY, matched=pattern.pattern)
        for pattern in blocklist.political_patterns
        if pattern.search(text)
    ]
    return BlocklistResult(verdict="block" if matches else "pass", matches=tuple(matches))


def has_probable_proper_noun(text_display: str) -> bool:
    """Heuristic cho "T0 auto-approve nếu không có danh từ riêng": có từ viết hoa
    không phải đầu câu -> coi là có khả năng chứa danh từ riêng, không phải blocklist
    match (đó là việc của lớp 1) mà là tín hiệu bổ sung để KHÔNG auto-approve."""
    return bool(_PROPER_NOUN_RE.search(text_display))


# ---------------------------------------------------------------------------
# Lớp 2 — USPTO
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class USPTOResult:
    verdict: Verdict
    evidence: dict[str, Any] = field(default_factory=dict)


async def _uspto_from_cache(session: AsyncSession, term_id: int) -> USPTOResult | None:
    cutoff = datetime.now(UTC) - timedelta(days=USPTO_CACHE_DAYS)
    row = (
        await session.execute(
            select(RiskFlag)
            .where(
                RiskFlag.term_id == term_id,
                RiskFlag.layer == "uspto",
                RiskFlag.created_at >= cutoff,
            )
            .order_by(RiskFlag.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    severity_to_verdict: dict[str, Verdict] = {"info": "pass", "review": "review", "block": "block"}
    verdict = severity_to_verdict.get(row.severity)
    if verdict is None:
        return None
    return USPTOResult(verdict=verdict, evidence={**row.evidence, "from_cache": True})


def _matches_relevant_class(row: UsptoTrademark) -> bool:
    classes = set(row.us_classes) | set(row.intl_classes)
    return any(c in USPTO_TRADEMARK_CLASSES for c in classes)


async def _lookup_local_index(session: AsyncSession, term_norm: str) -> list[UsptoTrademark]:
    """Tra "exact phrase và bản đã chuẩn hoá" (RISK_POLICY.md Lớp 2) trên bảng local
    `uspto_trademarks`: match `mark_norm` (đã qua cùng hàm normalize() với term) —
    tương đương so cả hai theo cùng chuẩn hoá vì mark_norm gốc cũng đi qua normalize()
    khi nạp (pipeline/uspto_index.py)."""
    rows = (
        await session.execute(select(UsptoTrademark).where(UsptoTrademark.mark_norm == term_norm))
    ).scalars().all()
    return [r for r in rows if _matches_relevant_class(r)]


async def check_uspto(session: AsyncSession, term_id: int, term_text: str) -> USPTOResult:
    """Tra local index thay live API (xem docstring module + pipeline/uspto_index.py).

    Fail-closed khi KHÔNG tìm thấy match: "không tìm thấy" chỉ đáng tin là "DEAD/NONE"
    (-> pass) khi index đã nạp ĐỦ toàn bộ bulk data
    (`settings.uspto_index_coverage_complete=True`, operator tự xác nhận thủ công).
    Chưa xác nhận đủ phủ -> "không tìm thấy" vẫn là "review", vì absence of evidence
    trong một index CHƯA ĐẦY ĐỦ không phải evidence of absence.
    """
    cached = await _uspto_from_cache(session, term_id)
    if cached is not None:
        return cached

    norm, _ = normalize(term_text)
    try:
        matches = await _lookup_local_index(session, norm)
    except Exception as exc:  # noqa: BLE001 - lỗi DB PHẢI rơi vào review, không raise
        log.warning("risk.uspto_local_lookup_failed", term=term_text, error=str(exc))
        return USPTOResult(verdict="review", evidence={"reason": str(exc)})

    live = [m for m in matches if m.status_category == "live"]
    if live:
        return USPTOResult(
            verdict="block",
            evidence={
                "status": "LIVE",
                "matches": [
                    {
                        "serial_number": m.serial_number,
                        "mark_identification": m.mark_identification,
                        "status_code": m.status_code,
                    }
                    for m in live[:5]
                ],
            },
        )

    unknown = [m for m in matches if m.status_category == "unknown"]
    if unknown:
        return USPTOResult(
            verdict="review",
            evidence={
                "reason": "status_code không rõ LIVE/DEAD",
                "matches": [
                    {"serial_number": m.serial_number, "status_code": m.status_code}
                    for m in unknown[:5]
                ],
            },
        )

    if matches:  # còn lại toàn bộ đều "dead"
        return USPTOResult(
            verdict="pass",
            evidence={
                "status": "DEAD",
                "matches": [
                    {"serial_number": m.serial_number, "status_code": m.status_code}
                    for m in matches[:5]
                ],
            },
        )

    settings = get_settings()
    if settings.uspto_index_coverage_complete:
        return USPTOResult(verdict="pass", evidence={"status": "NONE"})
    return USPTOResult(
        verdict="review",
        evidence={"reason": "không tìm thấy trong local index, nhưng index chưa xác nhận phủ đủ"},
    )


# ---------------------------------------------------------------------------
# Lớp 3 — LLM phân loại nguồn gốc
# ---------------------------------------------------------------------------

Origin = Literal["generic", "derived_from_media", "proper_noun", "unknown"]

ORIGIN_SYSTEM_PROMPT = """Bạn phân loại NGUỒN GỐC của một cụm từ khoá thương mại ngắn
(dùng để in lên sản phẩm print-on-demand). Câu hỏi duy nhất: cụm này xuất phát từ phim,
nhạc, người thật, thương hiệu cụ thể, hay là ngôn ngữ chung (generic)?

Trả lời CHỈ "generic" khi chắc chắn tuyệt đối đây là ngôn ngữ chung, không thể liên hệ
tới một tác phẩm/người/thương hiệu cụ thể nào. Nếu có bất kỳ nghi ngờ nào, hoặc không
chắc chắn, chọn "unknown" — LUÔN nghiêng về báo động nhầm hơn là bỏ sót một rủi ro
thật. Đây không phải kết luận pháp lý, chỉ là bộ lọc sơ bộ trước khi người duyệt xem.

Trả lời bằng đúng JSON, không thêm chữ nào khác:
{"origin": "generic" | "derived_from_media" | "proper_noun" | "unknown", "reasoning": "..."}
"""


class OriginClassification(BaseModel):
    origin: Origin
    reasoning: str = Field(max_length=500)


@dataclass(frozen=True)
class OriginResult:
    verdict: Verdict
    evidence: dict[str, Any] = field(default_factory=dict)


async def classify_origin(
    term_text: str, client: httpx.AsyncClient | None = None
) -> OriginResult:
    settings = get_settings()
    if not settings.anthropic_api_key:
        return OriginResult(verdict="review", evidence={"reason": "ANTHROPIC_API_KEY chưa cấu hình"})

    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=30.0)
    last_error = ""
    try:
        for attempt in range(ANTHROPIC_MAX_RETRIES + 1):
            try:
                response = await http_client.post(
                    ANTHROPIC_MESSAGES_URL,
                    headers={
                        "x-api-key": settings.anthropic_api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": ANTHROPIC_MODEL,
                        "max_tokens": 300,
                        "system": ORIGIN_SYSTEM_PROMPT,
                        "messages": [{"role": "user", "content": f'Cụm từ: "{term_text}"'}],
                    },
                )
                response.raise_for_status()
                body = response.json()
                text = body["content"][0]["text"]
                parsed = OriginClassification.model_validate_json(text)
                verdict: Verdict = "pass" if parsed.origin == "generic" else "review"
                return OriginResult(
                    verdict=verdict,
                    evidence={"origin": parsed.origin, "reasoning": parsed.reasoning},
                )
            except (httpx.HTTPError, ValidationError, KeyError, IndexError, ValueError) as exc:
                last_error = str(exc)
                log.warning(
                    "risk.llm_origin_attempt_failed",
                    term=term_text,
                    attempt=attempt,
                    error=last_error,
                )
        return OriginResult(verdict="review", evidence={"reason": f"llm_failed: {last_error}"})
    finally:
        if owns_client:
            await http_client.aclose()


# ---------------------------------------------------------------------------
# Lớp 4 — người duyệt (enforcement, không có auto-check)
# ---------------------------------------------------------------------------


class ApprovalRequiredError(Exception):
    """T2/T3 bắt buộc approved_by — không có đường tắt (RISK_POLICY.md Lớp 4)."""


def requires_human_approval(risk_tier: str) -> bool:
    return risk_tier in ("T2", "T3")


async def approve_candidate(
    session: AsyncSession, candidate: Candidate, risk_tier: str, approved_by: str | None
) -> None:
    """Duy nhất một chỗ được set status='approved' — mọi code path khác (kể cả tương
    lai) phải đi qua đây để không thể vô tình bỏ qua yêu cầu approved_by cho T2/T3."""
    if requires_human_approval(risk_tier) and not approved_by:
        raise ApprovalRequiredError(
            f"tier {risk_tier} bắt buộc approved_by, không có đường tắt (RISK_POLICY.md)"
        )
    if candidate.risk_level == "blocked":
        raise ApprovalRequiredError("candidate đã bị blocked, không thể approve")
    candidate.status = "approved"
    candidate.approved_by = approved_by
    candidate.approved_at = datetime.now(UTC)
    # Audit trail — cùng chỗ với 3 lớp tự động, để lịch sử duyệt nằm trọn trong risk_flags.
    session.add(
        RiskFlag(
            term_id=candidate.term_id,
            candidate_id=candidate.id,
            layer="human_approval",
            severity="info",
            evidence={"approved_by": approved_by, "risk_tier": risk_tier},
        )
    )


def is_eligible_for_export(candidate: Candidate, risk_tier: str) -> bool:
    """Kiểm tra lại lần nữa, độc lập với approve_candidate() — không tin một điểm
    chặn duy nhất (fail-closed nhân đôi)."""
    if candidate.status != "approved":
        return False
    if candidate.risk_level == "blocked":
        return False
    if requires_human_approval(risk_tier) and not candidate.approved_by:
        return False
    return True


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


async def determine_risk_tier(session: AsyncSession, term_id: int) -> str:
    """MAX(risk_tier) trong các seed đã sinh observation cho term. Không có seed nào
    -> DEFAULT_TIER_WHEN_UNKNOWN (fail-closed, không suy đoán về phía lỏng)."""
    tier = await session.scalar(
        select(func.max(Seed.risk_tier))
        .select_from(TermObservation)
        .join(Seed, Seed.id == TermObservation.seed_id)
        .where(TermObservation.term_id == term_id)
    )
    return str(tier) if tier else DEFAULT_TIER_WHEN_UNKNOWN


@dataclass
class RiskGateResult:
    term_id: int
    risk_tier: str
    risk_level: str  # 'low' | 'review' | 'blocked'
    layers_run: tuple[int, ...]


async def _write_flag(
    session: AsyncSession, term_id: int, layer: str, verdict: Verdict, evidence: dict[str, Any]
) -> None:
    severity = {"pass": "info", "review": "review", "block": "block"}[verdict]
    session.add(
        RiskFlag(term_id=term_id, layer=layer, severity=severity, evidence=evidence)
    )


async def run_risk_gate(
    session: AsyncSession,
    term_id: int,
    *,
    blocklist: CompiledBlocklist | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> RiskGateResult:
    """Chạy đủ các lớp bắt buộc theo risk_tier của term, ghi risk_flags, trả risk_level
    tổng hợp. KHÔNG tự set candidates.status — việc đó là của approve_candidate()."""
    term = await session.get(Term, term_id)
    if term is None:
        raise ValueError(f"không có term id={term_id}")

    risk_tier = await determine_risk_tier(session, term_id)
    required = REQUIRED_LAYERS[risk_tier]
    blocklist = blocklist or load_blocklist()

    verdicts: list[Verdict] = []
    layers_run: list[int] = []

    if 1 in required:
        result1 = check_blocklist(term.text_display, blocklist)
        await _write_flag(
            session,
            term_id,
            "blocklist",
            result1.verdict,
            {"matches": [{"category": m.category, "matched": m.matched} for m in result1.matches]},
        )
        verdicts.append(result1.verdict)
        layers_run.append(1)
        if risk_tier == "T0" and result1.verdict == "pass" and has_probable_proper_noun(
            term.text_display
        ):
            verdicts.append("review")  # T0 chỉ auto-approve nếu KHÔNG có danh từ riêng

    if 2 in required:
        result2 = await check_uspto(session, term_id, term.text_norm)
        await _write_flag(session, term_id, "uspto", result2.verdict, result2.evidence)
        verdicts.append(result2.verdict)
        layers_run.append(2)

    if 3 in required:
        result3 = await classify_origin(term.text_norm, http_client)
        await _write_flag(session, term_id, "llm_origin", result3.verdict, result3.evidence)
        verdicts.append(result3.verdict)
        layers_run.append(3)

    if 4 in required:
        # Không có check tự động — chỉ đánh dấu là cần người duyệt, trừ khi đã bị
        # block ở lớp trên (không cần hỏi người duyệt một thứ chắc chắn bị chặn).
        layers_run.append(4)
        if "block" not in verdicts:
            verdicts.append("review")

    if "block" in verdicts:
        risk_level = "blocked"
    elif any(v != "pass" for v in verdicts):
        risk_level = "review"
    else:
        risk_level = "low"

    return RiskGateResult(
        term_id=term_id, risk_tier=risk_tier, risk_level=risk_level, layers_run=tuple(layers_run)
    )


async def run_risk_gate_for_candidate(
    session: AsyncSession,
    candidate: Candidate,
    *,
    blocklist: CompiledBlocklist | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> RiskGateResult:
    """Chạy risk gate cho một candidate, cập nhật candidates.risk_level."""
    result = await run_risk_gate(
        session, candidate.term_id, blocklist=blocklist, http_client=http_client
    )
    candidate.risk_level = result.risk_level
    return result


@dataclass
class RiskGateBatchStats:
    checked: int = 0
    blocked: int = 0
    review: int = 0
    low: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "checked": self.checked,
            "blocked": self.blocked,
            "review": self.review,
            "low": self.low,
        }


async def run_risk_gate_for_pending_candidates(
    session: AsyncSession, limit: int = 100
) -> RiskGateBatchStats:
    """Chạy risk gate cho candidate `status='pending'` chưa có risk_level (mới được
    pipeline/score.py tạo). Không re-check candidate đã có risk_level != 'unknown' —
    tránh gọi lại USPTO/LLM tốn phí mỗi lần chạy; muốn chạy lại thì gọi run_risk_gate
    trực tiếp cho từng term."""
    stats = RiskGateBatchStats()
    rows = (
        await session.scalars(
            select(Candidate)
            .where(Candidate.status == "pending", Candidate.risk_level == "unknown")
            .limit(limit)
        )
    ).all()
    if not rows:
        return stats

    blocklist = load_blocklist()
    http_client = httpx.AsyncClient(timeout=30.0)
    try:
        for candidate in rows:
            result = await run_risk_gate_for_candidate(
                session, candidate, blocklist=blocklist, http_client=http_client
            )
            stats.checked += 1
            if result.risk_level == "blocked":
                stats.blocked += 1
            elif result.risk_level == "review":
                stats.review += 1
            else:
                stats.low += 1
    finally:
        await http_client.aclose()

    log.info("risk.batch_done", **stats.as_dict())
    return stats
