import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { StatusMessage } from '../../src/shared/protocol'
import { assistantLine, promptLine } from '../fixtures/transcript'

/** a status push of a Claude tab: its model, its context and its limits */
export const statusMsg = (tabId: string, sessionId: string): StatusMessage => ({
  v: 1,
  type: 'status',
  tabId,
  sessionId,
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  effort: 'xhigh',
  context: { usedTokens: 82_314, size: 200_000, usedPct: 41.2 },
  fiveHour: { usedPct: 23.5, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
  sevenDay: { usedPct: 41.2, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 }
})

export interface WorkflowRunFiles {
  /** the session's main transcript: it names the run in the Workflow call's result */
  transcriptPath: string
  /** the run's end in its journal: each agent's result */
  finish(): void
  /** the run file of a completed run, as Claude Code writes it when the run ends */
  complete(): void
}

/** the session's main transcript: the file the app is told about in the `session` message */
export const mainTranscript = (projectDir: string, sid: string): string => join(projectDir, `${sid}.jsonl`)

/**
 * a Workflow run as Claude Code keeps it on disk: the run's folder with its journal and its agents' transcripts, the session's
 * main transcript with the Workflow call's result, and the run file once it completes. `projectDir` is the project's folder.
 * The result is appended to the main transcript, so two runs can share a session; `at` is when the run started (now by default):
 * the result's timestamp, and the run folder's time, which is what the app takes for a run that is history.
 */
export function writeWorkflowRun(o: {
  projectDir: string
  sid: string
  runId: string
  taskId: string
  workflowName: string
  agents: { agentId: string; label: string; phase: string }[]
  at?: Date
}): WorkflowRunFiles {
  const at = o.at ?? new Date()
  const runDir = join(o.projectDir, o.sid, 'subagents', 'workflows', o.runId)
  mkdirSync(runDir, { recursive: true })
  const transcriptPath = mainTranscript(o.projectDir, o.sid)
  const journal = join(runDir, 'journal.jsonl')
  const lines = (rows: object[]): string => rows.map((row) => JSON.stringify(row) + '\n').join('')
  writeFileSync(journal, lines(o.agents.map((a, i) => ({ type: 'started', key: `k${i + 1}`, agentId: a.agentId, label: a.label, phase: a.phase }))))
  for (const a of o.agents) {
    writeFileSync(join(runDir, `agent-${a.agentId}.jsonl`), assistantLine('claude-haiku-5-5', 'low') + '\n' + promptLine(`Triage crash ${a.agentId}`) + '\n')
  }
  // writing files moves a folder's time: the run folder gets its time last
  utimesSync(runDir, at, at)
  // the Workflow call's result: the run's id and its task, as Claude Code writes them in the main transcript
  const id = createHash('sha1').update(o.runId).digest('hex').slice(0, 12)
  appendFileSync(transcriptPath, lines([{
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tw-${id}`, content: 'Workflow started' }] },
    toolUseResult: { status: 'async_launched', taskId: o.taskId, taskType: 'local_workflow', workflowName: o.workflowName, runId: o.runId, transcriptDir: runDir, scriptPath: '' },
    timestamp: at.toISOString(),
    uuid: `6f1c2a40-3b1e-4c5d-8e7f-${id}`
  }]))
  return {
    transcriptPath,
    finish: () => appendFileSync(journal, lines(o.agents.map((a, i) => ({ type: 'result', key: `k${i + 1}`, agentId: a.agentId, result: 'ok' })))),
    complete: () => {
      const runFolder = join(o.projectDir, o.sid, 'workflows')
      mkdirSync(runFolder, { recursive: true })
      writeFileSync(join(runFolder, `${o.runId}.json`), JSON.stringify({ runId: o.runId, taskId: o.taskId, workflowName: o.workflowName, status: 'completed', startTime: Date.now() - 5000, durationMs: 5000, workflowProgress: [] }))
    }
  }
}
