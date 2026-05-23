import { useEffect, useMemo, useRef, useState } from "react";

type Detection = {
  id: string;
  text: string;
  bbox: [number, number, number, number];
  confidence: number;
};

type HealthState =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

type DetectState =
  | { kind: "idle" }
  | { kind: "rendering"; file: File; fileName: string; page: number }
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
    }
  | { kind: "error"; message: string };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [state, setState] = useState<DetectState>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState("1");
  const [rotation, setRotation] = useState(0);
  const [hiddenCodes, setHiddenCodes] = useState<Set<string>>(new Set());
  const [drawMode, setDrawMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newBoxSeq = useRef(0);

  useEffect(() => {
    if (!API_BASE_URL) {
      setHealth({ kind: "error", message: "VITE_API_BASE_URL is not set." });
      return;
    }
    const controller = new AbortController();
    fetch(`${API_BASE_URL}/health`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.json();
        setHealth({ kind: "ok" });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setHealth({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => controller.abort();
  }, []);

  async function renderPage(file: File, page: number, rot: number) {
    if (!API_BASE_URL) return;
    setState({ kind: "rendering", file, fileName: file.name, page });
    setSelectedId(null);
    setDrawMode(false);
    setPageInput(String(page + 1));
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
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function runDetect() {
    if (state.kind !== "preview" && state.kind !== "detected") return;
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
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
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
      setState({ kind: "error", message: `Expected a PDF, got ${file.type}` });
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

  const showToolbar =
    state.kind === "rendering" ||
    state.kind === "preview" ||
    state.kind === "detecting" ||
    state.kind === "detected";

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 1400,
        margin: "2rem auto",
        padding: "0 1rem",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: "1rem" }}>
        <h1 style={{ margin: 0 }}>OCR Fixture Code Detector</h1>
        <HealthBadge state={health} />
      </header>

      <section style={{ marginTop: "1.5rem" }}>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            pickFile(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? "#2a6df4" : "#bbb"}`,
            background: dragOver ? "#eef3ff" : "#fafafa",
            padding: "1.25rem",
            borderRadius: 8,
            textAlign: "center",
            cursor: "pointer",
          }}
        >
          <p style={{ margin: 0 }}>
            <strong>Drop a PDF here</strong>, or click to choose.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            style={{ display: "none" }}
            onChange={(e) => pickFile(e.target.files)}
          />
        </div>
      </section>

      {showToolbar && (
        <section style={{ marginTop: "1rem" }}>
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

      <section style={{ marginTop: "1.5rem" }}>
        {state.kind === "rendering" && (
          <p>
            Rendering {state.fileName}, page {state.page + 1}…
          </p>
        )}
        {state.kind === "detecting" && (
          <p>
            Running OCR on {state.fileName}, page {state.page + 1}…
          </p>
        )}
        {state.kind === "preview" && (
          <ImageWithOverlay
            imageUrl={state.imageUrl}
            width={state.width}
            height={state.height}
            page={state.page}
            pageCount={state.pageCount}
            fileName={state.fileName}
            detections={[]}
            selectedId={null}
            hiddenCodes={new Set()}
            drawMode={false}
            editable={false}
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
          />
        )}
        {state.kind === "error" && (
          <p style={{ color: "crimson" }}>Error: {state.message}</p>
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
  const canRun = (state.kind === "preview" || state.kind === "detected") && !busy;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        flexWrap: "wrap",
      }}
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={busy || pageCount === null || page <= 0}
      >
        ← Prev
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={busy || pageCount === null || page >= pageCount - 1}
      >
        Next →
      </button>
      <label style={{ fontSize: 14 }}>
        Page{" "}
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
          style={{ width: 64 }}
        />
        {pageCount !== null && (
          <span style={{ color: "#666" }}> of {pageCount}</span>
        )}
      </label>
      <button type="button" onClick={onRotate} disabled={busy}>
        ↻ Rotate 90°{rotation !== 0 ? ` (now ${rotation}°)` : ""}
      </button>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onRun}
        disabled={!canRun}
        style={{
          background: canRun ? "#2a6df4" : "#cbd5e1",
          color: "#fff",
          border: "none",
          padding: "0.5rem 1rem",
          borderRadius: 6,
          fontWeight: 600,
          cursor: canRun ? "pointer" : "not-allowed",
        }}
      >
        {state.kind === "detected"
          ? "Re-run OCR on this page"
          : "Run OCR on this page"}
      </button>
    </div>
  );
}

function HealthBadge({ state }: { state: HealthState }) {
  const color =
    state.kind === "ok"
      ? "#1a7f37"
      : state.kind === "error"
        ? "#b42318"
        : "#888";
  const label =
    state.kind === "ok"
      ? "backend: ok"
      : state.kind === "error"
        ? `backend: ${state.message}`
        : "backend: checking…";
  return (
    <span
      style={{
        fontSize: 12,
        color,
        border: `1px solid ${color}`,
        padding: "2px 8px",
        borderRadius: 999,
      }}
    >
      {label}
    </span>
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
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 320px",
        gap: "1.5rem",
      }}
    >
      <ImageWithOverlay
        imageUrl={state.imageUrl}
        width={state.width}
        height={state.height}
        page={state.page}
        pageCount={state.pageCount}
        fileName={state.fileName}
        detections={state.detections}
        selectedId={selectedId}
        hiddenCodes={hiddenCodes}
        drawMode={drawMode}
        editable={true}
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

function ImageWithOverlay({
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
  onSelect,
  onMoveBox,
  onAddBox,
}: {
  imageUrl: string;
  width: number;
  height: number;
  fileName: string;
  page: number;
  pageCount: number;
  detections: Detection[];
  selectedId: string | null;
  hiddenCodes: Set<string>;
  drawMode: boolean;
  editable: boolean;
  onSelect: (id: string | null) => void;
  onMoveBox: (id: string, bbox: [number, number, number, number]) => void;
  onAddBox: (bbox: [number, number, number, number]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  function toImg(clientX: number, clientY: number): { x: number; y: number } | null {
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
    setDrag({ kind: "resize", id: det.id, corner, startImg: pt, startBox: det.bbox });
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
    <div>
      <p style={{ fontSize: 14, color: "#555", margin: "0 0 0.5rem" }}>
        <code>{fileName}</code> — page {page + 1} of {pageCount} — {width}×
        {height} px
      </p>
      <div
        style={{
          position: "relative",
          display: "inline-block",
          maxWidth: "100%",
          border: "1px solid #ddd",
          borderRadius: 6,
          overflow: "hidden",
          background: "#fff",
        }}
      >
        <img
          src={imageUrl}
          alt={`PDF page ${page + 1}`}
          width={width}
          height={height}
          style={{ display: "block", maxWidth: "100%", height: "auto" }}
        />
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMinYMin meet"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: editable ? "all" : "none",
            cursor: drawMode ? "crosshair" : "default",
            touchAction: "none",
          }}
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
              fill="rgba(42,109,244,0.18)"
              stroke="#2a6df4"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeDasharray="6 4"
              pointerEvents="none"
            />
          )}
        </svg>
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
  const stroke = selected ? "#ff8c00" : "#16a34a";
  const fill = selected ? "rgba(255,140,0,0.22)" : "rgba(22,163,74,0.15)";
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
        style={{ fontFamily: "system-ui, sans-serif", fontWeight: 600 }}
        pointerEvents="none"
      >
        {det.text}
      </text>
      {selected && interactive &&
        corners.map(([corner, cx, cy]) => (
          <circle
            key={corner}
            cx={cx}
            cy={cy}
            r={handleRadius}
            fill="#fff"
            stroke={stroke}
            strokeWidth={2}
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

  return (
    <aside
      style={{
        border: "1px solid #ddd",
        borderRadius: 6,
        padding: "0.75rem 1rem",
        background: "#fff",
        position: "sticky",
        top: "1rem",
        alignSelf: "start",
        maxHeight: "calc(100vh - 2rem)",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.5rem",
        }}
      >
        <h2 style={{ fontSize: 16, margin: 0 }}>Detected codes</h2>
        <button
          type="button"
          onClick={onToggleDrawMode}
          style={{
            background: drawMode ? "#2a6df4" : "transparent",
            color: drawMode ? "#fff" : "#2a6df4",
            border: "1px solid #2a6df4",
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 12,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {drawMode ? "Cancel" : "+ Draw box"}
        </button>
      </div>
      <p style={{ fontSize: 13, color: "#555", margin: "0 0 0.75rem" }}>
        {detections.length} total
        {drawMode && (
          <span style={{ color: "#2a6df4" }}>
            {" "}
            · click-drag on image to add
          </span>
        )}
      </p>
      {codes.length === 0 ? (
        <p style={{ fontSize: 13, color: "#777" }}>No LF codes detected.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {codes.map((code) => (
            <CodeGroup
              key={code}
              code={code}
              count={counts[code]}
              hidden={hiddenCodes.has(code)}
              detections={byCode.get(code) ?? []}
              selectedId={selectedId}
              onSelect={onSelect}
              onToggleVisibility={() => onToggleCodeVisibility(code)}
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
  detections,
  selectedId,
  onSelect,
  onToggleVisibility,
  onDeleteBox,
  onRelabelBox,
}: {
  code: string;
  count: number;
  hidden: boolean;
  detections: Detection[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggleVisibility: () => void;
  onDeleteBox: (id: string) => void;
  onRelabelBox: (id: string) => void;
}) {
  return (
    <li style={{ marginBottom: "0.75rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontWeight: 600,
          fontSize: 14,
          opacity: hidden ? 0.5 : 1,
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={!hidden}
            onChange={onToggleVisibility}
          />
          <span>{code}</span>
        </label>
        <span style={{ color: "#555" }}>{count}</span>
      </div>
      <ul
        style={{
          listStyle: "none",
          padding: "0.25rem 0 0 0.5rem",
          margin: 0,
        }}
      >
        {detections.map((d) => {
          const isSelected = selectedId === d.id;
          return (
            <li key={d.id} style={{ marginBottom: 2 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: isSelected ? "#fff3e0" : "transparent",
                  border: `1px solid ${isSelected ? "#ff8c00" : "transparent"}`,
                  borderRadius: 4,
                  padding: "2px 6px",
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(d.id)}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    fontSize: 12,
                    color: "#444",
                    fontFamily: "inherit",
                  }}
                >
                  {d.id} · {(d.confidence * 100).toFixed(0)}%
                </button>
                {isSelected && (
                  <>
                    <button
                      type="button"
                      onClick={() => onRelabelBox(d.id)}
                      style={{
                        background: "transparent",
                        border: "1px solid #ccc",
                        borderRadius: 3,
                        padding: "0 4px",
                        fontSize: 11,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      Relabel
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteBox(d.id)}
                      style={{
                        background: "transparent",
                        border: "1px solid #b42318",
                        color: "#b42318",
                        borderRadius: 3,
                        padding: "0 4px",
                        fontSize: 11,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
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
