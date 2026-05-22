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
  | { kind: "uploading"; fileName: string }
  | {
      kind: "detected";
      fileName: string;
      imageUrl: string;
      width: number;
      height: number;
      page: number;
      pageCount: number;
      detections: Detection[];
      counts: Record<string, number>;
    }
  | { kind: "error"; message: string };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [state, setState] = useState<DetectState>({ kind: "idle" });
  const [page, setPage] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  async function uploadFile(file: File) {
    if (!API_BASE_URL) return;
    setState({ kind: "uploading", fileName: file.name });
    setSelectedId(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("page", String(page));
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
        fileName: file.name,
        imageUrl: `data:${data.imageMime};base64,${data.image}`,
        width: data.width,
        height: data.height,
        page: data.page,
        pageCount: data.pageCount,
        detections: data.detections,
        counts: data.counts,
      });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function pickFile(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.type && file.type !== "application/pdf") {
      setState({ kind: "error", message: `Expected a PDF, got ${file.type}` });
      return;
    }
    void uploadFile(file);
  }

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
          <div style={{ marginTop: "0.5rem", fontSize: 14, color: "#555" }}>
            <label>
              Page (0-indexed):{" "}
              <input
                type="number"
                min={0}
                value={page}
                onChange={(e) => setPage(Math.max(0, Number(e.target.value)))}
                onClick={(e) => e.stopPropagation()}
                style={{ width: 64 }}
              />
            </label>
          </div>
        </div>
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        {state.kind === "uploading" && <p>Detecting {state.fileName}…</p>}
        {state.kind === "error" && (
          <p style={{ color: "crimson" }}>Error: {state.message}</p>
        )}
        {state.kind === "detected" && (
          <DetectionLayout
            state={state}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
      </section>
    </main>
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
  onSelect,
}: {
  state: Extract<DetectState, { kind: "detected" }>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 300px",
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
        onSelect={onSelect}
      />
      <SidePanel
        detections={state.detections}
        counts={state.counts}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </div>
  );
}

function ImageWithOverlay({
  imageUrl,
  width,
  height,
  fileName,
  page,
  pageCount,
  detections,
  selectedId,
  onSelect,
}: {
  imageUrl: string;
  width: number;
  height: number;
  fileName: string;
  page: number;
  pageCount: number;
  detections: Detection[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
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
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMinYMin meet"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        >
          {detections.map((d) => (
            <DetectionBox
              key={d.id}
              det={d}
              selected={selectedId === d.id}
              onClick={() => onSelect(d.id)}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

function DetectionBox({
  det,
  selected,
  onClick,
}: {
  det: Detection;
  selected: boolean;
  onClick: () => void;
}) {
  const [x, y, w, h] = det.bbox;
  const stroke = selected ? "#ff8c00" : "#16a34a";
  const fill = selected ? "rgba(255,140,0,0.22)" : "rgba(22,163,74,0.15)";
  const fontSize = Math.max(12, h * 0.7);
  return (
    <g
      style={{ pointerEvents: "all", cursor: "pointer" }}
      onClick={onClick}
      data-detection-id={det.id}
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={fill}
        stroke={stroke}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={x}
        y={y - 4}
        fill={stroke}
        fontSize={fontSize}
        style={{ fontFamily: "system-ui, sans-serif", fontWeight: 600 }}
      >
        {det.text}
      </text>
    </g>
  );
}

function SidePanel({
  detections,
  counts,
  selectedId,
  onSelect,
}: {
  detections: Detection[];
  counts: Record<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
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
      <h2 style={{ fontSize: 16, margin: "0 0 0.25rem" }}>Detected codes</h2>
      <p style={{ fontSize: 13, color: "#555", margin: "0 0 0.75rem" }}>
        {detections.length} total
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
              detections={byCode.get(code) ?? []}
              selectedId={selectedId}
              onSelect={onSelect}
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
  detections,
  selectedId,
  onSelect,
}: {
  code: string;
  count: number;
  detections: Detection[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <li style={{ marginBottom: "0.75rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        <span>{code}</span>
        <span style={{ color: "#555" }}>{count}</span>
      </div>
      <ul
        style={{
          listStyle: "none",
          padding: "0.25rem 0 0 0.5rem",
          margin: 0,
        }}
      >
        {detections.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => onSelect(d.id)}
              style={{
                width: "100%",
                textAlign: "left",
                background:
                  selectedId === d.id ? "#fff3e0" : "transparent",
                border: `1px solid ${selectedId === d.id ? "#ff8c00" : "transparent"}`,
                padding: "2px 6px",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
                color: "#444",
                fontFamily: "inherit",
              }}
            >
              {d.id} · {(d.confidence * 100).toFixed(0)}%
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}

function lfCodeCompare(a: string, b: string): number {
  const parse = (s: string): number => {
    const m = /^LF(\d{1,2}|7-X)$/.exec(s);
    if (!m) return Number.POSITIVE_INFINITY;
    return m[1] === "7-X" ? 7.5 : Number(m[1]);
  };
  return parse(a) - parse(b);
}
