import { tool } from "@opencode-ai/plugin"
import { naturalCompare, toRegex } from "./board.ts"
import { datasheetText, extractSection } from "./datasheet.ts"
import { componentDetail, componentSummary, netDetail, pathsDetail, testPointLine, testPointsDetail } from "./format.ts"
import type { DesignStore } from "./store.ts"

const z = tool.schema

const designArg = z
  .string()
  .optional()
  .describe("ODB++ archive: file name in the designs directory (extension optional) or a path. Optional when there is only one.")

export function createTools(store: DesignStore) {
  return {
    odb_designs: tool({
      description: "List the PCB designs (ODB++ archives) in the designs directory.",
      args: {},
      async execute() {
        const designs = store.list()
        return designs.length ? designs.join("\n") : "No ODB++ archives in the designs directory."
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
        const board = store.get(args.design)
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
        const board = store.get(args.design)
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
        const board = store.get(args.design)
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
        const board = store.get(args.design)
        const { components, nets } = board.search(args.query, args.limit ?? 50)
        const out: string[] = [`## Components (${components.length})`]
        for (const c of components) out.push(componentSummary(board, c))
        out.push("", `## Nets (${nets.length})`)
        for (const n of nets) out.push(`${n.name} (${n.pins.length} pins)`)
        return out.join("\n")
      },
    }),

    odb_testpoints: tool({
      description:
        "Test points (test pads) of a PCB design with net, board side and position. With net: the test points on " +
        "that net ('which test pad do I probe for I2C1_SDA'). With refdes: the net on that test point ('what is on " +
        "TP21'). With neither: all test points. Test points are recognised by TP<n> refdes or a TP/TestPoint " +
        "footprint or value on a 1-2 pin part; pass pattern to match refdes differently.",
      args: {
        net: z.string().optional().describe("Net name, e.g. 'I2C1_SDA' or '/M.2/M2_M_SMB_DATA'"),
        refdes: z.string().optional().describe("Test point reference designator, e.g. TP21"),
        design: designArg,
        pattern: z
          .string()
          .optional()
          .describe("Refdes substring or regex that marks test points instead of the default rule, e.g. '^(TP|TEST)'"),
      },
      async execute(args) {
        const board = store.get(args.design)
        const pattern = args.pattern ? toRegex(args.pattern) : undefined

        if (args.refdes) {
          const c = board.findComponent(args.refdes)
          if (!c) return notFound(board.components.keys(), args.refdes, "component")
          if (board.isTestPoint(c, pattern)) return testPointLine(c)
          return `${c.refDes} is not a test point (${componentSummary(board, c)}). Use odb_component for its pins.`
        }

        if (args.net) {
          const nets = board.findNets(args.net)
          if (nets.length === 0) return notFound(board.nets.keys(), args.net, "net")
          if (nets.length > 1) return `Ambiguous net name, candidates:\n${nets.map((n) => n.name).join("\n")}`
          const net = nets[0].name
          const tps = board.testPoints({ net, pattern })
          if (tps.length) return testPointsDetail(`Test points on ${net}`, tps)
          return `No test point on ${net}. Use odb_net to see what else is on it.`
        }

        const tps = board.testPoints({ pattern })
        return tps.length
          ? testPointsDetail("Test points", tps)
          : "No test points found. Try pattern with the refdes prefix this design uses."
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
        const board = store.get(args.design)
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
