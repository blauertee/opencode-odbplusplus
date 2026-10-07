// Mapping overlays: where agent results and user overrides live and how they
// are layered onto a board (docs/plans/property-mapping-agent.md, section 4).
// The ODB++ archive and its extracted copy are never written; an overlay is a
// separate JSON file of rules, applied in memory after parsing.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BoardIndex } from "../board.ts"
import { CACHE_DIR } from "../cache.ts"
import { HEURISTIC_VERSION } from "./health.ts"
import { PROMPT_VERSION } from "./prompt.ts"
import { mergeMappings, type MappingLayer } from "./rules.ts"
import { ruleSchema, SCHEMA_VERSION, type Field, type MappingOutput, type MappingRule } from "./schema.ts"

export interface OverlayEntry {
  schemaVersion: number
  heuristicVersion: number
  promptVersion: number
  fingerprint: string
  design: string
  createdAt: string
  /** Accepted rules, unresolved targets and the agent's summary. */
  output: MappingOutput
  /** mpnKey(refDes, value) -> verified */
  mpnStatus: Record<string, boolean>
  rejected: number
  coverageBefore?: Record<Field, { mapped: number; of: number }>
  coverageAfter?: Record<Field, { mapped: number; of: number }>
}

export class MappingCache {
  readonly root: string
  readonly designsRoot: string

  constructor(
    root = join(CACHE_DIR, "mappings"),
    /** Where per-design overlays go; the `mappingDir` option moves them into the project. */
    designsRoot?: string,
  ) {
    this.root = root
    this.designsRoot = designsRoot ?? join(root, "designs")
  }

  /** The overlay for this archive content, unless written by an incompatible version. */
  read(fingerprint: string): OverlayEntry | undefined {
    const entry = readJson<OverlayEntry>(join(this.designsRoot, `${fingerprint}.json`))
    return entry?.schemaVersion === SCHEMA_VERSION ? entry : undefined
  }

  /** Whether this overlay settles the design for the current health check and prompt. */
  isCurrent(entry: OverlayEntry | undefined): boolean {
    return !!entry && entry.heuristicVersion === HEURISTIC_VERSION && entry.promptVersion === PROMPT_VERSION
  }

  write(entry: OverlayEntry) {
    writeJson(join(this.designsRoot, `${entry.fingerprint}.json`), entry)
  }

  delete(fingerprint: string) {
    rmSync(join(this.designsRoot, `${fingerprint}.json`), { force: true })
  }

  /** Newest overlay of an earlier revision of the same design (same archive name). */
  previous(design: string, fingerprint: string): OverlayEntry | undefined {
    if (!existsSync(this.designsRoot)) return undefined
    return readdirSync(this.designsRoot)
      .filter((f) => f.endsWith(".json") && f !== `${fingerprint}.json`)
      .map((f) => readJson<OverlayEntry>(join(this.designsRoot, f)))
      .filter((e): e is OverlayEntry => e?.design === design && e.schemaVersion === SCHEMA_VERSION)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  }

  /** Property-name conventions learned on other designs (layer 2). */
  conventions(): MappingRule[] {
    return parseRules(readJson<{ rules?: unknown[] }>(join(this.root, "conventions.json"))?.rules).rules
  }

  /**
   * Promote high-confidence, design-independent rules: unscoped property
   * aliases and ignored properties.
   */
  promote(rules: MappingRule[]) {
    const portable = rules.filter(
      (r) => r.confidence === "high" && (r.kind === "ignoreProperty" || (r.kind === "propertyAlias" && !r.scope?.refdesPrefixes?.length)),
    )
    if (!portable.length) return
    const key = (r: MappingRule) => ("property" in r ? r.property.toLowerCase() : "")
    const merged = new Map(this.conventions().map((r) => [key(r), r]))
    for (const r of portable) merged.set(key(r), r)
    writeJson(join(this.root, "conventions.json"), { rules: [...merged.values()] })
  }

  clearConventions() {
    rmSync(join(this.root, "conventions.json"), { force: true })
  }

  /** Agent input, raw output and validation, for debugging. */
  logRun(fingerprint: string, data: unknown) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    writeJson(join(this.root, "runs", fingerprint, `${stamp}.json`), data)
  }
}

export interface UserOverrides {
  path: string
  rules: MappingRule[]
  errors: string[]
}

/** `<designsDir>/<stem>.mapping.json`: hand-written rules, highest priority, never written by the plugin. */
export function readUserOverrides(designsDir: string, stem: string): UserOverrides | undefined {
  const path = join(designsDir, `${stem}.mapping.json`)
  if (!existsSync(path)) return undefined
  let raw: { rules?: unknown[] } | undefined
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    return { path, rules: [], errors: [`not valid JSON: ${(e as Error).message}`] }
  }
  return { path, ...parseRules(raw?.rules) }
}

/** Layers, lowest priority first: conventions, design overlay, user overrides. */
export function applyMapping(board: BoardIndex, layers: { conventions?: MappingRule[]; overlay?: OverlayEntry; user?: MappingRule[] }) {
  const list: MappingLayer[] = []
  if (layers.conventions?.length) list.push({ output: { rules: layers.conventions } })
  if (layers.overlay) list.push({ output: layers.overlay.output, mpnStatus: layers.overlay.mpnStatus })
  if (layers.user?.length) list.push({ output: { rules: layers.user } })
  board.mapping = mergeMappings(list)
}

function parseRules(raw: unknown[] | undefined): { rules: MappingRule[]; errors: string[] } {
  const rules: MappingRule[] = []
  const errors: string[] = []
  ;(raw ?? []).forEach((r, i) => {
    const parsed = ruleSchema.safeParse(r)
    if (parsed.success) rules.push(parsed.data as MappingRule)
    else errors.push(`rules[${i}]: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`)
  })
  return { rules, errors }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

function writeJson(path: string, data: unknown) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n")
}
