import { chatComplete } from "@/lib/llm";
import { getOpenAI } from "@/lib/llm";

/**
 * Heuristic + optional LLM: turn conversational queries into JQL.
 * Avoids `text ~ "<entire sentence>"` which almost never matches.
 */

function escapeJqlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const MONTH_NAME_TO_NUM: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/** Calendar words must not become `project = MARCH` when user meant "March board". */
function isCalendarMonthToken(word: string): boolean {
  return MONTH_NAME_TO_NUM[word.trim().toLowerCase()] != null;
}

/** Jira-style project/board keys: RHC05, PROJ, TEAM2 */
function extractProjectKey(q: string): string | null {
  const patterns: RegExp[] = [
    /\bin\s+([A-Z][A-Z0-9]{1,9}\d*)\s+(?:board|project)\b/i,
    /\b(?:board|project)\s+([A-Z][A-Z0-9]{1,9}\d*)\b/i,
    /\b([A-Z][A-Z0-9]{1,9}\d*)\s+board\b/i,
  ];
  for (const re of patterns) {
    const m = q.match(re);
    if (!m?.[1]) continue;
    const token = m[1];
    if (isCalendarMonthToken(token)) continue;
    return token.toUpperCase();
  }
  const m2 = q.match(/\bproject\s*=\s*([A-Z][A-Z0-9]{1,9}\d*)\b/i);
  if (m2?.[1] && !isCalendarMonthToken(m2[1])) return m2[1].toUpperCase();

  /** e.g. RHC05, ABC123 — letters then digits (not a month word). */
  const loose = q.match(/\b([A-Za-z]{2,10}\d+)\b/g);
  if (loose) {
    for (const cand of loose) {
      const key = cand.toUpperCase();
      if (!isCalendarMonthToken(key)) return key;
    }
  }
  return null;
}

function pad2(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

/** "March 2026" or "Mar 2026" → { start: '2026-03-01', end: '2026-03-31' } */
function extractNamedMonthYearRange(
  q: string,
): { start: string; end: string } | null {
  const m = q.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{4})\b/i,
  );
  if (!m?.[1] || !m?.[2]) return null;
  const monthNum = MONTH_NAME_TO_NUM[m[1].toLowerCase()];
  if (!monthNum) return null;
  const year = Number.parseInt(m[2], 10);
  if (year < 1990 || year > 2100) return null;
  const lastDay = new Date(year, monthNum, 0).getDate();
  return {
    start: `${year}-${pad2(monthNum)}-01`,
    end: `${year}-${pad2(monthNum)}-${pad2(lastDay)}`,
  };
}

/** "2026-03" or "2026/3" */
function extractNumericMonthYearRange(
  q: string,
): { start: string; end: string } | null {
  const m = q.match(/\b(20\d{2})[-/](\d{1,2})\b(?!\d)/);
  if (!m?.[1] || !m?.[2]) return null;
  const year = Number.parseInt(m[1], 10);
  const monthNum = Number.parseInt(m[2], 10);
  if (monthNum < 1 || monthNum > 12) return null;
  const lastDay = new Date(year, monthNum, 0).getDate();
  return {
    start: `${year}-${pad2(monthNum)}-01`,
    end: `${year}-${pad2(monthNum)}-${pad2(lastDay)}`,
  };
}

function extractCalendarMonthClause(
  q: string,
  useResolvedDate: boolean,
): string | null {
  const range =
    extractNamedMonthYearRange(q) ?? extractNumericMonthYearRange(q);
  if (!range) return null;
  const field = useResolvedDate ? "resolved" : "updated";
  return `${field} >= "${range.start}" AND ${field} <= "${range.end}"`;
}

/** User wants completed / Done-column work */
function wantsDoneOrCompletedFilter(q: string): boolean {
  return /\b(done|completed|closed|finished)\b/i.test(q);
}

function extractTimeClause(q: string): string | null {
  const lower = q.toLowerCase();
  if (/\bthis\s+month\b/.test(lower)) {
    return "updated >= startOfMonth() AND updated <= endOfMonth()";
  }
  if (/\blast\s+month\b/.test(lower)) {
    return "updated >= startOfMonth(-1) AND updated <= endOfMonth(-1)";
  }
  if (/\bthis\s+week\b/.test(lower)) {
    return "updated >= startOfWeek()";
  }
  if (/\blast\s+week\b/.test(lower)) {
    return "updated >= startOfWeek(-1) AND updated <= startOfWeek()";
  }
  if (/\btoday\b/.test(lower)) {
    return "updated >= startOfDay()";
  }
  if (/\blast\s+(\d+)\s+days?\b/.test(lower)) {
    const m = lower.match(/\blast\s+(\d+)\s+days?\b/);
    if (m?.[1]) return `updated >= -${m[1]}d`;
  }
  if (/\bpast\s+(\d+)\s+days?\b/.test(lower)) {
    const m = lower.match(/\bpast\s+(\d+)\s+days?\b/);
    if (m?.[1]) return `updated >= -${m[1]}d`;
  }
  return null;
}

/** "what navya kommineni done ..." → assignee phrase */
function extractAssigneeHint(q: string): string | null {
  const m = q.match(
    /\bwhat\s+(.+?)\s+(?:has\s+)?(?:been\s+)?done\b/i,
  );
  if (m?.[1]) {
    const inner = m[1].replace(/\s+in\s+this\s+month.*$/i, "").trim();
    if (inner.length >= 2 && inner.length < 80) return inner;
  }
  const m2 = q.match(
    /\b(?:work|tasks?|issues?)\s+(?:by|from|for)\s+(.+?)(?:\s+in\s+|\s+this\s+|\s+on\s+|$)/i,
  );
  if (m2?.[1]) {
    const inner = m2[1].trim();
    if (inner.length >= 2 && inner.length < 80) return inner;
  }
  return null;
}

/** Looks like a long question, not a keyword search */
function looksLikeConversationalQuestion(q: string): boolean {
  const lower = q.toLowerCase();
  if (q.length > 55) return true;
  if (
    /\b(what|who|which|how|when|where|why|show|list|give|find|tell)\b/.test(
      lower,
    ) &&
    /\b(done|work|did|completed|finished|this month|last month)\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

export function buildHeuristicJql(q: string): string | null {
  const project = extractProjectKey(q);
  const assignee = extractAssigneeHint(q);
  const doneish = wantsDoneOrCompletedFilter(q);
  let time = extractTimeClause(q);
  if (!time) {
    const cal = extractCalendarMonthClause(q, doneish);
    if (cal) time = cal;
  }

  const parts: string[] = [];
  if (project) parts.push(`project = ${project}`);
  if (time) parts.push(`(${time})`);
  if (doneish) parts.push("statusCategory = Done");
  if (assignee) {
    const safe = escapeJqlString(assignee);
    parts.push(`assignee = "${safe}"`);
  }

  if (parts.length === 0) return null;
  return `${parts.join(" AND ")} ORDER BY updated DESC`;
}

function sanitizeLlmJql(raw: string): string | null {
  let line = raw
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim()
    .split(/\r?\n/)[0]
    .trim();
  if (!line || line.length > 800) return null;
  if (/[;\x00]/.test(line)) return null;
  if (!/ORDER BY/i.test(line)) {
    line = `${line} ORDER BY updated DESC`;
  }
  return line;
}

export async function nlToJqlWithLlm(q: string): Promise<string | null> {
  if (!getOpenAI()) return null;
  try {
    const raw = await chatComplete(
      `You convert a short natural-language request into exactly ONE line of Jira Cloud JQL.
Output rules:
- Output ONLY the JQL string. No markdown, no quotes around the whole line, no explanation.
- Use project = KEY when a board/project key appears (e.g. RHC05, ABC).
- "this month" means: updated >= startOfMonth() AND updated <= endOfMonth()
- "last month": updated >= startOfMonth(-1) AND updated <= endOfMonth(-1)
- Calendar phrases like "March 2026": use resolved date if the user asks for done/completed/closed items (resolved >= "2026-03-01" AND resolved <= "2026-03-31"); otherwise updated in that range.
- Map done/completed/closed/finished to statusCategory = Done when the user wants finished work.
- For a person's name, use assignee = "Full Name" with the name as the user wrote it (normalize only extra spaces).
- If the request is vague, prefer project + updated window from the text.
- Always end with ORDER BY updated DESC (or keep user's ORDER BY if you include one).`,
      q.slice(0, 2000),
    );
    return sanitizeLlmJql(raw);
  } catch {
    return null;
  }
}

export async function resolveNaturalLanguageToJql(q: string): Promise<string> {
  const trimmed = q.trim();
  if (!trimmed) return 'text ~ "empty" ORDER BY updated DESC';

  const sprintMatch = trimmed.match(/sprint\s+(\d+)/i);
  if (sprintMatch) {
    const n = sprintMatch[1];
    return `sprint = "Sprint ${n}" ORDER BY rank ASC`;
  }

  if (trimmed.toLowerCase().includes("order by")) {
    return trimmed;
  }

  const heuristic = buildHeuristicJql(trimmed);
  if (heuristic) return heuristic;

  const llmJql = await nlToJqlWithLlm(trimmed);
  if (llmJql) return llmJql;

  if (looksLikeConversationalQuestion(trimmed)) {
    const project = extractProjectKey(trimmed);
    const doneish = wantsDoneOrCompletedFilter(trimmed);
    let time = extractTimeClause(trimmed);
    if (!time) {
      const cal = extractCalendarMonthClause(trimmed, doneish);
      if (cal) time = cal;
    }
    if (project || time) {
      const parts: string[] = [];
      if (project) parts.push(`project = ${project}`);
      if (time) parts.push(`(${time})`);
      if (doneish) parts.push("statusCategory = Done");
      return `${parts.join(" AND ")} ORDER BY updated DESC`;
    }
    const words = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));
    const keywords = words.slice(0, 4).join(" ");
    if (keywords.length >= 3) {
      return `text ~ "${escapeJqlString(keywords)}" ORDER BY updated DESC`;
    }
    return "updated >= -30d ORDER BY updated DESC";
  }

  return `text ~ "${escapeJqlString(trimmed)}" ORDER BY updated DESC`;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "its",
  "may",
  "new",
  "now",
  "old",
  "see",
  "two",
  "who",
  "way",
  "use",
  "she",
  "many",
  "then",
  "them",
  "these",
  "this",
  "that",
  "with",
  "have",
  "from",
  "they",
  "been",
  "into",
  "more",
  "some",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "your",
  "about",
  "after",
  "also",
  "back",
  "been",
  "board",
  "done",
  "give",
  "like",
  "list",
  "make",
  "month",
  "show",
  "tasks",
  "task",
  "work",
  "done",
  "last",
  "week",
  "year",
]);
