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
    const textEntries = []; // local term extraction input (never transmitted)

    for (const { item, doi } of itemInfo) {
      const record = doi ? byDOI.get(doi) : null;
      const key = "z" + item.id;
      if (nodes.has(key)) continue;
      let tags = [];
      try {
        tags = item.getTags().map((t) => t.tag);
      } catch (e) {
        /* tags unavailable — extract from text only */
      }
      textEntries.push({
        text:
          (item.getField("title") || "") +
          ". " +
          (item.getField("abstractNote") || ""),
        tags,
      });
      if (record) {
        const node = this._node(key, "library", record, item.id);
        // The user's own metadata wins: OpenAlex's publication_year is
        // often the early-online year, one off from the item's real date.
        node.year = this._yearFromItem(item) || node.year;
        nodes.set(key, node);
        oaToKey.set(record.id, key);
      } else {
        const uTitle = item.getField("title") || "(untitled)";
        nodes.set(key, {
          key,
          kind: "unresolved",
          title: uTitle,
          year: this._yearFromItem(item),
          authors: [item.getField("firstCreator")].filter(Boolean),
          venue: item.getField("publicationTitle") || null,
          doi,
          zoteroItemID: item.id,
          citedByCount: 0,
          inLibraryCitations: 0,
          references: [],
          topics: [],
          oaStatus: null,
          // no OpenAlex type for unresolved items; use the title heuristic
          isReview: this.isReviewRecord({ title: uTitle }),
        });
      }
    }

    // ---- 3b. Collection profile ------------------------------------------
    // Aggregated OpenAlex topics/keywords plus locally extracted terms.
    // Drives suggestion re-ranking, topic search and cluster labels.
    const profile = this._buildProfile(nodes, textEntries);

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
            existing.oaID = record.id;
            existing.topics = record.topics || [];
            existing.oaStatus = record.oaStatus || null;
            existing.references = record.references || [];
            existing.related = record.related || [];
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

      // Rank: in-library citers, boosted by how well the candidate's topics
      // match the collection profile — so a topically relevant paper cited
      // by 2 of your papers can outrank a generic methods paper cited by 3.
      // Worldwide citations break the remaining ties.
      for (const v of valid) {
        v.sim = this._topicSim(v.record, profile);
      }
      valid.sort(
        (a, b) =>
          b.citers.length + b.sim - (a.citers.length + a.sim) ||
          (b.record.citedByCount || 0) - (a.record.citedByCount || 0)
      );
      for (const { oaID, citers, record } of valid.slice(0, maxDiscovered)) {
        const key = "d" + oaID;
        const node = this._node(key, "discovered", record, null);
        node.inLibraryCitations = citers.length;
        node.via = "refs";
        node.matchedTopics = this._matchedTopicNames(record, profile);
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

    // ---- 7. Bibliographic coupling ---------------------------------------
    // Two of YOUR papers sharing several references are "siblings" even if
    // neither cites the other — often the only structure a young collection
    // has. Computed at the lowest threshold (2 shared refs); the view's
    // strength chips filter live, so changing them needs no rebuild.
    const coupling = this._findCoupling(nodes, 2);

    // ---- 8. Related-works tally ------------------------------------------
    // OpenAlex ships algorithmic `related_works` per record; count how often
    // an external work is "related" to the collection. Used by the Discover
    // search (metadata fetched only if the user actually searches).
    const relatedCounts = new Map();
    for (const n of nodes.values()) {
      if (n.kind !== "library") continue;
      for (const rid of n.related || []) {
        if (oaToKey.has(rid)) continue; // already on the map
        relatedCounts.set(rid, (relatedCounts.get(rid) || 0) + 1);
      }
    }

    // OpenAlex IDs of the user's resolved papers (for forward-citation search).
    const libOAIDs = [];
    for (const [oaID, key] of oaToKey) {
      const n = nodes.get(key);
      if (n && n.kind === "library") libOAIDs.push(oaID);
    }

    // References/related/keywords are internal plumbing; drop before handing
    // to the view (topics stay — cluster labels and chips read them).
    for (const n of nodes.values()) {
      delete n.references;
      delete n.related;
      delete n.keywords;
    }

    return {
      nodes: [...nodes.values()],
      edges,
      chains,
      coupling,
      profile,
      libOAIDs,
      relatedCounts: [...relatedCounts.entries()]
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40),
      stats: {
        items: items.length,
        resolved: [...nodes.values()].filter((n) => n.kind === "library").length,
        edges: edges.length,
        discovered: [...nodes.values()].filter((n) => n.kind === "discovered")
          .length,
        coupling: coupling.length,
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
      related: record.related || [],
      topics: record.topics || [],
      keywords: record.keywords || [],
      oaStatus: record.oaStatus || null,
      oaID: record.id || null,
      isReview: this.isReviewRecord(record),
    };
  },

  // ============================================================ review detection

  // Title patterns that mark a review / secondary-literature article. Kept
  // reasonably specific so a bare "review" (e.g. "peer review process") does
  // not match, but broad enough to catch the common wordings.
  REVIEW_TITLE_RE:
    /\b(systematic|scoping|narrative|literature|umbrella|integrative|rapid|comprehensive|critical|mini|brief|concise)[\s-]+review\b|\bmeta[\s-]?analys(is|es)\b|\breview\s+article\b|:\s*an?\s+([a-z]+\s+){0,3}review\b|\ban?\s+review\s+of\b|\breview\s+of\s+the\s+literature\b|\(review\)|[:\-–—]\s*review\s*$|\breview\s*$|\brecent\s+(advances|progress|developments|insights|trends)\s+in\b|\ban?\s+(overview|survey)\s+of\b|\bcurrent\s+(concepts|status|state|understanding|perspectives)\b|\bstate[\s-]of[\s-]the[\s-]art\b/i,

  // Venues that are review journals/series (plural "Reviews" is a strong,
  // precise signal; singular "Review of X" is deliberately NOT matched, as
  // several are primary-research journals).
  REVIEW_VENUE_RE:
    /\breviews\b|\bannual\s+review\b|\bcurrent\s+opinion\s+in\b|\btrends\s+in\b|wiley\s+interdisciplinary/i,

  /**
   * Robustly decide whether a work is a review / secondary literature, using
   * every signal available from OpenAlex (and, for unresolved Zotero items,
   * their own title/venue):
   *   1. OpenAlex work type === "review" (authoritative when present);
   *   2. a targeted title pattern (systematic review, meta-analysis, …);
   *   3. a review-journal venue (Nature Reviews, Chemical Reviews, Annual
   *      Review of …, Trends in …, Current Opinion in …).
   * Zotero has no "review" item type, so 2 and 3 also cover library items.
   */
  isReviewRecord(rec) {
    if (!rec) return false;
    if ((rec.type || "").toLowerCase() === "review") return true;
    if (this.REVIEW_TITLE_RE.test(rec.title || "")) return true;
    if (rec.venue && this.REVIEW_VENUE_RE.test(rec.venue)) return true;
    return false;
  },

  // ======================================================= collection profile

  /**
   * Build the collection "fingerprint":
   *   - topics:   aggregated OpenAlex topics (id, name, count, weight)
   *   - keywords: aggregated OpenAlex keywords
   *   - terms:    locally extracted phrases from titles/abstracts/tags
   * Topics/keywords come from OpenAlex's own records; term extraction runs
   * entirely locally and its results are never transmitted anywhere.
   */
  _buildProfile(nodes, textEntries) {
    const topicAgg = new Map();
    const kwAgg = new Map();
    for (const n of nodes.values()) {
      if (n.kind !== "library") continue;
      for (const t of n.topics || []) {
        const e =
          topicAgg.get(t.id) || { id: t.id, name: t.name, count: 0, weight: 0 };
        e.count++;
        e.weight += t.score || 0;
        topicAgg.set(t.id, e);
      }
      for (const k of n.keywords || []) {
        const e = kwAgg.get(k.name) || { name: k.name, count: 0 };
        e.count++;
        kwAgg.set(k.name, e);
      }
    }
    return {
      topics: [...topicAgg.values()]
        .sort((a, b) => b.count - a.count || b.weight - a.weight)
        .slice(0, 8),
      keywords: [...kwAgg.values()]
        .filter((k) => k.count >= 2)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      terms: this._extractTerms(textEntries),
    };
  },

  /**
   * How well a candidate's topics overlap the collection profile, 0..3.
   * Each of the candidate's (up to 3) topics contributes the profile
   * topic's share of the strongest profile topic.
   */
  _topicSim(record, profile) {
    if (!profile || !profile.topics || !profile.topics.length) return 0;
    const maxCount = profile.topics[0].count || 1;
    let sim = 0;
    for (const t of record.topics || []) {
      const p = profile.topics.find((x) => x.id === t.id);
      if (p) sim += p.count / maxCount;
    }
    return sim;
  },

  /** Names of the candidate's topics that appear in the profile (≤ 2). */
  _matchedTopicNames(record, profile) {
    if (!profile || !profile.topics) return [];
    const ids = new Set(profile.topics.map((t) => t.id));
    return (record.topics || [])
      .filter((t) => ids.has(t.id))
      .slice(0, 2)
      .map((t) => t.name);
  },

  /**
   * RAKE-style phrase extraction, dependency-free and fully local.
   * Splits titles/abstracts at stopwords and punctuation into candidate
   * phrases of 1–3 words; the user's own Zotero tags count triple.
   */
  _extractTerms(entries) {
    if (!this._stopwords) {
      this._stopwords = new Set(
        (
          "a,an,the,and,or,but,of,in,on,at,to,for,with,by,from,as,is,are,was," +
          "were,be,been,being,it,its,this,that,these,those,we,our,their,they," +
          "he,she,his,her,you,your,i,not,no,than,then,so,such,can,could,may," +
          "might,will,would,shall,should,must,do,does,did,done,have,has,had," +
          "having,into,onto,over,under,between,among,through,during,before," +
          "after,above,below,about,against,within,without,toward,towards,per," +
          "via,using,used,use,based,new,novel,study,studies,analysis,results," +
          "effect,effects,approach,method,methods,paper,review,also,both,each," +
          "more,most,less,least,very,here,there,when,where,which,while,who," +
          "whom,whose,what,why,how,all,any,some,other,others,one,two,three," +
          "und,der,die,das,ein,eine,für,von,mit,auf,im,des,den,zur,zum,bei"
        ).split(",")
      );
    }
    const STOP = this._stopwords;
    const tokenize = (text) =>
      String(text || "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}\-]+/u)
        .filter(Boolean);
    const phrases = new Map(); // phrase -> { count, words }
    const addPhrase = (words, boost) => {
      if (!words.length || words.length > 3) return;
      const p = words.join(" ");
      if (p.length < 4) return;
      const e = phrases.get(p) || { count: 0, words: words.length };
      e.count += boost;
      phrases.set(p, e);
    };
    for (const entry of entries || []) {
      const tokens = tokenize(entry.text);
      let cur = [];
      for (const t of tokens) {
        if (STOP.has(t) || /^\d+$/.test(t) || t.length < 3) {
          if (cur.length) addPhrase(cur, 1);
          cur = [];
        } else {
          cur.push(t);
          if (cur.length === 3) {
            addPhrase(cur, 1);
            cur = [];
          }
        }
      }
      if (cur.length) addPhrase(cur, 1);
      for (const tag of entry.tags || []) {
        addPhrase(
          tokenize(tag).filter((w) => !STOP.has(w)),
          3
        );
      }
    }
    return [...phrases.entries()]
      .map(([term, e]) => ({ term, score: e.count * (e.words > 1 ? 1.6 : 1) }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  },

  // ==================================================== bibliographic coupling

  /**
   * Pairs of library papers sharing >= minShared references.
   * References cited by more than 40 of the user's papers are skipped —
   * a near-universal reference couples everything with everything and
   * carries no signal (and would cost O(n²) pairs).
   */
  _findCoupling(nodes, minShared) {
    const refOwners = new Map(); // referenced work -> [library node keys]
    for (const n of nodes.values()) {
      if (n.kind !== "library") continue;
      for (const ref of n.references || []) {
        if (!refOwners.has(ref)) refOwners.set(ref, []);
        refOwners.get(ref).push(n.key);
      }
    }
    const pairCounts = new Map();
    for (const owners of refOwners.values()) {
      if (owners.length < 2 || owners.length > 40) continue;
      for (let i = 0; i < owners.length; i++) {
        for (let j = i + 1; j < owners.length; j++) {
          const k =
            owners[i] < owners[j]
              ? owners[i] + "|" + owners[j]
              : owners[j] + "|" + owners[i];
          pairCounts.set(k, (pairCounts.get(k) || 0) + 1);
        }
      }
    }
    const coupling = [];
    for (const [k, shared] of pairCounts) {
      if (shared < minShared) continue;
      const idx = k.indexOf("|");
      coupling.push({ a: k.slice(0, idx), b: k.slice(idx + 1), shared });
    }
    // strongest first; cap so a dense collection can't drown the map
    coupling.sort((x, y) => y.shared - x.shared);
    return coupling.slice(0, 400);
  },

  // ======================================================== what's-new diffs

  /** Compact record of a build, for "new since last build" highlighting. */
  snapshotOf(graph) {
    return {
      keys: graph.nodes
        .filter((n) => n.kind !== "discovered")
        .map((n) => n.key),
      sugg: graph.nodes.filter((n) => n.kind === "discovered").map((n) => n.key),
      when: new Date().toISOString(),
    };
  },

  /**
   * Mark nodes that were not part of the previous build of this collection.
   * Returns { papers, suggestions } counts (0/0 when there is no snapshot —
   * a first build highlights nothing).
   */
  markNew(graph, snapshot) {
    if (!snapshot) return { papers: 0, suggestions: 0 };
    const prevKeys = new Set(snapshot.keys || []);
    const prevSugg = new Set(snapshot.sugg || []);
    let papers = 0;
    let suggestions = 0;
    for (const n of graph.nodes) {
      if (n.kind === "discovered") {
        n.isNew = !prevSugg.has(n.key);
        if (n.isNew) suggestions++;
      } else {
        n.isNew = !prevKeys.has(n.key);
        if (n.isNew) papers++;
      }
    }
    return { papers, suggestions };
  },

  // ========================================================= discover search

  /**
   * The on-demand "Search for new papers" engine. Three sources, each
   * optional (opts.citing / opts.topics / opts.related, default on):
   *
   *   1. forward citations — works that CITE the user's papers (the mirror
   *      of the reference-based suggestions; finds what's NEW);
   *   2. topic search — well-cited works in the collection's top OpenAlex
   *      topics (parallel literature with no citation link at all);
   *   3. related works — OpenAlex's per-record relatedness, tallied.
   *
   * Privacy: only OpenAlex work/topic IDs are transmitted — never the
   * user's text. Returns ranked entries:
   *   { record, score, citesCount, citers[nodeKeys], topicNames, relatedCount }
   *
   * @param {object} graph - model from build()
   * @param {object} opts - { citing, topics, related, fromYear, topicIDs,
   *                          limit, onProgress(phase, done, total) }
   */
  async searchNewPapers(graph, opts = {}) {
    const DS = ZCM_NS.DataSource;
    const profile = graph.profile || { topics: [] };
    const myIDs = graph.libOAIDs || [];
    const mySet = new Set(myIDs);
    const have = new Set(); // OA IDs and DOIs already on the map
    for (const n of graph.nodes) {
      if (n.oaID) have.add(n.oaID);
      if (n.key && n.key[0] === "d") have.add(n.key.slice(1));
      if (n.doi) have.add(n.doi);
    }
    const prog = opts.onProgress || (() => {});

    const found = new Map(); // oaID -> entry
    const entryFor = (record) => {
      if (!record || mySet.has(record.id) || have.has(record.id)) return null;
      if (record.doi && have.has(record.doi)) return null;
      if (!record.title || record.title === "(untitled)") return null;
      if (opts.fromYear && record.year && record.year < opts.fromYear)
        return null;
      let e = found.get(record.id);
      if (!e) {
        e = {
          record,
          score: 0,
          citesCount: 0,
          citers: [],
          topicNames: [],
          relatedCount: 0,
        };
        found.set(record.id, e);
      }
      return e;
    };

    // ---- 1. forward citations -------------------------------------------
    if (opts.citing !== false && myIDs.length) {
      const citing = await DS.fetchCitingWorks(myIDs, {
        fromYear: opts.fromYear,
        onProgress: (d, t) => prog("Finding papers that cite yours", d, t),
      });
      const keyByOA = new Map();
      for (const n of graph.nodes) {
        if (n.oaID) keyByOA.set(n.oaID, n.key);
      }
      for (const rec of citing.values()) {
        const cited = (rec.references || []).filter((r) => mySet.has(r));
        if (!cited.length) continue;
        const e = entryFor(rec);
        if (!e) continue;
        e.citesCount = cited.length;
        e.citers = cited.map((r) => keyByOA.get(r)).filter(Boolean);
        e.score += cited.length * 2;
      }
    }

    // ---- 2. topic search -------------------------------------------------
    if (opts.topics !== false && profile.topics.length) {
      prog("Searching your topics", 0, 1);
      const ids =
        opts.topicIDs && opts.topicIDs.length
          ? opts.topicIDs
          : profile.topics.slice(0, 3).map((t) => t.id);
      const byTopic = await DS.fetchWorksByTopics(ids, {
        fromYear: opts.fromYear,
        perPage: 50,
      });
      for (const rec of byTopic.values()) {
        const sim = this._topicSim(rec, profile);
        if (sim <= 0) continue;
        const e = entryFor(rec);
        if (!e) continue;
        e.score += sim * 1.5;
      }
      prog("Searching your topics", 1, 1);
    }

    // ---- 3. related works ------------------------------------------------
    if (opts.related !== false && (graph.relatedCounts || []).length) {
      prog("Looking up related works", 0, 1);
      const wanted = graph.relatedCounts
        .filter(([id]) => !mySet.has(id) && !have.has(id))
        .slice(0, 20);
      const recs = await DS.fetchWorksByOpenAlexId(wanted.map(([id]) => id));
      for (const [id, count] of wanted) {
        const e = entryFor(recs.get(id));
        if (!e) continue;
        e.relatedCount = count;
        e.score += count;
      }
      prog("Looking up related works", 1, 1);
    }

    // reason chips + review flag for every candidate
    for (const e of found.values()) {
      e.topicNames = this._matchedTopicNames(e.record, profile);
      e.isReview = this.isReviewRecord(e.record);
    }

    return [...found.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.record.citedByCount || 0) - (a.record.citedByCount || 0)
      )
      .slice(0, opts.limit || 30);
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
