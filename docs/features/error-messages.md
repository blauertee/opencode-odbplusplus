# Error messages from failed tool calls

When a tool throws, OpenCode marks the call as failed and keeps the error text on the tool part. In the
TUI the row turns red and only says that it failed; clicking the row expands the error text. `opencode
run` prints it after `✗ <tool> failed`, and `opencode export <sessionID>` has it in the part's
`state.error`. OpenCode's own log (`~/.local/share/opencode/log/`, or `--print-logs`) does not record tool
errors, so the error text is the place to look.

## What the plugin puts in it

- Library missing: `<path> not found. Build it with native/build.sh or point ODBPP_LIB at it.`
- Library present but not loadable (a shared library it links against is missing, wrong architecture):
  Bun's `Failed to open library "<path>": <dlerror text>`.
- No or ambiguous design: the designs directory and the archives that are there.
- Parse failure: `OdbDesign failed on <archive>: <reason>`, followed by `OdbDesign output:` and the last
  lines OdbDesign and libarchive wrote to stderr while parsing (at most about 2000 characters).

The last point needs `native/odbpp.cpp`: OdbDesign only says *why* a parse failed on stderr (its logger
thread, and libarchive via `fprintf`), then throws a generic "could not extract or parse ODB++ archive".
Inside OpenCode nobody sees that stderr. `odbpp_load_board` therefore redirects file descriptor 2 to a
temporary file while it parses. When it is done it logs a marker through the OdbDesign logger and waits
(up to about 1 s) until the marker shows up, since the logger writes from a background thread. It then
restores stderr, writes the captured text through to the real stderr (so nothing is lost on success
either), and on failure appends its tail to `odbpp_last_error()`.

Anything else in the process that writes to stderr during those ~1 s lands in the same capture and is
passed on afterwards, slightly late.

## ODB_DEBUG

`ODB_DEBUG=1` (any non-empty value except `0`) lowers OdbDesign's log level from Error to Debug, so a
parse failure carries the extraction and parsing steps leading up to it. It is read once, when the first
board is loaded, so OpenCode has to be restarted for a change to apply.

Changes to `native/odbpp.cpp` need `bun run build:native` again.
