import os

import fitz
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

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


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/render")
async def render_pdf(
    file: UploadFile = File(...),
    page: int = Form(DEFAULT_PAGE_INDEX),
    dpi: int = Form(DEFAULT_RENDER_DPI),
):
    if dpi <= 0 or dpi > MAX_RENDER_DPI:
        raise HTTPException(
            status_code=400,
            detail=f"dpi must be in (0, {MAX_RENDER_DPI}]",
        )

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")

    try:
        doc = fitz.open(stream=data, filetype="pdf")
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
        matrix = fitz.Matrix(zoom, zoom)
        pix = doc.load_page(page).get_pixmap(matrix=matrix, alpha=False)
        png_bytes = pix.tobytes("png")
        width, height = pix.width, pix.height
    finally:
        doc.close()

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "X-Image-Width": str(width),
            "X-Image-Height": str(height),
            "X-Page-Index": str(page),
            "X-Page-Count": str(page_count),
        },
    )
