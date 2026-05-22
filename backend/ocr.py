"""OCR provider interface and stub implementation.

A single file for now; split into a package when the second real provider lands
in Chunk 4.
"""

import os
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


def get_provider() -> OcrProvider:
    name = os.getenv("OCR_PROVIDER", "stub").lower()
    if name == "stub":
        return StubProvider()
    raise ValueError(f"Unknown OCR provider: {name!r}")
