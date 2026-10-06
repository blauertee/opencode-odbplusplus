// Finds ODB++ archives on disk, parses them with OdbDesign (in-process) and
// caches one BoardIndex per archive version.

import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { BoardIndex } from "./board.ts"
import { loadBoard, type NativeBoard } from "./native.ts"

const ARCHIVE = /\.(tgz|tar\.gz|zip)$/i
const CACHE_DIR = process.env.ODB_CACHE_DIR ?? join(homedir(), ".cache", "opencode-odbplusplus")

export type BoardLoader = (archivePath: string) => NativeBoard

export class DesignStore {
  private readonly cache = new Map<string, BoardIndex>()

  constructor(
    /** Directory searched for archives; relative design names resolve here. */
    private readonly designsDir: string,
    private readonly defaultDesign?: string,
    private readonly loader: BoardLoader = loadBoard,
  ) {}

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
    const path = this.resolvePath(design)
    const { mtimeMs, size } = statSync(path)
    const key = `${path}:${mtimeMs}:${size}`
    let board = this.cache.get(key)
    if (!board) {
      board = BoardIndex.build(this.loader(this.scratchCopy(path, key)), basename(path).replace(ARCHIVE, ""))
      this.cache.set(key, board)
    }
    return board
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
