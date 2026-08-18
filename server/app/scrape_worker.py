"""In-process worker pool that runs the automated Etsy scrape.

Admin controls how many real Chrome windows run at once (1-5, see the
ScraperSettings row) and which proxy (if any) each "window slot" uses --
see routers/admin.py's /settings endpoint. This module owns the pool:
routers enqueue a shop_id, a worker thread eventually picks it up, scrapes
with its slot's current proxy, and saves the result.

A queue + a resizable set of worker threads (not asyncio, not
BackgroundTasks) because scrape_shop_stealth is a blocking, synchronous
call that drives a real Chrome window -- there's no async win here, and
this is the only place in the app that needs to cap how many of those run
at once. `configure()` can be called again at any time (admin changes the
setting) to grow the pool (spawn more workers) or shrink it (signal extra
workers to stop after their current job finishes).
"""

import queue
import threading
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from . import models
from .database import SessionLocal
from .scraper import ScrapeBlockedError, ScrapedShop, scrape_shop_stealth

_WEEK = timedelta(days=7)
_MONTH = timedelta(days=30)


def _closest_snapshot_before(db: Session, shop_id: int, cutoff: datetime) -> "models.ShopMetricSnapshot | None":
    return (
        db.query(models.ShopMetricSnapshot)
        .filter(models.ShopMetricSnapshot.shop_id == shop_id, models.ShopMetricSnapshot.recorded_at <= cutoff)
        .order_by(models.ShopMetricSnapshot.recorded_at.desc())
        .first()
    )


def _diff_from_snapshot(
    shop: models.Shop, snapshot: "models.ShopMetricSnapshot | None"
) -> tuple[int | None, int | None]:
    if snapshot is None:
        return None, None
    sales = (
        shop.total_sales - snapshot.total_sales
        if shop.total_sales is not None and snapshot.total_sales is not None
        else None
    )
    reviews = (
        shop.total_reviews - snapshot.total_reviews
        if shop.total_reviews is not None and snapshot.total_reviews is not None
        else None
    )
    return sales, reviews


def save_scraped_data(
    db: Session, shop: models.Shop, scraped: ScrapedShop, replace_all: bool = False
) -> models.Shop:
    """Merges freshly scraped/imported data onto an existing Shop row and
    marks it done. Listings are upserted by etsy_listing_id so a shop with
    multiple pages can be filled in one manual paste per page without later
    pastes wiping earlier ones.

    replace_all=True additionally deletes listings that were NOT part of
    this batch -- appropriate for an automated scrape that walked every page
    in one go (a full snapshot), but wrong for a single manual page paste
    (which only ever represents a slice of the shop). When replace_all=True,
    also records which listings were newly added/removed, and how much
    total_sales/total_reviews grew, compared to the snapshot before this
    call -- onto shop.last_added_listings/last_removed_listings and
    shop.sales_delta/reviews_delta, for the user-facing change report.
    All of that is skipped on the shop's very first scrape (nothing to
    diff against yet).

    Also appends a ShopMetricSnapshot row and recomputes
    sales_delta_week/month + reviews_delta_week/month against the closest
    snapshot from ~7/~30 days ago -- independent of is_first_scrape, since
    that comparison is naturally None until a snapshot that old exists.
    """
    is_first_scrape = shop.scraped_at is None
    previous_total_sales = shop.total_sales
    previous_total_reviews = shop.total_reviews

    if scraped.shop_name:
        shop.shop_name = scraped.shop_name
    if scraped.location:
        shop.location = scraped.location
    if scraped.total_listings is not None:
        shop.total_listings = scraped.total_listings
    if scraped.total_reviews is not None:
        shop.total_reviews = scraped.total_reviews
    if scraped.total_sales is not None:
        shop.total_sales = scraped.total_sales
    if scraped.rating is not None:
        shop.rating = scraped.rating
    if scraped.shop_tenure:
        shop.shop_tenure = scraped.shop_tenure
    shop.status = models.ShopStatus.done
    shop.error_message = None
    shop.is_available = True
    shop.unavailable_reason = None
    shop.scraped_at = datetime.utcnow()

    if replace_all and not is_first_scrape:
        shop.sales_delta = (
            shop.total_sales - previous_total_sales
            if shop.total_sales is not None and previous_total_sales is not None
            else None
        )
        shop.reviews_delta = (
            shop.total_reviews - previous_total_reviews
            if shop.total_reviews is not None and previous_total_reviews is not None
            else None
        )
    elif replace_all:
        shop.sales_delta = None
        shop.reviews_delta = None

    if replace_all:
        now = shop.scraped_at
        week_snap = _closest_snapshot_before(db, shop.id, now - _WEEK)
        month_snap = _closest_snapshot_before(db, shop.id, now - _MONTH)
        shop.sales_delta_week, shop.reviews_delta_week = _diff_from_snapshot(shop, week_snap)
        shop.sales_delta_month, shop.reviews_delta_month = _diff_from_snapshot(shop, month_snap)
        db.add(
            models.ShopMetricSnapshot(
                shop_id=shop.id,
                recorded_at=now,
                total_sales=shop.total_sales,
                total_reviews=shop.total_reviews,
            )
        )

    existing_by_id = {
        listing.etsy_listing_id: listing
        for listing in db.query(models.Listing).filter(models.Listing.shop_id == shop.id).all()
        if listing.etsy_listing_id
    }

    def _summary(listing_id: str, title, image_url, url) -> dict:
        return {"etsy_listing_id": listing_id, "title": title, "image_url": image_url, "url": url}

    seen_ids: set[str] = set()
    kept_ids: set[str] = set()
    added: list[dict] = []
    for item in scraped.listings:
        if item.etsy_listing_id:
            if item.etsy_listing_id in seen_ids:
                continue
            seen_ids.add(item.etsy_listing_id)
            kept_ids.add(item.etsy_listing_id)

        row = existing_by_id.get(item.etsy_listing_id) if item.etsy_listing_id else None
        if row is None:
            row = models.Listing(shop_id=shop.id, etsy_listing_id=item.etsy_listing_id)
            db.add(row)
            if item.etsy_listing_id and not is_first_scrape:
                added.append(_summary(item.etsy_listing_id, item.title, item.image_url, item.url))
        row.title = item.title
        row.url = item.url
        row.image_url = item.image_url
        row.price = item.price
        row.price_value = item.price_value
        row.currency = item.currency
        row.rating = item.rating
        row.num_reviews = item.num_reviews
        row.scraped_at = datetime.utcnow()

    removed: list[dict] = []
    if replace_all:
        stale_ids = [lid for lid in existing_by_id if lid not in kept_ids]
        if stale_ids:
            if not is_first_scrape:
                for lid in stale_ids:
                    stale_row = existing_by_id[lid]
                    removed.append(_summary(lid, stale_row.title, stale_row.image_url, stale_row.url))
            db.query(models.Listing).filter(
                models.Listing.shop_id == shop.id,
                models.Listing.etsy_listing_id.in_(stale_ids),
            ).delete(synchronize_session=False)
        shop.last_added_listings = added
        shop.last_removed_listings = removed

        # Persisted separately from last_added/removed_listings (which get
        # overwritten by the next scrape) so "listings added/removed today"
        # stays correct even if a shop gets scraped more than once today.
        change_time = shop.scraped_at
        for item in added:
            db.add(
                models.ListingChangeLog(
                    shop_id=shop.id,
                    etsy_listing_id=item["etsy_listing_id"],
                    change_type="added",
                    title=item["title"],
                    image_url=item["image_url"],
                    url=item["url"],
                    changed_at=change_time,
                )
            )
        for item in removed:
            db.add(
                models.ListingChangeLog(
                    shop_id=shop.id,
                    etsy_listing_id=item["etsy_listing_id"],
                    change_type="removed",
                    title=item["title"],
                    image_url=item["image_url"],
                    url=item["url"],
                    changed_at=change_time,
                )
            )

    db.commit()
    db.refresh(shop)
    return shop


def _process(shop_id: int, proxy: str | None) -> None:
    """Runs on a worker thread, well after the HTTP request that enqueued
    it has returned. Owns its own DB session since the request-scoped one
    from `get_db` is long gone by the time this executes.
    """
    db = SessionLocal()
    try:
        shop = db.query(models.Shop).filter(models.Shop.id == shop_id).first()
        if shop is None:
            return
        shop.status = models.ShopStatus.scraping
        db.commit()

        try:
            scraped = scrape_shop_stealth(shop.shop_url, proxy=proxy)
        except ScrapeBlockedError as exc:
            shop.status = models.ShopStatus.failed
            shop.error_message = str(exc)
            db.commit()
            return
        except Exception as exc:
            # Browser automation can fail in ways an Etsy-specific 403 check
            # won't catch (crashed browser, network drop, Etsy markup
            # change breaking a selector) -- surface it instead of leaving
            # the shop stuck on "scraping" forever with no way to retry.
            shop.status = models.ShopStatus.failed
            shop.error_message = f"Lỗi khi lấy dữ liệu: {exc}"
            db.commit()
            return

        if scraped.unavailable_reason:
            # Shop loaded fine but is on vacation/closed/gone -- leave its
            # last-known listings alone (it may come back) instead of
            # treating an empty vacation banner as "0 listings now" and
            # wiping everything via save_scraped_data's replace_all logic.
            shop.status = models.ShopStatus.done
            shop.error_message = None
            shop.is_available = False
            shop.unavailable_reason = scraped.unavailable_reason
            shop.last_added_listings = []
            shop.last_removed_listings = []
            shop.sales_delta = None
            shop.reviews_delta = None
            shop.sales_delta_week = None
            shop.reviews_delta_week = None
            shop.sales_delta_month = None
            shop.reviews_delta_month = None
            shop.scraped_at = datetime.utcnow()
            db.commit()
            return

        save_scraped_data(db, shop, scraped, replace_all=True)
    finally:
        db.close()


class _Worker:
    def __init__(self, slot: int, pool: "ScrapeWorkerPool") -> None:
        self.slot = slot
        self.pool = pool
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True, name=f"scrape-worker-{slot}")

    def _run(self) -> None:
        # Polls with a timeout instead of blocking forever on queue.get()
        # so a shrink (configure() with a smaller max_concurrent) is
        # noticed within ~1s of this worker going idle, instead of only
        # after the next job happens to arrive.
        while not self.stop_event.is_set():
            try:
                shop_id = self.pool._queue.get(timeout=1)
            except queue.Empty:
                continue
            try:
                _process(shop_id, self.pool.proxy_for(self.slot))
            finally:
                self.pool._queue.task_done()


class ScrapeWorkerPool:
    def __init__(self) -> None:
        self._queue: "queue.Queue[int]" = queue.Queue()
        self._lock = threading.Lock()
        self._workers: list[_Worker] = []
        self._proxies: list[str | None] = [None]

    def proxy_for(self, slot: int) -> str | None:
        with self._lock:
            return self._proxies[slot] if slot < len(self._proxies) else None

    def configure(self, max_concurrent: int, proxies: list[str | None]) -> None:
        """Grows the pool by starting new worker threads, or shrinks it by
        signalling the excess workers to stop once their current job (if
        any) finishes. Safe to call repeatedly -- e.g. every time admin
        saves the settings form.
        """
        with self._lock:
            self._proxies = list(proxies) or [None]
            current = len(self._workers)
            if max_concurrent > current:
                for slot in range(current, max_concurrent):
                    worker = _Worker(slot, self)
                    self._workers.append(worker)
                    worker.thread.start()
            elif max_concurrent < current:
                for worker in self._workers[max_concurrent:]:
                    worker.stop_event.set()
                self._workers = self._workers[:max_concurrent]

    def enqueue(self, shop_id: int) -> None:
        self._queue.put(shop_id)


pool = ScrapeWorkerPool()
