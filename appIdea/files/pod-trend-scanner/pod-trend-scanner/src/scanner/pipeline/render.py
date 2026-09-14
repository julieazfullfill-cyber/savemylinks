"""brief → image prompt. Code thuần, KHÔNG dùng LLM (CLAUDE.md, docs/DESIGN_BRIEF_SPEC.md
mục 4). Một template dùng chung cho mọi product_type (spec chỉ đưa ra một ví dụ
"tshirt_art" và nội dung template không đổi theo loại sản phẩm — chỉ constraints/canvas
đổi, xem PRODUCT_CONSTRAINTS + docs/DESIGN_BRIEF_SPEC.md mục 6).

**Sai khác có chủ đích với chuỗi template in trong spec**: bản in trong spec là
`"{style} illustration of {subject}, ..."`, nhưng chính VÍ DỤ ĐƯỢC RENDER SẴN trong
spec (mục 5.1) lại KHÔNG có chữ "illustration" lặp hai lần — style đã chứa sẵn từ
"illustration" ("fine line botanical illustration"). Hai chỗ trong spec tự mâu thuẫn
nhau; TASKS.md Phase 4 yêu cầu acceptance là "tái tạo được đúng" ví dụ đã render sẵn,
nên template ở đây bỏ chữ "illustration" thừa để khớp đúng ví dụ đó (verify trong
test_render.py bằng chuỗi in nguyên văn từ spec)."""

from dataclasses import dataclass

from scanner.pipeline.design_brief_schema import DesignBrief

PROMPT_TEMPLATE = (
    "{style} of {subject}, {composition} composition, "
    "{detail_level} detail, {texture} finish, "
    "color palette {palette_str}, "
    "isolated on pure transparent background, "
    "flat 2D artwork for apparel screen print, "
    "centered, even margins, no perspective, no shadow"
)

HARD_NEGATIVE: tuple[str, ...] = (
    "text",
    "letters",
    "words",
    "typography",
    "watermark",
    "signature",
    "mockup",
    "t-shirt",
    "clothing",
    "hanger",
    "person wearing",
    "photorealistic",
    "3d render",
    "drop shadow",
    "gradient background",
    "cropped",
    "cut off edges",
)

# Ràng buộc in ấn theo (product.type, product.print_area) — docs/DESIGN_BRIEF_SPEC.md
# mục 6. Renderer chèn vào (schema comment: "do renderer chèn theo product.type"),
# không để LLM tự bịa ràng buộc kỹ thuật.
PRODUCT_CONSTRAINTS: dict[tuple[str, str], tuple[str, ...]] = {
    ("tshirt", "front_center"): (
        "nền trong suốt bắt buộc",
        "tránh gradient mịn và màu rất nhạt trên vải sáng",
    ),
    ("tshirt", "front_pocket"): ("chi tiết phải cực đơn giản, nhìn rõ ở khoảng cách 8cm",),
    ("mug", "full_wrap"): (
        "chừa 1cm hai bên tay cầm",
        "không in tràn viền",
    ),
    ("blanket", "full_wrap"): ("ảnh khách upload phải từ 1500px trở lên, validate lúc đặt hàng",),
    ("poster", "full_wrap"): ("có thể dùng gradient và ảnh thật thoải mái",),
    ("ornament", "full_wrap"): ("vùng in tròn, đặt chi tiết trong đường tròn 90%",),
    ("tumbler", "full_wrap"): ("thiết kế phải nối liền được ở mép ghép",),
}


@dataclass(frozen=True)
class RenderedPrompt:
    prompt: str
    negative_prompt: str
    width: int
    height: int
    upscale_to: tuple[int, int]
    constraints: tuple[str, ...]


def render(brief: DesignBrief) -> RenderedPrompt | None:
    """None nếu typography-only (`art_layer.enabled=false`) — bỏ qua model ảnh hoàn
    toàn, đúng nhánh rẻ nhất trong spec mục 1 ("Ngoại lệ: typography-only")."""
    art = brief.art_layer
    if not art.enabled:
        return None
    if not (art.style and art.subject and art.composition and art.palette):
        raise ValueError("art_layer.enabled=true nhưng thiếu trường bắt buộc để render")

    palette_str = ", ".join(art.palette.colors)
    prompt = PROMPT_TEMPLATE.format(
        style=art.style,
        subject=art.subject,
        composition=art.composition,
        detail_level=art.detail_level or "moderate",
        texture=art.texture or "clean",
        palette_str=palette_str,
    )
    negative = list(HARD_NEGATIVE) + list(brief.negative)

    canvas_w, canvas_h = brief.product.canvas_px
    width = 1024
    height = round(width * canvas_h / canvas_w)

    key = (brief.product.type, brief.product.print_area)
    constraints = tuple(dict.fromkeys(list(brief.constraints) + list(PRODUCT_CONSTRAINTS.get(key, ()))))

    return RenderedPrompt(
        prompt=prompt,
        negative_prompt=", ".join(negative),
        width=width,
        height=height,
        upscale_to=(canvas_w, canvas_h),
        constraints=constraints,
    )
