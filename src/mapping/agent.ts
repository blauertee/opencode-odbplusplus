// Runs the odb-mapper subagent through OpenCode's own session API
// (docs/plans/property-mapping-agent.md, section 5). The agent reads a
// profile, may drill down with read-only tools and answers by calling
// odb_mapping_submit; that tool validates the proposal and hands it back here.

import type { PluginInput } from "@opencode-ai/plugin"
import type { BoardIndex } from "../board.ts"
import { MAPPER_SYSTEM_PROMPT } from "./prompt.ts"
import type { MappingInput, MappingOutput } from "./schema.ts"
import { formatValidation, type ValidationResult } from "./validate.ts"

export const AGENT_NAME = "odb-mapper"
/** Tools only the mapping agent may call; hidden from every other agent. */
export const AGENT_TOOLS = ["odb_mapping_profile", "odb_mapping_values", "odb_mapping_submit"] as const
export const MAX_SUBMITS = 3

export interface AgentRequest {
  board: BoardIndex
  input: MappingInput
  /** Session whose tool call triggered the run; the run shows up as its child. */
  parentID?: string
  validate: (output: MappingOutput) => Promise<ValidationResult>
}

export interface AgentResult {
  output?: MappingOutput
  validation?: ValidationResult
  submits: number
  sessionID?: string
  error?: string
}

/** Anything that can turn a profile into a validated proposal (the OpenCode agent, or a fake in tests). */
export interface AgentRunner {
  run(req: AgentRequest): Promise<AgentResult>
}

interface RunState {
  req: AgentRequest
  submits: number
  last?: { output: MappingOutput; validation: ValidationResult }
  finish: () => void
}

/** Agent config added through the plugin's config hook. */
export function agentConfig(model?: string) {
  const tools: Record<string, boolean> = { "*": false, odb_component: true, odb_net: true }
  for (const t of AGENT_TOOLS) tools[t] = true
  return {
    mode: "subagent" as const,
    hidden: true,
    description: "Maps ODB++ component properties and features to the fields the odb tools use. Started by the plugin, not for direct use.",
    prompt: MAPPER_SYSTEM_PROMPT,
    ...(model ? { model } : {}),
    temperature: 0,
    maxSteps: 12,
    tools,
    permission: { edit: "deny" as const, bash: "deny" as const, webfetch: "deny" as const },
  }
}

export class OpencodeAgentRunner implements AgentRunner {
  private readonly runs = new Map<string, RunState>()

  constructor(
    private readonly client: PluginInput["client"],
    private readonly opts: { timeoutMs: number },
  ) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    const created = await this.client.session.create({
      body: { parentID: req.parentID, title: `ODB++ mapping: ${req.input.design.name}` },
    })
    const sessionID = created.data?.id
    if (!sessionID) return { submits: 0, error: `could not create a session: ${JSON.stringify(created.error ?? "no id")}` }

    let finish!: () => void
    const finished = new Promise<void>((resolve) => (finish = resolve))
    const state: RunState = { req, submits: 0, finish }
    this.runs.set(sessionID, state)

    const prompt = this.client.session
      .prompt({
        path: { id: sessionID },
        body: {
          // The model comes from the agent config (mappingModel or small_model, see src/index.ts).
          agent: AGENT_NAME,
          parts: [
            {
              type: "text",
              text:
                `Design profile below. Pass design "${req.input.design.name}" to odb_component and odb_net.\n\n` +
                JSON.stringify(req.input),
            },
          ],
        },
      })
      .then((r) => (r.error ? `prompt failed: ${JSON.stringify(r.error)}` : undefined))
      .catch((e: Error) => `prompt failed: ${e.message}`)

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<string>((resolve) => (timer = setTimeout(() => resolve("timeout"), this.opts.timeoutMs)))
    const outcome = await Promise.race([finished.then(() => undefined), prompt, timeout])
    clearTimeout(timer)
    if (outcome === "timeout" || state.last) {
      // Stop the agent once we have what we need, or when it ran too long.
      await this.client.session.abort({ path: { id: sessionID } }).catch(() => undefined)
    }
    this.runs.delete(sessionID)

    const error = state.last ? undefined : outcome === "timeout" ? "timed out before submitting" : (outcome ?? "ended without submitting")
    return { output: state.last?.output, validation: state.last?.validation, submits: state.submits, sessionID, error }
  }

  /** The run a tool call belongs to, if it comes from a mapping agent session. */
  state(sessionID: string): { board: BoardIndex; input: MappingInput } | undefined {
    const s = this.runs.get(sessionID)
    return s && { board: s.req.board, input: s.req.input }
  }

  /** odb_mapping_submit: validate, keep the latest proposal, report back to the agent. */
  async submit(sessionID: string, output: MappingOutput): Promise<string> {
    const s = this.runs.get(sessionID)
    if (!s) return "odb_mapping_submit is only available to the mapping agent the plugin started."
    s.submits++
    const validation = await s.req.validate(output)
    s.last = { output, validation }
    const done = validation.rejected.length === 0 || s.submits >= MAX_SUBMITS
    const text = formatValidation(validation, s.submits, MAX_SUBMITS)
    if (done) s.finish()
    return text
  }
}
