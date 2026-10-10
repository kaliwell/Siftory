#!/usr/bin/env python3
"""Generate the Siftory commercialization diagrams and executive-summary PDF."""

from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path

import pymupdf
from reportlab.graphics import renderPDF
from reportlab.graphics.shapes import Drawing, Line, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "docs"
MINDMAP_NAME = "open-source-commercialization-mindmap.png"
FLOWCHART_NAME = "open-source-commercialization-flowchart.png"
PDF_NAME = "open-source-commercialization-plan.pdf"

NAVY = colors.HexColor("#173F6B")
INK = colors.HexColor("#162235")
MUTED = colors.HexColor("#607089")
BLUE = colors.HexColor("#2D69E8")
CYAN = colors.HexColor("#0498B8")
TEAL = colors.HexColor("#087F73")
GREEN = colors.HexColor("#16853F")
ORANGE = colors.HexColor("#CE640A")
PURPLE = colors.HexColor("#7C3AED")
RED = colors.HexColor("#B42318")
PAPER = colors.HexColor("#F3F6FB")
PALE_BLUE = colors.HexColor("#EAF1FF")
PALE_CYAN = colors.HexColor("#E5F5F8")
PALE_GREEN = colors.HexColor("#E8F5EC")
PALE_ORANGE = colors.HexColor("#FFF1E7")
PALE_PURPLE = colors.HexColor("#F2EAFF")
PALE_RED = colors.HexColor("#FDECEC")


def register_fonts() -> tuple[str, str]:
    candidates = [
        (
            Path(r"C:\Windows\Fonts\msyh.ttc"),
            Path(r"C:\Windows\Fonts\msyhbd.ttc"),
        ),
        (
            Path(r"C:\Windows\Fonts\simhei.ttf"),
            Path(r"C:\Windows\Fonts\simhei.ttf"),
        ),
    ]
    for regular, bold in candidates:
        if regular.exists() and bold.exists():
            pdfmetrics.registerFont(TTFont("SiftorySans", str(regular), subfontIndex=0))
            pdfmetrics.registerFont(TTFont("SiftorySansBold", str(bold), subfontIndex=0))
            return "SiftorySans", "SiftorySansBold"
    raise FileNotFoundError("No supported Chinese font was found in C:\\Windows\\Fonts")


def add_node(
    drawing: Drawing,
    x: float,
    y: float,
    width: float,
    height: float,
    text: str,
    *,
    fill: colors.Color,
    stroke: colors.Color,
    font: str,
    font_size: float = 22,
    text_color: colors.Color = INK,
    radius: float = 14,
) -> None:
    drawing.add(
        Rect(
            x,
            y,
            width,
            height,
            rx=radius,
            ry=radius,
            fillColor=fill,
            strokeColor=stroke,
            strokeWidth=2,
        )
    )
    lines = text.split("\n")
    line_height = font_size * 1.25
    first_y = y + height / 2 + (len(lines) - 1) * line_height / 2 - font_size * 0.34
    for index, value in enumerate(lines):
        drawing.add(
            String(
                x + width / 2,
                first_y - index * line_height,
                value,
                fontName=font,
                fontSize=font_size,
                fillColor=text_color,
                textAnchor="middle",
            )
        )


def add_connection(
    drawing: Drawing,
    start: tuple[float, float],
    end: tuple[float, float],
    color: colors.Color,
    width: float = 4,
) -> None:
    drawing.add(
        Line(
            start[0],
            start[1],
            end[0],
            end[1],
            strokeColor=color,
            strokeWidth=width,
        )
    )


def drawing_to_png(drawing: Drawing, path: Path) -> None:
    buffer = BytesIO(renderPDF.drawToString(drawing))
    document = pymupdf.open(stream=buffer.getvalue(), filetype="pdf")
    try:
        if document.page_count != 1:
            raise RuntimeError(f"Expected one diagram page, got {document.page_count}")
        pixmap = document[0].get_pixmap(matrix=pymupdf.Matrix(1, 1), alpha=False)
        pixmap.save(path)
    finally:
        document.close()


def build_mindmap(path: Path, regular: str, bold: str) -> None:
    drawing = Drawing(1600, 1000)
    drawing.add(Rect(0, 0, 1600, 1000, fillColor=PAPER, strokeColor=PAPER))
    drawing.add(
        String(
            64,
            930,
            "Siftory 开放核心与商业化全景",
            fontName=bold,
            fontSize=42,
            fillColor=INK,
        )
    )
    drawing.add(
        String(
            64,
            888,
            "目标草案 | 当前 private + UNLICENSED | 发布门禁 0/8 | 不构成发行授权",
            fontName=regular,
            fontSize=20,
            fillColor=MUTED,
        )
    )

    center = (590, 390, 420, 190)
    add_node(
        drawing,
        *center,
        "Siftory · 寻藏\n开放核心与商业化目标",
        fill=NAVY,
        stroke=NAVY,
        font=bold,
        font_size=32,
        text_color=colors.white,
        radius=30,
    )

    groups = [
        {
            "side": "left",
            "color": BLUE,
            "fill": PALE_BLUE,
            "branch": (285, 680, 240, 90, "产品继承"),
            "items": [
                (40, 790, 210, 58, "Community\n当前完整能力"),
                (40, 710, 210, 58, "Pro\n未来增量 + 服务"),
                (40, 630, 210, 58, "Team/NAS\n路线图"),
                (40, 550, 210, 58, "Enterprise\n路线图"),
            ],
        },
        {
            "side": "left",
            "color": PURPLE,
            "fill": PALE_PURPLE,
            "branch": (270, 365, 255, 90, "许可与权属"),
            "items": [
                (25, 450, 215, 58, "当前\nUNLICENSED"),
                (25, 370, 215, 58, "Apache/MPL/AGPL\n均待决策"),
                (25, 290, 215, 58, "DCO/CLA\n首个贡献前"),
                (25, 210, 215, 58, "第三方组件\n独立审批"),
            ],
        },
        {
            "side": "left",
            "color": ORANGE,
            "fill": PALE_ORANGE,
            "branch": (300, 75, 225, 90, "发布门禁"),
            "items": [
                (45, 120, 220, 58, "Online / Offline\n当前 0/8"),
                (45, 40, 220, 58, "许可 + 政策 + 签名\n全部通过后发布"),
            ],
        },
        {
            "side": "right",
            "color": CYAN,
            "fill": PALE_CYAN,
            "branch": (1075, 680, 240, 90, "本地优先基础设施"),
            "items": [
                (1350, 790, 210, 58, "GitHub / Releases\n完成门禁后"),
                (1350, 710, 210, 58, "Pages / Worker\n候选"),
                (1350, 630, 210, 58, "D1 / R2\n候选"),
                (1350, 550, 210, 58, "现阶段\n不买 VPS"),
            ],
        },
        {
            "side": "right",
            "color": TEAL,
            "fill": colors.HexColor("#E5F3F1"),
            "branch": (1075, 365, 240, 90, "授权与交付"),
            "items": [
                (1350, 450, 210, 58, "Webhook\n验签 + 幂等"),
                (1350, 370, 210, 58, "Ed25519\n客户端仅公钥"),
                (1350, 290, 210, 58, "私钥\n只在签发端"),
                (1350, 210, 210, 58, "一次激活\n长期离线"),
            ],
        },
        {
            "side": "right",
            "color": GREEN,
            "fill": PALE_GREEN,
            "branch": (1075, 75, 240, 90, "启动路线"),
            "items": [
                (1350, 120, 210, 58, "先权属与 8/8\n再发布 Community"),
                (1350, 40, 210, 58, "人工付费验证\n需求稳定后自动化"),
            ],
        },
    ]

    center_left = (center[0], center[1] + center[3] / 2)
    center_right = (center[0] + center[2], center[1] + center[3] / 2)
    for group in groups:
        bx, by, bw, bh, label = group["branch"]
        branch_center = (bx + bw / 2, by + bh / 2)
        if group["side"] == "left":
            add_connection(drawing, center_left, (bx + bw, branch_center[1]), group["color"], 7)
        else:
            add_connection(drawing, center_right, (bx, branch_center[1]), group["color"], 7)
        for ix, iy, iw, ih, _ in group["items"]:
            item_center_y = iy + ih / 2
            if group["side"] == "left":
                add_connection(drawing, (ix + iw, item_center_y), (bx, branch_center[1]), group["color"], 3)
            else:
                add_connection(drawing, (bx + bw, branch_center[1]), (ix, item_center_y), group["color"], 3)

    for group in groups:
        bx, by, bw, bh, label = group["branch"]
        add_node(
            drawing,
            bx,
            by,
            bw,
            bh,
            label,
            fill=group["fill"],
            stroke=group["color"],
            font=bold,
            font_size=24,
        )
        for ix, iy, iw, ih, label in group["items"]:
            add_node(
                drawing,
                ix,
                iy,
                iw,
                ih,
                label,
                fill=colors.white,
                stroke=group["color"],
                font=regular,
                font_size=16,
                radius=11,
            )

    drawing.add(
        String(
            64,
            10,
            "核心原则：Community 不降级；Pro 只增加未来能力与商业交付；Team 在真实客户需求后建设。",
            fontName=bold,
            fontSize=18,
            fillColor=NAVY,
        )
    )
    drawing_to_png(drawing, path)


def build_flowchart(path: Path, regular: str, bold: str) -> None:
    drawing = Drawing(1600, 1000)
    drawing.add(Rect(0, 0, 1600, 1000, fillColor=PAPER, strokeColor=PAPER))
    drawing.add(
        String(
            64,
            930,
            "Siftory 购买、授权与交付流程",
            fontName=bold,
            fontSize=42,
            fillColor=INK,
        )
    )
    drawing.add(
        String(
            64,
            888,
            "先通过权属与发布门禁；支付和许可证自动化不是当前已交付能力",
            fontName=regular,
            fontSize=20,
            fillColor=MUTED,
        )
    )

    top_nodes = [
        (55, 690, 230, 90, "1. 权利主体\n许可证定案", PALE_PURPLE, PURPLE),
        (320, 690, 230, 90, "2. 不降级拆分\nProvider + fallback", PALE_BLUE, BLUE),
        (585, 690, 230, 90, "3. 正式政策\n签名 + 干净提交", PALE_ORANGE, ORANGE),
        (850, 690, 230, 90, "4. 发布门禁\nOnline 8/8", PALE_RED, RED),
        (1115, 690, 230, 90, "5. 发布\nCommunity", PALE_GREEN, GREEN),
    ]
    for index, node in enumerate(top_nodes):
        x, y, w, h, _, _, stroke = node
        if index:
            px, py, pw, ph, *_ = top_nodes[index - 1]
            add_connection(
                drawing,
                (px + pw, py + ph / 2),
                (x, y + h / 2),
                stroke,
                5,
            )
    for x, y, w, h, label, fill, stroke in top_nodes:
        add_node(
            drawing,
            x,
            y,
            w,
            h,
            label,
            fill=fill,
            stroke=stroke,
            font=bold,
            font_size=20,
        )

    add_node(
        drawing,
        850,
        800,
        230,
        65,
        "未达 8/8\n停止发布",
        fill=PALE_RED,
        stroke=RED,
        font=bold,
        font_size=18,
        text_color=RED,
    )
    add_connection(drawing, (965, 780), (965, 800), RED, 3)

    lower_nodes = [
        (160, 400, 300, 105, "Community\n免费、完整本地单用户能力", PALE_BLUE, BLUE),
        (650, 400, 300, 105, "Pro 首批验证\n合规托管 + 人工发证", PALE_ORANGE, ORANGE),
        (1140, 400, 300, 105, "Team 需求访谈\n不销售未实现能力", PALE_GREEN, GREEN),
        (650, 160, 300, 105, "20-50 个稳定付费用户\nWebhook + Worker/D1 + R2", colors.HexColor("#E5F3F1"), TEAL),
        (1140, 160, 300, 105, "真实团队客户\n共享索引 + RBAC + 审计", PALE_GREEN, GREEN),
    ]
    for x, y, w, h, label, fill, stroke in lower_nodes:
        add_node(
            drawing,
            x,
            y,
            w,
            h,
            label,
            fill=fill,
            stroke=stroke,
            font=bold,
            font_size=21,
        )

    community_source = (1230, 690)
    add_connection(drawing, community_source, (310, 505), BLUE, 5)
    add_connection(drawing, community_source, (800, 505), ORANGE, 5)
    add_connection(drawing, community_source, (1290, 505), GREEN, 5)
    add_connection(drawing, (800, 400), (800, 265), TEAL, 5)
    add_connection(drawing, (1290, 400), (1290, 265), GREEN, 5)

    add_node(
        drawing,
        120,
        65,
        400,
        110,
        "许可证验证\nEd25519 公钥在客户端\n私钥仅在受保护签发端",
        fill=colors.white,
        stroke=TEAL,
        font=regular,
        font_size=18,
    )
    add_node(
        drawing,
        1060,
        20,
        460,
        105,
        "基金会不是启动项\n公开 6-12 个月、多维护者、多组织后再评估",
        fill=colors.white,
        stroke=PURPLE,
        font=regular,
        font_size=18,
    )
    drawing_to_png(drawing, path)


def make_styles(regular: str, bold: str) -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "TitleCN",
            parent=base["Title"],
            fontName=bold,
            fontSize=29,
            leading=38,
            textColor=NAVY,
            alignment=TA_LEFT,
            spaceAfter=10 * mm,
        ),
        "subtitle": ParagraphStyle(
            "SubtitleCN",
            parent=base["Normal"],
            fontName=regular,
            fontSize=13,
            leading=21,
            textColor=MUTED,
        ),
        "h1": ParagraphStyle(
            "Heading1CN",
            parent=base["Heading1"],
            fontName=bold,
            fontSize=21,
            leading=28,
            textColor=NAVY,
            spaceBefore=6 * mm,
            spaceAfter=4 * mm,
        ),
        "h2": ParagraphStyle(
            "Heading2CN",
            parent=base["Heading2"],
            fontName=bold,
            fontSize=15,
            leading=21,
            textColor=INK,
            spaceBefore=4 * mm,
            spaceAfter=2 * mm,
        ),
        "body": ParagraphStyle(
            "BodyCN",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=10.5,
            leading=17,
            textColor=INK,
            spaceAfter=2.2 * mm,
        ),
        "small": ParagraphStyle(
            "SmallCN",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=8.5,
            leading=13,
            textColor=MUTED,
        ),
        "callout": ParagraphStyle(
            "CalloutCN",
            parent=base["BodyText"],
            fontName=bold,
            fontSize=11.5,
            leading=18,
            textColor=NAVY,
            leftIndent=4 * mm,
            rightIndent=4 * mm,
            spaceBefore=2 * mm,
            spaceAfter=2 * mm,
        ),
        "table": ParagraphStyle(
            "TableCN",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=8.5,
            leading=12,
            textColor=INK,
        ),
        "table_head": ParagraphStyle(
            "TableHeadCN",
            parent=base["BodyText"],
            fontName=bold,
            fontSize=8.5,
            leading=12,
            textColor=colors.white,
        ),
    }


def p(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def bullet(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(f"• {text}", style)


def table(
    rows: list[list[str]],
    widths: list[float],
    styles: dict[str, ParagraphStyle],
) -> Table:
    rendered = []
    for row_index, row in enumerate(rows):
        style = styles["table_head"] if row_index == 0 else styles["table"]
        rendered.append([p(value, style) for value in row])
    result = Table(rendered, colWidths=widths, repeatRows=1, hAlign="LEFT")
    result.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#C7D2E3")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PAPER]),
            ]
        )
    )
    return result


def page_decor(canvas, doc) -> None:
    canvas.saveState()
    canvas.setTitle("Siftory 开放核心与商业化落地方案")
    canvas.setAuthor("Siftory documentation")
    canvas.setSubject("目标草案、当前门禁、产品边界、支付授权与基金会路线")
    if doc.page > 1:
        canvas.setFont("SiftorySans", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(18 * mm, 286 * mm, "Siftory 开放核心与商业化落地方案")
        canvas.drawRightString(192 * mm, 286 * mm, "2026-08-24")
        canvas.setStrokeColor(colors.HexColor("#D7E0EC"))
        canvas.line(18 * mm, 282 * mm, 192 * mm, 282 * mm)
    canvas.setFont("SiftorySans", 8)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(105 * mm, 10 * mm, f"第 {doc.page} 页")
    canvas.restoreState()


def build_pdf(path: Path, mindmap: Path, flowchart: Path, regular: str, bold: str) -> None:
    styles = make_styles(regular, bold)
    doc = SimpleDocTemplate(
        str(path),
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=20 * mm,
        bottomMargin=17 * mm,
        title="Siftory 开放核心与商业化落地方案",
        author="Siftory documentation",
    )
    story = []

    story.extend(
        [
            Spacer(1, 24 * mm),
            p("目标草案 / v1.1", styles["subtitle"]),
            Spacer(1, 6 * mm),
            p("Siftory 开放核心<br/>与商业化落地方案", styles["title"]),
            p(
                "当前状态、产品继承、许可证决策、发布门禁、支付授权、基础设施与基金会触发条件",
                styles["subtitle"],
            ),
            Spacer(1, 15 * mm),
            table(
                [
                    ["当前许可", "发布门禁"],
                    ["private + UNLICENSED<br/>proprietary / pending", "Online 0/8<br/>Offline 0/8"],
                    ["产品边界", "核心原则"],
                    ["尚无 Community/Pro/Team SKU", "Community 不降级<br/>Pro 只做未来增量"],
                ],
                [82 * mm, 82 * mm],
                styles,
            ),
            Spacer(1, 12 * mm),
            p(
                "本文是目标方案，不是许可证批准、法律或税务意见，也不是公开或商业发行授权。机器决策文件与 release gate 始终优先。",
                styles["callout"],
            ),
            Spacer(1, 42 * mm),
            p("版本日期：2026-08-24", styles["small"]),
        ]
    )

    story.extend(
        [
            PageBreak(),
            p("1. 当前判定与正确顺序", styles["h1"]),
            p(
                "项目适合评估开放核心，但当前不能直接开源或商业发布。AGPL、MPL、Apache、双重许可和继续专有均未获批准。",
                styles["body"],
            ),
            table(
                [
                    ["事实", "当前状态", "约束"],
                    ["项目许可证", "private + UNLICENSED", "无根 LICENSE 或最终 EULA"],
                    ["产品版本", "仅 online/offline 资源 Profile", "不是 Community/Pro/Team SKU"],
                    ["代码边界", "现有功能位于同一主项目", "不得直接抽走或降级"],
                    ["Team/NAS", "只有零散单用户底座", "无共享索引、组织、席位或 RBAC"],
                    ["支付/激活", "目标架构", "尚无生产 Paddle/Worker/D1/License 实现"],
                ],
                [38 * mm, 52 * mm, 74 * mm],
                styles,
            ),
            Spacer(1, 5 * mm),
            p("正确执行顺序", styles["h2"]),
            bullet("权利主体、项目许可证与逐组件分发决策。", styles["body"]),
            bullet("建立不降低现有功能和性能的 edition/provider 边界。", styles["body"]),
            bullet("完成最终 EULA、隐私、退款、安全、支持和生产签名。", styles["body"]),
            bullet("从干净提交通过 licenses:gate、readiness 8/8 和 release:gate。", styles["body"]),
            bullet("发布 Community 后，用人工发证验证 Pro 付费。", styles["body"]),
            bullet("需求稳定后自动授权；真实团队客户出现后建设 Team/NAS。", styles["body"]),
            p(
                "任何门禁非零或 blocked 时都停止发布；自动化不得把 pending 修改成 approved。",
                styles["callout"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            p("2. 产品继承与商业权益", styles["h1"]),
            table(
                [
                    ["版本", "当前/未来能力", "商业权益"],
                    [
                        "Community",
                        "保留当前全部单用户本地能力：图片/视频搜索、精排、主体、人脸/ReID、素材库、批量、模型管理、ANN/F16/GPU 和本机 API。",
                        "免费社区发行；模型是否随包仍取决于组件许可。",
                    ],
                    [
                        "Pro",
                        "未来新增：生产 OCR、专业 Provider、工作流、计划任务、模板、迁移工具。",
                        "官方签名安装包、受控下载、稳定更新、商业许可与优先支持。",
                    ],
                    [
                        "Team/NAS",
                        "未来新增：共享索引、组织、邀请、席位、RBAC、团队审计、中央备份和 API/MCP。",
                        "团队年付、离线团队许可证和管理员支持。",
                    ],
                    [
                        "Enterprise",
                        "未来新增：隔离网、SSO/AD/SCIM、HA/DR、数据驻留、定制模型与连接器。",
                        "企业许可、部署咨询、SLA、安全响应和长期支持。",
                    ],
                ],
                [27 * mm, 91 * mm, 46 * mm],
                styles,
            ),
            Spacer(1, 5 * mm),
            p("不可违反的继承规则", styles["h2"]),
            bullet("Community 是当前完整本地单用户产品，不是残缺试用版。", styles["body"]),
            bullet("Pro 继承 Community，只增加未来 Provider、工作流和官方交付。", styles["body"]),
            bullet("现有精排、主体、视频、GPU、批量和性能优化不得被付费闸收回。", styles["body"]),
            bullet("百万规模表述为架构目标；ANN/F16/增量机制已有，但百万正式验收待完成。", styles["body"]),
            bullet("Team/Enterprise 必须标记为路线图，不能提前销售未实现能力。", styles["body"]),
        ]
    )

    story.extend(
        [
            PageBreak(),
            p("3. 许可证与代码边界", styles["h1"]),
            table(
                [
                    ["候选", "价值", "主要风险", "当前结论"],
                    ["继续专有", "先验证付费", "社区与贡献较弱", "可作公开前过渡"],
                    ["Apache-2.0", "商业采用友好", "允许闭源扩展", "待评估"],
                    ["MPL-2.0", "文件级改动回流", "需要稳定文件边界", "待评估"],
                    ["AGPL-3.0", "强网络 copyleft", "桌面、插件和私有模块组合复杂", "非默认，需专项审查"],
                    ["双重许可", "可提供商业授权", "再许可权与 CLA 成本高", "真实需求后决定"],
                ],
                [28 * mm, 40 * mm, 62 * mm, 34 * mm],
                styles,
            ),
            Spacer(1, 4 * mm),
            p(
                "任何 OSI 开源许可证都允许商业使用。官方版本应依靠商标、签名、更新质量、服务和企业能力区分，不能附加禁止第三方商业售卖的限制。",
                styles["callout"],
            ),
            p("目标代码边界", styles["h2"]),
            table(
                [
                    ["层", "目标职责"],
                    ["community", "公开客户端与完整单机闭环"],
                    ["core / plugin-sdk", "稳定数据、任务、检索和版本化 Provider 协议"],
                    ["providers", "公开基础实现与 Community fallback"],
                    ["pro-packages", "未来增量 Provider 和专业工作流"],
                    ["team-server", "共享索引、组织、权限和审计"],
                    ["release", "受保护的组装、签名、授权和发布设施"],
                ],
                [48 * mm, 116 * mm],
                styles,
            ),
            p(
                "私有插件或独立本地进程不是天然的许可证豁免。必须按实际链接、IPC 和分发方式进行法律审查。",
                styles["small"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            p("4. 商业化全景", styles["h1"]),
            p(
                "图中明确区分当前事实、目标产品、发布门禁、候选基础设施和分阶段路线。",
                styles["body"],
            ),
            Image(str(mindmap), width=174 * mm, height=108.75 * mm),
            Spacer(1, 5 * mm),
            p(
                "阅读重点：Community 不降级；Pro 只增加未来能力与商业交付；Team 在真实客户需求后建设；基金会不是启动项。",
                styles["callout"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            p("5. 基础设施与支付", styles["h1"]),
            table(
                [
                    ["能力", "目标方案", "当前状态"],
                    ["官网/社区", "Pages、GitHub、Releases", "待远程仓库与门禁"],
                    ["海外支付", "Paddle 主候选，Creem 备用", "需商户准入、KYC 和测试"],
                    ["国内支付", "合规托管；稳定后商户支付宝/微信", "待真实经营主体审核"],
                    ["授权/订单", "Worker + D1 或等价方案", "未实现"],
                    ["安装包/模型", "R2 + 受控下载", "未实现"],
                    ["Windows 发布", "Authenticode + 时间戳", "未配置生产签名"],
                ],
                [42 * mm, 68 * mm, 54 * mm],
                styles,
            ),
            p("当前不买 VPS 的理由", styles["h2"]),
            bullet("检索、建库和模型推理默认在用户电脑或客户 NAS 运行。", styles["body"]),
            bullet("前 20 名付费用户可以使用合规托管和人工发证。", styles["body"]),
            bullet("线上只处理订单、许可证、账户和必要交付记录。", styles["body"]),
            bullet("长期任务、固定 IP、复杂团队后台或成本拐点出现后再评估 VPS。", styles["body"]),
            p("支付事实", styles["h2"]),
            bullet("Paddle 按月出款，最低阈值通常为 US$100；CNY、商户准入和银行入账以后台与审核为准。", styles["body"]),
            bullet("Creem 中国个人支付宝和企业本地银行规则、限额、费率与排期需在上线前复核。", styles["body"]),
            bullet("5 万美元是个人结售汇便利化额度，不是合法经营收入上限。", styles["body"]),
        ]
    )

    story.extend(
        [
            PageBreak(),
            p("6. 购买、授权与交付", styles["h1"]),
            Image(str(flowchart), width=174 * mm, height=108.75 * mm),
            Spacer(1, 4 * mm),
            p("许可证安全原则", styles["h2"]),
            bullet("只相信验签 Webhook，并对事件与订单做幂等和重放防护。", styles["body"]),
            bullet("客户端只内置 Ed25519 公钥；私钥不得进入 Electron、Native addon、安装包、日志或仓库。", styles["body"]),
            bullet("许可证包含 schema_version、key_id、license_id、plan、features、updates_until 和 order_id。", styles["body"]),
            bullet("一次激活后长期离线；退款后的可执行边界必须写入 EULA 和退款政策。", styles["body"]),
            bullet("更新校验签名、哈希、渠道和更新权益，支持公钥轮换。", styles["body"]),
        ]
    )

    story.extend(
        [
            PageBreak(),
            p("7. 发布门禁与 30 天路线", styles["h1"]),
            table(
                [
                    ["门禁", "关闭条件"],
                    ["REL-LEGAL", "项目、EULA、发布者和逐组件 Profile 全部批准"],
                    ["REL-SOURCE", "干净且可追溯的发布提交"],
                    ["REL-TAG", "版本 Tag 指向同一发布提交"],
                    ["REL-SIGN", "受保护签名命令与身份已配置"],
                    ["REL-NEKO", "受控准确率基线可比较"],
                    ["REL-PACKAGED", "双语言/Profile matrix 绑定当前提交"],
                    ["REL-PRIVACY", "最终隐私政策已批准"],
                    ["REL-SUPPORT", "最终安全、更新和支持政策已批准"],
                ],
                [42 * mm, 122 * mm],
                styles,
            ),
            p("30 天重点", styles["h2"]),
            table(
                [
                    ["周", "交付"],
                    ["第 1 周", "权利主体、许可证路径、Community 基线、组件审查"],
                    ["第 2 周", "最终政策、商标/域名、签名环境、干净源码"],
                    ["第 3 周", "Provider 接口、Community fallback、验签原型、支付 Sandbox"],
                    ["第 4 周", "Online 8/8、受控用户验证、愿付价格与停止条件"],
                ],
                [28 * mm, 136 * mm],
                styles,
            ),
            p(
                "人数只是观察指标，不是自动进入下一阶段的充分条件。必须同时满足权利、工程、安全和真实重复需求。",
                styles["callout"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            p("8. 基金会、风险与参考", styles["h1"]),
            p("基金会触发条件", styles["h2"]),
            bullet("公开运行 6-12 个月，至少两个可复核发布周期。", styles["body"]),
            bullet("至少 3 名不受同一主体控制的维护者，覆盖至少 2 个组织。", styles["body"]),
            bullet("多组织需要中立商标、仓库、规范或资金管理，并愿意持续投入。", styles["body"]),
            bullet("达到条件后优先比较 Apache、Eclipse、Linux Foundation 等托管机制。", styles["body"]),
            p("主要风险", styles["h2"]),
            table(
                [
                    ["风险", "控制"],
                    ["目标草案被当成许可", "机器决策和发布门禁是唯一事实源"],
                    ["现有功能被抽走", "Provider ABI + fallback + 迁移 + 全量回归"],
                    ["模型字段被当成批准", "只认逐组件 decision/profile gate"],
                    ["支付跳转伪造", "验签 Webhook、幂等和重放防护"],
                    ["离线许可证退款冲突", "政策只承诺技术可执行的边界"],
                    ["Team 过早建设", "先有真实团队试点与合同需求"],
                ],
                [52 * mm, 112 * mm],
                styles,
            ),
            p("官方参考", styles["h2"]),
            p(
                '<a href="https://developer.paddle.com/get-started/how-paddle-works/digital-products" color="#2D69E8">Paddle 数字产品流程</a> · '
                '<a href="https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid" color="#2D69E8">Paddle 出款</a> · '
                '<a href="https://docs.creem.io/merchant-of-record/finance/payouts" color="#2D69E8">Creem 出款</a> · '
                '<a href="https://docs.lemonsqueezy.com/help/getting-started/supported-countries" color="#2D69E8">Lemon Squeezy 地区</a> · '
                '<a href="https://developers.cloudflare.com/workers/platform/pricing/" color="#2D69E8">Workers</a> · '
                '<a href="https://developers.cloudflare.com/d1/platform/pricing/" color="#2D69E8">D1</a> · '
                '<a href="https://developers.cloudflare.com/r2/pricing/" color="#2D69E8">R2</a> · '
                '<a href="https://learn.microsoft.com/windows/win32/seccrypto/signtool" color="#2D69E8">SignTool</a>',
                styles["body"],
            ),
            Spacer(1, 8 * mm),
            p(
                "最终顺序：先完成权属、许可、拆分和 8/8 门禁；再发布不降级的 Community；用人工发证验证 Pro；需求稳定后自动授权；有真实团队客户后建设 Team/NAS；满足多组织治理条件后再评估基金会。",
                styles["callout"],
            ),
        ]
    )

    doc.build(story, onFirstPage=page_decor, onLaterPages=page_decor)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Output directory (defaults to the repository docs directory).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    regular, bold = register_fonts()
    mindmap = output_dir / MINDMAP_NAME
    flowchart = output_dir / FLOWCHART_NAME
    pdf = output_dir / PDF_NAME
    build_mindmap(mindmap, regular, bold)
    build_flowchart(flowchart, regular, bold)
    build_pdf(pdf, mindmap, flowchart, regular, bold)
    print(f"Generated: {mindmap}")
    print(f"Generated: {flowchart}")
    print(f"Generated: {pdf}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
