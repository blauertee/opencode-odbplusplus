# Board exploration: explore subagents, saved understanding, user corrections

`odb_overview` gives a cheap, deterministic skeleton of a board ([board-overview.md](board-overview.md)).
This feature adds the step after that. Three subagents work out what the board and each block actually
do, the result is saved for later sessions and other agents, and the user can correct it in a file the
agents never overwrite.

Code: `src/explore/` (agents, prompts, schema, corrections file, schematic discovery, cache, validation,
rendering), tools in `src/tools.ts`, registration in `src/index.ts`.
Tests: `test/explore.test.ts`, plus one case per test board in `test/integration.test.ts`.

## The agents

All three ship with the plugin and are registered in the `config` hook. All are subagents only
(`mode: "subagent"`, visible in the `@` menu), like OpenCode's built-in `explore`. The user stays in
their own primary agent, which launches them with the `task` tool, or calls one with `@`. Nothing starts
them automatically. Anything set under `agent.<name>` in `opencode.json` wins over the plugin's defaults;
`permission` is merged key by key.

| | `odb-explore` | `odb-block-explore` | `odb-understanding-fix` |
|---|---|---|---|
| called by | the user (`@odb-explore`) or the primary agent | `odb-explore`, or the user (`@odb-block-explore USB3`) | the primary agent, which must call it when the user corrects saved understanding, or the user (`@odb-understanding-fix`) |
| job | board-level understanding, coordinating block explorers | understand one block, or a batch of small ones | record a user correction and rewrite every saved result it affects, in the same run |
| launches | `odb-block-explore` (and nothing else): `task: { "*": "deny", "odb-block-explore": "allow" }` | nothing | nothing |
| may write | `odb_explore_submit_board`, `odb_explore_submit_block` | `odb_explore_submit_block` | `odb_understanding_correct`, `odb_explore_submit_block`, `odb_explore_submit_board` |
| steps | 40 | 25 | 30 |
| model | `exploreModel` / `ODB_EXPLORE_MODEL`, else the session's | `blockExploreModel`, else `exploreModel` | `fixModel`, else `exploreModel` |

All three: `edit: deny` (they never write files themselves) and `bash: ask`, so a shell PDF tool
works after one approval and can be allowed per command in `opencode.json`. Other tools, including the
user's MCP servers and `read`, stay available.

### odb-explore

The prompt (`src/explore/prompts.ts`) has it:
1. read `odb_understanding`, and stop there if everything is current and no refresh was asked for
2. get the skeleton from `odb_overview` and `odb_interfaces`
3. skim the schematic if there is one
4. plan which blocks need work: missing or stale ones, or all of them on a refresh. Small blocks are
   batched, and a run launches at most `exploreMaxSubagents` (default 12) block explorers.
5. launch them in one step so they run in parallel
6. put the board picture together and submit it with `odb_explore_submit_board`
7. answer with a compact summary that ends with the correction rule (below)

If the task tool is refused (see nested subagents), it explores the blocks itself, one after another.

### odb-block-explore

Steps: `odb_understanding {block}` → `odb_block` → `odb_component` for key parts → `odb_datasheet`
(Description) where the function is not obvious → `odb_interfaces {refdes}` → schematic pages →
`odb_explore_submit_block`.

It submits:
- a title and a function
- the key parts with their roles
- the interfaces in and out, with the peer block where known
- the rails it uses or produces
- notes on anything odd
- a confidence level, the evidence and open questions

### odb-understanding-fix

Its description says it must be launched whenever the user disagrees with or corrects saved
understanding. The same rule ends every `odb_understanding` output and every `odb-explore` summary:

> If the user disagrees with or corrects any of this, launch the odb-understanding-fix subagent with the
> task tool before answering: pass the design, the user's words verbatim, the claim being corrected and
> the affected block(s).

Steps:
1. look at what is saved
2. check the correction against the board data. It never overrules the user: a conflict is recorded
   anyway and reported back.
3. record it with `odb_understanding_correct`, first
4. find the other saved results that relied on the wrong claim (`odb_understanding {mentions}`)
5. re-analyse each affected block with the correction as ground truth and resubmit it, then resubmit
   the board result if it was affected
6. report what changed

There is no "contradicted" state. The fixer rewrites the affected entries directly. If a run ends early,
the corrections file already holds the user's statement and is shown above the cached text.

### Nested subagents

Checked against OpenCode 1.18.35 (`packages/opencode/src/tool/task.ts`, `agent/subagent-permissions.ts`).
With default settings a subagent cannot launch subagents, for two reasons:
1. `subagent_depth` defaults to 1. `odb-explore` always runs in a child session (an `@` mention of a
   subagent also goes through the task tool), so its own task calls would fail.
2. A child session gets `task: deny` unless the agent's own permissions have a `task` rule.

The plugin handles both:
- `odb-explore` carries its own `task` rule.
- The `config` hook sets `subagent_depth: 2` when it is unset. A value the user set stays, including 1,
  in which case `odb-explore` falls back to exploring blocks itself. Only subagents with their own
  `task` rule can nest; built-in `general` and `explore` have none.

Verified with the real OpenCode 1.18.35 CLI in this repo:
- `opencode debug config` shows `subagent_depth: 2` and all three agents.
- `opencode debug agent odb-explore` shows `task` allowed for `odb-block-explore` only.
- `opencode debug agent build` shows the three write tools disabled.

A run with a model has not been done yet.

### Why permissions, not `tools`

OpenCode translates an agent's `tools` map into permissions when it parses its config files. Plugin
`config` hooks run after that, so a `tools` map added by a plugin is ignored. The plugin therefore
expresses everything as `permission` (keeping `tools` for older versions):
- a global `deny` for each write tool, appended after any user catch-all because the last matching
  rule wins
- per-agent `allow` rules for the agents that may write

This also fixed the mapping agent from [auto-repair-attribute-mapping.md](auto-repair-attribute-mapping.md).
On main, `opencode debug agent build` showed `odb_mapping_submit` enabled for every agent, and the mapper
could use every tool. Each write tool also checks the calling agent itself, so a misconfigured setup
gets a refusal, not a write.

## Tools

| Tool | Who | What |
|---|---|---|
| `odb_understanding` | everyone | Read-only merged view. User corrections win over saved results, which win over the heuristics. It lists the corrections file and its problems, the schematic files, the board result, and one line per block marked `user-corrected`, `[not explored]` or `[stale: reasons]`. `block` shows one block in full, `mentions` searches saved results for refdes, nets or terms, and `action: "reset"` drops the saved results (never the corrections file). |
| `odb_explore_submit_block` | explorers, fixer | Validated write of one block result |
| `odb_explore_submit_board` | `odb-explore`, fixer | Validated write of the board result |
| `odb_understanding_correct` | fixer | Records a correction in the corrections file and lists the saved results that mention the corrected block or parts |

`odb_overview` and `odb_block` show block titles from the corrections file or the saved results, and
use the user's part moves for grouping.

### Validation (`src/explore/validate.ts`)

Errors reject the whole submit and go back to the agent as text:
- the block name must exist (case-insensitive)
- key parts must exist, belong to the block, and not have been removed from it by the user
- rails must name exactly one net
- data-flow edges must name two different blocks that share a net or an interface bus

Notes are accepted and mentioned:
- an interface peer that is not a block (kept as text, for off-board peers)
- a title or function the user has set, which is shown instead of the agent's

Names are normalised to the board's spelling before saving.

## Saved results (`src/explore/service.ts`)

`<cache>/understanding/<archive sha256>.json`, or in the project with `understandingDir` /
`ODB_UNDERSTANDING_DIR` so a team can commit it. It holds one entry per block plus one board entry. Each
entry records:
- the submitting agent and the date
- the prompt and grouping versions
- the schematic hash
- a hash of the block's members (for the board, of the block names)

An entry is stale when its block's members changed (also through a user part move), the block no
longer exists, the schematic files changed, or a prompt or grouping version was bumped. Stale entries
are still shown, marked. Writes are synchronous read-modify-write with an atomic rename, so parallel
block explorers in one OpenCode process cannot lose each other's entries.

## User corrections (`src/explore/corrections.ts`)

`<design>.understanding.md` next to the archive. The user edits it freely. The plugin writes to it only
through `odb_understanding_correct`, and only touches the lines it owns.

```markdown
# Board
title: Camera carrier
Factory-only debug port on J3.

## Block USB3
title: USB-C 3.2 host port
function: SuperSpeed port with orientation mux; no PD.
parts: +R12 -U19
U19-U21 are ESD only.
```

- `# Board` and `## Block <name>` (or `## <name>`) start sections. Text before any heading or under
  other headings counts as board notes.
- `title:`, `function:` (or `purpose:`) and `parts: +REFDES -REFDES` are structured overrides: they
  replace the agents' title and function, and move parts in or out of the block for every tool.
  A `parts:` line under a new block name creates that block. Everything else is a note.
- Malformed `parts:` tokens are reported by `odb_understanding`, not fatal.
- Edits: title and function lines are replaced in place. Part moves merge into a single `parts:` line,
  where a later `+R12` cancels an earlier `-R12`. Notes are appended as `- text`. A missing block
  section is appended; a missing `# Board` section goes first.

## Schematic files (`src/explore/schematic.ts`)

Any file type works: PDF, images, a pre-converted Markdown or text file, a netlist or native export.
- **Found:** every `<design>.schematic.*` and `<design>.sch.*` next to the archive, the files in a
  `<design>.schematic/` folder, and paths from the `schematic` option / `ODB_SCHEMATIC`
  (comma-separated, files or folders).
- **Listed:** text formats come first; agents are told to prefer them.
- **Hashed:** for staleness.
- **Never read by the plugin:** the agents read them with what the setup offers (the read tool, an MCP
  document server, a shell tool) and carry on without them if nothing can.

## Limits

- No run with a real model yet. Prompts, parallel launches and the fixer's rewrite quality are untested.
- The quality of schematic reading depends on the user's tools and model.
- Parallel block explorers need the model to issue several task calls in one step; otherwise they run
  one after another.
- Free-text corrections are context, not checked constraints. Only titles, functions and part moves
  are enforced by validation.
