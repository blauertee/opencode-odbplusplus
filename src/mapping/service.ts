// Ties the mapping pieces together for one loaded design: apply cached
// layers, run the health check, start the agent when it says so, store the
// validated result (docs/plans/property-mapping-agent.md, section 3.3).

import type { BoardIndex } from "../board.ts"
import type { AgentRunner } from "./agent.ts"
import { mappingHealth, type HealthReport } from "./health.ts"
import { applyMapping, readUserOverrides, type MappingCache, type OverlayEntry, type UserOverrides } from "./overlay.ts"
import { buildProfile } from "./profile.ts"
import { PROMPT_VERSION } from "./prompt.ts"
import { HEURISTIC_VERSION } from "./health.ts"
import { SCHEMA_VERSION, type Field, type Target } from "./schema.ts"
import { validateOutput } from "./validate.ts"

export interface DesignHandle {
  board: BoardIndex
  /** Archive file name without extension */
  stem: string
  /** SHA-256 of the archive bytes */
  fingerprint: string
  health: HealthReport
  overlay?: OverlayEntry
  user?: UserOverrides
  /** Agent run in flight */
  run?: Promise<void>
  /** Outcome of the last run in this process, for odb_mapping */
  lastRun?: string
}

export interface MappingServiceOptions {
  cache: MappingCache
  designsDir: string
  agent?: AgentRunner
  /** "auto" runs the agent when the health check fires, "off" never does (odb_mapping repair still works). */
  mode: "auto" | "off"
  /** How long tools that need a gapped field wait for a running repair. */
  waitMs: number
  /** Datasheet text for the tier 3 MPN check; omit to stay offline. */
  datasheetText?: (url: string) => Promise<string>
}

export class MappingService {
  constructor(readonly opts: MappingServiceOptions) {}

  /** Apply conventions, the cached overlay and user overrides, then check health. */
  prepare(board: BoardIndex, stem: string, fingerprint: string): DesignHandle {
    const h: DesignHandle = { board, stem, fingerprint, health: undefined as unknown as HealthReport }
    h.overlay = this.opts.cache.read(fingerprint)
    h.user = readUserOverrides(this.opts.designsDir, stem)
    this.apply(h)
    return h
  }

  /** Start a background repair if the health check asks for one and nothing settles it yet. */
  maybeRepair(h: DesignHandle, parentID?: string): void {
    if (h.run || this.opts.mode === "off" || !this.opts.agent) return
    if (!h.health.launch || this.opts.cache.isCurrent(h.overlay) || h.lastRun) return
    this.repair(h, parentID)
  }

  /** Run the agent now (also used by odb_mapping action "repair"). */
  repair(h: DesignHandle, parentID?: string): Promise<void> {
    if (h.run) return h.run
    if (!this.opts.agent) return Promise.resolve()
    h.run = this.doRepair(h, parentID).finally(() => (h.run = undefined))
    return h.run
  }

  /** Wait for a running repair if the caller needs one of the gapped targets. */
  async waitFor(h: DesignHandle, targets: Target[]): Promise<void> {
    if (!h.run || !h.health.gaps.some((g) => targets.includes(g.target))) return
    await Promise.race([h.run, new Promise((r) => setTimeout(r, this.opts.waitMs))])
  }

  reset(h: DesignHandle, conventions: boolean) {
    this.opts.cache.delete(h.fingerprint)
    if (conventions) this.opts.cache.clearConventions()
    h.overlay = undefined
    h.lastRun = undefined
    this.apply(h)
  }

  private apply(h: DesignHandle) {
    applyMapping(h.board, { conventions: this.opts.cache.conventions(), overlay: h.overlay, user: h.user?.rules })
    h.health = mappingHealth(h.board)
  }

  private async doRepair(h: DesignHandle, parentID?: string) {
    const { cache, agent } = this.opts
    // The agent starts from conventions + user overrides, not from an overlay it is replacing.
    applyMapping(h.board, { conventions: cache.conventions(), user: h.user?.rules })
    const health = mappingHealth(h.board)
    const userOutput = h.user?.rules.length ? { rules: h.user.rules, unresolved: [], summary: "" } : undefined
    const input = buildProfile(h.board, health, {
      fingerprint: h.fingerprint,
      previous: cache.previous(h.stem, h.fingerprint)?.output,
      user: userOutput,
    })

    let result
    try {
      result = await agent!.run({
        board: h.board,
        input,
        parentID,
        validate: (output) => validateOutput(h.board, output, { userOverrides: h.user, datasheetText: this.opts.datasheetText }),
      })
    } catch (e) {
      result = { submits: 0, error: (e as Error).message }
    }
    cache.logRun(h.fingerprint, { input, result })

    if (!result.output || !result.validation) {
      h.lastRun = `Mapping agent failed: ${result.error ?? "no result"}.`
      this.apply(h)
      return
    }
    const v = result.validation
    const entry: OverlayEntry = {
      schemaVersion: SCHEMA_VERSION,
      heuristicVersion: HEURISTIC_VERSION,
      promptVersion: PROMPT_VERSION,
      fingerprint: h.fingerprint,
      design: h.stem,
      createdAt: new Date().toISOString(),
      output: { rules: v.accepted, unresolved: result.output.unresolved, summary: result.output.summary },
      mpnStatus: v.mpnStatus,
      rejected: v.rejected.length,
      coverageBefore: slim(health.coverage),
    }
    h.overlay = entry
    this.apply(h)
    entry.coverageAfter = slim(h.health.coverage)
    cache.write(entry)
    cache.promote(v.accepted)
    h.lastRun = `Mapping agent: ${v.accepted.length} rules accepted, ${v.rejected.length} rejected. ${result.output.summary}`
  }
}

function slim(c: Record<Field, { mapped: number; of: number }>) {
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { mapped: v.mapped, of: v.of }])) as Record<Field, { mapped: number; of: number }>
}
