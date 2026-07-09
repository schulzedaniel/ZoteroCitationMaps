# Citation Map for Zotero

![Version](https://img.shields.io/badge/version-1.8.1-blue)
![Zotero 7–9](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209-CC2936)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

An interactive citation network for your Zotero collections. Instead of a flat
list of papers, you get a living map: every paper is a dot, every citation is
an arrow, and the plugin tells you which important papers you are missing.

Works with **Zotero 7, 8, and 9**.

![Concept: ivory dots are your papers, amber dots are suggestions, teal threads are citation chains]
<!-- NOTE: keep your existing screenshot/image line here — the path was not visible when regenerating this file -->

## ⬇️ Download & install

[![Download the latest release](https://img.shields.io/badge/Download-latest%20release-CC2936?style=for-the-badge&logo=zotero&logoColor=white)](https://github.com/schulzedaniel/ZoteroCitationMaps/releases/latest)

**Three steps, about 30 seconds — no account, nothing to configure:**

1. **Click the red button above.** It always opens the newest release — grab
   the `citation-map-*.xpi` file listed under **Assets**.
   *Using Firefox?* Right-click the `.xpi` link → **"Save Link As…"**,
   otherwise Firefox tries to install the file into itself.
2. In Zotero, open **Tools → Plugins**.
3. **Drag the downloaded `.xpi` onto the Plugins window** — or use the
   gear (⚙) menu → **Install Plugin From File…** and pick the file.

That's it. The plugin activates immediately; no restart needed. You can also
[build it from source](#building-from-source).

## What it does

**1. Draws a citation map.**
Open any collection and see which of your papers cite which. Node size shows
how often a paper is cited *within your own collection* — the biggest dots are
the foundational works of your reading list. Hover to focus a paper and its
neighbors; drag dots to pin them; scroll to zoom.

**2. Discovers papers you should probably read.**
The plugin reads the full reference list of every paper in the collection
(via the open OpenAlex index). When several of your papers all cite the same
*external* work you don't have, it appears on the map as an amber dot with a
`×N` badge ("cited by N of your papers"). One click adds it to your Zotero
collection via its DOI.

**3. Traces citation chains.**
Paper A cited Paper B, which cited Paper C… The sidebar lists the longest
chains found in your collection; clicking one lights it up as an animated teal
thread across the map, with the year span shown (e.g. `1998 → 2024`).

**4. Timeline mode ("year rail").**
Switch from the free-form network to a chronological layout where every paper
snaps to its publication year on a horizontal axis — you can literally watch
ideas flow left-to-right through the decades.

**5. Recognises journals by their branding.**
Each paper is tinted with its journal's own corporate identity — the dot's
outline takes the publisher's brand colour and the journal name is shown in a
matching logo-style typeface (Nature, Cell, The Lancet, IEEE, JAMA, PLOS, ACS,
MDPI and ~20 more) — so you can spot where a paper was published at a glance.
Unknown journals keep a neutral style; no logos are downloaded, only colour
and font cues. Turn it off with the `journalBranding` setting.
See [Trademarks & affiliation](#trademarks--affiliation) below.

Also included: full-text search across titles/authors, a details panel with
venue/author/citation stats, "Show in library" and "Open DOI" shortcuts,
PNG and JSON export, and a local cache so rebuilding a map is instant.

## Usage

- Select a collection in the left pane, then **Tools → Show Citation Map**,
  or right-click the collection → **Show Citation Map for This Collection**.
- With no collection selected, the whole library is mapped.
- If the collection has **subcollections**, the map asks once which of them to
  include (all, only the top collection, or any mix). Your choice is
  remembered per collection and can be changed anytime from the
  **Subfolders** control in the toolbar.
- First run fetches reference lists from OpenAlex (a few seconds per 50
  papers). Results are cached in `citation-map-cache.json` in your Zotero
  data directory; later runs are nearly instant.
- **Import/export:** save a map with **Export JSON** in the toolbar, and
  reopen it with **Import JSON** (also in the toolbar, or **Tools → Import
  Citation Map (JSON)…**) — no re-fetching. On import you can optionally
  create a new Zotero collection (placed anywhere you pick in the
  library/collection tree) and add the map's papers to your library by DOI.

### Reading the map

| Element              | Meaning                                                            |
| -------------------- | ------------------------------------------------------------------ |
| Ivory dot            | Paper in your library                                              |
| Amber dot + halo     | Suggested paper (cited by ≥ N of your papers, not in your library) |
| Grey dot             | In your library, but no DOI / not found in OpenAlex                |
| Arrow                | Points from the citing paper to the cited paper                    |
| Teal dashed thread   | A selected citation chain                                          |
| Dot size             | How often the paper is cited within this collection                |
| Coloured dot outline | The journal's publisher brand colour (e.g. IEEE blue, Lancet red)  |

### Controls

Scroll = zoom · drag background = pan · drag dot = pin it ·
click = select · double-click = open in library / on doi.org.

## Configuration

Settings live under `extensions.citation-map.*` in
**Edit → Settings → Advanced → Config Editor**:

| Preference              | Default | Meaning                                                                           |
| ----------------------- | ------- | --------------------------------------------------------------------------------- |
| `discoveryThreshold`    | `2`     | Min. number of your papers that must cite an external work before it's suggested  |
| `maxDiscovered`         | `15`    | Max. number of suggestions shown                                                  |
| `includeSubcollections` | `true`  | Default for the subcollection picker (`true` = start with all subfolders checked) |
| `subScopes`             | `{}`    | Remembered per-collection subcollection choice (managed by the picker)            |
| `minChainLength`        | `3`     | Min. papers in a highlighted chain                                                |
| `cacheDays`             | `30`    | Days before cached API data is refreshed                                          |
| `mailto`                | `""`    | Your e-mail for OpenAlex's "polite pool" (faster API responses; recommended). Optional — see [Privacy](#privacy). |
| `journalBranding`       | `true`  | Tint papers with their journal's publisher brand colour and logo-style font       |

**Tools → Citation Map: Clear API Cache** wipes the local cache.

## How it works

Zotero stores your papers' metadata but not their reference lists, so the
plugin resolves each item's DOI against [OpenAlex](https://openalex.org),
a free and open scholarly index, and reads the `referenced_works` of every
paper. From that single dataset it derives:

- **edges** — references that point at another paper in your collection;
- **suggestions** — external works cited by ≥ threshold of your papers;
- **chains** — longest citation paths, found with a memoized DFS
  (citation graphs are effectively acyclic, so this is fast).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the module layout,
and [`docs/INSTALL.md`](docs/INSTALL.md) for a development setup
(running the plugin from source with hot reload of your edits).

## Building from source

```bash
git clone https://github.com/schulzedaniel/ZoteroCitationMaps.git
cd ZoteroCitationMaps/zotero-citation-map   # the plugin lives in this subfolder
./scripts/build.sh                          # → build/citation-map-1.8.1.xpi
```

No Node.js, no bundler, no dependencies — the plugin is plain JavaScript.

## Privacy

The plugin is designed to be as private as possible. In short: **everything
runs and stays on your machine, and the developer receives no data at all.**

**What is sent, and to whom.** To retrieve reference lists, the plugin sends
the **DOIs** of the mapped items from *your* computer directly to the
**OpenAlex API** (`api.openalex.org`), operated by
[OurResearch](https://ourresearch.org), a US-based non-profit. As with any
internet request, OpenAlex's servers technically receive your **IP address**
when your computer contacts them. Because OurResearch is based in the United
States, these requests may be processed outside the EU/EEA. See the
[OpenAlex/OurResearch privacy policy](https://openalex.org/) for how they
handle requests. DOIs identify published papers, not you.

**Optional e-mail (`mailto`).** If you enter an e-mail address in the
`mailto` setting, it is included in your API requests so OpenAlex can place
you in its faster "polite pool". This is entirely **optional and off by
default** — the plugin works without it. If you set it, your e-mail address
is transmitted to OpenAlex with each request; remove the setting at any time
to stop this.

**Local data.** API responses are cached in `citation-map-cache.json` inside
your Zotero data directory, on your machine only. You can delete it at any
time via **Tools → Citation Map: Clear API Cache** or by removing the file.
Exported PNG/JSON files are created only where you choose to save them.

**What is never collected.** The plugin contains **no telemetry, no
analytics, no crash reporting, no accounts, and no tracking** of any kind.
The developer never receives your library contents, your queries, or any
personal data. Nothing other than the requests to OpenAlex described above
ever leaves your machine.

**Data controller note.** The plugin runs locally under your control and the
developer processes no personal data. For questions about this plugin,
contact the author via the
[project repository](https://github.com/schulzedaniel/ZoteroCitationMaps/issues).

## Disclaimer & liability

This is free, open-source software provided under the MIT License **"as is",
without warranty of any kind** (see [LICENSE](LICENSE)). To the extent
permitted by applicable law, the author accepts no liability for damages
arising from the use of this software; nothing in this section excludes or
limits liability that cannot be excluded under applicable law (e.g. liability
for intent or gross negligence under German law).

Practical notes:

- The plugin only **reads** your Zotero items and **adds** items you
  explicitly click to add; it never deletes or modifies existing items.
  Nevertheless, back up your Zotero library regularly — as you should anyway.
- Citation data comes from OpenAlex and may be incomplete or contain errors
  (see [Limitations](#limitations)). The map is a research aid, not a
  guarantee of bibliographic completeness or accuracy.
- The OpenAlex API is a free third-party service outside the author's
  control; its availability, coverage, and terms may change at any time.

## Trademarks & affiliation

- This is an independent, community-developed plugin. It is **not
  affiliated with, endorsed by, or sponsored by Zotero** or its developer,
  the Corporation for Digital Scholarship. "Zotero" is a trademark of the
  Corporation for Digital Scholarship; it is used here only to describe
  compatibility ("for Zotero").
- The plugin is likewise **not affiliated with or endorsed by OpenAlex /
  OurResearch**. OpenAlex is used as a public data source; its metadata is
  released under CC0.
- Journal and publisher names shown by the *journal branding* feature
  (e.g. Nature, Cell, The Lancet, IEEE, JAMA, PLOS, ACS, MDPI) are
  trademarks of their respective owners. The feature uses generic colour and
  typeface cues **solely to identify the venue a paper was published in**
  (nominative/descriptive use). No logos are used or downloaded, and no
  affiliation with or endorsement by any publisher is implied. The feature
  can be disabled via the `journalBranding` setting.
- This plugin is **not affiliated with any other citation-mapping product or
  service**; any similarity in purpose reflects the shared, public nature of
  citation data.

## Contributing

Bug reports and pull requests are welcome! By submitting a contribution
(e.g. a pull request), you agree that your contribution is your own work,
that you have the right to submit it, and that it is **licensed to the
project under the same MIT License** that covers the project
("inbound = outbound"). This keeps the licensing of the project simple and
unambiguous for everyone.

## Limitations

- Items without a DOI (books, reports, old scans) appear as grey dots without
  citation links. Tip: many can be fixed by adding the DOI to the item.
- OpenAlex coverage is excellent for journals but thinner for some
  conferences and preprints; a missing edge usually means missing metadata,
  not a missing citation.
- Very large selections (1000+ items) work, but layout gets crowded —
  mapping per collection is the intended workflow.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history
(current release: **1.8.1**).

## Author

Created and maintained by **Daniel Schulze**
([@schulzedaniel](https://github.com/schulzedaniel)). Bug reports and pull
requests are welcome on the
[project repository](https://github.com/schulzedaniel/ZoteroCitationMaps).

## License

MIT © 2026 Daniel Schulze — see [LICENSE](LICENSE).

Data retrieved from [OpenAlex](https://openalex.org) is available under
[CC0](https://creativecommons.org/publicdomain/zero/1.0/). Thanks to the
OpenAlex / OurResearch team for providing an open scholarly index.
