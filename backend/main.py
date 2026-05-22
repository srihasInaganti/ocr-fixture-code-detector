import base64
import os
import re

import fitz
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from ocr import OcrConfigurationError, get_provider

app = FastAPI(title="OCR Fixture Code Detector")

allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]

IMAGE_HEADERS = ["X-Image-Width", "X-Image-Height", "X-Page-Index", "X-Page-Count"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=IMAGE_HEADERS,
)

DEFAULT_PAGE_INDEX = int(os.getenv("DEFAULT_PAGE_INDEX", "0"))
# Defaults are tuned for Render's free tier (512 MB). 300+ DPI on a 24x36"
# drawing will OOM the process. Override via env if you upgrade the plan.
DEFAULT_RENDER_DPI = int(os.getenv("DEFAULT_RENDER_DPI", "150"))
MAX_RENDER_DPI = int(os.getenv("MAX_RENDER_DPI", "300"))

LF_CODE = re.compile(r"^LF(\d{1,2}|7-X)$")


@app.get("/health")
def health():
    return {"status": "ok"}


def _render_page(pdf_bytes: bytes, page: int, dpi: int) -> tuple[bytes, int, int, int]:
    """Returns (png_bytes, width, height, page_count)."""
    if dpi <= 0 or dpi > MAX_RENDER_DPI:
        raise HTTPException(
            status_code=400, detail=f"dpi must be in (0, {MAX_RENDER_DPI}]"
        )
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Empty upload")

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not open PDF: {exc}")

    try:
        page_count = doc.page_count
        if page < 0 or page >= page_count:
            raise HTTPException(
                status_code=400,
                detail=f"page {page} out of range (PDF has {page_count} pages)",
            )
        zoom = dpi / 72.0
        pix = doc.load_page(page).get_pixmap(
            matrix=fitz.Matrix(zoom, zoom), alpha=False
        )
        return pix.tobytes("png"), pix.width, pix.height, page_count
    finally:
        doc.close()


@app.post("/render")
async def render_pdf(
    file: UploadFile = File(...),
    page: int = Form(DEFAULT_PAGE_INDEX),
    dpi: int = Form(DEFAULT_RENDER_DPI),
):
    data = await file.read()
    png, width, height, page_count = _render_page(data, page, dpi)
    return Response(
        content=png,
        media_type="image/png",
        headers={
            "X-Image-Width": str(width),
            "X-Image-Height": str(height),
            "X-Page-Index": str(page),
            "X-Page-Count": str(page_count),
        },
    )


class DetectionOut(BaseModel):
    id: str
    text: str
    bbox: list[float]
    confidence: float


class DetectResponse(BaseModel):
    image: str  # base64-encoded PNG
    imageMime: str
    width: int
    height: int
    page: int
    pageCount: int
    detections: list[DetectionOut]
    counts: dict[str, int]


@app.post("/detect", response_model=DetectResponse)
async def detect(
    file: UploadFile = File(...),
    page: int = Form(DEFAULT_PAGE_INDEX),
    dpi: int = Form(DEFAULT_RENDER_DPI),
):
    data = await file.read()
    png, width, height, page_count = _render_page(data, page, dpi)

    try:
        provider = get_provider()
        raw = provider.detect(png)
    except OcrConfigurationError as exc:
        raise HTTPException(status_code=500, detail=f"OCR misconfigured: {exc}")

    filtered = [d for d in raw if LF_CODE.match(d.text)]

    counts: dict[str, int] = {}
    detections_out: list[DetectionOut] = []
    for i, d in enumerate(filtered):
        detections_out.append(
            DetectionOut(
                id=f"det-{i}", text=d.text, bbox=d.bbox, confidence=d.confidence
            )
        )
        counts[d.text] = counts.get(d.text, 0) + 1

    return DetectResponse(
        image=base64.b64encode(png).decode("ascii"),
        imageMime="image/png",
        width=width,
        height=height,
        page=page,
        pageCount=page_count,
        detections=detections_out,
        counts=counts,
    )
