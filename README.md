# opencode-odbplusplus

Tools and skills to inspect schematics for LLM agents.

OpenCode plugin that makes PCB designs in ODB++ format (exported from KiCad, Altium, Pulsonix, …)
queryable through tool calls: a component's connections, everything on a net, signal chains
between two components, search, datasheet chapters. Parsing is done by the C++ library
[OdbDesign](https://github.com/nam20485/OdbDesign), directly inside the OpenCode process via `bun:ffi`.

Plan and background: [docs/PLAN.md](docs/PLAN.md).
Exporting from Altium Designer so the plugin gets value, MPN and datasheet: [docs/altium-export.md](docs/altium-export.md).

## Install

The plugin is not on npm, and it needs a native library built on your machine, so you install it
from a clone of this repository and point OpenCode at that clone. Requires
[Bun](https://bun.sh) and OpenCode.

```bash
# 1. Build dependencies (Debian/Ubuntu)
sudo apt install git cmake ninja-build g++ libprotobuf-dev protobuf-compiler \
                 libarchive-dev zlib1g-dev libasio-dev libabsl-dev

# 2. Clone the plugin from GitHub
git clone https://github.com/blauertee/opencode-odbplusplus ~/.local/share/opencode-odbplusplus
cd ~/.local/share/opencode-odbplusplus

# 3. Install the plugin's dependencies
bun install

# 4. Build OdbDesign + the C interface -> native/lib/libodbpp.so
#    (clones OdbDesign and Crow into native/vendor/ on first run)
bun run build:native
```

Then register the clone in an OpenCode config, either globally in `~/.config/opencode/opencode.json`
or per project in `opencode.json`. OpenCode loads a plugin from an absolute path to a directory
with a `package.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/home/you/.local/share/opencode-odbplusplus"]
}
```

Use the absolute path, since `~` is not expanded. Options can be passed as a tuple instead of
environment variables (names in `src/index.ts`):

```json
{ "plugin": [["/home/you/.local/share/opencode-odbplusplus", { "designsDir": "hardware/odb" }]] }
```

Alternatively, drop a file into a plugin directory (`~/.config/opencode/plugins/` or a project's
`.opencode/plugins/`), e.g. `odbplusplus.ts`:

```ts
export { OdbPlusPlusPlugin } from "/home/you/.local/share/opencode-odbplusplus/src/index.ts"
```

This repo already ships such a file, so starting OpenCode in the repo directory is enough to try it
on the test board:

```bash
cp testdata/jetson-orin-baseboard.tgz designs/
opencode
```

In your own projects, put ODB++ archives (`*.tgz`, `*.zip`) into a `designs/` folder in the project
or set `ODB_DESIGNS_DIR`.

**Updating:** `git pull && bun install && bun run build:native` in the clone, then restart OpenCode.
The native build only re-clones OdbDesign if `native/vendor/OdbDesign` is missing; delete
`native/vendor/` when the pinned OdbDesign revision in `native/build.sh` changes.

Configuration via environment variables:

| Variable | Default | |
|---|---|---|
| `ODB_DESIGNS_DIR` | `designs` in the project | folder with the ODB++ archives (`*.tgz`, `*.zip`) |
| `ODB_DESIGN` | – | default design, otherwise the only one in the folder |
| `ODBPP_LIB` | `native/lib/libodbpp.so` | path to the built library |
| `ODB_CACHE_DIR` | `~/.cache/opencode-odbplusplus` | working copies of archives, datasheets, mapping results |
| `ODB_MAPPING_AGENT` | `auto` | `off`: never start the mapping agent on its own |
| `ODB_MAPPING_MODEL` | OpenCode's `small_model` | `provider/model` for the mapping agent |
| `ODB_MAPPING_DIR` | in the cache | where mapping results per design are stored (e.g. in the project, to commit them) |
| `ODB_MPN_LOOKUP` | `off` | `datasheet`: also check proposed MPNs against the datasheet PDF |
| `ODB_UNDERSTANDING_DIR` | in the cache | where the explore agents' saved results per design are stored (e.g. in the project, to commit them) |
| `ODB_SCHEMATIC` | – | extra schematic files or folders, comma-separated (any file type) |
| `ODB_EXPLORE_MODEL` | the session's model | `provider/model` for the explore agents |

`odb_datasheet` needs `pdftotext` (package `poppler-utils`).

## Tools

| Tool | Example |
|---|---|
| `odb_designs` | Which designs are in the folder? |
| `odb_overview` | What is this board, what blocks and interfaces does it have? |
| `odb_block` | What is in the USB3 block, which nets leave it? |
| `odb_interfaces` | Which I2C buses exist, where do the CSI lanes go? |
| `odb_component` | All connections of U35 |
| `odb_net` | Everything on the +5V net |
| `odb_signal_path` | Components between U34 and J1 |
| `odb_search` | Where is the TUSB1046? Which nets are named `*I2C*`? |
| `odb_testpoints` | Which test pad carries I2C SDA? What is on TP21? All test points |
| `odb_datasheet` | Description chapter from the U10 datasheet |
| `odb_mapping` | How are properties mapped on this design, what is missing? Re-run or reset the mapping agent |
| `odb_understanding` | What do the saved results and user corrections say about this board or the USB3 block? |

Example output of `odb_signal_path { from: "U34", to: "J1" }` on the test board:

```
1. U34 -[/Peripherals/GPIOEX_I2C_SCL]-> R216 -[SYS_SCL]-> R31 -[/M.2/M2_E_I2C_CLK]-> J1
2. U34 -[/Peripherals/GPIOEX_I2C_SDA]-> R215 -[SYS_SDA]-> R30 -[/M.2/M2_E_I2C_DAT]-> J1

## Components on the chain
R30 | R_0R_0402 | MPN ERJ2GE0R00X | pkg R_0402_1005Metric
...
```

Test points are recognised by convention: a `TP<n>` refdes, or a `TP`/`TestPoint` footprint or value
on a part with at most two pins. `odb_testpoints` takes a `pattern` (refdes regex) for designs that
name them differently. The ODB++ `.test_point` pad attribute is not read yet; none of the exports we
have use it.

Start with `odb_overview` for a bird's-eye view: functional blocks inferred from schematic sheet
names in net names (KiCad), per-sheet refdes numbering (Altium) or connectivity, plus interfaces
recognised by net names. See [docs/features/board-overview.md](docs/features/board-overview.md).

## Exploring a board

Three subagents ship with the plugin. They are not primary agents: your own agent launches them,
or you call them with `@`.

| Agent | What it does |
|---|---|
| `@odb-explore` | Works out what the board is for, its blocks, how they connect and power. Launches `odb-block-explore` per block in parallel and saves the result. |
| `@odb-block-explore USB3` | Explores one block and saves the result. |
| `@odb-understanding-fix` | Records a correction from you and rewrites every saved result it affects. Your agent must launch it when you correct something it read from the saved understanding. |

Saved results are reused across sessions; `odb_understanding` shows them and marks stale ones.
Your corrections live in `<design>.understanding.md` next to the archive. You can edit it by hand;
its `title:`, `function:` and `parts: +R12 -U19` lines override the agents and the block grouping.
A schematic in any format can be put next to the archive as `<design>.schematic.<ext>` (PDF, Markdown,
text, …) or set with `ODB_SCHEMATIC`. The plugin never parses it; the agents read it with whatever
tools your OpenCode setup has. The plugin sets `subagent_depth: 2` unless you set it, so
`odb-explore` can launch subagents. Details: [docs/features/board-exploration.md](docs/features/board-exploration.md).

## Property mapping

EDA tools name component properties differently, so the plugin maps them to the fields its tools
use (value, MPN, datasheet, description, manufacturer) and recognises test points, rails and
mechanical parts. Built-in names are in `src/aliases.ts`. When a design still looks under-mapped
(e.g. unknown property names that hold part numbers, no test points found, or values only in the
part name, as in Altium exports without parameters), the plugin starts the `odb-mapper` agent in a
child session. The agent proposes rules; the plugin checks every rule against the data, including
offline MPN checks, and stores the accepted ones as an overlay keyed by the archive's SHA-256. The
archive itself is never changed. Details: [docs/features/auto-repair-attribute-mapping.md](docs/features/auto-repair-attribute-mapping.md).

To fix a mapping by hand, put `<design>.mapping.json` next to the archive. It takes the same rules
and always wins:

```json
{ "rules": [
  { "kind": "propertyAlias", "field": "mpn", "property": "PARTNO_MFR", "confidence": "high", "evidence": { "note": "manual" } },
  { "kind": "classify", "feature": "testPoint", "value": true, "match": { "part": ["PAD.04"] }, "confidence": "high", "evidence": { "note": "manual" } }
] }
```

## Development

```bash
bun test                         # unit tests, plus integration tests once native/lib is built
bun run typecheck
scripts/export-test-design.sh    # re-export the test board from KiCad (Docker)
```

## License

GPL-3.0 (see `LICENSE`). OdbDesign is AGPL-3.0 and is linked into the process (see `docs/PLAN.md`).
Test boards: `jetson-orin-baseboard` (KiCad export, by Antmicro, Apache-2.0, `testdata/jetson-orin-baseboard.LICENSE`)
and `altium.pixhawk-fmuv3` (Altium Designer 20.1 export of the Pixhawk FMUv3, CC BY-SA 3.0,
`testdata/pixhawk-fmuv3.LICENSE`). The Altium export carries no component properties: the Altium
comment ends up as the part name, so MPN and datasheet lookups return nothing on it.
