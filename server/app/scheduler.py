"""Background scheduler for admin-configured periodic re-scrapes.

Runs as a single daemon thread that wakes up once a minute and, depending
on ScheduleSettings.mode:

- 'off': does nothing.
- 'fixed_time': once a day, at the configured "HH:MM" (24h, server-local
  time), re-queues every shop -- a full refresh of everything previously
  added.
- 'auto': whenever nothing is currently in flight (no shop is pending or
  scraping -- i.e. the queue is idle, which also means no freshly-added
  link is being processed right now), re-queues just the single shop with
  the oldest scraped_at, **capped at one scrape per shop per rolling 24h**
  (a shop scraped within the last day is skipped even if it happens to
  still be the "oldest" -- otherwise a small shop list with nothing else
  to do would just re-scrape the same one or two shops back-to-back
  forever every idle tick). One shop at a time rather than a batch, so a
  refresh trickles in during downtime and the check next minute naturally
  picks up the next-oldest once this one finishes -- instead of dumping
  the whole backlog on the pool at once. This daily cap only applies to
  'auto' picks; it doesn't limit user/admin-triggered retries or
  'fixed_time', which are explicit asks and should always go through.

Shops with status 'failed' are left out of 'auto' picks: since scraped_at
only advances on a *successful* scrape, a shop that keeps failing would
otherwise have the oldest scraped_at forever and get re-picked every
cycle, starving every other shop of its turn. Admin (or the user) retrying
it manually is the intended way out of that state; 'fixed_time' mode still
includes it, since that's an explicit "refresh literally everything" ask.

Independent of mode/fixed_time: ScheduleSettings.review_mode/
review_fixed_time, on the same off/fixed_time/auto terms, govern walking
one successful shop's Reviews-tab pages (scrape_shop_reviews_stealth) to
fill in Listing.num_reviews per product -- Etsy's item-grid cards no
longer expose that number directly (see README.md), but each review on
the Reviews tab links back to the listing it was left for.

- 'off': does nothing.
- 'auto': checked every tick; whenever the queue is idle (same in_flight
  check the shop-level 'auto' mode uses), picks one shop.
- 'fixed_time': same daily-trigger gating as the shop-level mode (once a
  day, at review_fixed_time), then picks one shop the same way.

Either way, it runs on its own background thread (a full walk can take
minutes) guarded by _review_scrape_running so a slow shop doesn't get
picked twice by the next tick; picks the successful, available shop with
the oldest/null reviews_scraped_at, one at a time -- a refresh trickles in
rather than dumping the whole shop list on Chrome at once.
"""

import re
import threading
import time
from datetime import date, datetime, timedelta

from sqlalchemy import nullsfirst, or_

from . import models
from .database import SessionLocal
from .scraper import scrape_shop_reviews_stealth
from .scrape_worker import pool as scrape_pool

_CHECK_INTERVAL_SECONDS = 60
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_AUTO_MIN_INTERVAL = timedelta(days=1)

_last_fixed_trigger_date: date | None = None
_last_review_fixed_trigger_date: date | None = None

_review_lock = threading.Lock()
_review_scrape_running = False


def _fixed_time_due(fixed_time: str | None, last_trigger_date: date | None) -> bool:
    if not fixed_time or not _TIME_RE.match(fixed_time):
        return False
    now = datetime.now()
    if now.strftime("%H:%M") != fixed_time:
        return False
    return last_trigger_date != now.date()


def _run_fixed_time(db, settings_row: "models.ScheduleSettings") -> None:
    global _last_fixed_trigger_date
    if not _fixed_time_due(settings_row.fixed_time, _last_fixed_trigger_date):
        return

    shops = db.query(models.Shop).all()
    for shop in shops:
        shop.status = models.ShopStatus.pending
        shop.error_message = None
    db.commit()
    for shop in shops:
        scrape_pool.enqueue(shop.id)
    _last_fixed_trigger_date = date.today()


def _run_auto(db) -> None:
    in_flight = (
        db.query(models.Shop)
        .filter(models.Shop.status.in_([models.ShopStatus.pending, models.ShopStatus.scraping]))
        .count()
    )
    if in_flight > 0:
        return

    cutoff = datetime.utcnow() - _AUTO_MIN_INTERVAL
    shop = (
        db.query(models.Shop)
        .filter(
            models.Shop.status != models.ShopStatus.failed,
            or_(models.Shop.scraped_at.is_(None), models.Shop.scraped_at < cutoff),
        )
        .order_by(nullsfirst(models.Shop.scraped_at.asc()))
        .first()
    )
    if shop is None:
        return

    shop.status = models.ShopStatus.pending
    shop.error_message = None
    db.commit()
    scrape_pool.enqueue(shop.id)


def _first_configured_proxy(db) -> str | None:
    row = db.query(models.ScraperSettings).filter(models.ScraperSettings.id == 1).first()
    return row.proxies[0] if row and row.proxies else None


def _review_scrape_worker(shop_id: int, proxy: str | None) -> None:
    """Runs on its own thread (started by _run_review_scrape) since a full
    Reviews-tab walk can take minutes -- must not block the 60s tick loop
    the way _run_auto/_run_fixed_time do (those just enqueue and return).
    """
    global _review_scrape_running
    db = SessionLocal()
    try:
        shop = db.query(models.Shop).filter(models.Shop.id == shop_id).first()
        if shop is None:
            return
        try:
            counts = scrape_shop_reviews_stealth(shop.shop_url, proxy=proxy)
        except Exception:
            # Best-effort background job -- leave reviews_scraped_at alone
            # so this shop is retried on a later idle window instead of
            # silently staying on stale/missing counts.
            return
        if counts:
            listings = db.query(models.Listing).filter(models.Listing.shop_id == shop.id).all()
            for listing in listings:
                if listing.etsy_listing_id in counts:
                    listing.num_reviews = counts[listing.etsy_listing_id]
        shop.reviews_scraped_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()
        with _review_lock:
            _review_scrape_running = False


def _run_review_scrape(db, settings_row: "models.ScheduleSettings") -> None:
    global _review_scrape_running, _last_review_fixed_trigger_date
    if settings_row.review_mode == models.ScheduleMode.off:
        return
    if settings_row.review_mode == models.ScheduleMode.fixed_time:
        if not _fixed_time_due(settings_row.review_fixed_time, _last_review_fixed_trigger_date):
            return
        _last_review_fixed_trigger_date = date.today()

    with _review_lock:
        if _review_scrape_running:
            return

        in_flight = (
            db.query(models.Shop)
            .filter(models.Shop.status.in_([models.ShopStatus.pending, models.ShopStatus.scraping]))
            .count()
        )
        if in_flight > 0:
            return

        shop = (
            db.query(models.Shop)
            .filter(models.Shop.status == models.ShopStatus.done, models.Shop.is_available.is_(True))
            .order_by(nullsfirst(models.Shop.reviews_scraped_at.asc()))
            .first()
        )
        if shop is None:
            return

        _review_scrape_running = True
        proxy = _first_configured_proxy(db)

    threading.Thread(
        target=_review_scrape_worker, args=(shop.id, proxy), daemon=True, name="review-scrape-worker"
    ).start()


def _tick() -> None:
    db = SessionLocal()
    try:
        settings_row = db.query(models.ScheduleSettings).filter(models.ScheduleSettings.id == 1).first()
        if settings_row is None:
            return
        if settings_row.mode == models.ScheduleMode.fixed_time:
            _run_fixed_time(db, settings_row)
        elif settings_row.mode == models.ScheduleMode.auto:
            _run_auto(db)
        _run_review_scrape(db, settings_row)
    finally:
        db.close()


def _loop() -> None:
    while True:
        try:
            _tick()
        except Exception:
            # A transient DB hiccup shouldn't permanently kill the
            # scheduler for the rest of the process's life.
            pass
        time.sleep(_CHECK_INTERVAL_SECONDS)


def start() -> None:
    threading.Thread(target=_loop, daemon=True, name="rescrape-scheduler").start()
