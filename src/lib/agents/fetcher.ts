import { issueToBrief, jiraSearch, type JiraIssue } from "@/lib/jira";
import { resolveNaturalLanguageToJql } from "@/lib/nl-jql";

export type FetcherInput = {
  /** Natural language or JQL hint, e.g. "Sprint 20" */
  query: string;
  /** Optional explicit JQL — if omitted, built from query */
  jqlOverride?: string;
};

export type FetcherOutput = {
  /** JQL sent to Jira (includes sub-task filter when enabled). */
  jql: string;
  issues: JiraIssue[];
  briefLines: string[];
  /** Issues returned in this page (≤ maxResults). */
  issueCount: number;
  /** Jira total matches for `jql` (can exceed `issueCount`). */
  jiraTotalHits: number;
  subtasksExcluded: boolean;
};

/**
 * Fetcher Agent — mirrors what the Jira MCP tool `jira_search` would do.
 * Uses the same REST module as `src/mcp/jira-mcp-server.ts`.
 */
export async function runFetcher(input: FetcherInput): Promise<FetcherOutput> {
  const baseJql = input.jqlOverride?.trim()
    ? input.jqlOverride.trim()
    : await resolveNaturalLanguageToJql(input.query.trim());

  const { issues, total, jqlUsed } = await jiraSearch(baseJql);
  const briefLines = issues.map(issueToBrief);

  return {
    jql: jqlUsed,
    issues,
    briefLines,
    issueCount: issues.length,
    jiraTotalHits: total,
    subtasksExcluded: baseJql.trim() !== jqlUsed.trim(),
  };
}
