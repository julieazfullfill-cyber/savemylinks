"""Bước collect: chạy adapter, ghi `raw_items` + `term_observations`.

Đây là chỗ duy nhất được ghi DB cho dữ liệu nguồn. Adapter chỉ fetch và parse.
"""

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy import update as sa_update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.adapters import get_adapter_class
from scanner.adapters.base import Observation, RawItem, SourceAdapter
from scanner.core.log import get_logger
from scanner.core.models import Seed, Source, Term, TermObservation
from scanner.core.models import RawItem as RawItemRow
from scanner.core.normalize import clean_display, normalize
from scanner.core.db import session_scope
from scanner.core.seeds import CORE_NICHES

log = get_logger(__name__)


@dataclass
class CollectStats:
    source: str
    seeds: int = 0
    fetched: int = 0
    duplicates: int = 0
    observations: int = 0
    new_terms: int = 0
    failures: int = 0
    stopped_early: bool = False

    def as_dict(self) -> dict[str, int | str | bool]:
        return {
            "source": self.source,
            "seeds": self.seeds,
            "fetched": self.fetched,
            "duplicates": self.duplicates,
            "observations": self.observations,
            "new_terms": self.new_terms,
            "failures": self.failures,
            "stopped_early": self.stopped_early,
        }


@dataclass
class TermResolver:
    """Giải quyết term theo text_norm, fallback text_key để gộp bản đảo trật tự từ."""

    session: AsyncSession
    stats: CollectStats
    _by_norm: dict[str, int] = field(default_factory=dict)
    _by_key: dict[str, int] = field(default_factory=dict)

    async def resolve(self, text: str, rank: int | None, niche: str | None) -> int:
        text_norm, text_key = normalize(text)
        if not text_norm:
            raise ValueError("term rỗng sau khi chuẩn hoá")

        cached = self._by_norm.get(text_norm)
        if cached is not None:
            await self._maybe_update_display(cached, text, rank)
            return cached

        row = (
            await self.session.execute(
                select(Term.id, Term.text_display, Term.display_rank).where(
                    Term.text_norm == text_norm
                )
            )
        ).first()
        if row is None:
            # text_key trùng nghĩa là cùng một thứ, ví dụ "gift for bridesmaid" và
            # "bridesmaid gift" -> gộp về term đã tồn tại thay vì tạo term mới.
            row = (
                await self.session.execute(
                    select(Term.id, Term.text_display, Term.display_rank)
                    .where(Term.text_key == text_key)
                    .order_by(Term.first_seen_at)
                    .limit(1)
                )
            ).first()

        if row is not None:
            term_id = int(row.id)
            self._by_norm[text_norm] = term_id
            self._by_key.setdefault(text_key, term_id)
            await self._maybe_update_display(term_id, text, rank, row.display_rank)
            return term_id

        term_id = await self._insert(text, text_norm, text_key, rank, niche)
        self._by_norm[text_norm] = term_id
        self._by_key.setdefault(text_key, term_id)
        return term_id

    async def _insert(
        self, text: str, text_norm: str, text_key: str, rank: int | None, niche: str | None
    ) -> int:
        stmt = (
            pg_insert(Term)
            .values(
                text_norm=text_norm,
                text_key=text_key,
                text_display=clean_display(text),
                display_rank=rank,
                kind="keyword",
                niche=niche,
            )
            .on_conflict_do_nothing(index_elements=[Term.text_norm])
            .returning(Term.id)
        )
        new_id = await self.session.scalar(stmt)
        if new_id is not None:
            self.stats.new_terms += 1
            return int(new_id)
        existing = await self.session.scalar(select(Term.id).where(Term.text_norm == text_norm))
        if existing is None:  # pragma: no cover - chỉ xảy ra nếu term bị xoá giữa chừng
            raise RuntimeError(f"không giải quyết được term '{text_norm}'")
        return int(existing)

    async def _maybe_update_display(
        self, term_id: int, text: str, rank: int | None, current_rank: int | None = None
    ) -> None:
        """Giữ text_display của bản có rank tốt nhất từng thấy."""
        if rank is None:
            return
        if current_rank is None:
            current_rank = await self.session.scalar(
                select(Term.display_rank).where(Term.id == term_id)
            )
        if current_rank is not None and current_rank <= rank:
            return
        await self.session.execute(
            sa_update(Term)
            .where(Term.id == term_id)
            .values(text_display=clean_display(text), display_rank=rank)
        )


async def ensure_source(session: AsyncSession, adapter: SourceAdapter) -> Source:
    """Một dòng trong `sources` cho mỗi adapter. Giữ nguyên config nếu người dùng đã sửa."""
    row = adapter.source_row()
    stmt = (
        pg_insert(Source)
        .values(name=row["name"], kind=row["kind"], config=row["config"])
        .on_conflict_do_nothing(index_elements=[Source.name])
    )
    await session.execute(stmt)
    source = await session.scalar(select(Source).where(Source.name == row["name"]))
    assert source is not None
    return source


async def load_seeds(
    session: AsyncSession,
    niches: list[str] | None = None,
    risk_tiers: list[str] | None = None,
    limit: int | None = None,
) -> list[Seed]:
    stmt = select(Seed).where(Seed.enabled.is_(True))
    if niches:
        stmt = stmt.where(Seed.niche.in_(niches))
    if risk_tiers:
        stmt = stmt.where(Seed.risk_tier.in_(risk_tiers))
    stmt = stmt.order_by(Seed.niche, Seed.id)
    if limit:
        stmt = stmt.limit(limit)
    return list((await session.scalars(stmt)).all())


async def _store_raw(
    session: AsyncSession, source_id: int, raw: RawItem
) -> int | None:
    """INSERT-only. Trả None nếu raw item này đã có (chạy lại trong cùng ngày)."""
    stmt = (
        pg_insert(RawItemRow)
        .values(
            source_id=source_id,
            external_id=raw.external_id,
            payload=raw.payload,
            fetched_at=raw.fetched_at,
        )
        .on_conflict_do_nothing(index_elements=[RawItemRow.source_id, RawItemRow.external_id])
        .returning(RawItemRow.id)
    )
    raw_id = await session.scalar(stmt)
    return int(raw_id) if raw_id is not None else None


async def _store_observations(
    session: AsyncSession,
    resolver: TermResolver,
    observations: list[Observation],
    *,
    source_id: int,
    seed: Seed | None,
    raw_item_id: int,
) -> int:
    """`seed=None` cho nguồn per_seed=False (snapshot theo quốc gia, không gắn seed cụ thể)."""
    niche = seed.niche if seed is not None else None
    seed_id = seed.id if seed is not None else None
    stored = 0
    for obs in observations:
        try:
            term_id = await resolver.resolve(obs.text, obs.rank, niche)
        except ValueError:
            continue
        session.add(
            TermObservation(
                term_id=term_id,
                source_id=source_id,
                seed_id=seed_id,
                observed_at=obs.observed_at,
                rank=obs.rank,
                value=obs.value,
                raw_item_id=raw_item_id,
            )
        )
        stored += 1
    return stored


async def _collect_once(
    adapter: SourceAdapter, stats: CollectStats, source_id: int, source_name: str
) -> CollectStats:
    """Nguồn per_seed=False: gọi fetch() đúng 1 lần, không lặp qua seed.

    Dùng cho snapshot theo quốc gia (ví dụ pinterest_trends) — gọi 150 lần/ngày
    (một lần mỗi seed) sẽ mở 150 phiên trình duyệt thật cho cùng một dữ liệu,
    vừa chậm vừa vô nghĩa vì dữ liệu không phụ thuộc seed nào cả.
    """
    log.info("collect.start", source=source_name, mode="per_country")
    try:
        raws = await adapter.fetch_safe("")
        if not raws:
            stats.failures += 1
        else:
            stats.seeds = 1
            async with session_scope() as session:
                resolver = TermResolver(session=session, stats=stats)
                for raw in raws:
                    raw_id = await _store_raw(session, source_id, raw)
                    if raw_id is None:
                        stats.duplicates += 1
                        log.debug("collect.raw_duplicate", source=source_name)
                        continue
                    stats.fetched += 1
                    observations = adapter.extract_safe(raw)
                    stats.observations += await _store_observations(
                        session,
                        resolver,
                        observations,
                        source_id=source_id,
                        seed=None,
                        raw_item_id=raw_id,
                    )
    finally:
        await adapter.aclose()
    log.info("collect.done", **stats.as_dict())
    return stats


async def collect_source(
    source_name: str,
    *,
    niches: list[str] | None = None,
    risk_tiers: list[str] | None = None,
    limit: int | None = None,
) -> CollectStats:
    """Chạy một nguồn.

    Nguồn per_seed=True (mặc định, mọi adapter autocomplete): lặp qua toàn bộ seed
    đang bật. `niches=None` là mặc định ba niche core; `niches=[]` là không lọc niche.

    Nguồn per_seed=False (snapshot theo quốc gia): gọi fetch() đúng 1 lần, bỏ qua
    niches/risk_tiers/limit — dữ liệu không phụ thuộc seed nào.
    """
    adapter_cls = get_adapter_class(source_name)
    stats = CollectStats(source=source_name)
    selected_niches = list(CORE_NICHES) if niches is None else niches

    async with session_scope() as session:
        adapter = adapter_cls(config=None)
        source = await ensure_source(session, adapter)
        if not source.enabled:
            log.warning("collect.source_disabled", source=source_name)
            return stats
        adapter = adapter_cls(config=source.config)
        source_id = source.id
        seeds = (
            await load_seeds(session, selected_niches, risk_tiers, limit)
            if adapter_cls.per_seed
            else []
        )

    if not adapter_cls.per_seed:
        return await _collect_once(adapter, stats, source_id, source_name)

    max_requests = int(adapter.config.get("max_requests_per_run", 0) or 0)
    log.info(
        "collect.start",
        source=source_name,
        seeds=len(seeds),
        niches=selected_niches,
        max_requests=max_requests or None,
    )

    try:
        for index, seed in enumerate(seeds):
            if max_requests and index >= max_requests:
                stats.stopped_early = True
                log.warning(
                    "collect.request_cap_reached", source=source_name, max_requests=max_requests
                )
                break

            raws = await adapter.fetch_safe(seed.seed)
            if not raws:
                stats.failures += 1
                continue
            stats.seeds += 1

            async with session_scope() as session:
                resolver = TermResolver(session=session, stats=stats)
                seed_row = await session.get(Seed, seed.id)
                assert seed_row is not None
                for raw in raws:
                    raw_id = await _store_raw(session, source_id, raw)
                    if raw_id is None:
                        stats.duplicates += 1
                        log.debug(
                            "collect.raw_duplicate", source=source_name, seed=seed.seed
                        )
                        continue
                    stats.fetched += 1
                    observations = adapter.extract_safe(raw)
                    stats.observations += await _store_observations(
                        session,
                        resolver,
                        observations,
                        source_id=source_id,
                        seed=seed_row,
                        raw_item_id=raw_id,
                    )
    finally:
        await adapter.aclose()

    log.info("collect.done", **stats.as_dict())
    return stats
