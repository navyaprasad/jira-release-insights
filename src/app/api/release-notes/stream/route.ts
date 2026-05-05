import { runReleaseNotesPipeline } from "@/lib/orchestrator";
import type { PipelineProgressEvent, PipelineResult } from "@/lib/orchestrator";

export const maxDuration = 120;

type NdjsonLine =
  | { type: "pipeline"; phase: "start" | "end"; at: string; elapsedMs?: number }
  | ({ type: "progress" } & PipelineProgressEvent)
  | { type: "result"; payload: PipelineResult }
  | { type: "error"; message: string; at: string };

export async function POST(req: Request) {
  const body = (await req.json()) as {
    query?: string;
    jqlOverride?: string;
    userAsk?: string;
  };
  const query = (body.query ?? "").trim();
  const userAsk = (body.userAsk ?? "").trim();
  if (!query && !(body.jqlOverride ?? "").trim()) {
    return new Response(
      JSON.stringify({
        error: "Provide `query` (natural language) or `jqlOverride`.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (line: NdjsonLine) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      };

      const pipeStarted = Date.now();
      write({
        type: "pipeline",
        phase: "start",
        at: new Date().toISOString(),
      });

      try {
        const result = await runReleaseNotesPipeline(
          {
            query: query || "project is not EMPTY",
            jqlOverride: body.jqlOverride,
            userAsk:
              userAsk ||
              "Generate professional release notes from the fetched tickets.",
          },
          (ev) => write({ type: "progress", ...ev }),
        );

        write({
          type: "pipeline",
          phase: "end",
          at: new Date().toISOString(),
          elapsedMs: Date.now() - pipeStarted,
        });
        write({ type: "result", payload: result });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        write({
          type: "error",
          message,
          at: new Date().toISOString(),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
