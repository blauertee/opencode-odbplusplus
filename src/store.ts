// Loads designs from OdbDesignServer and caches one BoardIndex per design.

import { BoardIndex } from "./board.ts"
import type { ComponentRecord, OdbDesignClient } from "./client.ts"

export class DesignStore {
  private readonly cache = new Map<string, Promise<BoardIndex>>()

  constructor(
    private readonly client: OdbDesignClient,
    private readonly defaultDesign?: string,
  ) {}

  async list() {
    return this.client.listDesigns()
  }

  /**
   * Resolve which design a tool call refers to: the explicit argument, the
   * configured default, or the only design on the server.
   */
  async resolveName(name?: string): Promise<string> {
    if (name) return name.replace(/\.(tgz|zip)$/i, "")
    if (this.defaultDesign) return this.defaultDesign
    const designs = await this.client.listDesigns()
    if (designs.length === 1) return designs[0].name
    if (designs.length === 0) throw new Error("OdbDesignServer has no designs. Put an ODB++ .tgz into its designs directory.")
    throw new Error(`Several designs available, pass one of: ${designs.map((d) => d.name).join(", ")}`)
  }

  async get(name?: string): Promise<BoardIndex> {
    const resolved = await this.resolveName(name)
    let pending = this.cache.get(resolved)
    if (!pending) {
      pending = this.load(resolved)
      this.cache.set(resolved, pending)
      pending.catch(() => this.cache.delete(resolved))
    }
    return pending
  }

  invalidate(name?: string) {
    if (name) this.cache.delete(name)
    else this.cache.clear()
  }

  private async load(name: string): Promise<BoardIndex> {
    const design = await this.client.getDesign(name)
    const records = await this.loadComponentRecords(name)
    return BoardIndex.build(name, design, records)
  }

  /** Component layer files carry per-part properties (value, MPN, datasheet URL, ...). */
  private async loadComponentRecords(name: string): Promise<ComponentRecord[]> {
    const [steps, layers] = await Promise.all([this.client.getSteps(name), this.client.getMatrixLayers(name)])
    const step = steps[0]
    if (!step) return []
    const compLayers = layers.filter((l) => l.type?.toLowerCase() === "component").map((l) => l.name.toLowerCase())
    const files = await Promise.all(
      compLayers.map((layer) => this.client.getComponentsFile(name, step, layer).catch(() => undefined)),
    )
    return files.flatMap((f) => f?.componentRecords ?? [])
  }
}
