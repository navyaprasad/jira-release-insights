#!/usr/bin/env npx tsx
/**
 * Jira MCP server (stdio). Configure in Cursor MCP settings, e.g.:
 * { "command": "npm", "args": ["run", "mcp:jira"], "cwd": "/path/to/multi-agent-mcp" }
 *
 * Env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { jiraGetIssue, jiraSearch } from "../lib/jira";

const server = new McpServer({
  name: "jira-mcp",
  version: "0.1.0",
});

server.registerTool(
  "jira_search",
  {
    title: "Search Jira with JQL",
    description:
      "Run a JQL query and return matching issues (summary, status, type, etc.). Uses POST pagination: set fetchAllPages to retrieve up to maxTotalIssues (or JIRA_MAX_ISSUES_FETCH).",
    inputSchema: {
      jql: z.string().describe("JQL query"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Page size per request (default 50). Max 100."),
      fetchAllPages: z
        .boolean()
        .optional()
        .describe(
          "When true, follow nextPageToken until maxTotalIssues or no more pages.",
        ),
      maxTotalIssues: z
        .number()
        .int()
        .min(1)
        .max(50000)
        .optional()
        .describe(
          "Cap when fetchAllPages is true (default: JIRA_MAX_ISSUES_FETCH env or 2000).",
        ),
      excludeSubtasks: z
        .boolean()
        .optional()
        .describe(
          "When true (default), omit Sub-task issues. Set false to include them.",
        ),
    },
  },
  async ({
    jql,
    maxResults,
    fetchAllPages,
    maxTotalIssues,
    excludeSubtasks,
  }) => {
    const page = Math.min(maxResults ?? 50, 100);
    const cap = fetchAllPages
      ? (maxTotalIssues ?? undefined)
      : (maxResults ?? 50);
    const { issues, total, jqlUsed } = await jiraSearch(jql, {
      pageSize: page,
      maxIssues: cap,
      excludeSubtasks,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              jqlUsed,
              issueCount: issues.length,
              jiraTotalHits: total,
              issues,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "jira_get_issue",
  {
    title: "Get one Jira issue",
    description: "Fetch a single issue by key (e.g. PROJ-123).",
    inputSchema: {
      issueKey: z.string().describe("Issue key"),
    },
  },
  async ({ issueKey }) => {
    const issue = await jiraGetIssue(issueKey);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
