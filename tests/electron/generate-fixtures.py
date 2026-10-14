"""Optional fixture regeneration; synthetic documents, no user content."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from pypdf import PdfReader, PdfWriter

destination = Path(__file__).parent / "fixtures"
destination.mkdir(exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
document = canvas.Canvas(str(destination / "sample.pdf"), invariant=1)
for page in range(1, 4):
    document.setFont("Helvetica", 20)
    document.drawString(60, 740, f"PDF preview verification - page {page}")
    document.setFont("Helvetica", 14)
    document.drawString(60, 690, f"Searchable phrase: study coach page {page}")
    document.setFont("STSong-Light", 16)
    document.drawString(60, 640, "中文 PDF 阅读验证：学习与工作")
    document.rect(60, 540, 300, 50)
    document.showPage()
document.save()
document = canvas.Canvas(str(destination / "second.pdf"), invariant=1)
document.setFont("Helvetica", 20)
document.drawString(60, 740, "Second document: one page only")
document.save()
writer = PdfWriter()
writer.append(PdfReader(destination / "second.pdf"))
writer.encrypt("test-password")
with (destination / "encrypted.pdf").open("wb") as output:
    writer.write(output)
(destination / "broken.pdf").write_bytes(b"%PDF-1.7\nsynthetic damaged document\n%%EOF\n")
