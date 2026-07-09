# Architecture

The plugin is deliberately dependency-free: plain JavaScript, no bundler,
no third-party graph library. Everything a maintainer needs to read fits
in a handful of files.

```
addon/
├── manifest.json            Plugin identity + Zotero version range
├── bootstrap.js             Lifecycle hooks; loads the modules below
├── prefs.js                 Default preferences
├── locale/en-US/*.ftl       Fluent strings
├── content/
│   ├── graph.css            All UI styles (scoped with .zcm- prefix)
│   └── icons/               Plugin icons
└── modules/                 Loaded into one shared namespace object
    ├── dataSource.js        OpenAlex client + on-disk cache
    ├── publisherCI.js       Journal → publisher brand-identity lookup
    ├── graphBuilder.js      Pure graph logic (edges, discovery, chains)
    ├── graphView.js         Canvas renderer + sidebar + interactions
    └── citationMap.js       Controller: menus, tabs, pipeline, errors
```

## Data flow

```
Zotero items ──DOIs──▶ dataSource.fetchWorksByDOI ──▶ OpenAlex records
                                                          │ referenced_works
                                                          ▼
                       graphBuilder.build ──▶ { nodes, edges, chains, stats }
                                                          │
                                                          ▼
                       graphView (canvas in a Zotero tab) ◀── user
```

1. **citationMap.js** collects the regular items of the selected collection
   (optionally including subcollections) and opens a new Zotero tab with a
   progress screen.
2. **dataSource.js** normalizes each item's DOI and resolves it against the
   OpenAlex `/works?filter=doi:a|b|c` batch endpoint (50 per request,
   ~120 ms pause between batches). Each record is slimmed to the fields we
   need and cached in `citation-map-cache.json` in the Zotero data
   directory with a configurable TTL, so subsequent runs need no network.
3. **graphBuilder.js** turns the records into the graph model:
   - *edges*: a paper's `referenced_works` intersected with the OpenAlex
     IDs of other papers in the collection;
   - *discovery*: `referenced_works` **not** in the collection are tallied;
     any external work cited by ≥ `discoveryThreshold` papers becomes a
     `discovered` node (its metadata fetched in one extra batch), ranked by
     in-collection citation count and capped at `maxDiscovered`;
   - *chains*: longest simple paths via memoized DFS starting from "root"
     nodes (nothing cites them). Citation graphs are effectively acyclic —
     you can only cite what already exists — a visited-set guards against
     metadata cycles anyway. Sub-chains of longer chains are deduplicated.
4. **graphView.js** renders into a `<canvas>`:
   - a small custom force simulation (pairwise repulsion, edge springs,
     centering, friction) — O(n²) per tick, fine for the few hundred nodes
     of a realistic collection;
   - *timeline mode* replaces the centering force with a spring towards
     `x = f(publication_year)`, producing the "year rail";
   - hover focus, selection ring, chain highlighting with an animated dash
     offset, pan/zoom via canvas transform, hit-testing in graph
     coordinates.

## Why inject DOM into the tab instead of an iframe/browser?

The view needs first-class access to the Zotero API ("show in library",
"add by DOI" via `Zotero.Translate.Search`). Rendering directly into the
tab container keeps everything in one process and one document — no
message bridge, no privilege juggling. The cost is discipline: every CSS
rule is scoped under `.zcm-`, and every created element is tracked and
removed on shutdown (a hard requirement for bootstrapped plugins).

## Extension points

- **Another data source** (e.g. Semantic Scholar, Crossref): implement the
  same three methods as `dataSource.js` (`fetchWorksByDOI`,
  `fetchWorksByOpenAlexId`, `normalizeDOI`) returning the same slim record
  shape; nothing else changes.
- **More graph analytics** (co-citation, bibliographic coupling,
  PageRank): add pure functions to `graphBuilder.js`; the view only reads
  the model object.
- **More journal branding**: `publisherCI.js` maps a node's `venue` string
  to a publisher family (brand colour + logo-style font stack + confidence)
  via an ordered table of regex patterns, compiled once at startup and
  memoised per venue. The view calls `PublisherCI.styleFor(venue)` and tints
  the node rim and journal label (canvas, tooltip, details, suggestion rows);
  `onDark()` lightens near-black brand colours so they read on the dark map.
  Add a family by appending one entry to `FAMILIES` — specific/high-confidence
  families go before broad, low-confidence ones (first match wins). Curated
  from `journal_publisher_ci_dataset.json` at the repo root.
- **Localization**: add `addon/locale/<lang>/citation-map.ftl`; menu labels
  are the only strings currently hard-coded in English (see
  `citationMap.js`) and can be switched to Fluent IDs.
