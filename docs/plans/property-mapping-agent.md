# Plan: property-mapping repair agent

Status: plan, not implemented.

ODB++ carries component properties verbatim from the EDA tool, and every tool and part library
names them differently. Today `src/aliases.ts` maps names to the fields the plugin uses, and
`src/board.ts` recognises test points and rails by fixed conventions. When an export uses names or
conventions the table does not know, the tools silently answer with less: no MPN, no datasheet, no
test points.

This plan adds a mapping agent that ships with the plugin. A cheap deterministic check decides
whether a design looks under-mapped. If it does, the plugin runs a small OpenCode subagent that
looks at a compact profile of the design and proposes mapping rules. The plugin validates the
proposal against the data, stores it as an overlay next to (never inside) the original export, and
applies it every time the design loads.

## 1. What "mapped" means

The plugin needs a fixed set of canonical fields and features. These are the targets the agent maps
to; nothing else.

| Target | Kind | Used by | Today |
|---|---|---|---|
| `value` | field | every summary line, `odb_search` | aliases `Value`, `Val`, `Comment` |
| `mpn` | field | summaries, `odb_search`, BOM (planned) | 12 aliases, generic `Part Number`/`PN` last |
| `datasheet` | field | `odb_datasheet` | 5 aliases, `https://` preferred |
| `description` | field | `odb_component`, `odb_search` | `Description`, `Desc` |
| `manufacturer` | field | BOM (planned), MPN disambiguation | not mapped yet |
| `testPoint` | feature (per component) | `odb_testpoints`, test coverage (planned) | `TP<n>` refdes or `TP`/`TestPoint` in package/part/value, ≤ 2 pins |
| `rail` | feature (per net) | path search, summaries | `RAIL_NAME` regex or fanout > 40 |
| `mechanical` | feature (per component) | excluded from BOM and coverage counts | not mapped yet |

A canonical field can be filled from a component property, from the ODB++ part name (Altium writes
the component Comment there), or, as a last resort, inferred by the agent from other data on the
same component. Each source is recorded, so tools can say where a value came from.

Adding a canonical target later means extending this table, the output schema (section 6) and the
system prompt together; the version fields in section 4 make old cache entries re-run.

## 2. Gaps in the data we have

| Design | Source | What goes wrong today |
|---|---|---|
| `testdata/jetson-orin-baseboard.tgz` | KiCad 9 | Nothing important. 293 parts with `Value`, `MPN`, `Datasheet`, `Description`, `Manufacturer`; 48 `TP<n>` test points; `FID`/`H` parts without pins. This is the "healthy" reference and must not trigger the agent. |
| `testdata/altium.pixhawk-fmuv3.tgz` | Altium 20.1 | No `PRP` records at all. The part name holds the Comment (`220R`, `BQ24313`, `PMEG2005CT`), but `value()` only reads properties, so summaries show no value and no MPN. The 9 test pads are named `FMU-SWCLK`, `IO-SWDIO`, `5v`, `RX5`, `TX5` with part `PAD.04`, so `odb_testpoints` finds none. Refdes like `U$2`, `U$9001` have no standard prefix. |
| Pixhawk schematic (issue #4) | Altium params | `PARTNO` and `3DR_PARTNO` (internal numbers), `MFGPN` (real MPN), `DATASHEET`, `Supplier 1`, `Supplier Part Number 1` (distributor number, not an MPN). Once these reach a `PRP` record, `PARTNO` is unmapped and `Supplier Part Number 1` is a trap. |
| UW Robotics / CERN Altium libraries (aliases) | Altium params | Several MPN-like fields per part; the generic `Part Number` sometimes holds an internal number. |
| Pulsonix (issue #4, no export yet) | Pulsonix | Attribute names unknown. This is exactly the case the agent is for. |

So the agent has three jobs: map unknown property names to fields, use the part name when there
are no properties, and classify components and nets the fixed conventions miss.

## 3. When to launch the agent

### 3.1 Mapping health check

After `BoardIndex.build`, a pure function `mappingHealth(index, mapping)` computes a report. It
takes milliseconds and runs on every load. It only looks at **eligible components**: at least one
pin on a real net (excludes fiducials, mounting holes, logos and `$NONE$`-only parts), not already
classified as `mechanical`.

Signals, each with a strength:

| # | Signal | Rule | Strength |
|---|---|---|---|
| S1 | Unmapped property that looks like a field | A property name not covered by an alias, the ignore list (`Author`, `License`, `Tolerance`, `Voltage`, …) or the cached mapping, present on ≥ 10 % of eligible parts (min. 5), whose sampled values match a field's shape in ≥ 60 % of cases (shapes below), while that field's coverage is < 90 %. | strong |
| S2 | Field coverage low with a usable part name | `value` coverage < 70 % of eligible parts, or `mpn` < 50 % of eligible non-passive parts, and the part name is set and differs from the package name on ≥ 50 % of the uncovered parts. | strong |
| S3 | Test point gap | No test points by the current rule, and ≥ 3 eligible parts with ≤ 2 pins whose refdes prefix is not a known component class (R, C, L, D, Q, U, J, P, X, Y, F, FB, LED, RN, SW, S, K, T, BT, TP, …). Also fires when test points exist but such orphan small parts are ≥ 5. | strong |
| S4 | Unclassified refdes | ≥ 3 % of eligible parts (min. 3) have a refdes prefix outside the known class table (`U$`, `IO-`, `FMU-`, a bare `5v`). | weak |
| S5 | Suspicious MPN source | ≥ 30 % of the chosen MPN values come from a generic alias (`Part Number`, `PN`) and fail the MPN shape, e.g. all digits (`100-0042`), equal to `value` on passives, or a distributor pattern (`…-ND`, `…-1-ND`, `511-…`, `C123456`). | strong |
| S6 | Rail gap | A net with fanout ≥ 20 where ≥ 60 % of the other pins are on 2-pin capacitors, not matching `RAIL_NAME`. | weak |
| S7 | Placeholder values | ≥ 20 % of a field's values are placeholders (`~`, `-`, `NA`, `TBD`, `DNP`, empty after trim). | weak |

Value shapes (deliberately loose, they only rank candidates for the agent):

- `mpn`: 4–40 chars, no spaces, letters and digits both present, not a URL, not a passive value.
- `value`: passive value (`10k`, `4k7`, `100nF`, `0u1`, `220R`, `10u/25V`) or the part name.
- `datasheet`: `https?://`, `www.`, or a path ending in `.pdf`.
- `description`: ≥ 3 words.
- `manufacturer`: matches a short built-in list of manufacturer names, or repeats across many parts with ≤ 3 words.

### 3.2 Decision

Launch when **any strong signal or at least two weak signals** fire, **and** none of these hold:

- The cache (section 4) has an entry for this design fingerprint and the current
  `heuristicVersion`. An entry exists after every completed run, including runs that concluded the
  data is simply not there (`unresolved`, section 6). This is what stops the agent from re-running
  on a board like the Pixhawk export, where MPNs are genuinely absent.
- Auto repair is off (`mappingAgent: "off"` plugin option / `ODB_MAPPING_AGENT=off`).
- The design has fewer than 5 eligible components.
- A run for this fingerprint is already in flight (one run per design per process).

Expected results on the test boards (these become unit tests):

| Design | Signals | Launch |
|---|---|---|
| Jetson (KiCad) | none | no |
| Pixhawk (Altium) | S2 (no value, no MPN, part names set), S3 (9 `PAD.04` pads), S4 (`U$`, `IO-`, `FMU-`) | yes |
| Pixhawk with schematic params | S1 (`PARTNO`), S5 if `Supplier Part Number 1` wins, S3, S4 | yes |

### 3.3 Timing

The agent never blocks plain connectivity queries.

1. `DesignStore.get()` builds the index, loads the cached overlay, computes health. If the decision
   says launch, it starts the run in the background and returns the index with the base mapping.
2. Tools that depend on a gapped target wait for the run, up to `mappingWaitMs` (default 60 s):
   `odb_testpoints` when S3 fired, `odb_datasheet` when `datasheet` is gapped, `odb_search` when the
   query looks like an MPN. Everything else answers immediately and appends one line:
   `note: property mapping for this design is being repaired; values may be incomplete.`
3. When the run finishes, the store swaps in a new `BoardIndex` view with the overlay applied (the
   parsed netlist is reused; only properties and classifications change).
4. A new tool `odb_mapping` shows the health report and the active overlay, and takes
   `action: "repair"` to force a run (ignores the cache), or `action: "reset"` to drop the overlay.

## 4. Caching without touching the original data

The ODB++ archive is never modified, and neither is the extracted scratch copy. The mapping lives
in a separate overlay file that is applied in memory after parsing.

### 4.1 Layers

Highest priority last:

1. **Built-in rules**: `src/aliases.ts`, the test point and rail conventions in `src/board.ts`.
2. **Learned conventions** (global, per user): property-name rules the agent found that are not
   design specific, e.g. `PARTNO -> mpn: no (internal)`, `MFGPN -> mpn`. Applied to every design,
   so the second Pulsonix board does not need a run. Only rules of kind `propertyAlias` and
   `ignoreProperty` with confidence `high` are promoted here.
3. **Design overlay** (per design revision): everything the agent proposed and the validator
   accepted for this design.
4. **User overrides** (per design, hand-written): same format as the overlay, never written by
   the agent. Wins over everything, and the agent sees it as fixed input.

### 4.2 Keys and files

- **Fingerprint**: SHA-256 of the archive bytes (not path or mtime, so a renamed or copied archive
  keeps its mapping and a re-export with identical content too). Computed once while making the
  scratch copy, which already reads the whole file.
- **Versions** stored in every entry: `schemaVersion` (overlay format), `heuristicVersion`
  (health check rules), `promptVersion` (system prompt). A changed `schemaVersion` drops the entry;
  a changed `heuristicVersion` or `promptVersion` keeps applying it but allows a new run if the
  health check still fires.

```
$ODB_CACHE_DIR/                          default ~/.cache/opencode-odbplusplus
  boards/<key>/…                         existing scratch copies
  mappings/
    designs/<fingerprint>.json           design overlay (agent output after validation)
    conventions.json                     learned conventions (layer 2)
    runs/<fingerprint>/<timestamp>.json  agent input, raw output, validation report (debugging)
<designsDir>/<stem>.mapping.json         optional user overrides (layer 4), committed with the design
```

User overrides sit next to the archive because they are design knowledge a team wants to commit
and review; the plugin only reads that file. The option `mappingDir` moves the design overlays into
the project too (e.g. `.opencode/odb-mappings/`) for teams that want to commit agent results.

### 4.3 Applying an overlay

Overlays are declarative rules, not a copy of the board, so they can be re-validated on every load
and survive small re-exports:

- `BoardIndex.build(board, name, mapping)` keeps `properties` exactly as parsed. Resolved fields
  live in a separate `resolved: Partial<Record<Field, { value, source }>>` per component, computed
  from the merged rules. `prop()` and the `value()`/`mpn()`/… accessors read `resolved`.
- `isTestPoint`, `isRail` and a new `isMechanical` consult the overlay's classifications before the
  built-in conventions.
- Rules referring to properties, refdes or nets that no longer exist are skipped and counted in the
  health report, which can then fire again for the new revision. When a design has a new
  fingerprint but an overlay for an earlier revision of the same file name exists, that overlay is
  passed to the agent as a hint (section 5.3) so the second run is cheap.

## 5. The agent

### 5.1 Integration with OpenCode

The plugin already receives `client` (the OpenCode SDK) in `PluginInput`. No extra server or
process is involved.

- **Registration.** The plugin's `config` hook adds a subagent:

  ```ts
  config.agent["odb-mapper"] = {
    mode: "subagent",
    description: "Maps ODB++ component properties and features to the fields the odb tools use. Started by the plugin.",
    prompt: MAPPER_SYSTEM_PROMPT,          // section 7, versioned as promptVersion
    model: options.mappingModel,           // default: OpenCode's small model, else the session model
    temperature: 0,
    maxSteps: 12,
    tools: { "*": false, odb_mapping_profile: true, odb_mapping_values: true, odb_component: true, odb_net: true, odb_mapping_submit: true },
    permission: { edit: "deny", bash: "deny", webfetch: "deny" },
  }
  ```

  The agent has no file, shell or web access. Everything it may look at goes through read-only
  plugin tools.

- **Run.** `client.session.create({ body: { parentID, title: "ODB++ mapping: <design>" } })`,
  then `client.session.prompt({ path: { id }, body: { agent: "odb-mapper", parts: [{ type: "text", text: inputJson }] } })`.
  `parentID` is the session whose tool call triggered the load, so the run shows up as a child
  session the user can open.
- **Structured output.** The agent must end by calling `odb_mapping_submit` with the output object
  (section 6). That tool's zod schema enforces the shape; its `execute` runs the validator and
  returns the rejected items with reasons. The agent may correct and resubmit (at most 3 submits).
  The run resolves on the first submit with no rejected items, after the third submit, or on
  timeout (`mappingTimeoutMs`, default 180 s); whatever was accepted by then is kept.
- **Budget.** The input is a profile, not the board: about 3–8 k tokens for a 700-part design
  (section 6.1 caps every list). Drill-down tools cap their output the same way.

### 5.2 Agent tools

| Tool | Purpose |
|---|---|
| `odb_mapping_profile` | Returns the input object again, optionally one section only. For long runs after compaction. |
| `odb_mapping_values` | All distinct values of one property name, or of `part`/`package`, optionally for one refdes prefix, with counts and up to 3 refdes each. Capped at 200 values. |
| `odb_component`, `odb_net` | The existing tools, for checking one test point candidate or rail. |
| `odb_mapping_submit` | Final answer (section 6.2). |

### 5.3 Validation of the output

The plugin trusts nothing the agent says without checking it against the parsed data:

- Every property name in a rule must exist on the board (after normalization).
- Every refdes and net must exist. Every regex must compile, must not match more than 30 % of
  eligible parts for `testPoint`, and must match at least one part.
- A test point must have ≤ 2 pins (≤ 4 with an explicit reason) and at least one real net.
- A `componentValue` with `source.kind` `property` or `partName` must equal (after trim) or be a
  substring of that property or the part name on that component. Values with `source.kind:
  "inferred"` are allowed only for `value` and `mpn`, must have `confidence` `low` or `medium`, and
  are marked as inferred wherever a tool prints them (`mpn: BQ24313 (inferred from part name)`).
- A `datasheet` value must be an `https?://` URL. The agent may not invent URLs; `inferred` is not
  allowed for `datasheet`.
- Rules that conflict with user overrides are dropped.
- Rejected items are returned to the agent (and stored in `runs/`), never applied.

After applying, the plugin recomputes the health report and stores before/after coverage with the
overlay.

## 6. Input and output schema

TypeScript types; the zod schemas in `src/mapping/schema.ts` mirror them.

### 6.1 Input (`MappingInput`)

```ts
type Field = "value" | "mpn" | "datasheet" | "description" | "manufacturer"

interface MappingInput {
  schemaVersion: 1
  design: {
    name: string                    // archive stem
    fingerprint: string             // first 16 hex chars of the SHA-256
    producer?: string               // from misc/info if present, e.g. "KiCad 9.0", else a guess: "Altium (no misc/info)"
    components: number              // all
    eligibleComponents: number      // see 3.1
    nets: number
  }
  targets: {                         // the canonical model from section 1, with definitions
    fields: Record<Field, { meaning: string; shape: string }>
    features: Record<"testPoint" | "rail" | "mechanical", { meaning: string }>
  }
  currentMapping: {
    aliases: Record<Field, string[]>          // built-in + learned + overlay, in priority order
    ignoredProperties: string[]
    coverage: Record<Field, { mapped: number; of: number; sources: Record<string, number> }>
    testPoints: { count: number; sample: string[] }   // ≤ 10 refdes
    rails: { count: number; sample: string[] }         // ≤ 15 net names
  }
  gaps: Array<{
    signal: "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7"
    target: Field | "testPoint" | "rail" | "mechanical"
    summary: string                 // one sentence, e.g. "mpn set on 0 of 158 eligible parts"
    candidates?: string[]           // property names, refdes or nets the check flagged
  }>
  properties: Array<{               // every property name on the board, ≤ 60 rows, most frequent first
    name: string
    count: number                   // components carrying it with a non-empty value
    distinct: number
    mappedTo?: Field | "ignored"
    shapeHits: Partial<Record<Field, number>>   // share 0..1 of sampled values matching each shape
    samples: Array<{ refDes: string; value: string }>   // ≤ 6, spread over refdes prefixes, values cut at 80 chars
  }>
  partNames: {                      // the ODB++ part name (Altium: Comment)
    set: number
    equalsPackage: number
    samples: Array<{ refDes: string; part: string; package?: string }>   // ≤ 15, spread over prefixes
  }
  refdesClasses: Array<{            // grouped by refdes prefix (letters and symbols before the first digit, or the whole refdes)
    prefix: string
    count: number
    pins: [min: number, max: number]
    known: boolean                  // in the built-in class table
    samples: Array<{ refDes: string; part?: string; package?: string; nets: string[] }>  // ≤ 4, nets ≤ 3
  }>
  smallPartCandidates: Array<{      // ≤ 2-pin parts with unknown prefix or test-point-like names, ≤ 40
    refDes: string; part?: string; package?: string; side?: string; nets: string[]
  }>
  railCandidates: Array<{ net: string; pins: number; capacitorShare: number }>   // ≤ 20
  previousMapping?: MappingOutput   // overlay of an earlier revision of the same design, if any
  userOverrides?: MappingOutput     // fixed, must not be contradicted
}
```

Excerpt for the Pixhawk export (values from `testdata/altium.pixhawk-fmuv3.tgz`):

```json
{
  "design": { "name": "altium.pixhawk-fmuv3", "producer": "Altium (no misc/info)", "components": 166, "eligibleComponents": 166, "nets": 249 },
  "gaps": [
    { "signal": "S2", "target": "value", "summary": "value set on 0 of 166 eligible parts; part name set on 166" },
    { "signal": "S2", "target": "mpn", "summary": "mpn set on 0 of 33 eligible non-passive parts" },
    { "signal": "S3", "target": "testPoint", "summary": "no test points; 9 parts with at most two pins with unknown prefixes",
      "candidates": ["FMU-SWCLK", "FMU-SWDIO", "FMU-VDD_3V3", "IO-SWCLK", "IO-SWDIO", "IO-VDD_3V3", "5v", "RX5", "TX5"] },
    { "signal": "S4", "target": "mechanical", "summary": "prefixes U$, IO-, FMU-, M3_MOUNT not in the class table (mounting holes have a pin on a net, so they count as eligible)" }
  ],
  "properties": [],
  "partNames": { "set": 166, "equalsPackage": 0, "samples": [
    { "refDes": "R1022", "part": "220R" }, { "refDes": "U10001", "part": "BQ24313" },
    { "refDes": "D10001", "part": "PMEG2005CT" }, { "refDes": "C10001", "part": "10u/25V" },
    { "refDes": "FMU-SWCLK", "part": "PAD.04" }, { "refDes": "U$2", "part": "DF40C-20-DS" } ] }
}
```

(Counts in this excerpt are illustrative; the real ones come from the health check.)

### 6.2 Output (`MappingOutput`, the `odb_mapping_submit` argument)

```ts
type Confidence = "high" | "medium" | "low"

interface Evidence {
  // What the agent looked at, in a form the validator can re-check.
  refDes?: string[]                 // ≤ 5 examples
  note: string                      // one sentence, English
}

interface MappingOutput {
  schemaVersion: 1
  rules: Array<
    | { kind: "propertyAlias"; field: Field; property: string; priority: "before" | "after"; relativeTo?: string;
        scope?: { refdesPrefixes?: string[] }; confidence: Confidence; evidence: Evidence }
        // property -> field; priority places it relative to an existing alias (default: after all)
    | { kind: "ignoreProperty"; property: string; reason: "internal-number" | "distributor-number" | "unrelated" | "placeholder";
        confidence: Confidence; evidence: Evidence }
        // e.g. PARTNO, 3DR_PARTNO, Supplier Part Number 1 must never be read as mpn
    | { kind: "partNameAs"; field: "value" | "mpn"; scope: { refdesPrefixes?: string[]; refdes?: string[] };
        confidence: Confidence; evidence: Evidence }
        // use the ODB++ part name as the field for these parts when no property provides it
    | { kind: "componentValue"; refDes: string; field: Field; value: string;
        source: { kind: "property"; property: string } | { kind: "partName" } | { kind: "inferred" };
        confidence: Confidence; evidence: Evidence }
        // single-part fixes; keep these rare, prefer rules
    | { kind: "classify"; feature: "testPoint" | "mechanical"; value: boolean;
        match: { refdes?: string[]; refdesPattern?: string; part?: string[]; package?: string[] };
        confidence: Confidence; evidence: Evidence }
    | { kind: "rail"; nets: string[]; value: boolean; confidence: Confidence; evidence: Evidence }
  >
  unresolved: Array<{
    target: Field | "testPoint" | "rail" | "mechanical"
    reason: "absent-in-export" | "ambiguous" | "needs-user"
    detail: string                  // e.g. "No property or part name carries manufacturer part numbers for passives."
    suggestion?: string             // what the user could change in the EDA export, one sentence
  }>
  summary: string                   // ≤ 3 sentences for the user, English
}
```

Example output for the Pixhawk export:

```json
{
  "schemaVersion": 1,
  "rules": [
    { "kind": "partNameAs", "field": "value", "scope": { "refdesPrefixes": ["R", "C", "L", "RN", "F", "LED"] }, "confidence": "high",
      "evidence": { "refDes": ["R1022", "C10001", "RN2002"], "note": "Altium writes the Comment as part name; on passives it is the value (220R, 10u/25V, 10K/0.1%)." } },
    { "kind": "partNameAs", "field": "mpn", "scope": { "refdesPrefixes": ["U", "D", "Q", "X"] }, "confidence": "medium",
      "evidence": { "refDes": ["U10001", "D10001"], "note": "Part names on ICs and diodes are orderable part numbers (BQ24313, PMEG2005CT)." } },
    { "kind": "classify", "feature": "testPoint", "value": true,
      "match": { "part": ["PAD.04"] }, "confidence": "high",
      "evidence": { "refDes": ["FMU-SWCLK", "IO-SWDIO", "TX5"], "note": "One-pad PAD.04 parts named after the signal they expose (SWD, UART, supply)." } },
    { "kind": "classify", "feature": "mechanical", "value": true,
      "match": { "part": ["MOUNT-HOLE1.8MM"] }, "confidence": "high",
      "evidence": { "refDes": ["M3_MOUNT1001", "M3_MOUNT1003"], "note": "MOUNT-HOLE1.8MM parts with one plated pad; they carry a net but no electrical function." } }
  ],
  "unresolved": [
    { "target": "datasheet", "reason": "absent-in-export", "detail": "The export has no component properties.",
      "suggestion": "Push the schematic parameters to the PCB before exporting (docs/altium-export.md, step 3)." },
    { "target": "mpn", "reason": "absent-in-export", "detail": "Passives only carry their value, no part number." }
  ],
  "summary": "Values now come from the part name, MPNs for ICs and diodes are taken from the part name (inferred), and the 9 PAD.04 pads are test points. Datasheets and passive MPNs are not in this export."
}
```

`U$2`/`U$9001` stay components (connectors `DF40C-20-DS`, `CON-DF17-80F`); the agent leaves them
alone because nothing is missing for them except a standard prefix. S4 is informational there.

## 7. System prompt

Versioned as `promptVersion` in `src/mapping/prompt.ts`. The input JSON follows it as the first
user message.

```text
You map component data of one PCB design, exported as ODB++, to the fields and features a set of
PCB inspection tools uses. You do not answer questions about the design. You produce mapping rules
and submit them with the odb_mapping_submit tool. That call is your only output.

## What you are given
The user message is a JSON profile of the design: how many components and nets it has, which
property names occur with sample values, the ODB++ part names, refdes prefix groups, small parts
that might be test points, nets that might be power rails, the current mapping with its coverage,
and the gaps an automatic check found. The profile is a sample. Use odb_mapping_values to see all
values of a property, part name or package, and odb_component or odb_net to look at single parts
or nets before you decide on a rule.

## Targets
Fields, per component:
- value: the electrical value of a passive (10k, 4k7, 100nF, 0u1, 10u/25V) or, for any other part,
  the short name a schematic shows (STM32F427VIT6, BQ24313, DF40C-20-DS).
- mpn: the manufacturer's orderable part number. Not an internal company number, not a distributor
  or supplier number (Digi-Key "...-ND", Mouser "511-...", LCSC "C123456"), not a value.
- datasheet: a web URL to the datasheet. Network paths and local files do not count.
- description: a human-readable description of the part.
- manufacturer: the manufacturer's name.
Features:
- testPoint: a pad or part that exists so a probe, pogo pin or fixture can touch a net. Usually
  one or two pads, one net, often named after the signal (SWCLK, TX5, 5V) or TP<n>.
- mechanical: a part with no electrical function: mounting holes, fiducials, logos, standoffs.
- rail: a power or ground net.

## How to work
1. Read the gaps first. They tell you what is missing. Do not touch targets that are fine.
2. Prefer rules over single-part fixes. One propertyAlias, partNameAs or classify rule that covers
   a whole group is better than many componentValue entries. Use componentValue only for a few
   exceptions.
3. Every rule must be backed by data you saw. Put up to five refdes you checked into evidence and
   say in one sentence why the rule is right. The tools re-check every rule against the data and
   reject what does not hold.
4. Never invent data. A datasheet URL, a manufacturer or an MPN that does not appear in the design
   must not be submitted. The only exception: when a part name is clearly an orderable part
   number of an IC, diode, transistor, crystal or connector, you may map it to mpn with partNameAs
   or componentValue source "inferred", and confidence at most "medium".
5. When several properties could fill a field, pick the most specific one first and say which
   ones must be ignored. Internal numbers (PARTNO, company part numbers, all digits) and
   distributor numbers get an ignoreProperty rule so they are never read as mpn.
6. Test points: classify by a precise match (refdes list, refdes pattern, part or package names).
   A pattern must not catch resistors, capacitors, LEDs or connectors. Check at least two
   candidates with odb_component before submitting.
7. If a target cannot be filled from this export, add it to unresolved with reason
   "absent-in-export" and, if you can, one sentence on what to change in the EDA export. Do not
   guess to fill it. Unresolved entries prevent the check from starting you again for nothing.
8. Respect userOverrides; they are fixed. previousMapping is a mapping for an earlier revision of
   this design: reuse its rules where the data still supports them.
9. Submit once with everything. If the submit result lists rejected items, fix or drop exactly
   those and submit again. You have at most three submits.

Write evidence notes, unresolved details and the summary in plain English. The summary is at most
three sentences and is shown to the user: say what is now mapped and what the export lacks.
```

## 8. Implementation outline

| File | Change |
|---|---|
| `src/mapping/schema.ts` | zod schemas for `MappingInput`, `MappingOutput`; `schemaVersion` |
| `src/mapping/health.ts` | eligibility, value shapes, signals S1–S7, decision; `heuristicVersion` |
| `src/mapping/profile.ts` | builds `MappingInput` from a `BoardIndex` and the health report, with the caps from 6.1 |
| `src/mapping/validate.ts` | checks from 5.3, returns accepted rules and rejections |
| `src/mapping/overlay.ts` | layer merge (4.1), cache files (4.2), apply (4.3) |
| `src/mapping/agent.ts` | subagent config, session create/prompt, submit wait, timeout, run log |
| `src/mapping/prompt.ts` | system prompt (section 7), `promptVersion` |
| `src/aliases.ts` | add `manufacturer`, an ignore list, the refdes class table |
| `src/board.ts` | `resolved` fields, overlay-aware `isTestPoint`/`isRail`/`isMechanical`; raw `properties` unchanged |
| `src/store.ts` | content fingerprint, overlay load, background run, wait for gapped tools |
| `src/tools.ts` | `odb_mapping` (health/overlay/repair/reset), agent-only tools, the "being repaired" note |
| `src/index.ts` | `config` hook registering `odb-mapper`; options `mappingAgent`, `mappingModel`, `mappingDir`, `mappingWaitMs`, `mappingTimeoutMs` |
| `src/format.ts` | mark inferred values; show value source in `odb_component` |

Tests (no model needed except the last):

- Health check: Jetson fires nothing; Pixhawk fires S2, S3, S4; a synthetic board with `PARTNO`,
  `MFGPN`, `Supplier Part Number 1` fires S1 and, with `Part Number` holding digits, S5.
- Validator: rejects unknown properties and refdes, over-broad test point patterns, invented
  datasheet URLs, `inferred` with `high` confidence, values not found in their cited source.
- Overlay: applying the Pixhawk example output yields 9 test points, values on all passives, MPN
  on ICs marked inferred; original `properties` and the archive bytes are unchanged.
- Cache: same fingerprint and versions skip the run; a `heuristicVersion` bump re-runs only while
  signals still fire; an `unresolved`-only result prevents relaunch.
- Agent (integration, opt-in with `ODB_MAPPING_E2E=1`): one real run against the Pixhawk export
  through a local OpenCode server; asserts the submit validates and the test point gap closes.

## 9. Open points

- Default model: OpenCode's small model keeps it cheap but may be weak at telling MPNs from
  internal numbers. Plan: small model by default, configurable, and judge on the Pixhawk and the
  first Pulsonix export (issue #4).
- Promoting learned conventions across designs (4.1, layer 2) is the part most likely to spread a
  wrong rule. Only `high` confidence property rules are promoted, and `odb_mapping action: "reset"`
  should offer to clear them too.
- Pin names and functions (docs/PLAN.md, phase 1) are a related gap the same agent could fill from
  datasheets later. Out of scope here; the schema leaves room for a `pinName` target.
