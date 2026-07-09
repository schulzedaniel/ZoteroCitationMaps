# Changelog

## 1.6.0

- Journal branding: papers are now tinted with their journal's own corporate
  identity, so you can tell where a paper was published at a glance. The dot's
  outline takes the publisher's brand colour and the journal name is rendered
  in a matching logo-style typeface (with a web-safe fallback) wherever it
  appears — tooltips, the details panel and suggestion rows. The details panel
  also names the recognised publisher family and gains a brand accent stripe.
- Ships a lookup table of ~22 publisher families (Nature, Cell Press, The
  Lancet, Science/AAAS, NEJM, JAMA, IEEE, ACM, ACS, arXiv, PLOS, Frontiers,
  MDPI, PNAS, RSC, APS, BMC, AACR, Oxford University Press, and the
  best-effort Wiley/Springer cases), matched by journal-name patterns and
  loaded once at startup. Unknown journals keep the neutral house style rather
  than guessing; publishers without one unified identity are flagged as a
  best-effort visual cue. No logos are downloaded — only colour + font cues.
- New `journalBranding` preference (default on) turns the tinting off for a
  fully neutral look. Add a new publisher family by editing the single table
  in `modules/publisherCI.js`.

## 1.5.0

- The network layout now reflects citation structure. Papers are grouped
  into connected citation clusters; each cluster is laid out around its own
  centre so a well-cited hub sits in the middle with its citing papers
  around the edge (instead of position being meaningless). A leaf paper
  that only cites one work now clearly sits at the rim next to that work.
- Separate citation groups form distinct "islands": a pair of papers that
  only cite each other becomes its own little island next to the main
  network, and papers with no citation links gather in a tidy block off to
  the side rather than cluttering the centre. Repulsion now acts only
  within a cluster, so islands stay cleanly separated (and it's faster).
- Fit-to-view shows every island, and can zoom out further to frame a wide
  field of them.

## 1.4.0

- No more wobble: the network layout is now computed to rest off-screen
  before the first frame, so the map appears already settled and then
  holds completely still (the animation loop redraws only when something
  actually changes). Bigger spacing between papers (stronger repulsion,
  longer edges, more collision padding)
- Timeline completely redesigned. Instead of a linear year axis that
  crushed recent years together, papers are now laid out as one column
  per publication year, oldest on the left — so you can see at a glance
  what came first. Busier years get wider blocks and empty years are
  skipped, so a run of 2020-2026 spreads into readable columns ("little
  sub-maps") instead of a single jammed stripe. Year headers are evenly
  spaced (no more overlapping numbers), with alternating column shading
  and an older→newer hint. The timeline is a fixed grid, so it never wobbles

## 1.3.0

- Layout engine reworked for calm, robust behavior on any collection size:
  deterministic spiral starting positions (identical on every rebuild),
  much softer springs, stronger damping, a speed limit and faster cooling
  (no more wobble), distances that scale with node count, and dot-collision
  handling in both modes (no more overlapping piles)
- Suggestions on the map are now controllable: a toolbar toggle chooses
  Off / Top (default — only the strongest few, drawn softly) / All, and a
  ×2/×3/×4 strength filter in the sidebar sets the cutoff. The sidebar
  always lists everything that passes the filter; clicking a hidden
  suggestion or a chain through one reveals it on the map
- Readability: label budget (only the most-cited papers are labelled when
  zoomed out, more appear as you zoom), text halos behind labels, dark
  rims around dots, fainter edges on dense graphs, and alternating period
  bands in timeline mode

## 1.2.1

- Fixed: shortly after the map formed it jumped to a tiny blob in a corner.
  Papers without citation links drifted far from the cluster and the
  fit-to-view framed them all. Isolated papers now stay ringed around the
  cluster (with a hard position cap), and fit-to-view frames the central
  90% of dots instead of the extremes; it also no longer runs while the
  tab is hidden

## 1.2.0

- Gentler zoom steps, and pan/zoom is now clamped so the map can never be
  lost off-screen; the view auto-fits once the initial layout settles
- Floating map controls: zoom in/out, ⌂ fit-to-view ("home"), and a ? guide
  that explains dots, arrows, suggestions, chains and timeline (auto-opens
  on first use; double-clicking the background also re-fits the view)
- Tooltips now show everything at a glance: authors, journal, year,
  worldwide citations, in-collection citations, and what the dot's color means
- Journal and worldwide citation counts shown in tooltips, the details
  panel and suggestion rows
- Notes preview: selecting a paper shows its Zotero/Better Notes child
  notes in a scrollable card in the sidebar, with prev/next paging and an
  "Open note in Zotero" button
- Citation chains are easier to understand: clicking a chain expands the
  full step list (oldest → newest) in the sidebar, and numbered teal
  badges mark each step on the map
- Better suggestions: junk records are filtered out, ties are broken by
  worldwide citations, and works that are actually in your library (but
  failed DOI resolution) are linked into the map instead of suggested
- Timeline mode reworked: dots no longer pile on top of each other
  (collision layout), papers without a year go to an "undated" gutter, and
  switching modes re-frames the view

## 1.1.2

- Fixed: opening the map tab crashed on Zotero 9 ("can't access property
  'icon', tab.data is undefined") — Zotero 9's tab bar requires a `data`
  object when adding a tab

## 1.1.1

- Instant feedback: clicking the toolbar button (or menu items) now shows a
  "Collecting items…" popup immediately, before any work starts
- Every failure now surfaces as an error dialog and is written to
  Help → Debug Output with a `[Citation Map]` prefix (open(), item
  collection, tab creation — nothing can fail silently anymore)

## 1.1.0

- Fixed: opening the map for a (sub)collection silently did nothing when
  Zotero had not yet loaded that collection's item list — child items are
  now loaded explicitly, and any remaining error is shown instead of
  swallowed
- New: toolbar button in the items toolbar (next to "Add Item by
  Identifier") that maps the current collection, or the selected items
  when two or more are selected
- Items appearing in several subcollections are now deduplicated

## 1.0.0 — initial release

- Interactive citation map of any collection (or the whole library) in a Zotero tab
- Discovery engine: suggests external papers cited by ≥ N of your papers, one-click import by DOI
- Citation chain detection with animated highlighting
- Timeline ("year rail") layout mode
- Search, focus-on-hover, pan/zoom, node pinning, PNG/JSON export
- Local OpenAlex cache with configurable TTL
