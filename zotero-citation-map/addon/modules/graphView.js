/**
 * graphView.js, the interactive map itself.
 *
 * The view is plain DOM + <canvas>, injected directly into a Zotero tab
 * (no remote browser, no external libraries), so it has direct access to
 * the Zotero API for "select item" / "add by DOI" actions.
 *
 * Structure (design system v2.0 "Clear", see content/styles/):
 *   ┌ toolbar (48px, one row) ──────────────────────────────┐
 *   │ brand · collection · layout · search … filter ·       │
 *   │ display · rebuild · more                              │
 *   ├ filter bar (36px, only while a filter is active) ─────┤
 *   ├───────────────────────────────┬───────────────────────┤
 *   │                               │ sidebar               │
 *   │        <canvas> map           │  tabs: Suggested ·    │
 *   │                               │  Discover · Chains ·  │
 *   │                               │  Mine, or the paper   │
 *   ├ legend (footer strip) ────────┤  inspector            │
 *   ├───────────────────────────────┴───────────────────────┤
 *   │ status bar (28px): counts · layout · Shortcuts        │
 *   └───────────────────────────────────────────────────────┘
 *
 * Styling: every colour, size and font is a token (tokens.css) used by
 * components.css / graph.css; the canvas reads the mirrored palette from
 * modules/mapTheme.js. Light, dark or following Zotero ("auto").
 *
 * Rendering: custom force-directed layout (O(n²) repulsion per tick,
 * fine for the ≤ few hundred nodes of a typical collection), with a
 * "timeline" mode that pins x to publication year.
 *
 * Loaded into the CitationMap namespace (`this` === CitationMap).
 */

/* global Zotero */

// `this` is the shared CitationMap namespace while this script loads;
// capture it so methods can reach sibling modules (e.g. PublisherCI).
const ZCM_VIEW_NS = this;

this.GraphView = class {
  /**
   * @param {Document} doc  - the Zotero main-window document
   * @param {Element} container - the tab container to render into
   * @param {object} graph - model from GraphBuilder.build()
   * @param {object} ctx   - { collectionName, collectionID, rebuild() }
   */
  constructor(doc, container, graph, ctx) {
    this.doc = doc;
    this.win = doc.defaultView;
    this.container = container;
    this.graph = graph;
    this.ctx = ctx;

    // "force" | "timeline". The network layout always settles first (so
    // switching to it later glides to stable islands); the map then opens in
    // the remembered layout, the timeline by default.
    this.mode = "force";
    this._initialMode =
      Zotero.Prefs.get("extensions.citation-map.layoutMode", true) === "force"
        ? "force"
        : "timeline";
    // what a paper's HEIGHT means in the timeline: "global" = citations
    // worldwide, "local" = how many papers on this map cite it
    this.yMetric =
      Zotero.Prefs.get("extensions.citation-map.timelineMetric", true) === "local"
        ? "local"
        : "global";
    // how suggested papers appear on the map: "off" | "top" | "all"
    this.suggestDisplay =
      Zotero.Prefs.get("extensions.citation-map.suggestDisplay", true) || "top";
    this.suggestMinCiters =
      Zotero.Prefs.get("extensions.citation-map.suggestMinCiters", true) || 2;
    this.suggestTopCount =
      Zotero.Prefs.get("extensions.citation-map.suggestTopCount", true) || 4;
    // user-tunable scales (percent), remembered across sessions:
    // distance between papers and thickness of the citation lines. Spacing is
    // floored at 75% (an old saved 50 would be tighter than the slider now
    // allows), so the tightest map still has room to breathe.
    this.spacingPct = Math.max(
      75,
      parseInt(Zotero.Prefs.get("extensions.citation-map.nodeSpacing", true), 10) ||
        100
    );
    this.edgeWidthPct =
      parseInt(Zotero.Prefs.get("extensions.citation-map.edgeWidth", true), 10) ||
      100;
    // what the dot colors encode: kind (default) | publisher | year | cluster | oa
    this.colorMode =
      Zotero.Prefs.get("extensions.citation-map.colorMode", true) || "kind";
    // bibliographic-coupling overlay (dashed "sibling paper" links)
    this.showCoupling = !!Zotero.Prefs.get(
      "extensions.citation-map.showCoupling",
      true
    );
    this.couplingMin =
      Zotero.Prefs.get("extensions.citation-map.couplingMinShared", true) || 3;
    // what scrolling over the map does: "auto" (a trackpad's two-finger
    // slide moves the map, a mouse wheel zooms), "zoom" or "pan"
    this.scrollGesture =
      Zotero.Prefs.get("extensions.citation-map.scrollGesture", true) || "auto";
    if (!["auto", "zoom", "pan"].includes(this.scrollGesture)) this.scrollGesture = "auto";
    // map filters (dim non-matching papers; null = inactive)
    this.filterYearFrom = null;
    this.filterYearTo = null;
    this.filterTag = null;
    // hide review / secondary-literature articles everywhere
    this.hideReviews = !!Zotero.Prefs.get(
      "extensions.citation-map.hideReviews",
      true
    );
    // sidebar collapse state (width lives in the sidebarWidth pref)
    this._sidebarCollapsed = !!Zotero.Prefs.get(
      "extensions.citation-map.sidebarCollapsed",
      true
    );
    this.selected = null; // node key
    this.hovered = null;
    this.activeChain = null; // array of keys
    this.query = "";
    this.transform = { x: 0, y: 0, k: 1 }; // pan/zoom
    this.dashOffset = 0;
    this._destroyed = false;
    this._didInitialFit = false; // auto-fit once the layout settles
    this._autoFit = true; // keep the whole map framed until the user zooms/pans
    // canvas palette for the current theme; _initTheme() (called from
    // _buildDOM) resolves the Appearance setting and swaps it
    this.T = ZCM_VIEW_NS.MapTheme.MAP_THEME.light;
    this.appearance = "auto";

    this._prepare();
    this._buildDOM();
    this._initSimulation();
    // Settle the layout off-screen so the map appears already calm and
    // then stays still, no multi-second live "wobble" every time.
    this._preSettle();
    this._compactIslands();
    if (this._initialMode === "timeline") {
      this._setMode("timeline", { instant: true, persist: false });
    }
    this._fitView();
    this._dirty = true;
    this._animate();

    // Network health from the build phase, as a dismissible banner, so the
    // user knows WHY things were slow or incomplete.
    if (this.ctx && this.ctx.netState === "offline") {
      this._showNotice(
        "You appear to be offline, this map was built from cached data, " +
          "so some citation links or suggestions may be missing. Rebuild " +
          "once you're connected.",
        "warn"
      );
    } else if (this.ctx && this.ctx.netState === "slow") {
      this._showNotice(
        "Your internet connection seems slow, first-time fetches may take " +
          "a while. Everything is cached, so the next build of this " +
          "collection will be nearly instant.",
        "warn"
      );
    } else if (this.ctx && this.ctx.netMessage) {
      // refused (daily budget / API key) or an OpenAlex server error
      const n = this._showNotice(
        this.ctx.netMessage + " Some papers or suggestions may be missing.",
        "warn"
      );
      if (n && this.ctx.netState === "limited") {
        n._body.appendChild(
          this.constructor.apiKeyForm(this.doc, () => this.ctx.rebuild())
        );
      }
    }

    // Whether the toolbar scope control should pulse once the walkthrough
    // (if any) has closed.
    this._pendingScopeHint = !!(
      this.ctx &&
      this.ctx.subInfo &&
      this.ctx.subInfo.firstTime
    );

    // The first-run tour / upgrader "What's new" walkthrough is anchored to
    // real toolbar and sidebar elements, so it must wait until the tab has
    // actual on-screen dimensions, opening it during construction (before
    // layout) positioned everything against 0×0 rectangles and dimmed the
    // whole view. _openIntroWhenReady polls briefly, then runs it (or, if
    // the tab never sizes, falls back to the scope hint + advice).
    const version = (ZCM_VIEW_NS && ZCM_VIEW_NS.version) || "0.0";
    const seen =
      Zotero.Prefs.get("extensions.citation-map.lastSeenVersion", true) || "";
    // remembered before we stamp the current version below, so the upgrader
    // walkthrough can show exactly the features new SINCE this version.
    this._prevSeenVersion = seen;
    let intro = null;
    if (!Zotero.Prefs.get("extensions.citation-map.tourShown", true)) {
      intro = "tour";
    } else if (this._featureVersion(seen) < this._featureVersion(version)) {
      intro = "whatsnew";
    }
    if (intro) {
      try {
        Zotero.Prefs.set("extensions.citation-map.tourShown", true, true);
        Zotero.Prefs.set(
          "extensions.citation-map.lastSeenVersion",
          version,
          true
        );
      } catch (e) {
        /* pref write is best-effort */
      }
      this._openIntroWhenReady(intro);
    } else {
      // No walkthrough: run the follow-ups (scope nudge, sparse-map advice)
      // straight away.
      this._afterWalkthrough();
    }
  }

  /**
   * Wait for the tab to have real dimensions, then open the requested
   * walkthrough. Retries a handful of times (the tab is often 0×0 for the
   * first frames after creation); gives up gracefully so the follow-ups
   * still run even if the tab never sizes.
   */
  _openIntroWhenReady(which, attempt = 0) {
    if (this._destroyed) return;
    const rect = this.root && this.root.getBoundingClientRect();
    const ready = rect && rect.width > 120 && rect.height > 120;
    if (ready) {
      if (which === "tour") this._showTour();
      else this._showWhatsNew();
      return;
    }
    if (attempt >= 12) {
      // Tab never sized (hidden?); skip the anchored tour but keep the
      // helpful follow-ups.
      this._afterWalkthrough();
      return;
    }
    this.win.setTimeout(() => this._openIntroWhenReady(which, attempt + 1), 250);
  }

  /** "1.9.0" -> 1009, feature releases (major.minor) gate the overlay. */
  _featureVersion(v) {
    const m = /^(\d+)\.(\d+)/.exec(String(v || ""));
    return m ? parseInt(m[1], 10) * 1000 + parseInt(m[2], 10) : 0;
  }

  // ================================================================ model

  _prepare() {
    const g = this.graph;
    g.coupling = g.coupling || [];
    this.nodeByKey = new Map(g.nodes.map((n) => [n.key, n]));
    // adjacency for hover highlighting
    this.neighbors = new Map();
    for (const e of g.edges) {
      if (!this.neighbors.has(e.source)) this.neighbors.set(e.source, new Set());
      if (!this.neighbors.has(e.target)) this.neighbors.set(e.target, new Set());
      this.neighbors.get(e.source).add(e.target);
      this.neighbors.get(e.target).add(e.source);
    }
    // Hubs first: they seed the center of the layout and get label
    // priority; small nodes are drawn last, i.e. on top, so they stay
    // hoverable next to big neighbors.
    g.nodes.sort((a, b) => b.inLibraryCitations - a.inLibraryCitations);

    // Distances scale with collection size, so large graphs get room
    // instead of piling up; the user's Spacing slider multiplies on top.
    this.layoutScale =
      Math.max(1, Math.sqrt(g.nodes.length / 80)) * (this.spacingPct / 100);

    g.nodes.forEach((n, i) => {
      // node radius: base + in-library citations (how central it is to YOU).
      // A slightly larger base keeps dots readable when the map is zoomed out
      // to show several islands.
      n.r = ZCM_VIEW_NS.MapTheme.MAP_THEME.geometry.nodeRadius(
        n.inLibraryCitations || 0
      );
      n._rank = i; // label priority (0 = most cited)
      n.vx = 0;
      n.vy = 0;
    });

    // Group papers into connected citation clusters and lay each cluster
    // out as its own island, so the map reflects citation structure:
    // a paper that only cites one other sits at the edge of its little
    // group, and a pair that cites only each other becomes an island of
    // its own next to the main network.
    this._layoutIslands();

    const years = g.nodes.map((n) => n.year).filter(Boolean);
    this.yearMin = years.length ? Math.min(...years) : 1990;
    this.yearMax = years.length ? Math.max(...years) : new Date().getFullYear();
    if (this.yearMax === this.yearMin) this.yearMax++;

    this._applySuggestionVisibility(false);
  }

  /**
   * Partition the graph into connected citation clusters ("islands") and
   * assign every node a fixed anchor:
   *   - each multi-paper cluster gets its own packed anchor; the force
   *     step lays the cluster out around it (hubs land in the middle,
   *     leaves at the edge, so structure is visible);
   *   - papers with no citation links are gathered into one tidy grid off
   *     to the side rather than scattered as noise.
   * Clusters repel only within themselves and sit at well-separated
   * anchors, so islands stay distinct and the layout never wobbles.
   */
  _layoutIslands() {
    const nodes = this.graph.nodes;
    const ls = this.layoutScale;

    // --- connected components via union-find (edges treated undirected)
    const parent = new Map();
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));
        x = parent.get(x);
      }
      return x;
    };
    // Islands come from links between YOUR papers only: a suggestion (most
    // are hidden) cited by two of your papers must not weld them into one
    // island with no visible line between them.
    const isSugg = (key) => {
      const n = this.nodeByKey.get(key);
      return !!n && n.kind === "discovered";
    };
    for (const n of nodes) parent.set(n.key, n.key);
    for (const e of this.graph.edges) {
      if (!parent.has(e.source) || !parent.has(e.target)) continue;
      if (isSugg(e.source) || isSugg(e.target)) continue;
      const ra = find(e.source);
      const rb = find(e.target);
      if (ra !== rb) parent.set(ra, rb);
    }
    const groups = new Map();
    for (const n of nodes) {
      if (n.kind === "discovered") continue;
      const r = find(n.key);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(n);
    }
    // ...and each suggestion rests on the biggest island among its citers.
    const citersOf = new Map();
    for (const e of this.graph.edges) {
      if (!isSugg(e.target) || isSugg(e.source)) continue;
      if (!citersOf.has(e.target)) citersOf.set(e.target, []);
      citersOf.get(e.target).push(e.source);
    }
    for (const n of nodes) {
      if (n.kind !== "discovered") continue;
      let best = null;
      for (const c of citersOf.get(n.key) || []) {
        const r = find(c);
        if (groups.has(r) && (!best || groups.get(r).length > groups.get(best).length)) {
          best = r;
        }
      }
      if (best) groups.get(best).push(n);
      else groups.set(n.key, [n]);
    }

    const multi = [];
    const singles = [];
    for (const g of groups.values()) {
      if (g.length >= 2) multi.push(g);
      else singles.push(g[0]);
    }
    // biggest cluster first, it becomes the central island
    multi.sort((a, b) => b.length - a.length);

    const restLen = 135 * ls;
    const cellSize = 2 * 11 + 14; // grid cell for unconnected papers (r≈8)

    // Estimate each cluster's on-screen radius. Islands sit at fixed anchors
    // and never repel each other, so we can pack them fairly tight, a modest
    // over-estimate keeps neighbours from overlapping without leaving big
    // empty moats between islands.
    const entries = multi.map((g) => ({
      nodes: g,
      radius: restLen * (0.5 + 0.6 * Math.sqrt(g.length)),
    }));

    // The unconnected papers become one grid "island".
    let singlesEntry = null;
    if (singles.length) {
      singles.sort(
        (a, b) =>
          b.inLibraryCitations - a.inLibraryCitations ||
          (b.year || 0) - (a.year || 0)
      );
      const cols = Math.max(1, Math.ceil(Math.sqrt(singles.length)));
      const rows = Math.ceil(singles.length / cols);
      singlesEntry = {
        nodes: singles,
        grid: { cols, rows, cell: cellSize },
        radius: 0.5 * Math.hypot(cols * cellSize, rows * cellSize) + cellSize,
      };
      entries.push(singlesEntry);
    }

    // --- pack island anchors on a spiral, largest at the centre
    this._packIslands(entries);
    this._islands = entries;
    this._singlesEntry = singlesEntry;

    // --- assign anchors + deterministic start positions
    this._compGroups = []; // node arrays that repel internally
    this._clusters = []; // per-island metadata (label, color index)
    let clusterIdx = 0;
    for (const e of entries) {
      if (e === singlesEntry) continue;
      this._compGroups.push(e.nodes);
      const ci = clusterIdx++;
      this._clusters.push({
        nodes: e.nodes,
        index: ci,
        label: e.nodes.length >= 3 ? this._clusterLabel(e.nodes) : null,
      });
      e.nodes.forEach((n, i) => {
        n._cluster = ci;
        // small phyllotaxis seed around the cluster anchor
        const rad = 14 * Math.sqrt(i + 1) * ls;
        const ang = i * 2.399963229728653;
        n.anchorX = e.cx;
        n.anchorY = e.cy;
        n.x = e.cx + rad * Math.cos(ang);
        n.y = e.cy + rad * Math.sin(ang);
      });
    }
    if (singlesEntry) {
      for (const n of singlesEntry.nodes) n._cluster = -1;
    }
    if (singlesEntry) {
      const { cols, cell } = singlesEntry.grid;
      const w = (cols - 1) * cell;
      const h = (Math.ceil(singles.length / cols) - 1) * cell;
      singles.forEach((n, i) => {
        const gx = (i % cols) * cell - w / 2;
        const gy = Math.floor(i / cols) * cell - h / 2;
        // grid slots are fixed anchors; these papers have no relations,
        // so they simply rest in a neat block.
        n.anchorX = singlesEntry.cx + gx;
        n.anchorY = singlesEntry.cy + gy;
        n.x = n.anchorX;
        n.y = n.anchorY;
      });
    }

    // How far the packed islands reach, the force step's safety cap must
    // not clip a distant island back toward the centre.
    this._arena =
      entries.reduce(
        (m, e) => Math.max(m, Math.hypot(e.cx, e.cy) + e.radius),
        0
      ) + 400 * ls;
  }

  /**
   * Place island anchors (e.cx/e.cy) on a spiral around the first (largest)
   * one, so no two islands' circles (e.radius) come closer than a small gap.
   */
  _packIslands(entries) {
    const gap = 18 * this.layoutScale; // breathing room between islands
    const placed = [];
    for (const e of entries) {
      if (!placed.length) {
        e.cx = 0;
        e.cy = 0;
        placed.push(e);
        continue;
      }
      let angle = 0;
      let radius = placed[0].radius + e.radius + gap;
      let step = 0;
      for (;;) {
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        const ok = placed.every(
          (p) => Math.hypot(p.cx - x, p.cy - y) >= p.radius + e.radius + gap
        );
        if (ok || step > 800) {
          e.cx = x;
          e.cy = y;
          placed.push(e);
          break;
        }
        angle += 0.6;
        if (++step % 11 === 0) radius += gap * 0.8;
      }
    }
  }

  /**
   * After the network has settled, re-pack the islands by the room they
   * ACTUALLY take (the pre-layout radius is a generous guess), so the map
   * doesn't open as a few specks separated by empty moats. Each island
   * moves rigidly, nodes and anchor together, so its shape is untouched.
   */
  _compactIslands() {
    const entries = this._islands;
    if (!entries || entries.length < 2) return;
    for (const e of entries) {
      e.oldX = e.cx;
      e.oldY = e.cy;
      if (e.grid) continue; // the unlinked-papers grid is already exact
      let r = 0;
      for (const n of e.nodes) {
        r = Math.max(r, Math.hypot(n.x - e.cx, n.y - e.cy) + n.r + 18);
      }
      e.radius = Math.max(40, r);
    }
    this._packIslands(entries);
    for (const e of entries) {
      const dx = e.cx - e.oldX;
      const dy = e.cy - e.oldY;
      for (const n of e.nodes) {
        n.x += dx;
        n.y += dy;
        n.anchorX += dx;
        n.anchorY += dy;
      }
    }
    this._arena =
      entries.reduce((m, e) => Math.max(m, Math.hypot(e.cx, e.cy) + e.radius), 0) +
      400 * this.layoutScale;
  }

  /**
   * Auto-label a citation cluster: the OpenAlex topic most of its papers
   * share, falling back to the strongest locally-extracted title phrase.
   */
  _clusterLabel(members) {
    const tally = new Map();
    for (const n of members) {
      (n.topics || []).forEach((t, i) => {
        if (!t || !t.name) return;
        tally.set(t.name, (tally.get(t.name) || 0) + (i === 0 ? 2 : 1));
      });
    }
    let best = null;
    for (const [name, count] of tally) {
      if (!best || count > best.count) best = { name, count };
    }
    if (best && best.count >= 3) return best.name;
    // fallback: dominant phrase from the members' titles (fully local)
    try {
      const GB = ZCM_VIEW_NS && ZCM_VIEW_NS.GraphBuilder;
      const terms = GB
        ? GB._extractTerms(members.map((n) => ({ text: n.title, tags: [] })))
        : [];
      if (terms.length) return terms[0].term;
    } catch (e) {
      /* label is decorative, never fail the layout over it */
    }
    return best ? best.name : null;
  }

  /**
   * Decide which suggested papers take part in the map at all.
   * "off" , none (sidebar list still has them)
   * "top" , only the strongest few, drawn softly ("teased")
   * "all" , every suggestion that passes the ×N filter
   * A suggestion clicked in the sidebar is revealed regardless.
   */
  _applySuggestionVisibility(reheat = true) {
    const sugg = this.graph.nodes.filter((n) => n.kind === "discovered");
    const eligible = sugg
      .filter((n) => n.inLibraryCitations >= this.suggestMinCiters)
      // with reviews hidden, "Top N" fills its slots with non-reviews
      .filter((n) => !(this.hideReviews && n.isReview))
      .sort(
        (a, b) =>
          b.inLibraryCitations - a.inLibraryCitations ||
          (b.citedByCount || 0) - (a.citedByCount || 0)
      );
    const top = new Set(
      eligible.slice(0, this.suggestTopCount).map((n) => n.key)
    );
    for (const n of sugg) {
      if (this.suggestDisplay === "off") n.hidden = !n.revealed;
      else if (this.suggestDisplay === "all")
        n.hidden = n.inLibraryCitations < this.suggestMinCiters && !n.revealed;
      else n.hidden = !top.has(n.key) && !n.revealed;
      n.teased = this.suggestDisplay === "top" && !n.revealed;
    }
    this._activeNodes = null;
    this._activeEdges = null;
    if (this.mode === "timeline") {
      this._computeTimelineLayout();
      this.alpha = 1;
      // newly shown papers never took part in the network layout: let it
      // settle them once we're back there
      this._unsettled = true;
    } else if (reheat) {
      this.alpha = Math.max(this.alpha || 0, 0.3);
    }
    this._dirty = true;
  }

  /** Visible nodes/edges, hidden suggestions play no part in forces,
   *  drawing, hit-testing or view fitting. */
  /** A node that plays no part in the map right now (hidden or a hidden review). */
  _hiddenFromMap(n) {
    return n.hidden || (this.hideReviews && n.isReview);
  }

  _active() {
    if (!this._activeNodes) {
      this._activeNodes = this.graph.nodes.filter((n) => !this._hiddenFromMap(n));
      // label priority counts only papers actually on the map, so hidden
      // ones don't use up the label budget
      this._activeNodes.forEach((n, i) => (n._rank = i));
      this._activeEdges = this.graph.edges.filter((e) => {
        const s = this.nodeByKey.get(e.source);
        const t = this.nodeByKey.get(e.target);
        return s && t && !this._hiddenFromMap(s) && !this._hiddenFromMap(t);
      });
    }
    return { nodes: this._activeNodes, edges: this._activeEdges };
  }

  /** "Hide reviews" (Filter popover + filter-bar chip): map + all sidebar lists. */
  _setHideReviews(val) {
    this.hideReviews = !!val;
    try {
      Zotero.Prefs.set("extensions.citation-map.hideReviews", this.hideReviews, true);
    } catch (e) {
      /* best-effort */
    }
    this._applySuggestionVisibility(false);
    this._applyReviewVisibility();
    this._syncReviewBtn();
    this._filtersChanged();
  }

  /** The toolbar toggle reflects the state: pressed + "Reviews hidden". */
  _syncReviewBtn() {
    const b = this._reviewBtn;
    if (!b) return;
    const on = this.hideReviews;
    const label = on ? "Reviews hidden" : "Hide reviews";
    const lab = b.querySelector(".zcm-btn-label");
    if (lab) lab.textContent = label;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.setAttribute("aria-label", label);
    b.setAttribute(
      "title",
      on
        ? "Review articles are hidden from the map and faded in the lists. Click to show them again."
        : "Hide review / meta-analysis articles from the map and fade them in the lists"
    );
  }

  /**
   * Apply the review state. Map: reviews drop out of drawing/forces. Lists:
   * reviews are de-emphasised (faded, with a Review badge) via a SINGLE class
   * on the sidebar rather than re-rendering each list. Review rows carry
   * `.zcm-is-review`; the class toggles the look.
   */
  _applyReviewVisibility() {
    this._activeNodes = null;
    this._activeEdges = null;
    if (this.mode === "timeline") this._computeTimelineLayout();
    this.alpha = Math.max(this.alpha || 0, 0.25);
    this._dirty = true;
    this._applyReviewDim();
  }

  /** Toggle the faded look for review rows across every sidebar list. */
  _applyReviewDim() {
    if (this._sideEl) {
      this._sideEl.classList.toggle("zcm-hide-reviews", this.hideReviews);
    }
    if (this._papersReviewSw) this._papersReviewSw._set(this.hideReviews);
  }

  /** A "Review" badge for lists and the inspector. */
  _reviewChip() {
    return this._badge(
      "outline",
      "Review",
      "review",
      "Review / secondary-literature article (e.g. systematic review or meta-analysis)"
    );
  }

  /** A "New" badge: appeared since the last build of this collection. */
  _newChip() {
    return this._badge(
      "new",
      "New",
      "sparkle",
      "Appeared since your last build of this collection"
    );
  }

  _setSuggestDisplay(val) {
    this.suggestDisplay = val;
    try {
      Zotero.Prefs.set("extensions.citation-map.suggestDisplay", val, true);
    } catch (e) {
      /* best-effort */
    }
    if (this._suggSeg) this._suggSeg._set(val);
    // a new toggle state is a fresh look, drop one-off reveals (papers the
    // Discover search placed on the map stay put)
    for (const n of this.graph.nodes) {
      if (!n._injected) n.revealed = false;
    }
    this._applySuggestionVisibility();
  }

  // ============================================================ scale sliders

  /** Labelled range slider for the Display popover. */
  _buildSlider(label, tip, min, max, value, onInput) {
    const row = this._el("div", "zcm-control-row");
    row.appendChild(this._el("span", "zcm-control-label", label));
    const input = this._el("input", "zcm-range");
    input.setAttribute("type", "range");
    input.setAttribute("min", String(min));
    input.setAttribute("max", String(max));
    input.setAttribute("step", "5");
    input.setAttribute("aria-label", label);
    input.value = String(value);
    const show = () => input.setAttribute("title", `${tip}: ${input.value}%`);
    show();
    input.addEventListener("input", () => {
      show();
      onInput(parseInt(input.value, 10));
    });
    // double-click the slider to snap back to 100 %
    input.addEventListener("dblclick", () => {
      input.value = "100";
      show();
      onInput(100);
    });
    row.appendChild(input);
    return row;
  }

  /**
   * Spacing slider: scale the distance between papers. Existing positions,
   * anchors and remembered layouts are scaled proportionally (no re-layout,
   * no scatter), then the simulation relaxes gently into the new spacing.
   */
  _setSpacing(pct) {
    pct = Math.max(75, Math.min(250, Math.round(pct)));
    if (pct === this.spacingPct) return;
    const ratio = pct / this.spacingPct;
    this.spacingPct = pct;
    try {
      Zotero.Prefs.set("extensions.citation-map.nodeSpacing", pct, true);
    } catch (e) {
      /* best-effort */
    }
    this.layoutScale *= ratio;
    if (this._arena) this._arena *= ratio;
    for (const n of this.graph.nodes) {
      n.x *= ratio;
      n.y *= ratio;
      n.anchorX *= ratio;
      n.anchorY *= ratio;
      if (n._netX != null) {
        n._netX *= ratio;
        n._netY *= ratio;
      }
      if (n.tlx != null) {
        n.tlx *= ratio;
        n.tly *= ratio;
      }
    }
    if (this.mode === "timeline") {
      // scaled positions land almost exactly on the recomputed grid; the
      // ease absorbs the small residual from the cell-size clamp
      this._computeTimelineLayout();
      this.alpha = 1;
    } else if (!this._returning) {
      this.alpha = Math.max(this.alpha || 0, 0.25); // relax, don't reshuffle
    }
    this._fitView();
  }

  /** Line-width slider: thickness of the citation lines and arrowheads. */
  _setEdgeWidth(pct) {
    pct = Math.max(40, Math.min(300, Math.round(pct)));
    this.edgeWidthPct = pct;
    try {
      Zotero.Prefs.set("extensions.citation-map.edgeWidth", pct, true);
    } catch (e) {
      /* best-effort */
    }
    this._dirty = true;
  }

  // ===================================================== display & filters

  /**
   * Popover panel anchored to a button. Only one popover is open at a time;
   * clicking outside or pressing Esc closes it and returns focus to the
   * button. Opens below the button (above, when there is no room), aligned
   * to the button's right edge near the right side of the tab.
   */
  _popover(button, buildContent, opts = {}) {
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    const open = () => {
      if (this._openPopover) {
        const wasThis = this._openPopover._forBtn === button;
        this._closePopover();
        if (wasThis) return;
      }
      const panel = this._el("div", "zcm-popover" + (opts.cls ? " " + opts.cls : ""));
      panel._forBtn = button;
      if (opts.width) panel.style.width = opts.width + "px";
      buildContent(panel);
      this.root.appendChild(panel);
      const rootRect = this.root.getBoundingClientRect();
      const btnRect = button.getBoundingClientRect();
      const pw = panel.offsetWidth || opts.width || 300;
      const ph = panel.offsetHeight || 200;
      let top = btnRect.bottom - rootRect.top + 6;
      if (top + ph > rootRect.height - 8 && btnRect.top - rootRect.top - ph - 6 > 8) {
        top = btnRect.top - rootRect.top - ph - 6; // no room below: open upward
      }
      const center = btnRect.left + btnRect.width / 2 - rootRect.left;
      let left =
        center > rootRect.width / 2
          ? btnRect.right - rootRect.left - pw // right half: align right edges
          : btnRect.left - rootRect.left;
      left = Math.max(8, Math.min(left, rootRect.width - pw - 8));
      panel.style.top = Math.max(8, top) + "px";
      panel.style.left = left + "px";
      panel.style.maxHeight = Math.max(160, rootRect.height - Math.max(8, top) - 8) + "px";
      button.setAttribute("aria-expanded", "true");
      this._openPopover = panel;
      this._popoverCloser = (ev) => {
        if (!panel.contains(ev.target) && !button.contains(ev.target)) {
          this._closePopover();
        }
      };
      this.doc.addEventListener("mousedown", this._popoverCloser, true);
    };
    button.addEventListener("click", open);
    button._zcmOpen = open;
  }

  _closePopover(returnFocus = false) {
    if (this._popoverCloser) {
      this.doc.removeEventListener("mousedown", this._popoverCloser, true);
      this._popoverCloser = null;
    }
    const panel = this._openPopover;
    if (panel) {
      const btn = panel._forBtn;
      if (btn) {
        btn.setAttribute("aria-expanded", "false");
        if (returnFocus && btn.focus) btn.focus();
      }
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    }
    this._openPopover = null;
    this._popoverSync = null;
  }

  /** A popover section with an optional small label. */
  _popSection(panel, label) {
    const sec = this._el("div", "zcm-pop-section");
    if (label) sec.appendChild(this._el("span", "zcm-label", label));
    panel.appendChild(sec);
    return sec;
  }

  /** One row of a popover menu: optional lead (icon / dots), label, check. */
  _option(label, o = {}) {
    const row = this._el("button", "zcm-option");
    row.setAttribute("type", "button");
    if (o.title) row.setAttribute("title", o.title);
    if (o.lead) row.appendChild(o.lead);
    else if (o.icon) row.appendChild(this._icon(o.icon));
    row.appendChild(this._el("span", "zcm-option-label", label));
    if (o.kbd) row.appendChild(this._el("span", "zcm-kbd", o.kbd));
    const check = this._icon("check", "zcm-ic--sm zcm-ic--check");
    row.appendChild(check);
    row._setOn = (on) => {
      row.classList.toggle("is-on", !!on);
      if (o.radio) row.setAttribute("aria-checked", on ? "true" : "false");
      check.style.visibility = on ? "visible" : "hidden";
    };
    if (o.radio) row.setAttribute("role", "menuitemradio");
    row._setOn(!!o.on);
    if (o.onClick) row.addEventListener("click", o.onClick);
    return row;
  }

  /** Three preview dots for a color mode (Display popover). */
  _modeSwatch(mode) {
    const sw = this._el("span", "zcm-dots");
    const T = this.T;
    const dot = (color, cls) => {
      const d = this._el("i", cls || null);
      if (color) d.style.background = color;
      sw.appendChild(d);
    };
    if (mode === "kind") {
      dot(null, "zcm-dot-library");
      dot(null, "zcm-dot-suggested");
      dot(null, "zcm-dot-discover");
    } else if (mode === "year") {
      dot(T.year[0]);
      dot(T.year[2]);
      dot(T.year[4]);
    } else if (mode === "cluster") {
      dot(T.clusters[0]);
      dot(T.clusters[2]);
      dot(T.clusters[3]);
    } else if (mode === "oa") {
      dot(T.access.gold);
      dot(T.access.green);
      dot(T.access.closed);
    } else if (mode === "publisher") {
      const MT = ZCM_VIEW_NS.MapTheme;
      dot(MT.adjustBrandColour(MT.BRAND_SAMPLES[0], T.name));
      dot(MT.adjustBrandColour(MT.BRAND_SAMPLES[1], T.name));
      dot(null, "zcm-dot-nodata");
    }
    return sw;
  }

  /** Change what the dot colors encode. */
  _setColorMode(val) {
    this.colorMode = val;
    try {
      Zotero.Prefs.set("extensions.citation-map.colorMode", val, true);
    } catch (e) {
      /* best-effort */
    }
    this._renderLegend();
    this._dirty = true;
  }

  /** Toolbar "Display": colors, timeline height, coupling, sizes, appearance. */
  _buildDisplayControl() {
    const btn = this._btn("Display", {
      icon: "sliders",
      cls: "zcm-collapsible",
      title: "Colors, timeline height, coupling links, sizes and appearance",
    });
    this._displayBtn = btn;
    this._popover(btn, (panel) => {
      // ---- Color the dots by
      const colorSec = this._popSection(panel, "Color the dots by");
      const modes = [
        ["kind", "Type", "Library, suggested, search results and no-data in their own colors (the default)"],
        ["year", "Year", "Publication year, from older to newer"],
        ["cluster", "Cluster", "Each citation cluster (island) gets its own color"],
        ["oa", "Open access", "Open-access status: gold, green, hybrid, bronze, diamond, closed"],
        ["publisher", "Journal", "A rim in each journal's publisher color"],
      ];
      const rows = {};
      const paint = () => {
        for (const [val] of modes) {
          const row = rows[val];
          row._setOn(val === this.colorMode);
          const old = row.querySelector(".zcm-dots");
          if (old) row.replaceChild(this._modeSwatch(val), old);
        }
      };
      for (const [val, label, tip] of modes) {
        const row = this._option(label, {
          lead: this._modeSwatch(val),
          title: tip,
          radio: true,
          on: val === this.colorMode,
          onClick: () => {
            this._setColorMode(val);
            paint();
          },
        });
        rows[val] = row;
        colorSec.appendChild(row);
      }

      // ---- Height means + coupling
      const heightSec = this._popSection(panel, "Height means");
      heightSec.appendChild(
        this._seg(
          "Timeline height",
          [
            ["global", "Citations worldwide", "All citations OpenAlex knows of (log scale)"],
            ["local", "Cited on this map", "How many papers on this map cite it"],
          ],
          this.yMetric,
          (v) => this._setYMetric(v),
          { fill: true }
        )
      );
      const couplingRow = this._el("label", "zcm-control-row zcm-control-row--between");
      couplingRow.setAttribute(
        "title",
        "Dashed links between two of your papers that share many references, " +
          "“siblings” even when neither cites the other."
      );
      couplingRow.appendChild(this._el("span", null, "Coupling links"));
      const strengthRow = this._el("div", "zcm-control-row zcm-control-row--between");
      const couplingSw = this._switch(this.showCoupling, "Show coupling links", (on) => {
        this.showCoupling = on;
        try {
          Zotero.Prefs.set("extensions.citation-map.showCoupling", on, true);
        } catch (e) {
          /* best-effort */
        }
        strengthRow.style.display = on ? "" : "none";
        this._dirty = true;
      });
      couplingRow.appendChild(couplingSw);
      heightSec.appendChild(couplingRow);
      strengthRow.appendChild(this._el("span", "zcm-control-label", "Shared references"));
      strengthRow.appendChild(
        this._seg(
          "Minimum shared references",
          [2, 3, 5].map((v) => [v, `${v}+`, `Link papers sharing at least ${v} references`]),
          this.couplingMin,
          (v) => {
            this.couplingMin = v;
            try {
              Zotero.Prefs.set("extensions.citation-map.couplingMinShared", v, true);
            } catch (e) {
              /* best-effort */
            }
            this._dirty = true;
          }
        )
      );
      strengthRow.style.display = this.showCoupling ? "" : "none";
      heightSec.appendChild(strengthRow);

      // ---- Size
      const sizeSec = this._popSection(panel, "Size");
      sizeSec.appendChild(
        this._buildSlider(
          "Spacing",
          "Distance between papers (double-click to reset)",
          75,
          250,
          this.spacingPct,
          (v) => this._setSpacing(v)
        )
      );
      sizeSec.appendChild(
        this._buildSlider(
          "Lines",
          "Thickness of the citation lines (double-click to reset)",
          40,
          300,
          this.edgeWidthPct,
          (v) => this._setEdgeWidth(v)
        )
      );

      // ---- Scrolling (trackpad / mouse wheel)
      const scrollSec = this._popSection(panel, "Scrolling over the map");
      scrollSec.appendChild(
        this._seg(
          "Scrolling over the map",
          [
            ["auto", "Auto", "Trackpad: two fingers move the map, pinch zooms. Mouse wheel: zooms."],
            ["zoom", "Zooms", "Scrolling always zooms (drag to move the map)"],
            ["pan", "Moves", "Scrolling always moves the map (pinch or Ctrl/Cmd + scroll zooms)"],
          ],
          this.scrollGesture,
          (v) => {
            this.scrollGesture = v;
            try {
              Zotero.Prefs.set("extensions.citation-map.scrollGesture", v, true);
            } catch (e) {
              /* best-effort */
            }
          },
          { fill: true }
        )
      );
      scrollSec.appendChild(
        this._el(
          "span",
          "zcm-help",
          "Auto: on a trackpad, slide two fingers to move and pinch to zoom; " +
            "a mouse wheel zooms."
        )
      );

      // ---- Appearance
      const appSec = this._popSection(panel, "Appearance");
      appSec.appendChild(
        this._seg(
          "Appearance",
          [
            ["auto", "Auto", "Follow Zotero's color scheme", "auto"],
            ["light", "Light", "Always light", "sun"],
            ["dark", "Dark", "Always dark", "moon"],
          ],
          this.appearance,
          (v) => {
            this._setAppearance(v);
            paint(); // the preview dots follow the theme
          },
          { fill: true }
        )
      );
      appSec.appendChild(
        this._el("span", "zcm-help", "Auto follows Zotero's colour scheme.")
      );
      this._popoverSync = paint;
    });
    return btn;
  }

  /** Toolbar "More": export, import, API key, sidebar, help. */
  _buildMoreControl() {
    const btn = this._btn("More", {
      icon: "more",
      iconOnly: true,
      title: "More: export, import, OpenAlex API key, sidebar, help",
    });
    this._moreBtn = btn;
    const mac = this._isMac();
    this._popover(btn, (panel) => {
      const run = (fn) => () => {
        this._closePopover();
        fn();
      };
      const exportSec = this._popSection(panel);
      exportSec.appendChild(
        this._option("Export PNG image", {
          icon: "download",
          title: "Save the current view as an image, in the current theme",
          onClick: run(() => this._safeExport(() => this._exportPNG())),
        })
      );
      exportSec.appendChild(
        this._option("Export PNG, light background", {
          icon: "sun",
          title: "Save the current view on the light background, for slides and print",
          onClick: run(() => this._safeExport(() => this._exportPNG({ light: true }))),
        })
      );
      exportSec.appendChild(
        this._option("Export JSON data", {
          icon: "download",
          title: "Save nodes and edges as JSON",
          onClick: run(() => this._safeExport(() => this._exportJSON())),
        })
      );
      if (this.ctx && this.ctx.importJSON) {
        exportSec.appendChild(
          this._option("Import JSON map…", {
            icon: "upload",
            title: "Open a previously exported map in a new tab",
            onClick: run(() => this.ctx.importJSON()),
          })
        );
      }
      const setSec = this._popSection(panel);
      setSec.appendChild(
        this._option("OpenAlex API key…", {
          icon: "key",
          title: "Optional free key for a bigger daily OpenAlex budget",
          onClick: run(() => {
            const n = this._showNotice(
              "OpenAlex works without a key on a small daily budget per network. " +
                "A free key raises it about tenfold; it is stored in Zotero and " +
                "sent only to api.openalex.org.",
              "advice",
              "OpenAlex API key"
            );
            if (n) n._body.appendChild(this.constructor.apiKeyForm(this.doc, null));
          }),
        })
      );
      setSec.appendChild(
        this._option(this._sidebarCollapsed ? "Show sidebar" : "Hide sidebar", {
          icon: "sidebar",
          kbd: "S",
          onClick: run(() => this._setSidebarCollapsed(!this._sidebarCollapsed)),
        })
      );
      const helpSec = this._popSection(panel);
      helpSec.appendChild(
        this._option("How to read this map", {
          icon: "help",
          onClick: run(() => this._showGuide()),
        })
      );
      helpSec.appendChild(
        this._option("Replay the tour", {
          icon: "compass",
          onClick: run(() => this._showTour()),
        })
      );
      const ns = ZCM_VIEW_NS || {};
      helpSec.appendChild(
        this._el(
          "span",
          "zcm-help zcm-build-id",
          `Citation Map ${ns.version || ""}` + (ns.build ? ` · build ${ns.build}` : "")
        )
      );
    }, { width: 290 });
    return btn;
  }

  /** What a paper's height means in the timeline ("global" | "local"). */
  _setYMetric(val) {
    if (val === this.yMetric) return;
    this.yMetric = val;
    try {
      Zotero.Prefs.set("extensions.citation-map.timelineMetric", val, true);
    } catch (e) {
      /* best-effort */
    }
    if (this.mode === "timeline") {
      this._computeTimelineLayout();
      this.alpha = 1;
      this.win.setTimeout(() => {
        if (!this._destroyed) this._fitView(true);
      }, 600);
    }
    this._renderStatusMode();
    this._dirty = true;
  }

  /**
   * A small inline form to save (or clear) the optional OpenAlex API key.
   * Static and DOM-only so the controller can use it on the progress screen
   * too. `onSaved` runs after a change (e.g. to rebuild the map).
   */
  static apiKeyForm(doc, onSaved) {
    const row = doc.createElement("div");
    row.className = "zcm-keyform";
    const field = doc.createElement("label");
    field.className = "zcm-field zcm-keyform-field";
    const input = doc.createElement("input");
    input.type = "text";
    input.placeholder = "Paste your OpenAlex API key";
    input.setAttribute("aria-label", "OpenAlex API key");
    let current = "";
    try {
      current = String(Zotero.Prefs.get("extensions.citation-map.apiKey", true) || "");
    } catch (e) {
      /* no prefs */
    }
    input.value = current;
    field.appendChild(input);
    const save = doc.createElement("button");
    save.textContent = "Save key";
    save.className = "zcm-btn zcm-btn--sm zcm-btn--secondary";
    const status = doc.createElement("span");
    status.className = "zcm-help";
    save.addEventListener("click", () => {
      try {
        Zotero.Prefs.set("extensions.citation-map.apiKey", input.value.trim(), true);
        status.textContent = input.value.trim() ? "Saved." : "Key cleared.";
        if (onSaved) onSaved();
      } catch (e) {
        status.textContent = "Couldn't save the key.";
      }
    });
    const get = doc.createElement("button");
    get.textContent = "Get a free key";
    get.className = "zcm-btn zcm-btn--sm";
    get.addEventListener("click", () =>
      Zotero.launchURL("https://openalex.org/settings/api")
    );
    row.appendChild(field);
    row.appendChild(save);
    row.appendChild(get);
    row.appendChild(status);
    return row;
  }

  /** How many filters are active (year range, tag, reviews hidden). */
  _activeFilterCount() {
    return (
      (this.filterYearFrom != null || this.filterYearTo != null ? 1 : 0) +
      (this.filterTag != null ? 1 : 0) +
      (this.hideReviews ? 1 : 0)
    );
  }

  /** Any filter changed: refresh the toolbar count, filter bar and the map. */
  _filtersChanged() {
    const n = this._activeFilterCount();
    if (this._filterCount) {
      this._filterCount.textContent = String(n);
      this._filterCount.style.display = n ? "" : "none";
    }
    if (this._filterBtn) {
      this._filterBtn.setAttribute(
        "title",
        n
          ? `Filter: ${n} active`
          : "Filter by year, Zotero tag, or hide review articles"
      );
    }
    this._renderFilterBar();
    if (this._popoverSync) this._popoverSync();
    this._dirty = true;
  }

  _clearFilters() {
    this.filterYearFrom = null;
    this.filterYearTo = null;
    this.filterTag = null;
    this._tagKeys = null;
    if (this.hideReviews) this._setHideReviews(false); // calls _filtersChanged
    else this._filtersChanged();
  }

  /**
   * The filter bar: rendered only while at least one filter is active, with
   * a removable chip per filter, so a user never wonders why papers are
   * missing or dimmed.
   */
  _renderFilterBar() {
    const bar = this._filterBarEl;
    if (!bar) return;
    bar.textContent = "";
    const active = this._activeFilterCount() > 0;
    const was = bar.style.display !== "none";
    bar.style.display = active ? "flex" : "none";
    if (was !== active) this._layout(); // the stage grew or shrank
    if (!active) return;
    bar.appendChild(this._el("span", null, "Filters"));
    const chip = (icon, text, removeLabel, remove) => {
      const c = this._el("span", "zcm-chip");
      c.setAttribute("tabindex", "0");
      c.appendChild(this._icon(icon, "zcm-ic--sm"));
      c.appendChild(this._el("span", "zcm-chip-label zcm-num", text));
      const x = this._el("button");
      x.setAttribute("type", "button");
      x.setAttribute("aria-label", removeLabel);
      x.setAttribute("title", removeLabel);
      x.appendChild(this._icon("close", "zcm-ic--sm"));
      x.addEventListener("click", remove);
      c.addEventListener("keydown", (ev) => {
        if (ev.key === "Backspace" || ev.key === "Delete") {
          ev.preventDefault();
          remove();
        }
      });
      c.appendChild(x);
      bar.appendChild(c);
    };
    if (this.filterYearFrom != null || this.filterYearTo != null) {
      const text =
        this.filterYearFrom != null && this.filterYearTo != null
          ? `${this.filterYearFrom} – ${this.filterYearTo}`
          : this.filterYearFrom != null
          ? `From ${this.filterYearFrom}`
          : `Until ${this.filterYearTo}`;
      chip("calendar", text, "Remove year filter", () => {
        this.filterYearFrom = null;
        this.filterYearTo = null;
        this._filtersChanged();
      });
    }
    if (this.filterTag != null) {
      chip("tag", this.filterTag, "Remove tag filter", () => {
        this.filterTag = null;
        this._tagKeys = null;
        this._filtersChanged();
      });
    }
    if (this.hideReviews) {
      chip("eye-off", "Reviews hidden", "Show reviews", () => this._setHideReviews(false));
    }
    bar.appendChild(
      this._btn("Clear all", { sm: true, onClick: () => this._clearFilters() })
    );
    bar.appendChild(this._el("span", "zcm-spacer"));
    const papers = this.graph.nodes.filter((n) => n.kind !== "discovered");
    const shown = papers.filter(
      (n) => !(this.hideReviews && n.isReview) && this._passesFilters(n)
    );
    const count = this._el("span", "zcm-num zcm-filter-count");
    count.appendChild(this.doc.createTextNode("Showing "));
    count.appendChild(this._el("b", null, String(shown.length)));
    count.appendChild(
      this.doc.createTextNode(` of ${papers.length} paper${papers.length === 1 ? "" : "s"}`)
    );
    count.setAttribute("aria-live", "polite");
    bar.appendChild(count);
  }

  /** Toolbar "Filter": year range, Zotero tag, hide reviews. */
  _buildFilterControl() {
    const btn = this._btn("Filter", { icon: "filter", cls: "zcm-collapsible" });
    const count = this._el("span", "zcm-count", "0");
    count.style.display = "none";
    btn.appendChild(count);
    this._filterBtn = btn;
    this._filterCount = count;
    this._popover(
      btn,
      (panel) => {
        const nowY = new Date().getFullYear();
        // ---- Published year
        const yearSec = this._popSection(panel, "Published year");
        const yr = this._el("div", "zcm-control-row");
        const err = this._el("span", "zcm-error-text");
        err.style.display = "none";
        const fields = {};
        const validate = () => {
          let msg = "";
          const f = this.filterYearFrom;
          const t = this.filterYearTo;
          if ((f != null && f > nowY) || (t != null && t > nowY)) {
            msg = `The year can't be later than ${nowY}.`;
          } else if (f != null && t != null && f > t) {
            msg = "“From” is later than “To”, so nothing matches.";
          }
          err.textContent = msg;
          err.style.display = msg ? "" : "none";
          for (const k of Object.keys(fields)) {
            fields[k].field.classList.toggle("zcm-field--error", !!msg);
          }
        };
        const mkYear = (key, labelText, ph, get, set) => {
          const field = this._el("label", "zcm-field zcm-num zcm-year-field");
          const inp = this._el("input");
          inp.setAttribute("type", "number");
          inp.setAttribute("min", "1000");
          inp.setAttribute("max", String(nowY));
          inp.setAttribute("placeholder", ph);
          inp.setAttribute("aria-label", labelText);
          if (get() != null) inp.value = String(get());
          inp.addEventListener("input", () => {
            const v = parseInt(inp.value, 10);
            set(Number.isFinite(v) && v > 1000 ? v : null);
            validate();
            this._popoverSyncSkip = true; // don't rewrite the field being typed in
            this._filtersChanged();
            this._popoverSyncSkip = false;
          });
          field.appendChild(inp);
          fields[key] = { field, inp, get };
          return field;
        };
        yr.appendChild(
          mkYear("from", "From year", String(this.yearMin), () => this.filterYearFrom, (v) => {
            this.filterYearFrom = v;
          })
        );
        yr.appendChild(this._el("span", "zcm-dash", "–"));
        yr.appendChild(
          mkYear("to", "To year", String(this.yearMax), () => this.filterYearTo, (v) => {
            this.filterYearTo = v;
          })
        );
        yearSec.appendChild(yr);
        yearSec.appendChild(err);

        // ---- Zotero tag. A DOM list (NOT a native <select>): a native
        // dropdown's option clicks land outside the popover DOM and trip its
        // click-outside-to-close handler. A plain list keeps every click
        // inside the panel.
        const tagSec = this._popSection(panel, "Zotero tag");
        const tagList = this._el("div", "zcm-option-list");
        const tagCounts = this._collectTags();
        const tagRows = [];
        const mkTagRow = (label, value) => {
          const row = this._option(label, {
            radio: true,
            on: (this.filterTag || "") === value,
            onClick: () => {
              this.filterTag = value || null;
              this._tagKeys = null; // recompute the matching-node cache
              this._filtersChanged();
            },
          });
          row._value = value;
          tagRows.push(row);
          tagList.appendChild(row);
        };
        mkTagRow("All tags", "");
        for (const [tag, n] of tagCounts) mkTagRow(`${tag} (${n})`, tag);
        tagSec.appendChild(tagList);
        if (!tagCounts.length) {
          tagSec.appendChild(
            this._el("span", "zcm-help", "No tags on the papers in this map.")
          );
        }

        // ---- Reviews
        const revSec = this._popSection(panel);
        const revRow = this._el("label", "zcm-control-row zcm-control-row--between");
        revRow.appendChild(this._el("span", null, "Hide reviews"));
        const revSw = this._switch(this.hideReviews, "Hide review articles", (on) =>
          this._setHideReviews(on)
        );
        revRow.appendChild(revSw);
        revSec.appendChild(revRow);
        revSec.appendChild(
          this._el(
            "span",
            "zcm-help",
            "Takes review and meta-analysis articles off the map and fades " +
              "them in the Suggested, Discover and Mine lists."
          )
        );

        // ---- footer
        const foot = this._popSection(panel);
        foot.appendChild(
          this._el(
            "span",
            "zcm-help",
            "Year and tag filters dim the papers that don't match; the " +
              "layout stays put."
          )
        );
        const clear = this._btn("Clear all", {
          sm: true,
          variant: "secondary",
          onClick: () => {
            this._clearFilters();
            this._closePopover(true);
          },
        });
        foot.appendChild(clear);

        // keep the open popover truthful when a filter-bar chip is removed
        this._popoverSync = () => {
          for (const r of tagRows) r._setOn((this.filterTag || "") === r._value);
          revSw._set(this.hideReviews);
          if (!this._popoverSyncSkip) {
            for (const k of Object.keys(fields)) {
              const v = fields[k].get();
              fields[k].inp.value = v != null ? String(v) : "";
            }
          }
          validate();
        };
        validate();
      },
      { width: 320 }
    );
    return btn;
  }

  /** Tags used in this collection, most frequent first (cached). */
  _collectTags() {
    if (this._tagCounts) return this._tagCounts;
    const counts = new Map();
    for (const n of this.graph.nodes) {
      if (!n.zoteroItemID) continue;
      try {
        const item = Zotero.Items.get(n.zoteroItemID);
        if (!item) continue;
        for (const t of item.getTags()) {
          counts.set(t.tag, (counts.get(t.tag) || 0) + 1);
        }
      } catch (e) {
        /* item gone */
      }
    }
    this._tagCounts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40);
    return this._tagCounts;
  }

  /** Does this node pass the active year/tag filters? */
  _passesFilters(n) {
    if (this.filterYearFrom != null && (!n.year || n.year < this.filterYearFrom))
      return false;
    if (this.filterYearTo != null && (!n.year || n.year > this.filterYearTo))
      return false;
    if (this.filterTag != null) {
      if (!this._tagKeys) {
        this._tagKeys = new Set();
        for (const m of this.graph.nodes) {
          if (!m.zoteroItemID) continue;
          try {
            const item = Zotero.Items.get(m.zoteroItemID);
            if (item && item.getTags().some((t) => t.tag === this.filterTag)) {
              this._tagKeys.add(m.key);
            }
          } catch (e) {
            /* item gone */
          }
        }
      }
      if (!this._tagKeys.has(n.key)) return false;
    }
    return true;
  }

  // ------------------------------------------------------------ color modes

  /** Smallest zoom, shared by fit-to-view, the wheel and the − button. */
  static get MIN_ZOOM() {
    return 0.1;
  }

  /**
   * The fill color for a node under the active color mode, from the current
   * theme's palette. Returns null for "no fill" (open-access status unknown,
   * drawn as a hollow dashed ring).
   */
  _nodeFill(n) {
    const T = this.T;
    const kindFill = () =>
      n.kind === "unresolved"
        ? T.node.nodata.fill
        : n.kind === "discovered"
        ? (n._injected ? T.node.discover : T.node.suggested).stroke
        : T.node.library.fill;
    switch (this.colorMode) {
      case "year": {
        if (!n.year) return T.node.nodata.fill;
        const span = Math.max(1, this.yearMax - this.yearMin);
        return ZCM_VIEW_NS.MapTheme.yearColour(T.name, (n.year - this.yearMin) / span);
      }
      case "cluster": {
        if (n._cluster == null || n._cluster < 0) return T.node.nodata.fill;
        return T.clusters[n._cluster % T.clusters.length];
      }
      case "oa": {
        // "open" (unspecified OA) reads as green; unknown has no fill
        const status = n.oaStatus === "open" ? "green" : n.oaStatus;
        return (status && T.access[status]) || null;
      }
      default:
        // "kind" (the neutral default) and "publisher" (kind fill + brand rim)
        return kindFill();
    }
  }

  /** A legend key: a small mark plus a label, with a plain-language tooltip. */
  _legendKey(markup, label, tip, cls) {
    const key = this._el("span", "zcm-key" + (cls ? " " + cls : ""));
    if (tip) key.setAttribute("title", tip);
    key.appendChild(ZCM_VIEW_NS.Icons.shape(this.doc, markup, 12));
    if (label) key.appendChild(this._el("span", null, label));
    return key;
  }

  /**
   * Fill `box` with the legend keys for the active color mode. Shape always
   * carries type (filled = in your library, ring = not yet), so those keys
   * stay in every mode; the two direction keys come last.
   */
  _legendKeys(box) {
    const T = this.T;
    const add = (markup, label, tip, cls) =>
      box.appendChild(this._legendKey(markup, label, tip, cls));
    const sep = () => box.appendChild(this._el("span", "zcm-key-sep"));
    const disc = (color) => `<circle cx="6" cy="6" r="5" fill="${color}"/>`;
    const shapeKeys = () => {
      add(
        '<circle class="m-lib" cx="6" cy="6" r="5"/>',
        "Filled: in your library",
        "A filled dot is a paper in your Zotero library / this collection."
      );
      add(
        '<circle class="m-ringkey" cx="6" cy="6" r="4.2"/>',
        "Ring: not yet",
        "An open ring is a paper you don't have yet: a suggestion or a search result."
      );
    };

    if (this.colorMode === "year") {
      const wrap = this._el("span", "zcm-key");
      wrap.setAttribute("title", "Dot color = publication year (older → newer)");
      wrap.appendChild(this._el("span", "zcm-num", String(this.yearMin)));
      const grad = this._el("span", "zcm-legend-grad");
      grad.style.background = `linear-gradient(90deg, ${T.year.join(", ")})`;
      wrap.appendChild(grad);
      wrap.appendChild(this._el("span", "zcm-num", String(this.yearMax)));
      box.appendChild(wrap);
      sep();
      shapeKeys();
    } else if (this.colorMode === "cluster") {
      const wrap = this._el("span", "zcm-key");
      wrap.setAttribute(
        "title",
        "Dot color = which citation cluster (island) a paper belongs to. " +
          "In this mode type is carried by shape alone."
      );
      const sw = this._el("span", "zcm-dots zcm-dots--wide");
      for (let i = 0; i < 4; i++) {
        const d = this._el("i");
        d.style.background = T.clusters[i];
        sw.appendChild(d);
      }
      wrap.appendChild(sw);
      wrap.appendChild(this._el("span", null, "One color per cluster"));
      box.appendChild(wrap);
      sep();
      shapeKeys();
    } else if (this.colorMode === "oa") {
      const oa = T.access;
      add(disc(oa.gold), "Gold", "Gold OA, published open access in an OA journal.");
      add(disc(oa.green), "Green", "Green OA, a free copy in a repository or preprint server.");
      add(disc(oa.hybrid), "Hybrid", "Hybrid, an open-access article inside an otherwise subscription journal.");
      add(disc(oa.bronze), "Bronze", "Bronze, free to read on the publisher's site, but with no open license.");
      add(disc(oa.diamond), "Diamond", "Diamond OA, free to read and to publish (no author fees).");
      add(disc(oa.closed), "Closed", "Closed, paywalled; no free version found.");
      add(
        '<circle class="m-unknown" cx="6" cy="6" r="4.2"/>',
        "Unknown",
        "No open-access data, usually a paper without citation data."
      );
      sep();
      shapeKeys();
    } else {
      // "kind" (the default) and "publisher"
      add(
        '<circle class="m-lib" cx="6" cy="6" r="5"/>',
        "Library",
        "A paper that is in your Zotero library / this collection (a filled dot)."
      );
      add(
        '<circle class="m-sug" cx="6" cy="6" r="4.2"/>',
        "Suggested",
        "A paper NOT in your library that several of your papers cite (an " +
          "open orange ring). See the Suggested tab."
      );
      add(
        '<circle class="m-disc" cx="6" cy="6" r="4.2"/>',
        "Search result",
        "A paper the Discover search placed on the map (an open violet " +
          "ring). “Remove from map” takes it off again."
      );
      add(
        '<circle class="m-nodata" cx="6" cy="6" r="5"/>',
        "No data",
        "In your library, but OpenAlex has no reference data for it, usually " +
          "a missing DOI. Add the DOI in Zotero and Rebuild."
      );
      add(
        '<circle class="m-new" cx="6" cy="6" r="3.5"/>',
        "New",
        "Appeared since your last build of this collection."
      );
      if (this.colorMode === "publisher") {
        const MT = ZCM_VIEW_NS.MapTheme;
        add(
          `<circle cx="6" cy="6" r="4.1" class="m-lib" stroke="${MT.adjustBrandColour(MT.BRAND_SAMPLES[0], T.name)}" stroke-width="1.75"/>`,
          "Journal rim",
          "Papers from a recognised journal get a rim in the publisher's color."
        );
      }
    }
    sep();
    add(
      '<path class="m-cites" d="M1 6h10"/>',
      "Cites (older)",
      "Hover or select a paper: blue lines lead to the papers it cites.",
      "zcm-key--dir"
    );
    add(
      '<path class="m-citedby" d="M1 6h10"/>',
      "Cited by (newer)",
      "Hover or select a paper: pink lines come from the papers citing it.",
      "zcm-key--dir"
    );
  }

  /**
   * The legend: a footer strip under the map (never an overlay, so it can't
   * cover axis labels). Its keys follow the color mode. On narrow tabs the
   * strip collapses into a "Legend" button that opens the same keys in a
   * popover (see the responsive classes in graph.css).
   */
  _renderLegend() {
    const legend = this.legend;
    if (!legend) return;
    legend.textContent = "";
    const btn = this._btn("Legend", { sm: true, icon: "info", cls: "zcm-legend-btn" });
    this._popover(
      btn,
      (panel) => {
        const sec = this._popSection(panel, "Legend");
        const box = this._el("div", "zcm-legend-pop");
        this._legendKeys(box);
        sec.appendChild(box);
        sec.appendChild(this._el("span", "zcm-help", this._legendNote()));
      },
      { width: 240 }
    );
    legend.appendChild(btn);
    const keys = this._el("div", "zcm-legend-keys");
    this._legendKeys(keys);
    legend.appendChild(keys);
    legend.appendChild(this._el("span", "zcm-legend-note", this._legendNote()));
  }

  _legendNote() {
    return "Size: citations from your papers";
  }

  // ======================================================= collection picker

  /**
   * Toolbar collection picker: folder pictogram, the collection's name, a
   * "+N" badge when subfolders are included and (when the mapped source has
   * subfolders) a chevron. Clicking opens the subfolder checklist that used
   * to be a separate "Subfolders" button. For sources without subfolders it
   * is a plain label.
   */
  _buildScopeControl() {
    const s = this.ctx && this.ctx.subInfo;
    const canChange = !!(s && this.ctx.changeScope);
    const wrap = this._el("div", "zcm-picker-wrap");
    const btn = this._el(
      canChange ? "button" : "div",
      "zcm-btn zcm-picker" + (canChange ? "" : " zcm-picker--static")
    );
    if (canChange) btn.setAttribute("type", "button");
    btn.appendChild(this._icon("folder"));
    const name = this._el("span", "zcm-picker-name", this.ctx.collectionName || "Library");
    btn.appendChild(name);
    const included = s ? (s.mode === "all" ? s.total : s.included || 0) : 0;
    if (s && included > 0) {
      const badge = this._badge(
        "neutral",
        `+${included}`,
        null,
        `${included} subfolder${included === 1 ? "" : "s"} included`
      );
      btn.appendChild(badge);
    }
    if (canChange) {
      btn.appendChild(this._icon("chev-down", "zcm-ic--sm"));
      btn.setAttribute("aria-haspopup", "dialog");
      btn.setAttribute(
        "title",
        `${this.ctx.collectionName}: ${this._scopeLabel()}. ` +
          "Click to choose which subfolders are mapped."
      );
      btn.addEventListener("click", () => {
        this._dismissScopeHint();
        this.ctx.changeScope();
      });
    } else {
      btn.setAttribute("title", this.ctx.collectionName || "");
    }
    wrap.appendChild(btn);
    this._scopeCtl = wrap;
    this._scopeBtn = btn;
    return wrap;
  }

  _scopeLabel() {
    const s = this.ctx && this.ctx.subInfo;
    if (!s) return "no subfolders";
    if (s.mode === "all") return `all ${s.total} subfolders included`;
    if (!s.included) return `this collection only (${s.total} subfolders not included)`;
    return `${s.included} of ${s.total} subfolders included`;
  }

  /**
   * One-time nudge, right after the initial subcollection prompt, so the user
   * learns where the choice can be changed later: the picker pulses and a
   * small callout points at it, both clearing after a few seconds or on the
   * first interaction.
   */
  _playScopeHint() {
    if (!this._scopeCtl || this._destroyed) return;
    if (!(this.ctx && this.ctx.subInfo && this.ctx.changeScope)) return;
    this._scopeCtl.classList.add("zcm-scope-pulse");
    const callout = this._el(
      "div",
      "zcm-scope-callout",
      "Change which subfolders are mapped here anytime."
    );
    this._scopeCtl.appendChild(callout);
    this._scopeHintTimer = this.win.setTimeout(
      () => this._dismissScopeHint(),
      8000
    );
  }

  _dismissScopeHint() {
    if (this._scopeHintTimer) {
      this.win.clearTimeout(this._scopeHintTimer);
      this._scopeHintTimer = null;
    }
    this._pendingScopeHint = false;
    if (this._scopeCtl) {
      this._scopeCtl.classList.remove("zcm-scope-pulse");
      const c = this._scopeCtl.querySelector(".zcm-scope-callout");
      if (c && c.parentNode) c.parentNode.removeChild(c);
    }
  }

  // ================================================================== DOM

  _el(tag, cls, text) {
    const el = this.doc.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  // ------------------------------------------------- component factories
  // Small builders for the design system's components (components.css), so
  // markup and ARIA stay consistent everywhere.

  /** A pictogram (inline SVG, currentColor). */
  _icon(name, cls) {
    return ZCM_VIEW_NS.Icons.make(this.doc, name, cls);
  }

  /**
   * A button: optional leading pictogram + label.
   * o: { icon, variant: "primary"|"secondary"|"danger", sm, iconOnly, cls,
   *      title, onClick }. Icon-only buttons always get an accessible name
   * and a tooltip.
   */
  _btn(label, o = {}) {
    const b = this._el(
      "button",
      "zcm-btn" +
        (o.variant ? " zcm-btn--" + o.variant : "") +
        (o.sm ? " zcm-btn--sm" : "") +
        (o.iconOnly ? " zcm-btn--icon" : "") +
        (o.cls ? " " + o.cls : "")
    );
    b.setAttribute("type", "button");
    b._sm = !!o.sm;
    if (o.icon) b.appendChild(this._icon(o.icon, o.sm ? "zcm-ic--sm" : ""));
    if (label != null && !o.iconOnly) {
      b.appendChild(this._el("span", "zcm-btn-label", label));
    }
    if (label != null && (o.iconOnly || o.cls === "zcm-collapsible")) {
      b.setAttribute("aria-label", label);
    }
    if (o.title || o.iconOnly) b.setAttribute("title", o.title || label);
    if (o.onClick) b.addEventListener("click", o.onClick);
    return b;
  }

  /** Replace a button's content (e.g. "Adding…" with a spinner, "Added"). */
  _setBtn(b, label, icon) {
    b.textContent = "";
    if (icon) {
      b.appendChild(
        this._icon(icon, (b._sm ? "zcm-ic--sm" : "") + (icon === "spinner" ? " zcm-spin" : ""))
      );
    }
    if (label != null) b.appendChild(this._el("span", "zcm-btn-label", label));
  }

  /**
   * Segmented control: a group of aria-pressed buttons. `options` is a list
   * of [value, label, tooltip?, icon?]. Arrow keys move between segments.
   * Returns the group element; `el._set(value)` updates it silently.
   */
  _seg(ariaLabel, options, current, onChange, o = {}) {
    const g = this._el("div", "zcm-seg" + (o.fill ? " zcm-seg--fill" : ""));
    g.setAttribute("role", "group");
    g.setAttribute("aria-label", ariaLabel);
    const btns = [];
    const paint = (val) => {
      for (const b of btns) {
        b.setAttribute("aria-pressed", b._value === val ? "true" : "false");
      }
    };
    options.forEach(([value, label, tip, icon], i) => {
      const b = this._el("button");
      b.setAttribute("type", "button");
      b._value = value;
      if (icon) b.appendChild(this._icon(icon, "zcm-ic--sm"));
      b.appendChild(this._el("span", "zcm-seg-label", label));
      if (tip) b.setAttribute("title", tip);
      b.addEventListener("click", () => {
        paint(value);
        onChange(value);
      });
      b.addEventListener("keydown", (ev) => {
        const d = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        ev.preventDefault();
        ev.stopPropagation();
        const next = btns[(i + d + btns.length) % btns.length];
        next.focus();
        next.click();
      });
      btns.push(b);
      g.appendChild(b);
    });
    paint(current);
    g._set = paint;
    g._btns = btns;
    return g;
  }

  /** A switch (role="switch"). Returns the element; `el._set(on)` updates it. */
  _switch(checked, ariaLabel, onChange) {
    const s = this._el("span", "zcm-switch");
    s.setAttribute("role", "switch");
    s.setAttribute("tabindex", "0");
    s.setAttribute("aria-label", ariaLabel);
    let on = !!checked;
    const paint = () => s.setAttribute("aria-checked", on ? "true" : "false");
    const toggle = (ev) => {
      if (ev) {
        ev.preventDefault(); // a wrapping <label> must not click it twice
        ev.stopPropagation();
      }
      on = !on;
      paint();
      onChange(on);
    };
    s.addEventListener("click", toggle);
    s.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") toggle(ev);
    });
    // clicking anywhere on the row (a wrapping label) toggles too
    this.win.setTimeout(() => {
      const row = s.parentNode;
      if (row && row.classList && row.classList.contains("zcm-control-row")) {
        row.addEventListener("click", (ev) => {
          if (!s.contains(ev.target)) toggle(ev);
        });
      }
    }, 0);
    paint();
    s._set = (v) => {
      on = !!v;
      paint();
    };
    s._get = () => on;
    return s;
  }

  /**
   * A checkbox row: custom box (role="checkbox") + label to its right. The
   * whole row is clickable. Returns the row; `row.checked` reads/writes the
   * state, like a native input.
   */
  _check(checked, label, onChange, title) {
    const row = this._el("div", "zcm-control-row zcm-check-row");
    if (title) row.setAttribute("title", title);
    const box = this._el("span", "zcm-check");
    box.setAttribute("role", "checkbox");
    box.setAttribute("tabindex", "0");
    box.appendChild(this._icon("check"));
    let on = !!checked;
    const paint = () => box.setAttribute("aria-checked", on ? "true" : "false");
    const toggle = () => {
      on = !on;
      paint();
      if (onChange) onChange(on);
    };
    row.addEventListener("click", toggle);
    box.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        toggle();
      }
    });
    row.appendChild(box);
    const text =
      typeof label === "string" ? this._el("span", "zcm-check-label", label) : label;
    if (typeof label === "string") box.setAttribute("aria-label", label);
    row.appendChild(text);
    Object.defineProperty(row, "checked", {
      get: () => on,
      set: (v) => {
        on = !!v;
        paint();
      },
    });
    paint();
    return row;
  }

  /**
   * A badge (never interactive). kind: suggested | discover | chain | cites
   * | citedby | new | neutral | outline. `iconAfter` puts the pictogram
   * behind the text (direction badges).
   */
  _badge(kind, text, icon, title, iconAfter) {
    const b = this._el("span", "zcm-badge zcm-badge--" + kind);
    if (icon && !iconAfter) b.appendChild(this._icon(icon));
    b.appendChild(this.doc.createTextNode(text));
    if (icon && iconAfter) b.appendChild(this._icon(icon));
    if (title) {
      b.setAttribute("title", title);
      b.setAttribute("aria-label", title);
    }
    return b;
  }

  /** The kind line's small mark: filled disc (library) or open ring. */
  _kindMark(node) {
    const cls =
      node.kind === "unresolved"
        ? "m-nodata"
        : node.kind === "discovered"
        ? node._injected || node._preview || (node.via && node.via !== "refs")
          ? "m-disc"
          : "m-sug"
        : "m-lib";
    const r = cls === "m-sug" || cls === "m-disc" ? 3.6 : 4.5;
    return ZCM_VIEW_NS.Icons.shape(
      this.doc,
      `<circle class="${cls}" cx="5" cy="5" r="${r}"/>`,
      10
    );
  }

  /** Short kind sentence for the tooltip / inspector kind line. */
  _kindLabel(node) {
    if (node.kind === "discovered" && node.via && node.via !== "refs") {
      return node.via === "cites"
        ? `Found by search · cites ${node.citesCount || "several"} of your papers`
        : node.via === "related"
        ? "Found by search · related to your papers"
        : "Found by search · matches your topics";
    }
    if (node._preview) return "Search result · not on the map yet";
    return {
      library: "In your library",
      discovered: "Suggested · not in your library",
      unresolved: "In your library · no citation data",
    }[node.kind];
  }

  /** Announce something to screen readers (polite live region). */
  _announce(text) {
    if (!this._live) return;
    this._live.textContent = "";
    this.win.setTimeout(() => {
      if (this._live) this._live.textContent = text;
    }, 30);
  }

  // ----------------------------------------------------------------- layout

  /**
   * Apply the STRUCTURAL layout as inline styles, so the view lays out
   * correctly even if an external stylesheet fails to load, is cached stale,
   * or a parse error drops rules. The stylesheets still handle all colour
   * and cosmetic styling; these inline rules only own the box model that
   * decides whether the map and sidebar are visible at all. Inline styles
   * always win the cascade and are impossible to lose.
   */
  _applyLayoutStyles(els) {
    const set = (el, css) => {
      if (el) for (const k in css) el.style[k] = css[k];
    };
    set(els.root, {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      minHeight: "0",
      position: "relative",
      overflow: "hidden",
    });
    // one row that never wraps (the responsive steps shrink its contents)
    set(els.bar, {
      display: "flex",
      alignItems: "center",
      flexWrap: "nowrap",
      flex: "0 0 auto",
    });
    set(els.filterBar, { flex: "0 0 auto" });
    set(els.main, {
      display: "flex",
      flex: "1 1 auto",
      minHeight: "180px",
      overflow: "hidden",
      position: "relative",
    });
    set(els.stageOuter, {
      display: "flex",
      flexDirection: "column",
      flex: "1 1 auto",
      minWidth: "0",
      minHeight: "0",
      position: "relative",
    });
    set(els.stage, {
      position: "relative",
      flex: "1 1 auto",
      minWidth: "0",
      minHeight: "0", // kill the content-based min so the canvas can't grow it
      overflow: "hidden",
    });
    set(els.legend, { flex: "0 0 auto" });
    const w = this._sidebarWidth();
    set(els.side, {
      flex: "0 0 " + w + "px",
      // the sidebar itself does NOT scroll; its inner wrapper does, so the
      // tabs row stays pinned at the top
      flexDirection: "column",
      overflow: "hidden",
      minHeight: "0",
      display: this._sidebarCollapsed ? "none" : "flex",
    });
    if (els.resizer) {
      set(els.resizer, {
        flex: "0 0 auto",
        display: this._sidebarCollapsed ? "none" : "block",
      });
    }
    set(els.status, { flex: "0 0 auto" });
  }

  static get SIDEBAR_DEFAULT() {
    return 340;
  }
  static get SIDEBAR_MIN() {
    return 280;
  }
  static get SIDEBAR_MAX() {
    return 520;
  }

  /** Remembered sidebar width, clamped to the allowed range. */
  _sidebarWidth() {
    const C = this.constructor;
    const raw = parseInt(
      Zotero.Prefs.get("extensions.citation-map.sidebarWidth", true),
      10
    );
    let w = Number.isFinite(raw) ? raw : C.SIDEBAR_DEFAULT;
    // medium tabs (900–1023px) default to a slimmer sidebar, unless the user
    // picked a width themselves
    if (w === C.SIDEBAR_DEFAULT && this._sizeClass === "md") w = 300;
    return Math.max(C.SIDEBAR_MIN, Math.min(this._sidebarMax(), w));
  }

  /** Set (and optionally remember) the sidebar width. */
  _setSidebarWidth(w, persist) {
    const C = this.constructor;
    const next = Math.round(Math.max(C.SIDEBAR_MIN, Math.min(this._sidebarMax(), w)));
    if (this._sideEl) this._sideEl.style.flex = "0 0 " + next + "px";
    if (this._resizerEl) this._resizerEl.setAttribute("aria-valuenow", String(next));
    if (persist) {
      try {
        Zotero.Prefs.set("extensions.citation-map.sidebarWidth", next, true);
      } catch (e) {
        /* best-effort */
      }
    }
    this._applySideClasses(next);
    this._layout();
    this._dirty = true;
    return next;
  }

  /** Sidebar-width-dependent details: all tab counts from 400px, fewer labels when slim. */
  _applySideClasses(w) {
    if (!this._sideEl) return;
    this._sideEl.classList.toggle("zcm-side--wide", w >= 400);
    this._sideEl.classList.toggle("zcm-side--narrow", w < 300);
    // between 300 and 340px only the active tab keeps its label
    this._sideEl.classList.toggle("zcm-side--compact", w < 340);
  }

  /**
   * The divider between the map and the sidebar: a 1px line with a 9px hit
   * area. Drag to resize (width remembered), double-click to reset to the
   * default, arrow keys resize by 16px.
   */
  _buildSidebarResizer() {
    const C = this.constructor;
    const bar = this._el("div", "zcm-resizer");
    bar.setAttribute("role", "separator");
    bar.setAttribute("aria-orientation", "vertical");
    bar.setAttribute("aria-label", "Resize sidebar");
    bar.setAttribute("aria-valuemin", String(C.SIDEBAR_MIN));
    bar.setAttribute("aria-valuemax", String(C.SIDEBAR_MAX));
    bar.setAttribute("aria-valuenow", String(this._sidebarWidth()));
    bar.setAttribute("tabindex", "0");
    bar.setAttribute(
      "title",
      "Drag to resize the sidebar · double-click to reset"
    );

    let startX = 0;
    let startW = 0;
    let dragging = false;
    let lastW = null;
    const onMove = (ev) => {
      if (!dragging) return;
      // sidebar is to the RIGHT of the divider, so dragging left widens it
      lastW = this._setSidebarWidth(startW + (startX - ev.clientX), false);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      this.doc.removeEventListener("mousemove", onMove, true);
      this.doc.removeEventListener("mouseup", onUp, true);
      if (lastW) this._setSidebarWidth(lastW, true);
    };
    bar.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      lastW = null;
      startX = ev.clientX;
      startW = this._sideEl
        ? this._sideEl.getBoundingClientRect().width
        : this._sidebarWidth();
      this.doc.addEventListener("mousemove", onMove, true);
      this.doc.addEventListener("mouseup", onUp, true);
      ev.preventDefault();
    });
    bar.addEventListener("dblclick", () =>
      this._setSidebarWidth(C.SIDEBAR_DEFAULT, true)
    );
    bar.addEventListener("keydown", (ev) => {
      const d = ev.key === "ArrowLeft" ? 16 : ev.key === "ArrowRight" ? -16 : 0;
      if (!d) return;
      ev.preventDefault();
      ev.stopPropagation();
      const cur = this._sideEl
        ? this._sideEl.getBoundingClientRect().width
        : this._sidebarWidth();
      this._setSidebarWidth(cur + d, true);
    });
    return bar;
  }

  /** Largest sidebar width allowed right now (never more than ~55% of the tab). */
  _sidebarMax() {
    const C = this.constructor;
    let containerW = 1000;
    try {
      containerW = this.container.getBoundingClientRect().width || 1000;
    } catch (e) {
      /* default */
    }
    return Math.max(C.SIDEBAR_MIN, Math.min(C.SIDEBAR_MAX, Math.round(containerW * 0.55)));
  }

  /**
   * Show/hide the whole sidebar (⌘\ / Ctrl+\ or More ▸ Hide sidebar);
   * remembered across sessions. On narrow tabs (< 900px) the sidebar is an
   * overlay sheet instead, and opening or closing it is not remembered.
   */
  _setSidebarCollapsed(collapsed, persist = true) {
    this._sidebarCollapsed = collapsed;
    if (persist && this._sizeClass !== "sm") {
      try {
        Zotero.Prefs.set(
          "extensions.citation-map.sidebarCollapsed",
          collapsed,
          true
        );
      } catch (e) {
        /* best-effort */
      }
    }
    if (this._sideEl) {
      this._sideEl.style.display = collapsed ? "none" : "flex";
      if (!collapsed) {
        const w = this._sidebarWidth();
        this._sideEl.style.flex = "0 0 " + w + "px";
        this._applySideClasses(w);
      }
    }
    if (this._resizerEl) {
      this._resizerEl.style.display = collapsed ? "none" : "block";
    }
    this._layout();
    this._dirty = true;
  }

  /**
   * Responsive steps, by TAB width (not window width): xl ≥ 1200, lg
   * 1024–1199, md 900–1023, sm < 900. Sets one class on the root; graph.css
   * does the rest (wordmark, search width, icon-only buttons, legend
   * button, sidebar sheet).
   */
  _applyResponsive(w) {
    if (!this.root || !w) return;
    const cls = w >= 1200 ? "xl" : w >= 1024 ? "lg" : w >= 900 ? "md" : "sm";
    if (cls === this._sizeClass) return;
    const prev = this._sizeClass;
    this._sizeClass = cls;
    for (const c of ["xl", "lg", "md", "sm"]) {
      this.root.classList.toggle("zcm-w-" + c, c === cls);
    }
    if (cls === "sm") {
      // the sidebar becomes a sheet over the map: start closed unless a
      // paper is being inspected
      this._sidebarWasCollapsed = this._sidebarCollapsed;
      if (!this._inspecting) this._setSidebarCollapsed(true, false);
    } else if (prev === "sm") {
      this._setSidebarCollapsed(!!this._sidebarWasCollapsed, false);
    } else if (this._sideEl && !this._sidebarCollapsed) {
      const sw = this._sidebarWidth();
      this._sideEl.style.flex = "0 0 " + sw + "px";
      this._applySideClasses(sw);
    }
  }

  /**
   * Give the root a definite pixel height from the measured tab container,
   * so the flex column can distribute space even if the container's own
   * height model doesn't make `height:100%` resolve. Falls back to the
   * window height (minus the container's top offset) when the container
   * measures as collapsed. Called on init, on resize, and on a few retries
   * after open (the tab is often unsized for the first frames).
   */
  _layout() {
    if (this._destroyed || !this.root) return;
    let h = 0;
    let w = 0;
    try {
      const cr = this.container.getBoundingClientRect();
      h = cr.height;
      w = cr.width;
      if (h < 120 && this.win.innerHeight) {
        // container reports collapsed, fill down to the window bottom
        h = Math.max(240, this.win.innerHeight - cr.top - 8);
      }
    } catch (e) {
      /* fall through to a safe default */
    }
    if (!h || h < 120) h = 480; // last-resort default so nothing is invisible
    h = Math.round(h);
    if (w > 0) this._applyResponsive(w);
    // Only write when it actually changed, observing the container for
    // resizes could otherwise feed back on itself if the container sizes to
    // its content.
    if (h !== this._lastRootH) {
      this._lastRootH = h;
      this.root.style.height = h + "px";
      this._diag("layout", { containerW: Math.round(w), rootH: h });
    }
    this._resize();
  }

  /** Lightweight diagnostics to Help → Debug Output, prefixed for the user. */
  _diag(where, obj) {
    try {
      Zotero.debug(
        "[Citation Map][diag] " + where + " " + JSON.stringify(obj)
      );
    } catch (e) {
      /* never let logging throw */
    }
  }

  // ------------------------------------------------------------------ theme

  /**
   * Resolve the Appearance setting (auto | light | dark) and apply it: one
   * attribute (data-theme on the root) switches every CSS token, and the
   * canvas swaps to the mirrored palette and redraws once. In Auto the view
   * follows Zotero's own colour scheme the moment it changes.
   */
  _initTheme() {
    const MT = ZCM_VIEW_NS.MapTheme;
    this.appearance = MT.storedMode();
    if (this._themeDispose) this._themeDispose();
    this._themeDispose = MT.applyTheme(this.root, this.win, this.appearance, (palette) => {
      this.T = palette;
      this._onThemeChanged();
    });
  }

  _onThemeChanged() {
    if (this.legend) this._renderLegend(); // palette swatches are per theme
    if (this._inspecting && this._inspectedNode) {
      this._renderDetails(this._inspectedNode); // journal colour square
    }
    this._dirty = true;
  }

  /** Display ▸ Appearance: remember the choice and apply it immediately. */
  _setAppearance(mode) {
    try {
      Zotero.Prefs.set(ZCM_VIEW_NS.MapTheme.PREF_THEME, mode, true);
    } catch (e) {
      /* best-effort */
    }
    this._initTheme();
  }

  // ------------------------------------------------------------------- DOM

  _buildDOM() {
    const root = this._el("div", "zcm-root");
    this.root = root;
    this._initTheme();
    // the Appearance pref can also change from Zotero's settings pane or
    // another open map: follow it
    try {
      this._themePrefObs = Zotero.Prefs.registerObserver(
        ZCM_VIEW_NS.MapTheme.PREF_THEME,
        () => {
          if (this._destroyed) return;
          this._initTheme();
          if (this._popoverSync) this._popoverSync();
        },
        true
      );
    } catch (e) {
      /* no observer support: the Display popover still applies changes */
    }
    const mac = this._isMac();
    this._mac = mac;

    // ---- toolbar: brand · collection · layout · search · … · filter ·
    // display · rebuild · more. Order follows the workflow: choose scope,
    // choose view, find, refine, act. One 48px row that never wraps.
    const bar = this._el("div", "zcm-toolbar");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Citation Map");
    const brand = this._el("div", "zcm-brand");
    brand.setAttribute("title", "Citation Map");
    brand.appendChild(ZCM_VIEW_NS.Icons.logo(this.doc, "Citation Map"));
    brand.appendChild(this._el("span", "zcm-wordmark", "Citation Map"));
    bar.appendChild(brand);

    bar.appendChild(this._buildScopeControl());
    bar.appendChild(this._el("span", "zcm-sep"));

    // layout toggle
    const toggle = this._seg(
      "Layout",
      [
        [
          "timeline",
          "Timeline",
          "Left → right = publication year · higher = more cited · T",
          "timeline",
        ],
        [
          "force",
          "Network",
          "Papers that cite each other cluster into islands, labelled by topic · N",
          "network",
        ],
      ],
      this.mode,
      (v) => this._setMode(v)
    );
    this._layoutToggle = toggle; // coachmark anchor
    bar.appendChild(toggle);

    // search: dims papers that don't match (title or author)
    const searchField = this._el("label", "zcm-field zcm-search");
    searchField.appendChild(this._icon("search"));
    this.search = this._el("input");
    this.search.setAttribute("type", "text");
    this.search.setAttribute("placeholder", "Search title or author");
    this.search.setAttribute("aria-label", "Search the map");
    const kbd = this._el("span", "zcm-kbd", mac ? "⌘F" : "Ctrl+F");
    const clear = this._el("button", "zcm-field-clear");
    clear.setAttribute("type", "button");
    clear.setAttribute("aria-label", "Clear search");
    clear.setAttribute("title", "Clear search · Esc");
    clear.appendChild(this._icon("close", "zcm-ic--sm"));
    clear.style.display = "none";
    const syncSearch = () => {
      this.query = this.search.value.trim().toLowerCase();
      clear.style.display = this.search.value ? "" : "none";
      kbd.style.display = this.search.value ? "none" : "";
      this._dirty = true;
    };
    this._clearSearch = () => {
      this.search.value = "";
      syncSearch();
    };
    this.search.addEventListener("input", syncSearch);
    this.search.addEventListener("blur", () => {
      if (!this.search.value) searchField.classList.remove("is-open");
    });
    clear.addEventListener("click", (ev) => {
      ev.preventDefault();
      this._clearSearch();
      this.search.focus();
    });
    searchField.appendChild(this.search);
    searchField.appendChild(kbd);
    searchField.appendChild(clear);
    this._searchField = searchField;
    bar.appendChild(searchField);
    // below 900px the field collapses to this icon button, which expands it
    // over the centre of the toolbar
    const searchBtn = this._btn("Search the map", {
      icon: "search",
      iconOnly: true,
      cls: "zcm-search-btn",
      title: "Search title or author · " + (mac ? "⌘F" : "Ctrl+F"),
      onClick: () => this._focusSearch(),
    });
    bar.appendChild(searchBtn);

    bar.appendChild(this._el("span", "zcm-spacer"));

    // Hide reviews: a prominent toggle (also in Filter, and as a chip in the
    // filter bar while it is on)
    const reviewBtn = this._btn("Hide reviews", {
      icon: "eye-off",
      variant: "secondary",
      cls: "zcm-collapsible zcm-review-toggle",
      onClick: () => this._setHideReviews(!this.hideReviews),
    });
    this._reviewBtn = reviewBtn;
    this._syncReviewBtn();
    bar.appendChild(reviewBtn);
    bar.appendChild(this._buildFilterControl());
    bar.appendChild(this._buildDisplayControl());
    bar.appendChild(this._el("span", "zcm-sep"));
    const rebuildBtn = this._btn("Rebuild", {
      icon: "refresh",
      variant: "secondary",
      cls: "zcm-collapsible",
      title: "Re-fetch citation data and redraw",
      onClick: () => this.ctx.rebuild(),
    });
    this._rebuildBtn = rebuildBtn;
    bar.appendChild(rebuildBtn);
    bar.appendChild(this._buildMoreControl());
    root.appendChild(bar);

    // ---- filter bar (only while a filter is active)
    const filterBar = this._el("div", "zcm-filterbar");
    filterBar.setAttribute("role", "group");
    filterBar.setAttribute("aria-label", "Active filters");
    filterBar.style.display = "none";
    this._filterBarEl = filterBar;
    root.appendChild(filterBar);

    // ---- main area: stage (map + legend footer) | resizer | sidebar
    const main = this._el("div", "zcm-main");
    const stageOuter = this._el("div", "zcm-stage");
    const stage = this._el("div", "zcm-mapwrap");
    this.canvas = this.doc.createElement("canvas");
    this.canvas.className = "zcm-canvas";
    // Absolutely positioned so the canvas NEVER contributes to the stage's
    // content size. Otherwise sizing the canvas from the stage grows the
    // stage (a flex item's default min-size is its content), which grows the
    // canvas next frame, a runaway that ends in "Canvas exceeds max size"
    // and a map that never draws.
    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.display = "block";
    // one tab stop; arrow keys move between papers
    this.canvas.setAttribute("tabindex", "0");
    this.canvas.setAttribute("role", "application");
    this.canvas.setAttribute("aria-roledescription", "citation map");
    this.canvas.setAttribute(
      "aria-label",
      "Citation map. Arrow keys move between papers, Enter opens the details."
    );
    stage.appendChild(this.canvas);
    this.tooltip = this._el("div", "zcm-tooltip");
    this.tooltip.setAttribute("role", "tooltip");
    this.tooltip.style.display = "none";
    stage.appendChild(this.tooltip);

    // floating map controls (top-right corner of the map)
    const controls = this._el("div", "zcm-mapctl");
    controls.setAttribute("role", "toolbar");
    controls.setAttribute("aria-label", "Map view");
    for (const [icon, label, tip, fn] of [
      ["plus", "Zoom in", "Zoom in · +", () => this._zoomBy(1.3)],
      ["minus", "Zoom out", "Zoom out · −", () => this._zoomBy(1 / 1.3)],
      ["fit", "Fit all papers", "Fit all papers · 0", () => this._fitView(true)],
      [], // divider
      ["help", "Quick tour", "Quick tour, with a link to the full guide", () => this._showTour()],
    ]) {
      if (!icon) {
        controls.appendChild(this._el("hr"));
        continue;
      }
      controls.appendChild(
        this._btn(label, { icon, iconOnly: true, title: tip, onClick: fn })
      );
    }
    stage.appendChild(controls);
    this._mapControls = controls; // coachmark anchor

    // screen readers: the focused paper, build milestones, results
    this._live = this._el("div", "zcm-sr-only");
    this._live.setAttribute("aria-live", "polite");
    stage.appendChild(this._live);

    stageOuter.appendChild(stage);

    // legend: a footer strip under the map, adapts to the color mode
    this.legend = this._el("div", "zcm-legend");
    this.legend.setAttribute("aria-label", "Legend");
    this._renderLegend();
    stageOuter.appendChild(this.legend);

    main.appendChild(stageOuter);
    this.stage = stage;
    this._stageOuter = stageOuter;
    this._mainEl = main;
    this._barEl = bar;

    // Divider between the map and the sidebar (drag to resize).
    const resizer = this._buildSidebarResizer();
    this._resizerEl = resizer;
    main.appendChild(resizer);

    const side = this._buildSidebar();
    this._sideEl = side;
    // reflect a persisted "hide reviews" state on the lists straight away
    this._applyReviewDim();
    main.appendChild(side);

    root.appendChild(main);

    // ---- status bar
    this.status = this._el("div", "zcm-status");
    this._renderStatus();
    root.appendChild(this.status);

    // Structural layout as inline styles, independent of the external
    // stylesheets, so the map + sidebar are laid out even if the CSS never
    // applies (failed load, stale cache, parse error). Do this BEFORE the
    // container append so the first paint is already correct.
    this._applyLayoutStyles({
      root,
      bar,
      filterBar,
      main,
      stageOuter,
      stage,
      legend: this.legend,
      side,
      resizer,
      status: this.status,
    });
    this._applySideClasses(this._sidebarWidth());

    this.container.appendChild(root);
    this._attachCanvasEvents();
    this._filtersChanged(); // a persisted "hide reviews" shows its chip

    // keyboard shortcuts (document-level, only while this tab is in front)
    this._keyHandler = (ev) => this._onKeyDown(ev);
    this.doc.addEventListener("keydown", this._keyHandler, true);

    // Diagnostic: are the external stylesheets actually applying? (Checks a
    // token only tokens.css sets.) Logged for support, and used to show a
    // gentle on-screen note if the cosmetic styles are missing.
    try {
      const bg = this._css("--zcm-canvas");
      this._cssApplied = !!bg;
      this._diag("css", { applied: this._cssApplied, canvas: bg, theme: this.T.name });
    } catch (e) {
      this._cssApplied = true; // don't nag if the probe itself failed
    }

    // If the cosmetic stylesheets aren't applying, the inline layout above
    // still shows the map, but colours/spacing look wrong. Surface a
    // self-styled (CSS-independent) hint so the user knows and can report.
    if (!this._cssApplied) {
      const note = this.doc.createElement("div");
      note.style.cssText =
        "position:absolute;left:8px;bottom:8px;z-index:90;max-width:420px;" +
        "padding:8px 10px;border-radius:10px;font:12px system-ui,sans-serif;" +
        "background:Canvas;color:CanvasText;border:1px solid CanvasText";
      note.textContent =
        "Citation Map: the stylesheet didn't load, so this looks unstyled " +
        "(the map should still work). Please report this, see Help → " +
        "Debug Output Logging for details.";
      stage.appendChild(note);
    }

    this._layout();
    // The tab is frequently unsized for the first frames; re-measure a few
    // times so the map fills once real dimensions arrive.
    [80, 200, 500, 1000].forEach((ms) =>
      this.win.setTimeout(() => this._layout(), ms)
    );

    this._resizeObserver = new this.win.ResizeObserver(() => {
      this._layout();
      this._dirty = true;
    });
    // Observe the CONTAINER (the tab), not just the stage, the stage only
    // has a size once the layout above has given it one.
    this._resizeObserver.observe(this.container);
    this._resizeObserver.observe(stage);
    this._onWinResize = () => {
      this._layout();
      this._dirty = true;
    };
    this.win.addEventListener("resize", this._onWinResize);

    // Canvas text silently falls back if the bundled face isn't loaded yet:
    // wait for it, then redraw once so labels use it.
    ZCM_VIEW_NS.MapTheme.ensureMapFonts(this.doc).then(() => {
      this._dirty = true;
    });
  }

  /** macOS? (decides whether shortcuts read ⌘ or Ctrl) */
  _isMac() {
    if (typeof Zotero !== "undefined" && typeof Zotero.isMac === "boolean") {
      return Zotero.isMac;
    }
    const nav = this.win.navigator || {};
    return /Mac/i.test(nav.platform || nav.userAgent || "");
  }

  /** Focus the toolbar search (expanding it first on narrow tabs). */
  _focusSearch() {
    if (!this.search) return;
    if (this._searchField) this._searchField.classList.add("is-open");
    this.search.focus();
    this.search.select();
  }

  /**
   * Status bar: counts with bold numbers on the left, the current layout
   * and scale on the right, plus the Shortcuts button. (The long hint text
   * of earlier versions lives in the shortcuts popover now.)
   */
  _renderStatus() {
    const st = this.status;
    if (!st) return;
    st.textContent = "";
    const s = this.graph.stats;
    const ch = this.ctx && this.ctx.changed;
    const stat = (n, label, tip) => {
      const el = this._el("span", "zcm-stat-item");
      el.appendChild(this._el("b", null, Number(n || 0).toLocaleString()));
      el.appendChild(this.doc.createTextNode(" " + label));
      if (tip) el.setAttribute("title", tip);
      st.appendChild(el);
    };
    stat(s.items, s.items === 1 ? "item" : "items", "Papers in the mapped selection");
    stat(s.resolved, "resolved", "Papers matched on OpenAlex (by DOI)");
    stat(s.edges, s.edges === 1 ? "link" : "links", "Citation links between the papers on this map");
    stat(s.discovered, s.discovered === 1 ? "suggestion" : "suggestions", "Papers several of yours cite that aren't in your library");
    const newCount = ch ? ch.papers + ch.suggestions : 0;
    if (newCount > 0) stat(newCount, "new", "New since the last build of this collection");
    st.appendChild(this._el("span", "zcm-spacer"));
    const modeEl = this._el("span", "zcm-status-mode");
    this._statusMode = modeEl;
    st.appendChild(modeEl);
    this._renderStatusMode();
    const keysBtn = this._btn("Shortcuts", {
      sm: true,
      icon: "keyboard",
      title: "Keyboard shortcuts and mouse gestures · ?",
    });
    this._shortcutsBtn = keysBtn;
    this._popover(keysBtn, (panel) => this._buildShortcuts(panel), { width: 340 });
    st.appendChild(keysBtn);
    const ns = ZCM_VIEW_NS || {};
    st.setAttribute(
      "title",
      `Citation Map ${ns.version || ""}` + (ns.build ? ` · build ${ns.build}` : "")
    );
  }

  _renderStatusMode() {
    if (!this._statusMode) return;
    this._statusMode.textContent =
      this.mode === "timeline"
        ? "Timeline · " +
          (this.yMetric === "local" ? "cited on this map" : "citations worldwide")
        : "Network · citation islands";
  }

  /** The shortcuts popover (status bar button, or "?"). */
  _buildShortcuts(panel) {
    const mod = this._mac ? "⌘" : "Ctrl+";
    const keysSec = this._popSection(panel, "Keyboard shortcuts");
    const grid = this._el("div", "zcm-keys");
    for (const [keys, what] of [
      [[mod + "F"], "Focus search"],
      [["Esc"], "Clear search, close popover or details"],
      [["T", "N"], "Timeline · Network"],
      [["+", "−", "0"], "Zoom in · out · fit"],
      [["←", "↑", "→", "↓"], "Move between papers (click the map first)"],
      [["Enter"], "Open the focused paper's details"],
      [["A"], "Add the focused suggestion to Zotero"],
      [["1", "2", "3", "4"], "Switch sidebar tab"],
      [["S", mod + "\\"], "Show or hide the sidebar"],
      [["?"], "This list"],
    ]) {
      const k = this._el("span", "zcm-keys-k");
      for (const key of keys) k.appendChild(this._el("span", "zcm-kbd", key));
      grid.appendChild(k);
      grid.appendChild(this._el("span", "zcm-keys-what", what));
    }
    keysSec.appendChild(grid);
    const mouseSec = this._popSection(panel, "Trackpad and mouse");
    for (const line of [
      "Trackpad: slide two fingers to move the map, pinch to zoom",
      "Mouse: scroll to zoom toward the pointer · drag the background to pan",
      "Click a paper for its details · double-click to zoom to it and its links",
      "In the Network, drag a paper to pin it · double-click the background to fit",
    ]) {
      mouseSec.appendChild(this._el("span", "zcm-help", line));
    }
  }

  /**
   * Keyboard shortcuts. Only active while this map's tab is in front, and
   * single-key shortcuts never fire while typing in a field.
   */
  _onKeyDown(ev) {
    if (this._destroyed || !this._isVisible() || ev.defaultPrevented) return;
    const key = ev.key;
    const mod = ev.metaKey || ev.ctrlKey;
    const t = ev.target;
    const inRoot = !!(t && this.root.contains(t));
    const typing = !!(
      t &&
      t.localName &&
      (["input", "textarea", "select"].includes(t.localName) || t.isContentEditable)
    );
    const eat = () => {
      ev.preventDefault();
      ev.stopPropagation();
    };

    if (mod && !ev.altKey && !ev.shiftKey && (key === "f" || key === "F")) {
      eat();
      this._focusSearch();
      return;
    }
    if (mod && key === "\\") {
      eat();
      this._setSidebarCollapsed(!this._sidebarCollapsed);
      return;
    }
    if (key === "Escape") {
      // in order: clear search, close popover, close guide, close details
      if (this._cm) return; // the walkthrough handles its own Esc
      if (this.search && (this.search.value || t === this.search)) {
        eat();
        if (this.search.value) this._clearSearch();
        else {
          this.search.blur();
          if (this.canvas) this.canvas.focus();
        }
      } else if (this._openPopover) {
        eat();
        this._closePopover(true);
      } else if (this._guide) {
        eat();
        this._closeGuide();
      } else if (this._inspecting || this.selected) {
        eat();
        this._select(null, false);
      }
      return;
    }
    if (typing || mod || ev.altKey) return;
    // single keys: only when focus is inside the map view (or nowhere)
    const body = this.doc.body || this.doc.documentElement;
    if (!inRoot && t !== body && t !== this.doc.documentElement) return;
    const onButton = !!(t && t.localName === "button") || (t && t.getAttribute && t.getAttribute("role") === "switch");
    const onCanvas = t === this.canvas;

    if (onCanvas && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) {
      eat();
      this._kbdMove(key);
      return;
    }
    if (onCanvas && key === "Enter") {
      const k = this._kbdFocus || this.hovered;
      if (k) {
        eat();
        this._select(k, false);
      }
      return;
    }
    if (onButton && (key === " " || key === "Enter")) return; // activate the button
    switch (key) {
      case "t":
      case "T":
        eat();
        this._setMode("timeline");
        break;
      case "n":
      case "N":
        eat();
        this._setMode("force");
        break;
      case "+":
      case "=":
        eat();
        this._zoomBy(1.3);
        break;
      case "-":
      case "−":
      case "_":
        eat();
        this._zoomBy(1 / 1.3);
        break;
      case "0":
        eat();
        this._fitView(true);
        break;
      case "1":
      case "2":
      case "3":
      case "4": {
        eat();
        const id = ["suggested", "discover", "chains", "papers"][parseInt(key, 10) - 1];
        if (this._sidebarCollapsed) this._setSidebarCollapsed(false);
        if (this._inspecting) this._closeInspector();
        this._setSideTab(id);
        break;
      }
      case "a":
      case "A": {
        const k = this._kbdFocus || this.hovered || this.selected;
        const n = k ? this.nodeByKey.get(k) : null;
        if (n && n.kind === "discovered" && n.doi) {
          eat();
          this._select(n.key, false);
          if (this._addBtn) this._addDiscovered(n, this._addBtn);
        }
        break;
      }
      case "s":
      case "S":
        eat();
        this._setSidebarCollapsed(!this._sidebarCollapsed);
        break;
      case "?":
        eat();
        if (this._shortcutsBtn && this._shortcutsBtn._zcmOpen) this._shortcutsBtn._zcmOpen();
        break;
      default:
    }
  }

  /** Arrow keys on the map: move focus to the nearest paper in that direction. */
  _kbdMove(key) {
    const nodes = this._active().nodes;
    if (!nodes.length) return;
    const curKey = this._kbdFocus || this.hovered || this.selected;
    let cur = curKey ? this.nodeByKey.get(curKey) : null;
    if (cur && this._hiddenFromMap(cur)) cur = null;
    let next = null;
    if (!cur) {
      // start from the paper nearest the centre of the view
      const cx = -this.transform.x / this.transform.k;
      const cy = -this.transform.y / this.transform.k;
      let best = Infinity;
      for (const n of nodes) {
        const d = (n.x - cx) ** 2 + (n.y - cy) ** 2;
        if (d < best) {
          best = d;
          next = n;
        }
      }
    } else {
      const dir = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }[key];
      let best = Infinity;
      for (const n of nodes) {
        if (n === cur) continue;
        const dx = n.x - cur.x;
        const dy = n.y - cur.y;
        const along = dx * dir[0] + dy * dir[1];
        if (along <= 0) continue;
        const across = Math.abs(dx * dir[1] - dy * dir[0]);
        if (across > along * 2.5) continue; // too far off-axis
        const score = along + across * 2;
        if (score < best) {
          best = score;
          next = n;
        }
      }
    }
    if (!next) return;
    this._kbdFocus = next.key;
    this.hovered = next.key;
    // pan it into view if it sits outside (or close to) the edge
    const k = this.transform.k;
    const sx = this.width / 2 + this.transform.x + next.x * k;
    const sy = this.height / 2 + this.transform.y + next.y * k;
    if (sx < 60 || sx > this.width - 60 || sy < 60 || sy > this.height - 60) {
      this._autoFit = false;
      this._animateTransform(-next.x * k, -next.y * k, k);
    }
    this._showTooltip(next);
    this._announce(this._describe(next));
    this._dirty = true;
  }

  /** One sentence describing a paper, for screen readers. */
  _describe(n) {
    let nOut = 0;
    let nIn = 0;
    for (const e of this._active().edges) {
      if (e.source === n.key) nOut++;
      else if (e.target === n.key) nIn++;
    }
    const kind = {
      library: "in your library",
      discovered: n._injected ? "found by search" : "suggested, not in your library",
      unresolved: "in your library, no citation data",
    }[n.kind];
    return (
      `${n.title}, ${n.year || "undated"}, ${kind}, cites ${nOut} and is cited ` +
      `by ${nIn} paper${nIn === 1 ? "" : "s"} on this map`
    );
  }

  // --------------------------------------------------------------- sidebar

  static get SIDE_TABS() {
    return [
      // id, label, pictogram, feature hue, tooltip
      ["suggested", "Suggested", "bulb", "--zcm-f-suggested", "Papers you're missing, from your own citations (instant, offline) · 1"],
      ["discover", "Discover", "compass", "--zcm-f-discover", "Live web search for papers beyond your library · 2"],
      ["chains", "Chains", "chain", "--zcm-f-chain", "Citation chains through time · 3"],
      ["papers", "Mine", "books", "--zcm-f-library", "Everything in this collection · 4"],
    ];
  }

  _buildSidebar() {
    const side = this._el("aside", "zcm-side");
    side.setAttribute("aria-label", "Sidebar");

    // The lists live in tabs so each gets the space instead of stacking
    // into one long scroll; the last-used tab is remembered. Each panel is
    // built defensively: one broken panel must never take down the view.
    const tabs = this._el("div", "zcm-tabs");
    tabs.setAttribute("role", "tablist");
    this._tabsEl = tabs;
    this._tabBtns = {};
    this._tabCounts = {};
    this._tabPanels = {
      suggested: this._safePanel("Suggested", () => this._buildSuggestedPanel()),
      discover: this._safePanel("Discover", () => this._buildDiscoverPanel()),
      chains: this._safePanel("Citation chains", () => this._buildChainsPanel()),
      papers: this._safePanel("Mine", () => this._buildPapersPanel()),
    };
    const order = this.constructor.SIDE_TABS.map((t) => t[0]);
    for (const [id, label, icon, hue, tip] of this.constructor.SIDE_TABS) {
      const b = this._el("button", "zcm-tab");
      b.setAttribute("type", "button");
      b.setAttribute("role", "tab");
      b.setAttribute("title", tip);
      b.setAttribute("aria-label", label);
      b.style.setProperty("--tab-hue", `var(${hue})`);
      b.appendChild(this._icon(icon, "zcm-ic--sm"));
      b.appendChild(this._el("span", "zcm-tab-label", label));
      const n = this._el("span", "zcm-tab-n");
      b.appendChild(n);
      this._tabCounts[id] = n;
      b.addEventListener("click", () => this._setSideTab(id));
      // roving tabindex: arrow keys move between tabs
      b.addEventListener("keydown", (ev) => {
        const d = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        ev.preventDefault();
        ev.stopPropagation();
        const next = order[(order.indexOf(id) + d + order.length) % order.length];
        this._setSideTab(next);
        this._tabBtns[next].focus();
      });
      this._tabBtns[id] = b;
      tabs.appendChild(b);
      const p = this._tabPanels[id];
      p.setAttribute("role", "tabpanel");
      p.setAttribute("aria-label", label);
    }
    // The tabs stay PINNED at the top; only the panels below them scroll.
    // Inline styles here (and on the sidebar in _applyLayoutStyles) so this
    // holds even if the external stylesheet is stale/unloaded.
    tabs.style.flex = "0 0 auto";
    side.appendChild(tabs);
    const scroll = this._el("div", "zcm-side-body");
    Object.assign(scroll.style, {
      flex: "1 1 auto",
      minHeight: "0",
      overflowY: "auto",
      overflowX: "hidden",
    });
    this._sideScrollEl = scroll;
    for (const p of Object.values(this._tabPanels)) scroll.appendChild(p);
    side.appendChild(scroll);

    // The inspector: selecting a paper shows its details in this column,
    // in place of the tabs, so the map stays fully visible.
    side.appendChild(this._buildInspector());

    this._refreshTabCounts();
    const saved = Zotero.Prefs.get("extensions.citation-map.sideTab", true);
    this._setSideTab(this._tabPanels[saved] ? saved : "suggested", false);
    return side;
  }

  /** Counts beside the tab labels (the active tab's; all of them when wide). */
  _refreshTabCounts() {
    if (!this._tabCounts) return;
    const nodes = this.graph.nodes;
    const counts = {
      suggested: nodes.filter(
        (n) =>
          n.kind === "discovered" &&
          !n._injected &&
          n.inLibraryCitations >= this.suggestMinCiters
      ).length,
      discover: this._lastDiscoverEntries ? this._lastDiscoverEntries.length : null,
      chains: (this.graph.chains || []).length,
      papers: nodes.filter((n) => n.kind !== "discovered").length,
    };
    for (const [id, el] of Object.entries(this._tabCounts)) {
      const c = counts[id];
      el.textContent = c == null ? "" : String(c);
      el.style.display = c == null ? "none" : "";
    }
  }

  _setSideTab(id, persist = true) {
    this.sideTab = id;
    for (const [k, b] of Object.entries(this._tabBtns)) {
      const on = k === id;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.setAttribute("tabindex", on ? "0" : "-1");
    }
    for (const [k, p] of Object.entries(this._tabPanels)) {
      p.style.display = k === id ? "" : "none";
    }
    if (this._sideScrollEl) this._sideScrollEl.scrollTop = 0;
    if (persist) {
      try {
        Zotero.Prefs.set("extensions.citation-map.sideTab", id, true);
      } catch (e) {
        /* best-effort */
      }
    }
  }

  // ------------------------------------------------------------- inspector

  /**
   * The inspector column: a 44px bar (back, label, previous / next, close)
   * above a scrolling body that _renderDetails / _renderNotes fill.
   * `this.details` is the BODY; the bar persists across selections.
   */
  _buildInspector() {
    const insp = this._el("div", "zcm-insp");
    insp.style.display = "none";
    insp.style.flex = "1 1 auto";
    insp.style.minHeight = "0";
    const bar = this._el("div", "zcm-insp-bar");
    const back = this._btn("Back to the list", {
      icon: "chev-left",
      iconOnly: true,
      sm: true,
      onClick: () => this._closeInspector(),
    });
    this._inspBack = back;
    bar.appendChild(back);
    bar.appendChild(this._el("span", "zcm-label", "Paper"));
    const prev = this._btn("Previous paper in the list", {
      icon: "chev-up",
      iconOnly: true,
      sm: true,
      onClick: () => this._inspectStep(-1),
    });
    const next = this._btn("Next paper in the list", {
      icon: "chev-down",
      iconOnly: true,
      sm: true,
      onClick: () => this._inspectStep(1),
    });
    this._inspPrev = prev;
    this._inspNext = next;
    bar.appendChild(prev);
    bar.appendChild(next);
    bar.appendChild(
      this._btn("Close", {
        icon: "close",
        iconOnly: true,
        sm: true,
        title: "Close · Esc",
        onClick: () => this._select(null, false),
      })
    );
    insp.appendChild(bar);
    const body = this._el("div", "zcm-insp-body");
    Object.assign(body.style, {
      flex: "1 1 auto",
      minHeight: "0",
      overflowY: "auto",
      overflowX: "hidden",
      wordBreak: "break-word", // long titles / DOIs wrap instead of overflowing
    });
    insp.appendChild(body);
    this.details = body;
    this._inspEl = insp;
    return insp;
  }

  /** Show the inspector in place of the tabs (remembering the list's scroll). */
  _openInspector() {
    if (!this._inspEl) return;
    if (!this._inspecting) {
      this._savedScroll = this._sideScrollEl ? this._sideScrollEl.scrollTop : 0;
      this._tabsEl.style.display = "none";
      this._sideScrollEl.style.display = "none";
      this._inspEl.style.display = "flex";
      this._inspecting = true;
      // restart the slide-in
      this._inspEl.classList.remove("zcm-insp--in");
      void this._inspEl.offsetWidth;
      this._inspEl.classList.add("zcm-insp--in");
    }
    const label = (this.constructor.SIDE_TABS.find((t) => t[0] === this.sideTab) || [])[1];
    if (this._inspBack && label) {
      this._inspBack.setAttribute("aria-label", "Back to " + label);
      this._inspBack.setAttribute("title", "Back to " + label);
    }
    if (this._sidebarCollapsed) {
      // show the details even when the sidebar was hidden; closing the
      // inspector hides it again
      this._reopenedForInspector = true;
      this._setSidebarCollapsed(false, false);
    }
    this.details.scrollTop = 0;
    this._syncInspectNav();
  }

  /** Back to the tab that was open, with its scroll position kept. */
  _closeInspector() {
    if (!this._inspecting) return;
    this._inspecting = false;
    this._inspectedNode = null;
    this._inspEl.style.display = "none";
    this._tabsEl.style.display = "";
    this._sideScrollEl.style.display = "";
    this._sideScrollEl.scrollTop = this._savedScroll || 0;
    if (this._reopenedForInspector) {
      this._reopenedForInspector = false;
      this._setSidebarCollapsed(true, false);
    }
  }

  /** The rows of the current tab's list that can be opened, in order. */
  _inspectRows() {
    const panel = this._tabPanels && this._tabPanels[this.sideTab];
    if (!panel) return [];
    const seen = new Set();
    const rows = [];
    for (const row of panel.querySelectorAll(".zcm-row[data-key]")) {
      if (row.style.display === "none" || !row._zcmOpen) continue;
      const key = row.getAttribute("data-key");
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    return rows;
  }

  _syncInspectNav() {
    const rows = this._inspectRows();
    const key = this._inspectedNode && this._inspectedNode.key;
    const i = rows.findIndex((r) => r.getAttribute("data-key") === key);
    if (this._inspPrev) this._inspPrev.disabled = !(i > 0);
    if (this._inspNext) {
      this._inspNext.disabled = !(rows.length && i < rows.length - 1);
    }
  }

  /** ↑ / ↓ in the inspector bar: step through the current list. */
  _inspectStep(d) {
    const rows = this._inspectRows();
    if (!rows.length) return;
    const key = this._inspectedNode && this._inspectedNode.key;
    const i = rows.findIndex((r) => r.getAttribute("data-key") === key);
    const next = rows[i < 0 ? (d > 0 ? 0 : rows.length - 1) : i + d];
    if (next && next._zcmOpen) next._zcmOpen();
  }

  /** Mirror the selection in every sidebar list (the selected row's bar). */
  _markSelectedRows(key) {
    if (!this._sideEl) return;
    for (const row of this._sideEl.querySelectorAll(".zcm-row[data-key]")) {
      row.classList.toggle("is-selected", !!key && row.getAttribute("data-key") === key);
    }
  }

  /**
   * A list row (components.css .zcm-row): meta line · title · subline, with
   * an actions column on the right. `open` runs on click / Enter; hovering
   * a row whose paper is on the map highlights it there.
   */
  _row(key, open) {
    const row = this._el("div", "zcm-row");
    if (key) row.setAttribute("data-key", key);
    const meta = this._el("div", "zcm-row-meta");
    const title = this._el("div", "zcm-row-title");
    const sub = this._el("div", "zcm-row-sub");
    const actions = this._el("div", "zcm-row-actions");
    actions.addEventListener("click", (ev) => ev.stopPropagation());
    row.appendChild(meta);
    row.appendChild(title);
    row.appendChild(sub);
    row.appendChild(actions);
    if (open) {
      row._zcmOpen = open;
      row.setAttribute("tabindex", "0");
      row.setAttribute("role", "button");
      row.addEventListener("click", open);
      row.addEventListener("keydown", (ev) => {
        if (ev.target !== row) return;
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          open();
        }
      });
    }
    if (key) {
      row.addEventListener("mouseenter", () => {
        const n = this.nodeByKey.get(key);
        if (n && !this._hiddenFromMap(n)) {
          this.hovered = key;
          this._dirty = true;
        }
      });
      row.addEventListener("mouseleave", () => {
        if (this.hovered === key) {
          this.hovered = null;
          this._dirty = true;
        }
      });
    }
    return { row, meta, title, sub, actions };
  }

  /** A sidebar panel shell: title + one-line explanation, then content. */
  _panel(title, sub) {
    const panel = this._el("div", "zcm-panel");
    const head = this._el("div", "zcm-panel-head");
    head.appendChild(this._el("h3", "zcm-panel-title", title));
    if (sub) head.appendChild(this._el("p", "zcm-panel-sub", sub));
    panel.appendChild(head);
    return panel;
  }

  /** An empty state: icon tile in the feature colour, title, text. */
  _empty(icon, feature, title, text) {
    const box = this._el("div", "zcm-empty");
    const tile = this._el("div", "zcm-empty-icon");
    tile.appendChild(this._icon(icon, feature ? "zcm-ic--" + feature : ""));
    box.appendChild(tile);
    box.appendChild(this._el("h4", "zcm-empty-title", title));
    if (text) box.appendChild(this._el("p", "zcm-empty-text", text));
    return box;
  }

  /** Build a sidebar panel; on failure, log and show a fallback. */
  _safePanel(name, build) {
    try {
      return build();
    } catch (e) {
      Zotero.debug(
        `[Citation Map] ${name} panel failed: ` + e + "\n" + (e && e.stack)
      );
      const panel = this._panel(name);
      panel.appendChild(
        this._empty(
          "warning",
          null,
          "This panel could not be built",
          "Please report this, the details are in Help → Debug Output " +
            "Logging → View Output."
        )
      );
      return panel;
    }
  }

  /** "Authors · Venue" subline text for a list row. */
  _subline(authors, venue, citedBy) {
    const bits = [];
    if (authors && authors.length) {
      bits.push(authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : ""));
    }
    if (venue) bits.push(venue);
    if (citedBy) bits.push(this._fmtBig(citedBy) + " citations");
    return bits.join(" · ");
  }

  /** 71234 → "71k", 1284 → "1.3k", 96 → "96". */
  _fmtBig(v) {
    v = Number(v) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (v >= 1e4) return Math.round(v / 1e3) + "k";
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(v);
  }

  _buildSuggestedPanel() {
    // Suggestions computed from your own library's citations (no web search).
    const panel = this._panel(
      "Suggested from your library",
      "Papers that several of yours cite but that aren't in Zotero yet. " +
        "Worked out from your own reference lists, no web search."
    );

    // how many suggestions to show ON THE MAP (off/top/all), and the minimum
    // number of your papers that must cite one (×N).
    panel.appendChild(this._buildSuggestControls(() => renderList()));

    const list = this._el("div", "zcm-list");
    panel.appendChild(list);

    const renderList = () => {
      list.textContent = "";
      // reviews are NOT filtered out; they're kept and de-emphasised (see the
      // .zcm-is-review row class + the sidebar's .zcm-hide-reviews toggle),
      // with non-reviews sorted first so they lead the list.
      const discovered = this.graph.nodes
        .filter(
          (n) =>
            n.kind === "discovered" &&
            !n._injected &&
            n.inLibraryCitations >= this.suggestMinCiters
        )
        .sort(
          (a, b) =>
            (a.isReview ? 1 : 0) - (b.isReview ? 1 : 0) ||
            b.inLibraryCitations - a.inLibraryCitations ||
            (b.citedByCount || 0) - (a.citedByCount || 0)
        );
      if (!discovered.length) {
        list.appendChild(
          this._empty(
            "bulb",
            "suggested",
            "No suggestions at this strength",
            "Lower “Cited by at least” above, or search the wider " +
              "literature in the Discover tab."
          )
        );
      }
      for (const n of discovered) {
        const open = () => {
          n.revealed = true; // make it visible even if the map hides suggestions
          this._applySuggestionVisibility();
          this._select(n.key, true);
        };
        const { row, meta, title, sub, actions } = this._row(n.key, open);
        if (n.isReview) row.classList.add("zcm-is-review");
        meta.appendChild(
          this._badge(
            "suggested",
            `×${n.inLibraryCitations}`,
            null,
            `Cited by ${n.inLibraryCitations} of your papers`
          )
        );
        meta.appendChild(this._el("span", "zcm-num", String(n.year || "—")));
        if (n.isNew) meta.appendChild(this._newChip());
        if (n.isReview) meta.appendChild(this._reviewChip());
        if (n.matchedTopics && n.matchedTopics.length) {
          const t = this._el("span", "zcm-tag", n.matchedTopics[0]);
          t.setAttribute("title", "Shares this research topic with your collection");
          meta.appendChild(t);
        }
        title.textContent = n.title;
        sub.textContent = this._subline(n.authors, n.venue, n.citedByCount);
        if (n.doi) {
          actions.appendChild(
            this._btn("Open DOI", {
              icon: "external",
              iconOnly: true,
              sm: true,
              title: "Open this paper on doi.org",
              onClick: () => Zotero.launchURL("https://doi.org/" + n.doi),
            })
          );
        }
        list.appendChild(row);
      }
      this._markSelectedRows(this.selected);
      this._refreshTabCounts();
    };
    this._renderSuggestList = renderList; // so the controls can refresh it
    renderList();
    return panel;
  }

  /**
   * The "Discover" tab: the on-demand live OpenAlex search. Needs the live
   * collection profile, imported maps don't carry one, so they get a short
   * explanation instead of the search.
   */
  _buildDiscoverPanel() {
    if (this.graph.profile) return this._buildDiscoverCard();
    const panel = this._panel("Discover new papers");
    panel.appendChild(
      this._empty(
        "compass",
        "discover",
        "Not available for imported maps",
        "The live search needs your collection's topic profile, which " +
          "imported maps don't carry. Open the map from a Zotero collection " +
          "to use Discover."
      )
    );
    return panel;
  }

  /**
   * The suggestion controls: how many suggestions appear ON THE MAP, and the
   * ×N strength floor. `onChange` re-renders the sidebar list.
   */
  _buildSuggestControls(onChange) {
    const box = this._el("div", "zcm-controls");

    // Row 1, show on the map: Off / Top / All
    const r1 = this._el("div", "zcm-control-row zcm-control-row--between");
    r1.appendChild(this._el("span", "zcm-label", "On the map"));
    this._suggSeg = this._seg(
      "Suggestions on the map",
      [
        ["off", "Off", "Don't draw suggestions on the map (they still list here)"],
        ["top", "Top", `Only the ${this.suggestTopCount} strongest suggestions`],
        ["all", "All", "Every suggestion that passes “Cited by at least”"],
      ],
      this.suggestDisplay,
      (v) => this._setSuggestDisplay(v)
    );
    r1.appendChild(this._suggSeg);
    box.appendChild(r1);

    // Row 2, strength floor: cited by at least N of your papers
    const r2 = this._el("div", "zcm-control-row zcm-control-row--between");
    r2.appendChild(this._el("span", "zcm-label", "Cited by at least"));
    r2.appendChild(
      this._seg(
        "Cited by at least this many of your papers",
        [2, 3, 4].map((v) => [
          v,
          `×${v}`,
          `Only suggestions cited by at least ${v} of your papers`,
        ]),
        this.suggestMinCiters,
        (v) => {
          this.suggestMinCiters = v;
          try {
            Zotero.Prefs.set("extensions.citation-map.suggestMinCiters", v, true);
          } catch (e) {
            /* best-effort */
          }
          this._applySuggestionVisibility();
          onChange && onChange();
        }
      )
    );
    box.appendChild(r2);
    return box;
  }

  // ============================================================== discover

  /**
   * "Discover new papers": on-demand OpenAlex search for (1) papers citing
   * the user's papers, (2) well-cited papers in the collection's topics,
   * (3) OpenAlex related works, with reason badges explaining every hit.
   * Nothing is fetched until the user clicks the search button, and only
   * OpenAlex record/topic IDs are transmitted.
   */
  _buildDiscoverCard() {
    const card = this._panel(
      "Discover new papers",
      "A live search of OpenAlex for papers beyond your library: new work " +
        "that cites yours, and parallel work on your topics. Nothing is sent " +
        "until you press Search, and only anonymous OpenAlex IDs leave your " +
        "computer, never your notes, tags or text."
    );
    card.classList.add("zcm-discover");
    this._discoverCard = card; // coachmark anchor
    const profile = this.graph.profile;

    // ---- "Search for", the three sources, clearly labelled ----------------
    const sources = this._el("div", "zcm-group");
    sources.appendChild(this._el("span", "zcm-label", "Search for"));
    const mkCheck = (label, prefKey, tip) => {
      const row = this._check(
        Zotero.Prefs.get("extensions.citation-map." + prefKey, true) !== false,
        label,
        (on) => {
          try {
            Zotero.Prefs.set("extensions.citation-map." + prefKey, on, true);
          } catch (e) {
            /* best-effort */
          }
        },
        tip
      );
      sources.appendChild(row);
      return row;
    };
    const cbCiting = mkCheck(
      "Papers that cite yours",
      "discoverCiting",
      "Newer work that builds on the papers in this collection, the way to " +
        "find what came AFTER your reading list."
    );
    const cbTopics = mkCheck(
      "Papers on the same topics",
      "discoverTopics",
      "Well-cited papers in your collection's research topics, parallel " +
        "work that may not cite yours at all."
    );
    const cbRelated = mkCheck(
      "Related papers",
      "discoverRelated",
      "Works OpenAlex marks as related to several of your papers."
    );
    card.appendChild(sources);

    // ---- "Published", a preset dropdown -----------------------------------
    const pub = this._el("div", "zcm-group");
    pub.appendChild(this._el("span", "zcm-label", "Published"));
    const timeRow = this._el("div", "zcm-control-row");
    const selField = this._el("label", "zcm-field zcm-select zcm-select--native");
    const sel = this._el("select");
    sel.setAttribute("aria-label", "Published");
    sel.setAttribute("title", "Only include papers published within this time");
    const nowY = new Date().getFullYear();
    const presets = [
      ["any", "Any time"],
      ["2y", "Last 2 years"],
      ["5y", "Last 5 years"],
      ["10y", "Last 10 years"],
      ["custom", "Since year…"],
    ];
    for (const [val, label] of presets) {
      const o = this._el("option", null, label);
      o.value = val;
      sel.appendChild(o);
    }
    const savedSince =
      Zotero.Prefs.get("extensions.citation-map.discoverSince", true) || "any";
    // a saved custom year shows as "custom" with the field pre-filled
    const savedIsYear = /^\d{4}$/.test(String(savedSince));
    sel.value = savedIsYear ? "custom" : savedSince;
    selField.appendChild(sel);
    selField.appendChild(this._icon("chev-down", "zcm-ic--sm"));
    timeRow.appendChild(selField);
    const yearField = this._el("label", "zcm-field zcm-num zcm-year-field");
    const yearInp = this._el("input");
    yearInp.setAttribute("type", "number");
    yearInp.setAttribute("min", "1900");
    yearInp.setAttribute("max", String(nowY));
    yearInp.setAttribute("placeholder", String(nowY - 5));
    yearInp.setAttribute("aria-label", "Published since year");
    yearField.appendChild(yearInp);
    yearField.style.display = sel.value === "custom" ? "" : "none";
    if (savedIsYear) yearInp.value = String(savedSince);
    timeRow.appendChild(yearField);
    sel.addEventListener("change", () => {
      yearField.style.display = sel.value === "custom" ? "" : "none";
      this._persistSince(sel, yearInp);
    });
    yearInp.addEventListener("change", () => this._persistSince(sel, yearInp));
    pub.appendChild(timeRow);
    card.appendChild(pub);

    // ---- "Limit to topics": one row per topic, so long topic names
    //      always fit on their own row.
    this._activeTopics = new Set(
      (profile.topics || []).slice(0, 5).map((t) => t.id)
    );
    if (profile.topics && profile.topics.length) {
      const topics = this._el("div", "zcm-group");
      topics.appendChild(this._el("span", "zcm-label", "Limit to topics"));
      for (const t of profile.topics.slice(0, 5)) {
        const nameEl = this._el("span", "zcm-check-label");
        nameEl.appendChild(this._el("span", null, t.name));
        if (t.count) {
          nameEl.appendChild(
            this._el(
              "span",
              "zcm-topic-used",
              ` · ${t.count} paper${t.count === 1 ? "" : "s"}`
            )
          );
        }
        const row = this._check(
          this._activeTopics.has(t.id),
          nameEl,
          (on) => {
            if (on) this._activeTopics.add(t.id);
            else this._activeTopics.delete(t.id);
          },
          `OpenAlex topic shared by ${t.count} of your papers`
        );
        row.querySelector(".zcm-check").setAttribute("aria-label", t.name);
        topics.appendChild(row);
      }
      card.appendChild(topics);
    }
    if (profile.terms && profile.terms.length) {
      card.appendChild(
        this._el(
          "p",
          "zcm-help",
          "Key terms (computed on your machine, never sent): " +
            profile.terms
              .slice(0, 6)
              .map((t) => t.term)
              .join(" · ")
        )
      );
    }

    // ---- Search + results --------------------------------------------------
    const runRow = this._el("div", "zcm-toolrow");
    const runBtn = this._btn("Search for new papers", {
      icon: "search",
      variant: "primary",
      cls: "zcm-discover-run",
    });
    const status = this._el("div", "zcm-discover-status");
    status.setAttribute("aria-live", "polite");
    const results = this._el("div", "zcm-list zcm-discover-results");
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      this._setBtn(runBtn, "Searching…", "spinner");
      results.textContent = "";
      status.classList.remove("zcm-error-text");
      status.textContent = "Searching…";
      const DS = ZCM_VIEW_NS.DataSource;
      DS.resetNetState();
      try {
        const fromYear = this._sinceToYear(sel, yearInp);
        const entries = await ZCM_VIEW_NS.GraphBuilder.searchNewPapers(
          this.graph,
          {
            citing: cbCiting.checked,
            topics: cbTopics.checked,
            related: cbRelated.checked,
            fromYear,
            topicIDs: [...this._activeTopics],
            onProgress: (phase, d, t) => {
              const slow =
                DS.netState === "slow" ? " (slow connection, hang on)" : "";
              status.textContent = `${phase}… ${d} / ${t}${slow}`;
            },
          }
        );
        if (!entries.length && DS.netMessage()) {
          status.classList.add("zcm-error-text");
          status.textContent =
            DS.netState === "offline"
              ? "No internet connection, OpenAlex could not be reached. " +
                "Reconnect and try the search again."
              : DS.netMessage();
          if (DS.netState === "limited") {
            status.appendChild(this.constructor.apiKeyForm(this.doc, null));
          }
        } else {
          const span = fromYear ? ` published since ${fromYear}` : "";
          status.textContent = entries.length
            ? `${entries.length} paper${entries.length === 1 ? "" : "s"}${span}` +
              `, best matches first${
                DS.netState === "slow" ? " (connection was slow)" : ""
              }`
            : `Nothing new found${span}. Try more sources, more topics, or a ` +
              "wider time range.";
        }
        this._renderSearchResults(results, entries);
      } catch (e) {
        Zotero.debug("[Citation Map] Discover search failed: " + e);
        status.classList.add("zcm-error-text");
        status.textContent =
          DS.netState === "offline"
            ? "No internet connection, OpenAlex could not be reached. " +
              "Reconnect and try again."
            : DS.netMessage() ||
              "Search failed. See Help → Debug Output for details.";
      }
      runBtn.disabled = false;
      this._setBtn(runBtn, "Search for new papers", "search");
    });
    runRow.appendChild(runBtn);
    // "Clear from map", remove everything the search injected
    const clearBtn = this._btn("Clear from map", {
      title: "Remove every paper the search added to the map",
      onClick: () => this._clearInjected(),
    });
    clearBtn.style.display = "none";
    this._clearInjectedBtn = clearBtn;
    runRow.appendChild(clearBtn);
    card.appendChild(runRow);
    card.appendChild(status);
    card.appendChild(results);
    return card;
  }

  /** Map the time preset + custom field to a `fromYear` (or null = any). */
  _sinceToYear(sel, yearInp) {
    const now = new Date().getFullYear();
    switch (sel.value) {
      case "2y":
        return now - 2;
      case "5y":
        return now - 5;
      case "10y":
        return now - 10;
      case "custom": {
        const y = parseInt(yearInp.value, 10);
        if (!Number.isFinite(y)) return null;
        return Math.max(1900, Math.min(now, y)); // clamp, no 1/0/-1 nonsense
      }
      default:
        return null; // "any"
    }
  }

  _persistSince(sel, yearInp) {
    let val = sel.value;
    if (val === "custom") {
      const y = this._sinceToYear(sel, yearInp);
      val = y ? String(y) : "any";
    }
    try {
      Zotero.Prefs.set("extensions.citation-map.discoverSince", val, true);
    } catch (e) {
      /* best-effort */
    }
  }

  /**
   * Preview a Discover result in the inspector (the same column paper
   * details use), without adding it to the map. If it is already on the
   * map, just select it there.
   */
  _previewRecord(entry) {
    const rec = entry.record;
    const key = "d" + rec.id;
    if (this.nodeByKey.has(key)) {
      this._select(key, true);
      return;
    }
    const node = {
      key,
      kind: "discovered",
      title: rec.title,
      year: rec.year,
      authors: rec.authors || [],
      venue: rec.venue,
      doi: rec.doi,
      zoteroItemID: null,
      citedByCount: rec.citedByCount || 0,
      inLibraryCitations: 0,
      topics: rec.topics || [],
      oaStatus: rec.oaStatus || null,
      matchedTopics: entry.topicNames || [],
      isReview: !!entry.isReview,
      _preview: true,
      _citesCount: entry.citesCount || 0,
      _entry: entry,
    };
    this.selected = null; // this isn't a map node; clear the map selection ring
    if (this.tooltip) this.tooltip.style.display = "none";
    this._renderDetails(node);
    this._openInspector();
    this._markSelectedRows(key);
    this._dirty = true;
  }

  _renderSearchResults(container, entries) {
    this._lastDiscoverEntries = entries;
    this._lastDiscoverContainer = container;
    this._renderDiscoverResults = () =>
      this._renderSearchResults(
        this._lastDiscoverContainer,
        this._lastDiscoverEntries
      );
    container.textContent = "";
    this._resultSyncers = []; // per-row "Show/Remove on map" button updaters
    this._discoverResync = () => { for (const f of this._resultSyncers) f(); };
    // reviews are kept and de-emphasised (faded via .zcm-is-review),
    // non-reviews sorted first so they lead the results
    const shown = entries
      .slice()
      .sort((a, b) => (a.isReview ? 1 : 0) - (b.isReview ? 1 : 0));
    for (const e of shown) {
      const rec = e.record;
      const key = "d" + rec.id;
      // Clicking the row (anywhere but the action buttons) opens the paper
      // in the inspector, same as clicking a dot on the map.
      const { row, meta, title, sub, actions } = this._row(key, () =>
        this._previewRecord(e)
      );
      row.classList.add("zcm-discover-row");
      if (e.isReview) row.classList.add("zcm-is-review");
      if (e.citesCount) {
        meta.appendChild(
          this._badge(
            "discover",
            `cites ${e.citesCount} of yours`,
            null,
            "This paper cites papers in your collection"
          )
        );
      }
      if (e.relatedCount) {
        meta.appendChild(
          this._badge(
            "neutral",
            `related ×${e.relatedCount}`,
            null,
            "OpenAlex flags this as related to several of your papers"
          )
        );
      }
      meta.appendChild(this._el("span", "zcm-num", String(rec.year || "—")));
      if (e.isReview) meta.appendChild(this._reviewChip());
      for (const t of (e.topicNames || []).slice(0, 2)) {
        const tt = this._el("span", "zcm-tag", t);
        tt.setAttribute("title", "Shares this research topic with your collection");
        meta.appendChild(tt);
      }
      title.textContent = rec.title;
      sub.textContent = this._subline(rec.authors, rec.venue, rec.citedByCount);

      // inline, non-blocking feedback line under the row
      const feedback = this._el("div", "zcm-error-text");
      feedback.style.display = "none";

      // Add to Zotero, inline feedback, no modal alerts
      if (rec.doi) {
        const addBtn = this._btn("Add", {
          icon: "add",
          sm: true,
          title: "Add to Zotero",
        });
        addBtn.addEventListener("click", async () => {
          if (addBtn._done) {
            // after a successful add the same button jumps to the new item
            try {
              const pane = this.win.ZoteroPane || Zotero.getActiveZoteroPane();
              this.win.Zotero_Tabs.select("zotero-pane");
              await pane.selectItem(addBtn._done);
            } catch (err) {
              /* best-effort */
            }
            return;
          }
          addBtn.disabled = true;
          this._setBtn(addBtn, "Adding…", "spinner");
          feedback.style.display = "none";
          try {
            const item = await this._importByDOI(rec.doi, this.ctx.collectionID);
            this._setBtn(addBtn, "Added", "check");
            this._announce("Added to Zotero");
            const node = this.nodeByKey.get(key);
            if (node) {
              node.kind = "library";
              node.zoteroItemID = item.id;
              this._dirty = true;
            }
            // offer a jump to the freshly added item
            this.win.setTimeout(() => {
              if (this._destroyed) return;
              addBtn._done = item.id;
              addBtn.disabled = false;
              this._setBtn(addBtn, "Show", "locate");
              addBtn.setAttribute("title", "Show in library");
            }, 1600);
          } catch (err) {
            Zotero.debug("[Citation Map] Discover add failed: " + err);
            addBtn.disabled = false;
            this._setBtn(addBtn, "Add", "add");
            feedback.textContent =
              "Couldn't add it automatically. Open its DOI, then add it in " +
              "Zotero.";
            feedback.style.display = "";
          }
        });
        actions.appendChild(addBtn);
      }

      // Show on map ⇄ Remove from map (a real toggle, reversible)
      const mapBtn = this._btn("Show on map", { icon: "locate", iconOnly: true, sm: true });
      const syncMapBtn = () => {
        const on = this.nodeByKey.has(key) && !this.nodeByKey.get(key).hidden;
        const label = on ? "Remove from map" : "Show on map";
        mapBtn.setAttribute("aria-label", label);
        mapBtn.setAttribute("title", label);
        mapBtn.setAttribute("aria-pressed", on ? "true" : "false");
        mapBtn.classList.toggle("is-on", on);
      };
      mapBtn.addEventListener("click", () => {
        const node = this.nodeByKey.get(key);
        if (node && !node.hidden) this._removeInjected(node);
        else {
          this._injectSearchResult(e);
          // on narrow tabs the sidebar is a sheet over the map: get it out
          // of the way so the placed paper is visible
          if (this._sizeClass === "sm") this._select(null, false);
        }
        syncMapBtn();
      });
      syncMapBtn();
      this._resultSyncers.push(syncMapBtn);
      actions.appendChild(mapBtn);

      if (rec.doi) {
        actions.appendChild(
          this._btn("Open DOI", {
            icon: "external",
            iconOnly: true,
            sm: true,
            title: "Open this paper on doi.org",
            onClick: () => Zotero.launchURL("https://doi.org/" + rec.doi),
          })
        );
      }
      row.appendChild(feedback);
      container.appendChild(row);
    }
    this._markSelectedRows(this.selected);
    this._refreshTabCounts();
    this._announce(
      `${entries.length} search result${entries.length === 1 ? "" : "s"}`
    );
  }

  /**
   * Remove a Discover-injected paper (and its injected edges) from the map,
   * fully cleaning up nodeByKey / neighbors / component groups so the layout
   * and hit-testing stay consistent. Only removes `_injected` nodes.
   */
  _removeInjected(node) {
    if (!node || !node._injected) return;
    const key = node.key;
    this.graph.nodes = this.graph.nodes.filter((n) => n !== node);
    this.graph.edges = this.graph.edges.filter(
      (e) => e.source !== key && e.target !== key
    );
    this.nodeByKey.delete(key);
    // drop this key from every neighbour set, then its own entry
    for (const other of this.neighbors.get(key) || []) {
      const s = this.neighbors.get(other);
      if (s) s.delete(key);
    }
    this.neighbors.delete(key);
    if (this._compGroups) {
      for (const g of this._compGroups) {
        const i = g.indexOf(node);
        if (i >= 0) g.splice(i, 1);
      }
    }
    if (this.selected === key) this._select(null, false);
    this._activeNodes = null;
    this._activeEdges = null;
    if (this.mode === "timeline") this._computeTimelineLayout();
    this.alpha = Math.max(this.alpha || 0, 0.2);
    this._refreshClearInjected();
    // keep the Discover rows' "Show/Remove on map" buttons truthful, however
    // the paper was removed (row, inspector, "Clear")
    if (this._discoverResync) this._discoverResync();
    this._dirty = true;
  }

  /** Remove every injected paper from the map at once. */
  _clearInjected() {
    for (const n of this.graph.nodes.filter((n) => n._injected)) {
      this._removeInjected(n);
    }
    for (const f of this._resultSyncers || []) f();
  }

  /** Show/hide the "Clear discovered from map" button based on live state. */
  _refreshClearInjected() {
    if (!this._clearInjectedBtn) return;
    const any = this.graph.nodes.some((n) => n._injected && !n.hidden);
    this._clearInjectedBtn.style.display = any ? "" : "none";
  }

  /**
   * Put a Discover result on the map: a violet-haloed dot wired to the
   * papers it cites, resting on their island. List-only results (topic
   * matches without citation links) have nowhere sensible to sit, so the
   * button is only offered when links exist.
   */
  _injectSearchResult(entry) {
    const rec = entry.record;
    const key = "d" + rec.id;
    let node = this.nodeByKey.get(key);
    if (!node) {
      node = {
        key,
        kind: "discovered",
        title: rec.title,
        year: rec.year,
        authors: rec.authors || [],
        venue: rec.venue,
        doi: rec.doi,
        zoteroItemID: null,
        citedByCount: rec.citedByCount || 0,
        inLibraryCitations: 0,
        citesCount: entry.citesCount || 0,
        topics: rec.topics || [],
        oaStatus: rec.oaStatus || null,
        via: entry.citesCount ? "cites" : entry.relatedCount ? "related" : "topics",
        matchedTopics: entry.topicNames || [],
        isReview: !!entry.isReview,
        oaID: rec.id,
        revealed: true,
        _injected: true,
        r: 7,
        _rank: 9999,
        vx: 0,
        vy: 0,
      };
      const citerNodes = (entry.citers || [])
        .map((k2) => this.nodeByKey.get(k2))
        .filter(Boolean);
      let cx = 0;
      let cy = 0;
      if (citerNodes.length) {
        for (const c of citerNodes) {
          cx += c.x;
          cy += c.y;
        }
        cx /= citerNodes.length;
        cy /= citerNodes.length;
      } else {
        // topic/related-only result: no citation link, so drop it at the
        // current view centre (in graph coords) where the user is looking.
        cx = -this.transform.x / this.transform.k;
        cy = -this.transform.y / this.transform.k;
      }
      node.x = cx + 30;
      node.y = cy - 30;
      if (this.mode === "timeline" && citerNodes.length) {
        // its network home: beside its citers' remembered network spots
        let nx = 0;
        let ny = 0;
        for (const c of citerNodes) {
          nx += c._netX != null ? c._netX : c.anchorX;
          ny += c._netY != null ? c._netY : c.anchorY;
        }
        node._netX = nx / citerNodes.length + 30;
        node._netY = ny / citerNodes.length - 30;
        this._unsettled = true;
      }
      node.anchorX = citerNodes.length ? citerNodes[0].anchorX : cx;
      node.anchorY = citerNodes.length ? citerNodes[0].anchorY : cy;
      node._cluster = citerNodes.length ? citerNodes[0]._cluster : -1;
      this.graph.nodes.push(node);
      this.nodeByKey.set(key, node);
      if (citerNodes.length && this._compGroups) {
        const grp = this._compGroups.find((g) => g.includes(citerNodes[0]));
        if (grp) grp.push(node);
      }
      for (const k2 of entry.citers || []) {
        // the found paper CITES the user's paper, arrow points at yours
        this.graph.edges.push({ source: key, target: k2 });
        if (!this.neighbors.has(key)) this.neighbors.set(key, new Set());
        if (!this.neighbors.has(k2)) this.neighbors.set(k2, new Set());
        this.neighbors.get(key).add(k2);
        this.neighbors.get(k2).add(key);
      }
    }
    node.hidden = false;
    node.revealed = true;
    this._activeNodes = null;
    this._activeEdges = null;
    if (this.mode === "timeline") this._computeTimelineLayout();
    this.alpha = Math.max(this.alpha || 0, 0.3);
    this._refreshClearInjected();
    this._select(key, true);
    this._dirty = true;
  }

  /**
   * Add a work to Zotero by DOI: into the mapped collection's own library (a
   * group collection can't hold an item created in My Library), reusing an
   * item that already has this DOI there instead of creating a duplicate.
   */
  async _importByDOI(doi, collectionID) {
    let libraryID = (this.ctx && this.ctx.libraryID) || Zotero.Libraries.userLibraryID;
    const coll = collectionID ? Zotero.Collections.get(collectionID) : null;
    if (coll) libraryID = coll.libraryID;
    const lib = Zotero.Libraries.get(libraryID);
    if (lib && lib.editable === false) {
      throw new Error("The library of this map is read-only");
    }
    const Main = ZCM_VIEW_NS.Main;
    const existing = Main ? await Main._findByDOI(libraryID, doi) : null;
    if (existing) {
      if (collectionID && !existing.getCollections().includes(collectionID)) {
        existing.addToCollection(collectionID);
        await existing.saveTx();
      }
      return existing;
    }
    const translate = new Zotero.Translate.Search();
    translate.setIdentifier({ DOI: doi });
    const translators = await translate.getTranslators();
    if (!translators.length) throw new Error("No translator found for DOI");
    translate.setTranslator(translators);
    const items = await translate.translate({
      libraryID,
      collections: collectionID ? [collectionID] : false,
    });
    if (!items || !items.length) throw new Error("Nothing imported");
    return items[0];
  }

  _buildChainsPanel() {
    const panel = this._panel(
      "Citation chains",
      "A paper trail through time: step 2 cites step 1, step 3 cites step 2. " +
        "Click a chain to light it up on the map; click again to clear."
    );
    if (!this.graph.chains.length) {
      panel.appendChild(
        this._empty(
          "chain",
          "chain",
          "No chains yet",
          "No trail of 3 or more papers citing one another was found in " +
            "this collection."
        )
      );
      return panel;
    }
    const list = this._el("div", "zcm-list");
    panel.appendChild(list);
    this.graph.chains.forEach((chain) => {
      const toggle = () => {
        this.activeChain = this.activeChain === chain ? null : chain;
        this._dirty = true;
        for (const el of list.querySelectorAll(".zcm-chain-row")) {
          el.classList.remove("is-selected", "is-open");
          el.setAttribute("aria-pressed", "false");
        }
        if (this.activeChain) {
          row.classList.add("is-selected", "is-open");
          row.setAttribute("aria-pressed", "true");
          // a chain may run through a hidden suggestion, reveal it
          let revealed = false;
          for (const key of chain) {
            const n = this.nodeByKey.get(key);
            if (n && n.hidden && !(this.hideReviews && n.isReview)) {
              n.revealed = true;
              revealed = true;
            }
          }
          if (revealed) this._applySuggestionVisibility();
        }
      };
      const { row, meta, title, sub, actions } = this._row(null, toggle);
      row.classList.add("zcm-chain-row");
      row.setAttribute("aria-pressed", "false");
      meta.appendChild(this._badge("chain", `${chain.length} papers`, "chain"));
      const yrs = chain
        .map((k) => this.nodeByKey.get(k))
        .filter((n) => n && n.year)
        .map((n) => n.year);
      if (yrs.length >= 2) {
        meta.appendChild(
          this._el("span", "zcm-num", `${Math.min(...yrs)} → ${Math.max(...yrs)}`)
        );
      }
      const oldest = this.nodeByKey.get(chain[chain.length - 1]);
      const newest = this.nodeByKey.get(chain[0]);
      title.textContent =
        `${this._short(oldest && oldest.title)} → … → ` +
        `${this._short(newest && newest.title)}`;
      sub.textContent =
        (oldest ? this._label(oldest) : "?") + " to " + (newest ? this._label(newest) : "?");
      actions.appendChild(this._icon("chev-down", "zcm-ic--sm zcm-chain-chev"));

      // Step list (oldest → newest, matching the numbered discs on the map),
      // shown while the chain is active.
      const steps = this._el("div", "zcm-chain-steps");
      const ordered = [...chain].reverse();
      ordered.forEach((key, idx) => {
        const n = this.nodeByKey.get(key);
        if (!n) return;
        const st = this._el("button", "zcm-chain-step");
        st.setAttribute("type", "button");
        st.setAttribute("title", n.title);
        st.appendChild(this._el("span", "zcm-chain-num zcm-num", String(idx + 1)));
        st.appendChild(
          this._el(
            "span",
            "zcm-chain-step-label",
            `${this._label(n)} · ${this._short(n.title)}`
          )
        );
        st.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._select(key, true);
        });
        st.addEventListener("mouseenter", () => {
          this.hovered = key;
          this._dirty = true;
        });
        st.addEventListener("mouseleave", () => {
          if (this.hovered === key) this.hovered = null;
          this._dirty = true;
        });
        steps.appendChild(st);
      });
      row.appendChild(steps);
      list.appendChild(row);
    });
    return panel;
  }

  /**
   * "Mine": every paper of the mapped collection, newest first, with its
   * Zotero tags and note count. Clicking a row selects the paper on the map
   * (selection ring + centered view) and opens its details. Doubles as a
   * full text alternative to the map.
   */
  _buildPapersPanel() {
    const panel = this._panel(
      "My papers",
      "Everything in this collection, with tags and notes. Click a paper to " +
        "find it on the map."
    );

    // quick filter, local to this list (the toolbar search dims the map)
    const tools = this._el("div", "zcm-controls");
    const field = this._el("label", "zcm-field");
    field.appendChild(this._icon("search"));
    const filter = this._el("input");
    filter.setAttribute("type", "text");
    filter.setAttribute("placeholder", "Filter by title, author or tag");
    filter.setAttribute("aria-label", "Filter my papers");
    field.appendChild(filter);
    tools.appendChild(field);
    this._papersFilterInput = filter;

    // a local "hide reviews" switch, mirroring Filter ▸ Hide reviews
    const revRow = this._el("label", "zcm-control-row zcm-control-row--between");
    revRow.appendChild(this._el("span", "zcm-label", "Hide reviews"));
    this._papersReviewSw = this._switch(this.hideReviews, "Hide review articles", (on) =>
      this._setHideReviews(on)
    );
    revRow.appendChild(this._papersReviewSw);
    tools.appendChild(revRow);
    panel.appendChild(tools);

    const list = this._el("div", "zcm-list");
    panel.appendChild(list);
    this._paperRows = new Map();

    const papers = this.graph.nodes
      .filter((n) => n.kind !== "discovered")
      .sort(
        (a, b) =>
          (b.year || 0) - (a.year || 0) ||
          (a.title || "").localeCompare(b.title || "")
      );
    if (!papers.length) {
      list.appendChild(
        this._empty("books", "library", "No papers in this collection")
      );
    }

    for (const n of papers) {
      // tags + note count straight from the Zotero item
      let tags = [];
      let noteCount = 0;
      let libraryID = null;
      try {
        const item = n.zoteroItemID ? Zotero.Items.get(n.zoteroItemID) : null;
        if (item) {
          libraryID = item.libraryID;
          tags = item.getTags().map((t) => t.tag);
          noteCount = (item.getNotes() || []).length;
        }
      } catch (e) {
        /* item gone or not loaded, show the row without extras */
      }

      const { row, meta, title, sub } = this._row(n.key, () =>
        this._select(n.key, true)
      );
      row.classList.add("zcm-paper-row");
      row._isReview = !!n.isReview;
      if (n.isReview) row.classList.add("zcm-is-review");
      meta.appendChild(this._el("span", "zcm-num", String(n.year || "—")));
      if (n.isNew) meta.appendChild(this._newChip());
      if (n.isReview) meta.appendChild(this._reviewChip());
      if (n.kind === "unresolved") {
        meta.appendChild(
          this._badge(
            "outline",
            "No citation data",
            null,
            "OpenAlex has no reference data for this paper, usually a missing DOI"
          )
        );
      }
      if (noteCount) {
        const nb = this._badge(
          "neutral",
          String(noteCount),
          "note",
          `${noteCount} note${noteCount > 1 ? "s" : ""}`
        );
        meta.appendChild(nb);
      }
      title.textContent = n.title;
      sub.textContent = this._subline(n.authors, n.venue);
      if (tags.length) {
        const tw = this._el("div", "zcm-row-tags");
        for (const t of tags.slice(0, 6)) {
          const tagEl = this._el("span", "zcm-tag");
          // colored Zotero tags keep their color, as a small dot
          try {
            const c = Zotero.Tags.getColor(libraryID, t);
            if (c && c.color) {
              const dot = this._el("i", "zcm-tag-dot");
              dot.style.background = c.color;
              tagEl.appendChild(dot);
            }
          } catch (e) {
            /* neutral tag */
          }
          tagEl.appendChild(this.doc.createTextNode(t));
          tagEl.setAttribute("title", `Filter the map by “${t}”`);
          tagEl.classList.add("zcm-tag--action");
          tagEl.addEventListener("click", (ev) => {
            // Zotero tags filter the map on click
            ev.stopPropagation();
            this.filterTag = this.filterTag === t ? null : t;
            this._tagKeys = null;
            this._filtersChanged();
          });
          tw.appendChild(tagEl);
        }
        if (tags.length > 6) {
          tw.appendChild(this._el("span", "zcm-tag", `+${tags.length - 6}`));
        }
        row.appendChild(tw);
      }

      row._filterText = (
        n.title +
        " " +
        (n.authors || []).join(" ") +
        " " +
        tags.join(" ")
      ).toLowerCase();
      this._paperRows.set(n.key, row);
      list.appendChild(row);
    }

    // Text filter only. Reviews are NOT hidden here; they're faded via the
    // .zcm-is-review row class + the sidebar's .zcm-hide-reviews toggle.
    this._applyPapersFilter = () => {
      const q = (this._papersFilterInput
        ? this._papersFilterInput.value
        : ""
      )
        .trim()
        .toLowerCase();
      for (const row of this._paperRows.values()) {
        row.style.display = !q || row._filterText.includes(q) ? "" : "none";
      }
    };
    filter.addEventListener("input", () => this._applyPapersFilter());
    this._applyPapersFilter();

    return panel;
  }

  _short(t) {
    if (!t) return "?";
    return t.length > 42 ? t.slice(0, 40) + "…" : t;
  }

  /**
   * Resolve (and memoise on the node) the publisher corporate-identity style
   * for this paper's venue, brand colour, logo-style font stack, confidence.
   * Returns the neutral house style for unknown journals. Cheap and cached,
   * both here and inside PublisherCI, so it is safe to call every frame.
   */
  _ci(node) {
    if (node._ci === undefined) {
      const CI = ZCM_VIEW_NS && ZCM_VIEW_NS.PublisherCI;
      node._ci = CI ? CI.styleFor(node.venue) : null;
    }
    return node._ci;
  }

  /**
   * Render a paper's journal name into `container`. Recognised journals get
   * a small square in the publisher's colour (adjusted to stay legible on
   * the current theme) instead of the publisher's typeface, which keeps one
   * type family in the interface.
   */
  _appendVenue(container, node) {
    const ci = this._ci(node);
    const wrap = this._el("span", "zcm-journal");
    if (ci && ci.matched && ci.primary) {
      const sw = this._el("i");
      sw.style.background = ZCM_VIEW_NS.MapTheme.adjustBrandColour(
        ci.primary,
        this.T.name
      );
      wrap.appendChild(sw);
      wrap.setAttribute(
        "title",
        ci.family + (ci.bestEffort ? " · best-effort match" : "")
      );
    }
    wrap.appendChild(this._el("span", null, node.venue));
    container.appendChild(wrap);
  }

  /**
   * Fill the inspector for a paper: kind line · title · authors, year,
   * journal · three stats · two direction buttons · topics · actions ·
   * its links on the map · notes.
   */
  _renderDetails(node) {
    const d = this.details;
    d.textContent = "";
    this._inspectedNode = node || null;
    this._addBtn = null;
    if (!node) return;

    const kindRow = this._el("div", "zcm-toolrow zcm-insp-kind");
    const kind = this._el("span", "zcm-kind");
    kind.appendChild(this._kindMark(node));
    kind.appendChild(this._el("span", null, this._kindLabel(node)));
    kindRow.appendChild(kind);
    if (node.isNew) kindRow.appendChild(this._newChip());
    if (node.isReview) kindRow.appendChild(this._reviewChip());
    d.appendChild(kindRow);

    d.appendChild(this._el("h4", "zcm-insp-title", node.title));

    const meta = this._el("div", "zcm-insp-meta");
    const authorLine = [
      node.authors && node.authors.length ? node.authors.join(", ") : null,
      node.year ? String(node.year) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (authorLine) meta.appendChild(this._el("span", "zcm-num", authorLine));
    if (node.venue) this._appendVenue(meta, node);
    if (meta.childNodes.length) d.appendChild(meta);

    // its links on this map
    const cites = [];
    const citedBy = [];
    if (!node._preview) {
      for (const e of this._active().edges) {
        if (e.source === node.key) cites.push(this.nodeByKey.get(e.target));
        else if (e.target === node.key) citedBy.push(this.nodeByKey.get(e.source));
      }
    }

    // ---- stats
    const stats = this._el("div", "zcm-stats");
    const stat = (value, label, tip) => {
      const s = this._el("div", "zcm-stat");
      s.appendChild(this._el("b", null, value));
      s.appendChild(this._el("span", null, label));
      if (tip) s.setAttribute("title", tip);
      stats.appendChild(s);
    };
    stat(
      node.citedByCount != null && node.kind !== "unresolved"
        ? this._fmtBig(node.citedByCount)
        : "—",
      "Worldwide",
      node.kind === "unresolved"
        ? "No citation data found for this paper"
        : `${(node.citedByCount || 0).toLocaleString()} citations worldwide (OpenAlex)`
    );
    if (node._preview) {
      // for a search result the relevant number is how many of the user's
      // papers it cites
      stat(String(node._citesCount || 0), "Cites yours", "How many of your papers it cites");
      stat("—", "On this map", "Not on the map yet");
    } else {
      stat(
        String(cites.length + citedBy.length),
        "On this map",
        "Citation links to and from other papers on this map"
      );
      stat(
        String(node.inLibraryCitations || 0),
        "From yours",
        "How many papers in this collection cite it (this sets the dot's size)"
      );
    }
    d.appendChild(stats);

    // ---- directions: focus the map on its references / its citing papers
    if (!node._preview) {
      const dir = this._el("div", "zcm-dir");
      const mk = (cls, label, icon, after, list, tip) => {
        const b = this._el("button", cls);
        b.setAttribute("type", "button");
        b.setAttribute("title", tip);
        if (!after) b.appendChild(this._icon(icon, "zcm-ic--sm"));
        b.appendChild(this._el("span", null, label));
        b.appendChild(this._el("b", null, String(list.length)));
        if (after) b.appendChild(this._icon(icon, "zcm-ic--sm"));
        b.disabled = !list.length;
        b.addEventListener("click", () =>
          this._fitNodes([node, ...list.filter(Boolean)], true)
        );
        dir.appendChild(b);
      };
      mk(
        "is-cites",
        "Cites",
        "arrow-left",
        false,
        cites,
        "Older work it builds on. Click to frame the paper and its references on the map."
      );
      mk(
        "is-citedby",
        "Cited by",
        "arrow-right",
        true,
        citedBy,
        "Newer work building on it. Click to frame the paper and the papers citing it."
      );
      d.appendChild(dir);
    }

    // the paper's OpenAlex topics (for suggestions: the matched ones)
    const topicNames =
      node.matchedTopics && node.matchedTopics.length
        ? node.matchedTopics
        : (node.topics || []).slice(0, 2).map((t) => t.name);
    if (topicNames.length) {
      const tr = this._el("div", "zcm-toolrow zcm-insp-tags");
      for (const t of topicNames) {
        const tag = this._el("span", "zcm-tag", t);
        tag.setAttribute("title", t);
        tr.appendChild(tag);
      }
      d.appendChild(tr);
    }

    // ---- actions (at most one primary)
    const actions = this._el("div", "zcm-actions");
    if (node.zoteroItemID) {
      actions.appendChild(
        this._btn("Show in library", {
          icon: "locate",
          variant: "primary",
          onClick: () => this._showInLibrary(node),
        })
      );
    } else if (node.kind === "discovered" && node.doi) {
      const b = this._btn("Add to Zotero", { icon: "add", variant: "primary" });
      b.addEventListener("click", () => this._addDiscovered(node, b));
      this._addBtn = b;
      actions.appendChild(b);
    }
    // Remove a search-injected paper from the map (reversible).
    if (node._injected && !node.hidden) {
      actions.appendChild(
        this._btn("Remove from map", {
          variant: "secondary",
          title: "Take this search result off the map",
          onClick: () => this._removeInjected(node),
        })
      );
    }
    // Preview of a Discover result that isn't on the map yet: offer to place it.
    if (node._preview && node._entry) {
      actions.appendChild(
        this._btn("Show on map", {
          icon: "locate",
          variant: "secondary",
          title: "Place this paper on the map",
          onClick: () => {
            this._injectSearchResult(node._entry);
            if (this._discoverResync) this._discoverResync();
            if (this._sizeClass === "sm") this._select(null, false);
          },
        })
      );
    }
    if (node.doi) {
      actions.appendChild(
        this._btn("Open DOI", {
          icon: "external",
          iconOnly: true,
          title: "Open this paper on doi.org",
          onClick: () => Zotero.launchURL("https://doi.org/" + node.doi),
        })
      );
    }
    if (actions.childNodes.length) d.appendChild(actions);
    // inline, non-blocking feedback for Add-to-Zotero (no modal alerts)
    this._detailMsg = this._el("div", "zcm-error-text");
    this._detailMsg.style.display = "none";
    d.appendChild(this._detailMsg);

    if (!node._preview) this._appendLinkLists(d, node, cites, citedBy);

    // Zotero / Better Notes attached to this item, previewed in place.
    if (node.zoteroItemID) {
      this._renderNotes(node).catch((e) =>
        Zotero.debug("[Citation Map] Notes preview failed: " + e)
      );
    }
    this._syncInspectNav();
  }

  /**
   * The paper's citation links on this map as two short clickable lists:
   * blue = what it cites, pink = what cites it, matching the highlighted
   * lines. Hovering a row lights that paper up on the map; clicking selects
   * and centres it, so you can walk the citation trail from the inspector.
   */
  _appendLinkLists(d, node, cites, citedBy) {
    const byCitations = (a, b) => (b.citedByCount || 0) - (a.citedByCount || 0);
    const MAX = 6;
    for (const [list, label, cls] of [
      [cites, "Cites on this map", "is-cites"],
      [citedBy, "Cited by on this map", "is-citedby"],
    ]) {
      const papers = list.filter(Boolean).sort(byCitations);
      if (!papers.length) continue;
      const box = this._el("div", "zcm-links " + cls);
      box.appendChild(
        this._el("div", "zcm-links-head zcm-num", `${label} · ${papers.length}`)
      );
      for (const n of papers.slice(0, MAX)) {
        const row = this._el("button", "zcm-link");
        row.setAttribute("type", "button");
        row.appendChild(this._el("span", "zcm-link-who zcm-num", this._label(n)));
        row.appendChild(this._el("span", "zcm-link-title", n.title));
        row.setAttribute("title", n.title);
        row.addEventListener("click", () => this._select(n.key, true));
        row.addEventListener("mouseenter", () => {
          this.hovered = n.key;
          this._dirty = true;
        });
        row.addEventListener("mouseleave", () => {
          this.hovered = null;
          this._dirty = true;
        });
        box.appendChild(row);
      }
      if (papers.length > MAX) {
        box.appendChild(
          this._el("div", "zcm-help", `+ ${papers.length - MAX} more on the map`)
        );
      }
      d.appendChild(box);
    }
  }

  /** Preview the item's child notes (works for Better Notes too, it
   *  stores its notes as regular Zotero notes). */
  async _renderNotes(node) {
    let noteIDs = [];
    try {
      const item = Zotero.Items.get(node.zoteroItemID);
      noteIDs = (item && item.getNotes()) || [];
    } catch (e) {
      return;
    }
    if (!noteIDs.length) return;

    // Notes keep a paper feel in both themes (warm white / warm charcoal).
    const wrap = this._el("div", "zcm-note");
    const head = this._el("div", "zcm-note-head");
    const counter = this._el("span", "zcm-num", "");
    head.appendChild(counter);
    const nav = this._el("span", "zcm-note-nav");
    const prev = this._btn("Previous note", { icon: "chev-left", iconOnly: true, sm: true });
    const next = this._btn("Next note", { icon: "chev-right", iconOnly: true, sm: true });
    nav.appendChild(prev);
    nav.appendChild(next);
    if (noteIDs.length < 2) nav.style.display = "none";
    head.appendChild(nav);
    wrap.appendChild(head);

    const preview = this._el("div", "zcm-note-preview");
    wrap.appendChild(preview);
    const openBtn = this._btn("Open note in Zotero", { sm: true, icon: "external" });
    wrap.appendChild(openBtn);

    let idx = 0;
    const show = (i) => {
      idx = (i + noteIDs.length) % noteIDs.length;
      counter.textContent =
        noteIDs.length > 1 ? `Note ${idx + 1} of ${noteIDs.length}` : "Note";
      preview.textContent = "";
      try {
        const note = Zotero.Items.get(noteIDs[idx]);
        if (note) preview.appendChild(this._noteFragment(note.getNote()));
      } catch (e) {
        preview.appendChild(this._el("div", "zcm-help", "Could not load this note."));
      }
    };
    prev.addEventListener("click", () => show(idx - 1));
    next.addEventListener("click", () => show(idx + 1));
    openBtn.addEventListener("click", async () => {
      try {
        const pane = this.win.ZoteroPane || Zotero.getActiveZoteroPane();
        this.win.Zotero_Tabs.select("zotero-pane");
        await pane.selectItem(noteIDs[idx]);
      } catch (e) {
        Zotero.debug("[Citation Map] Open note failed: " + e);
      }
    });
    // Links inside a note must not navigate the Zotero window.
    preview.addEventListener("click", (ev) => {
      const a = ev.target.closest && ev.target.closest("a[href]");
      if (!a) return;
      ev.preventDefault();
      const href = a.getAttribute("href");
      if (/^https?:/i.test(href)) Zotero.launchURL(href);
    });
    show(0);
    // the user may have selected another paper while this loaded
    if (this._inspectedNode === node) this.details.appendChild(wrap);
  }

  /**
   * Note HTML → a safe DocumentFragment for the preview. Rebuilt node by
   * node from an allowlist instead of assigned via innerHTML, for two
   * reasons: the Zotero window is an XHTML (XML) document, where innerHTML
   * parses as XML and throws on ordinary note markup such as <br> or
   * &nbsp; ("Could not load this note."); and an allowlist can't miss an
   * active attribute the way a blocklist can. Only http(s) links survive;
   * everything else (scripts, styles, images, unknown tags) is dropped,
   * keeping its text.
   */
  _noteFragment(html) {
    const XHTML = "http://www.w3.org/1999/xhtml";
    const ALLOWED = new Set([
      "p", "br", "b", "strong", "i", "em", "u", "s", "sub", "sup", "span",
      "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
      "blockquote", "pre", "code", "a", "table", "thead", "tbody", "tr",
      "td", "th", "hr",
    ]);
    const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "svg", "math"]);
    const parsed = new this.win.DOMParser().parseFromString(html || "", "text/html");
    const frag = this.doc.createDocumentFragment();
    const copy = (src, dest) => {
      for (const child of src.childNodes) {
        if (child.nodeType === 3) {
          dest.appendChild(this.doc.createTextNode(child.nodeValue));
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.localName.toLowerCase();
        if (DROP.has(tag)) continue;
        if (!ALLOWED.has(tag)) {
          copy(child, dest); // unknown wrapper: keep its content
          continue;
        }
        const el = this.doc.createElementNS(XHTML, tag);
        if (tag === "a") {
          const href = (child.getAttribute("href") || "").trim();
          if (/^https?:\/\//i.test(href)) el.setAttribute("href", href);
        }
        copy(child, el);
        dest.appendChild(el);
      }
    };
    copy(parsed.body, frag);
    return frag;
  }

  // ============================================================ simulation

  _initSimulation() {
    this.alpha = 1; // simulation "temperature", decays to 0
  }

  /**
   * Run the network layout to rest synchronously, before the first paint.
   * The user never sees the settling motion, the map simply appears calm
   * and then holds still (the #1 cause of the "wobbly" feel was watching
   * it converge live for several seconds).
   */
  _preSettle() {
    if (this.mode !== "force") return;
    const count = this._active().nodes.length;
    const iters = count > 260 ? 130 : count > 120 ? 190 : 240;
    this.alpha = 1;
    for (let i = 0; i < iters; i++) this._tickForce();
    this.alpha = 0; // fully frozen; interaction/mode-change reheats it
  }

  /** One simulation step (dispatch by mode). */
  _tick() {
    if (this.alpha < 0.02) return;
    if (this.mode === "timeline") {
      this._tickTimeline();
    } else if (this._returning) {
      // Glide home along the remembered network positions (tlx/tly), the same
      // calm monotonic ease the timeline uses, no forces, so no scatter.
      this._tickTimeline();
      // Hand control back to the force layout once the glide has arrived
      // (checked here, since _animate stops calling _tick below this alpha).
      if (this.alpha < 0.02) {
        this._returning = false;
        if (this._unsettled) {
          // papers that appeared while in the timeline find their place now
          this._unsettled = false;
          this.alpha = 0.3;
        }
      }
    } else {
      this._tickForce();
    }
  }

  /**
   * Timeline: ease each node toward its fixed grid target. Pure
   * exponential approach (no velocity) → monotonic, so it CANNOT
   * overshoot or oscillate. Targets come from _computeTimelineLayout().
   */
  _tickTimeline() {
    for (const n of this._active().nodes) {
      if (n.fixed || n.tlx == null) continue;
      n.x += (n.tlx - n.x) * 0.22;
      n.y += (n.tly - n.y) * 0.22;
    }
    this.alpha *= 0.9; // just a timer to stop once it has arrived
  }

  /**
   * Network force step. Calm by design:
   *  - papers are grouped into citation clusters ("islands"); repulsion
   *    acts only WITHIN a cluster, and every node is gently pulled toward
   *    its cluster's fixed anchor, so structure shows (hubs central,
   *    leaves at the edge) and separate clusters stay as distinct islands
   *  - soft springs + strong damping + a speed limit → no oscillation
   *  - a collision pass keeps dots from overlapping
   *  - hidden suggestions take no part at all
   */
  _tickForce() {
    const { nodes, edges } = this._active();
    const a = this.alpha;
    const ls = this.layoutScale;

    // Repulsion, only between papers in the SAME citation cluster, so a
    // cluster spreads itself out without shoving neighbouring islands away.
    // Large clusters go through a spatial grid (O(n) pairs within the
    // cutoff) instead of the O(n²) double loop.
    const rep = 2200 * ls * ls;
    const cutoff = 560 * ls;
    const cutoff2 = cutoff * cutoff;
    const repel = (n1, n2) => {
      let dx = n2.x - n1.x;
      let dy = n2.y - n1.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) d2 = 1;
      if (d2 > cutoff2) return; // ignore far pairs
      const f = (rep * a) / d2;
      const d = Math.sqrt(d2);
      dx = (dx / d) * f;
      dy = (dy / d) * f;
      n1.vx -= dx;
      n1.vy -= dy;
      n2.vx += dx;
      n2.vy += dy;
    };
    for (const group of this._compGroups) {
      if (group.length > 150) {
        this._forEachClosePair(
          group.filter((n) => !this._hiddenFromMap(n)),
          cutoff,
          repel
        );
        continue;
      }
      for (let i = 0; i < group.length; i++) {
        const n1 = group[i];
        if (this._hiddenFromMap(n1)) continue;
        for (let j = i + 1; j < group.length; j++) {
          const n2 = group[j];
          if (this._hiddenFromMap(n2)) continue;
          repel(n1, n2);
        }
      }
    }

    // Springs along visible edges, soft on purpose; a stiff spring makes
    // the whole layout overshoot and wobble. Only WITHIN an island: islands
    // sit at fixed anchors, and a link to another island (typically to a
    // suggestion resting there) is drawn but must not drag papers across
    // the map or smear the grid of unlinked papers.
    const rest = 168 * ls;
    for (const e of edges) {
      const s = this.nodeByKey.get(e.source);
      const t = this.nodeByKey.get(e.target);
      if (!s || !t) continue;
      if (s._cluster !== t._cluster || s._cluster === -1) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = ((d - rest) / d) * 0.08 * a;
      s.vx += dx * f;
      s.vy += dy * f;
      t.vx -= dx * f;
      t.vy -= dy * f;
    }

    for (const n of nodes) {
      // Pull toward this node's cluster anchor (not a single global centre),
      // which keeps each island cohesive and in its packed place. Papers
      // with no links are held firmly in their grid slot.
      const c = n._cluster === -1 ? 0.16 : 0.045;
      n.vx += (n.anchorX - n.x) * c * a;
      n.vy += (n.anchorY - n.y) * c * a;
      if (n.fixed) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= 0.7; // strong damping: calm beats lively
      n.vy *= 0.7;
      // speed limit, the layout may converge, never buzz
      const sp = Math.hypot(n.vx, n.vy);
      const maxSp = 18 * a + 0.4;
      if (sp > maxSp) {
        n.vx = (n.vx / sp) * maxSp;
        n.vy = (n.vy / sp) * maxSp;
      }
      n.x += n.vx;
      n.y += n.vy;
      // hard cap: nothing may leave the arena, whatever the forces say
      const cap = Math.max(this._arena || 1400 * ls, this.width, this.height);
      if (n.x > cap) n.x = cap;
      else if (n.x < -cap) n.x = -cap;
      if (n.y > cap) n.y = cap;
      else if (n.y < -cap) n.y = -cap;
    }

    // Collision pass: overlapping dots are what made the map unreadable.
    // Grid-assisted above ~200 nodes (dot diameters are tiny compared to
    // the arena, so cells stay near-empty and the pass is effectively O(n)).
    const pad = 14;
    const collide = (n1, n2) => {
      const dx = n2.x - n1.x;
      const dy = n2.y - n1.y;
      const minD = n1.r + n2.r + pad;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD) return;
      const d = Math.sqrt(d2) || 1;
      const overlap = (minD - d) / 2;
      let px = (dx / d) * overlap;
      let py = (dy / d) * overlap;
      if (d2 === 0) {
        px = 0;
        py = (n1._gi % 2 ? 1 : -1) * overlap;
      }
      if (!n1.fixed) {
        n1.x -= px;
        n1.y -= py;
      }
      if (!n2.fixed) {
        n2.x += px;
        n2.y += py;
      }
    };
    if (nodes.length > 200) {
      this._forEachClosePair(nodes, 2 * 24 + pad, collide); // r is capped at 24
    } else {
      for (let i = 0; i < nodes.length; i++) {
        nodes[i]._gi = i;
        for (let j = i + 1; j < nodes.length; j++) {
          collide(nodes[i], nodes[j]);
        }
      }
    }

    this.alpha *= 0.975;
  }

  /**
   * Visit every pair of nodes closer than `cellSize` via a uniform spatial
   * hash, two nodes within that distance are always in the same or an
   * adjacent cell, so only the 3×3 neighbourhood is scanned.
   */
  _forEachClosePair(nodes, cellSize, fn) {
    const grid = new Map();
    const c = Math.max(1, cellSize);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n._gi = i;
      const key =
        Math.floor(n.x / c) * 100003 + Math.floor(n.y / c);
      let cell = grid.get(key);
      if (!cell) {
        cell = [];
        grid.set(key, cell);
      }
      cell.push(n);
    }
    for (const n of nodes) {
      const gx = Math.floor(n.x / c);
      const gy = Math.floor(n.y / c);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = grid.get((gx + dx) * 100003 + (gy + dy));
          if (!cell) continue;
          for (const m of cell) {
            if (m._gi <= n._gi) continue;
            fn(n, m);
          }
        }
      }
    }
  }

  /** The value a paper's height encodes in the timeline (see yMetric). */
  _metricValue(n) {
    return this.yMetric === "local"
      ? n.inLibraryCitations || 0
      : n.citedByCount || 0;
  }

  /** Papers with no citation data sit in a strip below the timeline axis. */
  _hasMetric(n) {
    return n.kind !== "unresolved";
  }

  /**
   * Timeline layout, a chart you can read without a legend:
   *   x = publication year (oldest left), height = citations (log scale).
   *
   * Each populated year is a column band, left→right in chronological order.
   * Empty years are skipped (a short gap marks the jump) so a lone 1970
   * classic doesn't squash 2015–2025 into a sliver. Inside its band a paper
   * sits at the height of its citation count, so the influential work rises
   * to the top; papers that would overlap are swarmed sideways (beeswarm)
   * and every band is exactly as wide as its swarm needs. Papers without
   * citation data rest in a strip under the axis. Positions are fixed, so
   * the layout never wobbles.
   */
  _computeTimelineLayout() {
    const nodes = this._active().nodes;
    if (!nodes.length) {
      this._timeBands = [];
      this._timeAxis = null;
      return;
    }
    const sp = this.spacingPct / 100;
    // Plot height grows gently with the number of papers; the Spacing slider
    // stretches it like everything else.
    const H = (300 + 40 * Math.sqrt(nodes.length)) * sp;
    const top = -H / 2;
    const floor = H / 2;
    const withData = nodes.filter((n) => this._hasMetric(n));
    const maxV = withData.reduce((m, n) => Math.max(m, this._metricValue(n)), 0);
    const minV = withData.length
      ? withData.reduce((m, n) => Math.min(m, this._metricValue(n)), Infinity)
      : 0;
    const logMax = Math.log10(1 + Math.max(1, maxV));
    // Citations worldwide: start the axis at the lowest power of ten in use
    // (e.g. 100 when every paper has 400+ citations) instead of at 0, so a
    // collection of well-cited papers uses the whole height rather than
    // bunching up at the top. "Cited on this map" counts start at 0 anyway.
    const floorDecade =
      this.yMetric === "global" && minV >= 10
        ? Math.pow(10, Math.floor(Math.log10(minV)))
        : 0;
    const logMin = floorDecade ? Math.log10(1 + floorDecade) : 0;
    const span = Math.max(0.3, logMax - logMin);
    const yOf = (v) =>
      floor - Math.max(0, (Math.log10(1 + Math.max(0, v)) - logMin) / span) * H;
    const noData = nodes.length > withData.length;
    const noDataY = floor + 54 * sp; // strip for papers without citation data
    const pad = 3 + 5 * sp; // gap between neighbouring dots

    const byYear = new Map();
    for (const n of nodes) {
      const y = n.year || null;
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(n);
    }
    const years = [...byYear.keys()]
      .filter((y) => y != null)
      .sort((a, b) => a - b);
    const order = byYear.has(null) ? [null, ...years] : years;

    const bands = [];
    const minBand = 34; // room for the year label under a lone dot
    const bandGap = 12 * sp;
    let cursorX = 0;
    let prevYear = null;
    for (const y of order) {
      // biggest/most-cited first so they claim the band's centre line
      const group = byYear.get(y).slice().sort(
        (a, b) =>
          this._metricValue(b) - this._metricValue(a) ||
          b.r - a.r ||
          (a.key < b.key ? -1 : 1)
      );
      const placed = [];
      for (const n of group) {
        const ty = this._hasMetric(n) ? yOf(this._metricValue(n)) : noDataY;
        const step = n.r * 0.5 + 1;
        let off = 0;
        for (let i = 0; i < 600; i++) {
          off = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * step;
          let free = true;
          for (const p of placed) {
            const dx = p.dx - off;
            const dy = p.y - ty;
            const min = p.r + n.r + pad;
            if (dx * dx + dy * dy < min * min) {
              free = false;
              break;
            }
          }
          if (free) break;
        }
        placed.push({ n, dx: off, y: ty, r: n.r });
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of placed) {
        lo = Math.min(lo, p.dx - p.r);
        hi = Math.max(hi, p.dx + p.r);
      }
      const width = Math.max(minBand, hi - lo);
      // a skipped stretch of years gets a slightly wider gap (and a marker)
      const skipped = y != null && prevYear != null ? y - prevYear - 1 : 0;
      if (bands.length) cursorX += bandGap + (skipped > 0 ? 18 * sp : 0);
      const x0 = cursorX;
      const cx = x0 + width / 2;
      const mid = (lo + hi) / 2;
      for (const p of placed) {
        p.n.tlx = cx + (p.dx - mid);
        p.n.tly = p.y;
      }
      bands.push({ year: y, x0, x1: x0 + width, cx, skipped });
      cursorX = x0 + width;
      if (y != null) prevYear = y;
    }

    // Center horizontally on the origin (vertically the plot already is).
    const shiftX = cursorX / 2;
    for (const n of nodes) if (n.tlx != null) n.tlx -= shiftX;
    for (const b of bands) {
      b.x0 -= shiftX;
      b.x1 -= shiftX;
      b.cx -= shiftX;
    }

    // "Nice" ticks for the height axis.
    const ticks = [];
    const cand =
      this.yMetric === "local"
        ? [0, 1, 2, 5, 10, 20, 50, 100, 200, 500]
        : [0, 1, 10, 100, 1000, 10000, 100000, 1000000];
    for (const v of cand) {
      if (v <= Math.max(1, maxV) && v >= floorDecade) ticks.push({ v, y: yOf(v) });
    }

    this._timeBands = bands;
    this._timeAxis = {
      top,
      floor,
      noData,
      noDataY,
      ticks,
      x0: bands[0].x0,
      x1: bands[bands.length - 1].x1,
    };
  }

  /**
   * Switch layout. `instant` snaps straight to the target (used when the map
   * opens in the timeline), `persist` remembers the choice for next time.
   */
  _setMode(mode, { instant = false, persist = true } = {}) {
    if (mode === this.mode) return;
    if (persist) {
      try {
        Zotero.Prefs.set("extensions.citation-map.layoutMode", mode, true);
      } catch (e) {
        /* best-effort */
      }
    }
    // A dragged (pinned) paper must not hold out against the new layout.
    for (const n of this.graph.nodes) n.fixed = false;
    if (mode === "timeline") {
      // Remember the exact network layout (islands and all) so we can glide
      // straight back to it later, instead of re-running a live force reflow
      // from the spread-out timeline positions, which scattered the islands.
      // Mid-way through a glide back, x/y are half-way positions: the real
      // network targets are still the remembered ones, so keep those.
      if (!this._returning) {
        for (const n of this.graph.nodes) {
          n._netX = n.x;
          n._netY = n.y;
        }
      }
      this.mode = "timeline";
      this._returning = false;
      this._computeTimelineLayout();
      this.alpha = 1; // ease into the chart
      if (instant) {
        for (const n of this._active().nodes) {
          if (n.tlx == null) continue;
          n.x = n.tlx;
          n.y = n.tly;
        }
        this.alpha = 0;
      }
    } else {
      // Returning to the network: ease every node back to its remembered
      // position with the same monotonic approach the timeline uses (no
      // forces, so it cannot overshoot, wobble, or fling islands apart).
      this.mode = "force";
      for (const n of this._active().nodes) {
        n.tlx = n._netX != null ? n._netX : n.anchorX != null ? n.anchorX : n.x;
        n.tly = n._netY != null ? n._netY : n.anchorY != null ? n.anchorY : n.y;
      }
      this._returning = true;
      this.alpha = 1;
    }
    if (this._layoutToggle) this._layoutToggle._set(this.mode);
    this._renderStatusMode();
    this._dirty = true;
    if (instant) return; // the caller fits the view
    // Re-fit once the new layout has settled.
    this.win.setTimeout(() => {
      if (!this._destroyed) {
        this._fitView();
        this._dirty = true;
      }
    }, 750);
  }

  // ============================================================== rendering

  _resize() {
    if (this._destroyed) return;
    const rect = this.stage.getBoundingClientRect();
    // Clamp the CSS size defensively (a bad measurement must never blow up
    // the backing store), then clamp the backing store itself to the canvas
    // max size, reducing the effective device-pixel ratio if needed, so
    // setTransform can never throw "Canvas exceeds max size".
    this.width = Math.max(50, Math.min(8000, rect.width || 0));
    this.height = Math.max(50, Math.min(8000, rect.height || 0));
    const MAX = 8192; // safe upper bound for a Gecko canvas dimension
    let dpr = this.win.devicePixelRatio || 1;
    let bw = Math.round(this.width * dpr);
    let bh = Math.round(this.height * dpr);
    if (bw > MAX || bh > MAX) {
      const s = MAX / Math.max(bw, bh);
      bw = Math.max(1, Math.floor(bw * s));
      bh = Math.max(1, Math.floor(bh * s));
      dpr = dpr * s;
    }
    // Only touch the (expensive) backing store when it actually changed.
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this.canvas.style.width = this.width + "px";
    this.canvas.style.height = this.height + "px";
    this.dpr = dpr;
    this._dirty = true;
    // The tab often gets its real size only after the first frames (and
    // changes with the sidebar, filter bar or window). As long as the user
    // hasn't zoomed or panned themselves, keep the whole map framed, so the
    // map never opens tiny in a corner of a viewport that grew afterwards.
    const sized =
      Math.abs(this.width - (this._fitW || 0)) > 1 ||
      Math.abs(this.height - (this._fitH || 0)) > 1;
    if (this._autoFit && this._didInitialFit && sized) {
      try {
        this._fitNodes(this._active().nodes, false, true);
      } catch (e) {
        /* not laid out yet: the animation loop fits once it is */
      }
    }
  }

  /** Is this map the tab in front? (Background tabs skip work and keys.) */
  _isVisible() {
    const tabs = this.win.Zotero_Tabs;
    if (this._tabID && tabs && tabs.selectedID != null) {
      return tabs.selectedID === this._tabID;
    }
    return true;
  }

  _css(name) {
    return this.win.getComputedStyle(this.root).getPropertyValue(name).trim();
  }

  _bounds() {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of this._active().nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    return { minX, maxX, minY, maxY };
  }

  /**
   * Rescale and center so the whole graph, every island included, fits
   * into the viewport. The layout is deterministic and bounded now, so
   * there are no stray fliers to trim against.
   */
  _fitView(animate = false) {
    this._fitNodes(this._active().nodes, animate, true);
  }

  /**
   * Frame a set of papers (all of them for fit-to-view; a paper and its
   * neighbours for double-click and the inspector's direction buttons).
   */
  _fitNodes(nodes, animate = false, whole = false) {
    nodes = (nodes || []).filter((n) => n && !this._hiddenFromMap(n));
    if (!nodes.length) return;
    // Stage collapsed (tab hidden / mid-layout): don't fit against a
    // bogus viewport, the next call will retry with real dimensions.
    if (this.width < 120 || this.height < 120) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }
    const w = Math.max(60, maxX - minX);
    const h = Math.max(60, maxY - minY);
    // the timeline's axes need room: tick values and title on the left,
    // year labels underneath (the legend is a footer now, not an overlay)
    const timeline = this.mode === "timeline";
    const padL = timeline ? 64 : 0;
    const padB = timeline ? 40 : 16;
    const margin = whole ? 60 : 140; // a subset gets more air around it
    const k = Math.max(
      this.constructor.MIN_ZOOM, // the same floor as wheel and buttons
      Math.min(
        whole ? 2 : 1.6,
        Math.min(
          (this.width - margin - padL) / w,
          (this.height - margin - padB) / h
        )
      )
    );
    const tx = (-(minX + maxX) / 2) * k + padL / 2;
    const ty = (-(minY + maxY) / 2) * k - padB / 2;
    // Smoothly glide to the fitted view (nicer than snapping), except on the
    // very first fit where there's nothing to animate from.
    if (animate && this._didInitialFit) {
      this._animateTransform(tx, ty, k);
    } else {
      this.transform.k = k;
      this.transform.x = tx;
      this.transform.y = ty;
    }
    // a whole-map fit keeps following the viewport size; framing a subset
    // is the user's own view and must not be overridden on resize
    this._autoFit = whole;
    this._fitW = this.width;
    this._fitH = this.height;
    if (whole) this._didInitialFit = true;
    this._dirty = true;
  }

  /**
   * Ease the pan/zoom transform to a target (260ms, the design system's
   * slow duration). Under reduced motion the camera jumps instead.
   */
  _animateTransform(tx, ty, k) {
    if (ZCM_VIEW_NS.MapTheme.reducedMotion(this.win)) {
      this.transform.k = k;
      this.transform.x = tx;
      this.transform.y = ty;
      this._dirty = true;
      return;
    }
    const from = { ...this.transform };
    const start = Date.now();
    const dur = 260;
    const token = (this._camToken = (this._camToken || 0) + 1);
    const ease = (u) => 1 - Math.pow(1 - u, 3); // easeOutCubic
    const step = () => {
      if (this._destroyed || token !== this._camToken) return; // superseded
      const u = Math.min(1, (Date.now() - start) / dur);
      const e = ease(u);
      this.transform.k = from.k + (k - from.k) * e;
      this.transform.x = from.x + (tx - from.x) * e;
      this.transform.y = from.y + (ty - from.y) * e;
      this._dirty = true;
      if (u < 1) this.win.requestAnimationFrame(step);
    };
    this.win.requestAnimationFrame(step);
  }

  /** Never let the graph leave the viewport entirely. */
  _clampTransform() {
    // nothing visible (e.g. every paper a hidden review): no bounds to clamp
    // to, and Infinity here would poison the transform for good
    if (!this._active().nodes.length) return;
    const { minX, maxX, minY, maxY } = this._bounds();
    const t = this.transform;
    const m = 60; // px of graph that must stay visible
    t.x = Math.min(
      Math.max(t.x, m - this.width / 2 - maxX * t.k),
      this.width / 2 - m - minX * t.k
    );
    t.y = Math.min(
      Math.max(t.y, m - this.height / 2 - maxY * t.k),
      this.height / 2 - m - minY * t.k
    );
    this._dirty = true;
  }

  /** Zoom by a factor toward the canvas center (for the +/− buttons). */
  _zoomBy(factor) {
    this._autoFit = false; // the user took over the camera
    const k2 = Math.max(this.constructor.MIN_ZOOM, Math.min(5, this.transform.k * factor));
    const ratio = k2 / this.transform.k;
    this.transform.x *= ratio;
    this.transform.y *= ratio;
    this.transform.k = k2;
    this._clampTransform();
  }

  _animate() {
    if (this._destroyed) return;
    this.win.requestAnimationFrame(() => this._animate());
    // A map in a background tab (library or PDF in front) does nothing;
    // it redraws once it is shown again.
    if (!this._isVisible()) {
      this._dirty = true;
      return;
    }
    // The loop always runs (so it can never get stuck), but the canvas is
    // only redrawn when something actually changed, a static, settled map
    // costs nothing.
    let redraw = this._dirty;
    this._dirty = false;
    // Retry the initial fit until the tab has real dimensions.
    if (!this._didInitialFit) {
      this._fitView();
      redraw = true;
    }
    if (this.alpha >= 0.02) {
      this._tick();
      redraw = true;
    }
    if (this.activeChain) {
      // the chain "thread" marches at a steady speed; under reduced motion
      // it stays static (and costs no redraws)
      const MT = ZCM_VIEW_NS.MapTheme;
      const now = Date.now();
      if (!MT.reducedMotion(this.win)) {
        const dt = Math.min(100, now - (this._lastChainTick || now));
        this.dashOffset -= (MT.MAP_THEME.geometry.chainSpeed * dt) / 1000;
        redraw = true;
      }
      this._lastChainTick = now;
    } else {
      this._lastChainTick = 0;
    }
    if (redraw) {
      try {
        this._draw();
      } catch (e) {
        // One bad frame must not spam the console every tick. Log once,
        // then leave the map static until something changes.
        if (!this._drawErrLogged) {
          this._drawErrLogged = true;
          this._diag("draw-error", {
            msg: String(e && e.message ? e.message : e),
            cw: this.canvas && this.canvas.width,
            ch: this.canvas && this.canvas.height,
          });
        }
      }
    }
  }

  /**
   * Draw the map. Every colour, width and font comes from the current
   * theme's palette (this.T, mirroring tokens.css) and the shared geometry
   * in MapTheme; nothing here is hard-coded. No blur, shadows or gradients
   * on canvas strokes.
   */
  _draw() {
    const ctx = this.canvas.getContext("2d");
    const MT = ZCM_VIEW_NS.MapTheme;
    const T = this.T;
    const G = MT.MAP_THEME.geometry;
    const { x: tx, y: ty, k } = this.transform;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // transparent canvas: the stage behind it paints --zcm-canvas
    ctx.clearRect(0, 0, this.width, this.height);

    const activeEdges = this._active().edges;
    // dense graphs get fainter edges so the dots stay in front: alpha falls
    // linearly from 50 to 600 edges
    const dens = Math.max(0, Math.min(1, (activeEdges.length - 50) / 550));
    const baseEdgeAlpha =
      T.edgeAlpha.sparse + (T.edgeAlpha.dense - T.edgeAlpha.sparse) * dens;
    const ew = this.edgeWidthPct / 100; // user's line-width slider

    ctx.save();
    ctx.translate(this.width / 2 + tx, this.height / 2 + ty);
    ctx.scale(k, k);

    // ---- timeline chart: year bands, citation axis, gridlines
    const ax = this.mode === "timeline" ? this._timeAxis : null;
    if (ax && this._timeBands && this._timeBands.length) {
      const sp = this.spacingPct / 100;
      const viewTop = (-this.height / 2 - ty) / k;
      const viewBot = (this.height / 2 - ty) / k;
      const viewLeft = (-this.width / 2 - tx) / k;
      const plotBottom = ax.noData ? ax.noDataY + 18 * sp : ax.floor + 10;
      const bandTop = Math.max(viewTop, ax.top - 34);
      const bandBot = Math.min(viewBot, plotBottom + 6);
      // every other year column gets a faint band, so each year is scannable
      ctx.fillStyle = T.band;
      this._timeBands.forEach((b, i) => {
        if (i % 2 === 1 && bandBot > bandTop) {
          ctx.fillRect(b.x0 - 5 * sp, bandTop, b.x1 - b.x0 + 10 * sp, bandBot - bandTop);
        }
      });
      // horizontal gridlines; tick labels pinned inside the left edge of the
      // viewport, so the scale stays readable however far you pan
      const tickX = Math.max(ax.x0 - 10 / k, viewLeft + 54 / k);
      ctx.lineWidth = 1 / k;
      ctx.strokeStyle = T.grid;
      ctx.fillStyle = T.axisText;
      ctx.font = MT.font(500, G.tickSize / k);
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      for (const t of ax.ticks) {
        ctx.beginPath();
        ctx.moveTo(ax.x0 - 8, t.y);
        ctx.lineTo(ax.x1 + 8, t.y);
        ctx.stroke();
        ctx.fillText(this._fmtCount(t.v), tickX, t.y);
      }
      if (ax.noData) ctx.fillText("No data", tickX, ax.noDataY);
      // axis title, rotated, reading bottom → top (sentence case)
      ctx.save();
      ctx.translate(tickX - 44 / k, (ax.top + ax.floor) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(
        this.yMetric === "local"
          ? "Cited by papers on this map"
          : "Citations worldwide (log)",
        0,
        0
      );
      ctx.restore();
      // year labels under the plot (pinned to the viewport bottom if the
      // plot runs below it); dense years skip labels that would collide
      const yearY = Math.min(viewBot - 14 / k, plotBottom + 12 / k);
      ctx.textAlign = "center";
      let lastRight = -Infinity;
      for (const b of this._timeBands) {
        if (b.skipped > 0) {
          // a jump over empty years: a small break mark on the baseline
          ctx.fillText("⋯", b.x0 - 15 * sp, ax.floor);
        }
        const label = b.year == null ? "Undated" : String(b.year);
        const w = ctx.measureText(label).width;
        if (b.cx - w / 2 < lastRight + 6 / k) continue;
        ctx.fillText(label, b.cx, yearY);
        lastRight = b.cx + w / 2;
      }
      ctx.textBaseline = "alphabetic";
    }

    const chainSet = new Set(this.activeChain || []);
    const chainEdges = new Set();
    if (this.activeChain) {
      for (let i = 0; i < this.activeChain.length - 1; i++) {
        chainEdges.add(this.activeChain[i] + ">" + this.activeChain[i + 1]);
      }
    }
    const focus = this.hovered || this.selected;
    const focusSet = focus
      ? new Set([focus, ...(this.neighbors.get(focus) || [])])
      : null;
    // Direction around the focused paper: what it cites (its references,
    // older work it builds on) vs. what cites it (newer work building on it).
    const focusOut = new Set();
    const focusIn = new Set();
    if (focus) {
      for (const e of activeEdges) {
        if (e.source === focus) focusOut.add(e.target);
        else if (e.target === focus) focusIn.add(e.source);
      }
    }
    // while a paper is focused, the legend's two direction keys switch to
    // full text colour
    if (this.legend && !!focus !== this._legendFocused) {
      this._legendFocused = !!focus;
      this.legend.classList.toggle("is-focused", !!focus);
    }

    // ---- coupling links (dashed "sibling" layer, beneath the arrows)
    if (this.showCoupling && this.graph.coupling.length) {
      ctx.strokeStyle = T.edge;
      for (const c of this.graph.coupling) {
        if (c.shared < this.couplingMin) continue;
        const a = this.nodeByKey.get(c.a);
        const b = this.nodeByKey.get(c.b);
        if (!a || !b || this._hiddenFromMap(a) || this._hiddenFromMap(b)) continue;
        let alpha = Math.min(0.7, 0.25 + c.shared * 0.05);
        if (focusSet && !(focusSet.has(c.a) && focusSet.has(c.b))) alpha *= T.dimAlpha;
        if (this.activeChain) alpha = Math.min(alpha, 0.7 * T.dimAlpha);
        ctx.globalAlpha = alpha;
        ctx.lineWidth = (G.edgeWidth * ew) / k;
        ctx.setLineDash([2 / k, 3 / k]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // ---- edges (arrow from citing → cited). Straight in the network; in
    // the timeline a gentle upward arc, so the many citations of one classic
    // fan out instead of stacking into a single thick line. Background
    // edges first, then the focused / chain edges on top.
    const curved = this.mode === "timeline";
    const drawEdge = (e, pass) => {
      const s = this.nodeByKey.get(e.source);
      const t = this.nodeByKey.get(e.target);
      if (!s || !t) return;
      const onChain = chainEdges.has(e.source + ">" + e.target);
      const isFocus = !!focus && (e.source === focus || e.target === focus);
      const top = onChain || isFocus;
      if ((pass === 1) !== top) return;
      let alpha = baseEdgeAlpha;
      let color = T.edge;
      let width = G.edgeWidth;
      if (focus && !isFocus) alpha = baseEdgeAlpha * T.dimAlpha;
      if (this.activeChain && !onChain) alpha = Math.min(alpha, baseEdgeAlpha * T.dimAlpha);
      if (isFocus) {
        // blue: the focused paper cites this one · pink: this one cites it
        color = e.source === focus ? T.cites : T.citedBy;
        alpha = 1;
        width = G.focusEdgeWidth;
      }
      if (onChain) {
        color = T.chain;
        alpha = 1;
        width = G.chainWidth;
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = (width * ew) / k;
      ctx.setLineDash(onChain ? G.chainDash.map((v) => v / k) : []);
      ctx.lineDashOffset = onChain ? this.dashOffset / k : 0;
      let fx = s.x; // the point the arrow's last segment comes from
      let fy = s.y;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      if (curved) {
        const ex = t.x - s.x;
        const ey = t.y - s.y;
        const len = Math.hypot(ex, ey) || 1;
        let px = -ey / len;
        let py = ex / len;
        if (py > 0) {
          px = -px; // always bow upward
          py = -py;
        }
        const bow = Math.min(60, len * 0.18);
        fx = (s.x + t.x) / 2 + px * bow;
        fy = (s.y + t.y) / 2 + py * bow;
        ctx.quadraticCurveTo(fx, fy, t.x, t.y);
      } else {
        ctx.lineTo(t.x, t.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // arrowhead at the cited end, along the line's final direction
      const dx = t.x - fx;
      const dy = t.y - fy;
      const d = Math.max(1, Math.hypot(dx, dy));
      const hx = t.x - (dx / d) * (t.r + 4 / k);
      const hy = t.y - (dy / d) * (t.r + 4 / k);
      const ang = Math.atan2(dy, dx);
      // arrowheads grow with the line width, but gently (sqrt), so thick
      // lines don't turn every arrow into a wedge
      const sz = ((onChain ? G.arrowSize + 2 : G.arrowSize) * Math.sqrt(ew)) / k;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx - sz * Math.cos(ang - 0.45), hy - sz * Math.sin(ang - 0.45));
      ctx.lineTo(hx - sz * Math.cos(ang + 0.45), hy - sz * Math.sin(ang + 0.45));
      ctx.fill();
    };
    for (const e of activeEdges) drawEdge(e, 0);
    if (focus || this.activeChain) for (const e of activeEdges) drawEdge(e, 1);

    // ---- nodes: dimmed (background) papers first, then the rest on top
    ctx.globalAlpha = 1;
    // Label budget: only the most-cited papers are labelled when zoomed out,
    // zooming in reveals the rest; collisions are resolved after the loop.
    const maxLabels = k > 1.6 ? Infinity : k > 0.9 ? 40 : 18;
    const labelCands = [];
    const softAlpha = T.softAlpha;
    const drawNode = (n, dim, matches) => {
      const base = dim ? T.dimAlpha : 1;
      const fill = this._nodeFill(n);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      if (n.kind === "discovered") {
        // NOT in your library (yet): an open ring with a soft fill, so the
        // shape alone says "not yours yet" (filled dots are yours). Orange
        // for suggestions from your references, violet for papers the
        // Discover search placed; "Top" mode's teased few are a little softer.
        const pal = n._injected ? T.node.discover : T.node.suggested;
        const byKind = this.colorMode === "kind" || this.colorMode === "publisher";
        const ring = byKind ? pal.stroke : fill || T.axisText;
        ctx.globalAlpha = base * (n.teased ? 0.75 : 1);
        if (byKind) {
          ctx.fillStyle = pal.fill; // already the soft tint
          ctx.fill();
        } else {
          ctx.fillStyle = MT.withAlpha(ring, softAlpha);
          ctx.fill();
        }
        ctx.strokeStyle = ring;
        ctx.lineWidth = G.ringWidth / k;
        if (!byKind && fill == null) ctx.setLineDash([2 / k, 2 / k]); // OA unknown
        ctx.stroke();
        ctx.setLineDash([]);
        if (n._injected && !byKind && !dim) {
          ctx.beginPath(); // keep "found by search" visible in every mode
          ctx.arc(n.x, n.y, n.r + G.neighbourRingGap / k, 0, Math.PI * 2);
          ctx.strokeStyle = T.node.discover.stroke;
          ctx.globalAlpha = 0.6;
          ctx.lineWidth = 1 / k;
          ctx.stroke();
        }
      } else if (fill == null) {
        // open-access status unknown: a hollow ring with a 2/2 dash
        ctx.globalAlpha = base;
        ctx.strokeStyle = T.axisText;
        ctx.lineWidth = 1.5 / k;
        ctx.setLineDash([2 / k, 2 / k]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.globalAlpha = base;
        ctx.fillStyle = fill;
        ctx.fill();
        // Rim. "By journal": papers from a recognised journal take the
        // publisher's colour, nudged to 3:1 against the canvas. Otherwise a
        // hairline in the canvas colour keeps touching dots apart.
        const ci = this.colorMode === "publisher" ? this._ci(n) : null;
        if (ci && ci.matched && ci.primary) {
          ctx.beginPath();
          // (zoomed far out the rim would be wider than the dot: keep r positive)
          ctx.arc(n.x, n.y, Math.max(n.r / 2, n.r - G.brandRimWidth / (2 * k)), 0, Math.PI * 2);
          ctx.strokeStyle = MT.adjustBrandColour(ci.primary, T.name);
          ctx.lineWidth = Math.min(n.r, G.brandRimWidth / k);
        } else {
          ctx.strokeStyle = T.canvas;
          ctx.lineWidth = 1 / k;
        }
        ctx.stroke();
      }
      ctx.globalAlpha = base;
      if (n.key === this.selected) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + G.selectRingGap / k, 0, Math.PI * 2);
        ctx.strokeStyle = T.selectRing;
        ctx.lineWidth = G.selectRingWidth / k;
        ctx.stroke();
      } else if (!dim && (focusOut.has(n.key) || focusIn.has(n.key))) {
        // a neighbour of the focused paper, ringed in its link's colour
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + G.neighbourRingGap / k, 0, Math.PI * 2);
        ctx.strokeStyle = focusOut.has(n.key) ? T.cites : T.citedBy;
        ctx.lineWidth = G.neighbourRingWidth / k;
        ctx.stroke();
      }
      if (n.key === this._kbdFocus && n.key !== this.selected) {
        // keyboard focus on the map: a dashed selection ring
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + (G.selectRingGap + 3) / k, 0, Math.PI * 2);
        ctx.strokeStyle = T.selectRing;
        ctx.lineWidth = G.selectRingWidth / k;
        ctx.setLineDash([3 / k, 3 / k]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // new since the last build of this collection: a small dot at the
      // node's upper left, outlined in the canvas colour so it reads over
      // any fill
      if (n.isNew && !dim) {
        ctx.beginPath();
        ctx.arc(n.x - n.r * 0.72, n.y - n.r * 0.72, G.newMarkerRadius / k, 0, Math.PI * 2);
        ctx.fillStyle = T.newMarker;
        ctx.fill();
        ctx.strokeStyle = T.canvas;
        ctx.lineWidth = 1.5 / k;
        ctx.stroke();
      }

      // step number on an active chain (1 = oldest paper)
      if (this.activeChain && chainSet.has(n.key)) {
        const stepNo = this.activeChain.length - this.activeChain.indexOf(n.key);
        const bx = n.x + n.r * 0.8;
        const by = n.y - n.r * 0.8;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(bx, by, G.chainStepRadius / k, 0, Math.PI * 2);
        ctx.fillStyle = T.chain;
        ctx.fill();
        ctx.fillStyle = T.chainStepText;
        ctx.font = MT.font(600, 10 / k);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(stepNo), bx, by + 0.5 / k);
        ctx.textBaseline = "alphabetic";
      }

      // label priority: the focused/selected paper, then a highlighted
      // chain, then the focused paper's neighbours, then by citations
      if (!dim) {
        let pri = null;
        if (n.key === focus || n.key === this.selected) pri = 0;
        else if (chainSet.has(n.key)) pri = 1;
        else if (focusSet && focusSet.has(n.key)) pri = 2;
        else if (this.query && matches) pri = 2;
        else if (n._rank < maxLabels) pri = 3 + n._rank;
        if (pri != null) labelCands.push({ n, pri });
      }
    };
    const front = [];
    for (const n of this.graph.nodes) {
      if (this._hiddenFromMap(n)) continue;
      const matches =
        !this.query ||
        n.title.toLowerCase().includes(this.query) ||
        (n.authors || []).some((a) => a.toLowerCase().includes(this.query));
      let dim = false;
      if (this.query && !matches) dim = true;
      if (focusSet && !focusSet.has(n.key)) dim = true;
      if (this.activeChain && !chainSet.has(n.key)) dim = true;
      if (!this._passesFilters(n)) dim = true;
      if (dim) drawNode(n, true, matches);
      else front.push([n, matches]);
    }
    for (const [n, matches] of front) drawNode(n, false, matches);

    // ---- labels ("Surname Year"), placed greedily by priority; a label
    // that would overlap one already placed is skipped (zoom in to see it),
    // so dense areas stay readable instead of turning into a smear.
    labelCands.sort((a, b) => a.pri - b.pri);
    ctx.globalAlpha = 1;
    ctx.font = MT.font(500, G.labelSize / k);
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.lineWidth = G.labelHaloWidth / k;
    const placedLabels = [];
    for (const { n, pri } of labelCands) {
      const label = this._label(n);
      const w = ctx.measureText(label).width;
      const ly = n.y + n.r + 14 / k;
      const box = {
        x0: n.x - w / 2 - 2 / k,
        x1: n.x + w / 2 + 2 / k,
        y0: ly - 11 / k,
        y1: ly + 3 / k,
      };
      if (
        pri > 0 &&
        placedLabels.some(
          (b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1
        )
      ) {
        continue;
      }
      placedLabels.push(box);
      ctx.strokeStyle = T.labelHalo; // halo so labels survive busy edges
      ctx.strokeText(label, n.x, ly);
      ctx.fillStyle = T.labelText;
      ctx.fillText(label, n.x, ly);
    }

    // ---- cluster labels (network mode): each island's dominant topic,
    // fading out as you zoom in and the per-paper labels take over.
    if (this.mode === "force" && this._clusters && this._clusters.length > 1) {
      const fade = Math.max(0, Math.min(1, (1.4 - k) / 0.9));
      if (fade > 0.02) {
        ctx.textAlign = "center";
        for (const cl of this._clusters) {
          if (!cl.label) continue;
          let sx = 0;
          let top = Infinity;
          let cnt = 0;
          for (const n of cl.nodes) {
            if (this._hiddenFromMap(n)) continue;
            sx += n.x;
            if (n.y - n.r < top) top = n.y - n.r;
            cnt++;
          }
          if (cnt < 3) continue;
          ctx.globalAlpha = fade;
          ctx.font = MT.font(600, G.clusterLabelSize / k);
          ctx.lineJoin = "round";
          ctx.lineWidth = (G.labelHaloWidth + 1) / k;
          ctx.strokeStyle = T.labelHalo;
          const lx = sx / cnt;
          const lyy = top - 18 / k;
          ctx.strokeText(cl.label, lx, lyy);
          ctx.fillStyle = T.axisText;
          ctx.fillText(cl.label, lx, lyy);
        }
        ctx.globalAlpha = 1;
      }
    }
    // ---- the grid of papers with no citation link to the rest gets a
    // caption, so it doesn't read as an unexplained block
    const se = this._singlesEntry;
    if (this.mode === "force" && se && se.nodes.length >= 2) {
      let sx = 0;
      let top = Infinity;
      let cnt = 0;
      for (const n of se.nodes) {
        if (this._hiddenFromMap(n)) continue;
        sx += n.x;
        top = Math.min(top, n.y - n.r);
        cnt++;
      }
      if (cnt >= 2) {
        ctx.globalAlpha = 1;
        ctx.textAlign = "center";
        ctx.font = MT.font(500, G.labelSize / k);
        ctx.fillStyle = T.axisText;
        ctx.fillText(`Not linked to the others (${cnt})`, sx / cnt, top - 12 / k);
      }
    }
    ctx.restore();
  }

  /** 0, 1, 10, 100, 1k, 10k, 1M, compact axis numbers. */
  _fmtCount(v) {
    if (v >= 1e6) return v / 1e6 + "M";
    if (v >= 1e3) return v / 1e3 + "k";
    return String(v);
  }

  _label(n) {
    const a = n.authors && n.authors[0];
    if (a) {
      // OpenAlex gives "Jane Smith"; Zotero's firstCreator (unresolved
      // papers) gives "Smith", "Smith and Jones" or "Smith et al."
      const first = String(a)
        .replace(/\s+et\s+al\.?\s*$/i, "")
        .split(/\s+(?:and|&)\s+/)[0]
        .trim();
      const surname = first.split(" ").pop() || first;
      return n.year ? `${surname} ${n.year}` : surname;
    }
    const t = this._short(n.title).slice(0, 22);
    return n.year ? `${t} ${n.year}` : t;
  }

  // ============================================================ interaction

  _toGraphCoords(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const { x: tx, y: ty, k } = this.transform;
    return {
      x: (ev.clientX - rect.left - this.width / 2 - tx) / k,
      y: (ev.clientY - rect.top - this.height / 2 - ty) / k,
    };
  }

  _nodeAt(p) {
    // iterate in reverse so top-drawn nodes win
    const nodes = this.graph.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (this._hiddenFromMap(n)) continue;
      const dx = p.x - n.x;
      const dy = p.y - n.y;
      // pointer target: at least 8px on screen, even for a small dot
      const hit = Math.max(n.r + 3, 8 / this.transform.k);
      if (dx * dx + dy * dy <= hit * hit) return n;
    }
    return null;
  }

  _attachCanvasEvents() {
    const c = this.canvas;
    let dragNode = null;
    let panning = false;
    let last = null;
    let downPt = null; // where the mouse went down, to tell a click from a drag
    let moved = false; // did the pointer move enough to count as a drag/pan?

    // Zoom around a point on the canvas (client coordinates).
    const zoomAt = (clientX, clientY, factor) => {
      const k2 = Math.max(this.constructor.MIN_ZOOM, Math.min(5, this.transform.k * factor));
      const rect = c.getBoundingClientRect();
      const mx = clientX - rect.left - this.width / 2;
      const my = clientY - rect.top - this.height / 2;
      this.transform.x = mx - ((mx - this.transform.x) * k2) / this.transform.k;
      this.transform.y = my - ((my - this.transform.y) * k2) / this.transform.k;
      this.transform.k = k2;
      this._clampTransform();
    };
    let lastPinch = 0; // which pinch source spoke last (avoids double zoom)
    let lastPinchSrc = "";
    let lastPt = null; // last pointer position over the canvas

    // Trackpad and mouse wheel.
    //  - Pinch with two fingers = zoom. Browsers deliver a pinch as a wheel
    //    event with ctrlKey set; Ctrl/Cmd + scroll does the same on a mouse.
    //  - Two fingers sliding = move the map in any direction. A trackpad
    //    sends pixel-precise deltas (deltaMode 0); a classic mouse wheel
    //    sends line steps (deltaMode 1), which keep zooming as before.
    //  - Display ▸ Scrolling overrides the guess: always zoom, or always move.
    c.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        this._hideTooltip();
        this._autoFit = false; // the user took over the camera
        const pinch = ev.ctrlKey || ev.metaKey;
        const precise = ev.deltaMode === 0;
        const pan =
          !pinch &&
          (this.scrollGesture === "pan" ||
            (this.scrollGesture !== "zoom" && precise));
        if (pan) {
          const step = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? this.height : 1;
          this.transform.x -= ev.deltaX * step;
          this.transform.y -= ev.deltaY * step;
          this._clampTransform();
          return;
        }
        if (pinch) {
          const now = Date.now();
          if (lastPinchSrc === "gesture" && now - lastPinch < 80) return;
          lastPinch = now;
          lastPinchSrc = "wheel";
        }
        // Zoom in proportion to the scroll amount: a mouse notch is a gentle
        // step, while a stream of tiny trackpad deltas doesn't race. A pinch
        // reports small deltas, so it gets a stronger factor.
        const unit =
          ev.deltaMode === 1 ? 0.05 : ev.deltaMode === 2 ? 1 : pinch ? 0.01 : 0.0025;
        const factor = Math.max(0.8, Math.min(1.25, Math.exp(-ev.deltaY * unit)));
        zoomAt(ev.clientX, ev.clientY, factor);
      },
      { passive: false }
    );

    // macOS trackpad pinch as delivered to Zotero's own (chrome) window:
    // Gecko's magnify gesture events, where they exist. Harmless elsewhere.
    const onMagnify = (ev) => {
      ev.preventDefault();
      const now = Date.now();
      if (lastPinchSrc === "wheel" && now - lastPinch < 80) return;
      lastPinch = now;
      lastPinchSrc = "gesture";
      const d = Number(ev.delta) || 0;
      if (!d) return;
      this._hideTooltip();
      this._autoFit = false;
      const factor = Math.max(0.8, Math.min(1.25, Math.exp(d * 0.01)));
      const rect = c.getBoundingClientRect();
      const pt = lastPt || {
        x: rect.left + this.width / 2,
        y: rect.top + this.height / 2,
      };
      zoomAt(pt.x, pt.y, factor);
    };
    c.addEventListener("MozMagnifyGestureStart", (ev) => ev.preventDefault());
    c.addEventListener("MozMagnifyGestureUpdate", onMagnify);
    c.addEventListener("MozMagnifyGesture", (ev) => ev.preventDefault());
    c.addEventListener("mousemove", (ev) => {
      lastPt = { x: ev.clientX, y: ev.clientY };
    });

    c.addEventListener("mousedown", (ev) => {
      const p = this._toGraphCoords(ev);
      this._hideTooltip();
      // Dragging a paper repositions (and pins) it in the network. In the
      // timeline its position IS its data, so a drag there pans instead.
      dragNode = this.mode === "timeline" ? null : this._nodeAt(p);
      if (!dragNode) panning = true;
      last = { x: ev.clientX, y: ev.clientY };
      downPt = { x: ev.clientX, y: ev.clientY };
      moved = false;
      this._dirty = true;
    });

    c.addEventListener("mousemove", (ev) => {
      const p = this._toGraphCoords(ev);
      // a small movement while the button is down means "drag/pan", not "click"
      if (downPt && (dragNode || panning)) {
        if (Math.hypot(ev.clientX - downPt.x, ev.clientY - downPt.y) > 4) {
          moved = true;
        }
      }
      if (dragNode) {
        // a plain click must not pin: only an actual drag does
        if (moved) {
          dragNode.fixed = true;
          dragNode.x = p.x;
          dragNode.y = p.y;
          this.alpha = Math.max(this.alpha, 0.08);
        }
      } else if (panning && last) {
        this._autoFit = false; // the user took over the camera
        this.transform.x += ev.clientX - last.x;
        this.transform.y += ev.clientY - last.y;
        this._clampTransform();
        last = { x: ev.clientX, y: ev.clientY };
      } else {
        const n = this._nodeAt(p);
        const prev = this.hovered;
        this.hovered = n ? n.key : null;
        this._kbdFocus = null; // the pointer took over from the keyboard
        c.style.cursor = n ? "pointer" : "grab";
        if (prev !== this.hovered) {
          this._dirty = true;
          // focus is instant; the tooltip follows after a short delay
          this._hideTooltip();
          if (n) {
            this._tooltipTimer = this.win.setTimeout(() => {
              this._tooltipTimer = null;
              if (!this._destroyed && this.hovered === n.key) this._showTooltip(n);
            }, 250);
          }
        }
      }
      if (panning) last = { x: ev.clientX, y: ev.clientY };
    });

    const endDrag = () => {
      dragNode = null;
      panning = false;
      last = null;
    };
    c.addEventListener("mouseup", endDrag);
    c.addEventListener("mouseleave", () => {
      endDrag();
      this.hovered = null;
      this._hideTooltip();
      this._dirty = true;
    });
    c.addEventListener("blur", () => {
      if (this._kbdFocus) {
        this._kbdFocus = null;
        this.hovered = null;
        this._hideTooltip();
        this._dirty = true;
      }
    });

    c.addEventListener("click", (ev) => {
      // A pan/drag ends in a click event too; don't let it deselect (which
      // would close the details whenever you moved the map).
      if (moved) {
        moved = false;
        return;
      }
      const n = this._nodeAt(this._toGraphCoords(ev));
      this._select(n ? n.key : null, false);
    });

    c.addEventListener("dblclick", (ev) => {
      const n = this._nodeAt(this._toGraphCoords(ev));
      if (!n) {
        this._fitView(true); // double-click the background = reframe everything
        return;
      }
      // double-click a paper = zoom to it and its neighbours on the map
      n.fixed = false; // also releases a pinned node
      const near = [...(this.neighbors.get(n.key) || [])].map((k) => this.nodeByKey.get(k));
      this._fitNodes([n, ...near], true);
    });
  }

  _hideTooltip() {
    if (this._tooltipTimer) {
      this.win.clearTimeout(this._tooltipTimer);
      this._tooltipTimer = null;
    }
    if (this.tooltip) this.tooltip.style.display = "none";
  }

  /**
   * The map tooltip: kind line · title · meta · badges · hint. It is
   * anchored to the PAPER (not the cursor), flips to stay inside the stage,
   * and never intercepts pointer events.
   */
  _showTooltip(node) {
    const tt = this.tooltip;
    if (!node || !tt) {
      this._hideTooltip();
      return;
    }
    tt.textContent = "";
    const kind = this._el("span", "zcm-kind");
    kind.appendChild(this._kindMark(node));
    let kindLabel = this._kindLabel(node);
    if (node.kind === "discovered" && !(node.via && node.via !== "refs")) {
      kindLabel = `Suggested · cited by ${node.inLibraryCitations} of your papers`;
    }
    kind.appendChild(this._el("span", null, kindLabel));
    tt.appendChild(kind);
    tt.appendChild(this._el("div", "zcm-tooltip-title", node.title));
    const authors = node.authors || [];
    const metaBits = [];
    if (authors.length) {
      metaBits.push(authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : ""));
    }
    if (node.year) metaBits.push(String(node.year));
    if (node.venue) metaBits.push(node.venue);
    if (metaBits.length) {
      tt.appendChild(this._el("div", "zcm-tooltip-meta", metaBits.join(" · ")));
    }
    // its links on the map, in the same blue/pink as the highlighted lines
    let nOut = 0;
    let nIn = 0;
    for (const e of this._active().edges) {
      if (e.source === node.key) nOut++;
      else if (e.target === node.key) nIn++;
    }
    const badges = this._el("div", "zcm-toolrow zcm-tooltip-badges");
    badges.appendChild(this._badge("cites", `cites ${nOut}`, "arrow-left"));
    badges.appendChild(this._badge("citedby", `cited by ${nIn}`, "arrow-right", null, true));
    if (node.citedByCount != null && node.kind !== "unresolved") {
      badges.appendChild(
        this._badge("neutral", `${this._fmtBig(node.citedByCount)} worldwide`)
      );
    }
    tt.appendChild(badges);
    tt.appendChild(
      this._el(
        "div",
        "zcm-tooltip-hint",
        "Click to open details · double-click to focus"
      )
    );

    // position: under the paper, centred; flip above when there's no room
    tt.style.display = "flex";
    const k = this.transform.k;
    const sx = this.width / 2 + this.transform.x + node.x * k;
    const sy = this.height / 2 + this.transform.y + node.y * k;
    const rr = node.r * k;
    const tw = tt.offsetWidth || 264;
    const th = tt.offsetHeight || 130;
    let left = sx - tw / 2;
    left = Math.max(8, Math.min(left, this.width - tw - 8));
    let top = sy + rr + 22; // clears the paper's label
    if (top + th > this.height - 8) top = sy - rr - th - 10;
    top = Math.max(8, Math.min(top, this.height - th - 8));
    tt.style.left = Math.round(left) + "px";
    tt.style.top = Math.round(top) + "px";
  }

  /**
   * Select a paper (or clear the selection with null): selection ring on
   * the map, the focus state stays while selected, and the inspector opens
   * in the sidebar. `center` pans the paper into the middle of the view.
   */
  _select(key, center) {
    this.selected = key;
    const node = key ? this.nodeByKey.get(key) : null;
    this._hideTooltip();
    if (node) {
      this._renderDetails(node);
      this._openInspector();
    } else {
      this._renderDetails(null);
      this._closeInspector();
      // on narrow tabs the sidebar is a sheet over the map: closing the
      // details closes the sheet with it
      if (this._sizeClass === "sm" && !this._sidebarCollapsed) {
        this._setSidebarCollapsed(true, false);
      }
    }
    // mirror the selection in the sidebar lists
    this._markSelectedRows(key);
    if (node && center) {
      const k = this.transform.k;
      this._autoFit = false;
      this._animateTransform(-node.x * k, -node.y * k, k);
    }
    this._dirty = true;
  }

  // ================================================================== tour

  // Interactive coachmarks: a small card pops up NEXT TO the element it
  // explains, with a teal spotlight ring around it. Used by the first-run
  // tour and the one-time "What's new" walkthrough for upgraders.
  //
  // Non-trapping by design: the overlay is click-THROUGH (pointer-events
  // none), so the map, toolbar and sidebar stay fully usable during the
  // tour, only the card itself is interactive. That means a mispositioned
  // card or a stale layout can never lock the user out of the view.

  /**
   * Run a coachmark sequence. Each step:
   *   { title, body, target?: () => Element|null, before?: () => void,
   *     guideLink?: boolean }
   * No target (or a not-yet-laid-out target) → centered card, no spotlight.
   * Missing targets are skipped.
   */
  _startCoachmarks(steps, onDone) {
    this._endCoachmarks(false);
    if (this._destroyed || !this.root) return;
    const ov = this._el("div", "zcm-cm-overlay");
    const ring = this._el("div", "zcm-cm-ring");
    const card = this._el("div", "zcm-cm-card");
    ov.appendChild(ring);
    ov.appendChild(card);
    this.root.appendChild(ov);
    // Escape always closes the walkthrough, whatever else is going on.
    const onKey = (ev) => {
      if (ev.key === "Escape") this._endCoachmarks(true);
    };
    this.doc.addEventListener("keydown", onKey, true);
    this._cm = { ov, ring, card, steps, i: 0, onDone, onKey };
    this._cmShow(0);
  }

  _cmShow(i) {
    const cm = this._cm;
    if (!cm || this._destroyed) return;
    try {
      this._cmRender(cm, i);
    } catch (e) {
      // A render error must never leave a stuck overlay dimming the map.
      Zotero.debug("[Citation Map] coachmark render failed: " + e);
      this._endCoachmarks(true);
    }
  }

  _cmRender(cm, i) {
    // skip steps whose anchor element doesn't exist in this view
    while (i < cm.steps.length && cm.steps[i].target && !cm.steps[i].target()) {
      i++;
    }
    if (i >= cm.steps.length) {
      this._endCoachmarks(true);
      return;
    }
    cm.i = i;
    const st = cm.steps[i];
    try {
      st.before && st.before();
    } catch (e) {
      /* a step's setup must never kill the walkthrough */
    }
    const tgt = st.target ? st.target() : null;
    if (tgt && tgt.scrollIntoView) {
      try {
        tgt.scrollIntoView({ block: "nearest" });
      } catch (e) {
        /* best-effort */
      }
    }

    const { ring, card, ov } = cm;
    const last = i === cm.steps.length - 1;

    // ---- card content
    card.textContent = "";
    card.appendChild(this._el("div", "zcm-cm-title", st.title));
    card.appendChild(this._el("div", "zcm-cm-body", st.body));
    const dots = this._el("div", "zcm-tour-dots");
    cm.steps.forEach((s, di) => {
      const d = this._el("span", "zcm-tour-dot");
      if (di === i) d.classList.add("is-on");
      dots.appendChild(d);
    });
    card.appendChild(dots);
    const foot = this._el("div", "zcm-cm-foot");
    const skip = this._btn(last ? "Close" : "Skip", { sm: true });
    skip.addEventListener("click", () => this._endCoachmarks(true));
    foot.appendChild(skip);
    if (st.guideLink) {
      const g = this._btn("Full guide", { sm: true });
      g.addEventListener("click", () => {
        this._endCoachmarks(true);
        this._showGuide();
      });
      foot.appendChild(g);
    }
    foot.appendChild(this._el("div", "zcm-spacer"));
    if (i > 0) {
      const back = this._btn("Back", { sm: true, variant: "secondary" });
      back.addEventListener("click", () => this._cmShow(this._cmPrev(i)));
      foot.appendChild(back);
    }
    const next = this._btn(last ? "Done" : "Next", { sm: true, variant: "primary" });
    next.addEventListener("click", () =>
      last ? this._endCoachmarks(true) : this._cmShow(i + 1)
    );
    foot.appendChild(next);
    card.appendChild(foot);

    // ---- spotlight + card position (relative to the view root)
    const rootRect = this.root.getBoundingClientRect();
    const r = tgt ? tgt.getBoundingClientRect() : null;
    // Treat a zero-size / off-screen target (e.g. layout not ready yet) as
    // "no target" so we never dim the whole view around an empty ring.
    const haveTarget =
      r && r.width > 4 && r.height > 4 && rootRect.width > 40;
    if (haveTarget) {
      const pad = 6;
      ov.classList.remove("zcm-cm-dim"); // the ring's shadow does the dimming
      ring.style.display = "block";
      ring.style.left = r.left - rootRect.left - pad + "px";
      ring.style.top = r.top - rootRect.top - pad + "px";
      ring.style.width = r.width + 2 * pad + "px";
      ring.style.height = r.height + 2 * pad + "px";
      const cw = card.offsetWidth || 280;
      const chh = card.offsetHeight || 150;
      let left = r.left - rootRect.left + r.width / 2 - cw / 2;
      left = Math.max(10, Math.min(left, rootRect.width - cw - 10));
      let top = r.bottom - rootRect.top + 16;
      if (top + chh > rootRect.height - 10) {
        top = r.top - rootRect.top - chh - 16; // flip above the target
      }
      top = Math.max(10, Math.min(top, Math.max(10, rootRect.height - chh - 10)));
      card.style.left = left + "px";
      card.style.top = top + "px";
      card.style.transform = "none";
    } else {
      ov.classList.add("zcm-cm-dim"); // uniform dim, centered card
      ring.style.display = "none";
      card.style.left = "50%";
      card.style.top = "50%";
      card.style.transform = "translate(-50%, -50%)";
    }
  }

  /** The previous step whose target still exists (for the Back button). */
  _cmPrev(i) {
    const cm = this._cm;
    let j = i - 1;
    while (j > 0 && cm.steps[j].target && !cm.steps[j].target()) j--;
    return Math.max(0, j);
  }

  _endCoachmarks(finished) {
    if (!this._cm) return;
    const { ov, onDone, onKey } = this._cm;
    if (onKey) this.doc.removeEventListener("keydown", onKey, true);
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    this._cm = null;
    if (finished && onDone) onDone();
  }

  /** After a walkthrough closes: deferred scope hint + collection advice. */
  _afterWalkthrough() {
    if (this._pendingScopeHint && !this._guide) {
      this._pendingScopeHint = false;
      this._playScopeHint();
    }
    this._maybeShowAdvice();
  }

  /**
   * First-run walkthrough (and the "?" map button): brief cards anchored to
   * the actual controls they explain. Steps without a live anchor (e.g.
   * Discover on an imported map) are skipped automatically.
   */
  _showTour() {
    if (this._guide) this._closeGuide();
    if (this._inspecting) this._select(null, false);
    const steps = [
      {
        title: "Your citation map",
        body:
          "Every dot is a paper: left → right is its year, higher means " +
          "more cited. Filled dots are yours, open rings are papers you " +
          "don't have yet.",
      },
      {
        target: () => this._layoutToggle,
        title: "Timeline or Network",
        body: "Network groups papers that cite each other into islands.",
      },
      {
        target: () => this.legend,
        title: "Follow the citations",
        body:
          "Hover or click a paper: blue lines lead to what it cites, pink " +
          "lines come from what cites it. Its details open in the sidebar.",
      },
      {
        target: () => this._tabsEl,
        before: () => {
          if (this._sidebarCollapsed) this._setSidebarCollapsed(false, false);
        },
        title: "The sidebar",
        body:
          "Suggested papers you may be missing, a live Discover search, " +
          "citation chains, and your own papers.",
      },
      {
        target: () => this._reviewBtn,
        title: "Refine the view",
        body:
          "Hide reviews, filter by year or tag, and change colors, sizes " +
          "and light / dark under Display.",
      },
      {
        target: () => this._mapControls,
        title: "Getting around",
        body:
          "Two fingers (or drag) move the map, pinch or scroll zooms. " +
          "Replay this tour with the ? button.",
        guideLink: true,
      },
    ];
    this._startCoachmarks(steps, () => this._afterWalkthrough());
  }

  // ============================================================= what's new

  /**
   * Per-release "what's new" registry. To add a walkthrough for a future
   * release, append ONE entry: { since: "<major.minor>", steps: [ …coachmark
   * steps… ] }. Order does not matter (entries are sorted by version). Each
   * step is the same shape the tour uses: { title, body, target?(), before?(),
   * guideLink? }. An upgrader is shown every entry whose `since` is newer than
   * their last-seen version and no newer than the current version, so people
   * who skip releases still catch up on everything they missed.
   */
  _whatsNewRegistry() {
    return [
      {
        since: "1.9",
        steps: [
          {
            target: () => this._tabsEl,
            before: () => this._setSideTab("suggested", false),
            title: "Suggested vs Discover",
            body:
              "Two separate tabs now. Suggested is worked out instantly " +
              "from your own papers' citations; Discover is a live web " +
              "search for papers beyond your library.",
          },
          {
            target: () => this._discoverCard,
            before: () => this._setSideTab("discover", false),
            title: "Discover new papers",
            body:
              "Search OpenAlex for papers that cite yours, share your " +
              "topics, or are related, with chips explaining every hit. " +
              "Only anonymous OpenAlex IDs are sent, never your text.",
          },
          {
            target: () => this._displayBtn,
            title: "Colours & coupling",
            body:
              "Colour dots by type (default), journal, year, cluster or " +
              "open access, and reveal dashed links between papers that " +
              "share references.",
          },
          {
            target: () => this._filterBtn,
            title: "Filters",
            body: "Dim papers outside a year range or a Zotero tag.",
          },
          {
            target: () => this._filterBtn,
            title: "Hide reviews",
            body:
              "Filter can also hide review / meta-analysis articles from " +
              "the map and fade them in the lists, to focus on primary " +
              "research.",
          },
          {
            target: () => this.status,
            title: "New since last build",
            body:
              "Rebuilding a collection marks newly added papers and " +
              "suggestions with a small green dot on the map and a New " +
              "badge in the lists.",
          },
        ],
      },
      {
        since: "1.10",
        steps: [
          {
            target: () => this._layoutToggle,
            title: "A Timeline that reads like a chart",
            body:
              "Left → right = publication year, higher = more cited (log " +
              "scale), so classics sit top-left and fresh work bottom-right. " +
              "It's the new default; Network is one click away, and the map " +
              "remembers your choice.",
          },
          {
            title: "Follow the citations",
            body:
              "Hover or click a paper: blue lines lead to what it cites, " +
              "pink lines come from what cites it. The paper's details list " +
              "both, click an entry to walk along the trail.",
          },
          {
            target: () => this.legend,
            title: "Suggestions are open rings",
            body:
              "Papers you don't own yet are drawn as open rings, your own " +
              "papers as filled dots, and labels no longer pile on top of " +
              "each other.",
          },
          {
            target: () => this._displayBtn,
            title: "Display, tidied up",
            body:
              "Spacing and line thickness moved in here, next to a choice " +
              "of what the Timeline's height measures.",
          },
          {
            target: () => this._moreBtn,
            title: "More",
            body:
              "Export and import live here now, plus an optional free " +
              "OpenAlex API key, which raises OpenAlex's daily budget for " +
              "you about tenfold.",
          },
        ],
      },
      {
        since: "2.0",
        steps: [
          {
            title: "A lighter, clearer Citation Map",
            body:
              "A new look that follows Zotero's light or dark color scheme. " +
              "Color now always means something: orange is suggestions, " +
              "violet is search results, teal is chains, blue is “cites” " +
              "and pink is “cited by”.",
          },
          {
            target: () => this._displayBtn,
            title: "Light, dark or automatic",
            body:
              "Display ▸ Appearance pins the map to Light or Dark, or lets " +
              "it follow Zotero (the default).",
          },
          {
            target: () => this._scopeBtn,
            title: "Collection and subfolders",
            body:
              "The mapped collection sits here. If it has subfolders, click " +
              "it to choose which are included (this used to be the " +
              "Subfolders button).",
          },
          {
            target: () => this._filterBtn,
            title: "Filters you can see",
            body:
              "Hide reviews is a toggle in the toolbar and also sits in " +
              "Filter, next to the year range and tags. Active filters " +
              "show as removable chips under the toolbar.",
          },
          {
            target: () => this.legend,
            title: "The legend moved under the map",
            body:
              "It never covers the chart, and it follows the color mode " +
              "you pick in Display.",
          },
          {
            target: () => this._tabsEl,
            before: () => {
              if (this._inspecting) this._select(null, false);
              if (this._sidebarCollapsed) this._setSidebarCollapsed(false, false);
            },
            title: "Details open in the sidebar",
            body:
              "Click a paper and its details replace the list here instead " +
              "of floating over the map; Back returns to the list. Hide or " +
              "show the sidebar from More, or press S.",
          },
          {
            target: () => this.status,
            title: "Shortcuts",
            body:
              "The Shortcuts button lists every key: T and N switch " +
              "layouts, arrow keys walk between papers, 1–4 switch tabs. " +
              "Double-clicking a paper now zooms to it and its links.",
          },
        ],
      },
      // Future releases: add { since: "<major.minor>", steps: [ … ] } here.
    ];
  }

  /**
   * One-time walkthrough for users upgrading from an older version, built
   * from _whatsNewRegistry() for exactly the features new since their last
   * version (fresh installs get the full tour instead).
   */
  _showWhatsNew() {
    const version = (ZCM_VIEW_NS && ZCM_VIEW_NS.version) || "";
    const fvSeen = this._featureVersion(this._prevSeenVersion || "");
    const fvNow = this._featureVersion(version);
    const steps = [];
    for (const entry of this._whatsNewRegistry().sort(
      (a, b) => this._featureVersion(a.since) - this._featureVersion(b.since)
    )) {
      const fv = this._featureVersion(entry.since);
      if (fv > fvSeen && fv <= fvNow) steps.push(...entry.steps);
    }
    if (!steps.length) {
      // nothing registered as new for this jump, just run the follow-ups
      this._afterWalkthrough();
      return;
    }
    steps.unshift({
      title: `What's new in ${version}`,
      body:
        "A quick lap around the new features. Click anywhere to advance, " +
        "or Skip.",
    });
    // the final step links to the full guide
    steps[steps.length - 1] = { ...steps[steps.length - 1], guideLink: true };
    this._startCoachmarks(steps, () => this._afterWalkthrough());
  }

  // ================================================================ notices

  /**
   * A dismissible notice stacked top-left on the map, for network health
   * ("warn": a yellow caution icon), collection advice ("advice": neutral)
   * and failures ("error": soft danger fill). Never modal, never blocks.
   * At most two are shown at once; an older non-error notice makes room.
   * Returns the notice element; `el._body` takes extra content (e.g. the
   * API-key form).
   */
  _showNotice(text, kind = "advice", title = null) {
    if (this._destroyed) return null;
    if (!this._notices) {
      this._notices = this._el("div", "zcm-notices");
      this.stage.appendChild(this._notices);
    }
    while (this._notices.childNodes.length >= 2) {
      const old =
        [...this._notices.childNodes].find(
          (el) => !el.classList.contains("zcm-notice--error")
        ) || this._notices.firstChild;
      this._notices.removeChild(old);
    }
    const variant = kind === "warn" ? "caution" : kind === "error" ? "error" : "info";
    const n = this._el("div", "zcm-notice zcm-notice--" + variant);
    n.setAttribute("role", variant === "error" ? "alert" : "status");
    n.appendChild(
      this._icon(variant === "caution" ? "warning" : variant === "error" ? "error" : "info")
    );
    const body = this._el("div", "zcm-notice-body");
    if (title) body.appendChild(this._el("span", "zcm-notice-title", title));
    body.appendChild(this._el("span", "zcm-notice-text", text));
    n.appendChild(body);
    n._body = body;
    n.appendChild(
      this._btn("Dismiss", {
        icon: "close",
        iconOnly: true,
        sm: true,
        onClick: () => {
          if (n.parentNode) n.parentNode.removeChild(n);
        },
      })
    );
    this._notices.appendChild(n);
    return n;
  }

  /**
   * Kind, one-time advice when the mapped selection can't produce a good
   * map yet, too few papers, no DOIs, or no internal citations, with a
   * concrete way to fix it.
   */
  _maybeShowAdvice() {
    if (this._adviceShown || this._destroyed) return;
    if (this.ctx && this.ctx.imported) return;
    this._adviceShown = true;
    const s = this.graph.stats;
    let msg = null;
    if (s.items < 5) {
      msg =
        `Only ${s.items} paper${s.items === 1 ? "" : "s"} here, citation ` +
        "maps start to shine at around 10+. Tip: map a parent collection, " +
        "include more subfolders (the collection button in the toolbar), or map the whole " +
        "library (no collection selected → Tools → Show Citation Map).";
    } else if (s.resolved === 0) {
      msg =
        "None of these papers could be matched on OpenAlex, usually that " +
        "means missing DOIs. Add each paper's DOI to its Zotero item " +
        "(publishers print it on the first page) and click Rebuild.";
    } else if (s.resolved < s.items / 2) {
      msg =
        `Citation data was found for only ${s.resolved} of ${s.items} ` +
        "papers, the grey dots are missing a DOI or aren't indexed by " +
        "OpenAlex. Adding DOIs in Zotero and clicking Rebuild usually " +
        "fixes most of them.";
    } else if (s.edges === 0) {
      msg =
        "Your papers don't cite each other (yet), so there are no arrows, " +
        "normal for a broad or young collection. Try the dashed coupling " +
        "links (Display) to see shared-reference siblings, or Discover to " +
        "find papers that connect them.";
    }
    if (msg) this._showNotice(msg, "advice");
  }

  // ================================================================= guide

  _showGuide() {
    if (this._guide) return;
    const ov = this._el("div", "zcm-guide-overlay");
    const g = this._el("div", "zcm-guide");
    g.setAttribute("role", "dialog");
    g.setAttribute("aria-label", "How to read this map");

    const head = this._el("div", "zcm-guide-head");
    head.appendChild(this._el("h2", "zcm-guide-title", "How to read this map"));
    head.appendChild(
      this._btn("Close", {
        icon: "close",
        iconOnly: true,
        title: "Close · Esc",
        onClick: () => this._closeGuide(),
      })
    );
    g.appendChild(head);

    const sec = (title, ...paras) => {
      g.appendChild(this._el("h3", "zcm-guide-h", title));
      for (const p of paras) g.appendChild(this._el("p", "zcm-guide-p", p));
    };

    if (this.ctx && this.ctx.subInfo && this.ctx.changeScope) {
      sec(
        "Subfolders",
        "This collection has subfolders. The collection button at the left " +
          "of the toolbar shows how many are included (the “+N” badge) and " +
          "lets you change the mix at any time: pick exactly the folders you " +
          "want and the map rebuilds. Your choice is remembered for this " +
          "collection."
      );
    }

    // legend with the real marks
    g.appendChild(this._el("h3", "zcm-guide-h", "The dots"));
    const legend = this._el("div", "zcm-guide-legend");
    for (const [markup, text] of [
      ['<circle class="m-lib" cx="6" cy="6" r="5"/>', "a paper in your library (filled)"],
      ['<circle class="m-sug" cx="6" cy="6" r="4.2"/>', "a suggested paper you don't have yet (orange ring)"],
      ['<circle class="m-disc" cx="6" cy="6" r="4.2"/>', "a paper the Discover search placed on the map (violet ring)"],
      ['<circle class="m-nodata" cx="6" cy="6" r="5"/>', "in your library, but no citation data (usually a missing DOI)"],
      ['<circle class="m-new" cx="6" cy="6" r="3.5"/>', "new since the last build of this collection"],
    ]) {
      legend.appendChild(this._legendKey(markup, text));
    }
    g.appendChild(legend);
    g.appendChild(
      this._el(
        "p",
        "zcm-guide-p",
        "Shape carries meaning: a filled dot is yours, an open ring is not " +
          "yet. The bigger a dot, the more often it is cited by the other " +
          "papers of this collection, the biggest dots are the foundations " +
          "of your reading list."
      )
    );

    sec(
      "The arrows",
      "An arrow points from the citing paper to the cited one, it always " +
        "points backwards in time, toward the foundations. Hover or click a " +
        "paper and its links light up: blue lines go to the papers it cites " +
        "(older work it builds on), pink lines come from the papers citing " +
        "it (newer work building on it). Everything else steps back."
    );
    sec(
      "Timeline (the default view)",
      "The Timeline reads like a chart: left to right is the publication " +
        "year (oldest on the left), and the higher a paper sits, the more " +
        "it is cited (worldwide, on a log scale; Display ▸ Height means " +
        "switches to citations from the papers on this map). So the " +
        "classics sit top-left and fresh work bottom-right. Each year is a " +
        "column; empty years are skipped (marked ⋯) so a busy stretch stays " +
        "readable. Papers without a year get an “Undated” column on the far " +
        "left, papers without citation data a strip under the axis."
    );
    sec(
      "Network: clusters and islands",
      "Papers connected by citations are grouped together, so a well-cited " +
        "hub sits in the middle of its group with the papers that cite it " +
        "arranged around the edge. Separate groups form their own islands, " +
        "each labelled with the topic its papers share, and papers with no " +
        "citation links at all gather in a labelled block off to the side."
    );
    sec(
      "Paper details",
      "Click a paper and its details open in the sidebar, in place of the " +
        "lists: its numbers, two buttons that frame its references or the " +
        "papers citing it on the map, its links as clickable lists, actions " +
        "(Show in library, Add to Zotero, Open DOI) and your Zotero notes. " +
        "Back returns to the list you came from; the arrows in the bar step " +
        "through that list."
    );
    sec(
      "Suggested (orange) and Discover (violet): the key difference",
      "Suggested is worked out instantly from your own papers' reference " +
        "lists (no web search, no waiting): the works several of your papers " +
        "already cite but you don't own (×N = cited by N of your papers). " +
        "The controls at the top of the tab set how suggestions appear on " +
        "the map, Off / Top (the strongest few) / All, and the strength " +
        "floor (cited by at least 2, 3 or 4 of your papers).",
      "Discover is a live search of OpenAlex for papers beyond your " +
        "library: papers that cite yours, papers on the same topics, and " +
        "related papers, optionally limited by time and topic. Every result " +
        "explains itself with badges. Add imports it into Zotero; the map " +
        "button places it on the map as a violet ring and takes it off " +
        "again. Privacy: only OpenAlex record and topic IDs are sent; the " +
        "key terms line is computed on your machine and never leaves it."
    );
    sec(
      "Colors",
      "By default dots are colored by type. Display can instead color by " +
        "Year (older → newer), Cluster (each citation island in its own " +
        "color), Open access (gold, green, hybrid, bronze, diamond, closed; " +
        "unknown is a dashed ring) or Journal (a rim in the publisher's " +
        "color, nudged so it stays visible on the current background). The " +
        "legend under the map always spells out the current colors; hover " +
        "an entry for its meaning.",
      "Each color has one meaning everywhere: orange is suggestions, violet " +
        "is search results, teal is chains, blue is “cites”, pink is “cited " +
        "by”, green marks what is new."
    );
    sec(
      "Filters",
      "Filter dims papers outside a year range or a chosen Zotero tag; the " +
        "layout stays put, so you can flip filters on and off freely. Hide " +
        "reviews takes review and meta-analysis articles off the map and " +
        "fades them (with a Review badge) in the lists. Active filters " +
        "appear as chips under the toolbar, each with its own remove button."
    );
    sec(
      "Coupling links (dashed)",
      "Two of your papers that share many references are “siblings”, even " +
        "when neither cites the other. Display can draw these " +
        "bibliographic-coupling links as a dashed layer, especially " +
        "revealing in young collections where direct citations are rare."
    );

    // chain mini-diagram
    g.appendChild(this._el("h3", "zcm-guide-h", "Citation chains (teal)"));
    const dia = this._el("div", "zcm-guide-chain");
    const mkDot = (num, year) => {
      const d = this._el("span", "zcm-guide-chain-dot");
      d.appendChild(this._el("span", "zcm-chain-num zcm-num", num));
      d.appendChild(this._el("span", "zcm-guide-chain-year zcm-num", year));
      return d;
    };
    dia.appendChild(mkDot("1", "1998"));
    dia.appendChild(this._el("span", "zcm-guide-chain-arrow", "← cites"));
    dia.appendChild(mkDot("2", "2007"));
    dia.appendChild(this._el("span", "zcm-guide-chain-arrow", "← cites"));
    dia.appendChild(mkDot("3", "2019"));
    g.appendChild(dia);
    g.appendChild(
      this._el(
        "p",
        "zcm-guide-p",
        "A chain is a paper trail through time: paper 2 cites paper 1, " +
          "paper 3 cites paper 2, the same thread of an idea, handed on. " +
          "Click a chain in the sidebar to light it up as a dashed teal " +
          "thread; the numbered discs run from the oldest paper (1) to the " +
          "newest, and the sidebar row lists every step."
      )
    );

    sec(
      "Appearance",
      "The map follows Zotero's light or dark color scheme by default. " +
        "Display ▸ Appearance (or Zotero's Settings ▸ Citation Map) pins it " +
        "to Light or Dark instead. Export PNG uses the current theme; More " +
        "also offers a light-background export for slides and print."
    );
    sec(
      "Getting around",
      "On a trackpad, slide two fingers to move the map and pinch to zoom; " +
        "with a mouse, scroll to zoom (toward the pointer) and drag the " +
        "background to pan. Display ▸ Scrolling changes what scrolling does · " +
        "in the Network, drag a dot to pin it (switching layouts releases " +
        "it) · click a dot for its details · double-click a dot to zoom to " +
        "it and its links · double-click the background (or press 0) to fit " +
        "everything back into view. The Shortcuts button in the status bar " +
        "lists every key."
    );
    sec(
      "Where the data comes from",
      "Reference lists come from OpenAlex, matched by each item's DOI, and " +
        "are cached locally, rebuilding a map is nearly instant. Items " +
        "without a DOI can't be linked: add the DOI to the item in Zotero " +
        "and click Rebuild."
    );

    ov.appendChild(g);
    ov.addEventListener("click", (ev) => {
      if (ev.target === ov) this._closeGuide();
    });
    this.root.appendChild(ov);
    this._guide = ov;
  }

  _closeGuide() {
    if (this._guide && this._guide.parentNode) {
      this._guide.parentNode.removeChild(this._guide);
    }
    this._guide = null;
    // The guide was covering the toolbar; now show the deferred scope nudge.
    if (this._pendingScopeHint) {
      this._pendingScopeHint = false;
      this._playScopeHint();
    }
  }

  // ========================================================= Zotero actions

  async _showInLibrary(node) {
    try {
      const pane = this.win.ZoteroPane || Zotero.getActiveZoteroPane();
      this.win.Zotero_Tabs.select("zotero-pane");
      await pane.selectItem(node.zoteroItemID);
    } catch (e) {
      Zotero.debug("[Citation Map] selectItem failed: " + e);
    }
  }

  /**
   * Import a discovered paper into the mapped collection via its DOI. The
   * button keeps its width: a spinner replaces the icon while adding, then
   * it reads "Added" with a check; on the map the ring fills in.
   */
  async _addDiscovered(node, button) {
    if (!button || button.disabled) return;
    button.disabled = true;
    this._setBtn(button, "Adding…", "spinner");
    const msg = this._detailMsg; // this inspector's message line, captured now
    if (msg) msg.style.display = "none";
    // the import takes a few seconds; the user may select another paper
    const stillShown = () =>
      !this._destroyed && this._inspectedNode && this._inspectedNode.key === node.key;
    try {
      const item = await this._importByDOI(node.doi, this.ctx.collectionID);
      node.kind = "library";
      node.zoteroItemID = item.id;
      node.teased = false;
      node.hidden = false;
      node.revealed = true;
      node._preview = false;
      this._activeNodes = null;
      this._activeEdges = null;
      this._setBtn(button, "Added", "check");
      this._announce("Added to Zotero");
      this._dirty = true;
      if (this._renderSuggestList) this._renderSuggestList();
      // after a moment, re-render the details so they show "Show in
      // library" and the notes
      this.win.setTimeout(() => {
        if (stillShown()) this._renderDetails(node);
      }, 1600);
    } catch (e) {
      Zotero.debug("[Citation Map] Add by DOI failed: " + e);
      button.disabled = false;
      this._setBtn(button, "Add to Zotero", "add");
      if (msg && stillShown()) {
        msg.textContent =
          "Couldn't add it automatically. Open its DOI, then add it in Zotero.";
        msg.style.display = "";
      }
    }
  }

  // ================================================================ export

  async _pickSavePath(suggested, extLabel, ext) {
    // filePicker.mjs is the Zotero 7+ module (ChromeUtils.import is gone)
    const { FilePicker } = ChromeUtils.importESModule(
      "chrome://zotero/content/modules/filePicker.mjs"
    );
    const fp = new FilePicker();
    fp.init(this.win, "Save " + extLabel, fp.modeSave);
    fp.appendFilter(extLabel, "*." + ext);
    fp.defaultString = suggested;
    const rv = await fp.show();
    if (rv !== fp.returnOK && rv !== fp.returnReplace) return null;
    return fp.file;
  }

  /** Run an export, turning any failure into a visible notice. */
  async _safeExport(fn) {
    try {
      await fn();
    } catch (e) {
      Zotero.debug("[Citation Map] export failed: " + e + "\n" + (e && e.stack));
      this._showNotice("Export failed: " + (e && e.message ? e.message : e), "warn");
    }
  }

  /**
   * Export the current view as a PNG. Uses the current theme; `light`
   * forces the light palette and background (for slides and print).
   */
  async _exportPNG({ light = false } = {}) {
    const path = await this._pickSavePath("citation-map.png", "PNG image", "png");
    if (!path) return;
    const MT = ZCM_VIEW_NS.MapTheme;
    const saved = this.T;
    const palette = light ? MT.MAP_THEME.light : this.T;
    let blob;
    try {
      this.T = palette;
      this._draw();
      // The map canvas is transparent (the stage paints the background), so
      // compose onto the palette's canvas colour.
      const out = this.doc.createElement("canvas");
      out.width = this.canvas.width;
      out.height = this.canvas.height;
      const o = out.getContext("2d");
      o.fillStyle = palette.canvas;
      o.fillRect(0, 0, out.width, out.height);
      o.drawImage(this.canvas, 0, 0);
      blob = await new Promise((res) => out.toBlob(res, "image/png"));
    } finally {
      this.T = saved;
      this._dirty = true; // redraw in the real theme
    }
    const buf = new Uint8Array(await blob.arrayBuffer());
    await IOUtils.write(path, buf);
  }

  async _exportJSON() {
    const path = await this._pickSavePath("citation-map.json", "JSON file", "json");
    if (!path) return;
    // A clean, stable node shape (drop volatile layout/interaction fields), so
    // the file round-trips cleanly through "Import Citation Map (JSON)".
    const data = {
      format: "zotero-citation-map",
      formatVersion: 2,
      generated: new Date().toISOString(),
      collection: this.ctx.collectionName,
      stats: this.graph.stats,
      nodes: this.graph.nodes.map((n) => ({
        key: n.key,
        kind: n.kind,
        title: n.title,
        year: n.year,
        authors: n.authors,
        venue: n.venue,
        doi: n.doi,
        zoteroItemID: n.zoteroItemID,
        citedByCount: n.citedByCount,
        inLibraryCitations: n.inLibraryCitations,
        topics: n.topics || [],
        oaStatus: n.oaStatus || null,
        via: n.via || null,
        citesCount: n.citesCount || 0,
        isReview: !!n.isReview,
      })),
      edges: this.graph.edges,
      chains: this.graph.chains,
      coupling: this.graph.coupling || [],
    };
    await IOUtils.writeUTF8(path, JSON.stringify(data, null, 2));
  }

  // =============================================================== teardown

  destroy() {
    this._destroyed = true;
    this._closePopover(); // drops the document-level outside-click listener
    this._endCoachmarks(false); // tears down any open walkthrough
    this._hideTooltip();
    if (this._scopeHintTimer) this.win.clearTimeout(this._scopeHintTimer);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._onWinResize) {
      this.win.removeEventListener("resize", this._onWinResize);
      this._onWinResize = null;
    }
    if (this._keyHandler) {
      this.doc.removeEventListener("keydown", this._keyHandler, true);
      this._keyHandler = null;
    }
    if (this._themeDispose) {
      this._themeDispose(); // stop following Zotero's colour scheme
      this._themeDispose = null;
    }
    if (this._themePrefObs) {
      try {
        Zotero.Prefs.unregisterObserver(this._themePrefObs);
      } catch (e) {
        /* best-effort */
      }
      this._themePrefObs = null;
    }
    this._live = null;
    if (this.root && this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
  }
};
