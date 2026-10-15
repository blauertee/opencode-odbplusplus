// The odb-part subagent: answers questions about one component from its
// datasheet (docs/features/part-questions.md).
//
// The plugin runs it itself (odb_part_ask) instead of leaving it to the task
// tool, so the part's context survives: one child session per part and chat,
// reused on every question, plus notes on disk (src/part/notes.ts) that seed a
// new session in another chat. Calls on the same part run one after another.

import type { PluginInput } from "@opencode-ai/plugin"
import type { BoardComponent, BoardIndex } from "../board.ts"
import { componentSummary } from "../format.ts"
import { outline, splitPages } from "../datasheet.ts"
import { mpnInText } from "../mapping/mpn.ts"
import { notesSummary, partKey, sameQuestion, type Answer, type AnswerSource, type Confidence, type PartNotes, PartNotesStore } from "./notes.ts"
import { partPrompt } from "./prompt.ts"

export const PART_AGENT = "odb-part"
/** Tools only odb-part may call; denied for every other agent. */
export const PART_TOOLS = ["odb_part_context", "odb_part_datasheet", "odb_part_answer"] as const

export interface PartOptions {
  client: PluginInput["client"]
  notes?: PartNotesStore
  /** Datasheet text for a URL (src/datasheet.ts, replaceable in tests). */
  datasheetText: (url: string) => Promise<string>
  /** `provider/model` set for the agent; without it the caller's model is used. */
  model?: string
  web: boolean
  timeoutMs: number
  /** A part session whose context is bigger than this (tokens) is replaced by a fresh one seeded from the notes. */
  contextBudget: number
  /** How long to let the agent finish its turn after it submitted, before the session is aborted. */
  graceMs?: number
}

export interface AskRequest {
  board: BoardIndex
  design: { stem: string; fingerprint: string }
  component: BoardComponent
  question: string
  ctx: { sessionID: string; messageID?: string; abort?: AbortSignal; metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void }
}

/** State of one running question, looked up by the child session's id from the agent's tools. */
export interface PartRun {
  board: BoardIndex
  component: BoardComponent
  design: { stem: string; fingerprint: string }
  question: string
  notes: PartNotes
  /** The datasheet the run reads, split into pages. */
  datasheet?: { url: string; pages: string[] }
  answer?: Answer
  finish: () => void
}

type Action = "allow" | "ask" | "deny"

/** Agent config added through the plugin's config hook. */
export function partAgentConfig(opts: { model?: string; web: boolean }) {
  const web: Action = opts.web ? "allow" : "deny"
  return {
    mode: "subagent" as const,
    hidden: true,
    description: "Answers a question about one component from its datasheet. Run by the odb_part_ask tool, not for the task tool.",
    prompt: partPrompt(opts.web),
    ...(opts.model ? { model: opts.model } : {}),
    steps: 20,
    maxSteps: 20,
    tools: Object.fromEntries(PART_TOOLS.map((t) => [t, true])),
    permission: {
      edit: "deny" as Action,
      // Shell PDF tools work after one approval; the prompt shows up in the user's chat (the run is its child).
      bash: "ask" as Action,
      task: "deny" as Action,
      odb_part_ask: "deny" as Action,
      webfetch: web,
      websearch: web,
      ...Object.fromEntries(PART_TOOLS.map((t) => [t, "allow" as Action])),
    },
  }
}

/**
 * Register odb-part, keep its tools away from every other agent and stop the
 * task tool from launching it (that would bypass the session reuse and notes).
 * User settings under agent["odb-part"] win over ours.
 */
export function applyPartConfig(config: Record<string, any>, opts: { model?: string; web: boolean }) {
  const ours = partAgentConfig(opts)
  const user = config.agent?.[PART_AGENT] ?? {}
  config.agent = {
    ...config.agent,
    [PART_AGENT]: { ...ours, ...user, permission: { ...ours.permission, ...user.permission }, tools: { ...ours.tools, ...user.tools } },
  }
  const deny = Object.fromEntries(PART_TOOLS.map((t) => [t, "deny" as const]))
  const perm = typeof config.permission === "string" ? { "*": config.permission } : { ...config.permission }
  const task = perm.task
  // Last matching rule wins, so our rules go after the user's.
  perm.task = typeof task === "string" ? { "*": task, [PART_AGENT]: "deny" } : { ...task, [PART_AGENT]: "deny" }
  config.permission = { ...perm, ...deny }
  config.tools = { ...config.tools, ...Object.fromEntries(PART_TOOLS.map((t) => [t, false])) }
}

export class PartService {
  readonly notes: PartNotesStore
  private readonly runs = new Map<string, PartRun>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(readonly opts: PartOptions) {
    this.notes = opts.notes ?? new PartNotesStore()
  }

  /** The run a tool call belongs to, if it comes from an odb-part session the plugin started. */
  run(sessionID: string): PartRun | undefined {
    return this.runs.get(sessionID)
  }

  /** Answer one question; calls on the same part wait for each other. */
  async ask(req: AskRequest): Promise<string> {
    const key = partKey(req.board.mpn(req.component), req.design.fingerprint, req.component.refDes)
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(() => this.askLocked(key, req))
    this.locks.set(key, next)
    try {
      return await next
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key)
    }
  }

  private async askLocked(key: string, req: AskRequest): Promise<string> {
    const { board, component: c, question, ctx } = req
    const notes = this.notes.read(key)
    const mpn = board.mpn(c)
    notes.mpn ??= mpn
    notes.manufacturer ??= board.manufacturer(c)

    const ds = await this.loadDatasheet(board, c, notes)
    const cached = [...notes.answers].reverse().find((a) => sameQuestion(a.question, question) && a.datasheet === ds.datasheet?.url && a.source !== "not-found")
    if (cached) {
      this.notes.write(notes)
      return formatAnswer(board, c, cached, true)
    }

    const root = await this.rootSession(ctx.sessionID)
    let sessionID = await this.reusable(notes, root)
    const fresh = !sessionID
    if (!sessionID) {
      const created = await this.opts.client.session.create({
        body: { parentID: root, title: `Part ${mpn ?? c.refDes}: datasheet questions` },
      })
      sessionID = created.data?.id
      if (!sessionID) return `Could not start the odb-part agent: ${JSON.stringify(created.error ?? "no session id")}`
    }
    notes.sessions[root] = { id: sessionID, at: new Date().toISOString() }
    this.notes.write(notes)
    ctx.metadata?.({ title: `${c.refDes}: ${question.slice(0, 60)}`, metadata: { sessionId: sessionID } })

    let finish!: () => void
    const finished = new Promise<void>((resolve) => (finish = resolve))
    const run: PartRun = { board, component: c, design: req.design, question, notes, datasheet: ds.datasheet, finish }
    this.runs.set(sessionID, run)

    try {
      const text = fresh ? seedMessage(board, c, req.design.stem, question, ds.status, notes) : followUp(board, c, req.design.stem, question, ds.status)
      const model = this.opts.model ? undefined : await this.callerModel(ctx)
      const prompt = this.opts.client.session
        .prompt({
          path: { id: sessionID },
          body: { agent: PART_AGENT, ...(model ? { model } : {}), parts: [{ type: "text", text }] },
        })
        .then((r) => (r.error ? { error: `prompt failed: ${JSON.stringify(r.error)}` } : { text: lastText(r.data?.parts) }))
        .catch((e: Error) => ({ error: `prompt failed: ${e.message}` }))

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), this.opts.timeoutMs)))
      const aborted = new Promise<"aborted">((resolve) => ctx.abort?.addEventListener("abort", () => resolve("aborted"), { once: true }))
      const outcome = await Promise.race([finished.then(() => "answered" as const), prompt, timeout, aborted])
      clearTimeout(timer)

      let stop = outcome === "timeout" || outcome === "aborted"
      if (outcome === "answered") {
        // Let the agent end its turn so the next question finds the session idle.
        const grace = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), this.opts.graceMs ?? 15_000))
        stop = (await Promise.race([prompt, grace])) === "late"
      }
      if (stop) await this.opts.client.session.abort({ path: { id: sessionID } }).catch(() => undefined)

      if (run.answer) {
        notes.answers.push(run.answer)
        this.notes.write(notes)
        return formatAnswer(board, c, run.answer, false)
      }
      this.notes.write(notes)
      if (outcome === "aborted") return "Cancelled."
      if (outcome === "timeout") return `The odb-part agent did not answer within ${Math.round(this.opts.timeoutMs / 1000)} s.`
      const result = outcome as { text?: string; error?: string }
      if (result.text?.trim()) return `${componentSummary(board, c)}\n(not saved: the agent answered without odb_part_answer)\n\n${result.text.trim()}`
      return `The odb-part agent ended without an answer${result.error ? `: ${result.error}` : "."}`
    } finally {
      this.runs.delete(sessionID)
    }
  }

  /**
   * The datasheet to read: the design's attribute when it gives a PDF, else
   * the one found on the web earlier. Failures are remembered in the notes.
   */
  private async loadDatasheet(board: BoardIndex, c: BoardComponent, notes: PartNotes): Promise<{ datasheet?: PartRun["datasheet"]; status: string }> {
    const mpn = board.mpn(c)
    const attr = board.datasheet(c)
    let attrFailure: string | undefined
    if (attr) {
      try {
        const text = await this.opts.datasheetText(attr)
        const pages = splitPages(text)
        const mpnFound = mpn ? mpnInText(mpn, text) : undefined
        notes.datasheet = { url: attr, source: "attribute", pages: pages.length, mpnFound, at: new Date().toISOString() }
        const warn = mpnFound === false ? `; the MPN ${mpn} does not appear in it, check that it is the right document` : ""
        return { datasheet: { url: attr, pages }, status: `from the design's datasheet attribute, ${pages.length} pages${warn}` }
      } catch (e) {
        attrFailure = (e as Error).message
        failed(notes, attr, attrFailure)
        if (notes.datasheet?.url === attr) notes.datasheet = undefined
      }
    }
    if (notes.datasheet) {
      try {
        const pages = splitPages(await this.opts.datasheetText(notes.datasheet.url))
        const how = notes.datasheet.source === "web" ? "found on the web earlier" : "from a datasheet attribute seen earlier"
        return { datasheet: { url: notes.datasheet.url, pages }, status: `${how}, ${pages.length} pages` }
      } catch (e) {
        failed(notes, notes.datasheet.url, (e as Error).message)
        notes.datasheet = undefined
      }
    }
    if (attrFailure) return { status: `none loaded: the datasheet attribute did not work (${attrFailure})` }
    return { status: "none: the design has no datasheet attribute for this part" }
  }

  /** odb_part_datasheet set: download a datasheet the agent found and keep it when the MPN is in it. */
  async setDatasheet(run: PartRun, url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url)) return "Pass an http(s) link to a PDF."
    let text: string
    try {
      text = await this.opts.datasheetText(url)
    } catch (e) {
      failed(run.notes, url, (e as Error).message)
      this.notes.write(run.notes)
      return `Rejected: ${(e as Error).message}. Find the direct PDF link.`
    }
    const mpn = run.board.mpn(run.component)
    if (mpn && !mpnInText(mpn, text)) {
      failed(run.notes, url, `MPN ${mpn} not in the text`)
      this.notes.write(run.notes)
      return `Rejected: ${mpn} (or its base without packaging suffix) does not appear in that PDF, so it is probably another part's datasheet.`
    }
    const pages = splitPages(text)
    const source = url === run.board.datasheet(run.component) ? "attribute" : "web"
    run.notes.datasheet = { url, source, pages: pages.length, mpnFound: mpn ? true : undefined, at: new Date().toISOString() }
    run.datasheet = { url, pages }
    this.notes.write(run.notes)
    return `Datasheet registered: ${url}, ${pages.length} pages.\n\n${outline(pages)}`
  }

  /** odb_part_answer: check and keep the agent's answer, which ends the run. */
  submitAnswer(run: PartRun, args: { answer: string; pages?: number[]; confidence: Confidence; source: AnswerSource }): string {
    if (!args.answer.trim()) return "Rejected: empty answer."
    const pages = [...new Set(args.pages ?? [])].sort((a, b) => a - b)
    if (args.source === "datasheet") {
      if (!run.datasheet) return 'Rejected: no datasheet is loaded, so source cannot be "datasheet". Register one with odb_part_datasheet set, or use another source.'
      const bad = pages.filter((p) => p < 1 || p > run.datasheet!.pages.length)
      if (bad.length) return `Rejected: the datasheet has ${run.datasheet.pages.length} pages, not ${bad.join(", ")}.`
      if (!pages.length) return 'Rejected: cite the page(s) for a "datasheet" answer.'
    }
    run.answer = {
      question: run.question,
      answer: args.answer.trim(),
      pages,
      confidence: args.confidence,
      source: args.source,
      datasheet: run.datasheet?.url,
      refdes: run.component.refDes,
      design: run.design.stem,
      at: new Date().toISOString(),
    }
    run.finish()
    return "Recorded. Reply with one short line and stop."
  }

  /** The user's chat: part sessions hang under it so they can be watched and their permission prompts show up there. */
  private async rootSession(sessionID: string): Promise<string> {
    let id = sessionID
    for (let i = 0; i < 8; i++) {
      const r = await this.opts.client.session.get({ path: { id } }).catch(() => undefined)
      const parent = (r?.data as { parentID?: string } | undefined)?.parentID
      if (!parent) return id
      id = parent
    }
    return id
  }

  /** The part's session in this chat, if it still exists and its context is under budget. */
  private async reusable(notes: PartNotes, root: string): Promise<string | undefined> {
    const entry = notes.sessions[root]
    if (!entry) return undefined
    const r = await this.opts.client.session.messages({ path: { id: entry.id } }).catch(() => undefined)
    if (!r || r.error || !Array.isArray(r.data)) return undefined
    const last = (r.data as { info: { role: string; tokens?: { input: number; cache?: { read: number } } } }[])
      .map((m) => m.info)
      .reverse()
      .find((i) => i.role === "assistant" && i.tokens)
    const used = last?.tokens ? last.tokens.input + (last.tokens.cache?.read ?? 0) : 0
    return used > this.opts.contextBudget ? undefined : entry.id
  }

  /** Model of the message that called the tool, so the agent runs on the caller's model unless partModel is set. */
  private async callerModel(ctx: AskRequest["ctx"]): Promise<{ providerID: string; modelID: string } | undefined> {
    if (!ctx.messageID) return undefined
    const r = await this.opts.client.session.message({ path: { id: ctx.sessionID, messageID: ctx.messageID } }).catch(() => undefined)
    const info = (r?.data as { info?: { role: string; providerID?: string; modelID?: string } } | undefined)?.info
    return info?.role === "assistant" && info.providerID && info.modelID ? { providerID: info.providerID, modelID: info.modelID } : undefined
  }
}

function failed(notes: PartNotes, url: string, reason: string) {
  notes.failedUrls = [...notes.failedUrls.filter((f) => f.url !== url), { url, reason, at: new Date().toISOString() }].slice(-10)
}

function lastText(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined
  return [...(parts as { type: string; text?: string }[])].reverse().find((p) => p.type === "text")?.text
}

function partLine(board: BoardIndex, c: BoardComponent, stem: string): string {
  const mfr = board.manufacturer(c)
  return `${componentSummary(board, c)}${mfr ? ` | ${mfr}` : ""} (design "${stem}")`
}

function seedMessage(board: BoardIndex, c: BoardComponent, stem: string, question: string, status: string, notes: PartNotes): string {
  const desc = board.description(c)
  return [
    `Part: ${partLine(board, c, stem)}`,
    ...(desc ? [`Description: ${desc}`] : []),
    `Datasheet: ${status}`,
    "",
    "What earlier sessions learned about this part:",
    notesSummary(notes),
    "",
    `Question: ${question}`,
  ].join("\n")
}

function followUp(board: BoardIndex, c: BoardComponent, stem: string, question: string, status: string): string {
  return [`Next question. Part: ${partLine(board, c, stem)}`, `Datasheet: ${status}`, "", `Question: ${question}`].join("\n")
}

function formatAnswer(board: BoardIndex, c: BoardComponent, a: Answer, cached: boolean): string {
  const where =
    a.source === "datasheet"
      ? `from the datasheet ${a.datasheet}, p. ${a.pages.join(", ")}`
      : a.source === "board"
        ? "from the board data only"
        : a.source === "web"
          ? "from other web sources"
          : "not found"
  const when = cached ? `\n(answered before for ${a.refdes} on ${a.at.slice(0, 10)}; from the saved part notes)` : ""
  return `${componentSummary(board, c)}\n${where}; confidence ${a.confidence}${when}\n\n${a.answer}`
}
