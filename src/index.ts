import type { Plugin } from "@opencode-ai/plugin"
import { OdbDesignClient } from "./client.ts"
import { DesignStore } from "./store.ts"
import { createTools } from "./tools.ts"

/**
 * OpenCode plugin exposing PCB design inspection (ODB++ via OdbDesignServer)
 * as tool calls.
 *
 * Configuration (plugin options take precedence over environment):
 *   serverUrl / ODB_SERVER_URL         default http://localhost:8888
 *   username  / ODB_SERVER_USERNAME    HTTP basic auth, if the server enforces it
 *   password  / ODB_SERVER_PASSWORD
 *   design    / ODB_DESIGN             default design for all tools
 */
export const OdbPlusPlusPlugin: Plugin = async (_input, options = {}) => {
  const opt = (key: string, env: string) => (options[key] as string | undefined) ?? process.env[env]

  const client = new OdbDesignClient({
    baseUrl: opt("serverUrl", "ODB_SERVER_URL") ?? "http://localhost:8888",
    username: opt("username", "ODB_SERVER_USERNAME"),
    password: opt("password", "ODB_SERVER_PASSWORD"),
  })
  const store = new DesignStore(client, opt("design", "ODB_DESIGN"))

  return { tool: createTools(store) }
}
