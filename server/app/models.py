import enum
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .database import Base


class UserRole(str, enum.Enum):
    admin = "admin"
    user = "user"


class ShopStatus(str, enum.Enum):
    pending = "pending"
    scraping = "scraping"
    done = "done"
    failed = "failed"


class ScheduleMode(str, enum.Enum):
    off = "off"
    fixed_time = "fixed_time"
    auto = "auto"


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, nullable=False, index=True)
    password_hash = Column(String, nullable=False)
    role = Column(Enum(UserRole), nullable=False, default=UserRole.user)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime, nullable=True)

    shops = relationship("Shop", back_populates="owner", cascade="all, delete-orphan")


class Shop(Base):
    __tablename__ = "shops"
    __table_args__ = (UniqueConstraint("owner_id", "shop_url", name="uq_owner_shop_url"),)

    id = Column(Integer, primary_key=True, index=True)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    shop_url = Column(String, nullable=False, index=True)
    niche = Column(String, nullable=True)
    status = Column(Enum(ShopStatus), nullable=False, default=ShopStatus.pending)
    shop_name = Column(String, nullable=True)
    location = Column(String, nullable=True)
    total_listings = Column(Integer, nullable=True)
    total_reviews = Column(Integer, nullable=True)
    total_sales = Column(Integer, nullable=True)
    rating = Column(Float, nullable=True)
    requested_at = Column(DateTime, default=datetime.utcnow)
    scraped_at = Column(DateTime, nullable=True)
    error_message = Column(Text, nullable=True)
    # Whether the shop itself is reachable and selling (vs. on vacation,
    # closed, or otherwise showing no listings) as of the last successful
    # scrape -- distinct from `status`/`error_message`, which track whether
    # *we* managed to fetch the page at all. See scraper.py's vacation/
    # closed-page detection.
    is_available = Column(Boolean, nullable=False, default=True)
    unavailable_reason = Column(String, nullable=True)
    # Listing summaries ({etsy_listing_id, title, image_url, url}) added or
    # removed by the most recent full automated scrape compared to the one
    # before it -- powers the user-facing change report. Only set by a
    # full scrape (replace_all=True), never by a manual HTML-paste import
    # (which only ever covers one page, not the whole shop), and left
    # empty on a shop's very first scrape since there's nothing to diff
    # against yet.
    last_added_listings = Column(JSON, nullable=False, default=list)
    last_removed_listings = Column(JSON, nullable=False, default=list)
    # Etsy's own human-readable "time on Etsy" duration (e.g. "9 months",
    # "5 years") -- see scraper.py's parse_shop_header.
    shop_tenure = Column(String, nullable=True)
    # How much total_sales/total_reviews grew since the *previous* full
    # scrape -- set alongside last_added/removed_listings (same replace_all
    # gating, same "skip on first scrape" rule) in save_scraped_data.
    sales_delta = Column(Integer, nullable=True)
    reviews_delta = Column(Integer, nullable=True)
    # Same idea as sales_delta/reviews_delta but compared against a
    # ShopMetricSnapshot from ~7/~30 days ago instead of just the previous
    # scrape -- see scrape_worker.py's save_scraped_data.
    sales_delta_week = Column(Integer, nullable=True)
    reviews_delta_week = Column(Integer, nullable=True)
    sales_delta_month = Column(Integer, nullable=True)
    reviews_delta_month = Column(Integer, nullable=True)
    # Last time scheduler.py's idle review-scrape walked this shop's
    # Reviews-tab pages to fill in Listing.num_reviews per product --
    # separate from scraped_at (the item-grid scrape), null until the first
    # review scrape ever runs. Drives which shop is picked next (oldest/
    # null first) the same way scraped_at drives 'auto' mode's picks.
    reviews_scraped_at = Column(DateTime, nullable=True)

    owner = relationship("User", back_populates="shops")
    listings = relationship(
        "Listing", back_populates="shop", cascade="all, delete-orphan"
    )


class Listing(Base):
    __tablename__ = "listings"
    __table_args__ = (UniqueConstraint("shop_id", "etsy_listing_id", name="uq_shop_listing"),)

    id = Column(Integer, primary_key=True, index=True)
    shop_id = Column(Integer, ForeignKey("shops.id"), nullable=False)
    etsy_listing_id = Column(String, nullable=True, index=True)
    title = Column(Text, nullable=True)
    url = Column(Text, nullable=True)
    image_url = Column(Text, nullable=True)
    price = Column(String, nullable=True)
    price_value = Column(Float, nullable=True)
    currency = Column(String, nullable=True)
    rating = Column(Float, nullable=True)
    num_reviews = Column(Integer, nullable=True)
    scraped_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    shop = relationship("Shop", back_populates="listings")


class ShopMetricSnapshot(Base):
    """One row per full scrape, recording total_sales/total_reviews at that
    point in time. Shop.sales_delta_week/month etc. are computed from this
    history (closest snapshot at or before ~7/~30 days ago vs. the current
    values) in scrape_worker.py's save_scraped_data. FK has ON DELETE
    CASCADE at the DB level (no ORM-side cascade/relationship needed) so
    deleting a shop doesn't leave orphaned snapshot rows behind.
    """

    __tablename__ = "shop_metric_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    shop_id = Column(Integer, ForeignKey("shops.id", ondelete="CASCADE"), nullable=False, index=True)
    recorded_at = Column(DateTime, default=datetime.utcnow, index=True)
    total_sales = Column(Integer, nullable=True)
    total_reviews = Column(Integer, nullable=True)


class ListingChangeLog(Base):
    """Persistent, append-only record of every listing add/remove detected
    by a full automated scrape (mirrors what goes into
    Shop.last_added_listings/last_removed_listings for that one scrape, but
    kept forever instead of being overwritten by the next scrape).

    Needed because removed listings are hard-deleted from the `listings`
    table (see save_scraped_data's replace_all logic) -- there's no other
    way to answer "how many listings were removed today" once today has
    more than one scrape, since shop.last_removed_listings only holds the
    most recent scrape's diff. Powers the user overview dashboard's
    "listing mới/gỡ hôm nay" counts.
    """

    __tablename__ = "listing_change_log"

    id = Column(Integer, primary_key=True, index=True)
    shop_id = Column(Integer, ForeignKey("shops.id", ondelete="CASCADE"), nullable=False, index=True)
    etsy_listing_id = Column(String, nullable=True)
    change_type = Column(String, nullable=False)  # "added" | "removed"
    title = Column(Text, nullable=True)
    image_url = Column(Text, nullable=True)
    url = Column(Text, nullable=True)
    changed_at = Column(DateTime, default=datetime.utcnow, index=True)


class ScraperSettings(Base):
    """Singleton row (id is always 1) holding admin-configurable scraping
    concurrency: how many real Chrome windows scrape_worker.pool runs at
    once (1-100, see schemas.ScraperSettingsUpdate), and the proxy (if any)
    each of those "window slots" uses. `proxies` is index-aligned with slot
    number and always has exactly `max_concurrent` entries -- see
    routers/admin.py's settings endpoint, which normalizes it on every save.
    """

    __tablename__ = "scraper_settings"

    id = Column(Integer, primary_key=True, default=1)
    max_concurrent = Column(Integer, nullable=False, default=1)
    proxies = Column(JSON, nullable=False, default=list)


class ScheduleSettings(Base):
    """Singleton row (id is always 1) controlling scheduler.py's periodic
    re-scrape of every already-added shop:

    - 'off': scheduler does nothing.
    - 'fixed_time': re-queues every shop once a day at `fixed_time`
      ("HH:MM", 24h, server-local time).
    - 'auto': whenever nothing is currently pending/scraping (queue is
      idle), re-queues just the single shop with the oldest scraped_at --
      so refreshes trickle in during downtime instead of a big batch.

    review_mode/review_fixed_time below govern the separate per-product
    review scrape on the same off/fixed_time/auto terms.
    """

    __tablename__ = "schedule_settings"

    id = Column(Integer, primary_key=True, default=1)
    mode = Column(Enum(ScheduleMode), nullable=False, default=ScheduleMode.off)
    fixed_time = Column(String, nullable=True)
    # Independent of mode/fixed_time above -- controls scheduler.py's
    # _run_review_scrape, which opens a real (stealth) Chrome window to walk
    # a shop's Reviews-tab pages and fill in Listing.num_reviews per
    # product. Same off/fixed_time/auto vocabulary as mode/fixed_time, but
    # its own row since a shop can want reviews refreshed on a different
    # cadence than the shop-level re-scrape (or not at all -- it's an extra
    # background Chrome window, not implied by mode='auto'/'fixed_time').
    review_mode = Column(Enum(ScheduleMode), nullable=False, default=ScheduleMode.off)
    review_fixed_time = Column(String, nullable=True)
