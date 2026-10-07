// Deterministic MPN checks for values the mapping agent proposes
// (docs/plans/property-mapping-agent.md, section 5.4). No API, no credentials.
//
// Tier 1 rejects values that cannot be an orderable part number. Tier 2 checks
// numbering grammars of common part families: a value that claims a family
// (by its prefix) but breaks its grammar, or whose encoded case size or pin
// count contradicts the footprint, is rejected; a full match counts as
// verified. Everything else stays "unverified" - real MPNs from vendors
// without a grammar here must not be thrown away.

export type MpnVerdict =
  | { verdict: "reject"; reason: string }
  | { verdict: "verified"; reason: string }
  | { verdict: "unverified" }

export interface MpnContext {
  package?: string
  /** Number of pins of the component, if known. */
  pins?: number
}

const PASSIVE_VALUE = /^\d+(?:[.,]\d+)?\s*(?:[pnuµmkKMGRrΩ]\d*)?\s*(?:[FfHhΩRr]|ohms?)?(?:\s*\/\s*\d+(?:[.,]\d+)?\s*(?:V|%))?(?:\s*\/\s*\d+(?:[.,]\d+)?\s*(?:V|%))?$/
const DISTRIBUTOR = [
  { re: /-ND$/i, name: "Digi-Key" },
  { re: /^C\d{3,}$/, name: "LCSC" },
]

/** "10k", "100nF", "0u1", "10u/25V", "220R": a passive's value, not a part number. */
export function isPassiveValue(v: string): boolean {
  const t = v.trim()
  return /[a-zµΩ]/i.test(t) && PASSIVE_VALUE.test(t)
}

/** Tier 1 and tier 2 for one value. */
export function checkMpn(raw: string, ctx: MpnContext = {}): MpnVerdict {
  const v = raw.trim()
  if (v.length < 4 || v.length > 40) return reject(`"${v}" is ${v.length < 4 ? "too short" : "too long"} for a part number`)
  if (/\s/.test(v)) return reject(`"${v}" contains whitespace`)
  if (/^(?:https?:\/\/|www\.)/i.test(v) || /\.pdf$/i.test(v)) return reject(`"${v}" is a link, not a part number`)
  if (isPassiveValue(v)) return reject(`"${v}" is a component value, not a part number`)
  for (const d of DISTRIBUTOR) if (d.re.test(v)) return reject(`"${v}" is a ${d.name} order number, not a manufacturer part number`)
  if (ctx.package && v.toUpperCase() === ctx.package.toUpperCase()) return reject(`"${v}" is the footprint name`)
  if (!/\d/.test(v)) return reject(`"${v}" has no digits, it reads like a name, not a part number`)
  if (isDescriptive(v)) return reject(`"${v}" reads like a library or description name, not a part number`)

  for (const g of GRAMMARS) {
    const claimed = g.claims.test(v)
    if (!claimed) continue
    const m = v.match(g.full)
    if (!m) {
      if (g.strict) return reject(`"${v}" starts like a ${g.family} part number but does not follow its numbering`)
      continue
    }
    const size = g.size?.(m)
    const fpSize = footprintSize(ctx.package)
    if (size && fpSize && size !== fpSize) {
      return reject(`"${v}" is a ${size} ${g.family} part, but the footprint is ${fpSize}`)
    }
    const pins = g.pins?.(m)
    if (pins && ctx.pins && Math.abs(ctx.pins - pins) > 1) {
      return reject(`"${v}" is a ${pins}-pin ${g.family} part, but the footprint has ${ctx.pins} pins`)
    }
    return { verdict: "verified", reason: `matches ${g.family} numbering${size ? ` (${size})` : ""}` }
  }
  return { verdict: "unverified" }
}

/**
 * Library or symbol names written as part names, e.g. Altium Comments like
 * "Crystal_Oscillator_in_3.2x2.5_SMD", "MMBT3906*SMD", "ST_STM32F101/103_48pin_LQFP".
 * Dashes are not split on: "TUSB1046-DCIRNQT" is a real MPN.
 */
function isDescriptive(v: string): boolean {
  if (v.includes("*")) return true
  const tokens = v.split(/[_,\s]+/).filter(Boolean)
  return tokens.length >= 2 && tokens.some((t) => /^[a-z]{5,}$/i.test(t) || /^\d+(?:pins?|way|pos)$/i.test(t))
}

/** Tier 3: the MPN (or its base without packaging suffix) appears in the datasheet text. */
export function mpnInText(mpn: string, text: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[\s\-_/#.,]/g, "")
  const hay = norm(text)
  const full = norm(mpn)
  if (hay.includes(full)) return true
  // Drop common ordering suffixes: tape & reel, lead-free, temperature/packaging letters.
  const base = full.replace(/(?:TR|T&R|R|PBF|G4|T|E3|E4)+$/, "")
  return base.length >= 5 && hay.includes(base)
}

/** Imperial case size in a footprint name: "R_0402_1005Metric" -> "0402". */
export function footprintSize(pkg: string | undefined): string | undefined {
  return pkg?.match(/(?:^|[^0-9])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2220|2512)(?:[^0-9]|$)/)?.[1]
}

interface Grammar {
  family: string
  /** The value claims this family. */
  claims: RegExp
  full: RegExp
  /** Reject values that claim the family but break the grammar. */
  strict: boolean
  size?: (m: RegExpMatchArray) => string | undefined
  pins?: (m: RegExpMatchArray) => number | undefined
}

const MURATA_SIZE: Record<string, string> = { "02": "01005", "03": "0201", "15": "0402", "18": "0603", "21": "0805", "31": "1206", "32": "1210", "43": "1812", "55": "2220" }
const SAMSUNG_SIZE: Record<string, string> = { "03": "0201", "05": "0402", "10": "0603", "21": "0805", "31": "1206", "32": "1210", "43": "1812", "55": "2220" }
const PANASONIC_ERJ_SIZE: Record<string, string> = { "1": "0201", "2": "0402", "3": "0603", "6": "0805", "8": "1206", "14": "1210", "12": "1812" }
// STM32 pin count letter (RM0090 / ST naming convention)
const STM32_PINS: Record<string, number> = {
  F: 20, G: 28, K: 32, T: 36, S: 44, C: 48, U: 63, R: 64, J: 72, M: 80, O: 90, V: 100, Q: 132, Z: 144, A: 169, I: 176, B: 208, N: 216, X: 256,
}

const GRAMMARS: Grammar[] = [
  {
    family: "Murata MLCC",
    claims: /^G(?:RM|CM|RT|JM|QM)\d/i,
    full: /^G(?:RM|CM|RT|JM|QM)(\d{2})[0-9A-Z]{8,}$/i,
    strict: true,
    size: (m) => MURATA_SIZE[m[1]],
  },
  {
    family: "Samsung MLCC",
    claims: /^CL\d{2}[A-Z]\d/i,
    full: /^CL(\d{2})[A-Z]\d{3}[A-Z]{1,2}[0-9A-Z]{2,}$/i,
    strict: true,
    size: (m) => SAMSUNG_SIZE[m[1]],
  },
  {
    family: "Yageo chip resistor",
    claims: /^RC\d{4}/i,
    full: /^RC(0201|0402|0603|0805|1206|1210|2010|2512)[A-Z]{2}-?[0-9A-Z]{2,}[0-9A-Z]*$/i,
    strict: true,
    size: (m) => m[1],
  },
  {
    family: "Yageo MLCC",
    claims: /^CC\d{4}/i,
    full: /^CC(0201|0402|0603|0805|1206|1210)[A-Z]{2}[0-9A-Z]{4,}$/i,
    strict: true,
    size: (m) => m[1],
  },
  {
    family: "Panasonic ERJ resistor",
    claims: /^ERJ-?/i,
    full: /^ERJ-?(1|2|3|6|8|14|12|P\d{2}|PA\d|U\d{2}|H\d|S\d{2}|B\d|[A-Z]\d?)[A-Z0-9]{2,}$/i,
    strict: true,
    size: (m) => PANASONIC_ERJ_SIZE[m[1]],
  },
  {
    family: "Vishay CRCW resistor",
    claims: /^CRCW/i,
    full: /^CRCW(0201|0402|0603|0805|1206|1210|2010|2512)[0-9A-Z]{4,}$/i,
    strict: true,
    size: (m) => m[1],
  },
  {
    family: "KEMET MLCC",
    claims: /^C(?:0201|0402|0603|0805|1206|1210)C/i,
    full: /^C(0201|0402|0603|0805|1206|1210)C\d{3}[A-Z]\d[A-Z][0-9A-Z]*$/i,
    strict: true,
    size: (m) => m[1],
  },
  {
    family: "STM32",
    claims: /^STM32/i,
    full: /^STM32(?:[A-Z]{1,2}\d{1,3}[A-Z0-9]?)([FGKTSCURJMOVQZAIBNX])([0-9A-K])([TUHYPJKIMV])([3679])[A-Z0-9]*$/i,
    strict: true,
    pins: (m) => STM32_PINS[m[1].toUpperCase()],
  },
  {
    family: "STM8",
    claims: /^STM8/i,
    full: /^STM8[A-Z]{1,2}\d{3}[A-Z0-9]{2,}$/i,
    strict: true,
  },
  {
    family: "Nexperia/TI logic",
    claims: /^(?:SN)?74(?:LVC|AHC|HC|HCT|AUP|LV|ALVC|AHCT|VHC|LVT|ABT|AC|ACT)\d/i,
    full: /^(?:SN)?74[A-Z]{2,5}\d[0-9A-Z]{1,}[-.,]?[0-9A-Z]*$/i,
    strict: false,
  },
  {
    family: "Nexperia PMEG diode",
    claims: /^PMEG\d/i,
    full: /^PMEG\d{4}[A-Z0-9]{1,6}(?:,\d{3})?$/i,
    strict: true,
  },
  {
    family: "TI analog/power",
    claims: /^(?:TPS|TLV|OPA|INA|LMR|TMP|ADS|DAC|ISO|TCA|TXS|TXB|TUSB|DRV|BQ|LMV|LP)\d/i,
    full: /^(?:TPS|TLV|OPA|INA|LMR|TMP|ADS|DAC|ISO|TCA|TXS|TXB|TUSB|DRV|BQ|LMV|LP)\d{2,6}[0-9A-Z-]{0,16}$/i,
    strict: false,
  },
]

function reject(reason: string): MpnVerdict {
  return { verdict: "reject", reason }
}
