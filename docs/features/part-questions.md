# Questions about a part: the odb-part agent

Any agent can ask a question about one component with `odb_part_ask`. The plugin hands it to the
`odb-part` subagent, which answers from the part's datasheet and cites pages. If the design has no
datasheet link, or the link is a landing page, the agent looks for the PDF on the web with the user's
own web tools. The agent keeps its context per part: a second question about the same part goes to a
session that already has the datasheet pages and earlier answers, and what it learned is kept on disk
for later chats.

Code: `src/part/` (agent, notes, prompt), page helpers in `src/datasheet.ts`, tools in `src/tools.ts`,
registration in `src/index.ts`. Tests: `test/part.test.ts`.

## Why a tool and not the task tool

OpenCode's `task` tool can resume a subagent session when the caller passes its `task_id` back. Checked
against OpenCode 1.19.0 (`packages/opencode/src/tool/task.ts`), that is not enough here:

1. The `task_id` only lives in the caller's context. It is lost after compaction, in a new chat, and
   when the caller is a short-lived subagent such as `odb-block-explore`.
2. Resuming a session that is still running (two block explorers asking about the same part at once)
   goes through `background.extend` and returns "Additional context sent to the running background
   task" instead of an answer.
3. Subagents calling subagents hit `subagent_depth` and the default `task: deny` of child sessions.
4. A `task_id` is not checked against the agent type.

So the plugin runs the agent itself, like `odb-mapper`: `odb_part_ask` is a plain tool (no depth limit,
any agent can call it), and the plugin decides which session the question goes to. The task tool cannot
launch `odb-part`: the plugin adds a global `task` rule `odb-part: deny`, so it is not offered there.

## Sessions and notes

**Key.** A part is identified by its MPN (upper-cased), so every refdes with that MPN, on any design,
shares one set of notes. Parts without an MPN are keyed by the archive's SHA-256 (first 16 hex
characters) and refdes.

**Notes** (`src/part/notes.ts`): `<cache>/parts/<key>.json`, or `partDir` / `ODB_PART_DIR`. They hold:
- the datasheet in use: URL, `attribute` or `web`, page count, whether the MPN was found in it;
- URLs that did not work and why (last 10);
- every answer: question, answer, pages, source, confidence, the datasheet it was read from, refdes,
  design and date;
- the session that holds this part's context, per chat (last 20 chats).

Writes go through a temp file and a rename.

**Sessions.** One child session per part and chat. The chat is the root session above the caller:
asked from a block explorer, the part session hangs under the user's chat, not under the explorer.
That keeps it reachable in the TUI and makes its permission prompts (`bash: ask`) show up in the
user's chat; the TUI only shows prompts of direct children of the open chat, and hides child sessions
from the session list. A part session is reused within its chat while it exists and its last turn used
at most `partContextTokens` (default 60 000) input tokens. Otherwise a new session starts, seeded with
the notes. A new chat always starts a new session from the notes.

**Order.** Questions about the same part run one after another (an in-process lock per key), so the
session is never prompted while busy.

## One question, step by step (`PartService.ask`)

1. Read the notes. Load the datasheet: the design's datasheet attribute if it gives a PDF, else the
   datasheet in the notes. A failing link is recorded in the notes. An attribute PDF that does not
   contain the MPN is used, and the agent is told to check it.
2. If the same question (ignoring case, spacing and trailing punctuation) was answered before from
   the same datasheet, return that answer, marked as from the notes. No model runs. Answers with
   source `not-found` are never reused.
3. Find or create the part session as above, and record it in the notes.
4. Prompt it with `agent: "odb-part"`. A new session gets the part line (refdes, value, MPN, package,
   manufacturer, design), description, datasheet status, the notes summary (datasheet, failed URLs,
   the last 15 answers) and the question. A reused session gets the part line, datasheet status and
   the question. The model is `partModel` if set, else the model of the message that called the tool.
5. Wait until the agent calls `odb_part_answer`, the prompt returns, `partTimeoutMs` passes (default
   300 s) or the tool call is cancelled. After an answer, the agent gets 15 s to end its turn before
   the session is aborted; on timeout or cancel it is aborted at once.
6. Save the answer in the notes and return it:

```
U12 | TPS62130 | MPN TPS62130RGTR | pkg QFN-16
from the datasheet https://www.ti.com/lit/ds/symlink/tps62130.pdf, p. 4; confidence high

VIN absolute maximum is 20 V.
```

If the agent replied in plain text without `odb_part_answer`, that text is returned, marked as not
saved.

`ctx.metadata` sets the tool call's title to the refdes and question and its `sessionId` to the part
session.

## The agent

Registered in the `config` hook as a hidden subagent (`mode: "subagent"`, `hidden: true`), 20 steps.

| Permission | |
|---|---|
| `odb_part_context`, `odb_part_datasheet`, `odb_part_answer` | allow (denied globally for every other agent; each tool also refuses calls from outside a run) |
| `edit` | deny |
| `bash` | ask, so a shell PDF tool works after one approval |
| `task`, `odb_part_ask` | deny |
| `webfetch`, `websearch` | allow, or deny with `partWeb: "off"` |

Other tools, including the user's MCP servers, stay as the user configured them. Anything set under
`agent["odb-part"]` in `opencode.json` wins over the plugin's defaults; `permission` is merged key by key.

### Its tools

| Tool | What |
|---|---|
| `odb_part_context` | `odb_component`-style detail of the part (pins, nets, neighbours), other refdes on the board with the same MPN, and the notes |
| `odb_part_datasheet` | `info`: URL, page count and an outline (numbered headings with their page, else the first line of each page). `search`: pages containing all words of `query`, matching lines with one line around them, up to 8 pages. `pages`: text of `from`..`to`, at most 5 pages and 12 000 characters, each headed `--- page n ---`. `section`: one chapter by heading (the existing `extractSection`). `set`: register a PDF found on the web |
| `odb_part_answer` | `{ answer, pages?, source, confidence }`; ends the run |

`source` is `datasheet`, `board` (board data only), `web` (other web pages) or `not-found`.
`odb_part_answer` rejects an empty answer, a `datasheet` answer when no datasheet is loaded or
without pages, and pages outside the datasheet. The agent can fix and submit again.

Pages come from `pdftotext -layout`, which separates pages with form feeds (`splitPages`), so page n
of the text is page n of the PDF.

### Finding a datasheet on the web

The prompt (`src/part/prompt.ts`) tells the agent to use whatever web tools the setup has:
`websearch` (OpenCode only offers it with the opencode / opencode-go providers or the Exa / Parallel
flags), an MCP search server, or `webfetch` on the manufacturer's site, starting from the landing page
when the attribute pointed to one. It prefers the manufacturer's PDF and must not use a similar part's
datasheet.

`odb_part_datasheet set` downloads the URL through the existing datasheet cache (`src/datasheet.ts`,
keyed by URL, so a PDF is downloaded once for all designs). It rejects a link that does not return a
PDF, and a PDF that does not contain the MPN or its base without a packaging suffix (`mpnInText`, the
same check as `mpnLookup`). Rejected URLs go into the notes. An accepted one becomes the part's
datasheet with source `web`, and later questions load it up front.

With `partWeb: "off"` the web tools are denied and the prompt says to answer from the board data or
report `not-found`.

## Watching it

The part session is a child of the user's chat. In the TUI, `<leader>↓` from the chat opens the first
child session and `←`/`→` cycle through the children; inside one you see the agent's reasoning (if the
model emits it), tool calls and datasheet reads live. Unlike a `task` call, the chat does not show an
inline card that follows the child's progress; that renderer is only used for the `task` tool.

## Use by other agents

`odb-block-explore` asks `odb_part_ask` for ICs whose function is not obvious, instead of reading the
Description chapter with `odb_datasheet`. `odb-understanding-fix` lists it among the tools for
re-checking a block. `odb_datasheet` stays as the quick way to read one chapter.

## Options

| Option | Env | Default | |
|---|---|---|---|
| `partModel` | `ODB_PART_MODEL` | the calling message's model | `provider/model` for `odb-part` |
| `partWeb` | `ODB_PART_WEB` | on | `off`: no web lookups |
| `partDir` | `ODB_PART_DIR` | `<cache>/parts` | where the notes are stored |
| `partTimeoutMs` | | 300000 | max time for one question |
| `partContextTokens` | | 60000 | a part session whose last turn used more input tokens starts over from the notes |

## Verification

- `test/part.test.ts`, against a stand-in OpenCode client whose "model" is a script driving the tools:
  - page splitting, search, page ranges and outline;
  - the first question creates a child of the root chat and runs on the caller's model;
  - a second question reuses the session;
  - an identical question for another refdes with the same MPN comes from the notes without a prompt;
  - two parallel questions run one after another;
  - a new chat gets a session seeded with earlier answers;
  - a session over budget is replaced;
  - a web datasheet without the MPN is rejected, the right one is kept and loaded by a new service;
  - a landing-page attribute is reported to the agent and recorded;
  - `not-found` answers are not reused, and page checks reject bad answers;
  - a plain-text reply is passed through but not saved;
  - the tools refuse calls from outside a run;
  - config registration, web off and user overrides.
- With the real OpenCode 1.19.0 CLI in this repo:
  - `opencode debug agent odb-part` shows the three part tools allowed, `task` and `odb_part_ask`
    denied, `bash` ask and `webfetch`/`websearch` allowed.
  - `opencode debug agent build`, `odb-explore` and `odb-block-explore` show the part tools denied and
    `task` denied for `odb-part`, with `odb_part_ask` available.
  - `opencode debug config` shows the global `task: { "odb-part": "deny" }`.

## Limits

- No run with a real model yet. Prompt quality, the web search, the reuse of a live session and the
  15 s wind-down after an answer are untested against OpenCode itself.
- Page outlines rely on numbered headings; datasheets without them get the first line of each page.
- Scanned datasheets without a text layer give no text; the agent can only try a shell OCR tool if
  the user allows it.
- The lock is per process. Two OpenCode processes asking about the same part at the same time can
  both write the notes; the last write wins.
