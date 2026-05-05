import { chatJson } from "@/lib/llm";
import { z } from "zod";

const GroupedSchema = z.object({
  bugs: z.array(z.string()).default([]),
  features: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export type AnalyzerOutput = z.infer<typeof GroupedSchema>;

/**
 * Analyzer Agent — groups ticket keys into bugs, features, risks, blockers.
 * Uses LLM when available; falls back to heuristic from issue type labels.
 */
export async function runAnalyzer(briefLines: string[]): Promise<AnalyzerOutput> {
  const corpus = briefLines.join("\n---\n");

  try {
    const parsed = await chatJson(
      `You are the Analyzer agent for release notes. Given Jira ticket one-line summaries (each line starts with KEY),
group issue KEYS into JSON only:
{"bugs":[],"features":[],"risks":[],"blockers":[],"notes":""}
Rules:
- bugs: defect-type work, regressions, incidents
- features: stories, tasks, improvements, new capability
- risks: security, performance, data loss, migration, dependency, unclear scope
- blockers: cannot ship / blocked status / explicit blocker label
- Each key appears in at most one list (prefer blockers > risks > bugs > features).
- "notes" optional short analyst comment.
Output ONLY valid JSON, no markdown.`,
      corpus.slice(0, 120_000),
      (raw) => {
        const json = extractJsonObject(raw);
        return GroupedSchema.parse(JSON.parse(json));
      },
    );
    return parsed;
  } catch {
    return heuristicAnalyzer(briefLines);
  }
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object in model output");
  }
  return text.slice(start, end + 1);
}

const KEY_RE = /^([A-Z][A-Z0-9]+-\d+)/;

function heuristicAnalyzer(briefLines: string[]): AnalyzerOutput {
  const bugs: string[] = [];
  const features: string[] = [];
  const risks: string[] = [];
  const blockers: string[] = [];

  for (const line of briefLines) {
    const m = line.match(KEY_RE);
    if (!m) continue;
    const key = m[1];
    const lower = line.toLowerCase();
    if (lower.includes("blocker") || lower.includes("| status=blocked")) {
      blockers.push(key);
    } else if (
      lower.includes("risk") ||
      lower.includes("security") ||
      lower.includes("migration")
    ) {
      risks.push(key);
    } else if (
      lower.includes("[bug]") ||
      lower.includes("defect") ||
      lower.includes("regression")
    ) {
      bugs.push(key);
    } else {
      features.push(key);
    }
  }

  return {
    bugs,
    features,
    risks,
    blockers,
    notes: "Heuristic grouping (no LLM or LLM failed).",
  };
}
