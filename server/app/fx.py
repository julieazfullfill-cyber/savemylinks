"""USD exchange rates for displaying listing prices in USD regardless of
which currency Etsy rendered them in (varies by the scraping browser's
inferred locale/IP -- see scraper.py's currency capture). Fetched from a
free, no-key public API and cached in memory, since these prices are for
at-a-glance comparison, not financial transactions -- rates only need to
be roughly current, not real-time.
"""

import json
import time
import urllib.request

_RATES_URL = "https://open.er-api.com/v6/latest/USD"
_CACHE_TTL_SECONDS = 6 * 60 * 60

_cache: dict[str, float] | None = None
_cache_at: float = 0.0


def get_usd_rates() -> dict[str, float]:
    """Returns {currency_code: units_per_USD}, e.g. {"VND": 25400.0, "EUR": 0.92}.
    Divide a price by its currency's rate to get the USD amount.
    """
    global _cache, _cache_at
    now = time.time()
    if _cache is not None and (now - _cache_at) < _CACHE_TTL_SECONDS:
        return _cache

    try:
        with urllib.request.urlopen(_RATES_URL, timeout=10) as resp:
            data = json.load(resp)
        rates = data["rates"]
    except Exception:
        # Keep serving the last good cache (even if stale) rather than
        # breaking price display because the FX API had a hiccup.
        if _cache is not None:
            return _cache
        rates = {"USD": 1.0}

    _cache = rates
    _cache_at = now
    return _cache
