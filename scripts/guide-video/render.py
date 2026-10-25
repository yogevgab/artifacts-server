"""Render the rtfx guide video from the redacted screenshots.

Usage: GUIDE_SHOTS=<png folder> python3 render.py [out.mp4] [--preview]
Then upload (see src/media.ts) and bump MEDIA_VERSION.
Frames are piped straight into ffmpeg (H.264, yuv420p, +faststart).
"""
import math, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

G = os.environ.get("GUIDE_SHOTS", "guide-shots")  # folder of the original PNG screenshots
W, H, FPS = 1920, 1080, 30
PREVIEW = "--preview" in sys.argv
OUT = next((a for a in sys.argv[1:] if a.endswith(".mp4")), "rtfx-guide.mp4")

SF = "/System/Library/Fonts/SFNS.ttf"
MONO = "/System/Library/Fonts/SFNSMono.ttf"
def font(size, path=SF, weight=None):
    f = ImageFont.truetype(path, size)
    if weight:
        try: f.set_variation_by_axes([weight])
        except Exception: pass
    return f

INK = (17, 24, 39); MUTED = (90, 99, 116); ACCENT = (11, 99, 206)
BG_TOP = (246, 248, 252); BG_BOT = (232, 238, 248)

def background():
    bg = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(bg)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(round(BG_TOP[i] * (1 - t) + BG_BOT[i] * t) for i in range(3)))
    return bg
BG = background()

# --- scenes -----------------------------------------------------------------
# (image, part label, caption, [(x, y, action)]) — coordinates in the image's own pixels.
SCENES = [
    ("01-add-custom-connector-clean.png", "A · Connect", "In Claude: Customize → Connectors → + Add → Add custom connector",
     [(1237, 95, "click"), (1262, 150, "click")]),
    ("02-connector-details.png", "A · Connect", "Name it rtfx, paste https://mcp.rtfx.pro/mcp, then Continue",
     [(300, 167, "click"), (300, 270, "click"), (722, 576, "click")]),
    ("03-authentication-defaults.png", "A · Connect", "Keep the detected defaults, then Add",
     [(38, 318, "hover"), (38, 690, "hover")]),
    ("04-connect.png", "A · Connect", "Click Connect", [(482, 510, "click")]),
    ("05-allow-access.png", "A · Connect", "Sign in to rtfx, then Allow access", [(418, 835, "click")]),
    ("06-connected.png", "A · Connect", "Connected — rtfx is ready in every chat", [(820, 255, "hover")]),
    ("07-allow-publish.png", "B · Publish", "Ask Claude to make something and “publish it with rtfx” — Allow once",
     [(905, 723, "click")]),
    ("08-published-link.png", "B · Publish", "Claude replies with your private link", [(700, 250, "hover")]),
    ("09-artifact.png", "B · Publish", "Your artifact — only you can open it until you share it", [(1129, 14, "click")]),
    ("10-share.png", "C · Share", "Add people as Viewer or Editor — or create a named share link",
     [(500, 226, "click"), (562, 520, "click"), (115, 566, "hover")]),
    ("PHONE", "C · Share", "What the recipient sees: the page, straight away — no sign-in", []),
    ("11-views.png", "D · Views", "See who opened it, when, through which link, on what device", [(460, 143, "hover")]),
]

def load(name):
    if name == "PHONE":
        im = Image.open(os.path.join(G, "raw-recipient-phone.png")).convert("RGB").crop((0, 0, 1170, 1700))
        return im
    return Image.open(os.path.join(G, name)).convert("RGB")

# Screenshot area: leave room for the top bar (110px) and caption (170px).
BOX = (110, 120, W - 110, H - 190)

def rounded(im, r):
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.width - 1, im.height - 1], r, fill=255)
    return mask

def compose(name):
    """Static scene (no cursor/caption): background + screenshot card. Returns (img, rect, scale)."""
    shot = load(name)
    bw, bh = BOX[2] - BOX[0], BOX[3] - BOX[1]
    s = min(bw / shot.width, bh / shot.height, 1.6 if name != "PHONE" else 10)
    if name == "PHONE":
        s = min(bh / shot.height, 1.0)
    sw, sh = round(shot.width * s), round(shot.height * s)
    shot = shot.resize((sw, sh), Image.LANCZOS)
    x = BOX[0] + (bw - sw) // 2; y = BOX[1] + (bh - sh) // 2
    img = BG.copy()
    r = 40 if name == "PHONE" else 18
    shadow = Image.new("L", (sw + 120, sh + 120), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([60, 70, 60 + sw, 70 + sh], r, fill=70)
    shadow = shadow.filter(ImageFilter.GaussianBlur(26))
    img.paste((150, 160, 185), (x - 60, y - 60), shadow)
    img.paste(shot, (x, y), rounded(shot, r))
    ImageDraw.Draw(img).rounded_rectangle([x, y, x + sw - 1, y + sh - 1], r, outline=(214, 220, 232), width=2)
    return img, (x, y, sw, sh), s

# --- cursor -----------------------------------------------------------------
def cursor_sprite(scale=1.0):
    pts = [(0, 0), (0, 34), (8, 26), (14, 40), (20, 37), (14, 24), (25, 24)]
    S = 3  # supersample
    im = Image.new("RGBA", (40 * S, 50 * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    p = [(4 * S + x * S, 3 * S + y * S) for x, y in pts]
    sh = Image.new("RGBA", im.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x + 2 * S, y + 3 * S) for x, y in p], fill=(0, 0, 0, 90))
    sh = sh.filter(ImageFilter.GaussianBlur(2 * S))
    im = Image.alpha_composite(im, sh)
    d = ImageDraw.Draw(im)
    d.polygon(p, fill=(255, 255, 255, 255))
    d.line(p + [p[0]], fill=(20, 20, 20, 255), width=int(2.2 * S), joint="curve")
    size = (round(40 * scale), round(50 * scale))
    return im.resize(size, Image.LANCZOS)
CURSOR = cursor_sprite(1.15)
CURSOR_DOWN = cursor_sprite(1.0)

def ease(t):
    t = max(0.0, min(1.0, t))
    return 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2

# --- overlays ----------------------------------------------------------------
F_CAP = font(44); F_LABEL = font(26); F_BRAND = font(34); F_NUM = font(26)
def overlay(frame, label, caption, idx, total, alpha=1.0):
    d = ImageDraw.Draw(frame, "RGBA")
    a = int(255 * alpha)
    # top bar
    bw = d.textlength("rtfx", font=F_BRAND); pw = d.textlength(".pro", font=F_BRAND)
    d.rounded_rectangle([88, 38, 132 + bw + pw, 94], 26, fill=(255, 255, 255, int(235 * alpha)), outline=(214, 220, 232, a))
    d.text((110, 46), "rtfx", font=F_BRAND, fill=(*INK, a))
    d.text((110 + bw, 46), ".pro", font=F_BRAND, fill=(*MUTED, a))
    lw = d.textlength(label, font=F_LABEL)
    d.rounded_rectangle([W - 110 - lw - 40, 44, W - 110, 88], 22, fill=(255, 255, 255, int(230 * alpha)), outline=(214, 220, 232, a))
    d.text((W - 110 - lw - 20, 52), label, font=F_LABEL, fill=(*ACCENT, a))
    # caption
    num = f"{idx}"
    cw = d.textlength(caption, font=F_CAP)
    total_w = cw + 70
    x0 = (W - total_w) / 2; y0 = H - 135
    d.rounded_rectangle([x0 - 22, y0 - 16, x0 + total_w + 26, y0 + 72], 44, fill=(255, 255, 255, int(240 * alpha)), outline=(214, 220, 232, a), width=2)
    d.ellipse([x0, y0 + 2, x0 + 52, y0 + 54], fill=(*ACCENT, a))
    nw = d.textlength(num, font=F_NUM)
    d.text((x0 + 26 - nw / 2, y0 + 12), num, font=F_NUM, fill=(255, 255, 255, a))
    d.text((x0 + 70, y0 + 2), caption, font=F_CAP, fill=(*INK, a))
    # progress
    d.rounded_rectangle([96, H - 46, W - 96, H - 28], 9, fill=(255, 255, 255, int(220 * alpha)))
    d.rounded_rectangle([110, H - 40, W - 110, H - 34], 3, fill=(214, 220, 232, a))
    d.rounded_rectangle([110, H - 40, 110 + (W - 220) * idx / total, H - 34], 3, fill=(*ACCENT, a))

def zoomed(img, z, fx, fy):
    """Crop around (fx, fy) at zoom z and scale back to full frame."""
    if z <= 1.001:
        return img.copy()
    cw, ch = W / z, H / z
    x = min(max(fx - cw / 2, 0), W - cw); y = min(max(fy - ch / 2, 0), H - ch)
    return img.resize((W, H), Image.BILINEAR, box=(x, y, x + cw, y + ch)), (x, y, cw, ch)

def to_frame(px, py, view):
    if view is None:
        return px, py
    x, y, cw, ch = view
    return (px - x) * W / cw, (py - y) * H / ch

def title_card(lines, sub=None):
    img = BG.copy(); d = ImageDraw.Draw(img)
    f1 = font(92); f2 = font(40); fm = font(38, MONO)
    y = 330
    for ln in lines:
        w = d.textlength(ln, font=f1); d.text(((W - w) / 2, y), ln, font=f1, fill=INK); y += 112
    if sub:
        y += 30
        w = d.textlength(sub, font=fm) + 60
        d.rounded_rectangle([(W - w) / 2, y, (W + w) / 2, y + 76], 18, fill=(255, 255, 255), outline=(214, 220, 232), width=2)
        d.text(((W - w) / 2 + 30, y + 16), sub, font=fm, fill=INK)
    return img

# --- render ----------------------------------------------------------------
def run():
    ff = subprocess.Popen([
        "ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
        "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-tune", "stillimage", OUT], stdin=subprocess.PIPE)
    def emit(img, n=1):
        b = img.convert("RGB").tobytes()
        for _ in range(n): ff.stdin.write(b)

    sec = lambda s: max(1, round(s * FPS))
    intro = title_card(["Publish from Claude", "to a private link"], "https://mcp.rtfx.pro/mcp")
    emit(intro, sec(2.6))
    prev_last = intro
    cur = (W * 0.62, H * 0.62)
    total = len(SCENES)
    for i, (name, label, caption, targets) in enumerate(SCENES, 1):
        if PREVIEW and i > 3: break
        base, (rx, ry, rw, rh), s = compose(name)
        pts = [(rx + x * s, ry + y * s, a) for x, y, a in targets]
        # crossfade in
        first = base.copy(); overlay(first, label, caption, i, total)
        for k in range(sec(0.45)):
            emit(Image.blend(prev_last, first, ease((k + 1) / sec(0.45))))
        z = 1.0; view = None; focus = (W / 2, H / 2)
        frame = first
        show_cursor = name != "PHONE"
        if not targets:
            emit(first, sec(2.6)); prev_last = first; continue
        emit(first, sec(0.5))
        for (tx, ty, act) in pts:
            # move (and ease the camera in towards the target)
            sx, sy = cur; n = sec(0.95)
            z0, f0 = z, focus
            # Zoom in for legibility, but never so far that the screenshot is cut at the sides.
            z1 = max(1.0, min(1.28, 0.96 * W / (rw + 80)))
            for k in range(n):
                t = ease((k + 1) / n)
                cx = sx + (tx - sx) * t; cy = sy + (ty - sy) * t - math.sin(math.pi * t) * 40
                z = z0 + (z1 - z0) * t
                focus = (f0[0] + (tx - f0[0]) * t, f0[1] + (ty - f0[1]) * t)
                res = zoomed(base, z, *focus)
                fr, view = (res if isinstance(res, tuple) else (res, None))
                fx, fy = to_frame(cx, cy, view)
                fr.paste(CURSOR, (int(fx), int(fy)), CURSOR)
                overlay(fr, label, caption, i, total)
                emit(fr)
            cur = (tx, ty)
            res = zoomed(base, z, *focus); fr0, view = (res if isinstance(res, tuple) else (res, None))
            fx, fy = to_frame(tx, ty, view)
            if act == "click":
                for k in range(sec(0.45)):
                    t = (k + 1) / sec(0.45)
                    fr = fr0.copy(); d = ImageDraw.Draw(fr, "RGBA")
                    rad = 12 + 46 * t
                    d.ellipse([fx - rad, fy - rad, fx + rad, fy + rad], outline=(*ACCENT, int(220 * (1 - t))), width=6)
                    d.ellipse([fx - 14, fy - 14, fx + 14, fy + 14], fill=(*ACCENT, int(110 * (1 - t))))
                    spr = CURSOR_DOWN if t < 0.35 else CURSOR
                    fr.paste(spr, (int(fx), int(fy)), spr)
                    overlay(fr, label, caption, i, total); emit(fr)
            else:
                fr = fr0.copy(); fr.paste(CURSOR, (int(fx), int(fy)), CURSOR); overlay(fr, label, caption, i, total)
                emit(fr, sec(0.5))
            frame = fr0
        last = frame.copy()
        fx, fy = to_frame(*cur, view)
        last.paste(CURSOR, (int(fx), int(fy)), CURSOR); overlay(last, label, caption, i, total)
        emit(last, sec(1.1))
        # zoom back out to full for the next transition, keeping the cursor in base coordinates
        prev_last = last
        cur = (cur[0], cur[1])
    outro = title_card(["Try it in your Claude"], "rtfx.pro/guide")
    for k in range(sec(0.5)):
        emit(Image.blend(prev_last, outro, ease((k + 1) / sec(0.5))))
    emit(outro, sec(2.4))
    ff.stdin.close(); ff.wait()
    print("wrote", OUT)

if __name__ == "__main__":
    run()
