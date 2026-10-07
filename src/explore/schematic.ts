// Schematic files that accompany a design. The plugin never reads their
// content: it finds them, hashes them (so cached understanding goes stale when
// they change) and tells the agents where they are. The agents read them with
// whatever this OpenCode setup offers (docs/features/board-exploration.md).

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, extname, isAbsolute, join, resolve } from "node:path"

export interface SchematicFile {
  path: string
  size: number
  /** Plain text formats the read tool handles directly. */
  text: boolean
}

const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".text", ".csv", ".tsv", ".net", ".kicad_sch", ".sch", ".json", ".xml", ".html", ".htm", ".edif", ".edf"])

/**
 * `<stem>.schematic.*`, `<stem>.sch.*` and the files in a `<stem>.schematic/`
 * folder next to the archive, plus any configured paths (files or folders,
 * relative to the designs directory).
 */
export function findSchematics(designsDir: string, stem: string, configured: string[] = []): SchematicFile[] {
  const found = new Map<string, SchematicFile>()
  const add = (path: string) => {
    if (!existsSync(path)) return
    const st = statSync(path)
    if (st.isDirectory()) {
      for (const f of readdirSync(path).sort()) {
        const p = join(path, f)
        if (!f.startsWith(".") && statSync(p).isFile()) add(p)
      }
      return
    }
    found.set(path, { path, size: st.size, text: isText(path) })
  }

  if (existsSync(designsDir)) {
    for (const f of readdirSync(designsDir).sort()) {
      const lower = f.toLowerCase()
      const prefix = stem.toLowerCase()
      if (lower === `${prefix}.schematic` || lower.startsWith(`${prefix}.schematic.`) || lower.startsWith(`${prefix}.sch.`)) {
        add(join(designsDir, f))
      }
    }
  }
  for (const c of configured) add(isAbsolute(c) ? c : resolve(designsDir, c))
  // Text versions first: cheaper to read and need no PDF toolchain.
  return [...found.values()].sort((a, b) => Number(b.text) - Number(a.text) || a.path.localeCompare(b.path))
}

function isText(path: string): boolean {
  return TEXT_EXT.has(extname(path).toLowerCase())
}

/** SHA-256 over all files' paths and bytes, "" when there are none. */
export function schematicHash(files: SchematicFile[]): string {
  if (!files.length) return ""
  const h = createHash("sha256")
  for (const f of files) {
    h.update(basename(f.path))
    h.update(readFileSync(f.path))
  }
  return h.digest("hex")
}
