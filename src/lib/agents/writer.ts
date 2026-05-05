import { chatComplete } from "@/lib/llm";
import type { AnalyzerOutput } from "@/lib/agents/analyzer";
import {
  wantsCustomerFacingNotes,
  wantsNoTicketIdsInOutput,
} from "@/lib/user-intent";

export type WriterInput = {
  grouped: AnalyzerOutput;
  briefLines: string[];
  userAsk: string;
};

const KEY_HEAD = /^([A-Z][A-Z0-9]+-\d+)\s+\[([^\]]*)\]\s*(.*)$/;

function parseBriefLine(line: string): {
  key: string;
  type: string;
  summary: string;
  blurb: string;
} {
  const firstNl = line.indexOf("\n");
  const head = (firstNl === -1 ? line : line.slice(0, firstNl)).trim();
  const blurb = (firstNl === -1 ? "" : line.slice(firstNl + 1).trim()).replace(
    /\s+/g,
    " ",
  );
  const m = head.match(KEY_HEAD);
  if (!m) {
    const km = head.match(/^([A-Z][A-Z0-9]+-\d+)/);
    return {
      key: km?.[1] ?? head.slice(0, 20),
      type: "?",
      summary: head,
      blurb,
    };
  }
  const summary = (m[3] ?? "").trim() || m[1];
  return { key: m[1], type: (m[2] ?? "?").trim() || "?", summary, blurb };
}

function collectKeys(grouped: AnalyzerOutput): string[] {
  return [
    ...grouped.bugs,
    ...grouped.features,
    ...grouped.risks,
    ...grouped.blockers,
  ];
}

function buildKeyFactMap(
  grouped: AnalyzerOutput,
  lookup: Map<string, string>,
): string {
  const lines: string[] = [];
  for (const k of collectKeys(grouped)) {
    const p = parseBriefLine(lookup.get(k) ?? k);
    lines.push(`${k}\t${p.summary}`);
  }
  return lines.join("\n");
}

function sectionEngineering(
  title: string,
  keys: string[],
  lookup: Map<string, string>,
): string {
  if (!keys.length) return `### ${title}\n_No items._\n`;
  const lines = keys.map((k) => {
    const p = parseBriefLine(lookup.get(k) ?? k);
    const extra = p.blurb ? `\n  ${p.blurb.slice(0, 400)}` : "";
    return `- **${k}** — ${p.summary}${extra}`;
  });
  return `### ${title}\n${lines.join("\n")}\n`;
}

function sectionCustomer(
  title: string,
  keys: string[],
  lookup: Map<string, string>,
): string {
  if (!keys.length) return `### ${title}\n_No items._\n`;
  const lines = keys.map((k) => {
    const p = parseBriefLine(lookup.get(k) ?? k);
    const extra = p.blurb ? `\n  ${p.blurb.slice(0, 500)}` : "";
    return `- **${p.summary}** (_type:_ ${p.type})${extra}`;
  });
  return `### ${title}\n${lines.join("\n")}\n`;
}

function buildTicketPayload(
  grouped: AnalyzerOutput,
  lookup: Map<string, string>,
  customer: boolean,
): string {
  const parts = customer
    ? [
        sectionCustomer("Bugs", grouped.bugs, lookup),
        sectionCustomer("Features", grouped.features, lookup),
        sectionCustomer("Risks", grouped.risks, lookup),
        sectionCustomer("Blockers", grouped.blockers, lookup),
      ]
    : [
        sectionEngineering("Bugs", grouped.bugs, lookup),
        sectionEngineering("Features", grouped.features, lookup),
        sectionEngineering("Risks", grouped.risks, lookup),
        sectionEngineering("Blockers", grouped.blockers, lookup),
      ];
  let body = parts.join("\n");
  if (customer) {
    body += `\n## INTERNAL_KEY_MAP (accuracy only — never print this block or any PROJ-123 keys in the release notes)\n${buildKeyFactMap(grouped, lookup)}\n`;
  }
  return body;
}

function fallbackMarkdown(
  input: WriterInput,
  lookup: Map<string, string>,
  customer: boolean,
): string {
  const lines: string[] = [
    "# Release notes",
    "",
    "## Summary",
    "",
    input.userAsk.trim(),
    "",
    "## Changes",
    "",
  ];
  const pushCat = (title: string, keys: string[]) => {
    if (!keys.length) return;
    lines.push(`### ${title}`, "");
    for (const k of keys) {
      const p = parseBriefLine(lookup.get(k) ?? k);
      if (customer) {
        lines.push(`- ${p.summary}`);
        if (p.blurb) lines.push(`  ${p.blurb.slice(0, 400)}`);
      } else {
        lines.push(`- **${k}** — ${p.summary}`);
      }
    }
    lines.push("");
  };
  pushCat("Bugs", input.grouped.bugs);
  pushCat("Features", input.grouped.features);
  pushCat("Risks", input.grouped.risks);
  pushCat("Blockers", input.grouped.blockers);
  if (input.grouped.notes) {
    lines.push(`_Analysis: ${input.grouped.notes}_`);
  }
  return lines.join("\n");
}

/**
 * Writer Agent — produces markdown release notes from grouped keys + corpus.
 */
export async function runWriter(input: WriterInput): Promise<string> {
  const lookup = new Map<string, string>();
  for (const line of input.briefLines) {
    const key = line.split(/\s/)[0];
    if (key?.includes("-")) lookup.set(key, line);
  }

  const instructions =
    input.userAsk.trim() ||
    "Generate clear release notes from the tickets below.";
  const customer =
    wantsCustomerFacingNotes(instructions) ||
    wantsNoTicketIdsInOutput(instructions);
  const ticketPayload = buildTicketPayload(input.grouped, lookup, customer);

  const customerRules = customer
    ? `
CUSTOMER / PRODUCT RULES (mandatory):
- Do not include Jira issue keys (e.g. RHC05-123), URLs, or "INTERNAL_KEY_MAP" in the published document.
- Do not paste raw metadata (status=, priority=, labels=, JSON, or ADF).
- Use plain language a customer or executive can skim; lead with outcomes and fixes.
- You may merge related bullets; keep facts faithful to TICKET_SOURCE.
`
    : `
DEFAULT RULES:
- Prefer human-readable summaries; avoid dumping raw Jira field syntax.
- Issue keys may appear only if USER_INSTRUCTIONS explicitly asks for traceability.
`;

  try {
    const raw = await chatComplete(
      `You are the Writer agent for Jira release notes.

MANDATORY — follow "## USER_INSTRUCTIONS" below exactly. It overrides defaults.
${customerRules}
- If USER asks for a specific format, tone, length, or audience, implement it in full.
- Reflect USER_INSTRUCTIONS in the opening ## Summary (do not bury them).

Suggested outline unless USER forbids it:
# Release notes → ## Summary → themed sections (not raw Jira dumps).

Ground truth is TICKET_SOURCE; do not invent work items.`,
      `## USER_INSTRUCTIONS\n${instructions}\n\n## TICKET_SOURCE\n${ticketPayload}\n\n## GROUPER_NOTES\n${input.grouped.notes ?? "(none)"}`,
    );
    return raw.replace(/^```markdown\n?/i, "").replace(/\n?```$/i, "");
  } catch {
    return fallbackMarkdown(input, lookup, customer);
  }
}
