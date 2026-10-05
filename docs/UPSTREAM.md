# Merging upstream Velorn

StorybookStudio is a fork of [VelornLabs/velorn](https://github.com/VelornLabs/velorn),
GPL-3.0-only. We merge upstream once a month so the editor, export pipeline and
ComfyUI integration keep improving without us carrying them.

Last upstream head merged: `fdd8255fb717db024688a2582022aa048dd16e84`
(2026-09-26, v0.3.36, "Merge pull request #134 from VelornLabs/codex/issue-131-import-cache").
Update this line and the table at the bottom in the merge PR.

## What we keep apart from upstream

- `electron/studio/` and `src/studio/` are ours alone. Upstream has no such folders, so a
  merge never touches them. Never move our code into upstream's files; register it from
  them with a one-line import and call.
- `tests/studio/` and `docs/` files named `STORYBOOKSTUDIO-*` or `UPSTREAM.md` are ours.
- The name is StorybookStudio everywhere, identifiers included (owner decision, 2026-10-05):
  package `name` and `appId`, the `.storybookstudio` project file, the `storybookstudio://`
  deep link and `storybookstudio-file://` protocol, the Studio Bridge ComfyUI extension,
  output prefixes, storage keys, MCP tool names and env vars. Upstream's names survive only in
  `LICENSE`, the licenses notice (`electron/studio/licenses/NOTICE.txt`), this file and
  `src/studio/legacyNames.json`, which the one-time migrations read;
  `tests/studio/no-upstream-names.test.mjs` fails on any other.
- Merging upstream therefore conflicts wherever upstream changed a line that carries its
  name. Resolve by keeping upstream's change and renaming as the rest of the tree does
  (Velorn → StorybookStudio, ComfyStudio → StorybookStudio, `comfystudio://` →
  `storybookstudio-file://`), then run the names test.

## Monthly merge

1. One-time setup per clone:

   ```bash
   git remote add upstream https://github.com/VelornLabs/velorn.git
   ```

2. Fetch and branch from our main:

   ```bash
   git fetch upstream --tags
   git checkout -b chore/upstream-YYYY-MM origin/main
   git log --oneline HEAD..upstream/main | wc -l      # how much is coming
   git merge upstream/main
   ```

   Use a merge, not a rebase, so the next month's merge base is the new upstream head.

3. Resolve conflicts. They concentrate in five files, because that is where our code
   registers with theirs:

   | File | Our change | Resolution |
   |---|---|---|
   | `electron/main.js` | studio registration, `velorn://` handling, window and dialog names | Take upstream's version of the hunk, then re-apply our registration lines and the rename (step 4) |
   | `electron/preload.js` | studio IPC bridge entries | Keep both sides' entries; ours sit in one `studio` block |
   | `electron/mcpServer.js` | bearer authentication, `StorybookStudio` server name, `studio_*` tool registration | Keep upstream's tool list changes; re-apply our auth check and registration call |
   | `src/App.jsx` | StorybookStudio name, studio workspace mount | Take upstream, re-apply the mount and rename |
   | `package.json` | `productName`, `build.protocols`, mac arm64 target, `test`, `test:studio` scripts | Take upstream's dependency and version changes; keep our five edits |

   Any other conflict is almost always the rename. Take upstream's side of the file.

4. Re-apply the rename. Upstream adds new strings every month, so run this over the
   merged tree whether or not git reported a conflict (it is idempotent):

   ```bash
   git grep -l '\bVelorn\b' -- src electron index.html public/lang/lang_en.json public/splash.html \
     | grep -v 'discoverCatalog\|comfyui-injected\|index.css' \
     | xargs perl -pi -e 'next if /github\.com|audio\/Velorn\x27/; s/\bVelorn\b(?! [Bb]ridge)/StorybookStudio/g'
   perl -pi -e 's/Velorn(?!Labs| [Bb]ridge|_)/StorybookStudio/g' public/lang/lang_jp.json
   ```

   Then restore the two strings that code or tests match on, which must keep the upstream
   spelling: the RIFE marker `Velorn secure build: PNG input and output only; WebP is disabled.`
  in `electron/rifeInterpolation.js`. `git diff upstream/main -- electron/rifeInterpolation.js`
   should show no change on the marker line.

5. Verify, in this order:

   ```bash
   npm ci
   npm run test:studio                 # our tests
   npm run test:media-preparation
   npm run check:media-preparation
   npm run test:export-scheduler
   npm run test:rife-hardening
   npm test                            # every test:* script
   npm run build
   ```

   Three media-preparation tests, one RIFE MoltenVK test and the GIF transcode tests
   fail on an unmodified upstream checkout on a developer laptop. Compare against
   `upstream/main` before blaming the merge.

6. Open the PR as `chore(upstream): merge VelornLabs/velorn <short sha> (<version>)`, listing
   the upstream release notes since the last head and every file where a conflict was
   resolved.

## Patches we offer upstream

Both close gaps found in v0.3.36 and are not StorybookStudio-specific, so upstream can
take them and the merge conflict surface shrinks.

1. **MCP bearer authentication.** The local MCP server in `electron/mcpServer.js` accepts
   any request that reaches its port. The patch generates a per-launch token, requires
   `Authorization: Bearer <token>` and shows the token in Settings next to the connect
   commands.
2. **`comfystudio://` path allowlist.** The `comfystudio://` file protocol serves any path
   the renderer asks for. The patch limits it to the open project folder, the media library
   and the app's own resources.

Send each as its own pull request from a branch cut from `upstream/main`, not from our
main, so it carries none of our rename. Once upstream merges one, drop our copy at the
next merge and note it in the table below.

## Merge log

| Date | Upstream head | Version | PR |
|---|---|---|---|
| 2026-10-04 | `fdd8255` | v0.3.36 | fork baseline |
