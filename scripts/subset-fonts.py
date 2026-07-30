#!/usr/bin/env python3
"""Regenerate the two-part web faces both UIs serve from `fonts-src/`.

Each licensed face in `fonts-src/` is split into two woff2 files declared with
complementary `unicode-range`s in `explorer-ui/src/styles/global.css` and
`preis-ui/src/styles/global.css`:

  <Face>-latin.woff2  ASCII + Latin-1 Supplement + every symbol the apps draw
                      (dashes, quotes, ellipsis, arrows, triangles, math
                      relations, currency, and the U+2080-2089 subscript digits
                      behind the 0.0(5)7191 notation). This is what real pages
                      need, so it is the only half a page normally fetches.
  <Face>-ext.woff2    Everything else the licensed face covers - Latin
                      Extended-A/B/Additional, combining diacritics, Greek,
                      Cyrillic, CJK punctuation, fullwidth forms. Fetched only
                      when a page actually contains one of those codepoints, so
                      an accented or Cyrillic identity name still renders in the
                      brand face instead of falling back to a system font.

Coverage is therefore unchanged from the unsplit faces; only transfer shrinks.
The script asserts that conservation per face rather than trusting it.

Hinting is deliberately kept. Gazpacho and Geist each spend roughly half their
`glyf` bytes on TrueType bytecode, and dropping it saves a further ~9kB per face,
but it also moves the rounded advance widths: measured against the source faces,
an unhinted Gazpacho specimen drifted up to 11px over a 900px string. Page titles
are Gazpacho, and where a title wraps is exactly what the preload in
`explorer-ui/index.html` exists to stabilise, so the bytes are not worth
re-opening that layout shift. With hinting kept, the split faces render
pixel-identically to the source faces at identical advance widths.

Requires `fonttools` and `brotli` (`pip install fonttools brotli`); it is a
one-off asset step, not part of `npm run check`.
"""
import os
import sys
import glob

from fontTools.ttLib import TTFont
from fontTools import subset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "fonts-src")
OUT_DIRS = [
    os.path.join(ROOT, "explorer-ui", "public", "fonts"),
    os.path.join(ROOT, "preis-ui", "public", "fonts"),
]

# The faces the two stylesheets actually declare. GazpachoBlack and GeistBold
# are licensed but unreferenced, so they are not shipped.
FACES = [
    "GazpachoRegular", "GazpachoMedium", "GazpachoBold",
    "GeistRegular", "GeistMedium", "GeistSemiBold",
    "GeistMonoRegular", "GeistMonoMedium", "GeistMonoSemiBold",
]
# Kept in the `-latin` half. Latin-1 stays because product copy and API text use
# the middle dot, multiplication sign, plus-minus and degree signs on ordinary
# pages -- moving them out would make almost every page fetch the `-ext` half.
LATIN_RANGES = [
    (0x0000, 0x007F),  # C0 + ASCII
    (0x00A0, 0x00FF),  # Latin-1 Supplement
    (0x2013, 0x2014), (0x2018, 0x201E), (0x2020, 0x2022), (0x2026, 0x2026),
    (0x2030, 0x2030), (0x2039, 0x203A), (0x2044, 0x2044),
    (0x2070, 0x209F),  # super/subscripts, incl. U+2080-2089
    (0x20A0, 0x20BF),  # currency
    (0x2100, 0x218F),  # letterlike, number forms
    (0x2190, 0x21FF),  # arrows
    (0x2200, 0x22FF),  # math operators
    (0x2300, 0x23FF),  # misc technical (U+2304 down arrowhead)
    (0x25A0, 0x25FF),  # geometric shapes (triangles, circles, squares)
    (0x2700, 0x27BF),  # dingbats (U+2715 multiplication x)
    (0xFB00, 0xFB4F),  # fi/fl ligatures
    (0xFFFD, 0xFFFD),
]
LATIN = {c for a, b in LATIN_RANGES for c in range(a, b + 1)}


def css_ranges(cps):
    """Compact a codepoint set into a CSS `unicode-range` value."""
    out, cps = [], sorted(cps)
    i = 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        out.append(f"U+{cps[i]:04X}" if i == j else f"U+{cps[i]:04X}-{cps[j]:04X}")
        i = j + 1
    return ", ".join(out)


def build(face, out_dir):
    src = os.path.join(SRC, face + ".woff2")
    with TTFont(src, lazy=True) as f:
        covered = set(f.getBestCmap())
    halves = {"latin": covered & LATIN, "ext": covered - LATIN}
    written, regained = {}, set()
    for half, cps in halves.items():
        path = os.path.join(out_dir, f"{face}-{half}.woff2")
        if not cps:
            if os.path.exists(path):
                os.remove(path)
            continue
        args = [
            src, "--flavor=woff2", f"--output-file={path}",
            "--unicodes=" + ",".join(f"U+{c:04X}" for c in sorted(cps)),
            # Keep shaping (kerning, ligatures) and the full name table so the
            # licence and designer records survive into the shipped file.
            "--layout-features=*", "--name-IDs=*", "--name-legacy",
            "--drop-tables+=FFTM", "--notdef-outline", "--recalc-bounds",
        ]
        subset.main(args)
        with TTFont(path, lazy=True) as f:
            regained |= set(f.getBestCmap())
        written[half] = (os.path.getsize(path), css_ranges(cps))
    assert regained == covered, (
        f"{face}: the two halves no longer cover the source face "
        f"(missing {sorted(covered - regained)[:8]}, extra {sorted(regained - covered)[:8]})"
    )
    return os.path.getsize(src), written


def main():
    if not os.path.isdir(SRC):
        sys.exit(f"missing {SRC}")
    for out_dir in OUT_DIRS:
        os.makedirs(out_dir, exist_ok=True)
        # Drop any previously shipped face so an unreferenced file cannot linger.
        for stale in glob.glob(os.path.join(out_dir, "*.woff2")):
            os.remove(stale)
    rows = []
    for face in FACES:
        for out_dir in OUT_DIRS:
            src_size, written = build(face, out_dir)
        rows.append((face, src_size, written))

    print(f"{'face':22s} {'source':>7s} {'latin':>7s} {'ext':>7s} {'first-paint saving':>19s}")
    tot = [0, 0, 0]
    for face, src_size, w in rows:
        lat = w.get("latin", (0, ""))[0]
        ext = w.get("ext", (0, ""))[0]
        print(f"{face:22s} {src_size:7d} {lat:7d} {ext:7d} {src_size - lat:19d}")
        tot[0] += src_size
        tot[1] += lat
        tot[2] += ext
    print(f"{'TOTAL':22s} {tot[0]:7d} {tot[1]:7d} {tot[2]:7d} {tot[0] - tot[1]:19d}")

    print("\nunicode-range for the -latin half (identical for every face):")
    print("  " + rows[0][2]["latin"][1])
    print("\nunicode-range for each -ext half:")
    for face, _, w in rows:
        print(f"  {face}: {w['ext'][1] if 'ext' in w else '(none)'}")


if __name__ == "__main__":
    main()
