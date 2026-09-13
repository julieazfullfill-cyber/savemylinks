"""Registry adapter.

Thêm nguồn mới = thêm 1 file trong thư mục này + 1 dòng ở REGISTRY + 1 dòng bảng `sources`.
Không sửa code core.
"""

from scanner.adapters.amazon_suggest import AmazonSuggestAdapter
from scanner.adapters.base import Observation, RawItem, SourceAdapter

REGISTRY: dict[str, type[SourceAdapter]] = {
    AmazonSuggestAdapter.name: AmazonSuggestAdapter,
}


def get_adapter_class(name: str) -> type[SourceAdapter]:
    try:
        return REGISTRY[name]
    except KeyError:
        raise KeyError(f"không có adapter tên '{name}'. Có: {sorted(REGISTRY)}") from None


__all__ = [
    "REGISTRY",
    "AmazonSuggestAdapter",
    "Observation",
    "RawItem",
    "SourceAdapter",
    "get_adapter_class",
]
