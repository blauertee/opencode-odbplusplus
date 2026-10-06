// In-process binding to OdbDesign through native/libodbpp (see native/odbpp.cpp).

import { CString, dlopen, FFIType } from "bun:ffi"
import { existsSync } from "node:fs"
import { join } from "node:path"

export interface NativeComponent {
  refDes: string
  part?: string
  package?: string
  side?: string
  x?: number
  y?: number
  props?: Record<string, string>
}

export interface NativeNet {
  name: string
  /** [refDes, pin name] */
  pins: [string, string][]
}

export interface NativeBoard {
  name: string
  components: NativeComponent[]
  nets: NativeNet[]
}

const LIB_NAME = process.platform === "darwin" ? "libodbpp.dylib" : "libodbpp.so"

function libraryPath(): string {
  const path = process.env.ODBPP_LIB ?? join(import.meta.dir, "..", "native", "lib", LIB_NAME)
  if (!existsSync(path)) {
    throw new Error(`${path} not found. Build it with native/build.sh or point ODBPP_LIB at it.`)
  }
  return path
}

let lib: ReturnType<typeof open> | undefined

function open() {
  return dlopen(libraryPath(), {
    odbpp_load_board: { args: [FFIType.cstring], returns: FFIType.ptr },
    odbpp_last_error: { args: [], returns: FFIType.cstring },
    odbpp_free: { args: [FFIType.ptr], returns: FFIType.void },
  })
}

/**
 * Parse an ODB++ archive with OdbDesign. Synchronous (about 1 s for a
 * 700-part board); OdbDesign extracts the archive next to the given path.
 */
export function loadBoard(archivePath: string): NativeBoard {
  lib ??= open()
  const ptr = lib.symbols.odbpp_load_board(Buffer.from(archivePath + "\0"))
  if (!ptr) throw new Error(`OdbDesign failed on ${archivePath}: ${lib.symbols.odbpp_last_error()}`)
  try {
    return JSON.parse(new CString(ptr).toString()) as NativeBoard
  } finally {
    lib.symbols.odbpp_free(ptr)
  }
}
