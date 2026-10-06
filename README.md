# opencode-odbplusplus

Tools and skills to inspect schematics for LLM agents.

OpenCode plugin that makes PCB designs in ODB++ format (exported from KiCad, Altium, Pulsonix, …)
queryable through tool calls: a component's connections, everything on a net, signal chains
between two components, search, datasheet chapters. Parsing is done by the C++ library
[OdbDesign](https://github.com/nam20485/OdbDesign), directly inside the OpenCode process via `bun:ffi`.

Plan and background: [docs/PLAN.md](docs/PLAN.md).

## Quick start

```bash
# 1. Build dependencies (Debian/Ubuntu)
sudo apt install git cmake ninja-build g++ libprotobuf-dev protobuf-compiler \
                 libarchive-dev zlib1g-dev libasio-dev

# 2. Build OdbDesign + the C interface -> native/lib/libodbpp.so
bun run build:native

# 3. Plugin dependencies, provide the test board
bun install
cp testdata/jetson-orin-baseboard.tgz designs/
```

Load it in OpenCode, e.g. in a project at `.opencode/plugins/odbplusplus.ts`:

```ts
export { OdbPlusPlusPlugin } from "/path/to/opencode-odbplusplus/src/index.ts"
```

This repo already ships that file: starting OpenCode in the repo directory is enough.

Configuration via environment variables:

| Variable | Default | |
|---|---|---|
| `ODB_DESIGNS_DIR` | `designs` in the project | folder with the ODB++ archives (`*.tgz`, `*.zip`) |
| `ODB_DESIGN` | – | default design, otherwise the only one in the folder |
| `ODBPP_LIB` | `native/lib/libodbpp.so` | path to the built library |
| `ODB_CACHE_DIR` | `~/.cache/opencode-odbplusplus` | working copies of archives, datasheets |

`odb_datasheet` needs `pdftotext` (package `poppler-utils`).

## Tools

| Tool | Example |
|---|---|
| `odb_designs` | Which designs are in the folder? |
| `odb_component` | All connections of U35 |
| `odb_net` | Everything on the +5V net |
| `odb_signal_path` | Components between U34 and J1 |
| `odb_search` | Where is the TUSB1046? Which nets are named `*I2C*`? |
| `odb_datasheet` | Description chapter from the U10 datasheet |

Example output of `odb_signal_path { from: "U34", to: "J1" }` on the test board:

```
1. U34 -[/Peripherals/GPIOEX_I2C_SCL]-> R216 -[SYS_SCL]-> R31 -[/M.2/M2_E_I2C_CLK]-> J1
2. U34 -[/Peripherals/GPIOEX_I2C_SDA]-> R215 -[SYS_SDA]-> R30 -[/M.2/M2_E_I2C_DAT]-> J1

## Components on the chain
R30 | R_0R_0402 | MPN ERJ2GE0R00X | pkg R_0402_1005Metric
...
```

## Development

```bash
bun test                         # unit tests, plus integration tests once native/lib is built
bun run typecheck
scripts/export-test-design.sh    # re-export the test board from KiCad (Docker)
```

## License

GPL-3.0 (see `LICENSE`). OdbDesign is AGPL-3.0 and is linked into the process (see `docs/PLAN.md`).
The test board is by Antmicro (Apache-2.0, `testdata/jetson-orin-baseboard.LICENSE`).
