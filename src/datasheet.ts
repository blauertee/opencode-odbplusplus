// Datasheet retrieval: download the PDF a part's "Datasheet" property points
// to, convert it with poppler's pdftotext and cut out one chapter.
// First iteration, see docs/PLAN.md (phase 3) for the planned improvements.

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
