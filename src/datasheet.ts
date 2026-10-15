// Datasheet retrieval: download the PDF a part's "Datasheet" property points
// to, convert it with poppler's pdftotext and cut out one chapter.
// First iteration, see docs/PLAN.md (phase 3) for the planned improvements.
// The page helpers at the end serve the odb-part agent (docs/features/part-questions.md).

import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { CACHE_DIR as ROOT } from "./cache.ts"

const CACHE_DIR = join(ROOT, "datasheets")

export async function datasheetText(url: string): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const key = createHash("sha256").update(url).digest("hex").slice(0, 16)
  const pdf = join(CACHE_DIR, `${key}.pdf`)
  const txt = join(CACHE_DIR, `${key}.txt`)
  if (existsSync(txt)) return Bun.file(txt).text()

  if (!existsSync(pdf)) {
    const res = await fetch(url, {
      redirect: "follow",
      // Several vendor sites (TI, Mouser) reject non-browser user agents.
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" },
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`Datasheet download failed (${res.status}): ${url}`)
    const body = new Uint8Array(await res.arrayBuffer())
    if (new TextDecoder().decode(body.slice(0, 5)) !== "%PDF-") {
      throw new Error(`Datasheet URL did not return a PDF (probably a landing page): ${url}`)
    }
    await Bun.write(pdf, body)
  }

  const proc = Bun.spawn(["pdftotext", "-layout", pdf, txt], { stderr: "pipe" })
  if ((await proc.exited) !== 0) {
    throw new Error(`pdftotext failed (is poppler-utils installed?): ${await new Response(proc.stderr).text()}`)
  }
  return Bun.file(txt).text()
}

/**
 * Return the chapter whose heading matches `section`, skipping table-of-
 * contents entries (lines ending in dot leaders or a bare page number).
 */
export function extractSection(text: string, section: string, maxChars = 6000): string | undefined {
  const lines = text.split("\n")
  const name = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const heading = new RegExp(`^\\s*(\\d+(?:\\.\\d+)*\\.?\\s+)?${name}\\b`, "i")
  const toc = /(\.{4,}|\s{3,}\d+\s*$)/

  const start = lines.findIndex((l) => heading.test(l) && !toc.test(l))
  if (start < 0) return undefined

  // Stop at the next numbered heading of the same or higher level.
  const number = lines[start].match(/^\s*(\d+(?:\.\d+)*)/)?.[1]
  const depth = number ? number.split(".").length : 1
  const nextHeading = new RegExp(`^\\s*\\d+(?:\\.\\d+){0,${depth - 1}}\\.?\\s+[A-Z]`)

  const out: string[] = [lines[start]]
  let size = lines[start].length
  for (const line of lines.slice(start + 1)) {
    if (number && nextHeading.test(line)) break
    out.push(line)
    size += line.length + 1
    if (size > maxChars) {
      out.push("[... truncated]")
      break
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n")
}

// ---- page access for the odb-part agent (docs/features/part-questions.md)

/** pdftotext separates pages with form feeds; page n is pages[n - 1]. */
export function splitPages(text: string): string[] {
  const pages = text.split("\f")
  // pdftotext ends the last page with a form feed too.
  if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop()
  return pages
}

/** Text of pages `from`..`to` (1-based, inclusive), each headed with its number, capped at `maxChars`. */
export function pageRange(pages: string[], from: number, to = from, maxChars = 12000): string {
  const first = Math.max(1, Math.floor(from))
  const last = Math.min(pages.length, Math.floor(to))
  if (first > last) return `No such pages; the datasheet has ${pages.length}.`
  const out: string[] = []
  let size = 0
  for (let n = first; n <= last; n++) {
    const body = pages[n - 1].replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim()
    if (size + body.length > maxChars && out.length) {
      out.push(`[... stopped before page ${n}, ask for fewer pages at once]`)
      break
    }
    out.push(`--- page ${n} ---\n${body.length > maxChars ? body.slice(0, maxChars) + "\n[... truncated]" : body}`)
    size += body.length
  }
  return out.join("\n\n")
}

/** Pages containing all words of `query` (case-insensitive), with the matching lines and one line around them. */
export function searchPages(pages: string[], query: string, maxPages = 8): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return "Empty query."
  const hits: string[] = []
  let total = 0
  pages.forEach((page, i) => {
    const low = page.toLowerCase()
    if (!words.every((w) => low.includes(w))) return
    total++
    if (hits.length >= maxPages) return
    const lines = page.split("\n")
    const keep = new Set<number>()
    lines.forEach((l, j) => {
      if (words.some((w) => l.toLowerCase().includes(w))) for (const k of [j - 1, j, j + 1]) if (k >= 0 && k < lines.length) keep.add(k)
    })
    const shown = [...keep].sort((a, b) => a - b).slice(0, 12).map((j) => lines[j].trimEnd())
    hits.push(`--- page ${i + 1} ---\n${shown.join("\n")}`)
  })
  if (!total) return `No page contains all of: ${words.join(", ")}. Try fewer or other words.`
  return `${total} page(s) match${total > hits.length ? `, first ${hits.length} shown` : ""}:\n\n${hits.join("\n\n")}`
}

/**
 * Numbered chapter headings with the page they are on, skipping table-of-contents
 * lines. A rough outline; datasheets without numbered headings get page openings instead.
 */
export function outline(pages: string[], max = 80): string {
  const toc = /(\.{4,}|\s{3,}\d+\s*$)/
  const heading = /^\s*(\d+(?:\.\d+){0,2})\.?\s+([A-Z][A-Za-z0-9 ,/&()+-]{2,60})\s*$/
  const seen = new Set<string>()
  const out: string[] = []
  pages.forEach((page, i) => {
    for (const line of page.split("\n")) {
      if (toc.test(line)) continue
      const m = line.match(heading)
      if (!m) continue
      const key = `${m[1]} ${m[2].trim()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(`p${i + 1}: ${key}`)
    }
  })
  if (out.length >= 3) return out.slice(0, max).join("\n") + (out.length > max ? `\n[... ${out.length - max} more]` : "")
  return pages
    .slice(0, max)
    .map((p, i) => `p${i + 1}: ${p.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 1).join("").slice(0, 80)}`)
    .join("\n")
}
