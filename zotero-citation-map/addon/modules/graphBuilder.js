/**
 * graphBuilder.js — pure graph logic. No UI, no network.
 *
 * Input : Zotero items + OpenAlex records (from dataSource.js)
 * Output: a plain-object graph model consumed by graphView.js:
 *
 *   {
 *     nodes: [{ key, kind, title, year, authors, venue, doi, zoteroItemID,
 *               citedByCount, inLibraryCitations }],
 *     edges: [{ source, target }],          // source CITES target (by key)
 *     chains: [[key, key, key, ...], ...],  // longest citation chains
 *     stats: { items, resolved, edges, discovered }
 *   }
 *
 * Node kinds:
 *   "library"     - a paper in the user's collection, resolved via OpenAlex
 *   "unresolved"  - in the collection but no DOI / not found in OpenAlex
 *   "discovered"  - NOT in the library, but cited by >= threshold library papers
 *
 * Loaded into the CitationMap namespace (`this` === CitationMap).
 */

/* global Zotero */

// `this` is the shared CitationMap namespace while this script loads;
// capture it so methods can reach sibling modules regardless of call site.
const ZCM_NS = this;

this.GraphBuilder = {
  /**
   * Build the full graph model.
   *
   * @param {Zotero.Item[]} items - regular (non-attachment) items to map
   * @param {function} onProgress - (phaseLabel, done, total)
   */
  async build(items, onProgress) {
    const DS = ZCM_NS.DataSource;

    // ---- 1. Gather DOIs from the Zotero items --------------------------
    const itemInfo = []; // { item, doi }
    for (const item of items) {
      const doi = DS.normalizeDOI(
        item.getField("DOI") || this._doiFromExtra(item)
      );
      itemInfo.push({ item, doi });
    }
    const dois = [...new Set(itemInfo.map((i) => i.doi).filter(Boolean))];

    // ---- 2. Resolve them against OpenAlex (cached) ---------------------
    const byDOI = await DS.fetchWorksByDOI(dois, (d, t) =>
      onProgress("Resolving papers", d, t)
    );

    // ---- 3. Create library / unresolved nodes ---------------------------
    const nodes = new Map(); // key -> node
    const oaToKey = new Map(); // OpenAlex ID -> node key

    for (const { item, doi } of itemInfo) {
      const record = doi ? byDOI.get(doi) : null;
      const key = "z" + item.id;
      if (nodes.has(key)) continue;
      if (record) {
        const node = this._node(key, "library", record, item.id);
        // The user's own metadata wins: OpenAlex's publication_year is
        // often the early-online year, one off from the item's real date.
        node.year = this._yearFromItem(item) || node.year;
        nodes.set(key, node);
        oaToKey.set(record.id, key);
      } else {
        nodes.set(key, {
          key,
          kind: "unresolved",
          title: item.getField("title") || "(untitled)",
          year: this._yearFromItem(item),
          authors: [item.getField("firstCreator")].filter(Boolean),
          venue: item.getField("publicationTitle") || null,
          doi,
          zoteroItemID: item.id,
          citedByCount: 0,
          inLibraryCitations: 0,
          references: [],
        });
      }
    }

    // ---- 4. Internal edges + tally external citations -------------------
    const edges = [];
    const externalCounts = new Map(); // OpenAlex ID -> [citing node keys]

    for (const node of nodes.values()) {
      if (node.kind !== "library") continue;
      for (const refID of node.references) {
        const targetKey = oaToKey.get(refID);
        if (targetKey && targetKey !== node.key) {
          edges.push({ source: node.key, target: targetKey });
        } else if (!targetKey) {
          if (!externalCounts.has(refID)) externalCounts.set(refID, []);
          externalCounts.get(refID).push(node.key);
        }
      }
    }

    // ---- 5. Discovery engine --------------------------------------------
    // External works cited by >= threshold library papers become
    // "discovered" suggestions, ranked by how many of YOUR papers cite them.
    const threshold =
      Zotero.Prefs.get("extensions.citation-map.discoveryThreshold", true) || 2;
    const maxDiscovered =
      Zotero.Prefs.get("extensions.citation-map.maxDiscovered", true) || 15;

    // Fetch more candidates than we will show, so junk records (no title,
    // no year) and works that turn out to already be in the library can be
    // filtered out without leaving the list half-empty.
    const candidates = [...externalCounts.entries()]
      .filter(([, citers]) => citers.length >= threshold)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, Math.min(60, maxDiscovered * 2));

    if (candidates.length) {
      onProgress("Looking up discovered papers", 0, candidates.length);
      const discovered = await DS.fetchWorksByOpenAlexId(
        candidates.map(([id]) => id)
      );

      const libByDOI = new Map(); // doi -> existing node key
      for (const n of nodes.values()) {
        if (n.doi) libByDOI.set(n.doi, n.key);
      }

      const valid = [];
      for (const [oaID, citers] of candidates) {
        const record = discovered.get(oaID);
        if (!record || !record.title || record.title === "(untitled)") continue;
        const existingKey = record.doi ? libByDOI.get(record.doi) : null;
        if (existingKey) {
          // Already in the library (its DOI just failed to resolve in
          // step 2) — wire the edges to the existing node instead of
          // suggesting a paper the user owns.
          const existing = nodes.get(existingKey);
          if (existing.kind === "unresolved") {
            existing.kind = "library";
            existing.year = existing.year || record.year;
            existing.venue = existing.venue || record.venue;
            existing.citedByCount = record.citedByCount;
          }
          oaToKey.set(oaID, existingKey);
          for (const citer of citers) {
            if (citer !== existingKey) {
              edges.push({ source: citer, target: existingKey });
            }
          }
          continue;
        }
        valid.push({ oaID, citers, record });
      }

      // Rank: most in-library citers first; worldwide citations break ties.
      valid.sort(
        (a, b) =>
          b.citers.length - a.citers.length ||
          (b.record.citedByCount || 0) - (a.record.citedByCount || 0)
      );
      for (const { oaID, citers, record } of valid.slice(0, maxDiscovered)) {
        const key = "d" + oaID;
        const node = this._node(key, "discovered", record, null);
        node.inLibraryCitations = citers.length;
        nodes.set(key, node);
        oaToKey.set(oaID, key);
        for (const citer of citers) {
          edges.push({ source: citer, target: key });
        }
      }
    }

    // Tally in-library citation counts (drives node size on the map).
    for (const e of edges) {
      const t = nodes.get(e.target);
      if (t && t.kind === "library") t.inLibraryCitations++;
    }

    // ---- 6. Citation chains ----------------------------------------------
    const minChain =
      Zotero.Prefs.get("extensions.citation-map.minChainLength", true) || 3;
    const chains = this._findChains(nodes, edges, minChain);

    // References are internal plumbing; drop before handing to the view.
    for (const n of nodes.values()) delete n.references;

    return {
      nodes: [...nodes.values()],
      edges,
      chains,
      stats: {
        items: items.length,
        resolved: [...nodes.values()].filter((n) => n.kind === "library").length,
        edges: edges.length,
        discovered: [...nodes.values()].filter((n) => n.kind === "discovered")
          .length,
      },
    };
  },

  _node(key, kind, record, zoteroItemID) {
    return {
      key,
      kind,
      title: record.title,
      year: record.year,
      authors: record.authors,
      venue: record.venue,
      doi: record.doi,
      zoteroItemID,
      citedByCount: record.citedByCount,
      inLibraryCitations: 0,
      references: record.references || [],
    };
  },

  /**
   * Publication year of a Zotero item, parsed robustly. Zotero's Date field
   * is free-form ("2020-05-01", "May 2020", "15/05/2020", …) — naive
   * parseInt turned "15/05/2020" into year 15. Zotero's own date parser
   * handles the common formats; a 4-digit-year regex catches the rest.
   */
  _yearFromItem(item) {
    const raw = item.getField("date") || "";
    if (!raw) return null;
    try {
      const parsed = Zotero.Date.strToDate(raw);
      const y = parsed && parseInt(parsed.year, 10);
      if (y && y > 1000) return y;
    } catch (e) {
      /* fall through to the regex */
    }
    const m = raw.match(/\b(1[0-9]{3}|2[0-9]{3})\b/);
    return m ? parseInt(m[1], 10) : null;
  },

  /** Some workflows put the DOI in the Extra field ("DOI: 10.x/..."). */
  _doiFromExtra(item) {
    const extra = item.getField("extra") || "";
    const m = extra.match(/^\s*DOI:\s*(\S+)/im);
    return m ? m[1] : null;
  },

  /**
   * Find the longest simple citation chains (paths) in the graph.
   *
   * Citation graphs are (almost always) acyclic — you can only cite papers
   * that already exist — so a DFS over the adjacency list terminates fast.
   * A visited-set guards against pathological cycles from bad metadata.
   *
   * Returns up to 10 chains of length >= minLen, longest first,
   * deduplicated so sub-chains of longer chains are dropped.
   */
  _findChains(nodes, edges, minLen) {
    const adj = new Map(); // key -> Set of cited keys
    const hasIncoming = new Set();
    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, new Set());
      adj.get(e.source).add(e.target);
      hasIncoming.add(e.target);
    }

    const memo = new Map(); // key -> longest chain starting at key
    const inStack = new Set();

    const longestFrom = (key) => {
      if (memo.has(key)) return memo.get(key);
      if (inStack.has(key)) return [key]; // cycle guard
      inStack.add(key);
      let best = [key];
      for (const next of adj.get(key) || []) {
        const sub = longestFrom(next);
        if (sub.length + 1 > best.length) best = [key, ...sub];
      }
      inStack.delete(key);
      memo.set(key, best);
      return best;
    };

    // Only start from "roots" (nothing in the graph cites them) —
    // every maximal chain must begin at one.
    const startKeys = [...adj.keys()].filter((k) => !hasIncoming.has(k));
    const chains = startKeys
      .map(longestFrom)
      .filter((c) => c.length >= minLen)
      .sort((a, b) => b.length - a.length)
      .slice(0, 25);

    // Drop chains fully contained in a longer chain.
    const kept = [];
    for (const c of chains) {
      const sig = c.join(">");
      if (!kept.some((k) => k.join(">").includes(sig))) kept.push(c);
      if (kept.length >= 10) break;
    }
    return kept;
  },
};
