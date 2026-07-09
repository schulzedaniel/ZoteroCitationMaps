# Citation Map for Zotero

An interactive citation network for your Zotero collections. Instead of a flat
list of papers, you get a living map: every paper is a dot, every citation is
an arrow, and the plugin tells you which important papers you are missing.

Works with **Zotero 7, 8, and 9**.

![Concept: ivory dots are your papers, amber dots are suggestions, teal threads are citation chains]

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

Also included: full-text search across titles/authors, a details panel with
venue/author/citation stats, "Show in library" and "Open DOI" shortcuts,
PNG and JSON export, and a local cache so rebuilding a map is instant.

## Installation

1. Download the latest `citation-map-x.y.z.xpi` from the
   [Releases](../../releases) page (or build it yourself, see below).
   *Firefox users:* right-click → "Save Link As…", otherwise Firefox tries to
   install the file into Firefox itself.
2. In Zotero, go to **Tools → Plugins**.
3. Drag the `.xpi` file onto the Plugins window
   (or use the gear menu → **Install Plugin From File…**).
4. Restart is not required — the plugin activates immediately.

## Usage

- Select a collection in the left pane, then **Tools → Show Citation Map**,
  or right-click the collection → **Show Citation Map for This Collection**.
- With no collection selected, the whole library is mapped.
- First run fetches reference lists from OpenAlex (a few seconds per 50
  papers). Results are cached in `citation-map-cache.json` in your Zotero
  data directory; later runs are nearly instant.

### Reading the map

| Element | Meaning |
| --- | --- |
| Ivory dot | Paper in your library |
| Amber dot + halo | Suggested paper (cited by ≥ N of your papers, not in your library) |
| Grey dot | In your library, but no DOI / not found in OpenAlex |
| Arrow | Points from the citing paper to the cited paper |
| Teal dashed thread | A selected citation chain |
| Dot size | How often the paper is cited within this collection |
| Coloured dot outline | The journal's publisher brand colour (e.g. IEEE blue, Lancet red) |

### Controls

Scroll = zoom · drag background = pan · drag dot = pin it ·
click = select · double-click = open in library / on doi.org.

## Configuration

Settings live under `extensions.citation-map.*` in
**Edit → Settings → Advanced → Config Editor**:

| Preference | Default | Meaning |
| --- | --- | --- |
| `discoveryThreshold` | `2` | Min. number of your papers that must cite an external work before it's suggested |
| `maxDiscovered` | `15` | Max. number of suggestions shown |
| `includeSubcollections` | `true` | Map items of subcollections too |
| `minChainLength` | `3` | Min. papers in a highlighted chain |
| `cacheDays` | `30` | Days before cached API data is refreshed |
| `mailto` | `""` | Your e-mail for OpenAlex's "polite pool" (faster API responses; recommended) |
| `journalBranding` | `true` | Tint papers with their journal's publisher brand colour and logo-style font |

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
git clone https://github.com/YOUR_GITHUB_USERNAME/zotero-citation-map.git
cd zotero-citation-map
./scripts/build.sh          # → build/citation-map-1.0.0.xpi
```

No Node.js, no bundler, no dependencies — the plugin is plain JavaScript.

## Privacy

The plugin sends only the **DOIs** of the mapped items to the OpenAlex API
(api.openalex.org) to retrieve reference lists. Nothing else leaves your
machine; there is no telemetry. All responses are cached locally.

## Limitations

- Items without a DOI (books, reports, old scans) appear as grey dots without
  citation links. Tip: many can be fixed by adding the DOI to the item.
- OpenAlex coverage is excellent for journals but thinner for some
  conferences and preprints; a missing edge usually means missing metadata,
  not a missing citation.
- Very large selections (1000+ items) work, but layout gets crowded —
  mapping per collection is the intended workflow.

## License

MIT — see [LICENSE](LICENSE).
