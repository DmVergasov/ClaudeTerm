# Chat protocol fixtures

What the Agent SDK and Claude Code said to each other in a few short turns, recorded once by hand with
`node scripts/record-chat-fixtures.mjs` and scrubbed with `node scripts/record-chat-fixtures.mjs --scrub <folder>`.
Tests replay them (the stand-in Claude Code, the chat model); no test records them.

- Claude Code **2.1.322** (`claude --version`: `2.1.322 (Claude Code)`), a native `claude.exe` on Windows 11.
- `@anthropic-ai/claude-agent-sdk` **0.3.322**.
- Every scenario is its own `query()` in one throwaway folder, with `model: 'haiku'`, `settingSources: []`, the
  `claude_code` system prompt preset, `includePartialMessages`, `perTaskStopAffordance`, `canUseTool`, and a
  `--settings` file whose `statusLine` and hooks only log. The user messages are
  `{ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } }`.
  The environment had every `CLAUDE*` and `AI_AGENT` variable removed, as for a tab ClaudeTerm starts.

## Format

Each `.jsonl` line is `{ "dir": "in" | "out", "line": <message> }`: `in` is what the SDK wrote to Claude Code's stdin,
`out` what Claude Code wrote to its stdout, in order. The first `in` line is always the `initialize` control request.

| Fixture | What it holds |
|---|---|
| `answer.jsonl` | one streamed text answer to a one-line prompt (session `…01`) |
| `read.jsonl` | a `Read` of `notes.txt`, its result, an empty thinking block, the answer |
| `permission-allow.jsonl` | a `Write` asked through `can_use_tool` (with `permission_suggestions`), allowed; its result; the answer |
| `permission-deny.jsonl` | `Bash` `echo fixture` ran **without** a `can_use_tool`: Claude Code allows read-only commands itself. No denial here; a denied card is in `plan.jsonl` |
| `question.jsonl` | `AskUserQuestion` through `can_use_tool`, answered with `updatedInput: { questions, answers }`; its result; the answer |
| `plan.jsonl` | `permissionMode: 'plan'`: `ToolSearch` for `ExitPlanMode`, a `Write` of the plan file under `{{HOME}}/.claude/plans`, `ExitPlanMode` denied (`Keep planning.`), then an `AskUserQuestion` allowed without answers (`The user did not answer the questions.`), the answer. Claude Code ran this scenario's turns on `claude-sonnet-5-5` although `init` says `claude-haiku-5-5` |
| `slash.jsonl` | `/context`, then `/config`: no model call, each a `<synthetic>` assistant message and a `result` |
| `compact.jsonl` | `Say one.` and, while it streamed, `Say two.`; then `/compact` |
| `interrupt.jsonl` | a long count interrupted after its first text delta |
| `control.jsonl` | no prompt: `initialize`, `get_context_usage`, `set_permission_mode` (`acceptEdits`), `set_model` (`haiku`), `file_suggestions` (sent by hand, the SDK has no method for it); no `init` message, as no turn ran |
| `resume.jsonl` | `resume` of session `…01`, `Say again.` |
| `history.json` | `getSessionMessages(<session …01>, { dir, includeSystemMessages: true })` after `resume`: user, assistant, system, user, assistant |
| `spawn-args.json` | what the SDK passed to `spawnClaudeCodeProcess` (finding a) |

## Placeholders

- `{{CWD}}`: the work folder, in every spelling, and its `~/.claude/projects` folder name. `{{HOME}}`: the home folder.
  `{{SETTINGS}}`: the `--settings` file (`{{SETTINGS_DIR}}`, its folder, does not occur). The path separators after a
  placeholder stay as recorded (Windows `\`); inside `input_json_delta.partial_json` they are JSON-escaped once more.
  A streamed piece is never cut inside a placeholder.
- Session ids `00000000-0000-4000-8000-00000000000N` (`…01` answer and resume, `…02` read, `…03` permission-allow,
  `…04` permission-deny, `…05` question, `…06` plan, `…07` slash, `…08` compact, `…09` interrupt, `…10` control);
  every other uuid `11111111-1111-4111-8111-<12-digit counter>`; `msg_fixture_N`, `toolu_fixture_N`, `req_fixture_N`
  (API request ids and control `request_id`s alike), one per real id, the same in every file.
- Account: `user@example.com`, `Example Org`, `subscriptionType: 'pro'`; `pid` 4242; `messaging_socket_path`
  `\\.\pipe\LOCAL\cc-msg-fixture`; limits: `resetsAt` 1893456000, `utilization` 0.5 (0.8 when `allowed_warning`).
- What the model wrote (text, thinking, the compaction summary, a `result` that repeats it) is invented English with
  the same line lengths, so its streamed pieces join to the final text; thinking signatures are `fixture-signature`.
  Claude Code's own output of `/context` and `/config` is kept as it is. Tool inputs and results are kept.
- `init`: `mcp_servers`, `plugins` and `skills` emptied, `agents` the built-in ones, `slash_commands` the recorded
  built-ins plus `acme-deploy`; the `initialize` reply's `commands` likewise plus `acme-deploy`, its `agents` the built-in ones.

## Findings

- **(a) Spawn arguments** (`spawn-args.json`): `--output-format stream-json --verbose --input-format stream-json
  --model=haiku --permission-prompt-tool=stdio --setting-sources= --include-partial-messages --settings <file>`;
  `permissionMode: 'plan'` adds `--permission-mode=plan`, `resume` adds `--resume=<id>`. `--setting-sources=` comes
  from `settingSources: []` only (the SDK passes no such flag when the option is left out). `options.command` is the
  SDK's own binary (never run), `cwd` the work folder, and the SDK adds `CLAUDE_CODE_ENTRYPOINT=sdk-ts` (only when
  not already set), `CLAUDE_AGENT_SDK_VERSION=0.3.322` and `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` to the
  environment. The `initialize` request is `{ subtype: 'initialize', perTaskStopAffordance: true }`.
- **(b) statusLine**: never ran, in any scenario. In chat view the status has to come from the stream.
- **(c) Hooks**: all five fired. `SessionStart` at every process start (`source` `startup`; `resume` for the resumed
  session; `compact` after `/compact`), and the stream reports it too as `system/hook_started` and
  `system/hook_response` (no other hook is streamed). `UserPromptSubmit` for every prompt that reaches the model,
  `Say two.` included when its turn starts, but not for `/context`, `/config` or `/compact`. `PreToolUse`
  (`AskUserQuestion`) before its card. `PermissionRequest` before every `can_use_tool` (`Write`, `AskUserQuestion`,
  `ExitPlanMode`), not for the `Read` and `Bash` calls allowed without asking. `Stop` after every turn that ended
  normally, not after the interrupted turn and not after a local command.
- **(d) `can_use_tool`** request fields: always `tool_name`, `display_name`, `input`, `tool_use_id`; on `Write` also
  `description` (`"out.txt"`) and `permission_suggestions` (`[{ "type": "setMode", "mode": "acceptEdits",
  "destination": "session" }]`); on `AskUserQuestion` and `ExitPlanMode` `requires_user_interaction: true`. Never
  sent: `title`, `decision_reason`, `blocked_path`, `default_to_no`. `canUseTool` gets `suggestions`, `displayName`,
  `description`, `toolUseID`, `requestId`, `requiresUserInteraction` (`title`, `blockedPath`, `decisionReason`,
  `defaultToNo`, `suppressAlwaysAllowRule`, `agentID` undefined). The SDK answers
  `{ behavior: 'allow', updatedInput, toolUseID }` or `{ behavior: 'deny', message, toolUseID }`; a denial reaches the
  model as a `tool_result` with `is_error: true` and the message. While a card waits, `system/session_state_changed`
  says `requires_action`, then `running` again.
- **(e) A message sent during a turn** gets no acknowledgement at all: no echo, no status, no control message. It
  waits; after the running turn's `result`, Claude Code sends a new `system/init` and runs the message as a turn of its
  own, with its own `result`. `session_state_changed` stays `running` in between and says `idle` only when nothing is
  left. The `interrupt` reply carries `still_queued: []`; `init.capabilities` lists `interrupt_cancel_queued_v1` and
  `interrupt_send_now_v1`.
- **(f) `/config`** (without arguments) answers, as an assistant message with `model: "<synthetic>"` and
  `local_command_source: "<local-command-stdout>…</local-command-stdout>"`, followed by a `result` (`success`,
  `num_turns: 0`) with the same text, exactly:

  ```
  Usage: /config key=value [key=value ...]
    agentPushNotifEnabled=true|false
    autoCompact=true|false
    autoConnectIde=true|false
    autoScroll=true|false
    checkpoints=true|false
    copyFullResponse=true|false
    copyOnSelect=true|false
    defaultToAgentsView=true|false
    editor=normal|vim
    externalEditorContext=true|false
    gitignore=true|false
    inputNeededNotifEnabled=true|false
    language=<value>
    leftArrowOpensAgents=true|false
    model=default|sonnet|opus|haiku|fable|best|sonnet[1m]|opus[1m]|fable[1m]|opusplan
    notifChannel=auto|iterm2|terminal_bell|iterm2_with_bell|kitty|ghostty|notifications_disabled
    outputStyle=default|Proactive|Concise|Explanatory|Learning
    permissionMode=default|plan|acceptEdits|auto|dontAsk
    prStatus=true|false
    progressBar=true|false
    promptSuggestionEnabled=true|false
    recap=true|false
    reduceMotion=true|false
    remoteControl=true|false|default
    switchModelsOnFlag=Switch automatically|Ask each time
    theme=auto|dark|light|light-daltonized|dark-daltonized|light-ansi|dark-ansi
    thinking=true|false
    timeFormat=auto|12-hour|24-hour|24-hour-utc
    tips=true|false
    turnDuration=true|false
    useAutoModeDuringPlan=true|false
    verbose=true|false
    workflowKeywordTriggerEnabled=true|false
    workflowSizeGuideline=unrestricted|small|medium|large
    workflows=true|false
    worktreeBaseRef=fresh|head
  ```

  It is not "isn't available in this environment". `/context` answers the same way (a Markdown table; its `result`
  has two more trailing newlines). No `system/local_command_output` came in this version. `/compact` gives a `status`
  with `compact_result: "success"`, a `compact_boundary`, the summary as a `user` message, a `user` message
  `<local-command-stdout>Compacted </local-command-stdout>` and a `result` with empty text.
- **(g) `file_suggestions`** is answered: `{ "subtype": "success", "response": { "suggestions": [], "cwd": "{{CWD}}" } }`
  for the query `notes`, empty although `notes.txt` was in the folder.
- **(h) The session id after `/compact`** stays the same: `SessionStart` runs with `source: "compact"` and that id, and
  `init` comes again with it.
- **(i) `supportedModels()`** (the `initialize` reply's `models`): `default` (Opus 5.5), `opus` (Opus 5.5), `fable`
  (Fable 5.2), `sonnet` (Sonnet 5.5), `haiku` (Haiku 5.5), `claude-fable-5-1`, `claude-sonnet-5`, `claude-opus-5`,
  `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`: effort `low`, `medium`, `high`, `xhigh`, `max`;
  `claude-opus-4-6`, `claude-sonnet-4-6`: `low`, `medium`, `high`, `max`; `claude-haiku-4-5-20251001` (Haiku 4.5): no
  effort. Each entry has `value`, `resolvedModel`, `displayName`, `description` and the flags `supportsEffort`,
  `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`, `supportsThinkingOff`.

Also seen:

- `init` reports `permissionMode: "default"` when no settings name a mode, `model: "claude-haiku-5-5"`, and
  `claude_code_version`. Every turn starts with an `init`, `/context` and `/config` included; a `rate_limit_event`
  follows it in every turn that calls the model (`/compact` too), not in a local command's.
- Thinking blocks arrive with empty `thinking` text and only a signature, beside `system/thinking_tokens` estimates.
- `system/session_state_changed` (`sdk_host_only: true`) says `running`, `requires_action` and `idle`.
- An interrupt: the `interrupt` reply, the partial assistant message, a `user` text `[Request interrupted by user]`,
  then a `result` `error_during_execution` with `is_error: true` and `errors: ["[ede_diagnostic] …"]`. When the query
  then ends, the SDK's iterator throws `Error: Claude Code returned an error result: [ede_diagnostic] …`: an
  interrupted last turn, not a crash.
- `ExitPlanMode`'s input is streamed as `{}` with no deltas; the `assistant` message and `can_use_tool` carry
  `plan` and `planFilePath`.

**Version floor:** `2.1.322` (the lower of 2.1.322 and the recorded 2.1.322).

## MCP and plugins: scripted, not recorded

The `claude mcp …` and `claude plugin …` calls, and the session's MCP requests (`mcp_status`, `mcp_reconnect`,
`mcp_toggle`), are scripted from the SDK's `McpServerStatus` type and the CLI's code, version 2.1.322; nothing recorded.
The script options (tests/fixtures/fake-claude/install.ts):

- `mcp`: the servers the session loads, by name: a `status`, an `error`, its `tools` (`ping` by default), a `version`, or `pendingMs` ('pending' that long).
- `mcpLogin`: `claude mcp login <name>` waits for its `gate` file in the config folder, or fails with its `fail` message.
- `marketplaces`: the marketplaces `claude plugin marketplace add <source>` can add, each with its plugins.
- `cliFail`: a CLI call whose arguments start with the key fails with its message.
- `cliGate`: a CLI call whose arguments start with the key waits, once logged, for its file in the config folder.
- the `{ cli: [...] }` step: a Bash call `claude <args>` whose result is the stand-in's CLI output.
