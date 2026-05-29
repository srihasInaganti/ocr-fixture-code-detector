# OCR Fixture Code Detector

A web app for extracting lighting-fixture codes from electrical drawings.

Upload a PDF of an electrical lighting plan, and the app renders the page,
runs OCR, and surfaces only the fixture codes you care about — `LF1`–`LF15`
plus `LF7-X` — each one tagged with a pixel bounding box drawn over the
rendered drawing. Click a code to highlight its box, adjust or relabel boxes
in-session if the OCR got something wrong, then export the results to JSON or
CSV.

**Live demo:** <https://ocr-fixture-code-detector.vercel.app>

## How it works

1. The PDF is rasterized to a high-resolution image on the server.
2. An OCR provider returns every recognized token with pixel-space bounding
   boxes.
3. A regex filter (`^LF(\d{1,2}|7-X)$`) keeps only the lighting-fixture codes
   and drops circuit numbers, EM / VS / D tags, and other noise.
4. The frontend overlays the boxes on the rendered drawing and lists the
   codes with counts and confidence scores.

## Tech stack

- **Backend:** Python + FastAPI on [Render](https://render.com), with
  [PyMuPDF](https://pymupdf.readthedocs.io/) for PDF rendering.
- **Frontend:** React + Vite + TypeScript on [Vercel](https://vercel.com).
- **OCR:** Google Document AI
