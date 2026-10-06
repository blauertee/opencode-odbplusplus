import { tool } from "@opencode-ai/plugin"
import { naturalCompare } from "./board.ts"
import { datasheetText, extractSection } from "./datasheet.ts"
import { componentDetail, componentSummary, netDetail, pathsDetail } from "./format.ts"
import type { DesignStore } from "./store.ts"

const z = tool.schema

const designArg = z
  .string()
  .optional()
  .describe("Design name on the OdbDesignServer. Optional when the server holds exactly one design.")

export function createTools(store: DesignStore) {
  return {
    odb_designs: tool({
      description: "List the PCB designs (ODB++ archives) available on the OdbDesignServer.",
      args: {},
      async execute() {
        const designs = await store.list()
        if (!designs.length) return "No designs on the server."
        return designs.map((d) => `${d.name}${d.loaded ? " (loaded)" : ""}`).join("\n")
      },
    }),

    odb_component: tool({
      description:
        "Show one component of a PCB design: value, MPN, package, datasheet URL and every pin with its net and the " +
        "other component pins on that net. Use this for 'what is U35 connected to'. Power/ground rails are summarised.",
      args: {
        refdes: z.string().describe("Reference designator, e.g. IC35 or U12"),
        design: designArg,
        neighbours: z.number().int().optional().describe("Max neighbour pins listed per net (default 12)"),
      },
      async execute(args) {
        const board = await store.get(args.design)
        const c = board.findComponent(args.refdes)
        if (!c) return notFound(board.components.keys(), args.refdes, "component")
        return componentDetail(board, c, args.neighbours ?? 12)
      },
    }),

    odb_net: tool({
      description:
        "List everything connected to a net (e.g. '+5V', 'GND', 'I2C1_SDA'), grouped by component with value and MPN. " +
        "Hierarchical KiCad names ('/CSI/CSI1_D0_N') also match by their last segment.",
      args: {
        net: z.string().describe("Net name"),
        design: designArg,
      },
      async execute(args) {
        const board = await store.get(args.design)
        const nets = board.findNets(args.net)
        if (nets.length === 0) return notFound(board.nets.keys(), args.net, "net")
        if (nets.length > 1) return `Ambiguous net name, candidates:\n${nets.map((n) => n.name).join("\n")}`
        return netDetail(board, nets[0].name)
      },
    }),

    odb_signal_path: tool({
      description:
        "Find the component chains connecting two components, e.g. everything between U10 and U35 on the signal " +
        "path. Walks shared signal nets, skips power/ground rails, and by default only passes through small " +
        "components (<= 4 pins: resistors, capacitors, ferrites, ESD diodes). Raise max_pins_through to pass " +
        "through buffers or level shifters.",
      args: {
        from: z.string().describe("Start reference designator"),
        to: z.string().describe("End reference designator"),
        design: designArg,
        max_pins_through: z.number().int().optional().describe("Max pin count of intermediate parts (default 4)"),
        max_depth: z.number().int().optional().describe("Max components per chain (default 8)"),
        max_paths: z.number().int().optional().describe("Max chains returned (default 10)"),
        include_rails: z.boolean().optional().describe("Also walk power/ground nets (default false)"),
      },
      async execute(args) {
        const board = await store.get(args.design)
        for (const ref of [args.from, args.to]) {
          if (!board.findComponent(ref)) return notFound(board.components.keys(), ref, "component")
        }
        const paths = board.signalPaths(args.from, args.to, {
          maxPinsThrough: args.max_pins_through,
          maxDepth: args.max_depth,
          maxPaths: args.max_paths,
          includeRails: args.include_rails,
        })
        if (!paths.length) {
          return `No signal chain from ${args.from} to ${args.to} within the limits. Try a larger max_pins_through or max_depth.`
        }
        return pathsDetail(board, paths)
      },
    }),

    odb_search: tool({
      description:
        "Search components (refdes, value, MPN, description, package) and nets by substring or regex, e.g. " +
        "'STM32', '^U', 'USB.*_D[PN]'.",
      args: {
        query: z.string().describe("Substring or regular expression (case-insensitive)"),
        design: designArg,
        limit: z.number().int().optional().describe("Max results per category (default 50)"),
      },
      async execute(args) {
        const board = await store.get(args.design)
        const { components, nets } = board.search(args.query, args.limit ?? 50)
        const out: string[] = [`## Components (${components.length})`]
        for (const c of components) out.push(componentSummary(board, c))
        out.push("", `## Nets (${nets.length})`)
        for (const n of nets) out.push(`${n.name} (${n.pins.length} pins)`)
        return out.join("\n")
      },
    }),

    odb_datasheet: tool({
      description:
        "Fetch the datasheet of a component (from its Datasheet property) and return one chapter, e.g. " +
        "'Description', 'Pin Configuration', 'Absolute Maximum Ratings'. Without section, lists the datasheet's " +
        "first lines. Needs poppler's pdftotext on the PATH.",
      args: {
        refdes: z.string().describe("Reference designator"),
        section: z.string().optional().describe("Chapter heading to extract (default: overview)"),
        design: designArg,
      },
      async execute(args) {
        const board = await store.get(args.design)
        const c = board.findComponent(args.refdes)
        if (!c) return notFound(board.components.keys(), args.refdes, "component")
        const url = board.datasheet(c)
        if (!url) return `${c.refDes} has no datasheet property. ${componentSummary(board, c)}`
        const text = await datasheetText(url)
        if (!args.section) return `datasheet: ${url}\n\n${text.slice(0, 4000)}`
        const chapter = extractSection(text, args.section)
        return chapter
          ? `datasheet: ${url}\n\n${chapter}`
          : `Section "${args.section}" not found in ${url}. Retry with another heading or without section.`
      },
    }),
  }
}

function notFound(names: Iterable<string>, wanted: string, kind: string): string {
  const w = wanted.toUpperCase()
  const prefix = w.replace(/\d+$/, "")
  const close = [...names].filter((n) => n.toUpperCase().startsWith(prefix)).sort(naturalCompare).slice(0, 20)
  return `No ${kind} named ${wanted}.${close.length ? ` Similar: ${close.join(", ")}` : ""}`
}
