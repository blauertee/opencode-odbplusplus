// Effective property mapping of one design: built-in aliases merged with the
// mapping layers (learned conventions, agent overlay, user overrides; see
// docs/features/auto-repair-attribute-mapping.md). Rules only change how the
// parsed properties are read; the parsed data itself is never modified.

import { IGNORED_PROPERTIES, normalizePropertyName, PROPERTY_ALIASES, PROPERTY_FIELDS } from "../aliases.ts"
import type { BoardComponent } from "../board.ts"
import type { Field, MappingOutput, MappingRule } from "./schema.ts"

export interface ResolvedValue {
  value: string
  /** "property <name>", "part name" or "inferred" */
  source: string
  /** Not taken verbatim from a property: an MPN read from the part name, or guessed by the agent. */
  inferred?: boolean
  /** MPN check result for agent-provided MPNs (src/mapping/mpn.ts). */
  verified?: boolean
}

type ClassifyRule = Extract<MappingRule, { kind: "classify" }>

export interface EffectiveMapping {
  /** Global aliases per field, in priority order. */
  aliases: Record<Field, string[]>
  /** Aliases restricted to refdes prefixes; tried before the global ones. */
  scopedAliases: Array<{ field: Field; property: string; prefixes: string[] }>
  /** Normalized property names that never fill a field. */
  ignored: Set<string>
  partNameAs: Array<{ field: "value" | "mpn"; prefixes: string[]; refdes: Set<string> }>
  /** refDes (upper case) -> fixed values */
  values: Map<string, Partial<Record<Field, ResolvedValue>>>
  /** Highest-priority rule first; the first matching rule decides. */
  classify: ClassifyRule[]
  rails: Map<string, boolean>
  /** mpnKey(refDes, value) -> MPN verification of agent-provided MPNs */
  mpnStatus: Map<string, boolean>
}

export function builtinMapping(): EffectiveMapping {
  const aliases = {} as Record<Field, string[]>
  for (const f of PROPERTY_FIELDS) aliases[f] = [...PROPERTY_ALIASES[f]]
  return {
    aliases,
    scopedAliases: [],
    ignored: new Set(),
    partNameAs: [],
    values: new Map(),
    classify: [],
    rails: new Map(),
    mpnStatus: new Map(),
  }
}

export interface MappingLayer {
  output: Pick<MappingOutput, "rules">
  /** mpnKey(refDes, value) -> MPN verified, stored with agent overlays */
  mpnStatus?: Record<string, boolean>
}

/** Apply layers in order, lowest priority first. */
export function mergeMappings(layers: MappingLayer[], base = builtinMapping()): EffectiveMapping {
  const m = base
  for (const layer of layers) {
    for (const rule of layer.output.rules) applyRule(m, rule)
    for (const [key, ok] of Object.entries(layer.mpnStatus ?? {})) m.mpnStatus.set(key.toUpperCase(), ok)
  }
  return m
}

function applyRule(m: EffectiveMapping, rule: MappingRule) {
  switch (rule.kind) {
    case "propertyAlias": {
      const key = normalizePropertyName(rule.property)
      m.ignored.delete(key)
      if (rule.scope?.refdesPrefixes?.length) {
        m.scopedAliases.unshift({ field: rule.field, property: rule.property, prefixes: rule.scope.refdesPrefixes.map(upper) })
        return
      }
      const list = m.aliases[rule.field].filter((a) => normalizePropertyName(a) !== key)
      const at = rule.relativeTo ? list.findIndex((a) => normalizePropertyName(a) === normalizePropertyName(rule.relativeTo!)) : -1
      if (at < 0) list.push(rule.property)
      else list.splice(rule.priority === "before" ? at : at + 1, 0, rule.property)
      m.aliases[rule.field] = list
      return
    }
    case "ignoreProperty":
      m.ignored.add(normalizePropertyName(rule.property))
      return
    case "partNameAs":
      m.partNameAs.unshift({
        field: rule.field,
        prefixes: (rule.scope.refdesPrefixes ?? []).map(upper),
        refdes: new Set((rule.scope.refdes ?? []).map(upper)),
      })
      return
    case "componentValue": {
      const key = upper(rule.refDes)
      const entry = m.values.get(key) ?? {}
      const source =
        rule.source.kind === "property" ? `property ${rule.source.property}` : rule.source.kind === "partName" ? "part name" : "inferred"
      entry[rule.field] = { value: rule.value, source, inferred: rule.source.kind === "inferred" || (rule.field === "mpn" && rule.source.kind === "partName") }
      m.values.set(key, entry)
      return
    }
    case "classify":
      m.classify.unshift(rule)
      return
    case "rail":
      for (const net of rule.nets) m.rails.set(net, rule.value)
      return
  }
}

/** Every candidate value of a field, best first (see EffectiveMapping for the order). */
export function resolveField(m: EffectiveMapping, c: BoardComponent, field: Field): ResolvedValue[] {
  const out: ResolvedValue[] = []
  const push = (v: ResolvedValue) => {
    if (!out.some((o) => o.value === v.value)) out.push(v)
  }
  const ref = upper(c.refDes)
  const fixed = m.values.get(ref)?.[field]
  if (fixed) push(fixed)

  const byName = new Map<string, [string, string]>()
  for (const [k, v] of Object.entries(c.properties)) {
    const key = normalizePropertyName(k)
    if (isPlaceholder(v) || m.ignored.has(key) || byName.has(key)) continue
    byName.set(key, [k, v.trim()])
  }
  const prefix = refdesPrefix(c.refDes).toUpperCase()
  const aliases = [
    ...m.scopedAliases.filter((s) => s.field === field && s.prefixes.includes(prefix)).map((s) => s.property),
    ...m.aliases[field],
  ]
  for (const alias of aliases) {
    const hit = byName.get(normalizePropertyName(alias))
    if (hit) push({ value: hit[1], source: `property ${hit[0]}` })
  }

  if (field === "value" || field === "mpn") {
    const part = c.part?.trim()
    if (part && part !== c.package) {
      for (const rule of m.partNameAs) {
        if (rule.field !== field) continue
        if (rule.refdes.has(ref) || rule.prefixes.includes(prefix)) {
          push({ value: part, source: "part name", inferred: field === "mpn" })
          break
        }
      }
    }
  }
  if (field !== "mpn" || !m.mpnStatus.size) return out
  return out.map((v) => {
    const ok = m.mpnStatus.get(mpnKey(ref, v.value))
    return ok === undefined ? v : { ...v, verified: ok }
  })
}

/** Key of an MPN verification: the same part with another value is not covered by it. */
export function mpnKey(refDes: string, value: string): string {
  return `${refDes}:${value}`.toUpperCase()
}

/** The classify rule deciding a feature for this component, if any. */
export function classifyComponent(m: EffectiveMapping, c: BoardComponent, feature: ClassifyRule["feature"]): boolean | undefined {
  for (const rule of m.classify) {
    if (rule.feature === feature && matches(rule.match, c)) return rule.value
  }
  return undefined
}

/** All given criteria must hold; within a list any entry may match (case-insensitive). */
export function matches(match: ClassifyRule["match"], c: BoardComponent): boolean {
  let any = false
  const eq = (list: string[] | undefined, v: string | undefined) => {
    if (!list?.length) return true
    any = true
    return v !== undefined && list.some((x) => x.toUpperCase() === v.toUpperCase())
  }
  if (!eq(match.refdes, c.refDes) || !eq(match.part, c.part) || !eq(match.package, c.package)) return false
  if (match.refdesPattern) {
    any = true
    const re = safeRegex(match.refdesPattern)
    if (!re || !re.test(c.refDes)) return false
  }
  return any
}

export function safeRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "i")
  } catch {
    return undefined
  }
}

const PLACEHOLDERS = new Set(["", "~", "-", "--", "?", "NA", "N/A", "TBD", "NONE", "UNKNOWN"])

export function isPlaceholder(v: string | undefined): boolean {
  return v === undefined || PLACEHOLDERS.has(v.trim().toUpperCase())
}

/**
 * Class prefix of a reference designator: the leading letters, plus a
 * following "$", "-" or "_" ("U$2" -> "U$", "FMU-SWCLK" -> "FMU-"). A refdes
 * that starts with a digit ("5v") is its own prefix.
 */
export function refdesPrefix(refDes: string): string {
  const m = refDes.match(/^[A-Za-z]+[$_-]?/)
  return m ? m[0] : refDes
}

export function isKnownPrefix(prefix: string, known: Set<string>): boolean {
  return known.has(prefix.toUpperCase())
}

export const BUILTIN_IGNORED = new Set(IGNORED_PROPERTIES.map(normalizePropertyName))

function upper(s: string) {
  return s.toUpperCase()
}
