"use client";

import { useEffect, useRef, useState } from "react";

type Step = {
  agent: string;
  detail: Record<string, unknown>;
};

type ApiOk = {
  releaseNotesMarkdown: string;
  jql: string;
  issueKeys: string[];
  issueCount: number;
  jiraTotalHits: number;
  subtasksExcluded: boolean;
  qa: { approved: boolean; issues: string[] };
  steps: Step[];
};

type ProgressRow = {
  id: string;
  kind: "pipeline" | "agent";
  at: string;
  label: string;
  sub?: string;
  phaseClass: string;
};

function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    });
  } catch {
    return iso;
  }
}

export default function HomePage() {
  const [query, setQuery] = useState("Sprint 20");
  const [jqlOverride, setJqlOverride] = useState("");
  const [userAsk, setUserAsk] = useState(
    "Generate release notes for this sprint and highlight risks.",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiOk | null>(null);
  const [progress, setProgress] = useState<ProgressRow[]>([]);
  const [currentAgent, setCurrentAgent] = useState<string | null>(null);
  /** Cancels an in-flight stream when starting a new run (avoids “dead” clicks). */
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    };
  }, []);

  function handleFormSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    e.stopPropagation();
    void runPipeline();
  }

  async function runPipeline() {
    const q = query.trim();
    const jql = jqlOverride.trim();
    if (!q && !jql) {
      setError("Enter a natural-language query or a JQL override.");
      return;
    }

    streamAbortRef.current?.abort();
    const ac = new AbortController();
    streamAbortRef.current = ac;

    setLoading(true);
    setError(null);
    setResult(null);
    setProgress([]);
    setCurrentAgent(null);

    let rowId = 0;
    const addRow = (row: Omit<ProgressRow, "id">) => {
      const id = `${++rowId}`;
      setProgress((p) => [...p, { ...row, id }]);
    };

    try {
      const res = await fetch("/api/release-notes/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          jqlOverride: jql || undefined,
          userAsk: userAsk.trim(),
        }),
        signal: ac.signal,
        cache: "no-store",
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        setError(
          typeof errJson.error === "string"
            ? errJson.error
            : res.statusText || "Request failed",
        );
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setError("No response body");
        return;
      }

      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(t) as Record<string, unknown>;
          } catch {
            continue;
          }

          const typ = msg.type as string;

          if (typ === "pipeline") {
            const phase = msg.phase as string;
            const at = (msg.at as string) ?? "";
            const elapsedMs = msg.elapsedMs as number | undefined;
            addRow({
              kind: "pipeline",
              at,
              phaseClass: "pipeline",
              label:
                phase === "start"
                  ? "Pipeline started"
                  : `Pipeline finished${elapsedMs != null ? ` (${elapsedMs} ms total)` : ""}`,
            });
            if (phase === "end") setCurrentAgent(null);
            continue;
          }

          if (typ === "progress") {
            const phase = msg.phase as string;
            const agent = msg.agent as string;
            const at = (msg.at as string) ?? "";
            const elapsedMs = msg.elapsedMs as number | undefined;
            const detail = msg.detail as Record<string, unknown> | undefined;

            if (phase === "start") {
              setCurrentAgent(agent);
              addRow({
                kind: "agent",
                at,
                phaseClass: "start",
                label: `▶ ${agent}`,
                sub: "running…",
              });
            } else {
              setCurrentAgent(null);
              const ms =
                elapsedMs != null ? `${elapsedMs} ms` : "done";
              const detailStr =
                detail && Object.keys(detail).length
                  ? JSON.stringify(detail)
                  : "";
              addRow({
                kind: "agent",
                at,
                phaseClass: "end",
                label: `■ ${agent}`,
                sub: [ms, detailStr].filter(Boolean).join(" · "),
              });
            }
            continue;
          }

          if (typ === "error") {
            setError((msg.message as string) || "Unknown error");
            return;
          }

          if (typ === "result") {
            const payload = msg.payload as ApiOk;
            setResult(payload);
            continue;
          }
        }
      }

      if (buf.trim()) {
        try {
          const msg = JSON.parse(buf.trim()) as Record<string, unknown>;
          if (msg.type === "result") {
            setResult(msg.payload as ApiOk);
          }
        } catch {
          /* ignore */
        }
      }
    } catch (err: unknown) {
      const aborted =
        (err instanceof Error && err.name === "AbortError") ||
        (typeof DOMException !== "undefined" &&
          err instanceof DOMException &&
          err.name === "AbortError");
      if (aborted) return;
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (streamAbortRef.current === ac) {
        streamAbortRef.current = null;
      }
      setLoading(false);
      setCurrentAgent(null);
    }
  }

  return (
    <main>
      <h1>Jira release notes</h1>
      <p className="lead">
        Four agents run in sequence: Fetcher (Jira API, same contract as the
        Jira MCP tools), Analyzer (grouping), Writer (markdown), and QA
        (critic). Progress streams live with timestamps while the pipeline
        runs.
      </p>

      <div className="grid">
        <form className="card" onSubmit={handleFormSubmit}>
          <div style={{ marginBottom: "1rem" }}>
            <label htmlFor="query">Natural language / sprint hint</label>
            <input
              id="query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='e.g. "Sprint 20"'
            />
          </div>
          <div style={{ marginBottom: "1rem" }}>
            <label htmlFor="jql">Optional JQL override</label>
            <textarea
              id="jql"
              value={jqlOverride}
              onChange={(e) => setJqlOverride(e.target.value)}
              placeholder='project = KEY AND sprint = "Sprint 20" ORDER BY rank ASC'
            />
          </div>
          <div style={{ marginBottom: "0.25rem" }}>
            <label htmlFor="ask">Instructions for the Writer / QA</label>
            <textarea
              id="ask"
              value={userAsk}
              onChange={(e) => setUserAsk(e.target.value)}
            />
          </div>
          <div className="row">
            <button
              className="primary"
              type="button"
              disabled={loading}
              onClick={() => {
                void runPipeline();
              }}
            >
              {loading
                ? currentAgent
                  ? `Running: ${currentAgent}…`
                  : "Starting pipeline…"
                : "Generate release notes"}
            </button>
            {result && (
              <span
                className={`badge ${result.qa.approved ? "ok" : "warn"}`}
                title={result.qa.issues.join(" · ")}
              >
                QA: {result.qa.approved ? "approved" : "revised"}
              </span>
            )}
          </div>
          {error && <p className="err">{error}</p>}

          {(loading || progress.length > 0) && (
            <div className="progress-panel" aria-live="polite">
              {progress.map((row) => (
                <div
                  key={row.id}
                  className={`line ${row.phaseClass} ${row.kind === "pipeline" ? "pipeline" : ""}`}
                >
                  <span className="ts">{formatTime(row.at)}</span>
                  <strong>{row.label}</strong>
                  {row.sub && (
                    <>
                      {" "}
                      <span className={row.sub === "running…" ? "running" : ""}>
                        {row.sub}
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </form>

        {result && (
          <div className="card">
            <div
              style={{
                marginBottom: "0.75rem",
                fontSize: "0.85rem",
                color: "var(--muted)",
              }}
            >
              <strong style={{ color: "var(--text)" }}>
                Fetched {result.issueCount} issue
                {result.issueCount === 1 ? "" : "s"}
              </strong>
              {result.jiraTotalHits > result.issueCount ? (
                <>
                  {" "}
                  (Jira reports {result.jiraTotalHits} total matches; showing
                  first {result.issueCount})
                </>
              ) : null}
              {result.subtasksExcluded ? (
                <> · Sub-task type excluded from search</>
              ) : (
                <> · Sub-tasks included</>
              )}
              <br />
              JQL used: <code>{result.jql}</code>
            </div>
            <ol className="steps">
              {result.steps.map((s) => (
                <li key={s.agent}>
                  <strong>{s.agent}</strong> — {JSON.stringify(s.detail)}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {result && (
        <section className="card" style={{ marginTop: "1.25rem" }}>
          <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>Output</h2>
          <pre className="notes">{result.releaseNotesMarkdown}</pre>
        </section>
      )}
    </main>
  );
}
