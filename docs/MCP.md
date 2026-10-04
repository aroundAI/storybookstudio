# Velorn MCP Guide

Velorn includes a local Model Context Protocol (MCP) server so AI agents can inspect and operate on the open Velorn project. It is designed for agents such as Codex, Claude Code, Cursor-compatible MCP clients, and other open source MCP clients that can talk to a local HTTP MCP server.

The MCP server is part of the desktop app. It exposes the current project, active timeline, assets, ComfyUI connection state, generation state, visual frame inspection, safe timeline edit actions, caption actions, export actions, and workflow setup helpers.

## Quick Start

1. Launch the Velorn desktop app.
2. Open a project. Some setup tools work without a project, but timeline and asset tools need one.
3. Open `Settings > Agents (MCP)`.
4. Confirm the server is `Running`.
5. Connect your MCP client to:

```text
http://127.0.0.1:19790/mcp
```

Every request needs `Authorization: Bearer <secret>`. The app generates a 32-byte secret on first run into `mcp-secret` in its user-data folder (macOS: `~/Library/Application Support/<app>/mcp-secret`). `Settings > Agents (MCP)` shows the ready-made commands with the secret masked; `Show` reveals them and `Copy` copies the real command.

For Claude Code:

```bash
claude mcp add --transport http storybookstudio http://127.0.0.1:19790/mcp --header "Authorization: Bearer <secret>"
```

For Codex, which reads the token from an environment variable at run time:

```bash
export STORYBOOKSTUDIO_MCP_TOKEN=<secret>   # in your shell profile
codex mcp add storybookstudio --url http://127.0.0.1:19790/mcp --bearer-token-env-var STORYBOOKSTUDIO_MCP_TOKEN
```

For clients that use an `.mcp.json` file:

```json
{
  "mcpServers": {
    "storybookstudio": {
      "type": "http",
      "url": "http://127.0.0.1:19790/mcp",
      "headers": { "Authorization": "Bearer ${STORYBOOKSTUDIO_MCP_TOKEN}" }
    }
  }
}
```

The repository root keeps this config for development; export `STORYBOOKSTUDIO_MCP_TOKEN` before starting the client.

### Two profiles: `agent` (the default) and `expert`

The same server and the same bearer serve two tool lists (FILM-2013):

| Profile | URL | Lists | For |
| --- | --- | --- | --- |
| `agent` (default) | `http://127.0.0.1:19790/mcp` or `/mcp?profile=agent` | the 18 `studio_*` capability tools ([below](#the-agent-profile-capability-tools)) | editing a StoryBook episode by intent: plan, preview as cards, apply into a version, explain |
| `expert` | `http://127.0.0.1:19790/mcp?profile=expert` | Velorn's tools (133 on fork main 438fdb9) plus the 6 `studio_*` lifecycle tools | everything Velorn can do, one primitive at a time |

The profile can also be sent as an `X-MCP-Profile: agent|expert` header; any other value is a `400`. Each profile refuses the other's tools. The bearer is required on both: a missing or wrong one is a `401` before the profile is read.

To connect Claude Code to the expert profile as well:

```bash
claude mcp add --transport http storybookstudio-expert "http://127.0.0.1:19790/mcp?profile=expert" --header "Authorization: Bearer <secret>"
```

## What Agents Can Do

Velorn MCP is useful for five broad workflows:

- Review an edit: inspect timelines, clips, visible shots, frame contact sheets, disabled clips, missing media, gaps, markers, transforms, and export readiness.
- Make safe editorial changes: move, trim, split, delete, enable/disable, label, retime, adjust audio, add transitions, manage tracks, and manage timelines.
- Build graphics and polish: add text, shapes, solids, adjustment clips, GLSL effects, keyframes, motion blur, dips to black, and clip styling.
- Drive generation: prepare Generate from the current timeline frame, queue approved generation batches, inspect bundled workflows, validate ComfyUI nodes, and place generated assets back into timelines.
- Deliver: set In/Out ranges, run H.264 delivery exports, run social delivery batches, export FCPXML, and inspect exported files.

The MCP server is not a replacement for the Velorn UI. It is a project-aware control layer for agents. The best results come from asking the agent to inspect first, show a preview plan, then apply only after approval.

## Safety Model

The server runs only on loopback:

```text
127.0.0.1:19790
```

Do not proxy or expose this port to a network. The server answers:

- `403` when the `Host` header, or an `Origin` header if present, is not loopback (`127.0.0.1`, `localhost`, `[::1]`, any port). This stops web pages and DNS-rebinding attacks from driving the editor.
- `401` when the `Authorization: Bearer <secret>` header is missing or wrong.

A local process that can read the user-data folder can still read the secret; the bearer keeps out everything that cannot.

Most write-capable tools support `previewOnly` and many default to preview mode. In preview mode the tool returns the planned operation and usually a suggested apply call. To apply, the agent calls the same tool again with:

```json
{ "previewOnly": false }
```

Recommended agent behavior:

1. Use read tools first.
2. Use `find_timeline_items` before targeting clips, markers, tracks, transitions, or assets from natural language.
3. Use `previewOnly: true` before write actions.
4. Ask for explicit user approval before applying changes that write files, queue generation, spend credits, start GPU work, change settings, or modify timelines.
5. Use `create_project_checkpoint` before risky multi-step edits.
6. Use `run_mcp_action_plan` for approved multi-step work so Velorn can checkpoint first and stop on the first error.

Undoable timeline changes use Velorn's normal undo stack. Project creation, project duplication, exports, generated assets, and imported media can write files to disk.

## A Good First Agent Prompt

After connecting your client, try:

```text
You are connected to Velorn. Call get_mcp_recipes, summarize what review and edit passes are available, then inspect the open project with get_project and get_timeline. Do not make changes yet.
```

For a timeline health pass:

```text
Review this Velorn timeline for delivery risks. Use analyze_timeline and check_media_health first. If you want to add markers, show me the add_timeline_markers previewOnly plan before applying anything.
```

For visual review:

```text
Inspect the next 20 visible shots from the playhead. Tell me what each shot shows and flag anything that looks off-story. Do not add markers until I approve a previewOnly marker plan.
```

For generation from the timeline:

```text
Use the selected clip or playhead frame as an image-to-video source. Preview the prepare_generation_from_timeline_context plan for LTX 2.3 first, then wait for my approval before opening Generate or queueing anything.
```

## Connection Details

Protocol:

- MCP over local HTTP.
- JSON-RPC endpoint: `POST http://127.0.0.1:19790/mcp`
- Server-sent-event probe: `GET http://127.0.0.1:19790/mcp`
- Authentication: `Authorization: Bearer <secret>` on every request (see Quick Start)
- Server name: `StorybookStudio`
- Profiles: `?profile=agent` (default) or `?profile=expert`, or the `X-MCP-Profile` header
- Default protocol version: `2024-11-05`

The server starts with the desktop app. If the port is not available, check `Settings > Agents (MCP)` for the current status/error.

Tools that can work without an open project include:

- `get_project`
- `list_recent_projects`
- `open_project`
- `create_project`
- ComfyUI connection/setup tools
- workflow inspection tools
- `list_glsl_effects`

Most timeline, asset, generation, caption, and export tools need an open project and an up-to-date project snapshot.

## Direct JSON-RPC Smoke Test

Most users should use an MCP client, but developers can test the server directly:

```bash
curl -s http://127.0.0.1:19790/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $STORYBOOKSTUDIO_MCP_TOKEN" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}"
```

Call a read-only tool:

```bash
curl -s http://127.0.0.1:19790/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $STORYBOOKSTUDIO_MCP_TOKEN" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_project\",\"arguments\":{}}}"
```

## The Agent Profile: Capability Tools

The model sees capability tools, not primitives. Each editing tool is an **intent compiler**: deterministic code (`src/studio/intents/`) that turns `(context, scope, params, policy)` into a `run_mcp_action_plan` plan with one reason per step. The model chooses the intent and the scope; the compiler chooses the primitives. The design is [AI_EDITOR_CONTRACT.md](AI_EDITOR_CONTRACT.md).

**Every capability tool previews by default.** An edit is always:

1. `studio_get_context` (once): the screenplay with dialogue text, the scene map, the policy, the brand, the timeline, versions, the clips the user edited by hand since the last AI plan, the last QA result.
2. `studio_edit {intent, scope, params}`: nothing changes. The compiler runs its reads (for example `get_audio_analysis` on the scene's dialogue), every step goes through its own primitive's `previewOnly` path, and the answer carries plan cards, a draft explain-why report and a `planId`. The cards also reach the AI panel as `studio:plan-proposed`.
3. Show the user the cards. A card lists anything under `touchesYourEdits`: a plan never changes a clip the user edited since the last plan unless `params.includeUserEdits` is true, and then it says so.
4. `studio_edit {same intent, scope, params, previewOnly: false, planId}` after approval: the compiler runs again on the current timeline; if it changed since the preview the answer is `TARGET_CHANGED` and nothing is applied. Otherwise a version is created (its snapshot is the timeline before the plan), the steps run through `run_mcp_action_plan` with a checkpoint first, each applied step is one line in `edits/oplog.jsonl` with its reason, scene and the plan's session, and the explain-why report is written to `edits/reports/<versionId>.json`.
5. `studio_restore_version {versionId}` undoes the whole plan.

A plan card:

```json
{
  "scene": 3,
  "heading": "INT. RESEARCH LAB - NIGHT (3)",
  "durationBefore": 21,
  "durationAfter": 13.917,
  "targetDuration": 12,
  "changes": [{ "text": "Cut 1.4 s of silence at 0:44.0 (S3.1 / S3.2)", "reason": "Dead air of 1.4 s between line 18 and line 19; pauses over 0.6 s are cut; toward the 12.0 s target", "tool": "extract_range", "step": 5 }],
  "touchesYourEdits": [],
  "notes": ["Scene 3: 21.0 s -> 13.9 s; the 12.0 s target is not reached without cutting dialogue: 8 lines run 12.7 s and the pauses left are under the 0.6 s limit"]
}
```

The card with `scene: null` is the whole timeline (caption re-timing, beds, markers).

### Tools

| Tool | Profiles | Does | Status |
| --- | --- | --- | --- |
| `studio_get_context` | agent | Script, scene map, policy, brand, timeline summary, versions, user edits, last QA. `{scope?}` | built |
| `studio_search_assets` | agent | Ranks assets by name, transcript and semantic fields. `{query, role?, scene?, durationRange?, limit?}` | built |
| `studio_edit` | agent | Intent → plan cards → apply into a version. `{intent, scope?, params?, previewOnly?, planId?, autoRepair?}` | built |
| `studio_edit_audio` | agent | `balance`, `duck`, `normalize`, `fade` over the buses, same preview/apply flow | built: FILM-2016's `intents/audio.js` compiles, FILM-2013 previews and applies; `balance` and `normalize` need measured loudness |
| `studio_add_captions` | agent | Brand-styled captions inside the aspect's safe area. `{language, style?}` | built over FILM-2016's `intents/captions.js`; styles the cues on the language's captions clip (a StoryBook rough cut has them); with none, transcribe first |
| `studio_add_graphic` | agent | Brand graphics | not available yet (FILM-2018) |
| `studio_create_variant` | agent | `short` (a 9:16 cut of a shorts candidate, the strongest line or a range, reframed on the subject, captions in the 9:16 safe area) and `hook` (N five-second openings, each exported) variants | built (FILM-2017); `language` is FILM-2019 |
| `studio_review` | agent | QA, then the critic | not available yet (FILM-2014) |
| `studio_repair` | agent | One plan for QA issues, previewed and applied like `studio_edit` | compiled by FILM-2014's `intents/repair.js` when the build has it, else not available yet |
| `studio_render_preview` | agent | Preview render and QA | not available yet (FILM-2014) |
| `studio_check_updates` | agent | Has the episode changed in StoryBook? Proposes a replacement plan | built over FILM-2011's re-sync |
| `studio_apply_updates` | agent | Previews and applies that plan into a "Sync from StoryBook" version; a regenerated shot's old sound is removed; `TARGET_CHANGED` when StoryBook changed again since the proposal | built |
| `studio_open_episode` | agent, expert | Starts the FILM-2011 pull; returns a `jobId`. `{episodeId}` | built over FILM-2011 |
| `studio_get_job_status` | agent, expert | `{jobId}` → the job's phase and progress | built over FILM-2011 |
| `studio_check_readiness` | agent, expert | Package, policy, target, media present and probed, codecs, captions, coverage, media health, export readiness → pass or issues | built |
| `studio_create_version` | agent, expert | `{name, prompt?}` | built |
| `studio_restore_version` | agent, expert | `{versionId, reason?}` | built |
| `studio_deliver` | agent, expert | `confirm: false` (default): a summary per render and its `summaryHash`, no side effects. `confirm: true` with the Deliver screen's one-time `confirmationToken`: render, QA, upload, `deliver_edit`; returns a `jobId`. `destination: folder` exports files and a QA report with no sign-in | built (FILM-2017); without the token `confirm: true` is `FORBIDDEN` |

A tool another spec builds answers `isError` with `{"error": {"code": "VALIDATION_FAILED", "message": "<tool> is not available yet: <spec> builds it.", "details": {"availableAfter": "<spec>"}}}`, never a partial result. Every error uses `{error: {code, message, details?}}` with `code` one of `VALIDATION_FAILED`, `TARGET_CHANGED`, `NOT_FOUND`, `FORBIDDEN`, `UNAUTHORIZED`. Arguments are checked against the tool's JSON schema first (required keys, unknown keys, types, enums). Every capability tool declares MCP `annotations`.

### `studio_edit` intents

| Intent | Scope | Params | Compiles to |
| --- | --- | --- | --- |
| `tighten_pacing` | scenes | `targetSeconds?`, `minSilenceSeconds` (0.6), `keepPauseSeconds` (0.25), `allowJumpCuts` (true), `includeUserEdits` | `get_audio_analysis` read → ripple `extract_range` cuts of the silence between lines (shot boundaries first, then inside a shot) and of repeated shots with no dialogue, tails over `maxShotLength`; `update_transition` to `transitions.maxDuration`; captions, beds and scene markers re-timed |
| `remove_dead_air` | scenes or range | as above | only spans with no voiced dialogue |
| `hit_duration` | episode or scenes | `targetSeconds` (default: the policy's or the episode's target) | silence first, then whole shots with no dialogue; every scene keeps a shot; within 5% or the card says why not |
| `open_with_strongest_line` | scenes | `lineId` or `sequenceNumber` | the highest-importance line and its shot moved to 0:00 (`move_clips`); beds stay; the report's `style.hookType` is `strongest_line` |
| `keep_music_under_dialogue` | episode | | no primitive: reports the music bus ducking FILM-2016 renders |
| `add_broll` | scenes | `query`, `perScene`, `durationSeconds` | `add_track` "B-roll" + `add_asset_to_timeline` after each scene's first line |
| `emphasize` | scene | `clipId` or `lineId`, `zoomPercent`, `text` | `set_clip_keyframes` punch-in (110% cap while `visual.avoidExtremeZoom`), optional `add_text_clip` |
| `add_cta` | episode | `text` (or the brand's outro asset) | `add_text_clip` in the last 10 s from the end of the final line, brand heading font |
| `match_brand` | scenes | | `add_transition` / `add_dip_to_black` / `remove_transitions` at scene changes, by `brand.transitionStyle` |
| `reorder_scenes` | episode | `order` (every scene once) | `move_clips` per scene block |
| `recut_around_drops` | episode | | silence cuts within 5 s of each measured drop in `analyticsHints.retention`; none when unmeasured, and it says so |

Bounds come from `storybook/policy.json` (StoryBook's edit policy, else its defaults); no compiler hard-codes a policy bound. A cut is a ripple `extract_range` because Velorn's `trim_clips` does not ripple: a trim alone leaves a gap and slips dialogue off its picture. Cuts run latest first, so each step's times are those of the timeline it was planned on.

`autoRepair: true` runs apply → QA → repair up to 3 rounds inside the one version and returns only the final cards. Repair plans come from FILM-2014's repair compiler; until FILM-2014's review is passed to the server the loop runs one round and says why.

The in-app agent (the Agent tab, `src/services/agentTools.js`) lists the same 18 tools and calls them through `studio:callCapability`, the same handler an MCP client reaches, so both get the same cards.

### Nightly AI eval

`scripts/ai-eval.mjs` runs 10 fixture episodes (`tests/studio/fixtures/ai-eval/episodes.json`, derived from the FILM-2001 packages) against 5 instructions (`instructions.json`, including the north-star "tighten scene 3 to 12 s and fix the audio") over MCP in the headless harness, with no human touch: the agent previews and applies. It scores each run on duration hit rate (within 5% of the asked target), QA pass rate, script coverage (lines and scenes still on the timeline), revisions (versions per run) and cost, writes `results.json` and `summary.md`, and with `--baseline` fails when the QA pass rate falls or the cost rises more than 20%.

```bash
npm run ai-eval -- --agent oracle                      # the compilers alone: a scripted agent, no model, no cost
npm i -D @anthropic-ai/sdk                             # once, for a model-driven run
STUDIO_EVAL_MODEL=claude-opus-5-5 ANTHROPIC_API_KEY=... npm run ai-eval -- --agent model --out .ai-eval/today --baseline .ai-eval/last/results.json
```

Which model drives the agent is the owner's choice (phase 20 open question 2); any model id works, and the cost table in the script covers the current Claude models. QA counts once FILM-2014 provides it; until then the QA pass rate is reported as unmeasured and the gate compares cost only.

## Recommended Workflows

### StoryBook Rough Cut (agent profile)

Use the `storybook-rough-cut` recipe from `get_mcp_recipes` (expert profile) or simply:

```text
Call studio_get_context. Tighten scene 3 to 12 seconds: preview with studio_edit (intent tighten_pacing, scope {"scene": 3}, params {"targetSeconds": 12}), show me the cards, and apply with the planId when I say so. Then show me the report.
```

`get_ai_review_passes` carries a `script-fidelity` pass: scenes with no clip, lines not on the timeline, scenes far off their planned length.

### Timeline Health

Use this before export or before an agent starts editing:

1. `get_project`
2. `get_timeline`
3. `check_media_health`
4. `analyze_timeline`
5. `check_export_readiness`
6. Optional: `add_timeline_markers` with `previewOnly: true`, then apply after approval.

### Visual Shot Review

Use this for music videos, fast social cuts, and visual continuity review:

1. `set_playhead` if the user gives a start time.
2. `inspect_visible_shots` for a page of top-visible shots.
3. `inspect_timeline_range` for a sampled contact sheet across a range.
4. `inspect_clip` or `inspect_timeline_frame` for specific problems.
5. Optional: `add_timeline_markers` after preview/approval.

### Safe Timeline Cleanup

Use this when the user asks for concrete timeline changes:

1. `find_timeline_items`
2. `inspect_clip` for any ambiguous target.
3. Preview one of `move_clips`, `trim_clips`, `delete_clips`, `split_clip`, `extract_range`, `set_clip_speed`, or `set_clip_audio`.
4. Apply only after approval.
5. Use `undo` if the result is not right.

### Generate From Timeline Context

Use this to extend, replace, or vary a shot:

1. `inspect_timeline_frame`
2. `list_velorn_workflows`
3. `prepare_generation_from_timeline_context` with `previewOnly: true`
4. Apply the prepare step only after approval.
5. `queue_prepared_generation` or `queue_timeline_generation_batch` with preview first.
6. `get_generation_status`
7. `add_asset_to_timeline`, `add_assets_to_timeline`, or `replace_clip_with_asset` with preview first.

### Community Workflow Import

Use this when the user brings a workflow from outside the official catalog — a comfy.org share URL, a downloaded .json, or pasted workflow JSON (UI/graph export format only):

1. `import_comfyui_workflow` with `previewOnly: true` and one of `url`, `filePath`, or `workflowJson`.
2. Show the user the dependency report: unknown node types, registry-resolvable node packs, model references, and `modelsMissingUrl` (community workflows almost never embed download URLs — supply `modelUrls` hints with `{ filename, url, targetSubdir }` for those).
3. Apply the import after approval. The result includes the `tpl-` workflow id, whether it is runnable, and any required extra media inputs (`assetSelect` fields).
4. `install_workflow_setup` with `previewOnly: true` — show the node packs, model files, and total download size, then apply only after explicit approval. Use `only: { nodePackIds, modelFilenames }` to install a subset.
5. Poll `get_workflow_install_status`. If it recommends a restart, restart ComfyUI with `control_comfyui_launcher`, wait for the connection, and re-preview to confirm.
6. `queue_timeline_template_generation` with `importedWorkflowId` (preview first). Map extra inputs — for example a reference face image — through `assetFieldIds` using the field ids from the preview.
7. `get_generation_status`, then place results with `add_asset_to_timeline` or `replace_clip_with_asset` after preview.

Downloads are https-only, existing files are never overwritten, and nothing installs without an applied `install_workflow_setup` call.

### Prompt To Generated Assets

Use this when the user gives a creative brief instead of a timeline source:

1. `list_velorn_workflows`
2. `create_asset_folder` with preview first.
3. `queue_prompt_generation_batch` with preview first.
4. `get_generation_status`
5. `create_timeline` if a separate sequence is useful.
6. `add_assets_to_timeline`
7. Add titles, shapes, adjustment clips, and keyframes as needed.

### Captions

Use this for timeline-wide captions or per-asset transcription:

1. `transcribe_captions` with `previewOnly: true`
2. Apply after approval.
3. Poll `get_caption_status`
4. Fix cue text or timing with `update_caption_cues`
5. `generate_captions` with preview first.
6. Apply after approval to render the caption overlay and place it on the Captions track.

### Export

Use this when delivery matters:

1. `check_media_health`
2. `check_export_readiness`
3. Optional: `set_in_out_range`
4. `export_timeline` with `previewOnly: true`
5. Apply after approval.
6. `inspect_export_file`

For social variants, preview `export_delivery_batch` before running it.

For interchange, preview `export_fcpxml` before writing a file. Use `format: "fcpxml"` for Resolve/Final Cut or `format: "premiere"` for Adobe Premiere Pro.

## Tool Catalog

Velorn exposes 133 MCP tools in the `expert` profile (130 upstream, plus `set_audio_buses` from FILM-2016 and two from FILM-2017; `node scripts/capability-matrix.mjs` counts them); the `agent` profile serves the 18 capability tools above instead.

StorybookStudio's AI editor builds on these tools: [AI_EDITOR_CONTRACT.md](AI_EDITOR_CONTRACT.md) defines what an agent may do, and [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md) maps every tool onto it.

### Project, Recipes, And Discovery

| Tool | Purpose |
| --- | --- |
| `get_project` | Summarize the open project, active timeline, asset counts, and snapshot freshness. |
| `get_timeline` | Return active timeline tracks, clips, markers, and optionally transitions. |
| `get_assets` | Return project assets without exposing heavy blobs or preview URLs. |
| `get_ai_review_passes` | Return practical AI review recipes. |
| `get_mcp_recipes` | Alias-style recipe entry point for agents asking what Velorn MCP can do. |
| `find_timeline_items` | Search clips, tracks, markers, transitions, and assets before targeting changes. |
| `list_recent_projects` | List recent projects, even when none is open. |
| `open_project` | Preview or open a project by path or recent project name. |
| `create_project` | Preview or create a new project in the configured Projects folder. |
| `duplicate_project` | Preview or duplicate a project folder and open it on apply. |
| `save_project` | Preview or explicitly save the current project, including Director state and the active timeline. |

### Health, Inspection, And Review

| Tool | Purpose |
| --- | --- |
| `check_media_health` | Find missing files, zero-byte files, missing asset IDs, and unused assets. |
| `inspect_export_file` | Inspect an exported file for codec, duration, resolution, FPS, audio, and warnings. |
| `check_export_readiness` | Check timeline blockers/warnings for a standard delivery export. |
| `inspect_clip` | Inspect a clip, source asset, timing, transform, label, and still image. |
| `inspect_timeline_frame` | Capture the composed timeline frame at the playhead, time, or frame. |
| `inspect_timeline_range` | Sample a range and return a visual contact sheet/storyboard. |
| `inspect_visible_shots` | Find top-visible shot changes and sample each visible shot. |
| `get_generation_status` | Summarize active, failed, and recent generated asset status. |
| `get_music_video_status` | Summarize music-video workflow assets, assembled clips, and sync locks. |
| `get_music_video_plan` | Return every parsed Music Video scene and shot, including IDs, prompts, timing, workflows, active jobs, and Step 4/5 completion state. |
| `inspect_music_video_keyframe` | Inspect one Music Video Step 4 shot, including its prompt, workflow routing, active job, latest image, and generation history. |
| `regenerate_music_video_keyframe` | Preview or queue one Step 4 shot through the active Music Video keyframe settings and native routing. |
| `inspect_music_video_video` | Inspect one Music Video Step 5 shot, including its input keyframe, motion prompt, timing, active job, latest video, history, and poster. |
| `regenerate_music_video_video` | Preview or queue one Step 5 shot through the active Music Video video settings and native routing. |
| `analyze_timeline` | Produce an AI-friendly timeline health report. |
| `analyze_music_video_workflow` | Produce an AI-friendly music-video workflow health report. |

### Agent-Guided Music Video Creation

These tools use the same persistent Director state as the visible Music Video UI. An agent-created project can therefore be opened, revised, regenerated, assembled, and saved through either MCP or the normal interface.

| Tool | Purpose |
| --- | --- |
| `get_music_video_session` | Read song, lyrics, creative direction, cast, workflows, output, passes, plan state, queue, and the resumable conversation checkpoint. |
| `configure_music_video` | Preview or set the song, lyrics, concept, style, workflows, output resolution, and FPS. |
| `update_music_video_session` | Preview or persist the current conversational phase, next question, decisions, approvals, and notes. |
| `manage_music_video_cast` | Preview or add, update, remove, replace, or clear named performers and their image references. |
| `queue_music_video_character_asset` | Preview or queue a Z-Image Turbo portrait or Multiple Angles character sheet. |
| `manage_music_video_pass` | Preview or manage alternate performance, environmental b-roll, and detail b-roll passes. |
| `set_music_video_director_script` | Validate, save, and optionally parse a master or coverage-pass director script. |
| `update_music_video_shot` | Preview or revise one parsed shot's prompts, timing, camera, type, artist, or reference overrides. |
| `queue_music_video_keyframes` | Preview or queue missing, all, or selected keyframes through native Director routing. |
| `queue_music_video_videos` | Preview or queue missing, all, or selected videos from their generated keyframes. |
| `replace_music_video_keyframe` | Preview or replace a Step 4 result with an existing project image. |
| `replace_music_video_video` | Preview or replace a Step 5 result with an existing project video. |
| `transcribe_music_video_audio` | Preview or run Qwen ASR transcription or provided-lyrics alignment. |
| `assemble_music_video_timeline` | Preview or assemble ready videos and song audio into editable coverage tracks with sync locks. |
| `replace_music_video_timeline_shot` | Preview or replace an assembled shot while preserving its edit timing, effects, transforms, and sync lock. |

### ComfyUI Setup And Workflow Support

| Tool | Purpose |
| --- | --- |
| `guide_comfyui_setup` | Beginner-friendly setup wizard for connecting Velorn to ComfyUI. |
| `diagnose_comfyui_connection` | Diagnose configured localhost port, API health, launcher state, and likely install mode. |
| `set_comfyui_connection` | Preview or set Velorn's local ComfyUI port. |
| `repair_comfyui_connection` | Probe likely ports and preview/apply a safe port-setting repair. |
| `control_comfyui_launcher` | Preview/apply start, stop, or restart through Velorn's launcher. |
| `get_comfyui_launcher_logs` | Return recent launcher logs with common issue summaries. |
| `validate_comfyui_nodes` | Check if ComfyUI node class names are available from `/object_info`. |
| `list_velorn_workflows` | List bundled workflows on the machine. |
| `inspect_velorn_workflow` | Inspect workflow JSON, extract required classes, and validate nodes. |
| `list_comfyui_templates` | Search official ComfyUI workflow templates. |
| `queue_timeline_template_generation` | Preview or queue an official ComfyUI template — or an imported community workflow via `importedWorkflowId` — from a timeline source clip. |
| `import_comfyui_workflow` | Preview or import a community ComfyUI workflow (comfy.org share URL, local .json, or inline JSON) as a runnable imported template with a dependency report. |
| `install_workflow_setup` | Preview or run the missing node-pack/model install for a workflow. Applying starts a background job. |
| `get_workflow_install_status` | Poll a dependency install job for progress, results, and restart guidance. |

### Selection, Navigation, Checkpoints, And Ranges

| Tool | Purpose |
| --- | --- |
| `undo` | Undo latest Velorn timeline or project-structure edit. |
| `redo` | Redo latest Velorn timeline or project-structure edit. |
| `set_playhead` | Move the playhead by seconds, timecode, or frame. |
| `select_clips` | Select clips by ID, filter, track, time, type, label, or search. |
| `select_assets` | Select/preview project assets by ID, name, type, folder, status, or latest match. |
| `create_project_checkpoint` | Create an MCP safety checkpoint, saved to `edits/checkpoints/` in the project folder (the newest 20 are kept). |
| `restore_project_checkpoint` | Preview or restore a checkpoint of the open project, including one from an earlier app session. |
| `set_in_out_range` | Set, preview, or clear the active timeline In/Out range. |
| `run_mcp_action_plan` | Preview or run a checkpointed ordered batch of approved MCP actions. |

### Timelines, Folders, Tracks, And Transitions

| Tool | Purpose |
| --- | --- |
| `create_timeline` | Preview or create a new sequence/timeline. |
| `switch_timeline` | Preview or switch the active sequence/timeline. |
| `rename_timeline` | Preview or rename a sequence/timeline. |
| `duplicate_timeline` | Preview or duplicate a sequence/timeline. |
| `delete_timeline` | Preview or delete a sequence/timeline. |
| `create_asset_folder` | Preview or create asset-panel folders, including nested paths. |
| `move_assets_to_folder` | Preview or move assets into a folder using IDs/names or safe filters. |
| `move_unused_assets_to_folder` | Preview or move unused project assets into a folder without deleting files. |
| `add_track` | Create a new timeline track. |
| `update_track` | Preview/update track name, mute, lock, visibility, channels, or order. |
| `remove_track` | Preview/remove a timeline track and its clips, with last-track protection. |
| `add_transition` | Preview/add native transitions between clips or on clip edges. |
| `update_transition` | Preview/update transition type, duration, alignment, or settings. |
| `remove_transitions` | Preview/remove native transitions. |

### Timeline Editing

| Tool | Purpose |
| --- | --- |
| `set_clip_label_color` | Set or clear clip label colors. |
| `set_clips_enabled` | Enable or disable timeline clips. |
| `add_timeline_markers` | Add labeled markers at times, frames, or the playhead. |
| `remove_timeline_markers` | Remove markers by ID, color, label, range, or all markers. |
| `set_timeline_marker_properties` | Rename, recolor, or move markers. |
| `move_clips` | Preview/move clips to a track or start time. |
| `trim_clips` | Preview/update clip timing and trim values. |
| `delete_clips` | Preview/delete clips, optionally with ripple. |
| `split_clip` | Razor clips at a time. |
| `extract_range` | Remove a time range across unlocked tracks, optionally ripple-closing the gap. |
| `set_clip_speed` | Retime clips from 0.1x to 8x and optionally reverse. |
| `set_clip_audio` | Set audio gain and fades. |
| `set_audio_buses` | StorybookStudio projects: preview/change bus gain, ducking under the dialogue bus (duckDb, attack, release) and the master loudness target (`project.studio.audioBuses`). The dialogue bus is never ducked. Preview and export both mix on the buses; a Studio export can also write stems beside the render. |
| `set_clip_style` | Batch-update label color, enabled state, transform, crop, blur, blend mode, and motion blur. |

### Media Placement And Replacement

| Tool | Purpose |
| --- | --- |
| `search_stock_media` | Search Pexels photos/videos and open the same results in Velorn's Stock tab. |
| `import_stock_media` | Preview/bulk-import selected Pexels IDs or the first N non-duplicate results into a project folder. |
| `import_asset_from_path` | Preview/import a local media file into the active project. |
| `relink_asset` | Preview/relink an existing asset record to a local file path. |
| `add_asset_to_timeline` | Preview/place one project asset on the active timeline. |
| `add_assets_to_timeline` | Preview/place multiple assets as review lanes or a sequence. |
| `replace_clip_with_asset` | Preview/replace a clip with another asset while preserving the edit slot and styling by default. |

Pexels search/import requires the user's API key in `Settings > Stock (Pexels)`. A safe agent flow is:

```text
Search Pexels photos for "ocean drone shots" with search_stock_media. Show me the result IDs first. Then preview importing 10 non-duplicate results with import_stock_media into Stock/Pexels/Ocean Drone Shots. Wait for approval before applying, and do not place anything on the timeline until I approve a separate add_assets_to_timeline preview.
```

`import_stock_media` re-runs the search before applying so result IDs are validated against Pexels instead of accepting arbitrary download URLs. Imported files become project-owned media and keep Pexels source/creator provenance in their asset metadata.

### Generation

| Tool | Purpose |
| --- | --- |
| `prepare_generation_from_timeline_context` | Preview/apply staging Generate from a selected clip or playhead frame. |
| `queue_prepared_generation` | Preview/queue the currently staged Generate request. |
| `queue_timeline_generation_batch` | Preview/queue multiple image-to-video generations from timeline context. |
| `queue_h3_reference_video` | Preview/queue one MiniMax H3 image+audio reference performance shot without opening the ComfyUI canvas. |
| `get_generation_queue_status` | Poll live Generate jobs, prompt IDs, progress, failures, and imported result asset IDs. |
| `queue_prompt_generation_batch` | Preview/queue text-to-image or text-to-video generations from prompts. |

### Captions

| Tool | Purpose |
| --- | --- |
| `transcribe_captions` | Preview/start Qwen ASR caption transcription for timeline or asset scope. |
| `get_caption_status` | Poll caption transcription/render jobs and get the cue draft. |
| `update_caption_cues` | Edit the cue draft or a live captions clip; a StorybookStudio caption plan sends per-cue `globalOverrides` (brand style, safe area) and a clip `preset` in the same call. |
| `generate_captions` | Preview/render an animated transparent caption overlay and place it on the Captions track. |

### Graphics, Effects, And Keyframes

| Tool | Purpose |
| --- | --- |
| `add_solid_color` | Preview/create a color or black constant asset and optionally place it on the timeline. |
| `add_adjustment_clip` | Preview/create an adjustment clip for color, blur, GLSL, and keyframed effects. |
| `duplicate_clip` | Duplicate a clip while preserving style, transform, effects, and keyframes. |
| `add_text_clip` | Create a text clip with typography, transform, animation, or keyframes. |
| `update_text_clip` | Preview/update an existing text clip. |
| `add_shape_clip` | Create shape clips for rectangles, rounded rectangles, ellipses, polygons, or lines. |
| `update_shape_clip` | Preview/update an existing shape clip. |
| `list_glsl_effects` | List GPU-backed effects, parameters, ranges, defaults, and presets. |
| `add_glsl_effect` | Preview/add a GLSL effect to a visual clip. |
| `update_glsl_effect` | Preview/update an existing GLSL effect. |
| `remove_glsl_effect` | Preview/remove a GLSL effect. |
| `set_clip_keyframes` | Preview/set visual keyframes for opacity, transform, blur, crop, color, and shape style. |
| `add_dip_to_black` | Preview/apply dip-to-black opacity fades between adjacent visual clips. |

### Export

| Tool | Purpose |
| --- | --- |
| `export_timeline` | Preview/start a timeline export through Velorn's export worker. |
| `export_delivery_batch` | Preview/run several delivery exports such as 16:9, 1:1, and 9:16. |
| `export_fcpxml` | Preview/export modern FCPXML for Resolve/Final Cut or XMEML v5 for Adobe Premiere Pro. |

## Preview/Apply Examples

Preview marker creation:

```json
{
  "tool": "add_timeline_markers",
  "arguments": {
    "markers": [
      {
        "timeSeconds": 12.5,
        "label": "Check continuity",
        "color": "#ffa500"
      }
    ],
    "previewOnly": true
  }
}
```

Apply after approval:

```json
{
  "tool": "add_timeline_markers",
  "arguments": {
    "markers": [
      {
        "timeSeconds": 12.5,
        "label": "Check continuity",
        "color": "#ffa500"
      }
    ],
    "previewOnly": false
  }
}
```

Preview a small generation batch:

```json
{
  "tool": "queue_prompt_generation_batch",
  "arguments": {
    "folderPath": "AI Spots / Product Demo",
    "items": [
      {
        "workflowId": "z-image-turbo",
        "prompt": "Premium tabletop product hero shot, soft cinematic light, clean background",
        "variations": 2,
        "width": 1280,
        "height": 720
      }
    ],
    "previewOnly": true
  }
}
```

Preview a MiniMax H3 lip-sync shot before spending credits:

```json
{
  "tool": "queue_h3_reference_video",
  "arguments": {
    "imageAssetId": "asset-reference-frame",
    "audioAssetId": "asset-exact-audio-segment",
    "shotId": "S01",
    "prompt": "Use Image 1 as the exact identity and composition reference. Use Audio 1 as the exact and sole performance-timing reference. Synchronize every visible mouth movement precisely to the supplied audio.",
    "durationSeconds": 9,
    "resolutionTier": "2K",
    "aspectRatio": "16:9",
    "previewOnly": true
  }
}
```

After explicit approval, repeat with `previewOnly: false`, then poll:

```json
{
  "tool": "get_generation_queue_status",
  "arguments": {
    "workflowId": "minimax-h3-r2v",
    "includeDone": true
  }
}
```

Preview a delivery export:

```json
{
  "tool": "export_timeline",
  "arguments": {
    "target": "h264_hd",
    "resolution": "1080p",
    "filename": "client_review_v1",
    "previewOnly": true
  }
}
```

## Troubleshooting

### The MCP client cannot connect

- Make sure the Velorn desktop app is running.
- Check `Settings > Agents (MCP)` for `Running`.
- Confirm the endpoint is `http://127.0.0.1:19790/mcp`.
- If the port is unavailable, another local process may already be using `19790`.
- Restart Velorn after changing development branches or rebuilding Electron code.

### The agent says no project is open

Open a project in Velorn, then try again. The agent can call `list_recent_projects` and `open_project`, but most timeline and asset tools need an active project snapshot.

### A write tool previews but does not apply

That is expected. Ask the agent to repeat the same tool call with `previewOnly: false` after you approve the preview.

### The agent cannot find the right clip

Ask it to use `find_timeline_items`, `inspect_visible_shots`, or `inspect_clip` before making changes. Prefer exact clip IDs for write actions.

### ComfyUI generation fails

Ask the agent to use:

1. `diagnose_comfyui_connection`
2. `get_comfyui_launcher_logs`
3. `validate_comfyui_nodes`
4. `inspect_velorn_workflow`

These tools can distinguish port issues, missing custom nodes, missing models, launcher problems, and workflow compatibility issues.

### Exports fail or look wrong

Ask the agent to run:

1. `check_media_health`
2. `check_export_readiness`
3. `export_timeline` with `previewOnly: true`
4. `inspect_export_file` after export

For square or vertical exports, make sure the agent previews `deliveryFraming` so you know whether the output will fit or crop the timeline frame.

## Notes For MCP Client Authors

- Use `tools/list` to discover schemas at runtime. The catalog can grow over time.
- Tool results are returned as MCP content blocks, usually text containing JSON.
- Frame and contact-sheet inspection tools may include image content when requested and when size limits allow.
- Keep the MCP client connected to the local machine running Velorn. This is not a cloud API.
- Do not assume a write tool changed the project unless the returned result says it applied successfully.
- Favor explicit IDs from read tools over natural-language targeting for write tools.
- Queueing generation and running exports can take time. Poll status tools such as `get_generation_status`, `get_caption_status`, or inspect output files after completion.
