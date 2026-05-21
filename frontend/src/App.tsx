import { useEffect, useState } from "react";

type HealthState =
  | { kind: "loading" }
  | { kind: "ok"; payload: unknown }
  | { kind: "error"; message: string };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });

  useEffect(() => {
    if (!API_BASE_URL) {
      setHealth({
        kind: "error",
        message: "VITE_API_BASE_URL is not set. Configure it in .env.local or your Vercel project.",
      });
      return;
    }

    const controller = new AbortController();
    fetch(`${API_BASE_URL}/health`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        setHealth({ kind: "ok", payload });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message = err instanceof Error ? err.message : String(err);
        setHealth({ kind: "error", message });
      });

    return () => controller.abort();
  }, []);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 720,
        margin: "4rem auto",
        padding: "0 1rem",
      }}
    >
      <h1>OCR Fixture Code Detector</h1>
      <p>
        API base: <code>{API_BASE_URL ?? "(unset)"}</code>
      </p>
      <section>
        <h2>Backend health</h2>
        {health.kind === "loading" && <p>Checking…</p>}
        {health.kind === "ok" && (
          <pre
            style={{
              background: "#f4f4f4",
              padding: "0.75rem",
              borderRadius: 6,
            }}
          >
            {JSON.stringify(health.payload, null, 2)}
          </pre>
        )}
        {health.kind === "error" && (
          <p style={{ color: "crimson" }}>Error: {health.message}</p>
        )}
      </section>
    </main>
  );
}
