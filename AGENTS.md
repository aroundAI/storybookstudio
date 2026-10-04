# Agent Notes

- The product/app is called StorybookStudio, in user-facing text, MCP metadata, identifiers, docs and chat. The upstream editor's names appear only in `LICENSE`, the Open-source licenses notice (`electron/studio/licenses/NOTICE.txt`), `docs/UPSTREAM.md` and `src/studio/legacyNames.json`, which the one-time migrations read; `tests/studio/no-upstream-names.test.mjs` enforces it.
- Read `docs/AI_PROJECT_CONTEXT.md` before substantial implementation work.
- Read `docs/AI_CURRENT_HANDOFF.md` for the current branch, migration, and verification state.
- Read `docs/AI_RELEASE_HANDOFF.md` before commits, tags, releases, or GitHub Actions work.
- StorybookStudio is a creator-facing desktop video editor. Preserve simple guided workflows; do not turn routine product surfaces into ComfyUI-style node configuration.
- Keep project files portable. Store project-owned media paths relative to the project when possible and preserve legacy project compatibility.
- Treat generation and editing as separate layers: editing, captions, and export must not require ComfyUI unless the specific feature is explicitly a ComfyUI workflow.
- Agent write actions should inspect first, preview when supported, and use StorybookStudio's existing undo/checkpoint paths.
- Keep changes narrowly scoped and test risky behavior at the renderer, Electron IPC, and packaged-platform boundaries it touches.
