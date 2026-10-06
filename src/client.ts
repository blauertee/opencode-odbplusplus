// Thin REST client for OdbDesignServer (https://github.com/nam20485/OdbDesign).
// Only the endpoints the board index needs are typed here; see the server's
// swagger spec for the full surface.

export interface ClientOptions {
  baseUrl: string
  username?: string
  password?: string
  /** Request timeout in ms. Large designs take a few seconds to parse on first access. */
  timeoutMs?: number
}

export interface Pin {
  name: string
  index?: number
}

export interface Package {
  name: string
  pins?: Pin[]
}

export interface Component {
  refDes: string
  partName?: string
  side?: "Top" | "Bottom" | "BsNone"
  package?: Package
}

export interface PinConnection {
  name: string
  component: Component
  pin: Pin
}

export interface Net {
  name: string
  pinConnections?: PinConnection[]
}

export interface Design {
  name: string
  nets: Net[]
  components: Component[]
}

export interface PropertyRecord {
  name: string
  value?: string
}

export interface ComponentRecord {
  compName: string
  partName?: string
  locationX?: number
  locationY?: number
  rotation?: number
  propertyRecords?: PropertyRecord[]
}

export interface ComponentsFile {
  side?: string
  componentRecords?: ComponentRecord[]
}

export interface MatrixLayer {
  name: string
  type?: string
}

export interface ArchiveListing {
  name: string
  loaded?: boolean
}

export class OdbDesignClient {
  constructor(private readonly opts: ClientOptions) {}

  async listDesigns(): Promise<ArchiveListing[]> {
    const res = await this.request("/designs")
    if (res.status === 204) return []
    const body = (await res.json()) as { filearchives?: ArchiveListing[] }
    return body.filearchives ?? []
  }

  getDesign(name: string): Promise<Design> {
    return this.json(`/designs/${enc(name)}`)
  }

  async getSteps(name: string): Promise<string[]> {
    const body = await this.json<{ steps?: string[] }>(`/filemodels/${enc(name)}/steps`)
    return body.steps ?? []
  }

  async getMatrixLayers(name: string): Promise<MatrixLayer[]> {
    const body = await this.json<{ layers?: MatrixLayer[] }>(`/filemodels/${enc(name)}/matrix/matrix`)
    return body.layers ?? []
  }

  getComponentsFile(name: string, step: string, layer: string): Promise<ComponentsFile> {
    return this.json(`/filemodels/${enc(name)}/steps/${enc(step)}/layers/${enc(layer)}/components`)
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.request(path)
    return (await res.json()) as T
  }

  private async request(path: string): Promise<Response> {
    const headers: Record<string, string> = {}
    if (this.opts.username) {
      headers.Authorization = "Basic " + btoa(`${this.opts.username}:${this.opts.password ?? ""}`)
    }
    const url = this.opts.baseUrl.replace(/\/+$/, "") + path
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`OdbDesignServer ${res.status} for ${path}: ${text.trim()}`)
    }
    return res
  }
}

// encodeURIComponent keeps '+' in layer names like "comp_+_top" safe; the
// server decodes a literal '+' as a space.
const enc = (s: string) => encodeURIComponent(s)
