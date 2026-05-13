"""Derive the .rm-to-PDF scale from a five-dot calibration pull.

One-time ceremony: the user marks five reference dots on a
calibration PDF (rendered by calibration-template.html). The
pulled .rm file contains five strokes. This script reduces each
stroke to its centroid, matches the five centroids to the five
expected dots via minimum-weight one-to-one assignment, derives
a single uniform scale from the median of per-dot ratios, and
verifies the result by re-projecting each centroid through the
derived transform.

On success, writes calibration.json to the caller-supplied output path
(derive-calibration.sh passes skills/sketch-brainstorm/calibration.json
by convention). On failure, emits a per-dot diagnostic on stderr and
exits non-zero.

Algorithm details (see remarkable-tablet-brainstorm.md "Hand-off
protocol: stroke-region checkbox detector > Calibration ceremony"
for the design rationale):

  step 4a  count guard: exactly 5 strokes required
  step 4b  centroid per stroke
  step 4c  one-to-one assignment (scipy linear_sum_assignment) with
           0.45 coarse bootstrap scale
  step 4d  scale_x = median over 4 corner ratios, scale_y = median
           over 5 ratios; final scale = average; reject 2% anisotropy
  step 5   re-project, reject 3 px residual
"""
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

from scipy.optimize import linear_sum_assignment

from _rm_strokes import PAGE_W, collect_lines, ordered_rm_files

# LOCKSTEP with calibration-template.html .dot style="left:Xpx; top:Ypx".
# If you change the margin or move any dot in the template, update the
# matching coordinates here and re-run the calibration ceremony.
EXPECTED_DOTS = [
    ("TL", 150.0, 150.0),
    ("TR", 1470.0, 150.0),
    ("BL", 150.0, 2010.0),
    ("BR", 1470.0, 2010.0),
    ("C", PAGE_W / 2, 1080.0),
]

BOOTSTRAP_SCALE = 0.45  # heuristic: bootstrap tolerance is wide (safe for ~0.30-0.65 real scales; see spec D6)
ASYMMETRY_THRESHOLD = 0.02  # heuristic: max tolerated x/y scale ratio before calibration is rejected
RESIDUAL_THRESHOLD_PX = 3.0  # heuristic: max per-dot re-projection error to accept calibration


def compute_centroid(points):
    """Mean (x, y) of a stroke's points."""
    if not points:
        raise ValueError("empty stroke; cannot compute centroid")
    n = len(points)
    cx = sum(p[0] for p in points) / n
    cy = sum(p[1] for p in points) / n

    return cx, cy


def collect_centroids(rm_dir):
    """Return a list of (cx, cy) centroids, one per stroke across
    all .rm files in rm_dir, in stroke-encounter order."""
    pages = ordered_rm_files(rm_dir)
    if len(pages) > 1:
        print(
            f"warning: calibration archive has {len(pages)} annotated pages; "
            f"expected 1. Extra pages contribute extra strokes and will likely "
            f"trigger a count-mismatch error.",
            file=sys.stderr,
        )
    centroids = []
    for _, rm_file in pages:
        for _color, _width, pts in collect_lines(rm_file):
            centroids.append(compute_centroid(pts))

    return centroids


def assign_centroids_to_dots(centroids):
    """Minimum-weight one-to-one assignment of centroids to expected
    dots, using BOOTSTRAP_SCALE to map .rm coordinates into approx
    PDF space for distance comparison.

    Returns a list of (label, expected_pdf, centroid_rm) tuples in
    EXPECTED_DOTS order. Raises ValueError on count mismatch.
    """
    if len(centroids) != len(EXPECTED_DOTS):
        raise ValueError(
            f"expected {len(EXPECTED_DOTS)} marks, found {len(centroids)}"
        )
    # Build cost matrix: rows = centroids, cols = expected dots.
    # Project centroids to approx PDF via bootstrap scale.
    cost = []
    for cx, cy in centroids:
        approx_pdf_x = cx * BOOTSTRAP_SCALE + PAGE_W / 2
        approx_pdf_y = cy * BOOTSTRAP_SCALE
        row = []
        for _, ex, ey in EXPECTED_DOTS:
            dx = approx_pdf_x - ex
            dy = approx_pdf_y - ey
            row.append(math.sqrt(dx * dx + dy * dy))
        cost.append(row)
    row_ind, col_ind = linear_sum_assignment(cost)
    # col_ind[i] = dot index assigned to centroid i
    # Reorder so output is in EXPECTED_DOTS order.
    by_dot = [None] * len(EXPECTED_DOTS)
    for centroid_i, dot_i in zip(row_ind, col_ind):
        label, ex, ey = EXPECTED_DOTS[dot_i]
        by_dot[dot_i] = (label, (ex, ey), centroids[centroid_i])

    return by_dot


def derive_scale(pairs):
    """Compute scale_x (median over corner pairs only) and scale_y
    (median over all five pairs), then return their average.

    The center dot (label "C") has centroid_rm_x ≈ 0, which makes the
    x-ratio (ex - PAGE_W/2) / cx degenerate. Skip pairs where ex equals
    PAGE_W/2 from the scale_x ratio set.

    For x_ratios (4 corner dots), sorted()[len//2] picks the upper-middle
    value (index 2 of 4) rather than averaging the two middles. This is a
    deliberate floor-median; it produced correct calibration (residuals
    0.04-1.10 px) and is consistent with the spec's "median over 4 corner
    ratios" intent. For y_ratios (5 dots), len//2 = 2 is the exact middle.

    Raises ValueError on asymmetric scale (> ASYMMETRY_THRESHOLD).
    """
    x_ratios = []
    y_ratios = []
    for label, (ex, ey), (cx, cy) in pairs:
        if label != "C":  # skip center dot: rm-x ≈ 0 makes the x-ratio degenerate
            if cx == 0:
                raise ValueError(f"degenerate centroid at {label}: cx=0; stroke may cross the center axis")
            x_ratios.append((ex - PAGE_W / 2) / cx)
        if cy == 0:
            raise ValueError(f"degenerate centroid at {label}: cy=0; stroke may be at the page top edge")
        y_ratios.append(ey / cy)
    scale_x = sorted(x_ratios)[len(x_ratios) // 2]
    scale_y = sorted(y_ratios)[len(y_ratios) // 2]
    asymmetry = abs(scale_x - scale_y) / max(scale_x, scale_y)
    if asymmetry > ASYMMETRY_THRESHOLD:
        raise ValueError(
            f"asymmetric scale_x={scale_x:.4f} scale_y={scale_y:.4f} "
            f"(asymmetry={asymmetry:.4f}, threshold={ASYMMETRY_THRESHOLD})"
        )

    return (scale_x + scale_y) / 2


def verify_residuals(pairs, scale):
    """Re-project each centroid through the full transform and
    return a dict of {label: residual_px}. Raises ValueError if
    any residual exceeds RESIDUAL_THRESHOLD_PX.
    """
    residuals = {}
    for label, (ex, ey), (cx, cy) in pairs:
        pdf_x = cx * scale + PAGE_W / 2
        pdf_y = cy * scale
        residual = math.sqrt((pdf_x - ex) ** 2 + (pdf_y - ey) ** 2)
        residuals[label] = residual
    max_residual = max(residuals.values())
    if max_residual > RESIDUAL_THRESHOLD_PX:
        table = "; ".join(
            f"{label}: {r:.2f} px {'FAIL' if r > RESIDUAL_THRESHOLD_PX else 'ok'}"
            for label, r in residuals.items()
        )
        raise ValueError(
            f"residual exceeds {RESIDUAL_THRESHOLD_PX} px; per-dot: {table}"
        )

    return residuals


def derive(rm_dir, firmware_note):
    """Run the full calibration derivation against rm_dir and return
    the calibration.json payload as a dict. Raises ValueError on any
    rejection (count mismatch, asymmetric scale, residual too high)."""
    centroids = collect_centroids(rm_dir)
    pairs = assign_centroids_to_dots(centroids)
    scale = derive_scale(pairs)
    residuals = verify_residuals(pairs, scale)

    return {
        "scale": round(scale, 6),
        "firmware_note": firmware_note,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "residuals_px": {label: round(r, 2) for label, r in residuals.items()},
    }


def main():
    if len(sys.argv) != 4:
        print(
            "usage: derive_calibration.py <rm-dir> <firmware-note> <output-json>",
            file=sys.stderr,
        )
        return 1
    rm_dir = Path(sys.argv[1])
    firmware_note = sys.argv[2]
    output_json = Path(sys.argv[3])
    try:
        payload = derive(rm_dir, firmware_note)
    except ValueError as e:
        # ValueErrors carry diagnostic detail (count, asymmetry, residual
        # table). Surface to stderr as-is; the orchestrator forwards to
        # chat alongside the clear-page retry instruction.
        print(str(e), file=sys.stderr)
        return 1
    output_json.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"scale: {payload['scale']} (residuals max "
        f"{max(payload['residuals_px'].values()):.2f} px)"
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
