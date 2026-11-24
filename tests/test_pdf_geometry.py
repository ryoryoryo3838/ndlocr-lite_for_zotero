"""Regression tests against PDFium's actual cropped, rotated raster coordinates."""
import io
import os
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

import pypdfium2
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

def _newest_src(install_dir):
    """インストール先でいちばん新しい NDLOCR-Lite の src（ndlocr-lite-<版>/ か、0.2.x で作った ndlocr-lite/）"""
    found = []
    for name in os.listdir(install_dir):
        marker = os.path.join(install_dir, name, '.installed-version')
        if (name == 'ndlocr-lite' or name.startswith('ndlocr-lite-')) and os.path.isfile(marker):
            version = open(marker).read().strip()
            found.append((tuple(int(x) if x.isdigit() else 0 for x in version.replace('-', '.').split('.')), name))
    return os.path.join(install_dir, max(found)[1], 'src')


OCR_SRC = os.environ.get('NDLOCR_OCR_SRC') or _newest_src(os.environ['NDLOCR_DIR'])
sys.path.insert(0, OCR_SRC)
import ocr

with patch.object(ocr, 'main'), patch.object(ocr, 'embed_text_layer_pdf'), patch.object(sys, 'argv', ['ndlocr_run.py', os.path.join(OCR_SRC, 'ocr.py')]):
    runner = runpy.run_path(os.path.join(os.path.dirname(__file__), '..', 'plugin', 'ndlocr_run.py'))


def raster(path):
    document = pypdfium2.PdfDocument(str(path))
    image = next(iter(document.render(pypdfium2.PdfBitmap.to_pil, page_indices=[0], scale=2))).convert('RGB')
    return document, image


def pixels(image, predicate):
    return [(x, y) for y in range(image.height) for x in range(image.width) if predicate(*image.getpixel((x, y)))]


class PdfGeometryTest(unittest.TestCase):
    def test_cropped_rotated_overlay_aligns_with_pdfium_raster(self):
        cases = [
            ('crop', (20, 30, 380, 280), (60, 70, 320, 250)),
            ('crop-outside-media', (20, 30, 380, 280), (-20, 70, 420, 250)),
            ('no-crop', (-20, -30, 380, 280), None),
        ]
        for name, media, crop, rotation in ((name, media, crop, rotation)
                                            for name, media, crop in cases
                                            for rotation in (0, 90, 180, 270)):
            with self.subTest(case=name, rotation=rotation), tempfile.TemporaryDirectory() as temp:
                original = os.path.join(temp, 'source.pdf')
                buf = io.BytesIO()
                c = canvas.Canvas(buf, pagesize=(400, 300))
                c.setFillColorRGB(1, 0, 0)
                c.rect(125, 110, 100, 25, fill=1, stroke=0)
                c.showPage()
                c.save()
                writer = PdfWriter()
                page = writer.add_page(PdfReader(io.BytesIO(buf.getvalue())).pages[0])
                page.mediabox.lower_left = media[:2]
                page.mediabox.upper_right = media[2:]
                if crop:
                    page.cropbox.lower_left = crop[:2]
                    page.cropbox.upper_right = crop[2:]
                page.rotate(rotation)
                writer.add_metadata({'/Title': 'Geometry metadata'})
                writer.add_outline_item('Bookmark', 0)
                with open(original, 'wb') as f:
                    writer.write(f)
                doc, image = raster(original)
                red = pixels(image, lambda r, g, b: r > 240 and g < 15 and b < 15)
                x0, x1 = min(x for x, y in red), max(x for x, y in red)
                y0, y1 = min(y for x, y in red), max(y for x, y in red)
                results = [{'img_width': image.width, 'img_height': image.height,
                            'text_layer_lines': [{'text': 'ALIGN', 'x': x0, 'y': y0,
                                                  'width': x1-x0+1, 'height': y1-y0+1,
                                                  'is_vertical': False}]}]
                output = os.path.join(temp, 'output.pdf')
                runner['embed_incremental'](original, output, results, visible_text=True)
                with open(original, 'rb') as f:
                    source = f.read()
                with open(output, 'rb') as f:
                    self.assertTrue(f.read().startswith(source))
                reader = PdfReader(output)
                self.assertEqual(reader.metadata.title, 'Geometry metadata')
                self.assertEqual(reader.outline[0].title, 'Bookmark')
                outdoc, outimage = raster(output)
                blue = pixels(outimage, lambda r, g, b: b > 150 and r < 100 and g < 100)
                self.assertTrue(blue, 'visible OCR text missing')
                inside = sum(x0 <= x <= x1 and y0 <= y <= y1 for x, y in blue)
                self.assertGreater(inside / len(blue), 0.85, f'blue text does not align with red OCR region: {inside}/{len(blue)}')
                textpage = outdoc[0].get_textpage()
                self.assertIn('ALIGN', textpage.get_text_bounded())
                invisible = os.path.join(temp, 'invisible.pdf')
                runner['embed_incremental'](original, invisible, results, visible_text=False)
                with open(invisible, 'rb') as f:
                    self.assertTrue(f.read().startswith(source))
                self.assertEqual(PdfReader(invisible).metadata.title, 'Geometry metadata')
                indoc, inimage = raster(invisible)
                self.assertEqual(image.tobytes(), inimage.tobytes())
                intext = indoc[0].get_textpage()
                self.assertIn('ALIGN', intext.get_text_bounded())
                self.assertEqual(textpage.get_charbox(0), intext.get_charbox(0))
                doc.close()
                outdoc.close()
                indoc.close()


if __name__ == '__main__':
    unittest.main()
