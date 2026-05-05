import { runFetcher, type FetcherInput } from "@/lib/agents/fetcher";
import { runAnalyzer } from "@/lib/agents/analyzer";
import { runWriter } from "@/lib/agents/writer";
import { runQa } from "@/lib/agents/qa";

export type PipelineRequest = FetcherInput & {
  userAsk: string;
};

export type PipelineStepLog = {
  agent: "fetcher" | "analyzer" | "writer" | "qa";
  detail: Record<string, unknown>;
};

export type PipelineResult = {
  releaseNotesMarkdown: string;
  jql: string;
  issueKeys: string[];
  /** Issues in this run after fetch (same as issueKeys.length). */
  issueCount: number;
  /** Jira-reported total hits for the executed JQL (may be > issueCount). */
  jiraTotalHits: number;
  subtasksExcluded: boolean;
  qa: {
    approved: boolean;
    issues: string[];
  };
  steps: PipelineStepLog[];
};

export type AgentName = PipelineStepLog["agent"];

/** Emitted when an agent starts or finishes (for streaming UIs / logs). */
export type PipelineProgressEvent = {
  phase: "start" | "end";
  agent: AgentName;
  at: string;
  elapsedMs?: number;
  detail?: Record<string, unknown>;
};

export type PipelineProgressHandler = (event: PipelineProgressEvent) => void;

function emit(
  onProgress: PipelineProgressHandler | undefined,
  event: Omit<PipelineProgressEvent, "at"> & { at?: string },
) {
  onProgress?.({
    ...event,
    at: event.at ?? new Date().toISOString(),
  });
}

async function trackAgent<T>(
  agent: AgentName,
  onProgress: PipelineProgressHandler | undefined,
  run: () => Promise<{ value: T; detail: Record<string, unknown> }>,
): Promise<T> {
  emit(onProgress, { phase: "start", agent });
  const t0 = Date.now();
  try {
    const { value, detail } = await run();
    emit(onProgress, {
      phase: "end",
      agent,
      elapsedMs: Date.now() - t0,
      detail,
    });
    return value;
  } catch (e) {
    emit(onProgress, {
      phase: "end",
      agent,
      elapsedMs: Date.now() - t0,
      detail: { error: e instanceof Error ? e.message : String(e) },
    });
    throw e;
  }
}

export async function runReleaseNotesPipeline(
  body: PipelineRequest,
  onProgress?: PipelineProgressHandler,
): Promise<PipelineResult> {
  const steps: PipelineStepLog[] = [];

  const fetched = await trackAgent("fetcher", onProgress, async () => {
    const r = await runFetcher({
      query: body.query,
      jqlOverride: body.jqlOverride,
    });
    return {
      value: r,
      detail: {
        jql: r.jql,
        issueCount: r.issueCount,
        jiraTotalHits: r.jiraTotalHits,
        subtasksExcluded: r.subtasksExcluded,
      },
    };
  });
  steps.push({
    agent: "fetcher",
    detail: {
      jql: fetched.jql,
      issueCount: fetched.issueCount,
      jiraTotalHits: fetched.jiraTotalHits,
      subtasksExcluded: fetched.subtasksExcluded,
    },
  });

  const grouped = await trackAgent("analyzer", onProgress, async () => {
    const r = await runAnalyzer(fetched.briefLines);
    return {
      value: r,
      detail: {
        bugs: r.bugs.length,
        features: r.features.length,
        risks: r.risks.length,
        blockers: r.blockers.length,
        notes: r.notes,
      },
    };
  });
  steps.push({
    agent: "analyzer",
    detail: {
      bugs: grouped.bugs.length,
      features: grouped.features.length,
      risks: grouped.risks.length,
      blockers: grouped.blockers.length,
      notes: grouped.notes,
    },
  });

  const draft = await trackAgent("writer", onProgress, async () => {
    const r = await runWriter({
      grouped,
      briefLines: fetched.briefLines,
      userAsk: body.userAsk,
    });
    return { value: r, detail: { chars: r.length } };
  });
  steps.push({ agent: "writer", detail: { chars: draft.length } });

  const issueKeys = fetched.issues.map((i) => i.key);
  const qa = await trackAgent("qa", onProgress, async () => {
    const r = await runQa(draft, issueKeys, body.userAsk);
    return {
      value: r,
      detail: { approved: r.approved, issues: r.issues },
    };
  });
  steps.push({
    agent: "qa",
    detail: { approved: qa.approved, issues: qa.issues },
  });

  const releaseNotesMarkdown =
    qa.approved || !qa.revisedMarkdown ? draft : qa.revisedMarkdown;

  return {
    releaseNotesMarkdown,
    jql: fetched.jql,
    issueKeys,
    issueCount: issueKeys.length,
    jiraTotalHits: fetched.jiraTotalHits,
    subtasksExcluded: fetched.subtasksExcluded,
    qa: { approved: qa.approved, issues: qa.issues },
    steps,
  };
}
