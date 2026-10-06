import type { Plugin } from "@opencode-ai/plugin"
import { isAbsolute, join } from "node:path"
import { DesignStore } from "./store.ts"
import { createTools } from "./tools.ts"

/**
 * OpenCode plugin exposing PCB design inspection (ODB++, parsed in-process by
 * OdbDesign through native/libodbpp) as tool calls.
 *
 * Configuration (plugin options take precedence over environment):
 *   designsDir / ODB_DESIGNS_DIR   where the *.tgz / *.zip archives live,
 *                                  default "designs" in the project
 *   design     / ODB_DESIGN        default design for all tools
 *   ODBPP_LIB                      path to libodbpp, default native/lib/ in this package
 */
export const OdbPlusPlusPlugin: Plugin = async (input, options = {}) => {
  const opt = (key: string, env: string) => (options[key] as string | undefined) ?? process.env[env]

  const dir = opt("designsDir", "ODB_DESIGNS_DIR") ?? "designs"
  const designsDir = isAbsolute(dir) ? dir : join(input.directory, dir)
  const store = new DesignStore(designsDir, opt("design", "ODB_DESIGN"))

  return { tool: createTools(store) }
}
