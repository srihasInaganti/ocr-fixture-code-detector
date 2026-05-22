import { useEffect, useRef, useState } from "react";

type HealthState =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

type RenderState =
  | { kind: "idle" }
  | { kind: "uploading"; fileName: string }
  | {
      kind: "rendered";
      fileName: string;
      imageUrl: string;
      width: number;
      height: number;
      page: number;
      pageCount: number;
    }
  | { kind: "error"; message: string };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [render, setRender] = useState<RenderState>({ kind: "idle" });
  const [page, setPage] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!API_BASE_URL) {
      setHealth({
        kind: "error",
        message: "VITE_API_BASE_URL is not set.",
      });
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

  useEffect(() => {
    if (render.kind !== "rendered") return;
    const url = render.imageUrl;
    return () => URL.revokeObjectURL(url);
  }, [render.kind === "rendered" ? render.imageUrl : null]);

  async function uploadFile(file: File) {
    if (!API_BASE_URL) return;
    setRender({ kind: "uploading", fileName: file.name });
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("page", String(page));
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
      const pageIdx = Number(res.headers.get("X-Page-Index") ?? "0");
      const pageCount = Number(res.headers.get("X-Page-Count") ?? "1");
      const blob = await res.blob();
      const imageUrl = URL.createObjectURL(blob);
      setRender({
        kind: "rendered",
        fileName: file.name,
        imageUrl,
        width,
        height,
        page: pageIdx,
        pageCount,
      });
    } catch (err) {
      setRender({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function pickFile(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.type && file.type !== "application/pdf") {
      setRender({ kind: "error", message: `Expected a PDF, got ${file.type}` });
      return;
    }
    void uploadFile(file);
  }

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 1100,
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
            padding: "2rem",
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
          <div
            style={{
              marginTop: "0.75rem",
              fontSize: 14,
              color: "#555",
            }}
          >
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
        <RenderView state={render} />
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

function RenderView({ state }: { state: RenderState }) {
  if (state.kind === "idle") return null;
  if (state.kind === "uploading")
    return <p>Rendering {state.fileName}…</p>;
  if (state.kind === "error")
    return <p style={{ color: "crimson" }}>Error: {state.message}</p>;

  return (
    <div>
      <p style={{ fontSize: 14, color: "#555", margin: "0 0 0.5rem" }}>
        <code>{state.fileName}</code> — page {state.page + 1} of{" "}
        {state.pageCount} — natural {state.width}×{state.height} px
      </p>
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          overflow: "auto",
          maxHeight: "80vh",
          background: "#fff",
        }}
      >
        <img
          src={state.imageUrl}
          alt={`PDF page ${state.page + 1}`}
          width={state.width}
          height={state.height}
          style={{
            display: "block",
            maxWidth: "100%",
            height: "auto",
          }}
        />
      </div>
    </div>
  );
}
