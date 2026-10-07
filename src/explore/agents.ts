// The explore subagents and how the plugin registers them in OpenCode's
// config (docs/features/board-exploration.md).
//
// OpenCode reads agent permissions from `permission`; the `tools` map is only
// translated into permissions when OpenCode parses its config files, which
// happens before plugin config hooks run. So everything here is expressed as
// permissions, with `tools` kept for older OpenCode versions.

import { BLOCK_EXPLORE_PROMPT, EXPLORE_PROMPT, FIX_PROMPT, FIX_RULE } from "./prompts.ts"

export const EXPLORE_AGENT = "odb-explore"
export const BLOCK_AGENT = "odb-block-explore"
export const FIX_AGENT = "odb-understanding-fix"
export const EXPLORE_AGENTS = [EXPLORE_AGENT, BLOCK_AGENT, FIX_AGENT] as const

/** Tools that write saved understanding, and the agents allowed to call them. */
export const WRITE_TOOLS: Record<string, readonly string[]> = {
  odb_explore_submit_block: [EXPLORE_AGENT, BLOCK_AGENT, FIX_AGENT],
  odb_explore_submit_board: [EXPLORE_AGENT, FIX_AGENT],
  odb_understanding_correct: [FIX_AGENT],
}

/** OpenCode's default `subagent_depth` (1) stops subagents from launching subagents. */
export const NESTED_DEPTH = 2

export interface ExploreAgentOptions {
  exploreModel?: string
  blockModel?: string
  fixModel?: string
  /** Cap on block subagents per odb-explore run. */
  maxSubagents: number
}

type Action = "allow" | "ask" | "deny"

function agent(opts: {
  description: string
  prompt: string
  model?: string
  steps: number
  allow: string[]
  extra?: Record<string, Action | Record<string, Action>>
}) {
  const permission: Record<string, Action | Record<string, Action>> = {
    edit: "deny",
    // Shell PDF tools (pdftotext, mutool, ...) work after one approval; users can allow them in opencode.json.
    bash: "ask",
    ...Object.fromEntries(Object.keys(WRITE_TOOLS).map((t) => [t, opts.allow.includes(t) ? "allow" : "deny"])),
    ...opts.extra,
  }
  return {
    mode: "subagent" as const,
    description: opts.description,
    prompt: opts.prompt,
    ...(opts.model ? { model: opts.model } : {}),
    steps: opts.steps,
    maxSteps: opts.steps,
    tools: Object.fromEntries(Object.keys(WRITE_TOOLS).map((t) => [t, opts.allow.includes(t)])),
    permission,
  }
}

export function exploreAgentConfigs(opts: ExploreAgentOptions) {
  return {
    [EXPLORE_AGENT]: agent({
      description:
        "Builds a high-level understanding of a PCB design (ODB++): what the board is for, its functional blocks, " +
        "how they connect, power. Launches odb-block-explore per block, saves the result for later sessions. Use it " +
        "when the user asks what a board is or does, or for a board overview beyond odb_overview.",
      prompt: EXPLORE_PROMPT.replace("{{MAX_SUBAGENTS}}", String(opts.maxSubagents)),
      model: opts.exploreModel,
      steps: 40,
      allow: ["odb_explore_submit_board", "odb_explore_submit_block"],
      extra: { task: { "*": "deny", [BLOCK_AGENT]: "allow" } },
    }),
    [BLOCK_AGENT]: agent({
      description:
        "Works out what one functional block of a PCB design (ODB++) does, e.g. 'odb-block-explore USB3', and saves " +
        "the result. Launched by odb-explore for each block, or directly to (re)explore a single block.",
      prompt: BLOCK_EXPLORE_PROMPT,
      model: opts.blockModel ?? opts.exploreModel,
      steps: 25,
      allow: ["odb_explore_submit_block"],
    }),
    [FIX_AGENT]: agent({
      description:
        "Applies a user's correction to the saved understanding of a PCB design and rewrites every saved result " +
        "that relied on the wrong claim. MUST be launched whenever the user disagrees with or corrects anything " +
        "that came from odb_understanding, odb-explore or odb-block-explore. Pass the design, the user's words " +
        "verbatim, the claim being corrected and the affected block(s).",
      prompt: FIX_PROMPT,
      model: opts.fixModel ?? opts.exploreModel,
      steps: 30,
      allow: ["odb_understanding_correct", "odb_explore_submit_block", "odb_explore_submit_board"],
    }),
  }
}

/**
 * Register the agents, keep the write tools away from every other agent and
 * allow one level of nested subagents unless the user set a depth.
 * User settings under agent.<name> win over ours.
 */
export function applyExploreConfig(config: Record<string, any>, opts: ExploreAgentOptions) {
  const ours = exploreAgentConfigs(opts)
  config.agent = { ...config.agent }
  for (const [name, cfg] of Object.entries(ours)) {
    const user = config.agent[name] ?? {}
    config.agent[name] = {
      ...cfg,
      ...user,
      permission: { ...cfg.permission, ...user.permission },
      tools: { ...cfg.tools, ...user.tools },
    }
  }

  const deny = Object.fromEntries(Object.keys(WRITE_TOOLS).map((t) => [t, "deny" as const]))
  const perm = config.permission
  // Last matching rule wins in OpenCode, so the denies go after a user's "*".
  config.permission = typeof perm === "string" ? { "*": perm, ...deny } : { ...perm, ...deny }
  config.tools = { ...config.tools, ...Object.fromEntries(Object.keys(WRITE_TOOLS).map((t) => [t, false])) }

  if (config.subagent_depth === undefined) config.subagent_depth = NESTED_DEPTH
}

export { FIX_RULE }
