"""SwarmFlow v3 / Node Live —— 把 icon.css 的几何参数渲染成产品图标。

与 design/logo/v3/icon.css 一一对应（1024 网格，夜版）：
  field #0f1613 / ring #e9e4d4 / lamp #e3a243
  六角环：宽 64%、高 74%，环厚＝内嵌 12%
  灯：圆心 (82%, 68.5%)、直径 20%，内部琥珀点 65%
  各尺寸统一保留空芯环：CSS 里 ≤24px 折叠成实心的规则只适用于网页排版，
  图标进任务栏（24px）时实心会让内部变亮、与产品标识不一致。

产物：icons/swarmflow.png（1024）与 icons/swarmflow.ico（多尺寸，PNG 载荷）。
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "icons"

FIELD = (15, 22, 19, 255)      # #0f1613
RING = (233, 228, 212, 255)    # #e9e4d4
LAMP = (227, 162, 67, 255)     # #e3a243
EDGE = (233, 228, 212, 14)     # rgba(233, 228, 212, .055)

SS = 4  # 超采样倍数


def hex_points(x: float, y: float, w: float, h: float):
    return [
        (x + w * 0.5, y),
        (x + w, y + h * 0.25),
        (x + w, y + h * 0.75),
        (x + w * 0.5, y + h),
        (x, y + h * 0.75),
        (x, y + h * 0.25),
    ]


def render(size: int) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角方块底 + 1px 内描边
    draw.rounded_rectangle((0, 0, s - 1, s - 1), radius=0.18 * s, fill=FIELD)
    draw.rounded_rectangle(
        (0.5, 0.5, s - 0.5, s - 0.5),
        radius=0.18 * s,
        outline=EDGE,
        width=max(1, SS // 2),
    )

    # 六角环：外六角填环色，内六角填料色挖空
    hw, hh = 0.64 * s, 0.74 * s
    hx, hy = (s - hw) / 2, (s - hh) / 2
    draw.polygon(hex_points(hx, hy, hw, hh), fill=RING)
    iw, ih = hw * 0.76, hh * 0.76
    ix, iy = hx + hw * 0.12, hy + hh * 0.12
    draw.polygon(hex_points(ix, iy, iw, ih), fill=FIELD)

    # 灯座（底色挖孔）＋琥珀灯芯
    cx, cy = 0.82 * s, 0.685 * s
    outer = 0.20 * s
    draw.ellipse((cx - outer / 2, cy - outer / 2, cx + outer / 2, cy + outer / 2), fill=FIELD)
    inner = outer * 0.65
    draw.ellipse((cx - inner / 2, cy - inner / 2, cx + inner / 2, cy + inner / 2), fill=LAMP)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)

    master = render(1024)
    master.save(ICON_DIR / "swarmflow.png")

    # ICO：Vista+ 允许每个尺寸用 PNG 载荷；小尺寸按 CSS 规则换成实心。
    sizes = [256, 128, 96, 64, 48, 40, 32, 24, 16]
    frames = [(size, render(size)) for size in sizes]
    blobs = []
    for _, frame in frames:
        import io

        buf = io.BytesIO()
        frame.save(buf, format="PNG")
        blobs.append(buf.getvalue())

    header = bytearray()
    header += (0).to_bytes(2, "little")      # reserved
    header += (1).to_bytes(2, "little")      # type = icon
    header += len(frames).to_bytes(2, "little")
    offset = 6 + 16 * len(frames)
    directory = bytearray()
    for (size, _), blob in zip(frames, blobs):
        dim = 0 if size >= 256 else size
        directory += bytes([dim, dim, 0, 0])
        directory += (1).to_bytes(2, "little")     # planes
        directory += (32).to_bytes(2, "little")    # bit count
        directory += len(blob).to_bytes(4, "little")
        directory += offset.to_bytes(4, "little")
        offset += len(blob)
    (ICON_DIR / "swarmflow.ico").write_bytes(bytes(header + directory + b"".join(blobs)))
    print(f"wrote {ICON_DIR / 'swarmflow.png'} and {ICON_DIR / 'swarmflow.ico'} ({len(frames)} sizes)")


if __name__ == "__main__":
    main()
