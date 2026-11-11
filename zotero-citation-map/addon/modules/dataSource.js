/**
 * dataSource.js — talks to the OpenAlex API and caches the results.
 *
 * Why OpenAlex?
 *   Zotero stores your papers' metadata but NOT their reference lists.
 *   OpenAlex (https://openalex.org) is a free, open scholarly index that
 *   returns, for each work, the list of works it references
 *   (`referenced_works`). Works without an API key on a small daily
 *   budget; an optional free key (pref `apiKey`) raises it about tenfold.
 *
 * Responsibilities of this module:
 *   - Resolve DOIs of library items to OpenAlex work records (batched).
 *   - Resolve OpenAlex IDs of "discovered" external works to metadata.
 *   - Cache every record on disk (JSON in the Zotero data directory) so
 *     rebuilding a map is instant and mostly works offline.
 *
 * This file is loaded into the shared CitationMap namespace by bootstrap.js
 * (`this` === CitationMap).
 */

/* global Zotero, IOUtils, PathUtils */

this.DataSource = {
  API_BASE: "https://api.openalex.org",
  BATCH_SIZE: 50, // values per OR filter (OpenAlex allows up to 100)
  // Bump when FIELDS/_slim change shape: old cached records lack the new
  // fields, so the whole cache is discarded and refetched once.
  CACHE_VERSION: 3,
  _cache: null, // { version, works: { key -> { fetched, record } }, snapshots }
  _cachePath: null,

  /** Fields we ask OpenAlex for. Keeping this list tight keeps responses small. */
  FIELDS: [
    "id",
    "doi",
    "title",
    "display_name",
    "type", // "article" | "review" | "preprint" | … (for review detection)
    "publication_year",
    "cited_by_count",
    "authorships",
    "referenced_works",
    "related_works",
    "primary_location",
    "topics",
    "keywords",
    "open_access",
  ].join(","),

  // ------------------------------------------------------------------ cache

  async initCache() {
    this._cachePath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "citation-map-cache.json"
    );
    try {
      if (await IOUtils.exists(this._cachePath)) {
        this._cache = await IOUtils.readJSON(this._cachePath);
      }
    } catch (e) {
      Zotero.debug("[Citation Map] Cache unreadable, starting fresh: " + e);
    }
    if (!this._cache || typeof this._cache !== "object") {
      this._cache = null;
    }
    // A version mismatch means cached records are missing newer fields
    // (e.g. topics) — discard works but keep the per-collection snapshots
    // used for the "new since last build" highlights.
    if (this._cache && this._cache.version !== this.CACHE_VERSION) {
      Zotero.debug(
        "[Citation Map] Cache format changed — refetching on next build"
      );
      this._cache = { snapshots: this._cache.snapshots || {} };
    }
    if (!this._cache) this._cache = {};
    this._cache.version = this.CACHE_VERSION;
    if (!this._cache.works) this._cache.works = {};
    if (!this._cache.snapshots) this._cache.snapshots = {};
    this._pruneCache();
  },

  /**
   * Drop records far past their TTL. Stale records are still useful as an
   * offline fallback for a while (see _cacheGet), but without a bound the
   * file only ever grows and every save rewrites all of it.
   */
  _pruneCache() {
    const days =
      Zotero.Prefs.get("extensions.citation-map.cacheDays", true) || 30;
    const keepMs = Math.max(90, days * 4) * 24 * 3600 * 1000;
    const now = Date.now();
    for (const [key, entry] of Object.entries(this._cache.works)) {
      if (!entry || !(now - entry.fetched < keepMs)) delete this._cache.works[key];
    }
  },

  async saveCache() {
    try {
      await IOUtils.writeJSON(this._cachePath, this._cache);
    } catch (e) {
      Zotero.debug("[Citation Map] Failed to persist cache: " + e);
    }
  },

  async clearCache() {
    this._cache = {
      version: this.CACHE_VERSION,
      works: {},
      snapshots: this._cache && this._cache.snapshots ? this._cache.snapshots : {},
    };
    await this.saveCache();
  },

  // ------------------------------------------------- build snapshots
  //
  // A tiny record of what the last build of a collection contained, so the
  // next build can highlight what is new. Not citation data — survives
  // cache clears and version bumps.

  getSnapshot(collectionID) {
    const s = this._cache && this._cache.snapshots[collectionID];
    return s && Array.isArray(s.keys) ? s : null;
  },

  async putSnapshot(collectionID, snapshot) {
    if (!this._cache) return;
    this._cache.snapshots[collectionID] = snapshot;
    await this.saveCache();
  },

  /**
   * A cached record, or null if absent or older than cacheDays. With
   * `allowStale`, an expired record is returned too: the fallback when a
   * refetch failed, so a map built online keeps working offline.
   */
  _cacheGet(key, allowStale = false) {
    const entry = this._cache.works[key];
    if (!entry) return null;
    if (allowStale) return entry.record;
    const maxAgeDays =
      Zotero.Prefs.get("extensions.citation-map.cacheDays", true) || 30;
    const ageMs = Date.now() - entry.fetched;
    if (ageMs > maxAgeDays * 24 * 3600 * 1000) return null; // stale
    return entry.record;
  },

  _cachePut(key, record) {
    this._cache.works[key] = { fetched: Date.now(), record };
  },

  // ------------------------------------------------------------ HTTP helper

  _mailtoParam() {
    const mail = Zotero.Prefs.get("extensions.citation-map.mailto", true);
    return mail ? `&mailto=${encodeURIComponent(mail)}` : "";
  },

  /** The optional OpenAlex API key (a credential, never user text). */
  _apiKey() {
    try {
      return String(
        Zotero.Prefs.get("extensions.citation-map.apiKey", true) || ""
      ).trim();
    } catch (e) {
      return "";
    }
  },

  // -------------------------------------------------------- network health
  //
  // Sticky per-operation state so the UI can tell the user WHY things are
  // slow or empty:
  //   "slow"    a request succeeded but took > SLOW_MS
  //   "offline" no response even after the retry (no connection, DNS)
  //   "limited" OpenAlex refused: daily budget used up (429) or API key
  //             rejected (401/403); further requests this run are skipped
  //   "error"   OpenAlex answered with a server error (5xx) twice

  SLOW_MS: 8000, // a successful request slower than this flags "slow"
  netState: "ok", // "ok" | "slow" | "offline" | "limited" | "error"
  lastStatus: 0, // HTTP status behind a "limited" state

  resetNetState() {
    this.netState = "ok";
    this.lastStatus = 0;
  },

  /** A plain-language explanation of a bad netState ("" when all is well). */
  netMessage() {
    switch (this.netState) {
      case "offline":
        return (
          "OpenAlex can't be reached, you appear to be offline. Using " +
          "locally cached data where possible."
        );
      case "limited":
        if ((this.lastStatus === 401 || this.lastStatus === 403) && this._apiKey()) {
          return (
            "OpenAlex rejected the API key saved in Citation Map. Check it " +
            "(or clear it) and try again."
          );
        }
        return (
          "OpenAlex's free daily allowance for your network is used up (it " +
          "resets at midnight UTC). A free OpenAlex API key raises it " +
          "about tenfold."
        );
      case "error":
        return "OpenAlex is having problems right now, please try again later.";
      default:
        return "";
    }
  },

  /**
   * GET a URL, returning parsed JSON. Uses Zotero's HTTP layer so requests
   * respect proxy settings, and retries once on transient failures. The
   * timeout is deliberately generous (60 s) so slow connections still get
   * their data — the UI shows a "slow connection" hint instead of failing.
   */
  async _getJSON(url) {
    // Once OpenAlex has refused, every further request this run would be
    // refused too: stop asking (and spending the user's budget).
    if (this.netState === "limited") {
      throw new Error("OpenAlex refused earlier requests (" + this.lastStatus + ")");
    }
    const headers = { Accept: "application/json" };
    const key = this._apiKey();
    if (key) headers.Authorization = "Bearer " + key;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      try {
        const req = await Zotero.HTTP.request("GET", url, {
          headers,
          timeout: 60000,
          // Zotero 10 retries 429/5xx on its own for up to an hour (and
          // sleeps on Retry-After without limit), so a used-up OpenAlex
          // budget looked like a frozen progress bar. Fail fast and handle
          // the status here; older Zotero versions ignore these options.
          errorDelayMax: 0,
          noRetryOnThrottle: true,
        });
        if (Date.now() - t0 > this.SLOW_MS && this.netState === "ok") {
          this.netState = "slow";
        }
        return JSON.parse(req.responseText);
      } catch (e) {
        const status = (e && e.status) || 0;
        if (status === 429 || status === 401 || status === 403) {
          this.netState = "limited";
          this.lastStatus = status;
          throw e;
        }
        if (status >= 400 && status < 500) {
          // A malformed request (e.g. an odd DOI in the filter): retrying
          // can't help, and it says nothing about the connection.
          Zotero.debug(
            "[Citation Map] OpenAlex " + status + ": " +
              String((e.xmlhttp && e.xmlhttp.responseText) || "").slice(0, 300)
          );
          throw e;
        }
        if (attempt === 1) {
          this.netState = status >= 500 ? "error" : "offline";
          throw e;
        }
        await Zotero.Promise.delay(1500); // brief back-off, then retry
      }
    }
    return null;
  },

  /**
   * Normalize a DOI to the bare lowercase form OpenAlex expects, or null if
   * there is no DOI in it. Handles what people paste into the DOI field:
   * "doi: 10.x/…", "https://doi.org/…", "DOI 10.x/…", trailing punctuation.
   */
  normalizeDOI(doi) {
    if (!doi) return null;
    let d = String(doi).trim();
    try {
      // Zotero's own cleaner pulls the 10.xxxx/… part out of any wrapping
      if (Zotero.Utilities && typeof Zotero.Utilities.cleanDOI === "function") {
        const c = Zotero.Utilities.cleanDOI(d);
        if (c) d = c;
      }
    } catch (e) {
      /* fall back to the patterns below */
    }
    d = d
      .replace(/^https?:\/\/(dx\.|www\.)?doi\.org\//i, "")
      .replace(/^doi[:\s]\s*/i, "")
      .replace(/[.,;]+$/, "")
      .trim()
      .toLowerCase();
    return /^10\.\d{3,9}\/\S+$/.test(d) ? d : null;
  },

  /**
   * DOIs that can't go into an OR filter: OpenAlex splits filter values on
   * "," and "|" (even URL-encoded), so one of these would fail or corrupt
   * its whole 50-DOI batch. They are looked up one at a time instead.
   */
  _batchableDOI(doi) {
    return !/[,|]/.test(doi);
  },

  /** Single-work lookup by DOI (null if OpenAlex doesn't know it). */
  async _fetchOneByDOI(doi) {
    const url =
      `${this.API_BASE}/works/https://doi.org/` +
      doi.split("/").map(encodeURIComponent).join("/") +
      `?select=${this.FIELDS}${this._mailtoParam()}`;
    try {
      return this._slim(await this._getJSON(url));
    } catch (e) {
      Zotero.debug("[Citation Map] DOI lookup failed (" + doi + "): " + e);
      return null;
    }
  },

  // --------------------------------------------------------------- fetching

  /**
   * Resolve an array of DOIs to OpenAlex work records.
   *
   * @param {string[]} dois - normalized DOIs
   * @param {function} onProgress - (done, total) callback for the UI
   * @returns {Map<string, object>} doi -> slimmed work record
   */
  async fetchWorksByDOI(dois, onProgress) {
    const result = new Map();
    const missing = [];

    for (const doi of dois) {
      const cached = this._cacheGet("doi:" + doi);
      if (cached) result.set(doi, cached);
      else missing.push(doi);
    }

    let done = dois.length - missing.length;
    onProgress && onProgress(done, dois.length);

    const batchable = missing.filter((d) => this._batchableDOI(d));
    const singles = missing.filter((d) => !this._batchableDOI(d));
    for (let i = 0; i < batchable.length; i += this.BATCH_SIZE) {
      const batch = batchable.slice(i, i + this.BATCH_SIZE);
      const filter = "doi:" + batch.join("|");
      const url =
        `${this.API_BASE}/works?filter=${encodeURIComponent(filter)}` +
        `&per_page=${this.BATCH_SIZE}&select=${this.FIELDS}${this._mailtoParam()}`;
      try {
        const json = await this._getJSON(url);
        for (const work of json.results || []) {
          const slim = this._slim(work);
          if (!slim.doi) continue;
          result.set(slim.doi, slim);
          this._cachePut("doi:" + slim.doi, slim);
          this._cachePut("oa:" + slim.id, slim);
        }
      } catch (e) {
        Zotero.debug("[Citation Map] Batch fetch failed: " + e);
        // Continue with remaining batches; unresolved DOIs simply appear
        // as "unresolved" nodes on the map.
      }
      done += batch.length;
      onProgress && onProgress(Math.min(done, dois.length), dois.length);
      await Zotero.Promise.delay(120); // stay well inside polite rate limits
    }
    for (const doi of singles) {
      const slim = await this._fetchOneByDOI(doi);
      if (slim) {
        result.set(doi, slim);
        this._cachePut("doi:" + doi, slim);
        this._cachePut("oa:" + slim.id, slim);
      }
      done++;
      onProgress && onProgress(Math.min(done, dois.length), dois.length);
      await Zotero.Promise.delay(120);
    }

    // Anything still missing (offline, refused, server error): fall back to
    // an expired cache record rather than drawing the paper as "no data".
    for (const doi of missing) {
      if (result.has(doi)) continue;
      const stale = this._cacheGet("doi:" + doi, true);
      if (stale) result.set(doi, stale);
    }

    await this.saveCache();
    return result;
  },

  /**
   * Resolve OpenAlex work IDs (e.g. "W2100837269") to records.
   * Used to get titles/years for discovered external papers.
   *
   * @param {string[]} ids
   * @returns {Map<string, object>} id -> slimmed work record
   */
  async fetchWorksByOpenAlexId(ids) {
    const result = new Map();
    const missing = [];

    for (const id of ids) {
      const cached = this._cacheGet("oa:" + id);
      if (cached) result.set(id, cached);
      else missing.push(id);
    }

    for (let i = 0; i < missing.length; i += this.BATCH_SIZE) {
      const batch = missing.slice(i, i + this.BATCH_SIZE);
      // `openalex:` is the documented filter for work IDs (ids.openalex)
      const filter = "openalex:" + batch.join("|");
      const url =
        `${this.API_BASE}/works?filter=${encodeURIComponent(filter)}` +
        `&per_page=${this.BATCH_SIZE}&select=${this.FIELDS}${this._mailtoParam()}`;
      try {
        const json = await this._getJSON(url);
        for (const work of json.results || []) {
          const slim = this._slim(work);
          result.set(slim.id, slim);
          this._cachePut("oa:" + slim.id, slim);
          if (slim.doi) this._cachePut("doi:" + slim.doi, slim);
        }
      } catch (e) {
        Zotero.debug("[Citation Map] OpenAlex ID batch failed: " + e);
      }
      await Zotero.Promise.delay(120);
    }
    for (const id of missing) {
      if (result.has(id)) continue;
      const stale = this._cacheGet("oa:" + id, true);
      if (stale) result.set(id, stale);
    }

    await this.saveCache();
    return result;
  },

  /**
   * Reduce a full OpenAlex work object to the handful of fields we need,
   * so the cache file stays small even for large libraries.
   */
  _slim(work) {
    const authors = (work.authorships || [])
      .slice(0, 6)
      .map((a) => a.author && a.author.display_name)
      .filter(Boolean);
    const stripID = (u) => String(u || "").replace(/^https:\/\/openalex\.org\//, "");
    return {
      id: stripID(work.id),
      doi: this.normalizeDOI(work.doi),
      title: work.title || work.display_name || "(untitled)",
      type: work.type || null, // OpenAlex work type, e.g. "article" / "review"
      year: work.publication_year || null,
      citedByCount: work.cited_by_count || 0,
      authors,
      venue:
        (work.primary_location &&
          work.primary_location.source &&
          work.primary_location.source.display_name) ||
        null,
      references: (work.referenced_works || []).map(stripID),
      related: (work.related_works || []).slice(0, 10).map(stripID),
      // OpenAlex topics: up to 3 per work, most relevant first.
      topics: (work.topics || []).slice(0, 3).map((t) => ({
        id: stripID(t.id),
        name: t.display_name,
        score: t.score || 0,
      })),
      keywords: (work.keywords || []).slice(0, 6).map((k) => ({
        name: k.display_name,
        score: k.score || 0,
      })),
      // "gold" | "green" | "hybrid" | "bronze" | "diamond" | "closed"
      oaStatus:
        (work.open_access &&
          (work.open_access.oa_status ||
            (work.open_access.is_oa ? "open" : "closed"))) ||
        null,
    };
  },

  // ------------------------------------------------------- discovery search
  //
  // Both searches transmit only OpenAlex identifiers (work IDs / topic IDs
  // taken from OpenAlex's own records) — never the user's text, notes or
  // tags. See the README's privacy section.

  /**
   * Find works that CITE any of the given OpenAlex work IDs (forward
   * citations — "who builds on my collection"). Returns a Map id -> slim
   * record; callers tally locally how many of the user's papers each
   * candidate references (its `references` are included).
   *
   * @param {string[]} oaIDs - OpenAlex work IDs of the user's papers
   * @param {object} opts - { fromYear, onProgress(done,total), pagesPerBatch }
   */
  async fetchCitingWorks(oaIDs, opts = {}) {
    const result = new Map();
    const CITES_BATCH = 40; // stay well under the OR-filter value limit
    const pages = Math.max(1, Math.min(3, opts.pagesPerBatch || 2));
    const batches = [];
    for (let i = 0; i < oaIDs.length; i += CITES_BATCH) {
      batches.push(oaIDs.slice(i, i + CITES_BATCH));
    }
    let done = 0;
    for (const batch of batches) {
      let filter = "cites:" + batch.join("|");
      if (opts.fromYear) {
        filter += `,from_publication_date:${opts.fromYear}-01-01`;
      }
      // With a year filter the user is hunting for RECENT work — sort by
      // date so brand-new (barely-cited) papers aren't crowded out.
      const sortKey = opts.fromYear
        ? "publication_date:desc"
        : "cited_by_count:desc";
      for (let page = 1; page <= pages; page++) {
        const url =
          `${this.API_BASE}/works?filter=${encodeURIComponent(filter)}` +
          `&per_page=100&page=${page}&sort=${sortKey}` +
          `&select=${this.FIELDS}${this._mailtoParam()}`;
        try {
          const json = await this._getJSON(url);
          const works = (json && json.results) || [];
          for (const work of works) {
            const slim = this._slim(work);
            if (!result.has(slim.id)) result.set(slim.id, slim);
            this._cachePut("oa:" + slim.id, slim);
            if (slim.doi) this._cachePut("doi:" + slim.doi, slim);
          }
          if (works.length < 100) break; // no further pages
        } catch (e) {
          Zotero.debug("[Citation Map] cites batch failed: " + e);
          break;
        }
        await Zotero.Promise.delay(120);
      }
      done++;
      opts.onProgress && opts.onProgress(done, batches.length);
      await Zotero.Promise.delay(120);
    }
    await this.saveCache();
    return result;
  },

  /**
   * Find well-cited works in the given OpenAlex topics (parallel literature
   * that may share no citation link with the collection at all).
   *
   * @param {string[]} topicIDs - OpenAlex topic IDs (e.g. "T10159")
   * @param {object} opts - { fromYear, perPage }
   * @returns {Map<string, object>} id -> slim record
   */
  async fetchWorksByTopics(topicIDs, opts = {}) {
    const result = new Map();
    if (!topicIDs.length) return result;
    let filter = "topics.id:" + topicIDs.slice(0, 8).join("|");
    if (opts.fromYear) {
      filter += `,from_publication_date:${opts.fromYear}-01-01`;
    }
    const perPage = Math.max(10, Math.min(100, opts.perPage || 50));
    const url =
      `${this.API_BASE}/works?filter=${encodeURIComponent(filter)}` +
      `&per_page=${perPage}&sort=cited_by_count:desc` +
      `&select=${this.FIELDS}${this._mailtoParam()}`;
    try {
      const json = await this._getJSON(url);
      for (const work of (json && json.results) || []) {
        const slim = this._slim(work);
        result.set(slim.id, slim);
        this._cachePut("oa:" + slim.id, slim);
        if (slim.doi) this._cachePut("doi:" + slim.doi, slim);
      }
    } catch (e) {
      Zotero.debug("[Citation Map] topic search failed: " + e);
    }
    await this.saveCache();
    return result;
  },
};
