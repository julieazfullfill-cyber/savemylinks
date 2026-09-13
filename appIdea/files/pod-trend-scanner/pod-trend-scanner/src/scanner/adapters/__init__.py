"""Registry adapter.

Thêm nguồn mới = thêm 1 file trong thư mục này + 1 dòng ở REGISTRY + 1 dòng bảng `sources`.
Không sửa code core.
"""

from scanner.adapters.amazon_suggest import AmazonSuggestAdapter
from scanner.adapters.base import Observation, RawItem, SourceAdapter
from scanner.adapters.bing_suggest import BingSuggestAdapter
from scanner.adapters.google_suggest import GoogleSuggestAdapter
from scanner.adapters.pinterest_suggest import PinterestSuggestAdapter

REGISTRY: dict[str, type[SourceAdapter]] = {
    AmazonSuggestAdapter.name: AmazonSuggestAdapter,
    GoogleSuggestAdapter.name: GoogleSuggestAdapter,
    BingSuggestAdapter.name: BingSuggestAdapter,
    PinterestSuggestAdapter.name: PinterestSuggestAdapter,
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
    "Observation",
    "PinterestSuggestAdapter",
    "RawItem",
    "SourceAdapter",
    "get_adapter_class",
]
