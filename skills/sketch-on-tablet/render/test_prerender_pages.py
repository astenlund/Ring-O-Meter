import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[2]  # render/ -> sketch-on-tablet/ -> skills/ -> repo
_WRAPPER = _REPO_ROOT / "skills" / "sketch-on-tablet" / "render-html-to-pdf.sh"
_PRERENDER = _HERE / "prerender-pages.py"


class PrerenderPagesTest(unittest.TestCase):
    def test_two_page_pdf_produces_two_pngs(self):
        # Use a known-good PDF from the test fixtures or render one fresh.
        # Render a fresh smoke PDF via the existing pipeline:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            pdf_path = tmp / "smoke.pdf"
            subprocess.run(
                [
                    "bash",
                    str(_WRAPPER),
                    "--topic",
                    "prerender test",
                    "--iteration",
                    "00",
                    "--out",
                    str(pdf_path),
                ],
                check=True,
            )

            out_dir = tmp / "out"
            out_dir.mkdir()
            subprocess.run(
                [
                    sys.executable,
                    str(_PRERENDER),
                    "--pdf",
                    str(pdf_path),
                    "--out-dir",
                    str(out_dir),
                    "--prefix",
                    "smoke-00",
                ],
                check=True,
            )

            page1 = out_dir / "smoke-00-page1.png"
            page2 = out_dir / "smoke-00-page2.png"
            self.assertTrue(page1.exists(), f"missing {page1}")
            self.assertTrue(page2.exists(), f"missing {page2}")

            with Image.open(page1) as img1:
                self.assertEqual(img1.size, (1620, 2160))
            with Image.open(page2) as img2:
                self.assertEqual(img2.size, (1620, 2160))


if __name__ == "__main__":
    unittest.main()
