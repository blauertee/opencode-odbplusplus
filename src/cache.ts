import { homedir } from "node:os"
import { join } from "node:path"

/** Root of everything the plugin writes: archive copies, datasheets, mapping overlays. */
export const CACHE_DIR = process.env.ODB_CACHE_DIR ?? join(homedir(), ".cache", "opencode-odbplusplus")
