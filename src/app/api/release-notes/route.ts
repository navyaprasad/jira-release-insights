import { NextResponse } from "next/server";
import { runReleaseNotesPipeline } from "@/lib/orchestrator";

export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      query?: string;
      jqlOverride?: string;
      userAsk?: string;
    };
    const query = (body.query ?? "").trim();
    const userAsk = (body.userAsk ?? "").trim();
    if (!query && !(body.jqlOverride ?? "").trim()) {
      return NextResponse.json(
        { error: "Provide `query` (natural language) or `jqlOverride`." },
        { status: 400 },
      );
    }
    const result = await runReleaseNotesPipeline({
      query: query || "project is not EMPTY",
      jqlOverride: body.jqlOverride,
      userAsk:
        userAsk ||
        "Generate professional release notes from the fetched tickets.",
    });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
