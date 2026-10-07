// Finds ODB++ archives on disk, parses them with OdbDesign (in-process) and
// caches one BoardIndex per archive version, with its property mapping
// applied (src/mapping/service.ts).

import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, isAbsolute, join, resolve } from "node:path"
import { BoardIndex } from "./board.ts"
import { CACHE_DIR } from "./cache.ts"
import { MappingCache } from "./mapping/overlay.ts"
import type { Target } from "./mapping/schema.ts"
import { MappingService, type DesignHandle } from "./mapping/service.ts"
import { loadBoard, type NativeBoard } from "./native.ts"

const ARCHIVE = /\.(tgz|tar\.gz|zip)$/i

export type BoardLoader = (archivePath: string) => NativeBoard

export class DesignStore {
  private readonly cache = new Map<string, DesignHandle>()
  readonly mapping: MappingService

  constructor(
    /** Directory searched for archives; relative design names resolve here. */
    private readonly designsDir: string,
    private readonly defaultDesign?: string,
    private readonly loader: BoardLoader = loadBoard,
    /** Without one, no agent runs and only cached or user mappings apply. */
    mapping?: MappingService,
  ) {
    this.mapping = mapping ?? new MappingService({ cache: new MappingCache(), designsDir, mode: "off", waitMs: 0 })
  }

  /** Archive file names in the designs directory. */
  list(): string[] {
    if (!existsSync(this.designsDir)) return []
    return readdirSync(this.designsDir).filter((f) => ARCHIVE.test(f)).sort()
  }

  /**
   * Resolve which archive a tool call refers to: an explicit path or name
   * (extension optional), the configured default, or the only archive.
   */
  resolvePath(design?: string): string {
    const wanted = design ?? this.defaultDesign
    if (wanted) {
      const direct = isAbsolute(wanted) ? wanted : resolve(this.designsDir, wanted)
      if (existsSync(direct) && statSync(direct).isFile()) return direct
      const stem = basename(wanted).replace(ARCHIVE, "")
      const match = this.list().find((f) => f.replace(ARCHIVE, "") === stem)
      if (match) return join(this.designsDir, match)
      throw new Error(`Design ${wanted} not found in ${this.designsDir}. Available: ${this.list().join(", ") || "none"}`)
    }
    const all = this.list()
    if (all.length === 1) return join(this.designsDir, all[0])
    if (all.length === 0) throw new Error(`No ODB++ archives (*.tgz, *.zip) in ${this.designsDir}`)
    throw new Error(`Several designs available, pass one of: ${all.join(", ")}`)
  }

  get(design?: string): BoardIndex {
    return this.handle(design).board
  }

  /** The loaded design with its mapping state. */
  handle(design?: string): DesignHandle {
    const path = this.resolvePath(design)
    const { mtimeMs, size } = statSync(path)
    const key = `${path}:${mtimeMs}:${size}`
    let h = this.cache.get(key)
    if (!h) {
      const stem = basename(path).replace(ARCHIVE, "")
      const board = BoardIndex.build(this.loader(this.scratchCopy(path, key)), stem)
      const fingerprint = createHash("sha256").update(readFileSync(path)).digest("hex")
      h = this.mapping.prepare(board, stem, fingerprint)
      this.cache.set(key, h)
    }
    return h
  }

  /**
   * Load a design for a tool call: starts a mapping repair in the background
   * when the health check asks for one, and waits for it (bounded) if the tool
   * needs one of `waitFor`. `note` tells the model when a repair is running.
   */
  async open(design?: string, opts: { sessionID?: string; waitFor?: Target[] } = {}): Promise<{ board: BoardIndex; note?: string }> {
    const h = this.handle(design)
    this.mapping.maybeRepair(h, opts.sessionID)
    if (opts.waitFor?.length) await this.mapping.waitFor(h, opts.waitFor)
    const note = h.run ? "note: the property mapping of this design is being repaired; values may be incomplete." : undefined
    return { board: h.board, note }
  }

  /**
   * OdbDesign extracts an archive into the directory it lives in. Work on a
   * copy in the cache so the user's design folder stays untouched.
   */
  private scratchCopy(path: string, key: string): string {
    const dir = join(CACHE_DIR, "boards", createHash("sha256").update(key).digest("hex").slice(0, 16))
    const copy = join(dir, basename(path))
    if (!existsSync(copy)) {
      mkdirSync(dir, { recursive: true })
      copyFileSync(path, copy)
    }
    return copy
  }
}
