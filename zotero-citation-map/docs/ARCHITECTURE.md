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
   need (including `topics`, `keywords`, `related_works`, `open_access`)
   and cached in `citation-map-cache.json` in the Zotero data directory
   with a configurable TTL, so subsequent runs need no network. The cache
   carries a `CACHE_VERSION`; bumping it (when the slim shape changes)
   discards stale records while keeping the per-collection build
   *snapshots* used for "new since last build" diffs. Two more fetchers
   serve the Discover search: `fetchCitingWorks` (`filter=cites:…`,
   forward citations) and `fetchWorksByTopics` (`filter=topics.id:…`).
3. **graphBuilder.js** turns the records into the graph model:
   - *edges*: a paper's `referenced_works` intersected with the OpenAlex
     IDs of other papers in the collection;
   - *profile*: aggregated OpenAlex topics/keywords of the collection plus
     RAKE-style terms extracted **locally** from titles/abstracts/tags
     (`_buildProfile` / `_extractTerms`; the local terms are never
     transmitted);
   - *discovery*: `referenced_works` **not** in the collection are tallied;
     any external work cited by ≥ `discoveryThreshold` papers becomes a
     `discovered` node (its metadata fetched in one extra batch), ranked by
     in-collection citation count **plus topic overlap with the profile**
     (`_topicSim`) and capped at `maxDiscovered`;
   - *chains*: longest simple paths via memoized DFS starting from "root"
     nodes (nothing cites them). Citation graphs are effectively acyclic —
     you can only cite what already exists — a visited-set guards against
     metadata cycles anyway. Sub-chains of longer chains are deduplicated;
   - *coupling*: pairs of library papers sharing ≥ 2 references
     (bibliographic coupling; the view filters by the user's threshold);
   - *what's new*: `snapshotOf`/`markNew` diff a build against the stored
     snapshot so the view can flag changes;
   - *discover search*: `searchNewPapers` (called on demand from the view)
     merges three ranked sources — forward citations, topic search,
     related works — into explainable result entries.
4. **graphView.js** renders into a `<canvas>`:
   - a small custom force simulation (pairwise repulsion, edge springs,
     centering, friction) — O(n²) per tick for typical collections, with a
     uniform spatial hash (`_forEachClosePair`) taking over repulsion and
     collision above ~150–200 nodes so large maps stay responsive;
   - *timeline mode* replaces the centering force with a spring towards
     `x = f(publication_year)`, producing the "year rail";
   - *color modes* (`_nodeFill`): `kind` (the neutral default — by paper
     type), publisher rims, year gradient, cluster palette or open-access
     status, with an adaptive, tooltipped toolbar legend (`_renderLegend`),
     plus auto-labelled islands (`_clusterLabel`), an optional dashed
     coupling layer, and gold ★ markers on nodes new since the last build;
   - *floating details card* (`_buildDetailCard`): a draggable card over the
     stage that `_renderDetails`/`_renderNotes` fill on selection, so the
     sidebar lists never reflow;
   - *sidebar collapse/resize* (`_buildSidebarResizer`, `_setSidebarCollapsed`,
     `sidebarWidth`/`sidebarCollapsed` prefs) with the structural width still
     asserted inline in `_applyLayoutStyles`;
   - *Discover injection is reversible*: `_injectSearchResult` /
     `_removeInjected` / `_clearInjected` add and cleanly remove
     search-found nodes (and their edges) from the live graph;
   - *sidebar tabs*: Suggested (`_buildSuggestedPanel`, offline, from the
     collection's own citations) and Discover (`_buildDiscoverPanel` →
     `_buildDiscoverCard`, the live OpenAlex search) are separate tabs; the
     Display popover previews each color mode with `_modeSwatch`;
   - the *Discover* card (its own tab) drives
     `GraphBuilder.searchNewPapers` and can inject results into the live
     graph (`_injectSearchResult`) with a violet halo;
   - *guided tours*: a fresh install gets the full first-run tour
     (`_showTour`); an upgrader gets a one-time "what's new" walkthrough
     (`_showWhatsNew`) built from a version-keyed registry
     (`_whatsNewRegistry`, keyed by `major.minor`). Gating compares the
     `lastSeenVersion` pref (captured as `_prevSeenVersion` before it is
     stamped) against the current version, so a release only needs to
     append one `{ since, steps }` entry to teach upgraders its new
     features, and people who skip releases catch up on all of them;
   - *review filter*: `GraphBuilder.isReviewRecord` flags reviews /
     meta-analyses (OpenAlex `type === "review"` plus a targeted title
     pattern); each node/record carries `isReview`. The toolbar toggle sets
     `hideReviews`, and `_hiddenFromMap` / `_applyReviewVisibility` exclude
     reviews from the map (draw, hit-test, forces, fit) and from the
     Suggested / Discover / My papers lists in one place;
   - hover focus, selection ring, chain highlighting with an animated dash
     offset, pan/zoom via canvas transform, hit-testing in graph
     coordinates; year/tag filters dim non-matching nodes without touching
     the layout.

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
