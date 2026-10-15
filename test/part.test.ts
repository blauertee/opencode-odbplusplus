import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { outline, pageRange, searchPages, splitPages } from "../src/datasheet.ts"
import type { NativeBoard } from "../src/native.ts"
import { applyPartConfig, PART_AGENT, PART_TOOLS, PartService } from "../src/part/agent.ts"
import { PartNotesStore, partKey, sameQuestion } from "../src/part/notes.ts"
import { DesignStore } from "../src/store.ts"
import { createTools } from "../src/tools.ts"

const tmp = mkdtempSync(join(tmpdir(), "odb-part-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const TPS = "https://example.com/tps62130.pdf"
const BMI = "https://example.com/bmi088.pdf"
const WRONG = "https://example.com/other.pdf"
const LANDING = "https://example.com/landing"
const PDFS: Record<string, string> = {
  [TPS]: "TPS62130RGTR 3-V to 17-V Step-Down Converter\n1 Features\nInput voltage 3 V to 17 V\n\f2 Absolute Maximum Ratings\nVIN  -0.3 to 20 V\nEN   -0.3 to 7 V\n\f3 Pin Configuration\nPin 1 SW\n\f",
  [BMI]: "BMI088 6-axis IMU\n1 Interfaces\nI2C address 0x18 or 0x19 (SDO1)\n\f",
  [WRONG]: "LM317 adjustable regulator\f",
}
const datasheetText = async (url: string) => {
  if (url === LANDING) throw new Error(`Datasheet URL did not return a PDF (probably a landing page): ${url}`)
  const text = PDFS[url]
  if (!text) throw new Error(`Datasheet download failed (404): ${url}`)
  return text
}

function fixture(): NativeBoard {
  const components: { refDes: string; package: string; props: Record<string, string> }[] = [
    { refDes: "U1", package: "QFN-16", props: { MPN: "TPS62130RGTR", Datasheet: TPS, Value: "TPS62130" } },
    { refDes: "U2", package: "QFN-16", props: { MPN: "TPS62130RGTR", Value: "TPS62130" } },
    { refDes: "U3", package: "LGA-16", props: { MPN: "BMI088", Value: "BMI088" } },
    { refDes: "U4", package: "SOT-23", props: { MPN: "AP2112K-3.3", Datasheet: LANDING } },
  ]
  return {
    name: "fixture",
    components,
    nets: [
      { name: "VIN", pins: [["U1", "1"], ["U2", "1"]] },
      { name: "GND", pins: components.map((c) => [c.refDes, "2"] as [string, string]) },
    ],
  }
}

type Script = (sessionID: string, text: string, call: Call) => Promise<void>
type Call = (tool: string, args: Record<string, unknown>, sessionID: string, agent?: string) => Promise<string>

/** A stand-in for OpenCode: sessions with parents, and a "model" that is a script driving the odb-part tools. */
function setup(name: string, script: Script, opts: { budget?: number; notesDir?: string } = {}) {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "fixture.tgz"), name)
  const store = new DesignStore(dir, "fixture", () => fixture())
  const parents: Record<string, string | undefined> = { ses_root: undefined, ses_block: "ses_root", ses_other: undefined }
  const tokens: Record<string, number> = {}
  const log = { creates: [] as { parentID?: string }[], prompts: [] as { id: string; text: string; model?: unknown }[], aborts: [] as string[], running: 0, maxRunning: 0 }
  let n = 0
  let call!: Call
  const client = {
    session: {
      get: async (r: { path: { id: string } }) => ({ data: { id: r.path.id, parentID: parents[r.path.id] } }),
      create: async (r: { body: { parentID?: string } }) => {
        const id = `ses_part${++n}`
        parents[id] = r.body.parentID
        log.creates.push(r.body)
        return { data: { id } }
      },
      messages: async (r: { path: { id: string } }) =>
        r.path.id in parents ? { data: [{ info: { role: "assistant", tokens: { input: tokens[r.path.id] ?? 1000, cache: { read: 0 } } } }] } : { error: "not found" },
      message: async () => ({ data: { info: { role: "assistant", providerID: "prov", modelID: "mod" } } }),
      prompt: async (r: { path: { id: string }; body: { model?: unknown; parts: { text: string }[] } }) => {
        log.prompts.push({ id: r.path.id, text: r.body.parts[0].text, model: r.body.model })
        log.maxRunning = Math.max(log.maxRunning, ++log.running)
        await Bun.sleep(5)
        await script(r.path.id, r.body.parts[0].text, call)
        log.running--
        return { data: { parts: [{ type: "text", text: "done" }] } }
      },
      abort: async (r: { path: { id: string } }) => (log.aborts.push(r.path.id), { data: true }),
    },
  }
  const notes = new PartNotesStore(opts.notesDir ?? join(dir, "parts"))
  const part = new PartService({ client: client as never, notes, datasheetText, web: true, timeoutMs: 5000, contextBudget: opts.budget ?? 60_000, graceMs: 200 })
  const tools = createTools(store, undefined, undefined, part) as Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }>
  call = async (tool, args, sessionID, agent = PART_AGENT) =>
    String(await tools[tool].execute(args, { sessionID, messageID: "msg", agent, abort: new AbortController().signal, metadata: () => {} }))
  const ask = (refdes: string, question: string, sessionID = "ses_block") => call("odb_part_ask", { refdes, question }, sessionID, "build")
  return { store, part, notes, log, tokens, ask, call }
}

/** The "model": looks the question up in the datasheet and answers with the page it found. */
const reader: Script = async (id, text, call) => {
  const q = text.match(/Question: (.*)/)?.[1] ?? ""
  if (/maximum/i.test(q)) {
    expect(await call("odb_part_datasheet", { action: "search", query: "absolute maximum" }, id)).toContain("--- page 2 ---")
    await call("odb_part_answer", { answer: "VIN absolute maximum is 20 V.", pages: [2], source: "datasheet", confidence: "high" }, id)
  } else {
    await call("odb_part_answer", { answer: "Pin 1 is SW.", pages: [3], source: "datasheet", confidence: "high" }, id)
  }
}

describe("datasheet pages", () => {
  const pages = splitPages(PDFS[TPS])
  test("splits on form feeds and drops the trailing empty page", () => expect(pages.length).toBe(3))
  test("search finds pages with all words", () => {
    expect(searchPages(pages, "absolute VIN")).toContain("--- page 2 ---")
    expect(searchPages(pages, "absolute VIN")).not.toContain("--- page 1 ---")
    expect(searchPages(pages, "nonexistent")).toContain("No page contains")
  })
  test("page range and outline", () => {
    expect(pageRange(pages, 2, 3)).toContain("--- page 3 ---\n3 Pin Configuration")
    expect(pageRange(pages, 5)).toContain("the datasheet has 3")
    expect(outline(pages)).toContain("p2: 2 Absolute Maximum Ratings")
  })
})

describe("part notes", () => {
  test("keyed by MPN, or by design and refdes without one", () => {
    expect(partKey("TPS62130RGTR", "abc", "U1")).toBe("mpn-TPS62130RGTR")
    expect(partKey(undefined, "0123456789abcdef99", "U1")).toBe("ref-0123456789abcdef-U1")
  })
  test("same question ignores case, spacing and punctuation", () => {
    expect(sameQuestion("What is the max VIN?", "what is the  max vin")).toBe(true)
    expect(sameQuestion("What is the max VIN?", "What is the min VIN?")).toBe(false)
  })
})

describe("odb_part_ask", () => {
  test("answers from the attribute's datasheet in a child of the user's chat", async () => {
    const { ask, log, notes } = setup("first", reader)
    const out = await ask("U1", "What is the absolute maximum input voltage?")
    expect(out).toContain("VIN absolute maximum is 20 V.")
    expect(out).toContain(`from the datasheet ${TPS}, p. 2; confidence high`)
    // asked from a block explorer (ses_block), the part session hangs under its root chat
    expect(log.creates).toEqual([{ parentID: "ses_root", title: "Part TPS62130RGTR: datasheet questions" } as never])
    expect(log.prompts[0].text).toContain("Datasheet: from the design's datasheet attribute, 3 pages")
    expect(log.prompts[0].model).toEqual({ providerID: "prov", modelID: "mod" })
    const saved = notes.read("mpn-TPS62130RGTR")
    expect(saved.answers).toHaveLength(1)
    expect(saved.sessions.ses_root.id).toBe("ses_part1")
    expect(saved.datasheet).toMatchObject({ url: TPS, source: "attribute", pages: 3, mpnFound: true })
  })

  test("reuses the session, answers repeats from the notes and shares the part across refdes", async () => {
    const { ask, log } = setup("reuse", reader)
    await ask("U1", "What is the absolute maximum input voltage?")
    await ask("U1", "What is pin 1?", "ses_root")
    expect(log.creates).toHaveLength(1)
    expect(log.prompts[1]).toMatchObject({ id: "ses_part1" })
    expect(log.prompts[1].text).toStartWith("Next question. Part: U1")

    // U2 has the same MPN but no datasheet attribute: same notes, same datasheet, cached answer
    const cached = await ask("U2", "what is the absolute maximum input voltage")
    expect(cached).toContain("answered before for U1")
    expect(cached).toContain("VIN absolute maximum is 20 V.")
    expect(log.prompts).toHaveLength(2)
  })

  test("questions about one part run one after another", async () => {
    const { ask, log } = setup("parallel", reader)
    const outs = await Promise.all([ask("U1", "What is the absolute maximum input voltage?"), ask("U2", "What is pin 1?")])
    expect(log.maxRunning).toBe(1)
    expect(log.creates).toHaveLength(1)
    expect(outs[1]).toContain("Pin 1 is SW.")
  })

  test("a new chat gets a new session seeded from the notes", async () => {
    const { ask, log } = setup("newchat", reader)
    await ask("U1", "What is the absolute maximum input voltage?")
    await ask("U1", "What is pin 1?", "ses_other")
    expect(log.creates.map((c) => c.parentID)).toEqual(["ses_root", "ses_other"])
    expect(log.prompts[1].text).toContain("earlier answers (1)")
    expect(log.prompts[1].text).toContain("A (datasheet, p. 2, high): VIN absolute maximum is 20 V.")
  })

  test("a session over the context budget is replaced", async () => {
    const { ask, log, tokens } = setup("budget", reader, { budget: 5000 })
    await ask("U1", "What is the absolute maximum input voltage?")
    tokens.ses_part1 = 9000
    await ask("U1", "What is pin 1?")
    expect(log.creates).toHaveLength(2)
  })

  test("finds a datasheet on the web when the attribute is empty, and keeps it for later", async () => {
    const notesDir = join(tmp, "web-notes")
    const replies: string[] = []
    const web: Script = async (id, text, call) => {
      expect(text).toContain("Datasheet: none: the design has no datasheet attribute")
      expect(await call("odb_part_datasheet", { action: "search", query: "I2C" }, id)).toContain("No datasheet loaded")
      replies.push(await call("odb_part_datasheet", { action: "set", url: WRONG }, id))
      replies.push(await call("odb_part_datasheet", { action: "set", url: BMI }, id))
      await call("odb_part_answer", { answer: "0x18, or 0x19 with SDO1 high.", pages: [1], source: "datasheet", confidence: "high" }, id)
    }
    const first = setup("web", web, { notesDir })
    expect(await first.ask("U3", "What is the I2C address of the accelerometer?")).toContain("0x18")
    expect(replies[0]).toContain("Rejected: BMI088")
    expect(replies[1]).toContain(`Datasheet registered: ${BMI}, 1 pages`)
    const saved = first.notes.read("mpn-BMI088")
    expect(saved.datasheet).toMatchObject({ url: BMI, source: "web" })
    expect(saved.failedUrls.map((f) => f.url)).toEqual([WRONG])

    // another process (new service, same notes): the web datasheet is loaded up front
    const second = setup("web2", async (id, text, call) => {
      expect(text).toContain("Datasheet: found on the web earlier, 1 pages")
      expect(text).toContain(`did not work: ${WRONG}`)
      await call("odb_part_answer", { answer: "IMU with I2C and SPI.", pages: [1], source: "datasheet", confidence: "medium" }, id)
    }, { notesDir })
    expect(await second.ask("U3", "What interfaces does it have?")).toContain("IMU with I2C and SPI.")
  })

  test("a landing page attribute is reported to the agent", async () => {
    const { ask, notes } = setup("landing", async (id, text, call) => {
      expect(text).toContain("none loaded: the datasheet attribute did not work (Datasheet URL did not return a PDF")
      await call("odb_part_answer", { answer: "No datasheet found.", source: "not-found", confidence: "low" }, id)
    })
    expect(await ask("U4", "What is the dropout voltage?")).toContain("not found; confidence low")
    expect(notes.read("mpn-AP2112K-3.3").failedUrls[0].url).toBe(LANDING)
  })

  test("not-found answers are not reused", async () => {
    let prompts = 0
    const { ask } = setup("notfound-reuse", async (id, _t, call) => {
      prompts++
      await call("odb_part_answer", { answer: "No datasheet found.", source: "not-found", confidence: "low" }, id)
    })
    await ask("U4", "What is the dropout voltage?")
    await ask("U4", "What is the dropout voltage?")
    expect(prompts).toBe(2)
  })

  test("checks the answer's pages", async () => {
    const replies: string[] = []
    const { ask } = setup("pages", async (id, _t, call) => {
      replies.push(await call("odb_part_answer", { answer: "20 V", source: "datasheet", confidence: "high" }, id))
      replies.push(await call("odb_part_answer", { answer: "20 V", pages: [9], source: "datasheet", confidence: "high" }, id))
      replies.push(await call("odb_part_answer", { answer: "20 V", pages: [2], source: "datasheet", confidence: "high" }, id))
    })
    await ask("U1", "Max VIN?")
    expect(replies).toEqual([
      'Rejected: cite the page(s) for a "datasheet" answer.',
      "Rejected: the datasheet has 3 pages, not 9.",
      "Recorded. Reply with one short line and stop.",
    ])
  })

  test("an agent that answers in plain text is passed through but not saved", async () => {
    const { ask, notes } = setup("plain", async () => {})
    const out = await ask("U1", "Max VIN?")
    expect(out).toContain("not saved")
    expect(out).toContain("done")
    expect(notes.read("mpn-TPS62130RGTR").answers).toHaveLength(0)
  })

  test("the agent's tools refuse calls from outside a run", async () => {
    const { call } = setup("refuse", reader)
    for (const t of PART_TOOLS) expect(await call(t, { action: "info", answer: "x", source: "board", confidence: "low" }, "ses_root", "build")).toContain("Only available to the odb-part agent")
    expect(await call("odb_part_ask", { refdes: "U1", question: "x" }, "ses_root", PART_AGENT)).toContain("does not call odb_part_ask")
    expect(await call("odb_part_ask", { refdes: "U99", question: "x" }, "ses_root", "build")).toContain("No component named U99")
  })
})

describe("agent registration", () => {
  test("hidden subagent with its own tools, unreachable through the task tool", () => {
    const config: Record<string, any> = { permission: { "*": "allow", task: "ask" } }
    applyPartConfig(config, { web: true })
    const a = config.agent[PART_AGENT]
    expect(a).toMatchObject({ mode: "subagent", hidden: true })
    expect(a.permission).toMatchObject({ edit: "deny", bash: "ask", task: "deny", odb_part_ask: "deny", webfetch: "allow", websearch: "allow", odb_part_answer: "allow" })
    expect(config.permission.task).toEqual({ "*": "ask", [PART_AGENT]: "deny" })
    // the denies come after the user's catch-all, since the last matching rule wins
    expect(Object.keys(config.permission)).toEqual(["*", "task", ...PART_TOOLS])
    for (const t of PART_TOOLS) expect(config.permission[t]).toBe("deny")
  })

  test("web off and user overrides", () => {
    const config: Record<string, any> = { agent: { [PART_AGENT]: { model: "x/y", permission: { bash: "deny" } } } }
    applyPartConfig(config, { web: false })
    expect(config.agent[PART_AGENT]).toMatchObject({ model: "x/y", permission: { bash: "deny", webfetch: "deny", websearch: "deny", odb_part_context: "allow" } })
    expect(config.agent[PART_AGENT].prompt).toContain("Web lookups are switched off")
    expect(config.permission.task).toEqual({ [PART_AGENT]: "deny" })
  })
})

test("notes are written atomically and can be deleted", () => {
  const dir = join(tmp, "notes-raw")
  const s = new PartNotesStore(dir)
  const n = s.read("mpn-X")
  n.answers.push({ question: "q", answer: "a", pages: [], confidence: "low", source: "board", refdes: "U1", design: "d", at: "2026-01-01" })
  s.write(n)
  expect(JSON.parse(readFileSync(join(dir, "mpn-X.json"), "utf8")).answers).toHaveLength(1)
  s.delete("mpn-X")
  expect(existsSync(join(dir, "mpn-X.json"))).toBe(false)
})
