#!/usr/bin/env python3
"""
delayer.py — turn a Photoshop PSD into independently-animatable web layers.

This is the exact pipeline used to build the Madame site. It has two modes:

  1) INSPECT  — render every layer to a labelled contact sheet + list, so you
                can see which (generically named) layer is the hand, the swirl,
                the background, etc.

  2) EXPORT   — given the layer indices, write three web-optimised WebP assets
                per page plus a manifest with each layer's exact canvas
                position, so the page lines up pixel-for-pixel with the PSD.

The model we settled on: only the HAND needs to animate, so each page is just
   background plate (cream + glow + swirl behind)  ← everything except hand+front
 + hand cut-out                                    ← the one animated layer
 + front swirl strand                              ← weaves over the forearm
with the text added on top in HTML/CSS (sharper, and lets the cursive
underlines/circles "draw" themselves with SVG).

Requirements:  pip install psd-tools pillow numpy scipy
  (scipy is needed because these PSDs use gradient adjustment layers.)

USAGE
  Inspect a file (writes contact_<name>.png + prints the layer table):
      python delayer.py inspect "Design/b 2.psd"

  Export one page's assets into ./assets:
      python delayer.py export "Design/b 2.psd" --slug step2 \
             --hand 21 --front 22

  --back is optional; by default the plate = everything except --hand/--front.
"""
import argparse, os, json, sys
from psd_tools import PSDImage
from PIL import Image, ImageDraw, ImageFont
import numpy as np
Image.MAX_IMAGE_PIXELS = None

ADJUSTMENT = ("huesaturation", "vibrance", "brightnesscontrast",
              "curves", "levels", "gradientmap", "colorbalance")


def visible_content_layers(psd):
    """Yield (idx, layer, coverage%) for layers that actually draw pixels."""
    for i, l in enumerate(psd):
        if not l.visible or l.kind in ADJUSTMENT:
            continue
        try:
            im = l.composite().convert("RGBA")
        except Exception:
            continue
        cov = float((np.asarray(im)[:, :, 3] > 10).mean() * 100)
        if cov >= 0.3:
            yield i, l, im, cov


def inspect(path):
    psd = PSDImage.open(path)
    name = os.path.splitext(os.path.basename(path))[0].replace(" ", "_")
    cells = []
    print(f"\n{os.path.basename(path)}  canvas={psd.size}")
    print(f"{'idx':>3}  {'name':24} {'cov%':>5}  position (l,t,w,h)")
    for i, l, im, cov in visible_content_layers(psd):
        x1, y1, x2, y2 = l.bbox
        print(f"{i:>3}  {l.name[:24]:24} {cov:5.1f}  {x1},{y1},{x2-x1},{y2-y1}")
        th = im.copy(); th.thumbnail((430, 430))
        bg = Image.new("RGBA", th.size, (255, 255, 255, 255))
        d = ImageDraw.Draw(bg); s = 18
        for yy in range(0, th.height, s):
            for xx in range(0, th.width, s):
                if (xx // s + yy // s) % 2 == 0:
                    d.rectangle([xx, yy, xx + s, yy + s], fill=(214, 214, 214, 255))
        bg.alpha_composite(th); cells.append((bg, f"#{i} {l.name} {cov:.0f}%"))
    cols = 3; cw = 460; ch = 360; rows = (len(cells) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cw, rows * ch), (28, 28, 28))
    d = ImageDraw.Draw(sheet)
    try:
        fnt = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 16)
    except Exception:
        fnt = ImageFont.load_default()
    for i, (im, lbl) in enumerate(cells):
        r, c = divmod(i, cols); x, y = c * cw + 10, r * ch + 26
        sheet.paste(im, (x, y)); d.text((x, y - 20), lbl[:46], fill=(255, 230, 0), font=fnt)
    out = f"contact_{name}.png"; sheet.save(out)
    print(f"\n-> wrote {out}  (open it to identify hand / swirl / background)")


def _save_webp(img, path, q):
    img.save(path, "WEBP", quality=q, method=6)


def _export_layer(path, idx, out, maxw, q):
    psd = PSDImage.open(path)
    layer = list(psd)[idx]
    im = layer.composite().convert("RGBA")
    x1, y1, x2, y2 = layer.bbox
    if im.width > maxw:
        im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
    _save_webp(im, out, q)
    return {"file": os.path.basename(out), "left": x1, "top": y1,
            "width": x2 - x1, "height": y2 - y1}


def export(path, slug, hand, front, back, outdir, plate_w):
    os.makedirs(outdir, exist_ok=True)
    man_path = os.path.join(outdir, "manifest.json")
    manifest = json.load(open(man_path)) if os.path.exists(man_path) else {}

    # 1) background plate = composite with hand + front hidden
    psd = PSDImage.open(path)
    CW, CH = psd.size
    hide = {hand, front}
    for i, l in enumerate(psd):
        l.visible = (i not in hide)
    plate = psd.composite().convert("RGB")
    plate = plate.resize((plate_w, round(CH * plate_w / CW)), Image.LANCZOS)
    _save_webp(plate, os.path.join(outdir, f"{slug}-bg.webp"), 84)

    # 2) the hand (animated) and 3) the front swirl strand
    h = _export_layer(path, hand, os.path.join(outdir, f"{slug}-hand.webp"), 1600, 88)
    f = _export_layer(path, front, os.path.join(outdir, f"{slug}-front.webp"), 1500, 88)
    h["file"] = f"assets/{slug}-hand.webp"; f["file"] = f"assets/{slug}-front.webp"

    manifest[slug] = {"canvas": [CW, CH], "bg": f"assets/{slug}-bg.webp",
                      "hand": h, "front": f}
    json.dump(manifest, open(man_path, "w"), indent=2)
    print(f"{slug}: wrote bg/hand/front to {outdir}  (hand at "
          f"{h['left']/CW*100:.2f}%,{h['top']/CH*100:.2f}%  w {h['width']/CW*100:.2f}%)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    insp = sub.add_parser("inspect"); insp.add_argument("psd")
    exp = sub.add_parser("export"); exp.add_argument("psd")
    exp.add_argument("--slug", required=True)
    exp.add_argument("--hand", type=int, required=True)
    exp.add_argument("--front", type=int, required=True)
    exp.add_argument("--back", type=int, default=None)  # reserved / unused
    exp.add_argument("--out", default="assets")
    exp.add_argument("--plate-w", type=int, default=2400)
    a = ap.parse_args()
    if a.cmd == "inspect":
        inspect(a.psd)
    else:
        export(a.psd, a.slug, a.hand, a.front, a.back, a.out, a.plate_w)
