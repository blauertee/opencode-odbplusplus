# opencode-odbplusplus

Tools and skills to inspect schematics for LLM agents.

OpenCode-Plugin, das Leiterplatten-Designs im ODB++-Format (Export aus KiCad, Altium, Pulsonix, …)
als Toolcalls abfragbar macht: Verbindungen eines Bauteils, alles an einem Netz, Signalketten
zwischen zwei Bauteilen, Suche, Datenblatt-Kapitel. Geparst wird mit
[OdbDesign](https://github.com/nam20485/OdbDesign), das als eigener Server läuft.

Plan und Hintergründe: [docs/PLAN.md](docs/PLAN.md).

## Schnellstart

```bash
# 1. OdbDesignServer bauen und starten (Port 8888), Testboard bereitstellen
cp testdata/jetson-orin-baseboard.tgz designs/
docker compose -f server/compose.yml up -d --build

# 2. Plugin-Abhängigkeiten
bun install
```

In OpenCode einbinden, z. B. in einem Projekt unter `.opencode/plugins/odbplusplus.ts`:

```ts
export { OdbPlusPlusPlugin } from "/pfad/zu/opencode-odbplusplus/src/index.ts"
```

Dieses Repo bringt das schon mit: OpenCode im Repo-Verzeichnis starten genügt.

Konfiguration über Umgebungsvariablen:

| Variable | Default | |
|---|---|---|
| `ODB_SERVER_URL` | `http://localhost:8888` | OdbDesignServer |
| `ODB_SERVER_USERNAME` / `ODB_SERVER_PASSWORD` | – | falls der Server Basic Auth erzwingt |
| `ODB_DESIGN` | – | Standard-Design, sonst das einzige auf dem Server |
| `ODB_CACHE_DIR` | `~/.cache/opencode-odbplusplus/datasheets` | Datenblatt-Cache |

`odb_datasheet` braucht `pdftotext` (Paket `poppler-utils`).

## Tools

| Tool | Beispiel |
|---|---|
| `odb_designs` | Welche Designs gibt es? |
| `odb_component` | Alle Verbindungen von U35 |
| `odb_net` | Alles am +5V-Netz |
| `odb_signal_path` | Bauteile zwischen U34 und J1 |
| `odb_search` | Wo ist der TUSB1046? Welche Netze heißen `*I2C*`? |
| `odb_datasheet` | Description-Kapitel aus dem Datenblatt von U10 |

Beispielausgabe `odb_signal_path { from: "U34", to: "J1" }` auf dem Testboard:

```
1. U34 -[/Peripherals/GPIOEX_I2C_SCL]-> R216 -[SYS_SCL]-> R31 -[/M.2/M2_E_I2C_CLK]-> J1
2. U34 -[/Peripherals/GPIOEX_I2C_SDA]-> R215 -[SYS_SDA]-> R30 -[/M.2/M2_E_I2C_DAT]-> J1

## Components on the chain
R30 | R_0R_0402 | MPN ERJ2GE0R00X | pkg R_0402_1005Metric
...
```

## Entwicklung

```bash
bun test                                         # Unit-Tests
ODB_SERVER_URL=http://localhost:8888 bun test    # + Integrationstests gegen das Testboard
bun run typecheck
scripts/export-test-design.sh                    # Testboard neu aus KiCad exportieren (Docker)
```

## Lizenz

GPL-3.0 (siehe `LICENSE`). OdbDesign ist AGPL-3.0 und läuft als separater Prozess.
Das Testboard stammt von Antmicro (Apache-2.0, `testdata/jetson-orin-baseboard.LICENSE`).
