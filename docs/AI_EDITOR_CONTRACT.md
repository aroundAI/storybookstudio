# StorybookStudio AI Editor Contract

This contract states what an AI client may read and do in StorybookStudio, and what the editor guarantees in return. It is the interface every Phase 20 Studio spec (FILM-2010..2019, in the StoryBook repo under `specs/phase-20-storybookstudio/`) implements. [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md) maps each of Velorn's MCP tools onto the verbs below.

Each clause has an id, its inputs (**In**), its outputs (**Out**), the invariant it guarantees (**Guarantees**) and the spec that implements it (**Built by**). Where this document and a spec disagree, the spec wins and this document is corrected in the same PR. A field or guarantee marked † is introduced here and not yet stated in the implementing spec; that spec adopts it or corrects this line.

## 0. Terms

- **Primitive**: one of Velorn's MCP tools in `electron/mcpServer.js` (`createToolDefinitions()`). Served by the `expert` profile.
- **Capability tool**: a `studio_*` tool in `electron/studio/mcpCapabilities.js`. Served by the `agent` profile, the default (FILM-2013).
- **Intent**: a named editing goal (`tighten_pacing`). An **intent compiler** is a pure function `(context, scope, params, policy) => ActionPlan` in `src/studio/intents/`.
- **Action plan**: an ordered list of primitive calls with one reason per step (A1).
- **Version**: a named snapshot of the timeline document plus the op range since its parent (FILM-2012).
- **Scope**†: `{ scenes?: number[], range?: [start, end], clipIds?: string[], timelineId?: string }`. An empty scope means the active timeline.

Both profiles are served on `http://127.0.0.1:19790/mcp`, chosen by `?profile=agent|expert` or the equivalent header, and both require the bearer secret (S1).

## 1. Inputs

### IN1 Edit package
- **In:** `get_edit_package({episodeId, ifNoneMatch?})` on StoryBook's `/api/mcp`, called by the main-process cloud client only.
- **Out:** `EditPackageSchema` (`storybook-edit-package/1`): `scenes` (from the screenplay), `shots` (sequence order, `timeline_start_seconds`, trims, transition, prompt, primary subject, continuation link, first and last frames), `dialogue` (per line, with `language` and `timeline_start_seconds`), `audioTracks` (music, sfx, ambience with loopable flag and tags), `captions` (segments per language), `characters`, `shortsCandidates`, `dubbed` (dubbed lines per language), `brand`, `editPolicy`, `analyticsHints`, `etag`. Every media entry is `{url, sha256, bytes, mime}` or `null` with a reason.
- **Guarantees:** The package is a read-only snapshot, stored as pulled in `storybook/package.json`. A matching `ifNoneMatch` returns `{unchanged: true, etag}`. `analyticsHints.retention` is measured drop-offs or `[]` with `reason: 'unmeasured'`; it is never zero-filled or invented. Signed URLs expire after 3600 s and are never logged.
- **Built by:** FILM-2001 (StoryBook). The schema is defined once in `@kit/desktop-integration` and copied into `src/studio/contracts/` with a drift test.

### IN2 Brand
- **In:** `editPackage.brand`, written to `storybook/brand.json`.
- **Out:** `BrandSchema`: `fonts {heading, body}`, `colors {primary, secondary, background, captionText, captionBackground}`, `captionStyle {fontSize, position, maxCharsPerLine, background, emphasis}`, `logo {assetId, position, opacity}`, `introAssetId`, `outroAssetId`, `transitionStyle cut|dissolve|dip`, `musicStyle[]`.
- **Guarantees:** Parsing `{}` yields the full default object, so a compiler never handles a missing field.
- **Built by:** FILM-2004.

### IN3 Edit policy
- **In:** `editPackage.editPolicy`, written to `storybook/policy.json`.
- **Out:** `EditPolicySchema`: `targetDurationSeconds`, `minShotLength` (1.2), `maxShotLength` (6), `transitions {preferred[], maxDuration 0.4}`, `music {enabled, duckUnderDialogue, duckDb -8}`, `captions {enabled, style}`, `visual {avoidRepeatedShots, avoidExtremeZoom}`, `loudnessTargetLufs` (-14).
- **Guarantees:** Compilers (§5) and the critic (V2) read bounds only from this file. No threshold is hard-coded in a compiler.
- **Built by:** FILM-2004. FILM-2013 and FILM-2014 consume it.

### IN4 Probed assets
- **In:** Downloaded media under `assets/`.
- **Out:** Per file: sha256 verified against the package, ffprobe `{duration, fps, width, height, codecs, hasAudio}`. A file that fails verification twice is marked offline.
- **Guarantees:** No clip references an unverified file. An offline asset surfaces in `check_media_health` and in readiness (L2).
- **Built by:** FILM-2011 (`electron/studio/pull.js`).

### IN5 Project document
- **In:** `project.comfystudio` with the EditGraph v1 additive fields.
- **Out:** `asset.role`, `asset.semantic {scene, shotId, characters[], purpose, emotion, prompt, continuationFrom}`, `asset.analysis {loudnessLufs, silences[], bpm, keyframes[], semanticsVersion}`, `asset.languageDependency`, `clip.metadata.semantic {scene, shotId, role}`, `clip.metadata.origin {versionId, opId, by: ai|user}`, `timeline.studio {kind, variantOf, aspect, language}`, `project.studio {schema: 'editgraph/1', episodeId, currentVersion, audioBuses}`. Also `edits/oplog.jsonl` and `edits/versions.json`.
- **Guarantees:** Stock Velorn opens a Studio project and ignores the extra fields. The Studio opens any Velorn project. Every clip the builder places carries `semantic`.
- **Built by:** FILM-2012.

## 2. Perception

Perception never changes the document. Every perception verb is callable at any time in either profile.

### P1 Context
- **In:** `studio_get_context({scope?})`.
- **Out:** Screenplay scenes with dialogue text, the scene map (P2), policy, brand summary, timeline summary (tracks, clip count, duration), versions, last QA result.
- **Guarantees:** This is the one call an agent makes first. Its output is derived from IN1..IN5 and the live snapshot, never cached across a document change.
- **Built by:** FILM-2013 (`src/studio/context.js`). Composes `get_project`, `get_timeline`, `get_assets`.

### P2 Scene map
- **In:** The project document.
- **Out:** `[{scene, heading, clipIds[], plannedDuration, actualDuration, targetDuration}]`.
- **Guarantees:** Every scene in the screenplay appears, including scenes with no clip (actual duration 0), so coverage gaps are visible.
- **Built by:** FILM-2013, from `clip.metadata.semantic.scene` (FILM-2012).

### P3 Search
- **In:** `studio_search_assets({query, role?, scene?, durationRange?})`; `find_timeline_items` for clips, tracks, markers and transitions.
- **Out:** Ranked assets with semantics and transcript match; matching timeline items with ids.
- **Guarantees:** Write steps target ids returned by search, never natural-language names.
- **Built by:** FILM-2013.

### P4 Inspect visual
- **In:** `inspect_clip`, `inspect_timeline_frame`, `inspect_timeline_range`, `inspect_visible_shots`.
- **Out:** Stills, contact sheets and shot boundaries with clip context.
- **Guarantees:** Unchanged Velorn behaviour.
- **Built by:** Velorn.

### P5 Inspect audio
- **In:** `get_audio_analysis({clipId|assetId, silenceThresholdDb?, minSilenceSeconds?})`.
- **Out:** Silence spans, beats and BPM, approximate integrated LUFS, loudness curve. With `clipId`, times are on the timeline.
- **Guarantees:** This is the compile-time silence source. Velorn has no `detect_silence` tool; the name in the design's `tighten_pacing` example means this call. Its loudness is approximate and is not a QA verdict (V1 is).
- **Built by:** Velorn; FILM-2013 wraps it for compilers.

### P6 Health
- **In:** `check_media_health`, `check_export_readiness`, `analyze_timeline`.
- **Out:** Missing or offline media, blockers and warnings for a target, gaps, tiny clips and overlaps.
- **Built by:** Velorn.

### P7 Review
- **In:** `studio_review({scope, versionId?})`.
- **Out:** `{qa: QaResult, critic: QaResult, skipped?: ['visual']}`†.
- **Guarantees:** Runs V1, then V2. Reports the visual analyser as skipped, not passed, when no hosted model is configured.
- **Built by:** FILM-2014.

### P8 Job status
- **In:** `studio_get_job_status({jobId})`.
- **Out:** `{phase, done, total, bytes, error?}` for pull, render and deliver jobs.
- **Guarantees:** Long jobs run in the main process, never over the renderer bridge (60 s timeout).
- **Built by:** FILM-2013 over FILM-2011.

## 3. Editing primitives

These are Velorn's tools, grouped by verb. An action plan (A1) is built only from them. The matrix lists every tool and its class.

| Id | Verb | Primitives | Notes |
| --- | --- | --- | --- |
| E1 | Timeline items | `set_playhead`, `select_clips`, markers (`add_timeline_markers`, `remove_timeline_markers`, `set_timeline_marker_properties`), `set_in_out_range`, tracks (`add_track`, `update_track`, `remove_track`), timelines (`create_timeline`, `switch_timeline`, `rename_timeline`, `duplicate_timeline`, `delete_timeline`) | A variant is a duplicated timeline with `timeline.studio.kind = variant` (FILM-2017) |
| E2 | Clips | `add_asset_to_timeline`, `add_assets_to_timeline`, `move_clips`, `delete_clips` (ripple), `duplicate_clip`, `replace_clip_with_asset`, `set_clips_enabled`, `set_clip_label_color` | |
| E3 | Trims | `trim_clips`, `split_clip`, `extract_range`, `set_clip_speed` | `split_clip`, `extract_range` and `set_clip_speed` are not plan-writable today (G3) |
| E4 | Transitions | `add_transition`, `update_transition`, `remove_transitions`, `add_dip_to_black` | Durations capped at `policy.transitions.maxDuration` |
| E5 | Audio | `set_clip_audio` (gain, fades), `update_track` (volume, pan, mute, inserts), `set_master_audio` (master, limiter); buses and ducking (FILM-2016) | No primitive writes a volume envelope or ducking yet (G4) |
| E6 | Captions | `transcribe_captions`, `get_caption_status`, `update_caption_cues`, `generate_captions` | Transcription is an async job; it cannot be a plan step |
| E7 | Effects and graphics | `set_clip_style`, `set_clip_mask`, `set_clip_keyframes`, `add_glsl_effect`, `update_glsl_effect`, `remove_glsl_effect`, `list_glsl_effects`, `add_adjustment_clip`, `add_solid_color`, `add_text_clip`, `update_text_clip`, `add_shape_clip`, `update_shape_clip`; compositions (FILM-2018); `set_auto_reframe`, `set_focal_point` (FILM-2017) | Semantic effects `punch_in`, `ken_burns`, `speed_ramp`, `freeze_frame`, `color_grade` compile to these (FILM-2018) |
| E8 | Export | `export_timeline`, `export_delivery_batch`, `export_fcpxml`, `inspect_export_file` | Delivery presets (FILM-2017) |
| E9 | Checkpoints | `create_project_checkpoint`, `restore_project_checkpoint`, `undo`, `redo`, `save_project`, `run_mcp_action_plan`; versions (L6) | Checkpoints persist under `edits/checkpoints/` (FILM-2010) |
| E10 | Assets | `import_asset_from_path`, `relink_asset`, `select_assets`, `create_asset_folder`, `move_assets_to_folder`, `move_unused_assets_to_folder` | |

**Guarantees for every primitive call:** It goes through the renderer's `mcp:action` bridge and the stores' normal actions, so undo, dirty tracking, autosave and the MCP snapshot stay accurate. Each applied write appends one op-log line (A4). Generation, ComfyUI, Music Video and stock tools serve no contract verb and stay in the expert profile.

## 4. Action plans

### A1 Plan shape
- **Out:** `ActionPlan = { steps: [{tool, arguments}], reasons: string[], expected: {durationBefore, durationAfter, perScene: [{scene, before, after}]}, touchesUserEdits†: clipId[] }`.
- **Guarantees:** `reasons.length === steps.length`. At most 50 steps (`MCP_ACTION_PLAN_MAX_STEPS`). Every step's tool is in `MCP_ACTION_PLAN_WRITABLE_TOOLS`. Every target is an id read at compile time.
- **Built by:** FILM-2013 (`src/studio/compile.js`).

### A2 Compile-time reads
- **In:** P1..P6 results, IN2, IN3.
- **Guarantees:** Reads happen in the compiler, never as plan steps. `run_mcp_action_plan` refuses any tool outside the writable set, which includes every read tool.
- **Built by:** FILM-2013.

### A3 Preview
- **In:** `studio_edit({intent, scope, params?, previewOnly: true})`. `previewOnly` defaults to true on every capability tool.
- **Out:** Plan cards `[{scene, durationBefore, durationAfter, changes: [{text, reason}]}]` and a draft explain-why report.
- **Guarantees:** Nothing in the document changes and nothing is logged. The compiler calls each step's own `previewOnly: true` path itself. `run_mcp_action_plan` with `previewOnly` only validates step names and does not exercise the steps.
- **Built by:** FILM-2013.

### A4 Apply
- **In:** The same call with `previewOnly: false`.
- **Out:** A new version (L6), the applied steps, the explain-why report in `edits/reports/<versionId>.json`.
- **Guarantees:** In order: re-base check (A5), `studio_create_version`, `run_mcp_action_plan` with `createCheckpointFirst: true` and `stopOnError: true`. Each applied step appends one line `{op, ts, by: 'ai', session, tool, args, inverse, reason, scene, versionId}` to `edits/oplog.jsonl`. A failed step stops the plan; the version and checkpoint remain for restore.
- **Built by:** FILM-2013, with the op log from FILM-2012.

### A5 User edits and re-basing
- **Guarantees:** A plan never includes a step on a clip whose last `origin.by` is `user` since the previous plan, unless the card lists it under "touches your edits". The compiler re-bases on the current document at preview and again at apply. If the document changed in between, apply refuses with `TARGET_CHANGED`.
- **Built by:** FILM-2013, tested against the FILM-2012 log.

## 5. Editing intents

Every intent compiles to an action plan (A1) and reads its bounds from the policy (IN3). The model chooses the intent and the scope; the compiler chooses the primitives.

| Intent | Tool | Reads | Compiles to | Guarantees | Built by |
| --- | --- | --- | --- | --- | --- |
| `hit_duration` | `studio_edit` | P2, P5, policy target | `extract_range`, `trim_clips`, `delete_clips` on lowest-information shots | Every scene keeps at least one clip; result within ±5% of target or the card says why not | FILM-2013 |
| `tighten_pacing` | `studio_edit` | P3, P5, P4 | `trim_clips` (silences over 0.6 s), `delete_clips` (duplicate establishing shots), `trim_clips` (reactions to `maxShotLength`), `update_transition` (to `transitions.maxDuration`) | No shot shorter than `minShotLength` | FILM-2013 |
| `remove_dead_air` | `studio_edit` | P5 | `extract_range` with ripple | Only spans in the silence list are cut, so no dialogue word is cut† | FILM-2013 |
| `open_with_strongest_line` | `studio_edit` | sound bites (IN5 analysis) | `move_clips`, `trim_clips` | The moved bite is reported with its importance score | FILM-2013 |
| `keep_music_under_dialogue` | `studio_edit` | P5, buses | music-bus ducking at `music.duckDb` | The dialogue bus is never ducked | FILM-2013, FILM-2016 |
| `add_broll` | `studio_edit` | P3 (role `broll`) | `add_asset_to_timeline` on an upper track | No b-roll covers a speaker's first line in a scene† | FILM-2013 |
| `emphasize` | `studio_edit` | P2 | `set_clip_keyframes` punch-in, `update_text_clip` | Punch-in respects `visual.avoidExtremeZoom`† | FILM-2013 |
| `add_cta` | `studio_edit` | IN2 | `add_asset_to_timeline` (outro) or `add_text_clip` in brand fonts; music ducked | Placed in the last 10 s, aligned to the final dialogue | FILM-2013 |
| `match_brand` | `studio_edit` | IN2 | `update_transition`, `add_dip_to_black`, `add_adjustment_clip`, caption style | Each change is reported with the brand field it came from† | FILM-2013 |
| `reorder_scenes` | `studio_edit` | P2 | `move_clips` per scene block | Clips keep their relative order inside a scene† | FILM-2013 |
| `recut_around_drops` | `studio_edit` | `analyticsHints.retention` | `trim_clips`, `move_clips` around drop timestamps | With `reason: 'unmeasured'` it returns no plan and says so; it never guesses drops | FILM-2013 |
| `balance` | `studio_edit_audio` | P5, bus stems | `set_clip_audio`, bus gain | Dialogue-to-music ratio per segment within policy | FILM-2016 |
| `duck` | `studio_edit_audio` | policy | bus `duckDb`, 120 ms attack, 400 ms release | As `keep_music_under_dialogue` | FILM-2016 |
| `normalize` | `studio_edit_audio` | preset LUFS | bus and master targets, `set_master_audio` | Master within ±1 LU of the preset target | FILM-2016 |
| `fade` | `studio_edit_audio` | cuts | `set_clip_audio` fades at cuts | Fades never exceed clip length | FILM-2016 |
| captions | `studio_add_captions` | IN2 `captionStyle` | `transcribe_captions`, then `update_caption_cues` with styled, safe-area cues, then the V1 caption check | Cues sit inside the aspect's safe rectangle (9:16 above the bottom 25%, clear of the right 15%) | FILM-2016 |
| variant `short` | `studio_create_variant` | `shortsCandidates` or hook pick | `duplicate_timeline`, `extract_range`, reframe, caption re-placement | Duration within the preset's `maxDuration` or flagged | FILM-2017 |
| variant `hook` | `studio_create_variant` | sound bites | N first-5-second timelines | Each exported as its own file | FILM-2017 |
| variant `language` | `studio_create_variant` | `dubbed` (re-synced) | `Dialogue:<lang>` track, captions for the language | Language-detection QA must match | FILM-2019 |
| graphic | `studio_add_graphic` | IN2 | composition clip | `VALIDATION_FAILED "not available yet"` until FILM-2018 | FILM-2018 |
| repair | `studio_repair` | QA issues | each issue's `repairIntent` (V3) | One plan for all issues, with reasons | FILM-2014 |

## 6. Validation

### V1 Deterministic QA
- **In:** A render or the timeline, the preset, the policy.
- **Out:** `QaResultSchema`: `{pass, issues: [{type, severity 0..1, timeRange, scene, detail, repairIntent?}]}`.
- **Checks:** ebur128 loudness and true peak against the preset (-14 LUFS YouTube, -16 Reels); astats clipping; blackdetect; freezedetect; silencedetect longer than policy; ffprobe duration within ±5% of `targetDurationSeconds`; codec, fps and resolution against the preset; caption cues inside safe rectangles and not overlapping; `check_media_health`; script coverage (every scene has a clip, every dialogue line is placed or logged as cut).
- **Guarantees:** No model is involved, so the same render gives the same result. Every issue a repair can fix names its `repairIntent`.
- **Built by:** FILM-2014 (`electron/studio/qa.js`). The schema is defined in `@kit/desktop-integration` (FILM-2003) and copied in.

### V2 Critic analysers
- **In:** Keyframes, the bus-stem mix, the scene map.
- **Out:** Issues in the V1 shape from `pacing` (shot length against policy, dialogue end against clip end, repeated shots, cut density), `audio` (dialogue-to-music ratio, fades at cuts, abrupt level changes) and `visual` (framing, caption overlap, continuity across cuts, script fidelity).
- **Guarantees:** Only `visual` spends tokens. It sends at most 40 keyframes per review and records its token cost in the op log.
- **Built by:** FILM-2014 (`src/studio/critic/`).

### V3 Repair
- **In:** `studio_repair({issues[]})`.
- **Out:** One action plan. Repair intents are `duck_music`, `trim_silence`, `normalize_loudness`, `move_caption`, `replace_missing_media`, `add_fade` and `re-time`.
- **Guarantees:** Repair is a plan with reasons, not a prompt. It follows A3 and A4 like any other edit.
- **Built by:** FILM-2014.

### V4 Auto-repair loop
- **In:** `studio_edit({..., autoRepair: true})`.
- **Guarantees:** Apply, keyframes, QA and repair run at most 3 rounds inside one draft version. Only the final cards are shown. Intermediate ops stay in the log. Issues left after round 3 become cards for the user.
- **Built by:** FILM-2013 with FILM-2014.

## 7. Lifecycle

The order is L1 to L8. L9 can happen at any point after L3.

### L1 Open episode
- **In:** `studio_open_episode({episodeId})` or the picker. A `velorn://open?api=&episode=` deep link opens the picker with the episode selected.
- **Out:** `jobId`. When the job completes, the project is open.
- **Guarantees:** A deep link never starts a pull by itself. The `api` host must be on the allowlist. Pulling is idempotent, so a re-run skips verified files.
- **Built by:** FILM-2011 (pull, protocol), FILM-2013 (tool), FILM-2015 (picker).

### L2 Readiness
- **In:** `studio_check_readiness()`.
- **Out:** Pass, or issues for media present and probed, codecs, durations, captions available, policy loaded, target duration known.
- **Built by:** FILM-2013, composing `check_media_health` and `check_export_readiness`.

### L3 Rough cut
- **In:** IN1..IN4.
- **Out:** A project document (IN5) built by `projectBuilder(package, probedAssets, brand, policy)`. It has one master timeline, shots on `video-1`, a dialogue track per language, music, sfx and ambience on their buses, a captions track, one marker per scene, and Veo shot audio ducked under dialogue.
- **Guarantees:** The builder is pure, so the same inputs produce the same project.
- **Built by:** FILM-2012.

### L4 Plan and preview
- See A1 to A3. Every edit starts as a preview. An agent cannot apply a plan the user has not seen as cards, except inside the V4 loop, which stays in a draft version.

### L5 Apply
- See A4 and A5.

### L6 Version
- **In:** `studio_create_version({name})`, `studio_restore_version({versionId})`.
- **Out:** `{id, name, parent, opRange, createdBy, createdAt, prompt}`. The snapshot is stored at `edits/snapshots/<id>.json`.
- **Guarantees:** A version is created before any apply. Restore loads the snapshot in O(1) and appends a restore op. Versions survive a restart. Velorn's in-memory undo remains the fast path.
- **Built by:** FILM-2012 (`versions.js`), FILM-2013 (tools).

### L7 Render
- **In:** `studio_render_preview({scope, range, timeline, quality})`.
- **Out:** A file path, keyframe paths and the V1 result.
- **Guarantees:** Keyframes are rendered after every applied plan. Scene and audio-only tiers are rendered for the critic. Preview renders bypass the media-preparation queue, so a long export never blocks them.
- **Built by:** FILM-2014.

### L8 Deliver
- **In:** `studio_deliver({presets[], languages[], confirm})`.
- **Out:** With `confirm: false`, a summary per render (preset, language, estimated size and duration, last QA state) and no side effects. With `confirm: true`, the renders, a QA result per file, `request_render_upload` and `finalize_render` per file, then `deliver_edit` once with the explain-why report and the pulled `episodeVersion`.
- **Guarantees:** `confirm: true` is refused without the one-time confirmation token the Deliver screen sets after the user sees a summary naming the episode, files and destination. An MCP client cannot upload on its own. `TARGET_CHANGED` from `deliver_edit` offers re-sync (L9) and retry, reusing renders that are already finalized. "Export to file" needs no sign-in.
- **Built by:** FILM-2017; the StoryBook side is FILM-2003.

### L9 Re-sync
- **In:** `studio_check_updates()`, `studio_apply_updates()`. Polling runs every 5 minutes while a project is open.
- **Out:** Changed shots and dialogue, and a replacement plan of `replace_clip_with_asset` calls.
- **Guarantees:** Changed media lands under new file names. Nothing is applied without approval (A3, A4).
- **Built by:** FILM-2011 (`sync.js`), FILM-2013 (tools).

## 8. Errors and safety

- **S1 Bearer:** Every request to the local MCP server carries `Authorization: Bearer <secret>`. The secret is generated on first run in `userData/mcp-secret`. A non-loopback `Origin` or `Host` gets 403. Built by FILM-2010.
- **S2 Tokens:** StoryBook tokens live in the main process under `safeStorage`. They never appear in the renderer, the MCP snapshot or the logs. Built by FILM-2010 (secrets module) and FILM-2011.
- **S3 Delivery confirmation:** See L8. `studio_deliver` is never in `MCP_ACTION_PLAN_WRITABLE_TOOLS`. Every other `studio_*` write tool is.
- **S4 Not available yet:** A capability tool whose spec has not landed returns `VALIDATION_FAILED "not available yet"`, never a partial result. This covers `studio_render_preview`, `studio_review` and `studio_repair` until FILM-2014; `studio_edit_audio` and `studio_add_captions` until FILM-2016; `studio_deliver` and `studio_create_variant` until FILM-2017; and `studio_add_graphic` until FILM-2018.
- **S5 Error codes:** `VALIDATION_FAILED` (bad input or not available), `TARGET_CHANGED` (document or episode changed since preview or pull), `NOT_FOUND`, `FORBIDDEN` (role), `UNAUTHORIZED` (sign in again). StoryBook-side codes pass through unchanged.

## 9. Gaps found while writing this contract

These come from reading `electron/mcpServer.js` at fork commit 233f35f (Velorn v0.3.36). Each is assigned to the spec that has to close it.

- **G1 Tool count.** There are 130 tools, not the 129 the design and specs state; `docs/MCP.md` says 125. `node scripts/capability-matrix.mjs` prints the count.
- **G2 Plan preview does not preview steps.** `run_mcp_action_plan` with `previewOnly` checks step names and returns them unexecuted. Per-step previews are the compiler's job (A3, FILM-2013).
- **G3 Write tools missing from the writable set.** `split_clip`, `extract_range`, `set_clip_speed`, `set_clip_audio`, `update_caption_cues` and `generate_captions` accept `previewOnly` but `run_mcp_action_plan` refuses them. FILM-2013 adds the first five; caption generation stays a sequenced job.
- **G4 No ducking primitive.** Velorn's UI ducking (`src/utils/audioDucking.mjs`) writes a volume envelope, but no MCP tool exposes it, and `set_clip_audio` sets only gain and fades. FILM-2016 builds bus ducking and can reuse that module.
- **G5 No `detect_silence`.** The design's `tighten_pacing` example names it. `get_audio_analysis` is the compile-time equivalent (P5); QA-grade `silencedetect` is FILM-2014.
- **G6 No MCP annotations.** No Velorn tool declares `readOnlyHint` or `destructiveHint`. Read and write are inferred from `previewOnly` and the writable set; capability tools declare annotations (FILM-2013).
