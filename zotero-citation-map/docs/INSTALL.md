# Installing & developing

## Installing the release build (normal users)

1. Download `citation-map-x.y.z.xpi` from the Releases page.
2. Zotero → **Tools → Plugins** → drag the `.xpi` onto the window
   (or gear menu → *Install Plugin From File…*).
3. Select a collection → **Tools → Show Citation Map**.

Compatible with Zotero 7.0 through 9.x (`strict_max_version: "9.*"` in
`addon/manifest.json` — bump this when Zotero 10 arrives and you've tested).

## Running from source (developers)

Zotero can load the plugin directly from your working copy, so you don't
need to rebuild the XPI after each change:

1. Close Zotero.
2. Find your Zotero **profile directory**
   (Help → More debugging info shows it; typically
   `~/Zotero/Profiles/xxxxxxxx.default` or
   `%APPDATA%\Zotero\Zotero\Profiles\...`).
3. In its `extensions/` folder, create a plain-text file named exactly
   after the plugin ID:

   ```
   citation-map@daniel.dev
   ```

   Its *content* must be the absolute path to this repo's **`addon/`**
   directory (the folder containing `manifest.json`), e.g.

   ```
   /Users/daniel/code/zotero-citation-map/addon/
   ```

4. In the profile's `prefs.js`, delete the lines containing
   `extensions.lastAppBuildId` and `extensions.lastAppVersion`
   (forces Zotero to rescan plugins).
5. Start Zotero. After editing code, disable+enable the plugin in
   Tools → Plugins (or restart) to reload it.

### Useful while developing

- Enable debug output: **Help → Debug Output Logging → View Output**.
  The plugin logs everything with a `[Citation Map]` prefix.
- Start Zotero from a terminal with `-ZoteroDebugText -jsconsole` to get
  a live Error Console.
- The API cache lives at `<Zotero data dir>/citation-map-cache.json`;
  delete it or use Tools → *Citation Map: Clear API Cache* to force
  fresh fetches.

## Packaging a release

```bash
./scripts/build.sh
```

produces `build/citation-map-<version>.xpi` and prints its SHA-256.
To publish with auto-updates:

1. Bump `version` in `addon/manifest.json`.
2. Commit, tag `vX.Y.Z`, push — the GitHub Action builds the XPI and
   attaches it to the release.
3. Update `update.json` (version, `update_link`, `update_hash` with the
   printed SHA-256) and publish it at the URL configured as
   `update_url` in the manifest.
