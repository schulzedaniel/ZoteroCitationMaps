/**
 * dataSource.js — talks to the OpenAlex API and caches the results.
 *
 * Why OpenAlex?
 *   Zotero stores your papers' metadata but NOT their reference lists.
 *   OpenAlex (https://openalex.org) is a free, open scholarly index that
 *   returns, for each work, the list of works it references
 *   (`referenced_works`). No API key required.
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
  BATCH_SIZE: 50, // OpenAlex allows up to 50 IDs per filter query
  _cache: null, // { works: { key -> { fetched, record } } }
  _cachePath: null,

  /** Fields we ask OpenAlex for. Keeping this list tight keeps responses small. */
  FIELDS: [
    "id",
    "doi",
    "title",
    "display_name",
    "publication_year",
    "cited_by_count",
    "authorships",
    "referenced_works",
    "primary_location",
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
      this._cache = { works: {} };
    }
    if (!this._cache.works) this._cache.works = {};
  },

  async saveCache() {
    try {
      await IOUtils.writeJSON(this._cachePath, this._cache);
    } catch (e) {
      Zotero.debug("[Citation Map] Failed to persist cache: " + e);
    }
  },

  async clearCache() {
    this._cache = { works: {} };
    await this.saveCache();
  },

  _cacheGet(key) {
    const entry = this._cache.works[key];
    if (!entry) return null;
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

  /**
   * GET a URL, returning parsed JSON. Uses Zotero's HTTP layer so requests
   * respect proxy settings, and retries once on transient failures.
   */
  async _getJSON(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const req = await Zotero.HTTP.request("GET", url, {
          headers: { Accept: "application/json" },
          timeout: 30000,
        });
        return JSON.parse(req.responseText);
      } catch (e) {
        if (attempt === 1) throw e;
        await Zotero.Promise.delay(1500); // brief back-off, then retry
      }
    }
    return null;
  },

  /** Normalize a DOI to the bare lowercase form OpenAlex expects. */
  normalizeDOI(doi) {
    if (!doi) return null;
    return doi
      .trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi:/i, "")
      .toLowerCase();
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

    for (let i = 0; i < missing.length; i += this.BATCH_SIZE) {
      const batch = missing.slice(i, i + this.BATCH_SIZE);
      const filter = "doi:" + batch.join("|");
      const url =
        `${this.API_BASE}/works?filter=${encodeURIComponent(filter)}` +
        `&per-page=${this.BATCH_SIZE}&select=${this.FIELDS}${this._mailtoParam()}`;
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
      const filter = "openalex_id:" + batch.join("|");
      const url =
        `${this.API_BASE}/works?filter=${encodeURIComponent(filter)}` +
        `&per-page=${this.BATCH_SIZE}&select=${this.FIELDS}${this._mailtoParam()}`;
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
    return {
      id: (work.id || "").replace("https://openalex.org/", ""),
      doi: this.normalizeDOI(work.doi),
      title: work.title || work.display_name || "(untitled)",
      year: work.publication_year || null,
      citedByCount: work.cited_by_count || 0,
      authors,
      venue:
        (work.primary_location &&
          work.primary_location.source &&
          work.primary_location.source.display_name) ||
        null,
      references: (work.referenced_works || []).map((r) =>
        r.replace("https://openalex.org/", "")
      ),
    };
  },
};
