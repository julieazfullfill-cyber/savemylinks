# Design Brief Spec — từ trend term đến prompt gen design

## 0. Nguyên tắc: LLM không viết prompt, LLM điền brief

Sai lầm phổ biến nhất là để LLM tự do viết cả câu prompt cho model ảnh. Kết quả là mỗi
lần một kiểu, không kiểm soát được ràng buộc in ấn, không A/B test được, không debug được
khi sản phẩm ra xấu.

Cách đúng là hai bước tách rời:

```
trend term ──[LLM]──> design_brief (JSON, có schema, validate được)
design_brief ──[renderer thuần code]──> image_prompt (string)
```

Renderer là code Python thường, không phải LLM. Nó ghép brief với một template cố định
theo product_type. Mọi ràng buộc kỹ thuật (kích thước, nền trong suốt, số màu, lề an toàn)
nằm trong template, không bao giờ để LLM tự nghĩ ra.

Lợi ích cụ thể:
- Đổi model ảnh (Midjourney → Flux → SDXL) chỉ cần sửa renderer, không sửa lại 40 prompt.
- Brief lưu trong DB dưới dạng structured → query được "tất cả design phong cách retro
  groovy bán chạy nhất", điều mà chuỗi prompt tự do không cho phép.
- Test được từng biến riêng lẻ: giữ nguyên concept, đổi mỗi `visual.style`.

## 1. Xử lý chữ — quyết định quan trọng nhất

Model ảnh vẽ chữ vẫn không đáng tin cho hàng in bán. Sai một ký tự là hàng lỗi, khách
chargeback. Với POD, luôn tách hai lớp:

- **Lớp art**: model ảnh sinh, KHÔNG có chữ trong prompt. Thêm `no text, no letters,
  no words, no typography` vào negative prompt.
- **Lớp text**: pipeline của bạn render bằng vector (Pillow/SVG/Illustrator script) từ
  font file có sẵn, đè lên lớp art.

Brief phải mô tả cả hai lớp riêng biệt, và `layout.text_anchor` cho renderer biết đặt
chữ ở đâu so với art.

Ngoại lệ: nếu design là typography-only (rất phổ biến với funny tee), bỏ hẳn lớp art,
chỉ chạy lớp text. Rẻ hơn, nhanh hơn, và thường bán tốt hơn.

## 2. Schema `design_brief`

```json
{
  "brief_id": "uuid",
  "created_at": "iso8601",

  "source": {
    "term": "chuỗi keyword gốc từ scanner",
    "niche": "wedding | birthday | custom_photo | occupation_humor | ...",
    "risk_tier": "T0 | T1 | T2 | T3",
    "evidence": {
      "velocity_7d": 0.0,
      "sources": ["pinterest_trends", "amazon_autocomplete"],
      "saturation": 1240
    }
  },

  "product": {
    "type": "tshirt | mug | blanket | poster | tumbler | ornament",
    "print_area": "front_center | front_pocket | full_wrap",
    "canvas_px": [4500, 5400],
    "print_method": "dtg | dtf | sublimation | uv",
    "max_colors": null
  },

  "concept": {
    "buyer": "ai mua — cụ thể, không phải 'mọi người'",
    "recipient": "tặng cho ai, hoặc null nếu tự mua",
    "occasion": "dịp gì",
    "emotional_angle": "sentimental | sarcastic | celebratory | proud | wholesome",
    "why_it_sells": "một câu, lý do người này rút ví"
  },

  "text_layer": {
    "enabled": true,
    "headline": "dòng chữ chính",
    "subline": "dòng phụ hoặc null",
    "personalization_slots": [
      {"name": "child_name", "placeholder": "{NAME}", "max_chars": 12, "case": "title"}
    ],
    "typography": {
      "primary_style": "bold condensed sans | flowing script | retro serif | handwritten",
      "case": "upper | title | lower",
      "arrangement": "stacked | arc | single_line | mixed_weight_stack",
      "emphasis_word": "từ cần nhấn hoặc null"
    }
  },

  "art_layer": {
    "enabled": true,
    "subject": "vật thể chính, mô tả cụ thể",
    "style": "flat vector illustration | retro 70s groovy | fine line art | watercolor",
    "composition": "centered | badge circle | wreath around text | bottom flourish",
    "palette": {
      "mode": "limited | full",
      "colors": ["#2F4F3E", "#E8D5B7", "#C9724A"],
      "background": "transparent"
    },
    "detail_level": "minimal | moderate | detailed",
    "texture": "clean | subtle grain | heavy distress"
  },

  "layout": {
    "text_anchor": "above_art | below_art | overlay_center | art_only | text_only",
    "safe_margin_pct": 8
  },

  "constraints": ["mảng chuỗi, do renderer chèn theo product.type"],
  "negative": ["mảng chuỗi"],

  "listing": {
    "title": "≤140 ký tự, front-loaded keyword",
    "tags": ["13 tag cho Etsy"],
    "bullets": ["3-5 bullet cho Amazon"]
  },

  "risk": {
    "level": "low | review | blocked",
    "origin_classification": "generic | derived_from_media | proper_noun | unknown",
    "checks": {"blocklist": "pass", "uspto_class25": "pass", "llm_origin": "pass"},
    "human_approved_by": null
  }
}
```

## 3. System prompt cho LLM sinh brief

```
Bạn là art director cho một xưởng print-on-demand. Đầu vào là một trend term kèm dữ liệu
thị trường. Đầu ra là một design_brief JSON hợp lệ, không có gì khác — không markdown,
không giải thích, không code fence.

QUY TẮC:

1. concept.buyer phải cụ thể tới mức hình dung được một con người. "Phụ nữ 28-35 vừa được
   chọn làm phù dâu lần thứ ba trong năm" là đúng. "Người thích đám cưới" là sai.

2. text_layer.headline tối đa 6 từ với sản phẩm mặc. Người ta đọc áo từ khoảng cách 2 mét.

3. TUYỆT ĐỐI KHÔNG dùng: tên nhân vật, tên phim, tên bài hát, lời bài hát, tên thương hiệu,
   tên người thật, tên đội thể thao, khẩu hiệu chiến dịch chính trị. Nếu trend term chứa
   những thứ này, đặt risk.level = "blocked" và giải thích trong risk.origin_classification.

4. Nếu headline là một cụm bạn từng nghe ở đâu đó, đặt origin_classification =
   "derived_from_media" và risk.level = "review". Thà báo động nhầm còn hơn bỏ sót.

5. art_layer.palette.colors: tối đa 5 màu với DTG, dùng mã hex. Chọn màu tương phản tốt
   trên cả áo trắng và áo đen, hoặc ghi rõ trong constraints nếu chỉ hợp một loại.

6. Nếu design mạnh hơn khi chỉ có chữ, đặt art_layer.enabled = false. Đừng nhét minh hoạ
   vào chỉ vì trường đó tồn tại.

7. personalization_slots: với niche wedding / birthday / custom_photo, luôn cố gắng có ít
   nhất một slot. Sản phẩm cá nhân hoá khó bị copy và bán giá cao hơn.

8. listing.title bắt đầu bằng keyword người ta thực sự gõ, không bắt đầu bằng tên brand.

Đầu vào:
{term, niche, risk_tier, evidence, product_type, seasonality}
```

Bắt buộc validate output bằng JSON Schema trước khi ghi DB. Fail thì retry một lần với
thông báo lỗi, fail lần hai thì bỏ, đừng để LLM "sửa" mãi.

## 4. Renderer: brief → image prompt

Code thuần, mỗi product_type một template.

```python
TEMPLATES = {
    "tshirt_art": (
        "{style} illustration of {subject}, {composition} composition, "
        "{detail_level} detail, {texture} finish, "
        "color palette {palette_str}, "
        "isolated on pure transparent background, "
        "flat 2D artwork for apparel screen print, "
        "centered, even margins, no perspective, no shadow"
    ),
}

HARD_NEGATIVE = [
    "text", "letters", "words", "typography", "watermark", "signature",
    "mockup", "t-shirt", "clothing", "hanger", "person wearing",
    "photorealistic", "3d render", "drop shadow", "gradient background",
    "cropped", "cut off edges",
]

def render(brief):
    art = brief["art_layer"]
    if not art["enabled"]:
        return None                      # typography-only, bỏ qua model ảnh
    prompt = TEMPLATES[f"{brief['product']['type']}_art"].format(
        style=art["style"],
        subject=art["subject"],
        composition=art["composition"],
        detail_level=art["detail_level"],
        texture=art["texture"],
        palette_str=", ".join(art["palette"]["colors"]),
    )
    negative = HARD_NEGATIVE + brief.get("negative", [])
    return {"prompt": prompt, "negative_prompt": ", ".join(negative),
            "width": 1024, "height": 1229, "upscale_to": brief["product"]["canvas_px"]}
```

Sinh ở 1024px rồi upscale, đừng bắt model sinh thẳng 4500px — chậm và thường tệ hơn.

## 5. Ba ví dụ đã điền đầy đủ

### 5.1 Wedding — cá nhân hoá, T0

```json
{
  "source": {"term": "bridesmaid proposal box", "niche": "wedding", "risk_tier": "T0"},
  "product": {"type": "tshirt", "print_area": "front_center",
              "canvas_px": [4500, 5400], "print_method": "dtg", "max_colors": 4},
  "concept": {
    "buyer": "Cô dâu 27-34 đang chuẩn bị đám cưới mùa hè, mua 4-6 cái cùng lúc cho nhóm phù dâu",
    "recipient": "Bạn thân được mời làm phù dâu",
    "occasion": "Bridesmaid proposal, 4-8 tháng trước ngày cưới",
    "emotional_angle": "sentimental",
    "why_it_sells": "Đây là khoảnh khắc được chụp ảnh và đăng lên mạng — sản phẩm phải lên hình đẹp, không phải bền"
  },
  "text_layer": {
    "enabled": true,
    "headline": "WILL YOU BE MY BRIDESMAID",
    "subline": "{NAME}",
    "personalization_slots": [
      {"name": "bridesmaid_name", "placeholder": "{NAME}", "max_chars": 14, "case": "title"}
    ],
    "typography": {
      "primary_style": "flowing script for subline, clean serif for headline",
      "case": "upper", "arrangement": "stacked", "emphasis_word": "BRIDESMAID"
    }
  },
  "art_layer": {
    "enabled": true,
    "subject": "delicate eucalyptus and baby's breath sprig arrangement, half-wreath opening upward",
    "style": "fine line botanical illustration",
    "composition": "wreath around text",
    "palette": {"mode": "limited", "colors": ["#7A8B6F", "#C4A582"], "background": "transparent"},
    "detail_level": "moderate", "texture": "clean"
  },
  "layout": {"text_anchor": "overlay_center", "safe_margin_pct": 8},
  "listing": {
    "title": "Will You Be My Bridesmaid Shirt Personalized Name Proposal Gift",
    "tags": ["bridesmaid proposal", "will you be my bridesmaid", "bridal party shirt",
             "personalized bridesmaid", "bridesmaid gift", "wedding party tee",
             "maid of honor", "bridal shower gift", "custom name shirt",
             "eucalyptus wedding", "bridesmaid box", "engagement gift", "bride tribe"]
  },
  "risk": {"level": "low", "origin_classification": "generic"}
}
```

Prompt ảnh renderer sinh ra:

> fine line botanical illustration of delicate eucalyptus and baby's breath sprig
> arrangement, half-wreath opening upward, wreath around text composition, moderate
> detail, clean finish, color palette #7A8B6F, #C4A582, isolated on pure transparent
> background, flat 2D artwork for apparel screen print, centered, even margins, no
> perspective, no shadow

### 5.2 Birthday — milestone, T1

```json
{
  "source": {"term": "50th birthday shirt funny", "niche": "birthday", "risk_tier": "T1"},
  "product": {"type": "tshirt", "print_area": "front_center",
              "canvas_px": [4500, 5400], "print_method": "dtg", "max_colors": 3},
  "concept": {
    "buyer": "Con gái 25-40 mua quà cho bố/mẹ tròn 50, ngân sách 25-35 USD",
    "recipient": "Người vừa tròn 50, thích được trêu nhưng không muốn bị chê già",
    "occasion": "Tiệc sinh nhật mốc 50",
    "emotional_angle": "sarcastic",
    "why_it_sells": "Người mua cần một món quà gây cười ngay lúc mở, không cần dùng lâu"
  },
  "text_layer": {
    "enabled": true,
    "headline": "LEVEL 50 UNLOCKED",
    "subline": "EST. {YEAR}",
    "personalization_slots": [
      {"name": "birth_year", "placeholder": "{YEAR}", "max_chars": 4, "case": "upper"}
    ],
    "typography": {
      "primary_style": "bold condensed sans", "case": "upper",
      "arrangement": "mixed_weight_stack", "emphasis_word": "50"
    }
  },
  "art_layer": {
    "enabled": true,
    "subject": "retro sunburst rays radiating from behind center, simple starburst accents",
    "style": "retro 70s groovy",
    "composition": "badge circle",
    "palette": {"mode": "limited", "colors": ["#D96C3F", "#E8C547", "#2B4162"],
                "background": "transparent"},
    "detail_level": "minimal", "texture": "subtle grain"
  },
  "layout": {"text_anchor": "overlay_center", "safe_margin_pct": 10},
  "risk": {"level": "low", "origin_classification": "generic"}
}
```

Ghi chú: `{YEAR}` không phải khách nhập, mà hệ thống tự tính `current_year - 50`. Đây là
kiểu personalization slot rẻ nhất — không cần khách làm gì, vẫn ra sản phẩm mới mỗi năm.

### 5.3 Funny tee — occupation humor, T1

```json
{
  "source": {"term": "nurse humor shirt", "niche": "occupation_humor", "risk_tier": "T1"},
  "product": {"type": "tshirt", "print_area": "front_center",
              "canvas_px": [4500, 5400], "print_method": "dtg", "max_colors": 2},
  "concept": {
    "buyer": "Điều dưỡng nữ 24-45, tự mua để mặc ngày off hoặc mua tặng đồng nghiệp",
    "recipient": null,
    "occasion": "Nurses Week tháng 5, hoặc mua tuỳ hứng quanh năm",
    "emotional_angle": "sarcastic",
    "why_it_sells": "Câu đùa chỉ người trong nghề mới hiểu — tín hiệu thuộc về một nhóm"
  },
  "text_layer": {
    "enabled": true,
    "headline": "RUNS ON CAFFEINE AND TWELVE HOUR SHIFTS",
    "subline": null,
    "personalization_slots": [],
    "typography": {
      "primary_style": "bold condensed sans", "case": "upper",
      "arrangement": "stacked", "emphasis_word": "TWELVE HOUR"
    }
  },
  "art_layer": {"enabled": false},
  "layout": {"text_anchor": "text_only", "safe_margin_pct": 10},
  "risk": {"level": "low", "origin_classification": "generic",
           "checks": {"blocklist": "pass", "uspto_class25": "pass", "llm_origin": "pass"}}
}
```

Đây là ví dụ typography-only: không gọi model ảnh, chỉ render chữ. Chi phí gần bằng 0,
thời gian vài giây, và trong mảng funny tee loại này thường bán tốt hơn loại có minh hoạ.

## 6. Ràng buộc in ấn theo product_type

| product_type | canvas_px | print_method | Lưu ý |
|---|---|---|---|
| tshirt front | 4500 × 5400 | DTG | Nền trong suốt bắt buộc. Tránh gradient mịn và màu rất nhạt trên vải sáng. |
| tshirt pocket | 1200 × 1200 | DTG | Chi tiết phải cực đơn giản, nhìn ở 8cm. |
| mug 11oz | 2475 × 1155 | Sublimation | Chừa 1cm hai bên tay cầm. Không in tràn viền. |
| blanket | 6000 × 8000 | Sublimation | Ảnh khách upload phải ≥1500px, cần validate lúc đặt hàng. |
| poster 18×24 | 5400 × 7200 | UV / giclée | Có thể dùng gradient và ảnh thật thoải mái. |
| ornament | 1200 × 1200 | UV | Vùng in tròn, đặt chi tiết trong đường tròn 90%. |
| tumbler 20oz | 2850 × 1500 | Sublimation | Thiết kế phải nối liền được ở mép ghép. |

## 7. Vòng phản hồi

Sau 30 ngày, join `design_brief` với doanh số và query xem trường nào tương quan với đơn:

```sql
SELECT art_layer->>'style' AS style,
       COUNT(*) AS designs,
       SUM(orders) AS total_orders,
       ROUND(AVG(orders), 2) AS avg_orders
FROM design_briefs b JOIN sales s USING (brief_id)
WHERE b.created_at > now() - interval '90 days'
GROUP BY 1 ORDER BY avg_orders DESC;
```

Đổi `art_layer->>'style'` thành `emotional_angle`, `typography->>'arrangement'`,
`concept->>'occasion'` để tìm ra công thức riêng của shop bạn. Đây là lý do brief phải là
JSON có cấu trúc chứ không phải một chuỗi prompt — chuỗi prompt không query được như thế này.
