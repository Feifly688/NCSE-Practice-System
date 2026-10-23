"""
生成 favicon 全套资源。

【为什么不能对线稿做描边加粗】
站点 logo 是 1px 细线稿（logo-outline-bold.png），其内部缝隙中位数仅 6px
（原图宽 162px）。实测：对该 logo 做半径为 1px 的形态学膨胀（MaxFilter(3)），
不透明覆盖率会从 43% 直接跳到 88%——细线跨过缝隙全部连通，内部纹理彻底消失，
16x16 下退化为一个实心方块。因此放弃「加粗描边」路线。

【采用的方案】
线稿在 16px 下线宽约 0.7px，靠以下两点保证可辨识：
1. 高对比：白色线稿叠在品牌蓝实底上（不依赖透明背景，深浅标签栏都能看清）；
2. 留白：标记仅占画布 75%，避免线稿挤占边缘导致糊成一片。

流程：以 1024px 主图合成 → 逐尺寸 LANCZOS 降采样（从高精度降采样，
而非放大低清图）→ 输出 ICO + 多尺寸 PNG + PWA manifest。

依赖：Pillow。用法：python scripts/generate_favicons.py
"""
import os
import struct
from io import BytesIO
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, 'frontend', 'public')
SRC = os.path.join(PUBLIC, 'logo-outline-bold.png')

MASTER = 1024          # 合成主图尺寸
PAD_RATIO = 0.75       # 标记占画布比例（留白；调大会糊，调小会看不清）
CORNER = 0.22          # 圆角比例
ICO_SIZES = [(16, 16), (32, 32), (48, 48)]

# 品牌色（对齐 antd colorPrimary #1D4ED8 与光标主色 #60A5FA）
C_TOP = (29, 78, 216)     # #1D4ED8
C_BOTTOM = (96, 165, 250) # #60A5FA
FG = (255, 255, 255)


def load_logo():
    """裁掉透明边距，仅保留图形内容。"""
    im = Image.open(SRC).convert('RGBA')
    bbox = im.split()[3].point(lambda v: 255 if v > 8 else 0).getbbox()
    return im.crop(bbox)


def build_mark(size, bg_rgb):
    """在透明背景上生成白色标记，尺寸为 size 像素见方。"""
    logo = load_logo()
    inner = max(1, round(size * PAD_RATIO))
    scale = inner / max(logo.size)
    ns = (max(1, round(logo.width * scale)), max(1, round(logo.height * scale)))

    # 白色前景 + 原 alpha 作掩膜；阈值化消除灰边，保证降采样后边缘干净
    alpha = logo.resize(ns, Image.LANCZOS).split()[3].point(lambda v: 255 if v > 128 else 0)
    mark = Image.new('RGBA', ns, (0, 0, 0, 0))
    mark.paste(Image.new('RGBA', ns, FG + (255,)), (0, 0), alpha)
    return mark


def make_master():
    """合成 1024px 主图：品牌蓝渐变圆角方块 + 居中白色标记。"""
    canvas = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))

    grad = Image.new('RGB', (MASTER, MASTER))
    px = grad.load()
    for y in range(MASTER):
        t = y / (MASTER - 1)
        color = tuple(round(C_TOP[i] + (C_BOTTOM[i] - C_TOP[i]) * t) for i in range(3))
        for x in range(MASTER):
            px[x, y] = color

    mask = Image.new('L', (MASTER, MASTER), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, MASTER - 1, MASTER - 1], radius=round(MASTER * CORNER), fill=255)
    canvas.paste(grad, (0, 0), mask)

    mark = build_mark(MASTER, C_TOP)
    canvas.alpha_composite(mark, ((MASTER - mark.width) // 2, (MASTER - mark.height) // 2))
    return canvas


def make_tile(px):
    """直接按目标像素生成单尺寸图标（ICO 内层需精确尺寸）。"""
    mark = build_mark(px, C_TOP)
    canvas = Image.new('RGBA', (px, px), (0, 0, 0, 0))

    grad = Image.new('RGB', (px, px))
    gpx = grad.load()
    for y in range(px):
        t = y / (px - 1) if px > 1 else 0
        color = tuple(round(C_TOP[i] + (C_BOTTOM[i] - C_TOP[i]) * t) for i in range(3))
        for x in range(px):
            gpx[x, y] = color

    mask = Image.new('L', (px, px), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, px - 1, px - 1], radius=round(px * CORNER), fill=255)
    canvas.paste(grad, (0, 0), mask)
    canvas.alpha_composite(mark, ((px - mark.width) // 2, (px - mark.height) // 2))
    return canvas


def sanitize_alpha_rgb(im):
    """把完全透明区域的 RGB 填成品牌色，避免黑边。

    部分浏览器（尤其处理 .ico 时）会忽略 alpha 直接采用 RGB 采样，
    透明区若残留黑色 RGB 就会渲染出黑角。用边缘品牌色填充即可消除。
    """
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                px[x, y] = C_TOP + (0,)
    return im


def build_ico(frames, path):
    """手工写 ICO 容器（ICONDIR + ICONDIRENTRY* + 每帧 PNG）。

    不用 Pillow 的 `save(sizes=[...])`：该参数会自行降采样生成各内层帧，
    绕过 sanitize_alpha_rgb，使透明区残留脏 RGB（实测 48px 帧有 48 个脏像素），
    在忽略 alpha 直接采样 RGB 的浏览器上会渲染成黑边。
    这里逐帧自行清理后再嵌入，行为完全可控。
    """
    count = len(frames)
    offset = 6 + 16 * count
    entries, datas = b'', b''
    for im in frames:
        buf = BytesIO()
        im.save(buf, format='PNG')
        data = buf.getvalue()
        w, h = im.size
        entries += struct.pack('<BBBBHHII',
                               w if w < 256 else 0, h if h < 256 else 0,
                               0, 0, 1, 32, len(data), offset)
        datas += data
        offset += len(data)
    with open(path, 'wb') as f:
        f.write(struct.pack('<HHH', 0, 1, count) + entries + datas)


def save_all(master):
    # ICO：多尺寸打包，供旧浏览器（IE / 旧 Edge）使用
    frames = []
    for s, _ in ICO_SIZES:
        tile = sanitize_alpha_rgb(master.resize((s, s), Image.LANCZOS))
        frames.append(tile)
    build_ico(frames, os.path.join(PUBLIC, 'favicon.ico'))

    for s in (16, 32, 48, 96):
        tile = master.resize((s, s), Image.LANCZOS)
        sanitize_alpha_rgb(tile).save(
            os.path.join(PUBLIC, 'favicon-%dx%d.png' % (s, s)))

    # apple-touch-icon 必须不透明（iOS 会把透明区渲染成黑色）
    tile180 = make_tile(180)
    flat = Image.new('RGB', (180, 180), C_TOP)
    flat.paste(tile180, (0, 0), tile180)
    flat.save(os.path.join(PUBLIC, 'apple-touch-icon.png'))

    for s in (192, 512):
        tile = master.resize((s, s), Image.LANCZOS)
        sanitize_alpha_rgb(tile).save(
            os.path.join(PUBLIC, 'android-chrome-%dx%d.png' % (s, s)))


def write_manifest():
    manifest = '''{
  "name": "NCSE 刷题系统",
  "short_name": "NCSE",
  "icons": [
    {
      "src": "/android-chrome-192x192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/android-chrome-512x512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    }
  ],
  "theme_color": "#1D4ED8",
  "background_color": "#0F172A",
  "display": "standalone",
  "start_url": "/"
}
'''
    with open(os.path.join(PUBLIC, 'site.webmanifest'), 'w', encoding='utf-8') as f:
        f.write(manifest)


if __name__ == '__main__':
    m = make_master()
    save_all(m)
    write_manifest()
    print('favicon 资源已生成：')
    for f in sorted(os.listdir(PUBLIC)):
        if 'favicon' in f or 'apple-touch' in f or 'android-chrome' in f or 'webmanifest' in f:
            print('  %-32s %6d bytes' % (f, os.path.getsize(os.path.join(PUBLIC, f))))