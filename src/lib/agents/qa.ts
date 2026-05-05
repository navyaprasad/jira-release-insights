import { chatJson } from "@/lib/llm";
import { wantsNoTicketIdsInOutput } from "@/lib/user-intent";
import { z } from "zod";

const QaSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string()).default([]),
  revisedMarkdown: z.string().optional(),
});

export type QaOutput = z.infer<typeof QaSchema>;

/**
 * QA Agent (critic) — checks missing info, hallucinated keys, formatting.
 */
export async function runQa(
  draftMarkdown: string,
  allowedKeys: string[],
  userAsk?: string,
): Promise<QaOutput> {
  const allowed = new Set(allowedKeys);
  const req = userAsk?.trim();

  try {
    const result = await chatJson(
      `You are the QA/critic agent for release notes.
Check: (1) USER_REQUIREMENTS below — if the draft ignores required tone, sections, or emphasis (e.g. "highlight risks"), list that in issues and fix in revisedMarkdown; (2) ticket keys not in ALLOWED_KEYS (hallucination); (3) broken markdown.
Return JSON only: {"approved":true|false,"issues":["..."],"revisedMarkdown":"..."}
If USER_REQUIREMENTS forbid ticket IDs in the customer document, remove every PROJ-123 style key from revisedMarkdown while keeping meaning.
If not approved, put a fully corrected markdown in revisedMarkdown using ONLY allowed keys from ALLOWED_KEYS while satisfying USER_REQUIREMENTS.`,
      `ALLOWED_KEYS:\n${[...allowed].join(", ")}\n\nUSER_REQUIREMENTS:\n${req ?? "(none)"}\n\nDRAFT:\n${draftMarkdown.slice(0, 80_000)}`,
      (raw) => {
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        const json = raw.slice(start, end + 1);
        return QaSchema.parse(JSON.parse(json));
      },
    );
    if (req && wantsNoTicketIdsInOutput(req)) {
      const keyPat = /\b[A-Z][A-Z0-9]+-\d+\b/;
      const md = result.revisedMarkdown ?? draftMarkdown;
      if (keyPat.test(md)) {
        result.issues = [
          ...result.issues,
          "USER asked not to include ticket IDs, but the draft still contains Jira keys.",
        ];
        result.approved = false;
        result.revisedMarkdown = stripAllJiraKeys(
          stripUnknownKeys(result.revisedMarkdown ?? draftMarkdown, allowed),
        );
      }
    }
    return result;
  } catch {
    return localQa(draftMarkdown, allowed, userAsk);
  }
}

function stripAllJiraKeys(md: string): string {
  return md
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function localQa(
  draft: string,
  allowed: Set<string>,
  userAsk?: string,
): QaOutput {
  const issues: string[] = [];
  const keyPattern = /\b[A-Z][A-Z0-9]+-\d+\b/g;
  const found = draft.match(keyPattern) ?? [];
  for (const k of found) {
    if (!allowed.has(k)) issues.push(`Possible hallucinated or unknown key: ${k}`);
  }
  if (!draft.includes("#")) issues.push("Missing top-level markdown heading");
  if (userAsk && wantsNoTicketIdsInOutput(userAsk)) {
    const keyPat = /\b[A-Z][A-Z0-9]+-\d+\b/g;
    if (keyPat.test(draft)) {
      issues.push(
        "USER asked not to include ticket IDs, but the draft still contains Jira keys.",
      );
    }
  }
  const approved = issues.length === 0;
  let revised: string | undefined;
  if (!approved) {
    let md = stripUnknownKeys(draft, allowed);
    if (wantsNoTicketIdsInOutput(userAsk ?? "")) {
      md = stripAllJiraKeys(md);
    }
    revised = md;
  }
  return {
    approved,
    issues,
    revisedMarkdown: revised,
  };
}

function stripUnknownKeys(md: string, allowed: Set<string>): string {
  return md.replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, (k) =>
    allowed.has(k) ? k : "[REDACTED-NON-JIRA]",
  );
}
