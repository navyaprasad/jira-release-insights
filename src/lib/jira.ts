/**
 * Jira Cloud REST v3 client — shared by the Fetcher agent and the Jira MCP server.
 */

export type JiraIssueFields = {
  summary?: string;
  description?: unknown;
  issuetype?: { name?: string };
  status?: { name?: string };
  priority?: { name?: string };
  labels?: string[];
  [key: string]: unknown;
};

export type JiraIssue = {
  id: string;
  key: string;
  fields: JiraIssueFields;
};

export type JiraSearchResult = {
  issues: JiraIssue[];
  /** Total issues matching the search (Jira may cap the returned page). */
  total: number;
  /** JQL actually sent to Jira (may include sub-task exclusion). */
  jqlUsed: string;
};

function getEnv() {
  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "");
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !apiToken) {
    throw new Error(
      "Missing Jira env: set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN",
    );
  }
  return { baseUrl, email, apiToken };
}

function authHeader(email: string, token: string) {
  const raw = `${email}:${token}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/** Insert `AND <clause>` before `ORDER BY`, or append at the end. */
export function appendJqlAndClause(jql: string, clause: string): string {
  const t = jql.trim();
  if (!t) return clause;
  const re = /\s+ORDER\s+BY\s+/i;
  const idx = t.search(re);
  if (idx === -1) return `${t} AND ${clause}`;
  const base = t.slice(0, idx).trim();
  const tail = t.slice(idx).trim();
  if (!base) return `${clause} ${tail}`;
  return `${base} AND ${clause} ${tail}`;
}

/** Default Atlassian name; override with JIRA_SUBTASK_ISSUETYPE_NAME if your site differs. */
function subtaskExcludeClause(): string {
  const name =
    process.env.JIRA_SUBTASK_ISSUETYPE_NAME?.trim() || "Sub-task";
  const safe = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `issuetype != "${safe}"`;
}

export function shouldExcludeSubtasksFromSearch(): boolean {
  return process.env.JIRA_INCLUDE_SUBTASKS !== "true";
}

export function prepareSearchJql(jql: string): string {
  if (!shouldExcludeSubtasksFromSearch()) return jql.trim();
  return appendJqlAndClause(jql.trim(), subtaskExcludeClause());
}

const SEARCH_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "labels",
  "description",
] as const;

export type JiraSearchOptions = {
  excludeSubtasks?: boolean;
  /**
   * Max issues to return across all pages (default JIRA_MAX_ISSUES_FETCH or 2000).
   * For a single page only, set this equal to pageSize (or use a small number).
   */
  maxIssues?: number;
  /** Issues per request; Jira Cloud typically allows up to 100. */
  pageSize?: number;
};

function parseMaxIssuesCap(): number {
  const raw = process.env.JIRA_MAX_ISSUES_FETCH?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 2000;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 50_000) : 2000;
}

/**
 * Jira Cloud enhanced JQL search with POST + nextPageToken pagination.
 * Legacy `jiraSearch(jql, 50)` = one page, max 50 issues.
 */
export async function jiraSearch(
  jql: string,
  maxResultsOrOptions?: number | JiraSearchOptions,
  maybeOptions?: JiraSearchOptions,
): Promise<JiraSearchResult> {
  let options: JiraSearchOptions = {};
  if (typeof maxResultsOrOptions === "number") {
    const n = maxResultsOrOptions;
    options = {
      pageSize: Math.min(Math.max(1, n), 100),
      maxIssues: n,
      ...maybeOptions,
    };
  } else if (maxResultsOrOptions != null) {
    options = maxResultsOrOptions;
  }

  const excludeSubtasks =
    options.excludeSubtasks !== false &&
    (options.excludeSubtasks === true || shouldExcludeSubtasksFromSearch());

  const effectiveJql = excludeSubtasks
    ? appendJqlAndClause(jql.trim(), subtaskExcludeClause())
    : jql.trim();

  const pageSize = Math.min(Math.max(1, options.pageSize ?? 100), 100);
  const maxIssues =
    options.maxIssues != null
      ? Math.min(Math.max(1, options.maxIssues), 50_000)
      : parseMaxIssuesCap();

  const { baseUrl, email, apiToken } = getEnv();
  const url = `${baseUrl}/rest/api/3/search/jql`;

  const headers: Record<string, string> = {
    Authorization: authHeader(email, apiToken),
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const issues: JiraIssue[] = [];
  const seen = new Set<string>();
  let total = 0;
  let nextPageToken: string | undefined;

  for (;;) {
    if (issues.length >= maxIssues) break;

    const body: Record<string, unknown> = {
      jql: effectiveJql,
      maxResults: Math.min(pageSize, maxIssues - issues.length),
      fields: [...SEARCH_FIELDS],
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira search failed ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      issues?: JiraIssue[];
      total?: number;
      nextPageToken?: string;
      isLast?: boolean;
    };

    if (typeof data.total === "number") total = data.total;
    const page = data.issues ?? [];
    const lenBefore = issues.length;
    for (const issue of page) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      issues.push(issue);
      if (issues.length >= maxIssues) break;
    }

    if (!page.length) break;
    if (issues.length === lenBefore && page.length > 0) break;
    if (data.isLast === true) break;

    const token = data.nextPageToken;
    if (!token || token === nextPageToken) break;
    nextPageToken = token;
  }

  if (!total) total = issues.length;

  return {
    issues,
    total,
    jqlUsed: effectiveJql,
  };
}

/** Pull plain text from Jira Cloud ADF / legacy description (no JSON dump). */
export function descriptionToPlainText(description: unknown, maxLen = 1500): string {
  if (typeof description === "string") {
    return description.replace(/\s+/g, " ").trim().slice(0, maxLen);
  }
  if (!description || typeof description !== "object") return "";

  function walk(node: unknown): string {
    if (node == null) return "";
    if (typeof node === "string") return node;
    if (typeof node !== "object") return "";
    const o = node as { text?: string; content?: unknown[] };
    let s = "";
    if (typeof o.text === "string") s += o.text + " ";
    if (Array.isArray(o.content)) {
      for (const c of o.content) s += walk(c) + " ";
    }
    return s;
  }

  const doc = description as { type?: string; content?: unknown[] };
  if (doc.type === "doc" && Array.isArray(doc.content)) {
    return walk(description).replace(/\s+/g, " ").trim().slice(0, maxLen);
  }
  return walk(description).replace(/\s+/g, " ").trim().slice(0, maxLen);
}

export async function jiraGetIssue(issueKey: string): Promise<JiraIssue> {
  const { baseUrl, email, apiToken } = getEnv();
  const url = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,status,issuetype,priority,labels,description`;

  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(email, apiToken),
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira get issue failed ${res.status}: ${text}`);
  }

  return (await res.json()) as JiraIssue;
}

/**
 * One block per issue for Analyzer/Writer. Line 1 starts with KEY for grouping.
 * Description is plain text from ADF — never raw JSON.
 */
export function issueToBrief(i: JiraIssue): string {
  const f = i.fields;
  const type = f.issuetype?.name ?? "?";
  const summary = (f.summary ?? "").replace(/\s+/g, " ").trim();
  const plain = descriptionToPlainText(f.description, 1200);
  const body = plain ? `${summary}\n${plain}` : summary;
  return `${i.key} [${type}] ${body}`;
}
