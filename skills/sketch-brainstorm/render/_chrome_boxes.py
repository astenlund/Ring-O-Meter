"""Shared chrome-footer checkbox layout and mode-set declarations.

Single source of truth for the page-chrome interaction boxes
(Finish-turn, End-session, mode-switch trio) and the canonical
render-mode tuple. Imported by both stroke-based detection
(`detect_marks.py`) and pixel-based pre-fill reading (`read_prefill.py`)
so the coordinates cannot drift across the two consumers.

This module is intentionally dependency-free at import time: no
rmscene, no fitz, no third-party packages. Both consumer venvs can
import it.

LOCKSTEP with `page-chrome.css`. Any coordinate change in the
stylesheet must update the matching tuple below in the same commit;
the inverse-transform in `detect_marks.inverse_transform_box` and the
pixel sampling in `read_prefill.read_prefill` both consume these
values verbatim.
"""

# Finish-turn box in PDF coordinates: (x, y, w, h).
FINISH_TURN_BOX_PDF = (1540.0, 2100.0, 40.0, 40.0)

# End-session box in PDF coordinates. Sits 60 px above Finish-turn,
# right-aligned so the user's pen lands at the same column.
END_SESSION_BOX_PDF = (1540.0, 2040.0, 40.0, 40.0)

# Mode-switch trio: three 40x40 boxes in the left half of the chrome
# footer, horizontally at x=80, 240, 400 / y=2100 on each page.
MODE_COLOR_BOX_PDF     = (80.0,  2100.0, 40.0, 40.0)
MODE_BW_BOX_PDF        = (240.0, 2100.0, 40.0, 40.0)
MODE_WIREFRAME_BOX_PDF = (400.0, 2100.0, 40.0, 40.0)

# Canonical render-mode tuple. Mirrored as `VALID_MODES` in `render.mjs`
# (JS cannot import from Python); a contract test in
# `test_render_format.mjs` asserts the two stay in sync.
VALID_MODES = ("color", "bw", "wireframe")

# Mode-switch box names in BOX_REGISTRY. Order matches VALID_MODES so
# `MODE_BOX_NAMES[i]` corresponds to `VALID_MODES[i]`.
MODE_BOX_NAMES = tuple(f"mode_{m}" for m in VALID_MODES)

# Detector box registry: maps box names to PDF rectangles. Mode-switch
# entries are ordered to match MODE_BOX_NAMES.
BOX_REGISTRY = {
    "finish_turn":    FINISH_TURN_BOX_PDF,
    "end_session":    END_SESSION_BOX_PDF,
    "mode_color":     MODE_COLOR_BOX_PDF,
    "mode_bw":        MODE_BW_BOX_PDF,
    "mode_wireframe": MODE_WIREFRAME_BOX_PDF,
}
