import type { Plugin } from "@opencode-ai/plugin"
import { isAbsolute, join } from "node:path"
import { datasheetText } from "./datasheet.ts"
import { AGENT_NAME, AGENT_TOOLS, agentConfig, OpencodeAgentRunner } from "./mapping/agent.ts"
import { MappingCache } from "./mapping/overlay.ts"
import { MappingService } from "./mapping/service.ts"
import { applyExploreConfig } from "./explore/agents.ts"
import { UnderstandingService } from "./explore/service.ts"
import { DesignStore } from "./store.ts"
import { createTools } from "./tools.ts"

/**
 * OpenCode plugin exposing PCB design inspection (ODB++, parsed in-process by
 * OdbDesign through native/libodbpp) as tool calls.
 *
 * Configuration (plugin options take precedence over environment):
 *   designsDir   / ODB_DESIGNS_DIR       where the *.tgz / *.zip archives live,
 *                                        default "designs" in the project
 *   design       / ODB_DESIGN            default design for all tools
 *   ODBPP_LIB                            path to libodbpp, default native/lib/ in this package
 *   mappingAgent / ODB_MAPPING_AGENT     "auto" (default): repair under-mapped designs with
 *                                        the odb-mapper agent; "off": never start it on its own
 *   mappingModel / ODB_MAPPING_MODEL     "provider/model" for the agent, default OpenCode's small_model
 *   mappingDir   / ODB_MAPPING_DIR       where agent results per design are stored, default in the cache
 *   mappingWaitMs                        how long test point / datasheet tools wait for a repair (60000)
 *   mappingTimeoutMs                     max agent run time (180000)
 *   mpnLookup    / ODB_MPN_LOOKUP        "datasheet": also verify MPNs against datasheet text
 *                                        (downloads PDFs, no credentials); default "off"
 *   understandingDir / ODB_UNDERSTANDING_DIR  where explore results per design are stored,
 *                                        default in the cache
 *   schematic    / ODB_SCHEMATIC         extra schematic files or folders (comma-separated or a
 *                                        list), besides <design>.schematic.* next to the archive
 *   exploreModel / ODB_EXPLORE_MODEL     "provider/model" for the explore agents, default the session's
 *   blockExploreModel, fixModel          per-agent overrides of exploreModel
 *   exploreMaxSubagents                  block subagents per odb-explore run (12)
 */
export const OdbPlusPlusPlugin: Plugin = async (input, options = {}) => {
  const opt = (key: string, env?: string) => (options[key] as string | undefined) ?? (env ? process.env[env] : undefined)
  const num = (key: string, fallback: number) => Number(options[key] ?? fallback)
  const path = (p: string) => (isAbsolute(p) ? p : join(input.directory, p))

  const designsDir = path(opt("designsDir", "ODB_DESIGNS_DIR") ?? "designs")
  const mappingDir = opt("mappingDir", "ODB_MAPPING_DIR")
  const model = opt("mappingModel", "ODB_MAPPING_MODEL")

  const agent = new OpencodeAgentRunner(input.client, { timeoutMs: num("mappingTimeoutMs", 180_000) })
  const mapping = new MappingService({
    cache: new MappingCache(undefined, mappingDir ? path(mappingDir) : undefined),
    designsDir,
    agent,
    mode: opt("mappingAgent", "ODB_MAPPING_AGENT") === "off" ? "off" : "auto",
    waitMs: num("mappingWaitMs", 60_000),
    datasheetText: opt("mpnLookup", "ODB_MPN_LOOKUP") === "datasheet" ? datasheetText : undefined,
  })
  const store = new DesignStore(designsDir, opt("design", "ODB_DESIGN"), undefined, mapping)

  const understandingDir = opt("understandingDir", "ODB_UNDERSTANDING_DIR")
  const schematic = options.schematic ?? process.env.ODB_SCHEMATIC
  const understanding = new UnderstandingService({
    designsDir,
    cacheDir: understandingDir ? path(understandingDir) : undefined,
    schematics: (Array.isArray(schematic) ? schematic : typeof schematic === "string" ? schematic.split(",") : [])
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map(path),
  })
  const exploreModel = opt("exploreModel", "ODB_EXPLORE_MODEL")

  return {
    tool: createTools(store, agent, understanding),

    // Register the agents and keep their write tools away from every other agent.
    async config(config) {
      const own = agentConfig(model ?? config.small_model)
      config.agent = { ...config.agent, [AGENT_NAME]: { ...own, ...config.agent?.[AGENT_NAME] } }
      config.tools = { ...config.tools, ...Object.fromEntries(AGENT_TOOLS.map((t) => [t, false])) }
      // Current OpenCode reads permissions, not tools, once plugins have run; last matching rule wins.
      const perm = (config as Record<string, any>).permission
      const deny = Object.fromEntries(AGENT_TOOLS.map((t) => [t, "deny" as const]))
      ;(config as Record<string, any>).permission = typeof perm === "string" ? { "*": perm, ...deny } : { ...perm, ...deny }

      applyExploreConfig(config as Record<string, any>, {
        exploreModel,
        blockModel: opt("blockExploreModel"),
        fixModel: opt("fixModel"),
        maxSubagents: num("exploreMaxSubagents", 12),
      })
    },
  }
}
