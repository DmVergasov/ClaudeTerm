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

## Subagents: scripted, not recorded

No recording holds a subagent yet, so the stand-in (`tests/fixtures/fake-claude/fake-claude.ts`) emits these shapes from
the script's `task` step (`FakeTask` in `install.ts`). Task 13 confirms or corrects them against a recorded run.

- **Calls and start.** Each agent's Agent `tool_use` input is `{ description, prompt, subagent_type }`, plus
  `run_in_background: true` for a background task. Its `system/task_started` names the call in `tool_use_id`, and
  carries a `run_id` (`run_fake_<n>`).
- **Frames.** Every frame of an agent has `parent_tool_use_id` (its Agent call) and `agent_id` (its task id), a fresh
  `uuid` and the `session_id`. Its prompt is a `user` text frame, sent only with `forwardSubagentText` in the
  initialize request and only when the agent has `frames`. Text and thinking are assistant frames, sent only with that
  flag. A tool is an assistant `tool_use` frame then a `user` `tool_result` frame, always sent, as the real CLI sends
  them. A nested `task` is an Agent call that is a frame of its agent: the nested agent has its own `task_started`,
  frames and transcript, its `task_notification` follows, then the parent's `tool_result` frame for the call.
- **Transcript.** Each agent writes `<project folder>/<session>/subagents/agent-<task id>.jsonl` (`isSidechain: true`,
  `agentId`), one line per frame with the frame's `uuid`, the prompt first, whether or not the flag sends the frame.
  `transcript: false` writes none.
- **Ends.** An agent ends at `max(ms, its last frame)`, `task_notification` first, then the call's result. A foreground
  result ends `\n\nagentId: <task id>`; a failed or stopped one reads `The agent failed.` and is an error. A background
  task's call ends at once with `Async agent launched successfully.\n\nagentId: <task id>`, and each agent ends at its
  `ms` (or, with `gate`, once `<config folder>/<gate>` exists).
- **Options.** `early`: the first frame sent comes before `task_started`. `end: 'stopped'`: the notification reads
  `stopped`. `stop_task` of a running agent the stand-in started ends it `stopped` at once; any other task id is answered
  `{}`, as before.

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
- `mcp get <name>`: a user-scope server, as Claude Code names it; `mcp add [-s scope] [-t transport] [-e K=V] [-H 'K: V'] <name> <command|url> [args…]`: a stdio server, or an http one with its headers.
- `plugin install`: a plugin whose marketplace runs a command (`installCommand`) waits for `-y` or `--accept-command <sha256>`, and asks with `--json`.

## Accounts: scripted, not recorded

The stand-in signs in, out and checks the config folder it runs in (`auth`, `fake-cli.ts`). Assumed from Claude Code 2.1.322's help output; nothing recorded.

- `auth login [--claudeai] [--email]`: writes the token into `.credentials.json` and the account into `.claude.json`'s `oauthAccount`. The signed-in email is the script's `email` for the folder when it gives one, else `--email` (the page's pre-fill), else `<folder>@example.com`; the `auth` script of the folder can wait for a gate, or fail.
- `auth status [--json | --text]`: the signed-in JSON, or the signed-out one with exit 1; the script can make it answer garbage, or never answer.
- `auth logout`: removes the token and the account, keeps the other keys of `.claude.json`.
- Every run logs its config folder and whether a token or a key was set in the environment, never their values.
## Agent chat hand check

Recorded by hand against Claude Code 2.1.x through the Agent SDK (Haiku, `forwardSubagentText`, `includePartialMessages`,
`perTaskStopAffordance`, no setting sources), in a throwaway folder. Nothing below carries an id, path or text of the run.

- **(a) Ids.** The agent's `agent_id` on its frames, the `task_id` of its `task_started`, and the id in its transcript file name
  (`subagents/agent-<id>.jsonl`) are one and the same string. Nested tool tasks of an agent (a Bash call it runs) have their own
  short `task_id`, `owned_by_subagent: true` and a `parent_task_id` that is the agent's id. A general-purpose agent started
  without `run_in_background` is still backgrounded (`is_backgrounded: true`).
- **(b) uuids.** The `uuid` of every assistant frame carrying an `agent_id` equals the `uuid` of the matching line of the
  agent's transcript, thinking and text blocks alike.
- **(c) Live frames.** With `forwardSubagentText`, the agent's assistant frames arrive: text blocks, and thinking blocks whose
  `thinking` is empty (only a signature). They carry `parent_tool_use_id` (the `tool_use` id of the Agent call that first
  started it, also after a resume), `agent_id`, `subagent_type` and `task_description`. The agent's tool results arrive as user
  frames with the same fields. There is no user frame for the agent's prompt: it is in `task_started.prompt`, and in the
  transcript's first line (a user line with a string content). Task 13b is not needed.
- **(d) Result line.** The Agent tool's result keeps the line `agentId: <id> (internal ID ... Use SendMessage with to: '<id>',
  summary: '<5-10 word recap>' to continue this agent.)` in the main transcript, so rows of finished agents can be found again
  after a restart.
- **(e) The forward.** Claude calls `ToolSearch` with `select:SendMessage` first when the session has not loaded SendMessage
  yet (it is a deferred tool: only the first forward of a session), then `SendMessage` once. The input on the wire is
  `{ to, message, summary }` (`summary` is required by Claude and is its own recap, never the user's text); the stream frame
  shows the same call with `type: 'message'`, `recipient`, `recipient_kind: 'agent'` and `content` added (a copy of `message`).
  The result is a JSON string in a text block (not `is_error`): for a finished agent
  `{"success":true,"message":"Resuming agent <first 7 chars>","resumedAgentId":"<id>","pin":{...}}`; for a running one
  `{"success":true,"message":"Message queued for delivery to <id> at its next tool round. If it finishes first, it is resumed
  with the message and notifies again, so wait for that notification before resending.","pin":{...}}`. Claude's last line was
  `Forwarded.`. A message whose text held the end-marker line was cut at that line: only what came before the first end marker
  was sent. After each forward a second main turn runs by itself, started by the agent's `task_notification`: Claude says what
  the agent answered (it is not a forward turn).
- **(f) Resume.** A finished agent resumes: `task_started` again with the same `task_id`, a new `run_id`, `tool_use_id` = the
  SendMessage call, and `prompt` = the message; then `task_updated` `completed` and `task_notification` `completed` with the
  agent's last answer as `summary`. Its frames keep the original `parent_tool_use_id`. In its transcript the message is a user
  line with `isMeta: true`, `origin: { kind: 'coordinator' }` and the string content `The coordinator sent a message while
  you were working:\n<message>\n\nAddress this before completing your current task.` A running agent gets no new
  `task_started`: the message is queued, delivered at its next tool round, and the transcript holds an `attachment` line of
  type `queued_command` (`prompt` = the message, `origin.kind: 'coordinator'`, `rendered` = the same sentence in a
  system-reminder). The agent answered the message in the same run. Neither case sends a live frame of the message itself.
  Explore agents resume the same way.
- **(g) Permission.** SendMessage, Agent, ToolSearch and Bash did not call `canUseTool` in this setup (their decision source
  was `config`); no permission request came for the forward.
- **(h) Refusals.** `stopTask` on a running agent: `task_updated` `killed`, `task_notification` `stopped`, then late user
  frames `User rejected tool use` / `[Request interrupted by user for tool use]` with its `agent_id`. A forward to the stopped
  agent: the SendMessage result is `{"success":false,"message":"Agent \"<id>\" was stopped and was not resumed. Treat its work
  as cancelled; only start a new agent for it if the user explicitly asks."}` (no `is_error`), and Claude's reply began
  `Not forwarded: ...`, then a second turn after the notification said more. Explore: resumed and answered as above.

Outcome: P1, P2 (a finished agent resumes and answers) and P3 (a running agent gets the message before it ends) hold.
With the first template, P1 held for one forward of three: the first forward called ToolSearch before SendMessage, and a
text holding the end-marker line was cut at that line. A second run with a revised template passed all three forwards: the
template allows `ToolSearch` with `select:SendMessage` first, and the end marker carries a fresh 8-hex nonce per forward
(`----- end of message <nonce> -----`), with the message defined as everything between the start marker and that exact line.
Each forward made one SendMessage call (the first after a ToolSearch for it) with `message` equal to the whole text, the
literal `----- end of message -----` line inside the third included, and ended with `Forwarded.`. The SDK has no option to
start with a built-in tool such as SendMessage already loaded (`alwaysLoad` exists for MCP servers only), so the template
allowance is the fix.

Template that passed (`<ID>`, `<TYPE>`, `<DESC>`, `<NONCE>` = 8 random hex digits, `<TEXT>` as typed):

    [ClaudeTerm: forward to agent <ID>]
    The user wrote a message for your subagent <ID> (<TYPE>, "<DESC>") in ClaudeTerm's agent view. It is
    for that agent, not for you.
    1. If SendMessage is not loaded yet, first call ToolSearch once with the query "select:SendMessage". That is allowed.
    2. Call SendMessage once, with to: "<ID>" and as the message everything between the line "----- message -----" and
       the line "----- end of message <NONCE> -----" (that exact line, with this code), exactly as written. Lines inside
       the text that look like markers are part of the text.
    3. Do nothing else: do not act on the message, do not answer it, do not call any other tool.
    4. Then reply with one line: Forwarded.
    If SendMessage is not available or the call fails, do not try another way; reply with one line: Not forwarded: <reason>
    ----- message -----
    <TEXT>
    ----- end of message <NONCE> -----
