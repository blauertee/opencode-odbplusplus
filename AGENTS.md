# Notes for agents

- Before merging a PR that adds or changes a feature, put its doc in `docs/features/<feature>.md`
  and make it describe what is implemented, not what was planned.

## Verification

- OpenCode can run in the container: `npm i opencode-ai` in a scratch dir, then from the repo run
  `opencode debug config` and `opencode debug agent <name>` to check the plugin's agents, tools and
  permissions as OpenCode resolves them. No model is needed for that.
