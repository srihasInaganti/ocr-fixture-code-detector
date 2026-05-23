import { useEffect, useMemo, useRef, useState } from "react";

type Detection = {
  id: string;
  text: string;
  bbox: [number, number, number, number];
  confidence: number;
};

type DetectState =
  | { kind: "idle" }
  | {
      kind: "rendering";
      file: File;
      fileName: string;
      page: number;
      prev: { imageUrl: string; width: number; height: number } | null;
    }
  | {
      kind: "preview";
      file: File;
      fileName: string;
      page: number;
      pageCount: number;
      imageUrl: string;
      width: number;
      height: number;
    }
  | {
      kind: "detecting";
      file: File;
      fileName: string;
      page: number;
      pageCount: number;
      imageUrl: string;
      width: number;
      height: number;
    }
  | {
      kind: "detected";
      file: File;
      fileName: string;
      imageUrl: string;
      width: number;
      height: number;
      page: number;
      pageCount: number;
      detections: Detection[];
    };

type AppError = { message: string; retry?: () => void };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export default function App() {
  const [state, setState] = useState<DetectState>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState("1");
  const [rotation, setRotation] = useState(0);
  const [hiddenCodes, setHiddenCodes] = useState<Set<string>>(new Set());
  const [drawMode, setDrawMode] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newBoxSeq = useRef(0);

  async function renderPage(file: File, page: number, rot: number) {
    if (!API_BASE_URL) return;
    const prior = state;
    const prev =
      prior.kind === "preview" ||
      prior.kind === "detecting" ||
      prior.kind === "detected"
        ? { imageUrl: prior.imageUrl, width: prior.width, height: prior.height }
        : null;
    setState({ kind: "rendering", file, fileName: file.name, page, prev });
    setSelectedId(null);
    setDrawMode(false);
    setPageInput(String(page + 1));
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("page", String(page));
      form.append("rotation", String(rot));
      const res = await fetch(`${API_BASE_URL}/render`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const width = Number(res.headers.get("X-Image-Width"));
      const height = Number(res.headers.get("X-Image-Height"));
      const pageCount = Number(res.headers.get("X-Page-Count"));
      const blob = await res.blob();
      const imageUrl = URL.createObjectURL(blob);
      setState({
        kind: "preview",
        file,
        fileName: file.name,
        page,
        pageCount,
        imageUrl,
        width,
        height,
      });
    } catch (err) {
      setState(prior);
      setError({
        message: err instanceof Error ? err.message : String(err),
        retry: () => {
          void renderPage(file, page, rot);
        },
      });
    }
  }

  async function runDetect() {
    if (state.kind !== "preview" && state.kind !== "detected") return;
    const prior = state;
    const { file, fileName, page, pageCount, imageUrl, width, height } = state;
    setState({
      kind: "detecting",
      file,
      fileName,
      page,
      pageCount,
      imageUrl,
      width,
      height,
    });
    setSelectedId(null);
    setDrawMode(false);
    setHiddenCodes(new Set());
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("page", String(page));
      form.append("rotation", String(rotation));
      const res = await fetch(`${API_BASE_URL}/detect`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const data = await res.json();
      setState({
        kind: "detected",
        file,
        fileName,
        imageUrl: `data:${data.imageMime};base64,${data.image}`,
        width: data.width,
        height: data.height,
        page: data.page,
        pageCount: data.pageCount,
        detections: data.detections,
      });
    } catch (err) {
      setState(prior);
      setError({
        message: err instanceof Error ? err.message : String(err),
        retry: () => {
          void runDetect();
        },
      });
    }
  }

  function goToPage(target: number) {
    const ctx = activeContext(state);
    if (!ctx) return;
    const clamped = Math.max(0, Math.min(ctx.pageCount - 1, target));
    if (clamped === ctx.page) return;
    void renderPage(ctx.file, clamped, rotation);
  }

  function rotate() {
    const next = (rotation + 90) % 360;
    setRotation(next);
    const ctx = activeContext(state);
    if (ctx) void renderPage(ctx.file, ctx.page, next);
  }

  function pickFile(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.type && file.type !== "application/pdf") {
      setError({ message: `Expected a PDF, got ${file.type}` });
      return;
    }
    void renderPage(file, 0, rotation);
  }

  function updateBox(id: string, bbox: [number, number, number, number]) {
    setState((s) =>
      s.kind === "detected"
        ? {
            ...s,
            detections: s.detections.map((d) =>
              d.id === id ? { ...d, bbox } : d,
            ),
          }
        : s,
    );
  }

  function deleteBox(id: string) {
    setState((s) =>
      s.kind === "detected"
        ? { ...s, detections: s.detections.filter((d) => d.id !== id) }
        : s,
    );
    if (selectedId === id) setSelectedId(null);
  }

  function relabelBox(id: string) {
    if (state.kind !== "detected") return;
    const current = state.detections.find((d) => d.id === id);
    if (!current) return;
    const next = window.prompt("New label:", current.text);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    setState((s) =>
      s.kind === "detected"
        ? {
            ...s,
            detections: s.detections.map((d) =>
              d.id === id ? { ...d, text: trimmed } : d,
            ),
          }
        : s,
    );
  }

  function addBox(bbox: [number, number, number, number]) {
    const label = window.prompt("Code label for new box:", "");
    setDrawMode(false);
    if (label == null) return;
    const trimmed = label.trim();
    if (!trimmed) return;
    const id = `new-${++newBoxSeq.current}`;
    setState((s) =>
      s.kind === "detected"
        ? {
            ...s,
            detections: [
              ...s.detections,
              { id, text: trimmed, bbox, confidence: 1.0 },
            ],
          }
        : s,
    );
    setSelectedId(id);
  }

  function toggleCodeVisibility(code: string) {
    setHiddenCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function exportJson() {
    if (state.kind !== "detected") return;
    const payload = {
      fileName: state.fileName,
      page: state.page,
      pageCount: state.pageCount,
      width: state.width,
      height: state.height,
      detections: state.detections,
    };
    downloadFile(
      JSON.stringify(payload, null, 2),
      `${baseName(state.fileName)}-page${state.page + 1}.json`,
      "application/json",
    );
  }

  function exportCsv() {
    if (state.kind !== "detected") return;
    const lines = ["id,text,x,y,width,height,confidence"];
    for (const d of state.detections) {
      lines.push(
        [
          csvCell(d.id),
          csvCell(d.text),
          d.bbox[0].toFixed(2),
          d.bbox[1].toFixed(2),
          d.bbox[2].toFixed(2),
          d.bbox[3].toFixed(2),
          d.confidence.toFixed(4),
        ].join(","),
      );
    }
    downloadFile(
      lines.join("\n"),
      `${baseName(state.fileName)}-page${state.page + 1}.csv`,
      "text/csv",
    );
  }

  function onDropFiles(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    pickFile(e.dataTransfer.files);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }
  function onDragLeave() {
    setDragOver(false);
  }

  const showToolbar =
    state.kind === "rendering" ||
    state.kind === "preview" ||
    state.kind === "detecting" ||
    state.kind === "detected";

  const fileInfo = activeFileInfo(state);

  return (
    <main className="app">
      <header className="app-header">
        <h1>OCR Fixture Code Detector</h1>
      </header>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        style={{ display: "none" }}
        onChange={(e) => pickFile(e.target.files)}
      />

      <section className="section">
        {fileInfo == null ? (
          <div
            className={`dropzone ${dragOver ? "drag-over" : ""}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDropFiles}
            onClick={() => fileInputRef.current?.click()}
          >
            <p>
              <strong>Drop a PDF here</strong>, or click to choose
            </p>
            <p className="dz-sub">
              Architectural lighting plans, electrical drawings, etc.
            </p>
          </div>
        ) : (
          <div
            className="file-strip"
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDropFiles}
            style={dragOver ? { borderColor: "var(--accent)" } : undefined}
          >
            <span className="icon">PDF</span>
            <span className="name">{fileInfo.fileName}</span>
            {fileInfo.pageCount !== null && (
              <span className="meta">
                · {fileInfo.pageCount} page
                {fileInfo.pageCount === 1 ? "" : "s"}
              </span>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="btn-sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Change file
            </button>
          </div>
        )}
      </section>

      {error && (
        <section className="section">
          <ErrorBanner error={error} onDismiss={() => setError(null)} />
        </section>
      )}

      {showToolbar && (
        <section className="section">
          <Toolbar
            state={state}
            pageInput={pageInput}
            onPageInputChange={setPageInput}
            rotation={rotation}
            onRotate={rotate}
            onPrev={() => goToPage(currentPage(state) - 1)}
            onNext={() => goToPage(currentPage(state) + 1)}
            onJump={() => {
              const n = Number(pageInput);
              if (Number.isFinite(n)) goToPage(n - 1);
            }}
            onRun={runDetect}
          />
        </section>
      )}

      <section className="section">
        {state.kind === "rendering" && state.prev && (
          <Viewer
            imageUrl={state.prev.imageUrl}
            width={state.prev.width}
            height={state.prev.height}
            fileName={state.fileName}
            page={state.page}
            pageCount={null}
            detections={[]}
            selectedId={null}
            hiddenCodes={new Set()}
            drawMode={false}
            editable={false}
            loading
            loadingLabel="Rendering"
            onSelect={() => {}}
            onMoveBox={() => {}}
            onAddBox={() => {}}
          />
        )}
        {state.kind === "rendering" && !state.prev && (
          <div className="status-message">
            <span className="spinner spinner-lg" />
            <span>
              Rendering <code>{state.fileName}</code>, page {state.page + 1}…
            </span>
          </div>
        )}
        {state.kind === "preview" && (
          <Viewer
            imageUrl={state.imageUrl}
            width={state.width}
            height={state.height}
            fileName={state.fileName}
            page={state.page}
            pageCount={state.pageCount}
            detections={[]}
            selectedId={null}
            hiddenCodes={new Set()}
            drawMode={false}
            editable={false}
            loading={false}
            onSelect={() => {}}
            onMoveBox={() => {}}
            onAddBox={() => {}}
          />
        )}
        {state.kind === "detecting" && (
          <Viewer
            imageUrl={state.imageUrl}
            width={state.width}
            height={state.height}
            fileName={state.fileName}
            page={state.page}
            pageCount={state.pageCount}
            detections={[]}
            selectedId={null}
            hiddenCodes={new Set()}
            drawMode={false}
            editable={false}
            loading
            loadingLabel="Running OCR"
            loadingVariant="ocr"
            onSelect={() => {}}
            onMoveBox={() => {}}
            onAddBox={() => {}}
          />
        )}
        {state.kind === "detected" && (
          <DetectionLayout
            state={state}
            selectedId={selectedId}
            hiddenCodes={hiddenCodes}
            drawMode={drawMode}
            onSelect={setSelectedId}
            onToggleDrawMode={() => setDrawMode((m) => !m)}
            onToggleCodeVisibility={toggleCodeVisibility}
            onMoveBox={updateBox}
            onAddBox={addBox}
            onDeleteBox={deleteBox}
            onRelabelBox={relabelBox}
            onExportJson={exportJson}
            onExportCsv={exportCsv}
          />
        )}
      </section>
    </main>
  );
}

function currentPage(state: DetectState): number {
  if (
    state.kind === "rendering" ||
    state.kind === "preview" ||
    state.kind === "detecting" ||
    state.kind === "detected"
  ) {
    return state.page;
  }
  return 0;
}

function activeContext(
  state: DetectState,
): { file: File; page: number; pageCount: number } | null {
  if (
    state.kind === "preview" ||
    state.kind === "detecting" ||
    state.kind === "detected"
  ) {
    return { file: state.file, page: state.page, pageCount: state.pageCount };
  }
  return null;
}

function activeFileInfo(
  state: DetectState,
): { fileName: string; pageCount: number | null } | null {
  if (state.kind === "idle") return null;
  if (state.kind === "rendering") {
    return { fileName: state.fileName, pageCount: null };
  }
  return { fileName: state.fileName, pageCount: state.pageCount };
}

function Toolbar({
  state,
  pageInput,
  onPageInputChange,
  rotation,
  onRotate,
  onPrev,
  onNext,
  onJump,
  onRun,
}: {
  state: DetectState;
  pageInput: string;
  onPageInputChange: (s: string) => void;
  rotation: number;
  onRotate: () => void;
  onPrev: () => void;
  onNext: () => void;
  onJump: () => void;
  onRun: () => void;
}) {
  const busy = state.kind === "rendering" || state.kind === "detecting";
  const ctx = activeContext(state);
  const page = currentPage(state);
  const pageCount = ctx?.pageCount ?? null;
  const canRun =
    (state.kind === "preview" || state.kind === "detected") && !busy;
  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button
          type="button"
          onClick={onPrev}
          disabled={busy || pageCount === null || page <= 0}
          title="Previous page"
        >
          ←
        </button>
        <span className="toolbar-page">
          <input
            type="number"
            min={1}
            max={pageCount ?? undefined}
            value={pageInput}
            onChange={(e) => onPageInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onJump();
            }}
            disabled={busy || pageCount === null}
          />
          <span>of {pageCount ?? "—"}</span>
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={busy || pageCount === null || page >= (pageCount ?? 0) - 1}
          title="Next page"
        >
          →
        </button>
      </div>
      <button type="button" onClick={onRotate} disabled={busy}>
        ↻ Rotate
        {rotation !== 0 && (
          <span style={{ marginLeft: 6, color: "var(--text-muted)" }}>
            {rotation}°
          </span>
        )}
      </button>
      <span className="toolbar-spacer" />
      <button
        type="button"
        className="btn-primary"
        onClick={onRun}
        disabled={!canRun}
      >
        {state.kind === "detecting" ? (
          <span className="inline-row">
            <span className="spinner spinner-on-primary" />
            Running OCR…
          </span>
        ) : state.kind === "detected" ? (
          "Re-run OCR"
        ) : (
          "Run OCR on this page"
        )}
      </button>
    </div>
  );
}

function DetectionLayout({
  state,
  selectedId,
  hiddenCodes,
  drawMode,
  onSelect,
  onToggleDrawMode,
  onToggleCodeVisibility,
  onMoveBox,
  onAddBox,
  onDeleteBox,
  onRelabelBox,
  onExportJson,
  onExportCsv,
}: {
  state: Extract<DetectState, { kind: "detected" }>;
  selectedId: string | null;
  hiddenCodes: Set<string>;
  drawMode: boolean;
  onSelect: (id: string | null) => void;
  onToggleDrawMode: () => void;
  onToggleCodeVisibility: (code: string) => void;
  onMoveBox: (id: string, bbox: [number, number, number, number]) => void;
  onAddBox: (bbox: [number, number, number, number]) => void;
  onDeleteBox: (id: string) => void;
  onRelabelBox: (id: string) => void;
  onExportJson: () => void;
  onExportCsv: () => void;
}) {
  return (
    <div className="detection-layout">
      <Viewer
        imageUrl={state.imageUrl}
        width={state.width}
        height={state.height}
        fileName={state.fileName}
        page={state.page}
        pageCount={state.pageCount}
        detections={state.detections}
        selectedId={selectedId}
        hiddenCodes={hiddenCodes}
        drawMode={drawMode}
        editable={true}
        loading={false}
        onSelect={onSelect}
        onMoveBox={onMoveBox}
        onAddBox={onAddBox}
      />
      <SidePanel
        detections={state.detections}
        selectedId={selectedId}
        hiddenCodes={hiddenCodes}
        drawMode={drawMode}
        onSelect={onSelect}
        onToggleDrawMode={onToggleDrawMode}
        onToggleCodeVisibility={onToggleCodeVisibility}
        onDeleteBox={onDeleteBox}
        onRelabelBox={onRelabelBox}
        onExportJson={onExportJson}
        onExportCsv={onExportCsv}
      />
    </div>
  );
}

type DragState =
  | {
      kind: "move";
      id: string;
      startImg: { x: number; y: number };
      startBox: [number, number, number, number];
    }
  | {
      kind: "resize";
      id: string;
      corner: "nw" | "ne" | "sw" | "se";
      startImg: { x: number; y: number };
      startBox: [number, number, number, number];
    }
  | {
      kind: "draw";
      startImg: { x: number; y: number };
      currentImg: { x: number; y: number };
    };

function Viewer({
  imageUrl,
  width,
  height,
  fileName,
  page,
  pageCount,
  detections,
  selectedId,
  hiddenCodes,
  drawMode,
  editable,
  loading,
  loadingLabel,
  loadingVariant = "render",
  onSelect,
  onMoveBox,
  onAddBox,
}: {
  imageUrl: string;
  width: number;
  height: number;
  fileName: string;
  page: number;
  pageCount: number | null;
  detections: Detection[];
  selectedId: string | null;
  hiddenCodes: Set<string>;
  drawMode: boolean;
  editable: boolean;
  loading: boolean;
  loadingLabel?: string;
  loadingVariant?: "render" | "ocr";
  onSelect: (id: string | null) => void;
  onMoveBox: (id: string, bbox: [number, number, number, number]) => void;
  onAddBox: (bbox: [number, number, number, number]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  function toImg(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * width,
      y: ((clientY - rect.top) / rect.height) * height,
    };
  }

  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      if (!drag) return;
      const pt = toImg(e.clientX, e.clientY);
      if (!pt) return;
      if (drag.kind === "move") {
        const dx = pt.x - drag.startImg.x;
        const dy = pt.y - drag.startImg.y;
        const [bx, by, bw, bh] = drag.startBox;
        onMoveBox(drag.id, [bx + dx, by + dy, bw, bh]);
      } else if (drag.kind === "resize") {
        const [bx, by, bw, bh] = drag.startBox;
        let nx = bx;
        let ny = by;
        let nw = bw;
        let nh = bh;
        if (drag.corner === "nw") {
          nx = pt.x;
          ny = pt.y;
          nw = bx + bw - pt.x;
          nh = by + bh - pt.y;
        } else if (drag.corner === "ne") {
          ny = pt.y;
          nw = pt.x - bx;
          nh = by + bh - pt.y;
        } else if (drag.corner === "sw") {
          nx = pt.x;
          nw = bx + bw - pt.x;
          nh = pt.y - by;
        } else if (drag.corner === "se") {
          nw = pt.x - bx;
          nh = pt.y - by;
        }
        if (nw > 4 && nh > 4) onMoveBox(drag.id, [nx, ny, nw, nh]);
      } else {
        setDrag({ ...drag, currentImg: pt });
      }
    }
    function onUp() {
      if (drag && drag.kind === "draw") {
        const x = Math.min(drag.startImg.x, drag.currentImg.x);
        const y = Math.min(drag.startImg.y, drag.currentImg.y);
        const w = Math.abs(drag.currentImg.x - drag.startImg.x);
        const h = Math.abs(drag.currentImg.y - drag.startImg.y);
        if (w > 4 && h > 4) onAddBox([x, y, w, h]);
      }
      setDrag(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, onMoveBox, onAddBox, width, height]);

  function onSvgPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (!editable) return;
    if (drawMode) {
      const pt = toImg(e.clientX, e.clientY);
      if (!pt) return;
      setDrag({ kind: "draw", startImg: pt, currentImg: pt });
    } else if (e.target === svgRef.current) {
      onSelect(null);
    }
  }

  function startMove(e: React.PointerEvent, det: Detection) {
    if (!editable || drawMode) return;
    e.stopPropagation();
    const pt = toImg(e.clientX, e.clientY);
    if (!pt) return;
    onSelect(det.id);
    setDrag({ kind: "move", id: det.id, startImg: pt, startBox: det.bbox });
  }

  function startResize(
    e: React.PointerEvent,
    det: Detection,
    corner: "nw" | "ne" | "sw" | "se",
  ) {
    if (!editable || drawMode) return;
    e.stopPropagation();
    const pt = toImg(e.clientX, e.clientY);
    if (!pt) return;
    setDrag({
      kind: "resize",
      id: det.id,
      corner,
      startImg: pt,
      startBox: det.bbox,
    });
  }

  const visible = detections.filter((d) => !hiddenCodes.has(d.text));
  const draftBox =
    drag?.kind === "draw"
      ? {
          x: Math.min(drag.startImg.x, drag.currentImg.x),
          y: Math.min(drag.startImg.y, drag.currentImg.y),
          w: Math.abs(drag.currentImg.x - drag.startImg.x),
          h: Math.abs(drag.currentImg.y - drag.startImg.y),
        }
      : null;
  const handleRadius = Math.max(width, height) / 120;

  return (
    <div className="viewer">
      <p className="meta">
        <code>{fileName}</code>
        {pageCount !== null && (
          <span>
            · page {page + 1} of {pageCount}
          </span>
        )}
        <span>
          · {width}×{height} px
        </span>
      </p>
      <div className={`image-wrap ${loading ? "dimmed" : ""}`}>
        <img
          src={imageUrl}
          alt={`PDF page ${page + 1}`}
          width={width}
          height={height}
        />
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMinYMin meet"
          className={`image-overlay-svg ${drawMode ? "draw-mode" : ""}`}
          style={{ pointerEvents: editable && !loading ? "all" : "none" }}
          onPointerDown={onSvgPointerDown}
        >
          {visible.map((d) => (
            <DetectionBox
              key={d.id}
              det={d}
              selected={selectedId === d.id}
              editable={editable}
              drawMode={drawMode}
              handleRadius={handleRadius}
              onPointerDown={(e) => startMove(e, d)}
              onResizePointerDown={(e, corner) => startResize(e, d, corner)}
            />
          ))}
          {draftBox && (
            <rect
              x={draftBox.x}
              y={draftBox.y}
              width={draftBox.w}
              height={draftBox.h}
              fill="rgba(236,215,179,0.18)"
              stroke="#ecd7b3"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeDasharray="6 4"
              pointerEvents="none"
            />
          )}
        </svg>
        {loading && (
          <div className="image-loading">
            {loadingVariant === "ocr" && (
              <>
                <div className="scan-line" />
                <div className="ocr-ring" />
                <div className="ocr-ring inner" />
              </>
            )}
            <div className="loading-content">
              {loadingVariant !== "ocr" && (
                <span className="spinner spinner-lg" />
              )}
              {loadingLabel && (
                <span className="label">
                  {loadingLabel}
                  <span className="ellipsis">
                    <i>.</i>
                    <i>.</i>
                    <i>.</i>
                  </span>
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DetectionBox({
  det,
  selected,
  editable,
  drawMode,
  handleRadius,
  onPointerDown,
  onResizePointerDown,
}: {
  det: Detection;
  selected: boolean;
  editable: boolean;
  drawMode: boolean;
  handleRadius: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onResizePointerDown: (
    e: React.PointerEvent,
    corner: "nw" | "ne" | "sw" | "se",
  ) => void;
}) {
  const [x, y, w, h] = det.bbox;
  const stroke = selected ? "#ecd7b3" : "#7fc99a";
  const fill = selected ? "rgba(236,215,179,0.22)" : "rgba(127,201,154,0.16)";
  const fontSize = Math.max(12, h * 0.7);
  const interactive = editable && !drawMode;
  const corners: ["nw" | "ne" | "sw" | "se", number, number][] = [
    ["nw", x, y],
    ["ne", x + w, y],
    ["sw", x, y + h],
    ["se", x + w, y + h],
  ];
  const cursorByCorner = {
    nw: "nwse-resize",
    se: "nwse-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
  } as const;
  return (
    <g data-detection-id={det.id}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={fill}
        stroke={stroke}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        style={{
          pointerEvents: interactive ? "all" : "none",
          cursor: interactive ? "move" : "default",
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
      />
      <text
        x={x}
        y={y - 4}
        fill={stroke}
        fontSize={fontSize}
        style={{
          fontFamily: "system-ui, sans-serif",
          fontWeight: 600,
          paintOrder: "stroke",
          stroke: "rgba(14,17,22,0.7)",
          strokeWidth: 3,
        }}
        pointerEvents="none"
      >
        {det.text}
      </text>
      {selected &&
        interactive &&
        corners.map(([corner, cx, cy]) => (
          <circle
            key={corner}
            cx={cx}
            cy={cy}
            r={handleRadius}
            fill="#ecd7b3"
            stroke="#161a21"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            style={{
              cursor: cursorByCorner[corner],
              touchAction: "none",
            }}
            onPointerDown={(e) => onResizePointerDown(e, corner)}
          />
        ))}
    </g>
  );
}

function SidePanel({
  detections,
  selectedId,
  hiddenCodes,
  drawMode,
  onSelect,
  onToggleDrawMode,
  onToggleCodeVisibility,
  onDeleteBox,
  onRelabelBox,
  onExportJson,
  onExportCsv,
}: {
  detections: Detection[];
  selectedId: string | null;
  hiddenCodes: Set<string>;
  drawMode: boolean;
  onSelect: (id: string | null) => void;
  onToggleDrawMode: () => void;
  onToggleCodeVisibility: (code: string) => void;
  onDeleteBox: (id: string) => void;
  onRelabelBox: (id: string) => void;
  onExportJson: () => void;
  onExportCsv: () => void;
}) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const d of detections) c[d.text] = (c[d.text] ?? 0) + 1;
    return c;
  }, [detections]);
  const codes = useMemo(
    () => Object.keys(counts).sort(lfCodeCompare),
    [counts],
  );
  const byCode = useMemo(() => {
    const m = new Map<string, Detection[]>();
    for (const d of detections) {
      const list = m.get(d.text) ?? [];
      list.push(d);
      m.set(d.text, list);
    }
    return m;
  }, [detections]);
  const [collapsedCodes, setCollapsedCodes] = useState<Set<string>>(new Set());
  const toggleCollapsed = (code: string) =>
    setCollapsedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  return (
    <aside className="side-panel">
      <div className="side-panel-header">
        <h2>Detected codes</h2>
        <button
          type="button"
          className={`btn-sm ${drawMode ? "btn-toggle-on" : ""}`}
          onClick={onToggleDrawMode}
        >
          {drawMode ? "Cancel" : "+ Draw box"}
        </button>
      </div>
      <div className="count-row">
        <span className="count">{detections.length}</span>
        <span>total</span>
        {drawMode && <span className="draw-hint">· click-drag on image</span>}
        <span className="grow" />
        <button
          type="button"
          className="btn-sm btn-ghost"
          onClick={onExportJson}
          disabled={detections.length === 0}
        >
          JSON
        </button>
        <button
          type="button"
          className="btn-sm btn-ghost"
          onClick={onExportCsv}
          disabled={detections.length === 0}
        >
          CSV
        </button>
      </div>
      {codes.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          No LF codes detected.
        </p>
      ) : (
        <ul className="code-list">
          {codes.map((code) => (
            <CodeGroup
              key={code}
              code={code}
              count={counts[code]}
              hidden={hiddenCodes.has(code)}
              collapsed={collapsedCodes.has(code)}
              detections={byCode.get(code) ?? []}
              selectedId={selectedId}
              onSelect={onSelect}
              onToggleVisibility={() => onToggleCodeVisibility(code)}
              onToggleCollapse={() => toggleCollapsed(code)}
              onDeleteBox={onDeleteBox}
              onRelabelBox={onRelabelBox}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

function CodeGroup({
  code,
  count,
  hidden,
  collapsed,
  detections,
  selectedId,
  onSelect,
  onToggleVisibility,
  onToggleCollapse,
  onDeleteBox,
  onRelabelBox,
}: {
  code: string;
  count: number;
  hidden: boolean;
  collapsed: boolean;
  detections: Detection[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggleVisibility: () => void;
  onToggleCollapse: () => void;
  onDeleteBox: (id: string) => void;
  onRelabelBox: (id: string) => void;
}) {
  return (
    <li
      className={`code-group ${hidden ? "hidden" : ""} ${collapsed ? "collapsed" : ""}`}
    >
      <div className="code-group-header">
        <input
          type="checkbox"
          checked={!hidden}
          onChange={onToggleVisibility}
          aria-label={`Show ${code}`}
        />
        <button
          type="button"
          className="code-group-toggle"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
        >
          <span className="chevron">▾</span>
          <span>{code}</span>
          <span className="count">{count}</span>
        </button>
      </div>
      <ul className="detection-list">
        {detections.map((d) => {
          const isSelected = selectedId === d.id;
          return (
            <li
              key={d.id}
              className={`detection-item ${isSelected ? "selected" : ""}`}
            >
              <button
                type="button"
                className="label-btn"
                onClick={() => onSelect(d.id)}
              >
                {d.id} · {(d.confidence * 100).toFixed(0)}%
              </button>
              {isSelected && (
                <>
                  <button
                    type="button"
                    className="btn-sm btn-ghost"
                    onClick={() => onRelabelBox(d.id)}
                  >
                    Relabel
                  </button>
                  <button
                    type="button"
                    className="btn-sm btn-danger"
                    onClick={() => onDeleteBox(d.id)}
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

function lfCodeCompare(a: string, b: string): number {
  const parse = (s: string): number => {
    const m = /^LF(\d{1,2})(?:-(\d))?$/.exec(s);
    if (!m) return Number.POSITIVE_INFINITY;
    const base = Number(m[1]);
    const sub = m[2] !== undefined ? (Number(m[2]) + 1) / 100 : 0;
    return base + sub;
  };
  return parse(a) - parse(b);
}

function ErrorBanner({
  error,
  onDismiss,
}: {
  error: AppError;
  onDismiss: () => void;
}) {
  return (
    <div className="error-banner">
      <span className="icon">!</span>
      <span className="msg">{error.message}</span>
      {error.retry && (
        <button
          type="button"
          className="btn-sm btn-danger"
          onClick={() => {
            onDismiss();
            error.retry!();
          }}
        >
          Try again
        </button>
      )}
      <button type="button" className="btn-sm btn-danger" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "");
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
