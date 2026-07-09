/**
 * graphView.js — the interactive map itself.
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
 * Rendering: custom force-directed layout (O(n²) repulsion per tick —
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
    // then stays still — no multi-second live "wobble" every time.
    this._preSettle();
    this._fitView();
    this._dirty = true;
    this._animate();

    // First ever map: open the guide once, so the colors/arrows/chains
    // are explained before the user has to ask.
    if (!Zotero.Prefs.get("extensions.citation-map.guideShown", true)) {
      this._showGuide();
      try {
        Zotero.Prefs.set("extensions.citation-map.guideShown", true, true);
      } catch (e) {
        /* pref write is best-effort */
      }
    }
  }

  // ================================================================ model

  _prepare() {
    const g = this.graph;
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
    // instead of piling up.
    this.layoutScale = Math.max(1, Math.sqrt(g.nodes.length / 80));

    g.nodes.forEach((n, i) => {
      // node radius: base + in-library citations (how central it is to YOU)
      n.r = Math.min(22, 6.5 + Math.sqrt(n.inLibraryCitations) * 4);
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
   *     leaves at the edge — so structure is visible);
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
    // biggest cluster first — it becomes the central island
    multi.sort((a, b) => b.length - a.length);

    const restLen = 150 * ls;
    const cellSize = 2 * 22 + 18; // grid cell for unconnected papers

    // Estimate each cluster's on-screen radius (a generous over-estimate,
    // so packed islands never overlap → no boundary jitter).
    const entries = multi.map((g) => ({
      nodes: g,
      radius: restLen * (0.7 + 0.85 * Math.sqrt(g.length)),
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
    const gap = 60 * ls;
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
    for (const e of entries) {
      if (e === singlesEntry) continue;
      this._compGroups.push(e.nodes);
      e.nodes.forEach((n, i) => {
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

    // How far the packed islands reach — the force step's safety cap must
    // not clip a distant island back toward the centre.
    this._arena =
      entries.reduce(
        (m, e) => Math.max(m, Math.hypot(e.cx, e.cy) + e.radius),
        0
      ) + 400 * ls;
  }

  /**
   * Decide which suggested papers take part in the map at all.
   * "off"  — none (sidebar list still has them)
   * "top"  — only the strongest few, drawn softly ("teased")
   * "all"  — every suggestion that passes the ×N filter
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

  /** Visible nodes/edges — hidden suggestions play no part in forces,
   *  drawing, hit-testing or view fitting. */
  _active() {
    if (!this._activeNodes) {
      this._activeNodes = this.graph.nodes.filter((n) => !n.hidden);
      this._activeEdges = this.graph.edges.filter((e) => {
        const s = this.nodeByKey.get(e.source);
        const t = this.nodeByKey.get(e.target);
        return s && t && !s.hidden && !t.hidden;
      });
    }
    return { nodes: this._activeNodes, edges: this._activeEdges };
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
    // a new toggle state is a fresh look — drop one-off reveals
    for (const n of this.graph.nodes) n.revealed = false;
    this._applySuggestionVisibility();
  }

  // ================================================================== DOM

  _el(tag, cls, text) {
    const el = this.doc.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
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

    // suggested papers on the map: off / top few (teased) / all
    const sWrap = this._el("div", "zcm-ctl");
    sWrap.appendChild(this._el("span", "zcm-ctl-label", "Suggestions"));
    const sTog = this._el("div", "zcm-toggle");
    this._suggBtns = {};
    for (const [val, label, tip] of [
      ["off", "Off", "No suggested papers on the map (the sidebar keeps the list)"],
      [
        "top",
        "Top",
        `Only the ${this.suggestTopCount} strongest suggestions, drawn softly`,
      ],
      ["all", "All", "Every suggestion that passes the ×N filter"],
    ]) {
      const b = this._el("button", "zcm-toggle-btn", label);
      b.setAttribute("title", tip);
      if (val === this.suggestDisplay) b.classList.add("zcm-on");
      b.addEventListener("click", () => this._setSuggestDisplay(val));
      this._suggBtns[val] = b;
      sTog.appendChild(b);
    }
    sWrap.appendChild(sTog);
    bar.appendChild(sWrap);

    const spacer = this._el("div", "zcm-spacer");
    bar.appendChild(spacer);

    // legend
    const legend = this._el("div", "zcm-legend");
    for (const [cls, label] of [
      ["zcm-dot-library", "In your library"],
      ["zcm-dot-discovered", "Suggested"],
      ["zcm-dot-unresolved", "No citation data"],
    ]) {
      const li = this._el("span", "zcm-legend-item");
      li.appendChild(this._el("span", "zcm-dot " + cls));
      li.appendChild(this._el("span", null, label));
      legend.appendChild(li);
    }
    bar.appendChild(legend);

    for (const [label, fn, titleTip] of [
      ["Export PNG", () => this._exportPNG(), "Save the map as an image"],
      ["Export JSON", () => this._exportJSON(), "Save nodes and edges as JSON"],
      ["Rebuild", () => this.ctx.rebuild(), "Re-fetch citation data and redraw"],
    ]) {
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
    stage.appendChild(this.canvas);
    this.tooltip = this._el("div", "zcm-tooltip");
    stage.appendChild(this.tooltip);

    // floating map controls (top-right corner of the canvas)
    const controls = this._el("div", "zcm-map-controls");
    for (const [label, tip, fn] of [
      ["+", "Zoom in", () => this._zoomBy(1.3)],
      ["−", "Zoom out", () => this._zoomBy(1 / 1.3)],
      ["⌂", "Fit the whole map into view", () => this._fitView()],
      ["?", "How to read this map", () => this._showGuide()],
    ]) {
      const b = this._el("button", "zcm-map-btn", label);
      b.setAttribute("title", tip);
      b.addEventListener("click", fn);
      controls.appendChild(b);
    }
    stage.appendChild(controls);

    main.appendChild(stage);
    this.stage = stage;

    main.appendChild(this._buildSidebar());
    root.appendChild(main);

    // ---- status strip
    const s = this.graph.stats;
    this.status = this._el(
      "div",
      "zcm-status",
      `${s.items} items · ${s.resolved} resolved · ${s.edges} citation links · ` +
        `${s.discovered} suggested papers · scroll = zoom · drag = pan · ` +
        `⌂ = fit view · ? = guide`
    );
    root.appendChild(this.status);

    this.container.appendChild(root);
    this._attachCanvasEvents();
    this._resize();
    this._resizeObserver = new this.win.ResizeObserver(() => {
      this._resize();
      this._dirty = true;
    });
    this._resizeObserver.observe(stage);
  }

  _buildSidebar() {
    const side = this._el("div", "zcm-side");

    // details card (filled on selection)
    this.details = this._el("div", "zcm-card zcm-details");
    this.details.appendChild(
      this._el("div", "zcm-empty", "Select a paper on the map to see its details.")
    );
    side.appendChild(this.details);

    // discovered papers
    const disc = this._el("div", "zcm-card");
    disc.appendChild(this._el("div", "zcm-card-head", "Suggested papers"));
    disc.appendChild(
      this._el(
        "div",
        "zcm-card-sub",
        "Missing from your library, but cited by your papers (×N = by how " +
          "many). The toolbar toggle controls the map; the full list lives " +
          "here — clicking a hidden one reveals it."
      )
    );

    // strength filter: minimum number of your papers citing the suggestion
    const chips = this._el("div", "zcm-chips");
    disc.appendChild(chips);
    const list = this._el("div");
    disc.appendChild(list);

    const renderList = () => {
      list.textContent = "";
      const discovered = this.graph.nodes
        .filter(
          (n) =>
            n.kind === "discovered" &&
            n.inLibraryCitations >= this.suggestMinCiters
        )
        .sort(
          (a, b) =>
            b.inLibraryCitations - a.inLibraryCitations ||
            (b.citedByCount || 0) - (a.citedByCount || 0)
        );
      if (!discovered.length) {
        list.appendChild(
          this._el("div", "zcm-empty", "No suggestions at this strength.")
        );
      }
      for (const n of discovered) {
        const row = this._el("div", "zcm-row");
        const meta = this._el("div", "zcm-row-meta");
        meta.appendChild(
          this._el("span", "zcm-badge", `×${n.inLibraryCitations}`)
        );
        meta.appendChild(this._el("span", "zcm-year", n.year || "—"));
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

    for (const v of [2, 3, 4]) {
      const chip = this._el("button", "zcm-chip", `×${v}+`);
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
        renderList();
      });
      chips.appendChild(chip);
    }
    renderList();
    side.appendChild(disc);

    // chains
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
            `${this._label(n)} — ${this._short(n.title)}`
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
          // a chain may run through a hidden suggestion — reveal it
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
    side.appendChild(ch);
    return side;
  }

  _short(t) {
    if (!t) return "?";
    return t.length > 42 ? t.slice(0, 40) + "…" : t;
  }

  /**
   * Resolve (and memoise on the node) the publisher corporate-identity style
   * for this paper's venue — brand colour, logo-style font stack, confidence.
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
    d.style.borderLeft = ""; // reset any previous brand accent
    if (!node) {
      d.appendChild(
        this._el("div", "zcm-empty", "Select a paper on the map to see its details.")
      );
      return;
    }
    // Publisher brand accent down the left edge of the card (secondary colour,
    // brightened for the dark panel) when the journal is recognised.
    const ci = this._ci(node);
    if (ci && ci.matched && ZCM_VIEW_NS.PublisherCI) {
      const accent = ci.secondary || ci.primary;
      if (accent) {
        d.style.borderLeft = "3px solid " + ZCM_VIEW_NS.PublisherCI.onDark(accent);
      }
    }
    const kindLabel = {
      library: "In your library",
      discovered: "Suggested — not in your library",
      unresolved: "In your library · no citation data found",
    }[node.kind];
    d.appendChild(this._el("div", "zcm-kind zcm-kind-" + node.kind, kindLabel));
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
    // note for low-confidence matches — see PublisherCI confidence levels).
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
    stats.appendChild(
      this._el("span", "zcm-year", `${node.inLibraryCitations} in this collection`)
    );
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
    d.appendChild(actions);

    // Zotero / Better Notes attached to this item, previewed in place.
    if (node.zoteroItemID) {
      this._renderNotes(node).catch((e) =>
        Zotero.debug("[Citation Map] Notes preview failed: " + e)
      );
    }
  }

  /** Preview the item's child notes (works for Better Notes too — it
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
   * The user never sees the settling motion — the map simply appears calm
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
    if (this.mode === "timeline") this._tickTimeline();
    else this._tickForce();
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
   *    its cluster's fixed anchor — so structure shows (hubs central,
   *    leaves at the edge) and separate clusters stay as distinct islands
   *  - soft springs + strong damping + a speed limit → no oscillation
   *  - a collision pass keeps dots from overlapping
   *  - hidden suggestions take no part at all
   */
  _tickForce() {
    const { nodes, edges } = this._active();
    const a = this.alpha;
    const ls = this.layoutScale;

    // Repulsion — only between papers in the SAME citation cluster, so a
    // cluster spreads itself out without shoving neighbouring islands away.
    const rep = 2200 * ls * ls;
    const cutoff2 = 560 * 560 * ls * ls;
    for (const group of this._compGroups) {
      for (let i = 0; i < group.length; i++) {
        const n1 = group[i];
        if (n1.hidden) continue;
        for (let j = i + 1; j < group.length; j++) {
          const n2 = group[j];
          if (n2.hidden) continue;
          let dx = n2.x - n1.x;
          let dy = n2.y - n1.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          if (d2 > cutoff2) continue; // ignore far pairs
          const f = (rep * a) / d2;
          const d = Math.sqrt(d2);
          dx = (dx / d) * f;
          dy = (dy / d) * f;
          n1.vx -= dx;
          n1.vy -= dy;
          n2.vx += dx;
          n2.vy += dy;
        }
      }
    }

    // Springs along visible edges — soft on purpose; a stiff spring makes
    // the whole layout overshoot and wobble.
    const rest = 150 * ls;
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
      // speed limit — the layout may converge, never buzz
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
    const pad = 10;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const n1 = nodes[i];
        const n2 = nodes[j];
        const dx = n2.x - n1.x;
        const dy = n2.y - n1.y;
        const minD = n1.r + n2.r + pad;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD) continue;
        const d = Math.sqrt(d2) || 1;
        const overlap = (minD - d) / 2;
        let px = (dx / d) * overlap;
        let py = (dy / d) * overlap;
        if (d2 === 0) {
          px = 0;
          py = (i % 2 ? 1 : -1) * overlap;
        }
        if (!n1.fixed) {
          n1.x -= px;
          n1.y -= py;
        }
        if (!n2.fixed) {
          n2.x += px;
          n2.y += py;
        }
      }
    }

    this.alpha *= 0.975;
  }

  /**
   * Timeline layout: a deterministic grid of per-year columns ("sub-maps").
   *
   * Papers are grouped by publication year; each populated year becomes a
   * column band placed left→right in chronological order, so the oldest
   * work is always at the far left. Empty years are skipped (they add no
   * value), and a year's band grows wider the more papers it holds — so a
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
    const cell = 2 * maxR + 16; // grid cell — no two dots can overlap
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
    this.mode = mode;
    this.btnForce.classList.toggle("zcm-on", mode === "force");
    this.btnTime.classList.toggle("zcm-on", mode === "timeline");
    if (mode === "timeline") {
      this._computeTimelineLayout();
      this.alpha = 1; // ease into the grid
    } else {
      this.alpha = 0.5; // let the forces reflow
    }
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
    this.width = Math.max(50, rect.width);
    this.height = Math.max(50, rect.height);
    const dpr = this.win.devicePixelRatio || 1;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = this.width + "px";
    this.canvas.style.height = this.height + "px";
    this.dpr = dpr;
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
   * Rescale and center so the whole graph — every island included — fits
   * into the viewport. The layout is deterministic and bounded now, so
   * there are no stray fliers to trim against.
   */
  _fitView() {
    const nodes = this._active().nodes;
    if (!nodes.length) return;
    // Stage collapsed (tab hidden / mid-layout): don't fit against a
    // bogus viewport — the next call will retry with real dimensions.
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
      0.08, // allow zooming far enough out to show a wide field of islands
      Math.min(2, Math.min((this.width - 90) / w, (this.height - 90) / h))
    );
    this.transform.k = k;
    this.transform.x = (-(minX + maxX) / 2) * k;
    this.transform.y = (-(minY + maxY) / 2) * k;
    this._didInitialFit = true;
    this._dirty = true;
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
    // only redrawn when something actually changed — a static, settled map
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
    if (redraw) this._draw();
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
      text: this._css("--zcm-text") || "#e9ecf5",
      muted: this._css("--zcm-muted") || "#8e96b0",
      bg: this._css("--zcm-bg") || "#0e1424",
    };
    const activeEdges = this._active().edges;
    // dense graphs get fainter edges so the dots stay in front
    const baseEdgeAlpha =
      activeEdges.length > 400 ? 0.18 : activeEdges.length > 150 ? 0.26 : 0.35;

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
        // one evenly-spaced header per band — no overlap, unlike the old rail
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
      ctx.lineWidth = (onChain ? 2.4 : 1.1) / k;
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
      const sz = (onChain ? 7 : 5) / k;
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
      if (n.hidden) continue;
      const matches =
        !this.query ||
        n.title.toLowerCase().includes(this.query) ||
        (n.authors || []).some((a) => a.toLowerCase().includes(this.query));
      let dim = false;
      if (this.query && !matches) dim = true;
      if (focusSet && !focusSet.has(n.key)) dim = true;
      if (this.activeChain && !chainSet.has(n.key)) dim = true;

      // teased suggestions ("Top" mode) are shown softly, as an invitation
      const baseAlpha = n.teased && !dim ? 0.55 : 1;
      ctx.globalAlpha = dim ? 0.15 : baseAlpha;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = colors[n.kind] || colors.library;
      ctx.fill();
      // Rim: for papers from a recognised journal, use the publisher's brand
      // colour (brightened to stay visible on the dark map) so the source is
      // identifiable at a glance; otherwise a subtle dark rim to separate
      // touching dots. Fill still encodes the node KIND (library/suggested).
      const ci = this._ci(n);
      if (ci && ci.matched && ci.primary && ZCM_VIEW_NS.PublisherCI) {
        ctx.strokeStyle = ZCM_VIEW_NS.PublisherCI.onDark(ci.primary);
        ctx.lineWidth = 1.8 / k;
      } else {
        ctx.strokeStyle = "rgba(10, 14, 26, 0.5)";
        ctx.lineWidth = 1 / k;
      }
      ctx.stroke();

      if (n.kind === "discovered" && !dim) {
        // soft amber halo — "you should look at this"
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 5 / k, 0, Math.PI * 2);
        ctx.strokeStyle = colors.discovered;
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

      // Labels: a budget keeps the map readable — only the most-cited
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
      if (n.hidden) continue;
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

    c.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      // gentle steps — strong zoom made the map easy to lose
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
      this._dirty = true;
    });

    c.addEventListener("mousemove", (ev) => {
      const p = this._toGraphCoords(ev);
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
      const n = this._nodeAt(this._toGraphCoords(ev));
      this._select(n ? n.key : null, false);
    });

    c.addEventListener("dblclick", (ev) => {
      const n = this._nodeAt(this._toGraphCoords(ev));
      if (!n) {
        this._fitView(); // double-click the background = reframe everything
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
    const kindLabel = {
      library: "In your library",
      discovered: `Suggested — cited by ${node.inLibraryCitations} of your papers`,
      unresolved: "In your library · no citation data",
    }[node.kind];
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
    if (node && center) {
      this.transform.x = -node.x * this.transform.k;
      this.transform.y = -node.y * this.transform.k;
      this._clampTransform();
    }
    this._dirty = true;
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
          "of this collection — the biggest dots are the foundations of " +
          "your reading list."
      )
    );

    sec(
      "The arrows",
      "An arrow points from the citing paper to the cited one — it always " +
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
      "Suggested papers (amber)",
      "When several of your papers all cite the same external work that is " +
        "missing from your library, it becomes a suggestion (×N = cited by " +
        "N of your papers). These are usually papers worth knowing. Select " +
        "one and click “Add to Zotero” to import it by DOI.",
      "The “Suggestions” toggle in the toolbar controls the map: Off keeps " +
        "them out entirely, Top softly teases only the strongest few, All " +
        "shows everything. The ×N filter in the sidebar raises the bar for " +
        "what counts as a suggestion — the full list always lives in the " +
        "sidebar, and clicking a hidden one reveals it on the map."
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
          "paper 3 cites paper 2 — the same thread of an idea, handed on. " +
          "Click a chain in the sidebar to light it up as an animated teal " +
          "thread; the numbered badges run from the oldest paper (1) to the " +
          "newest, and the expanded sidebar row lists every step."
      )
    );

    sec(
      "Journal branding",
      "Each paper is tinted with its journal's own corporate identity: the " +
        "dot's outline and the journal name take on the publisher's brand " +
        "colour and a matching typeface — the black-and-red of Nature, IEEE " +
        "blue, the red Lancet masthead, Cell Press, JAMA, PLOS, MDPI and " +
        "many more — so you can tell at a glance where a paper was published.",
      "Journals we don't recognise keep the neutral house style rather than " +
        "guessing. For publishers that don't use one identity across all " +
        "their titles the match is a best-effort visual cue (flagged in the " +
        "details panel), never an exact reproduction — and no logos are ever " +
        "downloaded. You can turn all of this off with the " +
        "“journalBranding” setting in the Config Editor."
    );
    sec(
      "Timeline mode",
      "The Timeline button arranges papers into one column per publication " +
        "year, oldest on the left — so you can see at a glance what came " +
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
        "are cached locally — rebuilding a map is nearly instant. Items " +
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
    try {
      const translate = new Zotero.Translate.Search();
      translate.setIdentifier({ DOI: node.doi });
      const translators = await translate.getTranslators();
      if (!translators.length) throw new Error("No translator found for DOI");
      translate.setTranslator(translators);
      const items = await translate.translate({
        libraryID: Zotero.Libraries.userLibraryID,
        collections: this.ctx.collectionID ? [this.ctx.collectionID] : false,
      });
      if (items && items.length) {
        node.kind = "library";
        node.zoteroItemID = items[0].id;
        button.textContent = "Added ✓";
        this._renderDetails(node);
      } else {
        throw new Error("Nothing imported");
      }
    } catch (e) {
      Zotero.debug("[Citation Map] Add by DOI failed: " + e);
      button.disabled = false;
      button.textContent = "Add to Zotero";
      this.win.alert(
        "Could not import this paper automatically.\nDOI: " + node.doi
      );
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
    const data = {
      generated: new Date().toISOString(),
      collection: this.ctx.collectionName,
      nodes: this.graph.nodes.map(({ vx, vy, fixed, r, _ci, ...n }) => n),
      edges: this.graph.edges,
      chains: this.graph.chains,
    };
    await IOUtils.writeUTF8(path, JSON.stringify(data, null, 2));
  }

  // =============================================================== teardown

  destroy() {
    this._destroyed = true;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this.root && this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
  }
};
