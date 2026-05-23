"""OCR provider interface and implementations.

Single file for now; split into a package if/when a third provider lands.
"""

import io
import os
import re
import struct
from abc import ABC, abstractmethod

from pydantic import BaseModel


class Detection(BaseModel):
    text: str
    bbox: list[float]  # [x, y, w, h] in pixel coords
    confidence: float


class OcrProvider(ABC):
    @abstractmethod
    def detect(self, image_bytes: bytes) -> list[Detection]:
        ...


class OcrConfigurationError(RuntimeError):
    """Raised when a provider is selected but its configuration is incomplete."""


def _png_size(data: bytes) -> tuple[int, int]:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return (0, 0)
    return struct.unpack(">II", data[16:24])


class StubProvider(OcrProvider):
    """Deterministic fake detections so the pipeline renders end-to-end at zero cost.

    Emits a mix of real LF codes and noise tokens (EM / VS) to prove the
    LF regex filter works.
    """

    def detect(self, image_bytes: bytes) -> list[Detection]:
        width, height = _png_size(image_bytes)
        if width == 0 or height == 0:
            width, height = 1275, 1650

        bw = max(80, width // 16)
        bh = max(30, height // 60)

        seeds = [
            ("LF1", 0.96),
            ("LF2", 0.94),
            ("LF3", 0.92),
            ("LF4", 0.91),
            ("LF7-X", 0.88),
            ("EM", 0.85),
            ("VS", 0.83),
        ]
        out: list[Detection] = []
        for i, (text, conf) in enumerate(seeds):
            col = i % 4
            row = i // 4
            x = int(width * (0.08 + 0.22 * col))
            y = int(height * (0.12 + 0.25 * row))
            out.append(Detection(text=text, bbox=[x, y, bw, bh], confidence=conf))
        return out


# Tiling: ~letter-page sized tile, small overlap so text on a tile boundary
# is fully visible in at least one tile. Dedup buckets the box center to
# this many pixels so the same token from two overlapping tiles collapses.
_TILE_SIZE = 1500
_TILE_OVERLAP = 200
_DEDUP_BUCKET = 30


class DocumentAiProvider(OcrProvider):
    """Google Document AI OCR. Tiles large images so small fixture tags
    don't get downsampled away on big drawings."""

    def __init__(self) -> None:
        project_id = os.getenv("GCP_PROJECT_ID")
        location = os.getenv("GCP_LOCATION")
        processor_id = os.getenv("DOCAI_PROCESSOR_ID")
        creds_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")

        missing = [
            name
            for name, val in [
                ("GCP_PROJECT_ID", project_id),
                ("GCP_LOCATION", location),
                ("DOCAI_PROCESSOR_ID", processor_id),
                ("GOOGLE_APPLICATION_CREDENTIALS", creds_path),
            ]
            if not val
        ]
        if missing:
            raise OcrConfigurationError(
                "Document AI requires env vars: " + ", ".join(missing)
            )

        try:
            from google.api_core.client_options import ClientOptions
            from google.cloud import documentai_v1 as documentai
        except ImportError as exc:
            raise OcrConfigurationError(
                "google-cloud-documentai is not installed (check requirements.txt)"
            ) from exc

        self._documentai = documentai
        self._client = documentai.DocumentProcessorServiceClient(
            client_options=ClientOptions(
                api_endpoint=f"{location}-documentai.googleapis.com"
            )
        )
        self._processor_name = self._client.processor_path(
            project_id, location, processor_id  # type: ignore[arg-type]
        )

    def detect(self, image_bytes: bytes) -> list[Detection]:
        width, height = _png_size(image_bytes)
        if width == 0 or height == 0:
            raise OcrConfigurationError(
                "Could not parse PNG dimensions; provider expects a PNG input"
            )

        if width <= _TILE_SIZE and height <= _TILE_SIZE:
            return _rejoin_lf7_subcodes(
                self._detect_image(image_bytes, offset_x=0, offset_y=0)
            )

        from PIL import Image

        img = Image.open(io.BytesIO(image_bytes))
        x_starts = _tile_starts(width, _TILE_SIZE, _TILE_OVERLAP)
        y_starts = _tile_starts(height, _TILE_SIZE, _TILE_OVERLAP)

        seen: set[tuple[str, int, int]] = set()
        out: list[Detection] = []
        for ty in y_starts:
            for tx in x_starts:
                tw = min(_TILE_SIZE, width - tx)
                th = min(_TILE_SIZE, height - ty)
                tile_img = img.crop((tx, ty, tx + tw, ty + th))
                buf = io.BytesIO()
                tile_img.save(buf, format="PNG")
                for det in self._detect_image(
                    buf.getvalue(), offset_x=tx, offset_y=ty
                ):
                    cx = round((det.bbox[0] + det.bbox[2] / 2) / _DEDUP_BUCKET)
                    cy = round((det.bbox[1] + det.bbox[3] / 2) / _DEDUP_BUCKET)
                    key = (det.text, cx, cy)
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append(det)
        return _rejoin_lf7_subcodes(out)

    def _detect_image(
        self, image_bytes: bytes, *, offset_x: int, offset_y: int
    ) -> list[Detection]:
        """OCR one image; translate every bbox by (offset_x, offset_y)."""
        width, height = _png_size(image_bytes)
        raw_doc = self._documentai.RawDocument(
            content=image_bytes, mime_type="image/png"
        )
        request = self._documentai.ProcessRequest(
            name=self._processor_name, raw_document=raw_doc
        )
        result = self._client.process_document(request=request)
        document = result.document
        full_text = document.text or ""

        detections: list[Detection] = []
        for page in document.pages:
            for token in page.tokens:
                text = _extract_layout_text(token.layout, full_text)
                if not text:
                    continue
                bbox = _normalized_poly_to_pixel_bbox(
                    token.layout.bounding_poly, width, height
                )
                if bbox is None:
                    continue
                shifted = [bbox[0] + offset_x, bbox[1] + offset_y, bbox[2], bbox[3]]
                confidence = float(token.layout.confidence or 1.0)
                detections.append(
                    Detection(text=text, bbox=shifted, confidence=confidence)
                )
        return detections


def _extract_layout_text(layout, full_text: str) -> str:
    anchor = getattr(layout, "text_anchor", None)
    if anchor is None or not anchor.text_segments:
        return ""
    parts: list[str] = []
    for seg in anchor.text_segments:
        start = int(seg.start_index) if seg.start_index else 0
        end = int(seg.end_index) if seg.end_index else len(full_text)
        parts.append(full_text[start:end])
    return "".join(parts).strip()


def _normalized_poly_to_pixel_bbox(
    bounding_poly, width: int, height: int
) -> list[float] | None:
    verts = list(bounding_poly.normalized_vertices)
    if not verts:
        return None
    xs = [float(v.x) * width for v in verts]
    ys = [float(v.y) * height for v in verts]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    return [x_min, y_min, x_max - x_min, y_max - y_min]


_LF7_TOKEN_RE = re.compile(r"^LF7$")
_DASH_DIGIT_TOKEN_RE = re.compile(r"^-\d$")


def _rejoin_lf7_subcodes(detections: list[Detection]) -> list[Detection]:
    """Document AI often splits `LF7-3` into separate `LF7` and `-3` tokens.
    Find LF7 + -digit pairs on the same line with a small horizontal gap
    and emit a merged `LF7-N` detection so the regex in main.py accepts it.
    """
    pairings: dict[int, int] = {}
    used_dashes: set[int] = set()
    for i, det in enumerate(detections):
        if not _LF7_TOKEN_RE.match(det.text):
            continue
        lx, ly, lw, lh = det.bbox
        lf_cy = ly + lh / 2
        best = -1
        best_gap = float("inf")
        for j, cand in enumerate(detections):
            if j in used_dashes or not _DASH_DIGIT_TOKEN_RE.match(cand.text):
                continue
            cx, cy, cw, ch = cand.bbox
            if cx < lx + lw * 0.5:
                continue
            gap = cx - (lx + lw)
            if gap > lh:
                continue
            if abs((cy + ch / 2) - lf_cy) > lh * 0.6:
                continue
            if gap < best_gap:
                best_gap = gap
                best = j
        if best >= 0:
            pairings[i] = best
            used_dashes.add(best)

    if not pairings:
        return detections

    merged: list[Detection] = []
    for i, det in enumerate(detections):
        if i in used_dashes:
            continue
        if i in pairings:
            cand = detections[pairings[i]]
            lx, ly, lw, lh = det.bbox
            cx, cy, cw, ch = cand.bbox
            y0 = min(ly, cy)
            y1 = max(ly + lh, cy + ch)
            merged.append(
                Detection(
                    text=det.text + cand.text,
                    bbox=[lx, y0, (cx + cw) - lx, y1 - y0],
                    confidence=min(det.confidence, cand.confidence),
                )
            )
        else:
            merged.append(det)
    return merged


def _tile_starts(length: int, tile_size: int, overlap: int) -> list[int]:
    if length <= tile_size:
        return [0]
    step = tile_size - overlap
    starts: list[int] = []
    pos = 0
    while pos + tile_size < length:
        starts.append(pos)
        pos += step
    starts.append(length - tile_size)
    return starts


_provider_cache: dict[str, OcrProvider] = {}


def get_provider() -> OcrProvider:
    name = os.getenv("OCR_PROVIDER", "stub").lower()
    cached = _provider_cache.get(name)
    if cached is not None:
        return cached
    if name == "stub":
        provider: OcrProvider = StubProvider()
    elif name == "documentai":
        provider = DocumentAiProvider()
    else:
        raise OcrConfigurationError(f"Unknown OCR provider: {name!r}")
    _provider_cache[name] = provider
    return provider
