"""Registry adapter.

Thêm nguồn mới = thêm 1 file trong thư mục này + 1 dòng ở REGISTRY + 1 dòng bảng `sources`.
Không sửa code core.
"""

from scanner.adapters.amazon_suggest import AmazonSuggestAdapter
from scanner.adapters.base import Observation, RawItem, SourceAdapter
from scanner.adapters.bing_suggest import BingSuggestAdapter
from scanner.adapters.google_suggest import GoogleSuggestAdapter
from scanner.adapters.google_trending_now import GoogleTrendingNowAdapter
from scanner.adapters.pinterest_suggest import PinterestSuggestAdapter
from scanner.adapters.pinterest_trends import PinterestTrendsAdapter

REGISTRY: dict[str, type[SourceAdapter]] = {
    AmazonSuggestAdapter.name: AmazonSuggestAdapter,
    GoogleSuggestAdapter.name: GoogleSuggestAdapter,
    BingSuggestAdapter.name: BingSuggestAdapter,
    PinterestSuggestAdapter.name: PinterestSuggestAdapter,
    PinterestTrendsAdapter.name: PinterestTrendsAdapter,
    GoogleTrendingNowAdapter.name: GoogleTrendingNowAdapter,
}


def get_adapter_class(name: str) -> type[SourceAdapter]:
    try:
        return REGISTRY[name]
    except KeyError:
        raise KeyError(f"không có adapter tên '{name}'. Có: {sorted(REGISTRY)}") from None


__all__ = [
    "REGISTRY",
    "AmazonSuggestAdapter",
    "BingSuggestAdapter",
    "GoogleSuggestAdapter",
    "GoogleTrendingNowAdapter",
    "Observation",
    "PinterestSuggestAdapter",
    "PinterestTrendsAdapter",
    "RawItem",
    "SourceAdapter",
    "get_adapter_class",
]
