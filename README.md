# Multi-agent Jira release notes

A [Next.js](https://nextjs.org/) app that turns Jira issues into release notes using a small **multi-agent pipeline** (fetch, analyze, write, QA), plus optional **natural-language to JQL** and a standalone **Jira MCP server** for tools-based workflows.

## Features

- **Fetcher** — Resolves a natural-language query or explicit JQL, searches Jira Cloud, returns issues and metadata used by downstream agents.
- **Analyzer** — Groups work into bugs, features, risks, and blockers from compact issue briefs.
- **Writer** — Produces markdown release notes aligned with your instructions.
- **QA** — Checks allowed ticket keys, user requirements, and markdown; can return a revised draft.
- **Web UI** — Run the pipeline from the home page with live progress when using the streaming API.
- **REST APIs** — `POST /api/release-notes` (JSON response) and `POST /api/release-notes/stream` (NDJSON progress + final result).
- **Jira MCP** — `npm run mcp:jira` exposes Jira search aligned with the same REST client as the app.

## Requirements

- **Node.js** 20+ (matches Next.js 15 and the toolchain used here).
- **Jira Cloud** site with REST API access (email + API token).
- **OpenAI-compatible HTTP API** for LLM steps (OpenAI, many proxies, or gateways that implement the chat completions shape). Agents are skipped or degraded when no API key is configured, depending on the code path.

## Quick start

```bash
git clone <your-repo-url>
cd multi-agent-mcp
npm install
```

Create a `.env` file in the project root (it is gitignored). Use at least:

| Variable | Required | Description |
|----------|----------|-------------|
| `JIRA_BASE_URL` | Yes | Jira site base URL, e.g. `https://your-domain.atlassian.net` |
| `JIRA_EMAIL` | Yes | Atlassian account email |
| `JIRA_API_TOKEN` | Yes | [API token](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/) |
| `OPENAI_API_KEY` | For LLM features | API key for your provider |
| `OPENAI_BASE_URL` | Optional | Custom base URL (no trailing slash); omit for default OpenAI |
| `OPENAI_MODEL` | Optional | Model id (default in code: `claude-sonnet-4-5` when unset) |
| `JIRA_MAX_ISSUES_FETCH` | Optional | Cap on issues fetched (default `2000`, max `50000`) |
| `JIRA_INCLUDE_SUBTASKS` | Optional | Set to `true` to include sub-tasks in search (default excludes them) |
| `JIRA_SUBTASK_ISSUETYPE_NAME` | Optional | Issuetype name used for exclusion (default `Sub-task`) |

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), enter a natural-language query or JQL override, optional instructions, and run the pipeline.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development server (Turbopack) |
| `npm run build` | Production build (includes lint and type checks) |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint via Next.js |
| `npm run mcp:jira` | Start the Jira MCP server (`tsx`) |

## API examples

**Non-streaming** (single JSON body):

```bash
curl -sS -X POST http://localhost:3000/api/release-notes \
  -H "Content-Type: application/json" \
  -d '{"query":"Sprint 20","userAsk":"Highlight risks and blockers."}'
```

**Streaming** (NDJSON lines: `pipeline`, `progress`, then `result` or `error`):

```bash
curl -sS -N -X POST http://localhost:3000/api/release-notes/stream \
  -H "Content-Type: application/json" \
  -d '{"query":"project = KEY","jqlOverride":"project = KEY AND status = Done"}'
```

Either `query` or `jqlOverride` must be non-empty.

## Project layout (high level)

- `src/app/` — Next.js App Router UI and route handlers.
- `src/lib/agents/` — Fetcher, analyzer, writer, and QA agents.
- `src/lib/orchestrator.ts` — Pipeline orchestration and progress hooks.
- `src/lib/jira.ts` — Jira Cloud REST client and search helpers.
- `src/lib/nl-jql.ts` — Natural language to JQL (heuristics + optional LLM).
- `src/lib/llm.ts` — Chat completion client for agents and NL→JQL.
- `src/mcp/jira-mcp-server.ts` — MCP entrypoint for Jira tools.

## Security notes

- Never commit `.env` or real tokens. The repository `.gitignore` excludes `.env` and `.env.local`.
- Prefer fine-scoped Jira tokens and rotate them if exposed.

## License

Private project (`"private": true` in `package.json`). Add a `LICENSE` file if you intend to open-source this repository.
