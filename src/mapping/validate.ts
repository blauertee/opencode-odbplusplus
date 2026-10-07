// Checks the agent's proposal against the parsed data before anything is
// applied (docs/features/auto-repair-attribute-mapping.md).

import { normalizePropertyName } from "../aliases.ts"
import type { BoardComponent, BoardIndex } from "../board.ts"
import { eligibleComponents } from "./health.ts"
import { checkMpn, mpnInText } from "./mpn.ts"
import { isPlaceholder, matches, mpnKey, refdesPrefix, safeRegex } from "./rules.ts"
import type { MappingOutput, MappingRule } from "./schema.ts"

export interface Rejection {
  index: number
  rule: MappingRule
  reason: string
}

export interface ValidationResult {
  accepted: MappingRule[]
  rejected: Rejection[]
  /** Accepted rules that produce some MPN values the checks refused; those values are skipped. */
  warnings: string[]
  /** mpnKey(refDes, value) -> agent-provided MPN verified (true) or unverified (false) */
  mpnStatus: Record<string, boolean>
}

export interface ValidateOptions {
  userOverrides?: Pick<MappingOutput, "rules">
  /** Datasheet text for a URL (tier 3 MPN check); omitted = no network. */
  datasheetText?: (url: string) => Promise<string>
  /** Max datasheets fetched per validation. */
  maxDatasheets?: number
}

/** Max share of an MPN rule's values that may fail the checks. */
const MAX_BAD_MPN_SHARE = 0.3
/** Max share of eligible parts a test point rule may classify. */
const MAX_TEST_POINT_SHARE = 0.3
const NOT_TEST_POINT_PREFIXES = new Set(["R", "C", "L", "D", "LED", "J", "U", "IC", "Q", "Y", "X", "FB", "RN", "SW"])

export async function validateOutput(board: BoardIndex, output: Pick<MappingOutput, "rules">, opts: ValidateOptions = {}): Promise<ValidationResult> {
  const result: ValidationResult = { accepted: [], rejected: [], warnings: [], mpnStatus: {} }
  const eligible = eligibleComponents(board)
  const propertyKeys = new Set<string>()
  for (const c of board.components.values()) for (const k of Object.keys(c.properties)) propertyKeys.add(normalizePropertyName(k))
  const user = userKeys(opts.userOverrides)
  const mpnUnverified: BoardComponent[] = []
  /** refDes -> proposed MPN still waiting for the datasheet check */
  const pendingMpn = new Map<string, string>()
  /** rule -> refdes whose MPN values were refused */
  const skipped = new Map<MappingRule, Set<string>>()

  output.rules.forEach((rule, index) => {
    const reason = check(rule)
    if (reason) result.rejected.push({ index, rule, reason })
    else result.accepted.push(narrow(rule))
  })

  if (opts.datasheetText && mpnUnverified.length) {
    const cache = new Map<string, Promise<string | undefined>>()
    for (const c of mpnUnverified.slice(0, opts.maxDatasheets ?? 20)) {
      const url = board.datasheet(c)
      if (!url || !/^https?:\/\//i.test(url)) continue
      if (!cache.has(url)) cache.set(url, opts.datasheetText(url).catch(() => undefined))
      const text = await cache.get(url)
      const mpn = pendingMpn.get(c.refDes)
      if (text && mpn && mpnInText(mpn, text)) result.mpnStatus[mpnKey(c.refDes, mpn)] = true
    }
  }
  return result

  // ------------------------------------------------------------------

  function check(rule: MappingRule): string | undefined {
    const conflict = user.get(conflictKey(rule))
    if (conflict) return `conflicts with the user's override (${conflict})`
    switch (rule.kind) {
      case "propertyAlias": {
        if (!propertyKeys.has(normalizePropertyName(rule.property))) return `no component has a property named "${rule.property}"`
        const parts = inScope(rule.scope?.refdesPrefixes)
        const values = propertyValues(parts, rule.property)
        if (!values.length) return `"${rule.property}" has no values on the parts in scope`
        if (rule.field === "datasheet") {
          const urls = values.filter(([, v]) => /^(?:https?:\/\/|www\.)/i.test(v) || /\.pdf$/i.test(v)).length
          if (urls / values.length < 0.5) return `fewer than half the values of "${rule.property}" are links`
        }
        if (rule.field === "mpn") return checkMpnValues(rule, values)
        return undefined
      }
      case "ignoreProperty":
        if (!propertyKeys.has(normalizePropertyName(rule.property))) return `no component has a property named "${rule.property}"`
        return undefined
      case "partNameAs": {
        const parts = partNameScope(rule.scope)
        if (!parts.length) return "the scope matches no component with a part name"
        if (rule.field === "mpn") return checkMpnValues(rule, parts.map((c) => [c, c.part!.trim()]))
        return undefined
      }
      case "componentValue": {
        const c = board.findComponent(rule.refDes)
        if (!c) return `no component ${rule.refDes}`
        const v = rule.value.trim()
        if (!v || isPlaceholder(v)) return "empty or placeholder value"
        if (rule.source.kind === "property") {
          const src = Object.entries(c.properties).find(([k]) => normalizePropertyName(k) === normalizePropertyName((rule.source as { property: string }).property))
          if (!src) return `${c.refDes} has no property "${rule.source.property}"`
          if (!src[1].includes(v)) return `"${v}" does not appear in ${c.refDes}'s ${src[0]} ("${src[1]}")`
        } else if (rule.source.kind === "partName") {
          if (!c.part?.includes(v)) return `"${v}" does not appear in ${c.refDes}'s part name ("${c.part ?? ""}")`
        } else {
          if (rule.field !== "value" && rule.field !== "mpn") return `inferred values are only allowed for value and mpn`
          if (rule.confidence === "high") return `inferred values must have confidence medium or low`
        }
        if (rule.field === "datasheet" && !/^https?:\/\//i.test(v)) return `datasheet must be an http(s) link`
        if (rule.field === "mpn") return checkMpnValues(rule, [[c, v]])
        return undefined
      }
      case "classify": {
        const { refdes, refdesPattern, part, package: pkg } = rule.match
        if (!refdes?.length && !refdesPattern && !part?.length && !pkg?.length) return "empty match"
        const missing = (refdes ?? []).filter((r) => !board.findComponent(r))
        if (missing.length) return `unknown refdes: ${missing.join(", ")}`
        if (refdesPattern && !safeRegex(refdesPattern)) return `invalid regex ${refdesPattern}`
        const hit = [...board.components.values()].filter((c) => matches(rule.match, c))
        if (!hit.length) return "the match selects no component"
        if (!rule.value) return undefined
        if (rule.feature === "testPoint") {
          if (hit.length > Math.max(3, eligible.length * MAX_TEST_POINT_SHARE)) return `selects ${hit.length} parts, too many to be test points`
          const wrong = hit.filter((c) => c.pins.size > 2 || NOT_TEST_POINT_PREFIXES.has(refdesPrefix(c.refDes).toUpperCase()))
          if (wrong.length) return `selects parts that are not test points: ${wrong.slice(0, 5).map((c) => `${c.refDes} (${c.pins.size} pins)`).join(", ")}`
          const unconnected = hit.filter((c) => ![...c.pins.values()].some((n) => n !== "$NONE$"))
          if (unconnected.length === hit.length) return "none of the selected parts is connected to a net"
        } else {
          const wrong = hit.filter((c) => c.pins.size > 4)
          if (wrong.length) return `selects parts with more than 4 pins: ${wrong.slice(0, 5).map((c) => c.refDes).join(", ")}`
        }
        return undefined
      }
      case "rail": {
        const missing = rule.nets.filter((n) => !board.nets.has(n))
        return missing.length ? `unknown nets: ${missing.join(", ")}` : undefined
      }
    }
  }

  /** Tier 1+2 per value; consistency across the design; records verification. */
  function checkMpnValues(rule: MappingRule, values: Array<[BoardComponent, string]>): string | undefined {
    const bad: string[] = []
    const ok: Array<[BoardComponent, string, boolean]> = []
    const packages = new Map<string, Set<string>>()
    for (const [c, v] of values) if (c.package) packages.set(v, (packages.get(v) ?? new Set()).add(c.package))
    for (const [c, v] of values) {
      const r = checkMpn(v, { package: c.package, pins: c.pins.size })
      if (r.verdict === "reject") bad.push(`${c.refDes}: ${r.reason}`)
      else if ((packages.get(v)?.size ?? 0) > 1) bad.push(`${c.refDes}: "${v}" is used on parts with different footprints (${[...packages.get(v)!].join(", ")})`)
      else ok.push([c, v, r.verdict === "verified"])
    }
    if (bad.length && (values.length === 1 || bad.length / values.length > MAX_BAD_MPN_SHARE)) {
      return `MPN check failed for ${bad.length} of ${values.length} values: ${bad.slice(0, 4).join("; ")}`
    }
    if (bad.length) {
      result.warnings.push(`${rule.kind} ${"field" in rule ? rule.field : ""}: skipped ${bad.length} values (${bad.slice(0, 3).join("; ")})`)
      skipped.set(rule, new Set(bad.map((b) => b.slice(0, b.indexOf(":")))))
    }
    for (const [c, v, verified] of ok) {
      result.mpnStatus[mpnKey(c.refDes, v)] = verified
      if (!verified) {
        mpnUnverified.push(c)
        pendingMpn.set(c.refDes, v)
      }
    }
    return undefined
  }

  /** partNameAs with a few refused MPN values: restrict the rule to the parts that passed. */
  function narrow(rule: MappingRule): MappingRule {
    const skip = skipped.get(rule)
    if (!skip || rule.kind !== "partNameAs") return rule
    const keep = partNameScope(rule.scope).filter((c) => !skip.has(c.refDes)).map((c) => c.refDes)
    return { ...rule, scope: { refdes: keep } }
  }

  function inScope(prefixes?: string[]): BoardComponent[] {
    if (!prefixes?.length) return [...board.components.values()]
    const set = new Set(prefixes.map((p) => p.toUpperCase()))
    return [...board.components.values()].filter((c) => set.has(refdesPrefix(c.refDes).toUpperCase()))
  }

  function partNameScope(scope: { refdesPrefixes?: string[]; refdes?: string[] }): BoardComponent[] {
    const prefixes = new Set((scope.refdesPrefixes ?? []).map((p) => p.toUpperCase()))
    const refs = new Set((scope.refdes ?? []).map((r) => r.toUpperCase()))
    return [...board.components.values()].filter(
      (c) =>
        c.part?.trim() &&
        c.part !== c.package &&
        (refs.has(c.refDes.toUpperCase()) || prefixes.has(refdesPrefix(c.refDes).toUpperCase())),
    )
  }
}

function propertyValues(parts: BoardComponent[], property: string): Array<[BoardComponent, string]> {
  const key = normalizePropertyName(property)
  const out: Array<[BoardComponent, string]> = []
  for (const c of parts) {
    const hit = Object.entries(c.properties).find(([k, v]) => normalizePropertyName(k) === key && !isPlaceholder(v))
    if (hit) out.push([c, hit[1].trim()])
  }
  return out
}

/** Rules that would override the same thing as a user rule. */
function conflictKey(rule: MappingRule): string {
  switch (rule.kind) {
    case "propertyAlias":
    case "ignoreProperty":
      return `property:${normalizePropertyName(rule.property)}`
    case "componentValue":
      return `value:${rule.refDes.toUpperCase()}:${rule.field}`
    case "partNameAs":
      return `partName:${rule.field}:${[...(rule.scope.refdesPrefixes ?? []), ...(rule.scope.refdes ?? [])].join(",").toUpperCase()}`
    case "classify":
      return `classify:${rule.feature}:${JSON.stringify(rule.match)}`
    case "rail":
      return `rail:${rule.nets.join(",")}`
  }
}

function userKeys(overrides?: Pick<MappingOutput, "rules">): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of overrides?.rules ?? []) {
    out.set(conflictKey(r), r.kind)
    if (r.kind === "rail") for (const n of r.nets) out.set(`rail:${n}`, "rail")
  }
  return out
}

/** Plain-text report for the agent (odb_mapping_submit result). */
export function formatValidation(v: ValidationResult, attempt: number, maxAttempts: number): string {
  const lines = [`Accepted ${v.accepted.length} rules, rejected ${v.rejected.length}.`]
  for (const r of v.rejected) lines.push(`- rules[${r.index}] (${r.rule.kind}): ${r.reason}`)
  for (const w of v.warnings) lines.push(`- warning: ${w}`)
  const verified = Object.values(v.mpnStatus).filter(Boolean).length
  const total = Object.keys(v.mpnStatus).length
  if (total) lines.push(`MPNs: ${verified} of ${total} verified, the rest kept as unverified.`)
  if (v.rejected.length && attempt < maxAttempts) {
    lines.push(`Fix or drop the rejected rules and submit the complete output again (submit ${attempt} of ${maxAttempts}).`)
  } else {
    lines.push("Done. Do not call any more tools.")
  }
  return lines.join("\n")
}
