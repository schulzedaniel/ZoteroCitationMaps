/**
 * graphView.js, the interactive map itself.
 *
 * The view is plain DOM + <canvas>, injected directly into a Zotero tab
 * (no remote browser, no external libraries), so it has direct access to
 * the Zotero API for "select item" / "add by DOI" actions.
 *
 * Structure:
 *   ┌ toolbar ──────────────────────────────────────────────┐
 *   │ search · layout toggle · legend · export · rebuild    │
 *   ├───────────────────────────────┬───────────────────────┤
 *   │                               │ sidebar               │
 *   │        <canvas> map           │  · paper details      │
 *   │                               │  · discovered papers  │
 *   │  (year rail in timeline mode) │  · citation chains    │
 *   └───────────────────────────────┴───────────────────────┘
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

    this.mode = "force"; // "force" | "timeline"
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

    this._prepare();
    this._buildDOM();
    this._initSimulation();
    // Settle the layout off-screen so the map appears already calm and
    // then stays still, no multi-second live "wobble" every time.
    this._preSettle();
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
      n.r = Math.min(24, 8 + Math.sqrt(n.inLibraryCitations) * 4.2);
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
    for (const n of nodes) parent.set(n.key, n.key);
    for (const e of this.graph.edges) {
      if (!parent.has(e.source) || !parent.has(e.target)) continue;
      const ra = find(e.source);
      const rb = find(e.target);
      if (ra !== rb) parent.set(ra, rb);
    }
    const groups = new Map();
    for (const n of nodes) {
      const r = find(n.key);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(n);
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
    const gap = 18 * ls; // breathing room between islands (tightened so many
    // small islands don't spread the map into a field of tiny specks)
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
      this._activeEdges = this.graph.edges.filter((e) => {
        const s = this.nodeByKey.get(e.source);
        const t = this.nodeByKey.get(e.target);
        return s && t && !this._hiddenFromMap(s) && !this._hiddenFromMap(t);
      });
    }
    return { nodes: this._activeNodes, edges: this._activeEdges };
  }

  /** The toolbar "hide reviews" toggle: map + all sidebar lists. */
  _setHideReviews(val) {
    this.hideReviews = !!val;
    try {
      Zotero.Prefs.set("extensions.citation-map.hideReviews", this.hideReviews, true);
    } catch (e) {
      /* best-effort */
    }
    this._syncReviewBtn();
    this._applyReviewVisibility();
  }

  _syncReviewBtn() {
    const b = this._reviewBtn;
    if (!b) return;
    b.textContent = this.hideReviews ? "Reviews hidden" : "Hide reviews";
    b.classList.toggle("zcm-on", this.hideReviews);
    b.setAttribute(
      "title",
      this.hideReviews
        ? "Reviews are hidden from the map and greyed out in the lists. Click to restore them."
        : "Hide review / meta-analysis articles from the map, and grey them out in the Suggested, Discover and My papers lists."
    );
  }

  /**
   * Apply the review state. Map: reviews drop out of drawing/forces. Lists:
   * reviews are de-emphasised (greyed + italic) via a SINGLE class on the
   * sidebar rather than re-rendering each list, which is what made it
   * unreliable. Review rows carry `.zcm-is-review`; the class toggles the look.
   */
  _applyReviewVisibility() {
    this._activeNodes = null;
    this._activeEdges = null;
    if (this.mode === "timeline") this._computeTimelineLayout();
    this.alpha = Math.max(this.alpha || 0, 0.25);
    this._dirty = true;
    this._applyReviewDim();
  }

  /** Toggle the greyed/italic look for review rows across every sidebar list. */
  _applyReviewDim() {
    if (this._sideEl) {
      this._sideEl.classList.toggle("zcm-hide-reviews", this.hideReviews);
    }
    if (this._papersReviewCb) this._papersReviewCb.checked = this.hideReviews;
  }

  /** A small "review" label chip for lists and the details card. */
  _reviewChip() {
    const c = this._el("span", "zcm-review-chip", "review");
    c.setAttribute(
      "title",
      "Review / secondary-literature article (e.g. systematic review or meta-analysis)"
    );
    return c;
  }

  _setSuggestDisplay(val) {
    this.suggestDisplay = val;
    try {
      Zotero.Prefs.set("extensions.citation-map.suggestDisplay", val, true);
    } catch (e) {
      /* best-effort */
    }
    for (const [v, b] of Object.entries(this._suggBtns || {})) {
      b.classList.toggle("zcm-on", v === val);
    }
    // a new toggle state is a fresh look, drop one-off reveals (papers the
    // Discover search placed on the map stay put)
    for (const n of this.graph.nodes) {
      if (!n._injected) n.revealed = false;
    }
    this._applySuggestionVisibility();
  }

  // ============================================================ scale sliders

  /** Compact labelled range slider for the toolbar. */
  _buildSlider(label, tip, min, max, value, onInput) {
    const wrap = this._el("div", "zcm-ctl");
    wrap.appendChild(this._el("span", "zcm-ctl-label", label));
    const input = this._el("input", "zcm-slider");
    input.setAttribute("type", "range");
    input.setAttribute("min", String(min));
    input.setAttribute("max", String(max));
    input.setAttribute("title", tip);
    input.value = String(value);
    input.addEventListener("input", () => onInput(parseInt(input.value, 10)));
    // double-click the slider to snap back to 100 %
    input.addEventListener("dblclick", () => {
      input.value = "100";
      onInput(100);
    });
    wrap.appendChild(input);
    return wrap;
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
   * Small popover panel anchored under a toolbar button. Only one popover
   * is open at a time; clicking outside closes it.
   */
  _popover(button, buildContent) {
    const open = () => {
      if (this._openPopover) {
        const wasThis = this._openPopover._forBtn === button;
        this._closePopover();
        if (wasThis) return;
      }
      const panel = this._el("div", "zcm-popover");
      panel._forBtn = button;
      buildContent(panel);
      this.root.appendChild(panel);
      const rootRect = this.root.getBoundingClientRect();
      const btnRect = button.getBoundingClientRect();
      panel.style.top = btnRect.bottom - rootRect.top + 6 + "px";
      panel.style.left =
        Math.max(
          8,
          Math.min(
            btnRect.left - rootRect.left,
            rootRect.width - panel.offsetWidth - 12
          )
        ) + "px";
      this._openPopover = panel;
      this._popoverCloser = (ev) => {
        if (!panel.contains(ev.target) && ev.target !== button) {
          this._closePopover();
        }
      };
      this.doc.addEventListener("mousedown", this._popoverCloser, true);
    };
    button.addEventListener("click", open);
  }

  _closePopover() {
    if (this._popoverCloser) {
      this.doc.removeEventListener("mousedown", this._popoverCloser, true);
      this._popoverCloser = null;
    }
    if (this._openPopover && this._openPopover.parentNode) {
      this._openPopover.parentNode.removeChild(this._openPopover);
    }
    this._openPopover = null;
  }

  /** Toolbar "Display" button: color modes + bibliographic coupling. */
  /** A small at-a-glance preview of what a color mode does (for Display). */
  _modeSwatch(mode) {
    const sw = this._el("div", "zcm-pop-swatch");
    const dot = (color, cls) => {
      const d = this._el("span", "zcm-dot" + (cls ? " " + cls : ""));
      if (color) d.style.background = color;
      return d;
    };
    if (mode === "kind") {
      sw.appendChild(dot(null, "zcm-dot-library"));
      sw.appendChild(dot(null, "zcm-dot-discovered"));
      sw.appendChild(dot(null, "zcm-dot-unresolved"));
    } else if (mode === "publisher") {
      const d = dot(null, "zcm-dot-library");
      d.style.boxShadow = "0 0 0 2px #7fb3f5"; // a journal-brand rim
      sw.appendChild(d);
    } else if (mode === "year") {
      const grad = this._el("span", "zcm-legend-grad");
      grad.style.width = "42px";
      sw.appendChild(grad);
    } else if (mode === "cluster") {
      const pal = this.constructor.CLUSTER_PALETTE;
      for (let i = 0; i < 3; i++) sw.appendChild(dot(pal[i]));
    } else if (mode === "oa") {
      const oa = this.constructor.OA_COLORS;
      sw.appendChild(dot(oa.gold));
      sw.appendChild(dot(oa.green));
      sw.appendChild(dot(oa.closed));
    }
    return sw;
  }

  _buildDisplayControl() {
    const btn = this._el("button", "zcm-btn", "Display");
    btn.setAttribute(
      "title",
      "What the colors encode, and the coupling-links overlay"
    );
    this._displayBtn = btn;
    this._popover(btn, (panel) => {
      panel.appendChild(this._el("div", "zcm-pop-head", "Color the dots by"));
      panel.appendChild(
        this._el(
          "div",
          "zcm-pop-sub",
          "Changes how the map LOOKS, not which papers are on it."
        )
      );
      const modes = [
        [
          "kind",
          "By type",
          "The neutral default, library, suggested and no-data in distinct colors; no journal coloring",
        ],
        [
          "publisher",
          "By journal",
          "A rim in each journal's brand color (e.g. IEEE blue, Lancet red)",
        ],
        ["year", "By year", "Publication year: blue (older) → warm (recent)"],
        ["cluster", "By cluster", "Each citation cluster (island) gets its own color"],
        [
          "oa",
          "By access",
          "Open-access status: gold, green, hybrid, bronze, closed",
        ],
      ];
      const wrap = this._el("div", "zcm-pop-modelist");
      const btns = {};
      for (const [val, label, tip] of modes) {
        const b = this._el("button", "zcm-pop-mode");
        b.setAttribute("title", tip);
        b.appendChild(this._modeSwatch(val)); // self-explanatory preview
        b.appendChild(this._el("span", "zcm-pop-mode-label", label));
        if (val === this.colorMode) b.classList.add("zcm-on");
        b.addEventListener("click", () => {
          this.colorMode = val;
          try {
            Zotero.Prefs.set("extensions.citation-map.colorMode", val, true);
          } catch (e) {
            /* best-effort */
          }
          for (const [v, bb] of Object.entries(btns)) {
            bb.classList.toggle("zcm-on", v === val);
          }
          this._renderLegend();
          this._dirty = true;
        });
        btns[val] = b;
        wrap.appendChild(b);
      }
      panel.appendChild(wrap);

      panel.appendChild(this._el("div", "zcm-pop-head", "Coupling links"));
      panel.appendChild(
        this._el(
          "div",
          "zcm-pop-sub",
          "Dashed links between two of your papers that share many " +
            "references, “siblings” even when neither cites the other."
        )
      );
      const row = this._el("div", "zcm-pop-row");
      const cb = this._el("input");
      cb.setAttribute("type", "checkbox");
      cb.checked = this.showCoupling;
      cb.addEventListener("change", () => {
        this.showCoupling = cb.checked;
        try {
          Zotero.Prefs.set(
            "extensions.citation-map.showCoupling",
            cb.checked,
            true
          );
        } catch (e) {
          /* best-effort */
        }
        this._dirty = true;
      });
      const lab = this._el("label", "zcm-pop-label");
      lab.appendChild(cb);
      lab.appendChild(this._el("span", null, "Show coupling links"));
      row.appendChild(lab);
      const strength = this._el("div", "zcm-chips");
      for (const v of [2, 3, 5]) {
        const chip = this._el("button", "zcm-chip", `${v}+ shared`);
        if (v === this.couplingMin) chip.classList.add("zcm-on");
        chip.setAttribute(
          "title",
          `Link papers sharing at least ${v} references`
        );
        chip.addEventListener("click", () => {
          this.couplingMin = v;
          try {
            Zotero.Prefs.set(
              "extensions.citation-map.couplingMinShared",
              v,
              true
            );
          } catch (e) {
            /* best-effort */
          }
          for (const c of strength.children) {
            c.classList.toggle("zcm-on", c === chip);
          }
          this._dirty = true;
        });
        strength.appendChild(chip);
      }
      row.appendChild(strength);
      panel.appendChild(row);
    });
    return btn;
  }

  /** Toolbar "Filter" button: year range + Zotero tag (dims non-matching). */
  _buildFilterControl() {
    const btn = this._el("button", "zcm-btn", "Filter");
    btn.setAttribute("title", "Dim papers outside a year range or tag");
    this._filterBtn = btn;
    const refreshBtn = () => {
      const active =
        this.filterYearFrom != null ||
        this.filterYearTo != null ||
        this.filterTag != null;
      btn.classList.toggle("zcm-btn-active", active);
      btn.textContent = active ? "Filter ●" : "Filter";
    };
    this._popover(btn, (panel) => {
      panel.appendChild(this._el("div", "zcm-pop-head", "Filter the map"));
      panel.appendChild(
        this._el(
          "div",
          "zcm-pop-sub",
          "Greys out (dims) papers that don't match, nothing is removed, and " +
            "the layout stays put, so you can flip filters on and off freely."
        )
      );
      panel.appendChild(this._el("div", "zcm-pop-head", "Published year"));
      const yr = this._el("div", "zcm-pop-yearrow");
      const mkYear = (labelText, ph, val, set) => {
        const field = this._el("label", "zcm-pop-yearfield");
        field.appendChild(this._el("span", "zcm-pop-yearlabel", labelText));
        const inp = this._el("input", "zcm-pop-year");
        inp.setAttribute("type", "number");
        inp.setAttribute("min", "1000");
        inp.setAttribute("placeholder", ph);
        if (val != null) inp.value = String(val);
        inp.addEventListener("input", () => {
          const v = parseInt(inp.value, 10);
          set(Number.isFinite(v) && v > 1000 ? v : null);
          refreshBtn();
          this._dirty = true;
        });
        field.appendChild(inp);
        return field;
      };
      yr.appendChild(
        mkYear("From", String(this.yearMin), this.filterYearFrom, (v) => {
          this.filterYearFrom = v;
        })
      );
      yr.appendChild(this._el("span", "zcm-pop-dash", "–"));
      yr.appendChild(
        mkYear("To", String(this.yearMax), this.filterYearTo, (v) => {
          this.filterYearTo = v;
        })
      );
      panel.appendChild(yr);

      panel.appendChild(this._el("div", "zcm-pop-head", "Zotero tag"));
      // A DOM list (NOT a native <select>): a native dropdown's option clicks
      // land outside the popover DOM and trip its click-outside-to-close
      // handler, which cancelled the selection — the "tag filter doesn't work"
      // bug. A plain list keeps every click inside the panel.
      const tagList = this._el("div", "zcm-filter-taglist");
      // keep the list usable even if the stylesheet is stale
      Object.assign(tagList.style, { maxHeight: "180px", overflowY: "auto" });
      const tagCounts = this._collectTags();
      const rows = [];
      const mkTagRow = (label, value) => {
        const row = this._el("button", "zcm-filter-tagrow", label);
        if ((this.filterTag || "") === value) row.classList.add("zcm-on");
        row.addEventListener("click", () => {
          this.filterTag = value || null;
          this._tagKeys = null; // recompute the matching-node cache
          for (const r of rows) r.classList.toggle("zcm-on", r === row);
          refreshBtn();
          this._dirty = true;
        });
        rows.push(row);
        tagList.appendChild(row);
      };
      mkTagRow("All tags", "");
      for (const [tag, count] of tagCounts) mkTagRow(`${tag} (${count})`, tag);
      if (!tagCounts.length) {
        tagList.appendChild(
          this._el("div", "zcm-empty", "No tags on the papers in this map.")
        );
      }
      panel.appendChild(tagList);

      const clear = this._el("button", "zcm-btn zcm-filter-clear", "Clear filters");
      clear.addEventListener("click", () => {
        this.filterYearFrom = null;
        this.filterYearTo = null;
        this.filterTag = null;
        this._tagKeys = null;
        for (const r of rows) r.classList.toggle("zcm-on", r === rows[0]);
        refreshBtn();
        this._dirty = true;
        this._closePopover();
      });
      panel.appendChild(clear);
    });
    refreshBtn();
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

  /** Distinguishable island colors for the "cluster" mode. */
  static get CLUSTER_PALETTE() {
    return [
      "#7fb3f5",
      "#f0a63f",
      "#6fd9a6",
      "#e58fb1",
      "#c9a0f0",
      "#f2e18a",
      "#7adfe0",
      "#f09a72",
      "#a9c97f",
      "#95a5e8",
      "#e0b7d2",
      "#8fd0b2",
    ];
  }

  static get OA_COLORS() {
    return {
      diamond: "#7adfe0",
      gold: "#f2c14e",
      green: "#6fd9a6",
      hybrid: "#c9a0f0",
      bronze: "#cf9a6b",
      open: "#6fd9a6",
      closed: "#66708c",
    };
  }

  /** The fill color for a node under the active color mode. */
  _nodeFill(n, colors) {
    switch (this.colorMode) {
      case "kind":
        // neutral default, library / suggested / no-data by colour, and
        // (unlike publisher mode) no journal-coloured rim
        return colors[n.kind] || colors.library;
      case "year": {
        if (!n.year) return colors.unresolved;
        const span = Math.max(1, this.yearMax - this.yearMin);
        const t = Math.max(0, Math.min(1, (n.year - this.yearMin) / span));
        // blue (old) → warm amber (recent); lightness kept map-friendly
        return `hsl(${Math.round(215 - 170 * t)}, 70%, ${58 + 8 * t}%)`;
      }
      case "cluster": {
        const pal = this.constructor.CLUSTER_PALETTE;
        if (n._cluster == null || n._cluster < 0) return colors.unresolved;
        return pal[n._cluster % pal.length];
      }
      case "oa": {
        const map = this.constructor.OA_COLORS;
        return (n.oaStatus && map[n.oaStatus]) || colors.unresolved;
      }
      default:
        return colors[n.kind] || colors.library;
    }
  }

  /**
   * Legend content matching the active color mode. Every entry carries a
   * plain-language tooltip (hover), and the legend itself names the mode;
   * so nothing (e.g. the open-access colors) is left unexplained.
   */
  _renderLegend() {
    const legend = this.legend;
    if (!legend) return;
    legend.textContent = "";
    // `color` sets an inline swatch; `cls` uses a themed swatch class instead.
    const item = (color, label, cls, tip) => {
      const li = this._el("span", "zcm-legend-item");
      if (tip) li.setAttribute("title", tip);
      const dot = this._el("span", "zcm-dot" + (cls ? " " + cls : ""));
      if (color) dot.style.background = color;
      li.appendChild(dot);
      li.appendChild(this._el("span", null, label));
      legend.appendChild(li);
    };
    const violet = this._css("--zcm-violet") || "#8b7ff0";
    const kindItems = () => {
      item(
        null,
        "In your library",
        "zcm-dot-library",
        "A paper that is in your Zotero library / this collection."
      );
      item(
        null,
        "Suggested",
        "zcm-dot-discovered",
        "A paper NOT in your library that several of your papers cite " +
          "(amber halo). Worth a look, see the Suggested tab."
      );
      // Discover-found papers are drawn with a violet halo (see _draw).
      item(
        violet,
        "Found by search",
        null,
        "A paper the Discover tab's live web search placed on the map " +
          "(violet halo). Use “Remove from map” to take it off again."
      );
      item(
        null,
        "No citation data",
        "zcm-dot-unresolved",
        "In your library, but OpenAlex has no reference data for it, usually a " +
          "missing DOI. Add the DOI in Zotero and Rebuild."
      );
    };

    if (this.colorMode === "year") {
      legend.setAttribute("title", "Dot color = publication year (older → newer)");
      const old = this._el("span", null, String(this.yearMin));
      old.setAttribute("title", "Oldest paper (blue)");
      const grad = this._el("span", "zcm-legend-grad");
      grad.setAttribute("title", "Blue = older · green = middle · amber = recent");
      const rec = this._el("span", null, String(this.yearMax));
      rec.setAttribute("title", "Newest paper (amber)");
      legend.appendChild(old);
      legend.appendChild(grad);
      legend.appendChild(rec);
    } else if (this.colorMode === "cluster") {
      legend.setAttribute(
        "title",
        "Dot color = which citation cluster (island) a paper belongs to"
      );
      const pal = this.constructor.CLUSTER_PALETTE;
      for (let i = 0; i < 4; i++) {
        item(pal[i], "", null, "One color per connected citation cluster");
      }
      const lbl = this._el("span", null, "one color per cluster");
      legend.appendChild(lbl);
    } else if (this.colorMode === "oa") {
      legend.setAttribute("title", "Dot color = open-access status (from OpenAlex)");
      const oa = this.constructor.OA_COLORS;
      item(oa.gold, "Gold", null, "Gold OA, published open access in an OA journal.");
      item(oa.green, "Green", null, "Green OA, a free copy in a repository/preprint server.");
      item(
        oa.hybrid,
        "Hybrid",
        null,
        "Hybrid, an open-access article inside an otherwise subscription journal."
      );
      item(
        oa.bronze,
        "Bronze",
        null,
        "Bronze, free to read on the publisher's site, but with no open license."
      );
      item(oa.closed, "Closed", null, "Closed, paywalled; no free version found.");
    } else if (this.colorMode === "publisher") {
      legend.setAttribute(
        "title",
        "Dot fill = paper type; dot RIM = the journal's brand color (color by journal)"
      );
      kindItems();
      item(
        "#9aa4c2",
        "journal rim",
        null,
        "Recognised journals get a rim in the publisher's brand color (e.g. IEEE blue, Lancet red)."
      );
    } else {
      // "kind", the neutral default
      legend.setAttribute("title", "Dot color = paper type (the neutral default)");
      kindItems();
    }
  }

  // ===================================================== subcollection scope

  /** Toolbar control showing / changing which subcollections are mapped. */
  _buildScopeControl() {
    const wrap = this._el("div", "zcm-ctl zcm-scope-ctl");
    wrap.appendChild(this._el("span", "zcm-ctl-label", "Subfolders"));
    const btn = this._el("button", "zcm-btn zcm-scope-btn", this._scopeLabel());
    btn.setAttribute(
      "title",
      "Choose which subcollections are included in this map"
    );
    btn.addEventListener("click", () => {
      this._dismissScopeHint();
      if (this.ctx.changeScope) this.ctx.changeScope();
    });
    wrap.appendChild(btn);
    this._scopeCtl = wrap;
    this._scopeBtn = btn;
    return wrap;
  }

  _scopeLabel() {
    const s = this.ctx && this.ctx.subInfo;
    if (!s) return "All";
    if (s.mode === "all") return `All (${s.total})`;
    if (!s.included) return "This only";
    return `${s.included} / ${s.total}`;
  }

  /**
   * One-time nudge, right after the initial subcollection prompt, so the user
   * learns where the choice can be changed later: the toolbar control pulses
   * and a small callout points at it, both clearing after a few seconds or on
   * the first interaction.
   */
  _playScopeHint() {
    if (!this._scopeCtl || this._destroyed) return;
    this._scopeCtl.classList.add("zcm-scope-pulse");
    const callout = this._el(
      "div",
      "zcm-scope-callout",
      "Change which subcollections are mapped here anytime."
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

  /**
   * Apply the STRUCTURAL layout as inline styles, so the view lays out
   * correctly even if the external stylesheet fails to load, is cached
   * stale, or a parse error drops rules. graph.css still handles all colour
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
    set(els.bar, {
      display: "flex",
      alignItems: "center",
      flexWrap: "wrap",
      flex: "0 0 auto",
      maxHeight: "45%",
      overflowY: "auto",
    });
    set(els.main, {
      display: "flex",
      flex: "1 1 auto",
      minHeight: "180px",
      overflow: "hidden",
    });
    set(els.stage, {
      position: "relative",
      flex: "1 1 auto",
      minWidth: "0",
      minHeight: "0", // kill the content-based min so the canvas can't grow it
      overflow: "hidden",
    });
    const w = this._sidebarWidth();
    set(els.side, {
      flex: "0 0 " + w + "px",
      // the sidebar itself does NOT scroll; its inner wrapper does, so the
      // tabs row stays pinned at the top
      flexDirection: "column",
      overflow: "hidden",
      display: this._sidebarCollapsed ? "none" : "flex",
    });
    if (els.resizer) {
      set(els.resizer, { display: this._sidebarCollapsed ? "none" : "block" });
    }
    set(els.status, { flex: "0 0 auto" });
  }

  /** Remembered sidebar width, clamped to a sane range. */
  _sidebarWidth() {
    const raw = parseInt(
      Zotero.Prefs.get("extensions.citation-map.sidebarWidth", true),
      10
    );
    const w = Number.isFinite(raw) ? raw : 320;
    return Math.max(240, Math.min(620, w));
  }

  /**
   * The drag-divider between the map and the sidebar: drag to resize (width
   * persisted), and a chevron to collapse the sidebar entirely.
   */
  _buildSidebarResizer() {
    const bar = this._el("div", "zcm-side-resizer");
    bar.setAttribute("title", "Drag to resize the sidebar");
    const grip = this._el("div", "zcm-side-grip");
    bar.appendChild(grip);
    const chevron = this._el("button", "zcm-side-collapse", "›");
    chevron.setAttribute("title", "Hide the sidebar");
    chevron.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._setSidebarCollapsed(true);
    });
    bar.appendChild(chevron);

    let startX = 0;
    let startW = 0;
    let dragging = false;
    const onMove = (ev) => {
      if (!dragging) return;
      // sidebar is to the RIGHT of the divider, so dragging left widens it
      const dx = startX - ev.clientX;
      const next = Math.max(240, Math.min(this._sidebarMax(), startW + dx));
      if (this._sideEl) this._sideEl.style.flex = "0 0 " + Math.round(next) + "px";
      this._layout();
      this._dirty = true;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      this.doc.removeEventListener("mousemove", onMove, true);
      this.doc.removeEventListener("mouseup", onUp, true);
      try {
        const w = this._sideEl
          ? parseInt(this._sideEl.style.flex.replace(/[^0-9]/g, ""), 10)
          : null;
        if (w) Zotero.Prefs.set("extensions.citation-map.sidebarWidth", w, true);
      } catch (e) {
        /* best-effort */
      }
    };
    bar.addEventListener("mousedown", (ev) => {
      if (ev.target === chevron) return; // let the chevron click through
      dragging = true;
      startX = ev.clientX;
      startW = this._sideEl
        ? this._sideEl.getBoundingClientRect().width
        : this._sidebarWidth();
      this.doc.addEventListener("mousemove", onMove, true);
      this.doc.addEventListener("mouseup", onUp, true);
      ev.preventDefault();
    });
    return bar;
  }

  /** Largest sidebar width allowed right now (never more than ~55% of the tab). */
  _sidebarMax() {
    let containerW = 900;
    try {
      containerW = this.container.getBoundingClientRect().width || 900;
    } catch (e) {
      /* default */
    }
    return Math.max(280, Math.min(620, Math.round(containerW * 0.55)));
  }

  /** Show/hide the whole sidebar; remembered across sessions. */
  _setSidebarCollapsed(collapsed) {
    this._sidebarCollapsed = collapsed;
    try {
      Zotero.Prefs.set(
        "extensions.citation-map.sidebarCollapsed",
        collapsed,
        true
      );
    } catch (e) {
      /* best-effort */
    }
    if (this._sideEl) {
      this._sideEl.style.display = collapsed ? "none" : "flex";
      if (!collapsed) this._sideEl.style.flex = "0 0 " + this._sidebarWidth() + "px";
    }
    if (this._resizerEl) {
      this._resizerEl.style.display = collapsed ? "none" : "block";
    }
    if (this._reopenEl) this._reopenEl.style.display = collapsed ? "flex" : "none";
    this._layout();
    this._dirty = true;
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

  _buildDOM() {
    const root = this._el("div", "zcm-root");
    this.root = root;

    // ---- toolbar
    const bar = this._el("div", "zcm-toolbar");
    const title = this._el("div", "zcm-title");
    title.appendChild(this._el("span", "zcm-title-name", "Citation Map"));
    title.appendChild(
      this._el("span", "zcm-title-coll", this.ctx.collectionName)
    );
    bar.appendChild(title);

    this.search = this._el("input", "zcm-search");
    this.search.setAttribute("placeholder", "Search title or author…");
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this._dirty = true;
    });
    bar.appendChild(this.search);

    // layout toggle
    const toggle = this._el("div", "zcm-toggle");
    this.btnForce = this._el("button", "zcm-toggle-btn zcm-on", "Network");
    this.btnTime = this._el("button", "zcm-toggle-btn", "Timeline");
    this.btnForce.addEventListener("click", () => this._setMode("force"));
    this.btnTime.addEventListener("click", () => this._setMode("timeline"));
    toggle.appendChild(this.btnForce);
    toggle.appendChild(this.btnTime);
    bar.appendChild(toggle);

    // Prominent "hide review articles" toggle: affects the map AND every
    // sidebar list (Suggested, Discover, My papers).
    this._reviewBtn = this._el("button", "zcm-btn zcm-review-toggle");
    this._reviewBtn.addEventListener("click", () =>
      this._setHideReviews(!this.hideReviews)
    );
    this._syncReviewBtn();
    bar.appendChild(this._reviewBtn);

    // (The suggested-papers Off/Top/All control now lives in the Suggested
    // sidebar tab, next to the ×N strength filter, one place, not two.)

    // scale sliders: distance between papers, thickness of citation lines
    bar.appendChild(
      this._buildSlider(
        "Spacing",
        "Distance between papers (double-click to reset)",
        75,
        250,
        this.spacingPct,
        (v) => this._setSpacing(v)
      )
    );
    bar.appendChild(
      this._buildSlider(
        "Lines",
        "Thickness of the citation lines (double-click to reset)",
        40,
        300,
        this.edgeWidthPct,
        (v) => this._setEdgeWidth(v)
      )
    );

    // Display popover (what the colors mean, coupling links) and
    // Filter popover (year range, Zotero tag)
    bar.appendChild(this._buildDisplayControl());
    bar.appendChild(this._buildFilterControl());

    // subcollection scope (only when a collection with subfolders is mapped)
    if (this.ctx && this.ctx.subInfo && this.ctx.changeScope) {
      bar.appendChild(this._buildScopeControl());
    }

    const spacer = this._el("div", "zcm-spacer");
    bar.appendChild(spacer);

    // legend, adapts to the active color mode
    this.legend = this._el("div", "zcm-legend");
    this._renderLegend();
    bar.appendChild(this.legend);

    const barButtons = [
      ["Export PNG", () => this._exportPNG(), "Save the map as an image"],
      ["Export JSON", () => this._exportJSON(), "Save nodes and edges as JSON"],
    ];
    if (this.ctx && this.ctx.importJSON) {
      barButtons.push([
        "Import JSON",
        () => this.ctx.importJSON(),
        "Open a previously exported map (JSON) in a new tab",
      ]);
    }
    barButtons.push([
      "Rebuild",
      () => this.ctx.rebuild(),
      "Re-fetch citation data and redraw",
    ]);
    for (const [label, fn, titleTip] of barButtons) {
      const b = this._el("button", "zcm-btn", label);
      b.setAttribute("title", titleTip);
      b.addEventListener("click", fn);
      bar.appendChild(b);
    }
    root.appendChild(bar);

    // ---- main area
    const main = this._el("div", "zcm-main");
    const stage = this._el("div", "zcm-stage");
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
    stage.appendChild(this.canvas);
    this.tooltip = this._el("div", "zcm-tooltip");
    stage.appendChild(this.tooltip);

    // floating map controls (top-right corner of the canvas)
    const controls = this._el("div", "zcm-map-controls");
    for (const [label, tip, fn] of [
      ["+", "Zoom in", () => this._zoomBy(1.3)],
      ["−", "Zoom out", () => this._zoomBy(1 / 1.3)],
      ["⌂", "Fit the whole map into view", () => this._fitView(true)],
      ["?", "Quick tour (with a link to the full guide)", () => this._showTour()],
    ]) {
      const b = this._el("button", "zcm-map-btn", label);
      b.setAttribute("title", tip);
      b.addEventListener("click", fn);
      controls.appendChild(b);
    }
    stage.appendChild(controls);
    this._mapControls = controls; // coachmark anchor

    // Floating paper-details card over the map. Selecting a paper fills and
    // shows it; it never shifts the sidebar list. Hidden until a selection.
    // NOTE: _buildDetailCard sets this.details (the padded inner BODY that
    // _renderDetails writes into) and this._detailCard (the whole card). Do
    // NOT overwrite this.details with the returned card — that made
    // _renderDetails clear the card's header + close button + padding.
    const detailCard = this._buildDetailCard();
    stage.appendChild(detailCard);

    main.appendChild(stage);
    this.stage = stage;
    this._mainEl = main;
    this._barEl = bar;

    // Draggable divider between the map and the sidebar (resize), plus a
    // collapse chevron on it.
    const resizer = this._buildSidebarResizer();
    this._resizerEl = resizer;
    main.appendChild(resizer);

    const side = this._buildSidebar();
    this._sideEl = side;
    // reflect a persisted "hide reviews" state on the lists straight away
    this._applyReviewDim();
    main.appendChild(side);

    // Slim strip shown when the sidebar is collapsed, to reopen it.
    const reopen = this._el("button", "zcm-side-reopen", "‹");
    reopen.setAttribute("title", "Show the sidebar");
    reopen.addEventListener("click", () => this._setSidebarCollapsed(false));
    this._reopenEl = reopen;
    main.appendChild(reopen);

    root.appendChild(main);

    // ---- status strip
    const s = this.graph.stats;
    const ch = this.ctx && this.ctx.changed;
    const newBits =
      ch && ch.papers + ch.suggestions > 0
        ? ` · ★ ${ch.papers + ch.suggestions} new since last build`
        : "";
    this.status = this._el(
      "div",
      "zcm-status",
      `${s.items} items · ${s.resolved} resolved · ${s.edges} citation links · ` +
        `${s.discovered} suggested papers${newBits} · scroll = zoom · ` +
        `drag = pan · ⌂ = fit view · ? = tour`
    );
    root.appendChild(this.status);

    // Structural layout as inline styles, independent of the external
    // stylesheet, so the map + sidebar are laid out even if graph.css never
    // applies (failed load, stale cache, parse error). Do this BEFORE the
    // container append so the first paint is already correct.
    this._applyLayoutStyles({
      root,
      bar,
      main,
      stage,
      side,
      resizer,
      status: this.status,
    });
    // reflect the persisted collapsed state on the reopen strip
    reopen.style.display = this._sidebarCollapsed ? "flex" : "none";

    this.container.appendChild(root);
    this._attachCanvasEvents();

    // Diagnostic: is the external stylesheet actually applying? (Checks a
    // property only graph.css sets.) Logged for support, and used to show a
    // gentle on-screen note if the cosmetic styles are missing.
    try {
      const bg = this._css("--zcm-bg");
      this._cssApplied = !!bg;
      this._diag("css", { applied: this._cssApplied, bg });
    } catch (e) {
      this._cssApplied = true; // don't nag if the probe itself failed
    }

    // If the cosmetic stylesheet isn't applying, the inline layout above
    // still shows the map, but colours/spacing look wrong. Surface a
    // self-styled (CSS-independent) hint so the user knows and can report.
    if (!this._cssApplied) {
      const note = this.doc.createElement("div");
      note.style.cssText =
        "position:absolute;left:8px;bottom:8px;z-index:90;max-width:420px;" +
        "padding:8px 10px;border-radius:8px;font:12px system-ui,sans-serif;" +
        "background:#7a1f1f;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.4)";
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
  }

  _buildSidebar() {
    const side = this._el("div", "zcm-side");

    // NOTE: the paper-details card no longer lives here, it is a floating
    // card over the map (built in _buildDOM / _buildDetailCard), so selecting
    // a paper never reflows the sidebar lists.

    // The lists live in tabs so each gets the space instead of stacking
    // into one long scroll; the last-used tab is remembered. Each panel is
    // built defensively: one broken panel must never take down the view.
    const tabs = this._el("div", "zcm-tabs");
    this._tabsEl = tabs;
    this._tabBtns = {};
    this._tabPanels = {
      suggested: this._safePanel("Suggested", () => this._buildSuggestedPanel()),
      discover: this._safePanel("Discover", () => this._buildDiscoverPanel()),
      chains: this._safePanel("Citation chains", () => this._buildChainsPanel()),
      papers: this._safePanel("My papers", () => this._buildPapersPanel()),
    };
    for (const [id, label, tip] of [
      ["suggested", "Suggested", "Papers you're missing, from your own citations (instant, offline)"],
      ["discover", "Discover", "Live web search for papers beyond your library"],
      ["chains", "Chains", "Citation chains through time"],
      ["papers", "My papers", "Everything in this collection"],
    ]) {
      const b = this._el("button", "zcm-tab", label);
      b.setAttribute("title", tip);
      b.addEventListener("click", () => this._setSideTab(id));
      this._tabBtns[id] = b;
      tabs.appendChild(b);
    }
    // The tabs stay PINNED at the top; only the panels below them scroll.
    // Inline styles here (and on the sidebar in _applyLayoutStyles) so this
    // holds even if the external stylesheet is stale/unloaded.
    tabs.style.flex = "0 0 auto";
    side.appendChild(tabs);
    const scroll = this._el("div", "zcm-side-scroll");
    Object.assign(scroll.style, {
      flex: "1 1 auto",
      minHeight: "0",
      overflowY: "auto",
      overflowX: "hidden",
    });
    this._sideScrollEl = scroll;
    for (const p of Object.values(this._tabPanels)) scroll.appendChild(p);
    side.appendChild(scroll);

    const saved = Zotero.Prefs.get("extensions.citation-map.sideTab", true);
    this._setSideTab(this._tabPanels[saved] ? saved : "suggested", false);
    return side;
  }

  _setSideTab(id, persist = true) {
    this.sideTab = id;
    for (const [k, b] of Object.entries(this._tabBtns)) {
      b.classList.toggle("zcm-on", k === id);
    }
    for (const [k, p] of Object.entries(this._tabPanels)) {
      p.style.display = k === id ? "" : "none";
    }
    if (persist) {
      try {
        Zotero.Prefs.set("extensions.citation-map.sideTab", id, true);
      } catch (e) {
        /* best-effort */
      }
    }
  }

  /** Build a sidebar panel; on failure, log and show a fallback card. */
  _safePanel(name, build) {
    try {
      return build();
    } catch (e) {
      Zotero.debug(
        `[Citation Map] ${name} panel failed: ` + e + "\n" + (e && e.stack)
      );
      const card = this._el("div", "zcm-card");
      card.appendChild(this._el("div", "zcm-card-head", name));
      card.appendChild(
        this._el(
          "div",
          "zcm-empty",
          "This panel could not be built. Please report this, the details " +
            "are in Help → Debug Output Logging → View Output."
        )
      );
      return card;
    }
  }

  _buildSuggestedPanel() {
    const wrap = this._el("div", "zcm-panel-stack");

    // Suggestions computed from your own library's citations (no web search).
    const disc = this._el("div", "zcm-card");
    disc.appendChild(this._el("div", "zcm-card-head", "Suggested from your library"));
    disc.appendChild(
      this._el(
        "div",
        "zcm-card-sub",
        "Papers you don't have yet, worked out instantly from your own " +
          "papers' reference lists: the works several of your papers already " +
          "cite. No web search. (To search the wider literature, open the " +
          "Discover tab.)"
      )
    );

    // one control row: how many suggestions to show ON THE MAP (off/top/all),
    // and the minimum number of your papers that must cite one (×N).
    disc.appendChild(this._buildSuggestControls(() => renderList()));

    const list = this._el("div", "zcm-sugg-list");
    disc.appendChild(list);

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
          this._el(
            "div",
            "zcm-empty",
            "No suggestions at this strength. Lower the ×N filter above, or " +
              "use Discover below to search for more."
          )
        );
      }
      for (const n of discovered) {
        const row = this._el("div", "zcm-row");
        if (n.isReview) row.classList.add("zcm-is-review");
        const meta = this._el("div", "zcm-row-meta");
        const badge = this._el("span", "zcm-badge", `×${n.inLibraryCitations}`);
        badge.setAttribute(
          "title",
          `Cited by ${n.inLibraryCitations} of your papers`
        );
        meta.appendChild(badge);
        meta.appendChild(this._el("span", "zcm-year", n.year || "—"));
        if (n.isReview) meta.appendChild(this._reviewChip());
        if (n.isNew) {
          const c = this._el("span", "zcm-new-chip", "NEW");
          c.setAttribute("title", "Appeared since your last build of this collection");
          meta.appendChild(c);
        }
        if (n.matchedTopics && n.matchedTopics.length) {
          const t = this._el("span", "zcm-topic-tag", n.matchedTopics[0]);
          t.setAttribute("title", "Shares this research topic with your collection");
          meta.appendChild(t);
        }
        row.appendChild(meta);
        row.appendChild(this._el("div", "zcm-row-title", n.title));
        const sub = this._el("div", "zcm-row-sub");
        if (n.venue) this._appendVenue(sub, n);
        if (n.citedByCount) {
          const cites = n.citedByCount.toLocaleString() + " citations";
          sub.appendChild(
            this._el("span", null, (n.venue ? " · " : "") + cites)
          );
        }
        if (sub.childNodes.length) row.appendChild(sub);
        row.addEventListener("click", () => {
          n.revealed = true; // make it visible even if the map hides suggestions
          this._applySuggestionVisibility();
          this._select(n.key, true);
        });
        list.appendChild(row);
      }
    };
    this._renderSuggestList = renderList; // so the controls can refresh it
    renderList();
    wrap.appendChild(disc);
    return wrap;
  }

  /**
   * The "Discover" tab: the on-demand live OpenAlex search. Needs the live
   * collection profile, imported maps don't carry one, so they get a short
   * explanation instead of the search.
   */
  _buildDiscoverPanel() {
    const wrap = this._el("div", "zcm-panel-stack");
    if (this.graph.profile) {
      wrap.appendChild(this._buildDiscoverCard());
    } else {
      const card = this._el("div", "zcm-card");
      card.appendChild(this._el("div", "zcm-card-head", "Discover new papers"));
      card.appendChild(
        this._el(
          "div",
          "zcm-empty",
          "The live search isn't available for imported maps (they don't " +
            "carry your collection's topic profile). Open the map from a " +
            "Zotero collection to use Discover."
        )
      );
      wrap.appendChild(card);
    }
    return wrap;
  }

  /**
   * The unified suggestion controls (previously split between a toolbar
   * toggle and sidebar chips): how many suggestions appear ON THE MAP, and
   * the ×N strength floor. `onChange` re-renders the sidebar list.
   */
  _buildSuggestControls(onChange) {
    const box = this._el("div", "zcm-sugg-controls");

    // Row 1, show on the map: Off / Top / All
    const r1 = this._el("div", "zcm-sugg-ctl-row");
    r1.appendChild(this._el("span", "zcm-ctl-label", "On the map"));
    const tog = this._el("div", "zcm-toggle");
    this._suggBtns = {};
    for (const [val, label, tip] of [
      ["off", "Off", "Don't draw suggestions on the map (they still list here)"],
      [
        "top",
        "Top",
        `Only the ${this.suggestTopCount} strongest suggestions, drawn softly`,
      ],
      ["all", "All", "Every suggestion that passes the ×N filter below"],
    ]) {
      const b = this._el("button", "zcm-toggle-btn", label);
      b.setAttribute("title", tip);
      if (val === this.suggestDisplay) b.classList.add("zcm-on");
      b.addEventListener("click", () => this._setSuggestDisplay(val));
      this._suggBtns[val] = b;
      tog.appendChild(b);
    }
    r1.appendChild(tog);
    box.appendChild(r1);

    // Row 2, strength floor: cited by at least N of your papers
    const r2 = this._el("div", "zcm-sugg-ctl-row");
    r2.appendChild(this._el("span", "zcm-ctl-label", "Cited by ≥"));
    const chips = this._el("div", "zcm-chips");
    for (const v of [2, 3, 4]) {
      const chip = this._el("button", "zcm-chip", String(v));
      if (v === this.suggestMinCiters) chip.classList.add("zcm-on");
      chip.setAttribute(
        "title",
        `Only suggestions cited by at least ${v} of your papers`
      );
      chip.addEventListener("click", () => {
        this.suggestMinCiters = v;
        try {
          Zotero.Prefs.set("extensions.citation-map.suggestMinCiters", v, true);
        } catch (e) {
          /* best-effort */
        }
        for (const c of chips.children) c.classList.toggle("zcm-on", c === chip);
        this._applySuggestionVisibility();
        onChange && onChange();
      });
      chips.appendChild(chip);
    }
    r2.appendChild(chips);
    r2.appendChild(this._el("span", "zcm-ctl-hint", "of your papers"));
    box.appendChild(r2);
    return box;
  }

  // ============================================================== discover

  /**
   * "Discover new papers": on-demand OpenAlex search for (1) papers citing
   * the user's papers, (2) well-cited papers in the collection's topics,
   * (3) OpenAlex related works, with reason chips explaining every hit.
   * Nothing is fetched until the user clicks the search button, and only
   * OpenAlex record/topic IDs are transmitted.
   */
  _buildDiscoverCard() {
    const card = this._el("div", "zcm-card zcm-discover");
    this._discoverCard = card; // coachmark anchor
    const head = this._el("div", "zcm-card-head", "Discover new papers");
    head.appendChild(this._el("span", "zcm-card-badge", "live search"));
    card.appendChild(head);
    card.appendChild(
      this._el(
        "div",
        "zcm-card-sub",
        "A live web search of OpenAlex for papers BEYOND your library, " +
          "including brand-new work that cites yours, and parallel work on " +
          "your topics. (For papers your own collection already cites, use " +
          "the Suggested tab.) Nothing is sent until you press Search, and " +
          "only anonymous OpenAlex IDs leave your computer, never your " +
          "notes, tags or text."
      )
    );
    const profile = this.graph.profile;

    // ---- "Search for", the three sources, clearly labelled ----------------
    card.appendChild(this._el("div", "zcm-discover-h", "Search for"));
    const opts = this._el("div", "zcm-discover-sources");
    const mkCheck = (label, prefKey, tip) => {
      const lab = this._el("label", "zcm-discover-source");
      const cb = this._el("input");
      cb.setAttribute("type", "checkbox");
      cb.checked =
        Zotero.Prefs.get("extensions.citation-map." + prefKey, true) !== false;
      cb.addEventListener("change", () => {
        try {
          Zotero.Prefs.set("extensions.citation-map." + prefKey, cb.checked, true);
        } catch (e) {
          /* best-effort */
        }
      });
      lab.setAttribute("title", tip);
      lab.appendChild(cb);
      lab.appendChild(this._el("span", null, label));
      opts.appendChild(lab);
      return cb;
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
    card.appendChild(opts);

    // ---- "Published", a preset dropdown (no more confusing year box) -------
    card.appendChild(this._el("div", "zcm-discover-h", "Published"));
    const timeRow = this._el("div", "zcm-discover-time");
    const sel = this._el("select", "zcm-discover-select");
    sel.setAttribute("title", "Only include papers published within this time");
    const nowY = new Date().getFullYear();
    const presets = [
      ["any", "Any time"],
      ["2y", "Last 2 years"],
      ["5y", "Last 5 years"],
      ["10y", "Last 10 years"],
      ["custom", "Custom year…"],
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
    timeRow.appendChild(sel);
    const yearInp = this._el("input", "zcm-discover-year");
    yearInp.setAttribute("type", "number");
    yearInp.setAttribute("min", "1900");
    yearInp.setAttribute("max", String(nowY));
    yearInp.setAttribute("placeholder", String(nowY - 5));
    yearInp.style.display = sel.value === "custom" ? "inline-block" : "none";
    if (savedIsYear) yearInp.value = String(savedSince);
    timeRow.appendChild(yearInp);
    sel.addEventListener("change", () => {
      yearInp.style.display = sel.value === "custom" ? "inline-block" : "none";
      this._persistSince(sel, yearInp);
    });
    yearInp.addEventListener("change", () => this._persistSince(sel, yearInp));
    card.appendChild(timeRow);

    // ---- "Limit to topics": a vertical toggle list, so long topic names
    //      always fit on their own row (chips truncated them).
    this._activeTopics = new Set(
      (profile.topics || []).slice(0, 5).map((t) => t.id)
    );
    if (profile.topics && profile.topics.length) {
      card.appendChild(this._el("div", "zcm-discover-h", "Limit to topics"));
      const list = this._el("div", "zcm-topic-list");
      for (const t of profile.topics.slice(0, 5)) {
        const row = this._el("label", "zcm-topic-row");
        row.setAttribute(
          "title",
          `OpenAlex topic shared by ${t.count} of your papers`
        );
        const cb = this._el("input");
        cb.setAttribute("type", "checkbox");
        cb.checked = this._activeTopics.has(t.id);
        cb.addEventListener("change", () => {
          if (cb.checked) this._activeTopics.add(t.id);
          else this._activeTopics.delete(t.id);
        });
        row.appendChild(cb);
        // topic name, followed by an italic, teal "used by N papers" note
        const nameEl = this._el("span", "zcm-topic-name");
        nameEl.appendChild(this._el("span", null, t.name));
        if (t.count) {
          nameEl.appendChild(
            this._el(
              "span",
              "zcm-topic-used",
              ` - used by ${t.count} paper${t.count === 1 ? "" : "s"}`
            )
          );
        }
        row.appendChild(nameEl);
        list.appendChild(row);
      }
      card.appendChild(list);
    }
    if (profile.terms && profile.terms.length) {
      const terms = this._el(
        "div",
        "zcm-discover-terms",
        "Key terms (computed on your machine, never sent): " +
          profile.terms
            .slice(0, 6)
            .map((t) => t.term)
            .join(" · ")
      );
      card.appendChild(terms);
    }

    // ---- Search + results --------------------------------------------------
    const runBtn = this._el(
      "button",
      "zcm-btn zcm-btn-primary zcm-discover-run",
      "🔍  Search for new papers"
    );
    const status = this._el("div", "zcm-discover-status");
    const results = this._el("div", "zcm-discover-results");
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      results.textContent = "";
      status.classList.remove("zcm-discover-err");
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
        if (!entries.length && DS.netState === "offline") {
          status.classList.add("zcm-discover-err");
          status.textContent =
            "No internet connection, OpenAlex could not be reached. " +
            "Reconnect and try the search again.";
        } else {
          const span = fromYear ? ` published since ${fromYear}` : "";
          status.textContent = entries.length
            ? `${entries.length} paper${entries.length === 1 ? "" : "s"}${span}` +
              `, best matches first${
                DS.netState === "slow" ? " (connection was slow)" : ""
              }:`
            : `Nothing new found${span}. Try more sources, more topics, or a ` +
              "wider time range.";
        }
        this._renderSearchResults(results, entries);
      } catch (e) {
        Zotero.debug("[Citation Map] Discover search failed: " + e);
        status.classList.add("zcm-discover-err");
        status.textContent =
          DS.netState === "offline"
            ? "No internet connection, OpenAlex could not be reached. " +
              "Reconnect and try again."
            : "Search failed. See Help → Debug Output for details.";
      }
      runBtn.disabled = false;
    });
    card.appendChild(runBtn);
    // "Clear discovered from map", remove everything the search injected
    const clearBtn = this._el(
      "button",
      "zcm-btn zcm-discover-clear",
      "Clear discovered papers from map"
    );
    clearBtn.setAttribute(
      "title",
      "Remove every paper the search added to the map"
    );
    clearBtn.style.display = "none";
    clearBtn.addEventListener("click", () => this._clearInjected());
    this._clearInjectedBtn = clearBtn;
    card.appendChild(clearBtn);
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
   * Preview a Discover result in the floating card (the same window paper
   * details use), without adding it to the map. If it is already on the map,
   * just select it there.
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
    this._renderDetails(node);
    if (this._detailCard) {
      if (this.tooltip) this.tooltip.style.display = "none";
      this._detailCard.style.display = "flex";
      this._positionDetail(null); // centred in the map field (no dot to anchor to)
    }
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
    // reviews are kept and de-emphasised (greyed/italic via .zcm-is-review),
    // non-reviews sorted first so they lead the results
    const shown = entries
      .slice()
      .sort((a, b) => (a.isReview ? 1 : 0) - (b.isReview ? 1 : 0));
    for (const e of shown) {
      const rec = e.record;
      const key = "d" + rec.id;
      const row = this._el("div", "zcm-row zcm-discover-row");
      if (e.isReview) row.classList.add("zcm-is-review");
      const meta = this._el("div", "zcm-row-meta");
      if (e.isReview) meta.appendChild(this._reviewChip());
      if (e.citesCount) {
        const b = this._el(
          "span",
          "zcm-badge zcm-badge-cites",
          `cites ${e.citesCount} of yours`
        );
        b.setAttribute("title", "This paper cites papers in your collection");
        meta.appendChild(b);
      }
      if (e.relatedCount) {
        const b = this._el(
          "span",
          "zcm-badge zcm-badge-rel",
          `related ×${e.relatedCount}`
        );
        b.setAttribute(
          "title",
          "OpenAlex flags this as related to several of your papers"
        );
        meta.appendChild(b);
      }
      for (const t of e.topicNames || []) {
        const tt = this._el("span", "zcm-topic-tag", t);
        tt.setAttribute("title", "Shares this research topic with your collection");
        meta.appendChild(tt);
      }
      meta.appendChild(this._el("span", "zcm-year", rec.year || "—"));
      row.appendChild(meta);
      // Clicking the row (anywhere but the action buttons) opens a preview of
      // the paper in the floating card, same as clicking a dot on the map.
      row.classList.add("zcm-row-preview");
      row.setAttribute("title", "Click for a preview");
      row.addEventListener("click", () => this._previewRecord(e));
      const titleEl = this._el("div", "zcm-row-title", rec.title);
      row.appendChild(titleEl);
      const sub = this._el("div", "zcm-row-sub");
      if (rec.authors && rec.authors.length) {
        sub.appendChild(
          this._el(
            "span",
            null,
            rec.authors.slice(0, 3).join(", ") +
              (rec.authors.length > 3 ? " et al." : "") +
              (rec.venue ? " · " : "")
          )
        );
      }
      if (rec.venue) this._appendVenue(sub, { venue: rec.venue });
      if (rec.citedByCount) {
        sub.appendChild(
          this._el(
            "span",
            null,
            " · " + rec.citedByCount.toLocaleString() + " citations"
          )
        );
      }
      if (sub.childNodes.length) row.appendChild(sub);

      const actions = this._el("div", "zcm-d-actions");
      // Clicks on the buttons must not also trigger the row's preview.
      actions.addEventListener("click", (ev) => ev.stopPropagation());
      // inline, non-blocking feedback line under the buttons
      const feedback = this._el("div", "zcm-inline-msg");
      feedback.style.display = "none";

      // Add to Zotero, inline feedback, no modal alerts
      if (rec.doi) {
        const addBtn = this._el("button", "zcm-btn zcm-btn-mini", "Add to Zotero");
        addBtn.addEventListener("click", async () => {
          addBtn.disabled = true;
          addBtn.textContent = "Adding…";
          feedback.style.display = "none";
          try {
            const item = await this._importByDOI(rec.doi, this.ctx.collectionID);
            addBtn.textContent = "Added ✓";
            addBtn.classList.add("zcm-btn-done");
            const node = this.nodeByKey.get(key);
            if (node) {
              node.kind = "library";
              node.zoteroItemID = item.id;
              this._dirty = true;
            }
            // offer a jump to the freshly added item
            const showBtn = this._el(
              "button",
              "zcm-btn zcm-btn-mini",
              "Show in library"
            );
            showBtn.addEventListener("click", async () => {
              try {
                const pane = Zotero.getActiveZoteroPane();
                this.win.Zotero_Tabs.select("zotero-pane");
                await pane.selectItem(item.id);
              } catch (err) {
                /* best-effort */
              }
            });
            actions.appendChild(showBtn);
          } catch (err) {
            Zotero.debug("[Citation Map] Discover add failed: " + err);
            addBtn.disabled = false;
            addBtn.textContent = "Add to Zotero";
            feedback.textContent =
              "Couldn't add it automatically. Use “DOI” to open it, then " +
              "add it in Zotero.";
            feedback.style.display = "block";
          }
        });
        actions.appendChild(addBtn);
      }

      // Show on map ⇄ Remove from map (a real toggle, reversible)
      const mapBtn = this._el("button", "zcm-btn zcm-btn-mini", "");
      const syncMapBtn = () => {
        const on = this.nodeByKey.has(key) && !this.nodeByKey.get(key).hidden;
        mapBtn.textContent = on ? "Remove from map" : "Show on map";
        mapBtn.classList.toggle("zcm-btn-done", on);
      };
      mapBtn.addEventListener("click", () => {
        const node = this.nodeByKey.get(key);
        if (node && !node.hidden) this._removeInjected(node);
        else this._injectSearchResult(e);
        syncMapBtn();
      });
      syncMapBtn();
      this._resultSyncers.push(syncMapBtn);
      actions.appendChild(mapBtn);

      if (rec.doi) {
        const doiBtn = this._el("button", "zcm-btn zcm-btn-mini", "DOI");
        doiBtn.setAttribute("title", "Open this paper on doi.org");
        doiBtn.addEventListener("click", () =>
          Zotero.launchURL("https://doi.org/" + rec.doi)
        );
        actions.appendChild(doiBtn);
      }
      row.appendChild(actions);
      row.appendChild(feedback);
      container.appendChild(row);
    }
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
    this._clearInjectedBtn.style.display = any ? "block" : "none";
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
        r: 6.5,
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

  /** Import a work into the library (and collection) by DOI. */
  async _importByDOI(doi, collectionID) {
    const translate = new Zotero.Translate.Search();
    translate.setIdentifier({ DOI: doi });
    const translators = await translate.getTranslators();
    if (!translators.length) throw new Error("No translator found for DOI");
    translate.setTranslator(translators);
    const items = await translate.translate({
      libraryID: Zotero.Libraries.userLibraryID,
      collections: collectionID ? [collectionID] : false,
    });
    if (!items || !items.length) throw new Error("Nothing imported");
    return items[0];
  }

  _buildChainsPanel() {
    const ch = this._el("div", "zcm-card");
    ch.appendChild(this._el("div", "zcm-card-head", "Citation chains"));
    ch.appendChild(
      this._el(
        "div",
        "zcm-card-sub",
        "A paper trail through time: step 2 cites step 1, step 3 cites " +
          "step 2, … Click a chain to light it up on the map (numbered from " +
          "the oldest paper); click again to clear."
      )
    );
    if (!this.graph.chains.length) {
      ch.appendChild(
        this._el("div", "zcm-empty", "No chains of 3+ papers found in this collection.")
      );
    }
    this.graph.chains.forEach((chain) => {
      const row = this._el("div", "zcm-row zcm-chain-row");
      const meta = this._el("div", "zcm-row-meta");
      meta.appendChild(
        this._el("span", "zcm-badge zcm-badge-chain", `${chain.length} papers`)
      );
      const yrs = chain
        .map((k) => this.nodeByKey.get(k))
        .filter((n) => n && n.year)
        .map((n) => n.year);
      if (yrs.length >= 2) {
        meta.appendChild(
          this._el("span", "zcm-year", `${Math.min(...yrs)} → ${Math.max(...yrs)}`)
        );
      }
      row.appendChild(meta);
      const oldest = this.nodeByKey.get(chain[chain.length - 1]);
      const newest = this.nodeByKey.get(chain[0]);
      row.appendChild(
        this._el(
          "div",
          "zcm-row-title",
          `${this._short(oldest && oldest.title)} → … → ` +
            `${this._short(newest && newest.title)}`
        )
      );

      // Expandable step list (oldest → newest, matching the map badges).
      const steps = this._el("div", "zcm-chain-steps");
      const ordered = [...chain].reverse();
      ordered.forEach((key, idx) => {
        const n = this.nodeByKey.get(key);
        if (!n) return;
        if (idx > 0) {
          steps.appendChild(
            this._el("div", "zcm-chain-link", "↑ cited by")
          );
        }
        const st = this._el("div", "zcm-chain-step");
        st.appendChild(this._el("span", "zcm-chain-num", String(idx + 1)));
        st.appendChild(
          this._el(
            "span",
            "zcm-chain-step-label",
            `${this._label(n)}, ${this._short(n.title)}`
          )
        );
        st.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._select(key, true);
        });
        steps.appendChild(st);
      });
      row.appendChild(steps);

      row.addEventListener("click", () => {
        this.activeChain = this.activeChain === chain ? null : chain;
        this._dirty = true;
        for (const el of ch.querySelectorAll(".zcm-chain-row")) {
          el.classList.toggle("zcm-active", false);
        }
        if (this.activeChain) {
          row.classList.add("zcm-active");
          // a chain may run through a hidden suggestion, reveal it
          let revealed = false;
          for (const key of chain) {
            const n = this.nodeByKey.get(key);
            if (n && n.hidden) {
              n.revealed = true;
              revealed = true;
            }
          }
          if (revealed) this._applySuggestionVisibility();
        }
      });
      ch.appendChild(row);
    });
    return ch;
  }

  /**
   * "My papers": every paper of the mapped collection, newest first, with
   * its Zotero tags and note count. Clicking a row selects the paper on
   * the map (highlight ring + centered view + details card).
   */
  _buildPapersPanel() {
    const card = this._el("div", "zcm-card");
    card.appendChild(this._el("div", "zcm-card-head", "My papers"));
    card.appendChild(
      this._el(
        "div",
        "zcm-card-sub",
        "Everything in this collection, with tags and notes. Click a paper " +
          "to highlight it on the map."
      )
    );

    // quick filter, local to this list (the toolbar search dims the map)
    const filter = this._el("input", "zcm-search zcm-papers-filter");
    filter.setAttribute("placeholder", "Filter by title, author or tag…");
    card.appendChild(filter);
    this._papersFilterInput = filter;

    // a local "hide reviews" checkbox, mirroring the toolbar toggle
    const revRow = this._el("label", "zcm-papers-reviewrow");
    const revCb = this._el("input");
    revCb.setAttribute("type", "checkbox");
    revCb.checked = this.hideReviews;
    revCb.addEventListener("change", () => this._setHideReviews(revCb.checked));
    this._papersReviewCb = revCb;
    revRow.appendChild(revCb);
    revRow.appendChild(this._el("span", null, "Hide review articles"));
    card.appendChild(revRow);

    const list = this._el("div");
    card.appendChild(list);
    this._paperRows = new Map();

    const papers = this.graph.nodes
      .filter((n) => n.kind !== "discovered")
      .sort(
        (a, b) =>
          (b.year || 0) - (a.year || 0) ||
          (a.title || "").localeCompare(b.title || "")
      );
    if (!papers.length) {
      list.appendChild(this._el("div", "zcm-empty", "No papers in this collection."));
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

      const row = this._el("div", "zcm-row zcm-paper-row");
      row._isReview = !!n.isReview;
      if (n.isReview) row.classList.add("zcm-is-review");
      const meta = this._el("div", "zcm-row-meta");
      meta.appendChild(this._el("span", "zcm-year", n.year || "—"));
      if (n.isReview) meta.appendChild(this._reviewChip());
      if (n.isNew) meta.appendChild(this._el("span", "zcm-new-chip", "NEW"));
      if (n.kind === "unresolved") {
        meta.appendChild(this._el("span", "zcm-paper-flag", "no citation data"));
      }
      if (noteCount) {
        meta.appendChild(
          this._el(
            "span",
            "zcm-paper-notes",
            `✎ ${noteCount} note${noteCount > 1 ? "s" : ""}`
          )
        );
      }
      row.appendChild(meta);
      row.appendChild(this._el("div", "zcm-row-title", n.title));
      if (n.venue || n.authors?.length) {
        const sub = this._el("div", "zcm-row-sub");
        if (n.authors && n.authors.length) {
          sub.appendChild(
            this._el(
              "span",
              null,
              n.authors.slice(0, 3).join(", ") +
                (n.authors.length > 3 ? " et al." : "") +
                (n.venue ? " · " : "")
            )
          );
        }
        if (n.venue) this._appendVenue(sub, n);
        row.appendChild(sub);
      }
      if (tags.length) {
        const tw = this._el("div", "zcm-paper-tags");
        for (const t of tags.slice(0, 6)) {
          const tagEl = this._el("span", "zcm-paper-tag", t);
          // colored Zotero tags keep their color
          try {
            const c = Zotero.Tags.getColor(libraryID, t);
            if (c && c.color) {
              tagEl.style.borderColor = c.color;
              tagEl.style.color = c.color;
            }
          } catch (e) {
            /* neutral chip */
          }
          tw.appendChild(tagEl);
        }
        if (tags.length > 6) {
          tw.appendChild(
            this._el("span", "zcm-paper-tag", `+${tags.length - 6}`)
          );
        }
        row.appendChild(tw);
      }

      row.addEventListener("click", () => this._select(n.key, true));
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

    // Text filter only. Reviews are NOT hidden here; they're greyed out via
    // the .zcm-is-review row class + the sidebar's .zcm-hide-reviews toggle.
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

    return card;
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
   * Render a paper's journal name into `container`, styled with its
   * publisher's identity when recognised (logo-style font + brand colour,
   * legible on the dark panels), preceded by a small brand swatch. Unknown
   * journals fall back to the plain muted style.
   */
  _appendVenue(container, node) {
    const ci = this._ci(node);
    const CI = ZCM_VIEW_NS && ZCM_VIEW_NS.PublisherCI;
    if (ci && ci.matched && CI) {
      if (ci.primary) {
        const sw = this._el("span", "zcm-ci-swatch");
        sw.style.background = ci.primary;
        container.appendChild(sw);
      }
      const v = this._el("span", "zcm-ci-venue", node.venue);
      v.style.fontFamily = ci.font;
      v.style.fontStyle = "normal";
      if (ci.primary) v.style.color = CI.onDark(ci.primary);
      v.setAttribute(
        "title",
        ci.family + (ci.bestEffort ? " · best-effort styling" : "")
      );
      container.appendChild(v);
    } else {
      container.appendChild(this._el("span", null, node.venue));
    }
  }

  _renderDetails(node) {
    const d = this.details;
    d.textContent = "";
    // brand accent lives on the whole floating card, not inside the body
    const card = this._detailCard;
    if (card) card.style.borderLeftColor = "";
    if (card) card.style.borderLeftWidth = "";
    if (!node) {
      d.appendChild(
        this._el("div", "zcm-empty", "Select a paper on the map to see its details.")
      );
      return;
    }
    // Publisher brand accent down the left edge of the CARD (secondary colour,
    // brightened for the dark panel) when the journal is recognised.
    const ci = this._ci(node);
    if (card && ci && ci.matched && ZCM_VIEW_NS.PublisherCI) {
      const accent = ci.secondary || ci.primary;
      if (accent) {
        card.style.borderLeftWidth = "3px";
        card.style.borderLeftColor = ZCM_VIEW_NS.PublisherCI.onDark(accent);
      }
    }
    let kindLabel = {
      library: "In your library",
      discovered: "Suggested, not in your library",
      unresolved: "In your library · no citation data found",
    }[node.kind];
    if (node.kind === "discovered" && node.via && node.via !== "refs") {
      kindLabel =
        node.via === "cites"
          ? `Found, cites ${node.citesCount || "several"} of your papers`
          : node.via === "related"
          ? "Found, related to your papers"
          : "Found, matches your topics";
    }
    const kindRow = this._el("div", "zcm-d-kindrow");
    kindRow.appendChild(this._el("span", "zcm-kind zcm-kind-" + node.kind, kindLabel));
    if (node.isReview) kindRow.appendChild(this._reviewChip());
    if (node.isNew) kindRow.appendChild(this._el("span", "zcm-new-chip", "NEW"));
    d.appendChild(kindRow);
    d.appendChild(this._el("div", "zcm-d-title", node.title));
    if (node.authors && node.authors.length) {
      d.appendChild(this._el("div", "zcm-d-meta", node.authors.join(", ")));
    }
    if (node.venue) {
      const vEl = this._el("div", "zcm-d-venue");
      this._appendVenue(vEl, node);
      if (node.year) vEl.appendChild(this._el("span", null, " · " + node.year));
      d.appendChild(vEl);
    } else if (node.year) {
      d.appendChild(this._el("div", "zcm-d-venue", String(node.year)));
    }
    // A small chip naming the recognised publisher family (with a best-effort
    // note for low-confidence matches, see PublisherCI confidence levels).
    if (ci && ci.matched) {
      const chip = this._el("div", "zcm-ci-chip");
      if (ci.primary) {
        const sw = this._el("span", "zcm-ci-swatch");
        sw.style.background = ci.primary;
        chip.appendChild(sw);
      }
      chip.appendChild(this._el("span", null, ci.family));
      if (ci.bestEffort) {
        chip.appendChild(this._el("span", "zcm-ci-best", "best-effort cue"));
      }
      d.appendChild(chip);
    }

    // the paper's OpenAlex topics (for suggestions: the matched ones)
    const topicNames =
      node.matchedTopics && node.matchedTopics.length
        ? node.matchedTopics
        : (node.topics || []).slice(0, 2).map((t) => t.name);
    if (topicNames.length) {
      const tr = this._el("div", "zcm-d-topics");
      for (const t of topicNames) {
        tr.appendChild(this._el("span", "zcm-topic-tag", t));
      }
      d.appendChild(tr);
    }

    const stats = this._el("div", "zcm-d-stats");
    if (node.citedByCount != null && node.kind !== "unresolved") {
      stats.appendChild(
        this._el(
          "span",
          "zcm-year",
          `${node.citedByCount.toLocaleString()} citations worldwide`
        )
      );
    }
    // For a Discover preview the relevant number is how many of the user's
    // papers it cites; for mapped papers it's in-collection citations.
    if (node._preview && node._citesCount) {
      stats.appendChild(
        this._el("span", "zcm-year", `cites ${node._citesCount} of your papers`)
      );
    } else if (!node._preview) {
      stats.appendChild(
        this._el("span", "zcm-year", `${node.inLibraryCitations} in this collection`)
      );
    }
    d.appendChild(stats);

    const actions = this._el("div", "zcm-d-actions");
    if (node.zoteroItemID) {
      const b = this._el("button", "zcm-btn zcm-btn-primary", "Show in library");
      b.addEventListener("click", () => this._showInLibrary(node));
      actions.appendChild(b);
    }
    if (node.kind === "discovered" && node.doi) {
      const b = this._el("button", "zcm-btn zcm-btn-primary", "Add to Zotero");
      b.addEventListener("click", () => this._addDiscovered(node, b));
      actions.appendChild(b);
    }
    if (node.doi) {
      const b = this._el("button", "zcm-btn", "Open DOI");
      b.addEventListener("click", () =>
        Zotero.launchURL("https://doi.org/" + node.doi)
      );
      actions.appendChild(b);
    }
    // Remove a search-injected paper from the map (reversible).
    if (node._injected && !node.hidden) {
      const b = this._el("button", "zcm-btn", "Remove from map");
      b.setAttribute("title", "Take this discovered paper off the map");
      b.addEventListener("click", () => this._removeInjected(node));
      actions.appendChild(b);
    }
    // Preview of a Discover result that isn't on the map yet: offer to place it.
    if (node._preview && node._entry) {
      const b = this._el("button", "zcm-btn", "Show on map");
      b.setAttribute("title", "Place this paper on the map");
      b.addEventListener("click", () => {
        this._injectSearchResult(node._entry);
        if (this._discoverResync) this._discoverResync();
      });
      actions.appendChild(b);
    }
    d.appendChild(actions);
    // inline, non-blocking feedback for Add-to-Zotero (no modal alerts)
    this._detailMsg = this._el("div", "zcm-inline-msg");
    this._detailMsg.style.display = "none";
    d.appendChild(this._detailMsg);

    // Zotero / Better Notes attached to this item, previewed in place.
    if (node.zoteroItemID) {
      this._renderNotes(node).catch((e) =>
        Zotero.debug("[Citation Map] Notes preview failed: " + e)
      );
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

    const wrap = this._el("div", "zcm-notes");
    const head = this._el("div", "zcm-notes-head");
    head.appendChild(this._el("span", null, `Notes (${noteIDs.length})`));
    const nav = this._el("span", "zcm-notes-nav");
    const prev = this._el("button", "zcm-btn zcm-btn-mini", "‹");
    const counter = this._el("span", "zcm-notes-counter", "");
    const next = this._el("button", "zcm-btn zcm-btn-mini", "›");
    nav.appendChild(prev);
    nav.appendChild(counter);
    nav.appendChild(next);
    if (noteIDs.length < 2) nav.style.display = "none";
    head.appendChild(nav);
    wrap.appendChild(head);

    const preview = this._el("div", "zcm-note-preview");
    wrap.appendChild(preview);
    const openBtn = this._el("button", "zcm-btn", "Open note in Zotero");
    wrap.appendChild(openBtn);

    let idx = 0;
    const show = (i) => {
      idx = (i + noteIDs.length) % noteIDs.length;
      counter.textContent = `${idx + 1} / ${noteIDs.length}`;
      preview.textContent = "";
      try {
        const note = Zotero.Items.get(noteIDs[idx]);
        if (note) preview.innerHTML = this._sanitizeNoteHTML(note.getNote());
      } catch (e) {
        preview.appendChild(
          this._el("div", "zcm-empty", "Could not load this note.")
        );
      }
    };
    prev.addEventListener("click", () => show(idx - 1));
    next.addEventListener("click", () => show(idx + 1));
    openBtn.addEventListener("click", async () => {
      try {
        const pane = Zotero.getActiveZoteroPane();
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
    this.details.appendChild(wrap);
  }

  /** Strip anything active from note HTML before injecting it. */
  _sanitizeNoteHTML(html) {
    const parsed = new this.win.DOMParser().parseFromString(
      html || "",
      "text/html"
    );
    for (const el of parsed.querySelectorAll(
      "script, iframe, object, embed, link, meta, style"
    )) {
      el.remove();
    }
    for (const el of parsed.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) el.removeAttribute(attr.name);
        else if (
          (name === "href" || name === "src") &&
          /^\s*javascript:/i.test(attr.value)
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }
    return parsed.body.innerHTML;
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
      if (this.alpha < 0.02) this._returning = false;
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
          group.filter((n) => !n.hidden),
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
    // the whole layout overshoot and wobble.
    const rest = 168 * ls;
    for (const e of edges) {
      const s = this.nodeByKey.get(e.source);
      const t = this.nodeByKey.get(e.target);
      if (!s || !t) continue;
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
      const c = this.neighbors.has(n.key) ? 0.045 : 0.16;
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
      this._forEachClosePair(nodes, 2 * 22 + pad, collide);
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

  /**
   * Timeline layout: a deterministic grid of per-year columns ("sub-maps").
   *
   * Papers are grouped by publication year; each populated year becomes a
   * column band placed left→right in chronological order, so the oldest
   * work is always at the far left. Empty years are skipped (they add no
   * value), and a year's band grows wider the more papers it holds, so a
   * burst of 2020-2026 papers spreads out into readable blocks instead of
   * piling onto a single pixel column. Undated papers get their own band
   * on the far left. Because positions are fixed, this layout never wobbles.
   */
  _computeTimelineLayout() {
    const nodes = this._active().nodes;
    if (!nodes.length) {
      this._timeBands = [];
      return;
    }
    const maxR = nodes.reduce((m, n) => Math.max(m, n.r), 8);
    // grid cell, no two dots can overlap at 100 %; the Spacing slider
    // tightens or relaxes the grid (never below touching distance)
    const cell = Math.max(2 * maxR + 4, (2 * maxR + 16) * (this.spacingPct / 100));
    const bandGap = cell * 0.75; // breathing room between year bands

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
    let cursorX = 0;
    for (const y of order) {
      const group = byYear.get(y).slice().sort(
        (a, b) =>
          b.inLibraryCitations - a.inLibraryCitations ||
          (b.citedByCount || 0) - (a.citedByCount || 0)
      );
      const count = group.length;
      // more papers → wider band (denser years get more room), capped so
      // no single year dominates the width.
      const cols = Math.max(1, Math.min(6, Math.round(Math.sqrt(count * 0.55))));
      const rows = Math.ceil(count / cols);
      const bandWidth = cols * cell;
      const x0 = cursorX;
      group.forEach((n, i) => {
        n.tlx = x0 + (i % cols) * cell + cell / 2;
        n.tly = Math.floor(i / cols) * cell; // stack downward
      });
      bands.push({ year: y, x0, x1: x0 + bandWidth, cx: x0 + bandWidth / 2, rows });
      cursorX = x0 + bandWidth + bandGap;
    }

    // Center the whole arrangement on the origin.
    const shiftX = (cursorX - bandGap) / 2;
    const maxRows = bands.reduce((m, b) => Math.max(m, b.rows), 1);
    const shiftY = ((maxRows - 1) * cell) / 2;
    for (const n of nodes) {
      if (n.tlx != null) {
        n.tlx -= shiftX;
        n.tly -= shiftY;
      }
    }
    for (const b of bands) {
      b.x0 -= shiftX;
      b.x1 -= shiftX;
      b.cx -= shiftX;
    }
    this._timeBands = bands;
    this._timeCell = cell;
    this._timeTopY = -shiftY; // y of the top row, for header placement
  }

  _setMode(mode) {
    if (mode === this.mode) return;
    if (mode === "timeline") {
      // Remember the exact network layout (islands and all) so we can glide
      // straight back to it later, instead of re-running a live force reflow
      // from the spread-out timeline positions, which scattered the islands.
      for (const n of this.graph.nodes) {
        n._netX = n.x;
        n._netY = n.y;
      }
      this.mode = "timeline";
      this._returning = false;
      this._computeTimelineLayout();
      this.alpha = 1; // ease into the grid
    } else {
      // Returning to the network: ease every node back to its remembered
      // position with the same monotonic approach the timeline uses (no
      // forces, so it cannot overshoot, wobble, or fling islands apart).
      this.mode = "force";
      for (const n of this._active().nodes) {
        n.tlx = n._netX != null ? n._netX : n.x;
        n.tly = n._netY != null ? n._netY : n.y;
      }
      this._returning = true;
      this.alpha = 1;
    }
    this.btnForce.classList.toggle("zcm-on", this.mode === "force");
    this.btnTime.classList.toggle("zcm-on", this.mode === "timeline");
    this._dirty = true;
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
    const nodes = this._active().nodes;
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
    const k = Math.max(
      0.12, // don't zoom out to microscopic; tighter packing keeps this rare
      Math.min(2, Math.min((this.width - 60) / w, (this.height - 60) / h))
    );
    const tx = (-(minX + maxX) / 2) * k;
    const ty = (-(minY + maxY) / 2) * k;
    // Smoothly glide to the fitted view (nicer than snapping), except on the
    // very first fit where there's nothing to animate from.
    if (animate && this._didInitialFit) {
      this._animateTransform(tx, ty, k);
    } else {
      this.transform.k = k;
      this.transform.x = tx;
      this.transform.y = ty;
    }
    this._didInitialFit = true;
    this._dirty = true;
  }

  /** Ease the pan/zoom transform to a target over a few frames. */
  _animateTransform(tx, ty, k) {
    const from = { ...this.transform };
    const start = Date.now();
    const dur = 420;
    const ease = (u) => 1 - Math.pow(1 - u, 3); // easeOutCubic
    const step = () => {
      if (this._destroyed) return;
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
    if (!this.graph.nodes.length) return;
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
    const k2 = Math.max(0.2, Math.min(5, this.transform.k * factor));
    const ratio = k2 / this.transform.k;
    this.transform.x *= ratio;
    this.transform.y *= ratio;
    this.transform.k = k2;
    this._clampTransform();
  }

  _animate() {
    if (this._destroyed) return;
    this.win.requestAnimationFrame(() => this._animate());
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
      this.dashOffset -= 0.6; // animates the chain "thread"
      redraw = true;
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

  _draw() {
    const ctx = this.canvas.getContext("2d");
    const { x: tx, y: ty, k } = this.transform;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const colors = {
      library: this._css("--zcm-node") || "#f2eddd",
      discovered: this._css("--zcm-amber") || "#f0a63f",
      unresolved: this._css("--zcm-slate") || "#66708c",
      edge: this._css("--zcm-edge") || "#39415f",
      chain: this._css("--zcm-teal") || "#46d3c2",
      coupling: this._css("--zcm-violet") || "#8b7ff0",
      newmark: "#ffd97a",
      text: this._css("--zcm-text") || "#e9ecf5",
      muted: this._css("--zcm-muted") || "#8e96b0",
      bg: this._css("--zcm-bg") || "#0e1424",
    };
    const activeEdges = this._active().edges;
    // dense graphs get fainter edges so the dots stay in front
    const baseEdgeAlpha =
      activeEdges.length > 400 ? 0.18 : activeEdges.length > 150 ? 0.26 : 0.35;
    const ew = this.edgeWidthPct / 100; // user's line-width slider

    ctx.save();
    ctx.translate(this.width / 2 + tx, this.height / 2 + ty);
    ctx.scale(k, k);

    // ---- year columns (timeline mode)
    if (this.mode === "timeline" && this._timeBands && this._timeBands.length) {
      const cell = this._timeCell;
      const viewTop = (-this.height / 2 - ty) / k;
      const viewBot = (this.height / 2 - ty) / k;
      // year headers ride just below the top of the viewport, so they
      // stay visible however far you scroll down a tall column.
      const headerY = viewTop + 16 / k;
      ctx.textAlign = "center";
      this._timeBands.forEach((b, i) => {
        // subtle alternating band background makes each year scannable
        if (i % 2 === 1) {
          ctx.fillStyle = "rgba(147, 161, 199, 0.05)";
          ctx.fillRect(
            b.x0 - cell * 0.15,
            viewTop,
            b.x1 - b.x0 + cell * 0.3,
            viewBot - viewTop
          );
        }
        // one evenly-spaced header per band, no overlap, unlike the old rail
        const pxWidth = (b.x1 - b.x0) * k;
        if (pxWidth > 24) {
          const label = b.year == null ? "undated" : String(b.year);
          ctx.font = `600 ${12 / k}px ui-monospace, Menlo, Consolas, monospace`;
          ctx.fillStyle = colors.muted;
          ctx.fillText(label, b.cx, headerY);
        }
      });
      // "older → newer" hint under the headers
      ctx.font = `${10 / k}px -apple-system, "Segoe UI", system-ui, sans-serif`;
      ctx.fillStyle = colors.muted;
      ctx.globalAlpha = 0.6;
      ctx.textAlign = "left";
      ctx.fillText("← older", this._timeBands[0].x0, headerY + 16 / k);
      ctx.textAlign = "right";
      ctx.fillText(
        "newer →",
        this._timeBands[this._timeBands.length - 1].x1,
        headerY + 16 / k
      );
      ctx.globalAlpha = 1;
      ctx.textAlign = "center";
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

    // ---- coupling links (dashed "sibling" layer, beneath the arrows)
    if (this.showCoupling && this.graph.coupling.length) {
      ctx.strokeStyle = colors.coupling;
      for (const c of this.graph.coupling) {
        if (c.shared < this.couplingMin) continue;
        const a = this.nodeByKey.get(c.a);
        const b = this.nodeByKey.get(c.b);
        if (!a || !b || a.hidden || b.hidden) continue;
        let alpha = Math.min(0.45, 0.1 + c.shared * 0.04);
        if (focusSet && !(focusSet.has(c.a) && focusSet.has(c.b))) alpha = 0.04;
        if (this.activeChain) alpha = Math.min(alpha, 0.05);
        ctx.globalAlpha = alpha;
        ctx.lineWidth = (0.9 * ew) / k;
        ctx.setLineDash([2.5 / k, 4 / k]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // ---- edges (arrow from citing → cited)
    for (const e of activeEdges) {
      const s = this.nodeByKey.get(e.source);
      const t = this.nodeByKey.get(e.target);
      if (!s || !t) continue;
      const onChain = chainEdges.has(e.source + ">" + e.target);
      let alpha = baseEdgeAlpha;
      if (focusSet && !(focusSet.has(e.source) && focusSet.has(e.target)))
        alpha = 0.06;
      if (this.activeChain && !onChain) alpha = Math.min(alpha, 0.08);
      ctx.globalAlpha = onChain ? 0.95 : alpha;
      ctx.strokeStyle = onChain ? colors.chain : colors.edge;
      ctx.lineWidth = ((onChain ? 2.4 : 1.1) * ew) / k;
      ctx.setLineDash(onChain ? [7 / k, 5 / k] : []);
      ctx.lineDashOffset = onChain ? this.dashOffset / k : 0;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // arrowhead at the cited end
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const ax = t.x - (dx / d) * (t.r + 4);
      const ay = t.y - (dy / d) * (t.r + 4);
      const ang = Math.atan2(dy, dx);
      // arrowheads grow with the line width, but gently (sqrt), so thick
      // lines don't turn every arrow into a wedge
      const sz = ((onChain ? 7 : 5) * Math.sqrt(ew)) / k;
      ctx.fillStyle = onChain ? colors.chain : colors.edge;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - sz * Math.cos(ang - 0.45), ay - sz * Math.sin(ang - 0.45));
      ctx.lineTo(ax - sz * Math.cos(ang + 0.45), ay - sz * Math.sin(ang + 0.45));
      ctx.fill();
    }

    // ---- nodes
    ctx.globalAlpha = 1;
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

      // teased suggestions ("Top" mode) are shown softly, as an invitation
      const baseAlpha = n.teased && !dim ? 0.55 : 1;
      ctx.globalAlpha = dim ? 0.15 : baseAlpha;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = this._nodeFill(n, colors);
      ctx.fill();
      // Rim (publisher mode): papers from a recognised journal take the
      // publisher's brand colour (brightened for the dark map) so the source
      // is identifiable at a glance; other color modes use a neutral rim so
      // the mode's fill colors stay readable.
      const ci = this.colorMode === "publisher" ? this._ci(n) : null;
      if (ci && ci.matched && ci.primary && ZCM_VIEW_NS.PublisherCI) {
        ctx.strokeStyle = ZCM_VIEW_NS.PublisherCI.onDark(ci.primary);
        ctx.lineWidth = 1.8 / k;
      } else {
        ctx.strokeStyle = "rgba(10, 14, 26, 0.5)";
        ctx.lineWidth = 1 / k;
      }
      ctx.stroke();

      if (n.kind === "discovered" && !dim) {
        // soft halo, amber for reference-based suggestions, violet for
        // papers the Discover search placed on the map
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 5 / k, 0, Math.PI * 2);
        ctx.strokeStyle = n._injected ? colors.coupling : colors.discovered;
        ctx.globalAlpha = n.teased ? 0.18 : 0.35;
        ctx.lineWidth = 3 / k;
        ctx.stroke();
        ctx.globalAlpha = dim ? 0.15 : baseAlpha;
      }
      if (n.key === this.selected) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3.5 / k, 0, Math.PI * 2);
        ctx.strokeStyle = colors.text;
        ctx.lineWidth = 1.6 / k;
        ctx.stroke();
      }
      // ★ new since the last build of this collection
      if (n.isNew && !dim) {
        ctx.beginPath();
        ctx.arc(n.x - n.r * 0.9, n.y - n.r * 0.9, 3.2 / k, 0, Math.PI * 2);
        ctx.fillStyle = colors.newmark;
        ctx.fill();
      }

      // step number on an active chain (1 = oldest paper)
      if (this.activeChain && chainSet.has(n.key)) {
        const stepNo = this.activeChain.length - this.activeChain.indexOf(n.key);
        const bx = n.x + n.r * 0.8;
        const by = n.y - n.r * 0.8;
        ctx.beginPath();
        ctx.arc(bx, by, 8.5 / k, 0, Math.PI * 2);
        ctx.fillStyle = colors.chain;
        ctx.fill();
        ctx.fillStyle = colors.bg;
        ctx.font = `bold ${9.5 / k}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(stepNo), bx, by);
        ctx.textBaseline = "alphabetic";
      }

      // Labels: a budget keeps the map readable, only the most-cited
      // papers are labelled when zoomed out; zooming in reveals the rest.
      // Focused and chain papers are always labelled.
      const maxLabels = k > 1.6 ? Infinity : k > 0.9 ? 28 : 12;
      if (
        !dim &&
        (n._rank < maxLabels || n.key === focus || chainSet.has(n.key))
      ) {
        const ly = n.y + n.r + 13 / k;
        ctx.font = `${11 / k}px -apple-system, "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.lineJoin = "round";
        ctx.lineWidth = 3 / k;
        ctx.strokeStyle = colors.bg; // halo so labels survive busy edges
        const label = this._label(n);
        ctx.strokeText(label, n.x, ly);
        ctx.fillStyle = colors.text;
        ctx.fillText(label, n.x, ly);
        if (n.year && this.mode !== "timeline") {
          ctx.font = `${9.5 / k}px ui-monospace, Menlo, Consolas, monospace`;
          ctx.strokeText(String(n.year), n.x, ly + 12 / k);
          ctx.fillStyle = colors.muted;
          ctx.fillText(String(n.year), n.x, ly + 12 / k);
        }
      }
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
          let sy = 0;
          let top = Infinity;
          let cnt = 0;
          for (const n of cl.nodes) {
            if (n.hidden) continue;
            sx += n.x;
            sy += n.y;
            if (n.y - n.r < top) top = n.y - n.r;
            cnt++;
          }
          if (cnt < 3) continue;
          ctx.globalAlpha = 0.55 * fade;
          ctx.font =
            `600 ${13 / k}px -apple-system, "Segoe UI", system-ui, sans-serif`;
          ctx.lineJoin = "round";
          ctx.lineWidth = 4 / k;
          ctx.strokeStyle = colors.bg;
          const lx = sx / cnt;
          const lyy = top - 18 / k;
          ctx.strokeText(cl.label, lx, lyy);
          ctx.fillStyle = colors.muted;
          ctx.fillText(cl.label, lx, lyy);
        }
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  _label(n) {
    const a = n.authors && n.authors[0];
    if (a) {
      const surname = a.split(" ").pop();
      return n.year ? `${surname} ${n.year}` : surname;
    }
    return this._short(n.title).slice(0, 22);
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
      if (dx * dx + dy * dy <= (n.r + 3) * (n.r + 3)) return n;
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

    c.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      // gentle steps, strong zoom made the map easy to lose
      const factor = ev.deltaY < 0 ? 1.06 : 1 / 1.06;
      const k2 = Math.max(0.2, Math.min(5, this.transform.k * factor));
      // zoom toward the cursor
      const rect = c.getBoundingClientRect();
      const mx = ev.clientX - rect.left - this.width / 2;
      const my = ev.clientY - rect.top - this.height / 2;
      this.transform.x = mx - ((mx - this.transform.x) * k2) / this.transform.k;
      this.transform.y = my - ((my - this.transform.y) * k2) / this.transform.k;
      this.transform.k = k2;
      this._clampTransform();
    });

    c.addEventListener("mousedown", (ev) => {
      const p = this._toGraphCoords(ev);
      dragNode = this._nodeAt(p);
      if (dragNode) {
        dragNode.fixed = true;
        this.alpha = Math.max(this.alpha, 0.12);
      } else {
        panning = true;
      }
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
        dragNode.x = p.x;
        dragNode.y = p.y;
        this.alpha = Math.max(this.alpha, 0.08);
      } else if (panning && last) {
        this.transform.x += ev.clientX - last.x;
        this.transform.y += ev.clientY - last.y;
        this._clampTransform();
        last = { x: ev.clientX, y: ev.clientY };
      } else {
        const n = this._nodeAt(p);
        const prev = this.hovered;
        this.hovered = n ? n.key : null;
        c.style.cursor = n ? "pointer" : "grab";
        this._showTooltip(n, ev);
        if (prev !== this.hovered) this._dirty = true;
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
      this.tooltip.style.display = "none";
      this._dirty = true;
    });

    c.addEventListener("click", (ev) => {
      // A pan/drag ends in a click event too; don't let it deselect (which
      // made the details card vanish whenever you moved the map).
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
      if (n.zoteroItemID) this._showInLibrary(n);
      else if (n.doi) Zotero.launchURL("https://doi.org/" + n.doi);
      // release a pinned node on double-click as well
      n.fixed = false;
    });
  }

  _showTooltip(node, ev) {
    if (!node) {
      this.tooltip.style.display = "none";
      return;
    }
    this.tooltip.textContent = "";
    let kindLabel = {
      library: "In your library",
      discovered: `Suggested, cited by ${node.inLibraryCitations} of your papers`,
      unresolved: "In your library · no citation data",
    }[node.kind];
    if (node.kind === "discovered" && node.via && node.via !== "refs") {
      kindLabel =
        node.via === "cites"
          ? `Found, cites ${node.citesCount || "several"} of your papers`
          : node.via === "related"
          ? "Found, related to your papers"
          : "Found, matches your topics";
    }
    this.tooltip.appendChild(
      this._el("div", "zcm-tt-kind zcm-kind-" + node.kind, kindLabel)
    );
    this.tooltip.appendChild(this._el("div", "zcm-tt-title", node.title));
    const authors = node.authors || [];
    if (authors.length) {
      this.tooltip.appendChild(
        this._el(
          "div",
          "zcm-tt-authors",
          authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : "")
        )
      );
    }
    if (node.venue) {
      const vrow = this._el("div", "zcm-tt-meta");
      this._appendVenue(vrow, node);
      if (node.year) vrow.appendChild(this._el("span", null, " · " + node.year));
      this.tooltip.appendChild(vrow);
    } else if (node.year) {
      this.tooltip.appendChild(this._el("div", "zcm-tt-meta", String(node.year)));
    }
    const cites = [];
    if (node.citedByCount != null && node.kind !== "unresolved") {
      cites.push(`${node.citedByCount.toLocaleString()} citations worldwide`);
    }
    cites.push(`${node.inLibraryCitations} in this collection`);
    this.tooltip.appendChild(this._el("div", "zcm-tt-meta", cites.join(" · ")));
    this.tooltip.appendChild(
      this._el("div", "zcm-tt-hint", "click = details · double-click = open")
    );

    const rect = this.stage.getBoundingClientRect();
    this.tooltip.style.display = "block";
    this.tooltip.style.left =
      Math.max(8, Math.min(ev.clientX - rect.left + 14, rect.width - 300)) + "px";
    this.tooltip.style.top =
      Math.max(8, Math.min(ev.clientY - rect.top + 14, rect.height - 170)) + "px";
  }

  _select(key, center) {
    this.selected = key;
    const node = key ? this.nodeByKey.get(key) : null;
    this._renderDetails(node);
    // Floating details card: show it for a selection, hide it otherwise.
    if (this._detailCard) {
      this._detailCard.style.display = node ? "flex" : "none";
      if (node) {
        if (this.tooltip) this.tooltip.style.display = "none"; // avoid two boxes
        this._positionDetail(node); // appear near the clicked dot, in the field
      }
    }
    // mirror the selection in the "My papers" list
    if (this._paperRows) {
      for (const [k, row] of this._paperRows) {
        row.classList.toggle("zcm-active", k === key);
      }
    }
    if (node && center) {
      this.transform.x = -node.x * this.transform.k;
      this.transform.y = -node.y * this.transform.k;
      this._clampTransform();
      this._positionDetail(node); // re-place after re-centering
    }
    this._dirty = true;
  }

  /**
   * The floating paper-details card that sits over the map (bottom-right by
   * default). `this.details` is its scrollable BODY, _renderDetails and
   * _renderNotes clear/fill that, while the header (title + close) persists.
   */
  _buildDetailCard() {
    const card = this._el("div", "zcm-detail-card");
    // ALL critical visuals are inline (frame, padding, close button), so the
    // card looks right regardless of the external stylesheet.
    Object.assign(card.style, {
      display: "none", // shown on selection
      position: "absolute",
      left: "50%",
      top: "14%",
      zIndex: "30",
      flexDirection: "column",
      width: "min(360px, 90%)",
      maxHeight: "74%",
      borderRadius: "13px",
      overflow: "hidden",
      boxShadow: "0 14px 36px rgba(0,0,0,0.55)",
      background: "#161d31",
      border: "1px solid rgba(147,161,199,0.25)",
    });

    // Close button: an ABSOLUTE child pinned to the card's top-right corner,
    // so it is always visible no matter how the header lays out. High-contrast
    // so it can't be missed.
    const close = this._el("button", "zcm-detail-close", "✕");
    close.setAttribute("title", "Close (Esc)");
    Object.assign(close.style, {
      position: "absolute",
      top: "10px",
      right: "10px",
      zIndex: "3",
      width: "26px",
      height: "26px",
      padding: "0",
      borderRadius: "50%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: "14px",
      lineHeight: "1",
      cursor: "pointer",
      color: "#c7cdda",
      background: "rgba(147,161,199,0.12)",
      border: "1px solid rgba(147,161,199,0.22)",
      transition: "background 0.12s, color 0.12s",
    });
    close.addEventListener("mouseenter", () => {
      close.style.background = "rgba(224,72,72,0.25)";
      close.style.color = "#ffffff";
    });
    close.addEventListener("mouseleave", () => {
      close.style.background = "rgba(147,161,199,0.12)";
      close.style.color = "#c7cdda";
    });
    close.addEventListener("click", () => this._select(null, false));
    card.appendChild(close);

    // Draggable header (title). Right padding leaves room for the × corner.
    const head = this._el("div", "zcm-detail-head");
    Object.assign(head.style, {
      display: "flex",
      alignItems: "center",
      padding: "10px 46px 10px 18px",
      cursor: "move",
      flex: "0 0 auto",
      background: "#1b2340",
      borderBottom: "1px solid rgba(147,161,199,0.2)",
    });
    head.appendChild(this._el("span", "zcm-detail-drag", "Paper details"));
    card.appendChild(head);

    const body = this._el("div", "zcm-detail-body");
    Object.assign(body.style, {
      padding: "18px 20px 20px",
      overflowY: "auto",
      overflowX: "hidden",
      flex: "1 1 auto",
      minHeight: "0",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      wordBreak: "break-word", // long titles / DOIs wrap instead of overflowing
    });
    card.appendChild(body);
    this.details = body;
    this._detailCard = card;
    this._makeDraggable(card, head, close);
    // Esc closes the card when it's open.
    this._detailKeyHandler = (ev) => {
      if (
        ev.key === "Escape" &&
        this._detailCard &&
        this._detailCard.style.display !== "none"
      ) {
        this._select(null, false);
      }
    };
    this.doc.addEventListener("keydown", this._detailKeyHandler, true);
    return card;
  }

  /**
   * Place the details card in a consistent, roomy spot: horizontally centred
   * over the map, near the top, with space to every border. Used for BOTH
   * map/suggestion selections and Discover previews so they look identical
   * (the `node` arg is ignored; kept for call-site compatibility). Clamped so
   * the whole card, and its top-right close button, always stay on-screen.
   */
  _positionDetail(node) {
    const card = this._detailCard;
    if (!card) return;
    const w = this.width || 800;
    const h = this.height || 600;
    const cw = card.offsetWidth || 380;
    const ch = card.offsetHeight || 320;
    const m = 16; // breathing room to the stage borders
    // Bottom-right by default: out of the way (doesn't cover the map centre),
    // always fully on-screen, and the user can drag it anywhere by its header.
    let x = w - cw - m;
    let y = h - ch - m;
    x = Math.max(m, Math.min(x, w - cw - m));
    y = Math.max(m, Math.min(y, h - ch - m));
    card.style.right = "auto";
    card.style.bottom = "auto";
    card.style.left = Math.round(x) + "px";
    card.style.top = Math.round(y) + "px";
  }

  /**
   * If a previous drag left the details card partly off the stage (or the
   * stage shrank), pull it back so it stays fully visible.
   */
  _ensureDetailOnScreen() {
    const card = this._detailCard;
    if (!card || card.style.display === "none") return;
    try {
      const s = this.stage.getBoundingClientRect();
      const r = card.getBoundingClientRect();
      if (!s.width || !r.width) return;
      // only act if the card was manually moved (left/top set), else the CSS
      // bottom/right anchoring already keeps it in the corner
      if (card.style.left === "" && card.style.top === "") return;
      const m = 8;
      let left = r.left - s.left;
      let top = r.top - s.top;
      left = Math.max(m, Math.min(left, s.width - r.width - m));
      top = Math.max(m, Math.min(top, s.height - r.height - m));
      card.style.left = left + "px";
      card.style.top = top + "px";
    } catch (e) {
      /* best-effort */
    }
  }

  /** Let the user drag `el` by `handle` within the stage (ignoring `except`). */
  _makeDraggable(el, handle, except) {
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    let dragging = false;
    const onMove = (ev) => {
      if (!dragging) return;
      // switch to top/left positioning on first move
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.left = ox + dx + "px";
      el.style.top = oy + dy + "px";
    };
    const onUp = () => {
      dragging = false;
      this.doc.removeEventListener("mousemove", onMove, true);
      this.doc.removeEventListener("mouseup", onUp, true);
    };
    handle.addEventListener("mousedown", (ev) => {
      if (except && ev.target === except) return;
      const r = el.getBoundingClientRect();
      const sr = this.stage.getBoundingClientRect();
      ox = r.left - sr.left;
      oy = r.top - sr.top;
      sx = ev.clientX;
      sy = ev.clientY;
      dragging = true;
      this.doc.addEventListener("mousemove", onMove, true);
      this.doc.addEventListener("mouseup", onUp, true);
      ev.preventDefault();
    });
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
      if (di === i) d.classList.add("zcm-on");
      dots.appendChild(d);
    });
    card.appendChild(dots);
    const foot = this._el("div", "zcm-cm-foot");
    const skip = this._el("button", "zcm-btn zcm-btn-mini", last ? "Close" : "Skip");
    skip.addEventListener("click", () => this._endCoachmarks(true));
    foot.appendChild(skip);
    if (st.guideLink) {
      const g = this._el("button", "zcm-btn zcm-btn-mini", "Full guide");
      g.addEventListener("click", () => {
        this._endCoachmarks(true);
        this._showGuide();
      });
      foot.appendChild(g);
    }
    foot.appendChild(this._el("div", "zcm-spacer"));
    if (i > 0) {
      const back = this._el("button", "zcm-btn zcm-btn-mini", "Back");
      back.addEventListener("click", () => this._cmShow(this._cmPrev(i)));
      foot.appendChild(back);
    }
    const next = this._el(
      "button",
      "zcm-btn zcm-btn-primary zcm-btn-mini",
      last ? "Done" : "Next"
    );
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
   * First-run walkthrough (and the "?" button): brief cards anchored to
   * the actual controls they explain. Steps without a live anchor (e.g.
   * Discover on an imported map) are skipped automatically.
   */
  _showTour() {
    if (this._guide) this._closeGuide();
    const steps = [
      {
        title: "Your citation map",
        body:
          "Every dot is a paper, the bigger, the more the other papers " +
          "here cite it. Arrows point at the cited paper, back in time.",
      },
      {
        target: () => this.legend,
        title: "The colors",
        body:
          "Ivory = in your library · amber = suggested · grey = no " +
          "citation data. This legend always shows what the colors " +
          "currently mean.",
      },
      {
        target: () => this._mapControls,
        title: "Getting around",
        body:
          "Scroll to zoom, drag to pan, double-click a dot to open it. " +
          "Click a dot and its details appear in a small card over the map " +
          "(drag the card to move it). ⌂ fits everything back into view.",
      },
      {
        target: () => this._tabsEl,
        title: "The sidebar",
        body:
          "Suggested papers you may be missing, citation chains through " +
          "time, and your own papers with tags and notes. Drag its left " +
          "edge to resize it, or the chevron to hide it.",
      },
      {
        target: () => this._discoverCard,
        before: () => this._setSideTab("discover", false),
        title: "Discover new papers",
        body:
          "One click searches OpenAlex for papers citing yours or " +
          "matching your topics, every hit says why. Only anonymous " +
          "record IDs are sent, never your text.",
      },
      {
        target: () => this._displayBtn,
        title: "Display",
        body:
          "Choose what the colors mean, publisher, year, cluster, open " +
          "access, and reveal dashed links between papers that share " +
          "references.",
      },
      {
        target: () => this._filterBtn,
        title: "Filter",
        body: "Dim everything outside a year range or a Zotero tag.",
      },
      {
        target: () => this._reviewBtn,
        title: "Hide reviews",
        body:
          "Focus on primary research: this hides review / meta-analysis " +
          "articles from the map, and greys them out (with a flag) in the " +
          "Suggested, Discover and My papers lists.",
      },
      {
        title: "That's it!",
        body:
          "Replay this tour anytime with the ? button, the full guide " +
          "lives there too.",
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
            target: () => this._reviewBtn,
            title: "Hide reviews",
            body:
              "Hide review / meta-analysis articles from the map and grey " +
              "them out in the lists, to focus on primary research.",
          },
          {
            target: () => this.status,
            title: "New since last build",
            body:
              "Rebuilding a collection marks newly added papers and " +
              "suggestions with a gold ★ on the map and a NEW chip in the " +
              "lists.",
          },
        ],
      },
      // Future releases: add { since: "1.10", steps: [ … ] } here.
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
   * Small dismissible banner at the top of the map, for network health
   * ("warn") and collection advice ("advice"). Never modal, never blocks.
   */
  _showNotice(text, kind = "advice") {
    if (this._destroyed) return null;
    if (!this._notices) {
      this._notices = this._el("div", "zcm-notices");
      this.stage.appendChild(this._notices);
    }
    const n = this._el("div", "zcm-notice zcm-notice-" + kind);
    n.appendChild(this._el("div", "zcm-notice-text", text));
    const x = this._el("button", "zcm-notice-close", "✕");
    x.setAttribute("title", "Dismiss");
    x.addEventListener("click", () => {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    n.appendChild(x);
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
        "include more subfolders (Subfolders control), or map the whole " +
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

    const head = this._el("div", "zcm-guide-head");
    head.appendChild(this._el("div", "zcm-title-name", "How to read this map"));
    const close = this._el("button", "zcm-btn", "Close");
    close.addEventListener("click", () => this._closeGuide());
    head.appendChild(close);
    g.appendChild(head);

    const sec = (title, ...paras) => {
      g.appendChild(this._el("div", "zcm-guide-h", title));
      for (const p of paras) g.appendChild(this._el("div", "zcm-guide-p", p));
    };

    if (this.ctx && this.ctx.subInfo && this.ctx.changeScope) {
      sec(
        "Subcollections",
        "This collection has subfolders. The “Subfolders” control in the " +
          "toolbar shows how many are included and lets you change the mix at " +
          "any time, pick exactly the folders you want and the map rebuilds. " +
          "Your choice is remembered for this collection."
      );
    }

    // legend with real color dots
    g.appendChild(this._el("div", "zcm-guide-h", "The dots"));
    const legend = this._el("div", "zcm-guide-legend");
    for (const [cls, text] of [
      ["zcm-dot-library", "a paper in your library"],
      ["zcm-dot-discovered", "a suggested paper you don't have yet"],
      ["zcm-dot-unresolved", "in your library, but no citation data (usually a missing DOI)"],
    ]) {
      const li = this._el("div", "zcm-guide-legend-item");
      li.appendChild(this._el("span", "zcm-dot " + cls));
      li.appendChild(this._el("span", null, text));
      legend.appendChild(li);
    }
    g.appendChild(legend);
    g.appendChild(
      this._el(
        "div",
        "zcm-guide-p",
        "The bigger a dot, the more often it is cited by the other papers " +
          "of this collection, the biggest dots are the foundations of " +
          "your reading list."
      )
    );

    sec(
      "The arrows",
      "An arrow points from the citing paper to the cited one, it always " +
        "points backwards in time, toward the foundations."
    );
    sec(
      "Clusters & islands",
      "Papers connected by citations are grouped together, so a well-cited " +
        "hub sits in the middle of its group with the papers that cite it " +
        "arranged around the edge. Separate groups form their own islands: a " +
        "pair of papers that only cite each other becomes a little island of " +
        "its own next to the main network, and papers with no citation links " +
        "at all (often those without a DOI) gather in a tidy block off to the " +
        "side."
    );
    sec(
      "Suggested tab (amber) vs Discover tab (violet): the key difference",
      "These are two DIFFERENT things, now in two separate sidebar tabs. " +
        "SUGGESTED is worked out instantly from your own papers' reference " +
        "lists (no web search, no waiting): the works several of your papers " +
        "already cite but you don't own. DISCOVER is a live web search of " +
        "OpenAlex for papers BEYOND your library, including brand-new work " +
        "that cites yours. Rule of thumb: Suggested = what your collection " +
        "already points to; Discover = what's out there that you'd have to " +
        "search for."
    );
    sec(
      "The Suggested tab (amber)",
      "When several of your papers all cite the same external work that is " +
        "missing from your library, it becomes a suggestion (×N = cited by " +
        "N of your papers). These are usually papers worth knowing. Click a " +
        "row to reveal it on the map; select a paper and use “Add to Zotero” " +
        "to import it by DOI.",
      "The controls at the top of the tab set how suggestions appear ON THE " +
        "MAP, Off / Top (the strongest few, drawn softly) / All, and the " +
        "×N strength floor (cited by at least 2, 3 or 4 of your papers). " +
        "Suggestions are ranked by how many of your papers cite them AND how " +
        "well their topics match your collection, so a topically relevant " +
        "paper can outrank a generic, famous methods paper."
    );
    sec(
      "The Discover tab (violet), a live search",
      "Discover searches OpenAlex on demand. Under “Search for”, pick any " +
        "of: papers that CITE yours (how you find brand-new work building on " +
        "your reading list), papers on the same topics (parallel literature " +
        "that may not cite yours at all), and related papers. “Published” " +
        "limits by time (Any time / Last 2, 5, 10 years / a custom year). " +
        "“Limit to topics” narrows the search to the topics you tick.",
      "Every result explains itself with chips (cites N of yours, related " +
        "×N, shared topics). “Add to Zotero” imports it (with a “Show in " +
        "library” shortcut afterwards); “Show on map” drops it on the map " +
        "with a violet halo, and the same button becomes “Remove from map” " +
        "so nothing is permanent, or use “Clear discovered papers from " +
        "map”. Privacy: only OpenAlex record and topic IDs are sent; the " +
        "key terms line is computed on your machine and never leaves it."
    );
    sec(
      "Colors, cluster names & filters",
      "By default dots are colored by TYPE (library / suggested / no-data). " +
        "The Display button can instead color by Publisher (a rim in the " +
        "journal's brand color, “color by journal”), Year (blue = old, " +
        "warm = recent), Cluster (each citation island in its own color), or " +
        "Access (open-access status). The toolbar legend always spells out " +
        "the current colors, hover any legend entry for its meaning, " +
        "including what Gold / Green / Hybrid / Bronze / Closed access mean. " +
        "Each island is also labelled with the topic its papers share.",
      "The Filter button dims papers outside a year range or a chosen " +
        "Zotero tag, the layout stays put, so you can flip filters on and " +
        "off freely. Drag the divider between the map and the sidebar to " +
        "resize it, or use the chevron to hide the sidebar entirely."
    );
    sec(
      "Hide reviews",
      "The “Hide reviews” toggle in the toolbar lets you focus on primary " +
        "research: review and meta-analysis articles are removed from the " +
        "map and greyed out (with a “review” flag) in the Suggested, " +
        "Discover and My papers lists. Reviews are spotted from OpenAlex's " +
        "work type, telltale titles (systematic review, meta-analysis, " +
        "“recent advances in …”) and review-journal names (Nature Reviews, " +
        "Annual Review of …, Trends in …). The My papers panel also has its " +
        "own checkbox for the same thing."
    );
    sec(
      "Coupling links (dashed)",
      "Two of your papers that share many references are “siblings”, even " +
        "when neither cites the other. The Display popover can draw these " +
        "bibliographic-coupling links as a dashed layer, especially " +
        "revealing in young collections where direct citations are rare. " +
        "The strength chips set how many shared references count as a link."
    );
    sec(
      "New since last build (★)",
      "When you rebuild a collection you've mapped before, papers and " +
        "suggestions that weren't there last time get a small gold star on " +
        "the map and a NEW chip in the sidebar, so you can see at a " +
        "glance what changed."
    );

    // chain mini-diagram
    g.appendChild(this._el("div", "zcm-guide-h", "Citation chains (teal)"));
    const dia = this._el("div", "zcm-guide-chain");
    const mkDot = (num, year) => {
      const d = this._el("span", "zcm-guide-chain-dot");
      d.appendChild(this._el("span", "zcm-guide-chain-num", num));
      d.appendChild(this._el("span", "zcm-guide-chain-year", year));
      return d;
    };
    dia.appendChild(mkDot("1", "1998"));
    dia.appendChild(this._el("span", "zcm-guide-chain-arrow", "⟵ cites"));
    dia.appendChild(mkDot("2", "2007"));
    dia.appendChild(this._el("span", "zcm-guide-chain-arrow", "⟵ cites"));
    dia.appendChild(mkDot("3", "2019"));
    g.appendChild(dia);
    g.appendChild(
      this._el(
        "div",
        "zcm-guide-p",
        "A chain is a paper trail through time: paper 2 cites paper 1, " +
          "paper 3 cites paper 2, the same thread of an idea, handed on. " +
          "Click a chain in the sidebar to light it up as an animated teal " +
          "thread; the numbered badges run from the oldest paper (1) to the " +
          "newest, and the expanded sidebar row lists every step."
      )
    );

    sec(
      "Journal branding",
      "Each paper is tinted with its journal's own corporate identity: the " +
        "dot's outline and the journal name take on the publisher's brand " +
        "colour and a matching typeface, the black-and-red of Nature, IEEE " +
        "blue, the red Lancet masthead, Cell Press, JAMA, PLOS, MDPI and " +
        "many more, so you can tell at a glance where a paper was published.",
      "Journals we don't recognise keep the neutral house style rather than " +
        "guessing. For publishers that don't use one identity across all " +
        "their titles the match is a best-effort visual cue (flagged in the " +
        "details panel), never an exact reproduction, and no logos are ever " +
        "downloaded. You can turn all of this off with the " +
        "“journalBranding” setting in the Config Editor."
    );
    sec(
      "Timeline mode",
      "The Timeline button arranges papers into one column per publication " +
        "year, oldest on the left, so you can see at a glance what came " +
        "first. Years with more papers get a wider block, and empty years " +
        "are skipped, so a busy stretch like 2020-2026 spreads out into " +
        "readable columns instead of piling up. Papers without a year get " +
        "their own “undated” column on the far left."
    );
    sec(
      "Getting around",
      "Scroll to zoom (toward the cursor) · drag the background to pan · " +
        "drag a dot to pin it (double-click it to release) · click a dot " +
        "for details, notes and actions · double-click a dot to open it in " +
        "your library or on doi.org · ⌂ or double-clicking the background " +
        "fits everything back into view."
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
    this.stage.appendChild(ov);
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
      const pane = Zotero.getActiveZoteroPane();
      this.win.Zotero_Tabs.select("zotero-pane");
      await pane.selectItem(node.zoteroItemID);
    } catch (e) {
      Zotero.debug("[Citation Map] selectItem failed: " + e);
    }
  }

  /** Import a discovered paper into the mapped collection via its DOI. */
  async _addDiscovered(node, button) {
    button.disabled = true;
    button.textContent = "Adding…";
    if (this._detailMsg) this._detailMsg.style.display = "none";
    try {
      const item = await this._importByDOI(node.doi, this.ctx.collectionID);
      node.kind = "library";
      node.zoteroItemID = item.id;
      button.textContent = "Added ✓";
      this._dirty = true;
      // re-render details so it now shows "Show in library" + notes
      this._renderDetails(node);
    } catch (e) {
      Zotero.debug("[Citation Map] Add by DOI failed: " + e);
      button.disabled = false;
      button.textContent = "Add to Zotero";
      if (this._detailMsg) {
        this._detailMsg.textContent =
          "Couldn't add it automatically. Use “Open DOI”, then add it in " +
          "Zotero.";
        this._detailMsg.style.display = "block";
      }
    }
  }

  // ================================================================ export

  async _pickSavePath(suggested, extLabel, ext) {
    let FilePicker;
    try {
      ({ FilePicker } = ChromeUtils.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs"
      ));
    } catch (e) {
      ({ FilePicker } = ChromeUtils.import(
        "chrome://zotero/content/modules/filePicker.jsm"
      ));
    }
    const fp = new FilePicker();
    fp.init(this.win, "Save " + extLabel, fp.modeSave);
    fp.appendFilter(extLabel, "*." + ext);
    fp.defaultString = suggested;
    const rv = await fp.show();
    if (rv !== fp.returnOK && rv !== fp.returnReplace) return null;
    return fp.file;
  }

  async _exportPNG() {
    const path = await this._pickSavePath("citation-map.png", "PNG image", "png");
    if (!path) return;
    const blob = await new Promise((res) => this.canvas.toBlob(res, "image/png"));
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
    if (this._scopeHintTimer) this.win.clearTimeout(this._scopeHintTimer);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._onWinResize) {
      this.win.removeEventListener("resize", this._onWinResize);
      this._onWinResize = null;
    }
    if (this._detailKeyHandler) {
      this.doc.removeEventListener("keydown", this._detailKeyHandler, true);
      this._detailKeyHandler = null;
    }
    if (this.root && this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
  }
};
