"""Scrapes public Etsy shop pages for listing info.

Etsy's markup changes over time and the site fronts requests with DataDome
bot-detection, so selectors below use several fallbacks and everything that
can fail degrades to `None` instead of raising. If Etsy changes its layout,
this is the file to update -- selectors are kept in one place (the
*_SELECTORS lists) for that reason.
"""

import re
from dataclasses import dataclass, field
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from scrapling.fetchers import StealthySession

from .config import settings

LISTING_CARD_SELECTORS = [
    "div.js-merch-stash-check-listing",
    "li.wt-list-unstyled div[data-listing-id]",
    "div[data-listing-id]",
]
TITLE_SELECTORS = ["h3", "h2", ".v2-listing-card__title", "[data-listing-card-title]"]
PRICE_SELECTORS = [".currency-value", ".n-listing-card__price .currency-value", ".wt-text-title-01"]
CURRENCY_SYMBOL_TO_CODE = {
    "₫": "VND",
    "$": "USD",
    "€": "EUR",
    "£": "GBP",
    "¥": "JPY",
    "₹": "INR",
    "₩": "KRW",
    "A$": "AUD",
    "C$": "CAD",
    "R$": "BRL",
    "₽": "RUB",
    "zł": "PLN",
}
RATING_TEXT_RE = re.compile(r"([\d.]+)\s+out of 5 stars")
REVIEW_COUNT_RE = re.compile(r"[\(\[]?([\d,]+)[\)\]]?\s*(?:reviews?)?")
SALES_COUNT_RE = re.compile(r"([\d,]+)\s+[Ss]ales?")
LOCATION_RE = re.compile(r"located in ([^.]+)\.?")
ABBREVIATED_COUNT_RE = re.compile(r"^([\d.]+)\s*([kKmM]?)$")

# Etsy shows one of these banners instead of the listing grid when a shop
# is on vacation, closed, or otherwise not selling -- the request still
# succeeds (200), there's just nothing to scrape. Best-effort text match;
# if Etsy rewords a banner, that case just falls through to "no listings
# found" instead of a specific reason -- still degrades gracefully.
UNAVAILABLE_MARKERS = [
    ("vacation", "Shop đang trong chế độ nghỉ (vacation mode)"),
    ("temporarily closed", "Shop tạm đóng"),
    ("shop is closed", "Shop đã đóng"),
    ("no longer available", "Shop không còn khả dụng trên Etsy"),
    ("no longer on etsy", "Shop không còn khả dụng trên Etsy"),
    ("currently unavailable", "Shop hiện không khả dụng"),
]


class ScrapeBlockedError(Exception):
    """Raised when Etsy returns a non-200 response (likely bot detection)."""


@dataclass
class ScrapedListing:
    etsy_listing_id: str | None = None
    title: str | None = None
    url: str | None = None
    image_url: str | None = None
    price: str | None = None
    price_value: float | None = None
    currency: str | None = None
    rating: float | None = None
    num_reviews: int | None = None


@dataclass
class ScrapedShop:
    shop_name: str | None = None
    location: str | None = None
    total_listings: int | None = None
    total_reviews: int | None = None
    total_sales: int | None = None
    rating: float | None = None
    shop_tenure: str | None = None
    listings: list[ScrapedListing] = field(default_factory=list)
    unavailable_reason: str | None = None


def _first_match(soup_or_tag, selectors: list[str]):
    for sel in selectors:
        found = soup_or_tag.select_one(sel)
        if found is not None:
            return found
    return None


def _parse_int(text: str | None) -> int | None:
    if not text:
        return None
    m = REVIEW_COUNT_RE.search(text.replace("\xa0", " "))
    if not m:
        return None
    try:
        return int(m.group(1).replace(",", ""))
    except ValueError:
        return None


def _extract_image_url(img_el) -> str | None:
    """Picks the real Etsy CDN URL, skipping local paths Chrome rewrites to
    when a page is saved via "Ctrl+S -> Webpage, HTML only" (e.g.
    "./ShopName_files/il_340x270.xxx.jpg", which nothing on our server can
    reach). Lazy-load attributes (data-src/srcset) often still hold the
    original absolute URL even when `src` has been rewritten.
    """
    if img_el is None:
        return None
    candidates = [img_el.get("data-src"), img_el.get("data-src-retina"), img_el.get("data-original")]
    srcset = img_el.get("data-srcset") or img_el.get("srcset")
    if srcset:
        candidates.append(srcset.split(",")[0].strip().split(" ")[0])
    candidates.append(img_el.get("src"))
    for candidate in candidates:
        if candidate and candidate.startswith(("http://", "https://")):
            return candidate
    return None


def _parse_price(card) -> tuple[str | None, float | None, str | None]:
    """Returns (display_text, numeric_value, currency_code).

    The number and its currency symbol are separate sibling spans
    (`.currency-value` / `.currency-symbol`) under the same wrapper --
    reach for the symbol via that wrapper rather than assuming a fixed DOM
    depth, since Etsy nests these slightly differently across card layouts.
    `.currency-value`'s text is comma-thousands-separated with a `.`
    decimal only for currencies that have minor units (e.g. "1,234.56" USD
    vs "313,774" VND) -- stripping commas then float-parsing handles both
    without needing to special-case currencies.
    """
    price_el = _first_match(card, PRICE_SELECTORS)
    if price_el is None:
        return None, None, None
    display = price_el.get_text(strip=True)

    wrapper = price_el.parent
    symbol_el = wrapper.select_one(".currency-symbol") if wrapper else None
    symbol = symbol_el.get_text(strip=True) if symbol_el else None
    currency_code = CURRENCY_SYMBOL_TO_CODE.get(symbol) if symbol else None

    try:
        value = float(display.replace("\xa0", "").replace(",", ""))
    except ValueError:
        value = None

    return display, value, currency_code


def _parse_rating(card) -> float | None:
    rating_holder = card.select_one("[aria-label*='out of 5 stars']") or card.select_one(
        "input[name='rating']"
    )
    if rating_holder is None:
        return None
    label = rating_holder.get("aria-label") or rating_holder.get("value") or ""
    m = RATING_TEXT_RE.search(label)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            return None
    try:
        return float(label)
    except (TypeError, ValueError):
        return None


def _parse_abbreviated_count(text: str | None) -> int | None:
    """Parses Etsy's already-rounded review counts -- "(1k)", "234",
    "1.2k" -- into an approximate integer. Etsy doesn't expose the exact
    review count on the shop page (unlike sales, which has an exact figure
    in the "/sold" link's text elsewhere on the page), so this is the best
    precision available; a shop going from 1,000 to 1,400 reviews won't
    show a change here until it crosses into the next display bucket.
    """
    if not text:
        return None
    m = ABBREVIATED_COUNT_RE.match(text.strip().strip("()").replace(",", ""))
    if not m:
        return None
    try:
        value = float(m.group(1))
    except ValueError:
        return None
    suffix = m.group(2).lower()
    if suffix == "k":
        value *= 1_000
    elif suffix == "m":
        value *= 1_000_000
    return int(value)


def detect_shop_unavailable(soup: BeautifulSoup) -> str | None:
    text = soup.get_text(" ", strip=True).lower()
    for marker, reason in UNAVAILABLE_MARKERS:
        if marker in text:
            return reason
    return None


def parse_shop_header(soup: BeautifulSoup) -> ScrapedShop:
    shop = ScrapedShop()

    name_el = soup.select_one("h1") or soup.select_one("[data-shop-name]")
    if name_el:
        shop.shop_name = name_el.get_text(strip=True)

    items_el = soup.find(string=re.compile(r"[\d,]+\s+[Ii]tems?"))
    if items_el:
        shop.total_listings = _parse_int(str(items_el))

    sales_el = soup.select_one("[data-shop-sale-count]") or soup.find(
        string=re.compile(r"[\d,]+\s+[Ss]ales?")
    )
    if sales_el:
        m = SALES_COUNT_RE.search(str(sales_el))
        if m:
            shop.total_sales = _parse_int(m.group(1))

    # Etsy's shop-header rating widget exposes the exact average directly as
    # a data attribute (the visible text is stars-only, no number) --
    # `[aria-label*='out of 5 stars']` was the old (now unused) markup.
    rating_el = soup.select_one("[data-rating]")
    if rating_el:
        try:
            shop.rating = float(rating_el["data-rating"])
        except (TypeError, ValueError):
            pass

    # Only ever rendered rounded ("(1k)") -- see _parse_abbreviated_count.
    reviews_el = soup.select_one(".rating-and-reviews-count__reviews-count")
    if reviews_el:
        shop.total_reviews = _parse_abbreviated_count(reviews_el.get_text(strip=True))

    # Etsy computes this duration itself ("9 months", "5 years") -- stored
    # as-is rather than converted to an exact join date, since that's all
    # the page gives us and it's already in the form we want to display.
    tenure_el = soup.select_one('[data-highlight="on_etsy"] .highlight__primary-content')
    if tenure_el:
        shop.shop_tenure = tenure_el.get_text(strip=True)

    # Etsy's meta description consistently reads "Shop <blurb> by <ShopName>
    # located in <Location>." -- the most reliable place to pull location
    # from since it's not tucked behind a specific CSS class that changes often.
    meta_desc = soup.select_one('meta[name="description"]')
    if meta_desc and meta_desc.get("content"):
        m = LOCATION_RE.search(meta_desc["content"])
        if m:
            shop.location = m.group(1).strip()

    return shop


def parse_listing_cards(soup: BeautifulSoup, base_url: str) -> list[ScrapedListing]:
    cards = []
    for sel in LISTING_CARD_SELECTORS:
        cards = soup.select(sel)
        if cards:
            break

    listings: list[ScrapedListing] = []
    seen_listing_ids: set[str] = set()
    for card in cards:
        link = card if card.name == "a" else card.select_one("a[href*='/listing/']")
        href = link.get("href") if link else None

        etsy_listing_id = card.get("data-listing-id")
        if not etsy_listing_id and href:
            m = re.search(r"/listing/(\d+)", href)
            etsy_listing_id = m.group(1) if m else None

        # Etsy shop pages often show the same listing more than once (main
        # grid + "you may also like" carousels) -- skip repeats so the DB's
        # unique (shop_id, etsy_listing_id) constraint doesn't reject the save.
        if etsy_listing_id:
            if etsy_listing_id in seen_listing_ids:
                continue
            seen_listing_ids.add(etsy_listing_id)

        title_el = _first_match(card, TITLE_SELECTORS)
        img_el = card.select_one("img")
        price_display, price_value, currency_code = _parse_price(card)

        listings.append(
            ScrapedListing(
                etsy_listing_id=etsy_listing_id,
                title=title_el.get_text(strip=True) if title_el else (
                    img_el.get("alt") if img_el else None
                ),
                url=urljoin(base_url, href) if href else None,
                image_url=_extract_image_url(img_el),
                price=price_display,
                price_value=price_value,
                currency=currency_code,
                rating=_parse_rating(card),
                num_reviews=_parse_int(
                    (card.select_one(".wt-text-caption") or {}).get_text(strip=True)
                    if card.select_one(".wt-text-caption")
                    else None
                ),
            )
        )
    return listings


def parse_shop_html(shop_url: str, html: str) -> ScrapedShop:
    """Parses HTML the user saved/copied from their own browser session.

    Kept as a fallback for cases where even scrape_shop_stealth gets
    blocked -- since the HTML comes from a real logged-in browser, no
    request is made from the server at all.
    """
    soup = BeautifulSoup(html, "lxml")
    shop = parse_shop_header(soup)
    shop.listings = parse_listing_cards(soup, shop_url)
    if shop.total_listings is None:
        shop.total_listings = len(shop.listings)
    return shop


def parse_review_items(soup: BeautifulSoup) -> list[str | None]:
    """One entry per review card on a shop's Reviews-tab page, holding the
    etsy_listing_id of the product that review was left for (None if Etsy
    didn't attach one to that card, e.g. a since-deleted listing).

    Etsy's shop item cards no longer expose a per-listing review count (see
    the `num_reviews` note in README.md), but each card here links back to
    the specific listing via `div[data-region="listing"] a[href*="/listing/
    "]` -- counting these per listing_id is how scrape_shop_reviews_stealth
    fills that gap.
    """
    listing_ids: list[str | None] = []
    for card in soup.select("div.review-item"):
        region = card.select_one('div[data-region="listing"]')
        link = region.select_one("a[href*='/listing/']") if region else None
        href = link.get("href") if link else None
        listing_id = None
        if href:
            m = re.search(r"/listing/(\d+)", href)
            listing_id = m.group(1) if m else None
        listing_ids.append(listing_id)
    return listing_ids


def scrape_shop_reviews_stealth(
    shop_url: str, max_pages: int = 200, proxy: str | None = None
) -> dict[str, int]:
    """Counts reviews per listing by walking the shop's own paginated
    Reviews tab (`{shop_url}/reviews?ref=pagination&page=N`), same
    StealthyFetcher approach as scrape_shop_stealth. Only reviews Etsy
    makes browsable this way are counted -- typically far fewer than the
    shop's all-time rounded review count shown elsewhere, since Etsy caps
    how many pages of reviews are listable.

    Returns {etsy_listing_id: review_count}. Stops at the first page with
    no review cards (natural end of the list) or `max_pages`, whichever
    comes first -- max_pages is just a runaway-loop safety net given
    review-tab page counts aren't bounded by settings.scrape_max_pages the
    way item-grid pages are, not expected to be hit in practice.
    """
    counts: dict[str, int] = {}
    with StealthySession(
        headless=False, real_chrome=True, network_idle=True, proxy=proxy
    ) as session:
        page_num = 1
        while page_num <= max_pages:
            url = f"{shop_url.rstrip('/')}/reviews?ref=pagination&page={page_num}"
            page = session.fetch(url, wait=6000)
            if page.status != 200:
                break
            soup = BeautifulSoup(page.html_content, "lxml")
            listing_ids = parse_review_items(soup)
            if not listing_ids:
                break
            for listing_id in listing_ids:
                if listing_id:
                    counts[listing_id] = counts.get(listing_id, 0) + 1
            page_num += 1
    return counts


def scrape_shop_stealth(
    shop_url: str, max_pages: int | None = None, proxy: str | None = None
) -> ScrapedShop:
    """Automated scrape using Scrapling's StealthyFetcher (Patchright-based
    stealth browser). Patchright patches CDP/leak fingerprints deep enough
    to get past Etsy's DataDome check with a visible (headless=False),
    real-Chrome browser -- raw Playwright with just a couple of navigator
    overrides reliably got a 403 before the page even rendered. This is the
    path scrape_worker's pool uses; manual HTML paste (parse_shop_html)
    stays as a fallback for shops/situations where even this gets blocked.

    `proxy` is per-call (not baked into a shared session) because the
    worker pool assigns a possibly-different proxy to this "window slot"
    on every job -- see scrape_worker.py.
    """
    max_pages = max_pages or settings.scrape_max_pages

    with StealthySession(
        headless=False, real_chrome=True, network_idle=True, proxy=proxy
    ) as session:
        page = session.fetch(shop_url, wait=8000)
        if page.status == 404:
            # A real 404 (vs. DataDome's 403) means the shop URL itself is
            # gone -- Etsy fully removed it, not just blocking this request.
            return ScrapedShop(
                unavailable_reason="Không tìm thấy shop (có thể đã đóng hoặc bị xoá khỏi Etsy)"
            )
        if page.status != 200:
            raise ScrapeBlockedError(
                f"Etsy returned status {page.status} for {shop_url}. "
                "This usually means the request was blocked (bot detection) "
                "or the shop URL is wrong/private."
            )
        soup = BeautifulSoup(page.html_content, "lxml")
        shop = parse_shop_header(soup)

        unavailable_reason = detect_shop_unavailable(soup)
        if unavailable_reason:
            shop.unavailable_reason = unavailable_reason
            return shop

        shop.listings.extend(parse_listing_cards(soup, shop_url))

        page_num = 2
        while page_num <= max_pages:
            next_link = soup.select_one(f"a[href*='page={page_num}']")
            if not next_link:
                break
            page_url = urljoin(shop_url, next_link.get("href"))
            page = session.fetch(page_url, wait=6000)
            if page.status != 200:
                break
            soup = BeautifulSoup(page.html_content, "lxml")
            new_listings = parse_listing_cards(soup, shop_url)
            if not new_listings:
                break
            shop.listings.extend(new_listings)
            page_num += 1

    if shop.total_listings is None:
        shop.total_listings = len(shop.listings)

    return shop
