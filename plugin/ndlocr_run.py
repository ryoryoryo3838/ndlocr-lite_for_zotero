# NDLOCR-Lite の ocr.py を、透明テキスト付き PDF の書き出し方だけ差し替えて実行する。
#   python ndlocr_run.py <ocr.py のパス> <ocr.py の引数…>
#
# NDLOCR-Lite はページだけを新しい PDF に移して文字の層を重ねるため、しおり・文書情報などが消える。
# ここでは元の PDF に文字の層を増分更新（incremental update）として追記する。元のバイト列は先頭にそのまま残る。
# 失敗したとき（暗号化 PDF など）は NDLOCR-Lite 本来の書き出しに戻す。
# NDLOCR-Lite 1.4.0 と 2.0.0 で確認した内部関数（embed_text_layer_pdf, _draw_text_layer_line）に依存している。
import os
import sys

ocr_py = sys.argv[1]
sys.path.insert(0, os.path.dirname(os.path.abspath(ocr_py)))
import ocr  # noqa: E402

_original_embed = ocr.embed_text_layer_pdf


def embed_incremental(input_pdf, output_pdf, page_results, visible_text=False):
    try:
        from io import BytesIO
        from pypdf import PdfReader, PdfWriter
        from reportlab.pdfgen import canvas
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont

        pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5", isVertical=False))
        pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3", isVertical=True))
        writer = PdfWriter(input_pdf, incremental=True)
        if len(writer.pages) != len(page_results):
            raise ValueError("ページ数が OCR 結果と合いません")
        buf = BytesIO()
        c = canvas.Canvas(buf)
        transforms = []
        for page, res in zip(writer.pages, page_results):
            # PDFium renders the intersection of CropBox and MediaBox, after
            # applying /Rotate. Draw in that displayed coordinate system, then
            # map the overlay back into the original page's user space.
            media, crop = page.mediabox, page.cropbox
            left = max(float(media.left), float(crop.left))
            bottom = max(float(media.bottom), float(crop.bottom))
            right = min(float(media.right), float(crop.right))
            top = min(float(media.top), float(crop.top))
            width, height = right - left, top - bottom
            rotation = int(page.rotation) % 360
            if width <= 0 or height <= 0 or rotation not in (0, 90, 180, 270):
                raise ValueError("Unsupported PDF page geometry")
            if rotation == 0:
                w, h, transform = width, height, (1, 0, 0, 1, left, bottom)
            elif rotation == 90:
                w, h, transform = height, width, (0, 1, -1, 0, right, bottom)
            elif rotation == 180:
                w, h, transform = width, height, (-1, 0, 0, -1, right, top)
            else:
                w, h, transform = height, width, (0, -1, 1, 0, left, top)
            transforms.append(transform)
            c.setPageSize((w, h))
            for line in res["text_layer_lines"]:
                ocr._draw_text_layer_line(
                    canvas_obj=c, line=line, img_width=res["img_width"], img_height=res["img_height"],
                    page_width=w, page_height=h, visible=visible_text,
                )
            c.showPage()
        c.save()
        buf.seek(0)
        for page, overlay, transform in zip(writer.pages, PdfReader(buf).pages, transforms):
            page.merge_transformed_page(overlay, transform, expand=False)
        with open(output_pdf, "wb") as f:
            writer.write(f)
        print("[INFO] Text layer appended as an incremental update", flush=True)
    except Exception as e:
        print(f"[WARN] Incremental update failed ({e}); using NDLOCR-Lite's PDF output", flush=True)
        _original_embed(input_pdf, output_pdf, page_results, visible_text)


ocr.embed_text_layer_pdf = embed_incremental
sys.argv = [ocr_py] + sys.argv[2:]
ocr.main()
