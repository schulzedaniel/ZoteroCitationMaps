/**
 * publisherCI.js — map a journal name to its publisher's corporate identity.
 *
 * Many scholarly publishers style every journal in a family the same way —
 * the Nature wordmark, IEEE blue, the red Lancet masthead. This module turns
 * a paper's venue string (e.g. "Nature Communications", "IEEE Transactions on
 * …", "The Lancet Oncology") into a small style object the view uses to tint
 * that paper's dot and to render its journal name in the publisher's own
 * colour and typeface — so a source is recognisable at a glance, the way it
 * looks on the publisher's site or cover.
 *
 * We never ship or fetch a publisher's logo (a copyright minefield). Instead
 * we reproduce the *cue*: brand colour + a web-safe font stack that leads with
 * the real logo face (used only if the reader happens to have it licensed) and
 * falls back to a close web-safe match. That gets visibly close without
 * copying anything.
 *
 * Design (per the project brief):
 *   - a lookup TABLE keyed by publisher/family regex patterns, compiled once;
 *   - first match wins, so specific/less-ambiguous families come before broad
 *     ones (the array order below IS the priority);
 *   - each family stores a CONFIDENCE — "high"/"medium" are treated as brand
 *     reproductions, "low"/"low-medium" as a best-effort visual cue, because
 *     several publishers (Elsevier general titles, Wiley, non-Nature Springer)
 *     deliberately do NOT enforce one identity across all their journals;
 *   - unknown venues get a NEUTRAL default (house style), never a guess.
 *
 * The data is hand-curated from journal_publisher_ci_dataset.json at the repo
 * root (colours, fonts, confidence, sources). To teach the map a new family,
 * add one entry to FAMILIES below — nothing else changes.
 *
 * Loaded into the shared CitationMap namespace by bootstrap.js (`this` ===
 * CitationMap).
 */

/* global Zotero */

this.PublisherCI = (function () {
  // ---------------------------------------------------------------- helpers

  /** House style for venues that match no known family (rule: never guess). */
  const NEUTRAL = Object.freeze({
    matched: false,
    family: null,
    confidence: null,
    bestEffort: false,
    // the view's own default sans; primary/secondary null → callers keep the
    // theme colours instead of tinting.
    font: '-apple-system, "Segoe UI", system-ui, sans-serif',
    primary: null,
    secondary: null,
    note: "",
  });

  function _fam(cfg) {
    return {
      patterns: cfg.patterns,
      style: Object.freeze({
        matched: true,
        family: cfg.family,
        confidence: cfg.confidence,
        // "low"/"low-medium" → best-effort cue, not exact reproduction.
        bestEffort: /^low/.test(cfg.confidence),
        font: cfg.font,
        primary: cfg.primary,
        secondary: cfg.secondary || null,
        note: cfg.note || "",
      }),
    };
  }

  // --------------------------------------------------------- colour on dark

  const _hexCache = new Map();

  function _parse(hex) {
    if (typeof hex !== "string") return null;
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const int = parseInt(m[1], 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
  }

  function _lum({ r, g, b }) {
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function _toHex({ r, g, b }) {
    const h = (v) => Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  }

  /**
   * Lighten a brand colour just enough to stay legible on the dark map/panels
   * (many brand colours are near-black — Nature, JAMA, ACM, PNAS — and would
   * otherwise vanish). Distinct hues stay distinct; we only raise lightness.
   * Cached, since a handful of colours are reused across hundreds of nodes.
   */
  function onDark(hex, minLum = 0.32) {
    if (!hex) return hex;
    const ck = hex + "|" + minLum;
    if (_hexCache.has(ck)) return _hexCache.get(ck);
    let rgb = _parse(hex);
    if (!rgb) {
      _hexCache.set(ck, hex);
      return hex;
    }
    let guard = 0;
    while (_lum(rgb) < minLum && guard++ < 16) {
      rgb = {
        r: rgb.r + (255 - rgb.r) * 0.18,
        g: rgb.g + (255 - rgb.g) * 0.18,
        b: rgb.b + (255 - rgb.b) * 0.18,
      };
    }
    const out = _toHex(rgb);
    _hexCache.set(ck, out);
    return out;
  }

  /** Black or white text that reads on a swatch of the given brand colour. */
  function textOn(hex) {
    const rgb = _parse(hex);
    if (!rgb) return "#0e1424";
    return _lum(rgb) > 0.42 ? "#0e1424" : "#ffffff";
  }

  // ================================================================= TABLE
  // Order = priority. Specific families first; broad, low-confidence ones
  // (Wiley, Springer, Elsevier) last, so a precise match always wins.

  const FAMILIES = [
    // --- Nature Portfolio — before Cell/others so "Nature Reviews Molecular
    //     Cell Biology" resolves to Nature, not Cell Press.
    _fam({
      family: "Nature Portfolio",
      confidence: "high",
      patterns: [/^nature\b/i, /^scientific reports\b/i, /^communications (biology|physics|chemistry|materials|earth & environment|medicine)\b/i],
      font: '"Harding", "Harding Text", Georgia, "Times New Roman", serif',
      primary: "#000000",
      secondary: "#FA0F00",
      note: "Harding wordmark system across all Nature-titled journals.",
    }),

    // --- Science / AAAS. Anchored so "Science of the Total Environment" and
    //     "Science China …" (other publishers) do NOT match.
    _fam({
      family: "Science / AAAS",
      confidence: "low-medium",
      patterns: [
        /^science$/i,
        /^science \(/i,
        /^science (advances|robotics|immunology|signaling|translational medicine)\b/i,
      ],
      font: '"Times New Roman", Georgia, serif',
      primary: "#D0143C",
      secondary: "#000000",
      note: "Baskerville-style serif wordmark (unofficial id).",
    }),

    // --- Cell Press. Explicit titles (several carry no "Cell" in the name).
    _fam({
      family: "Cell Press",
      confidence: "medium",
      patterns: [
        /^cell$/i,
        /^cell \(/i,
        /^cell (reports|metabolism|stem cell|host & microbe|systems|chemical biology|genomics|reports medicine|reports physical science)\b/i,
        /^(cancer|molecular|developmental|structural) cell\b/i,
        /^(immunity|neuron|joule|matter|chem|structure|current biology|med)$/i,
        /^trends in /i,
      ],
      font: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      primary: "#00539B",
      secondary: "#000000",
      note: "Shared Cell Press visual family incl. Neuron, Immunity, Joule.",
    }),

    // --- The Lancet family.
    _fam({
      family: "The Lancet",
      confidence: "medium",
      patterns: [/^the lancet\b/i, /^lancet\b/i],
      font: 'Georgia, "Times New Roman", serif',
      primary: "#ED1B2E",
      secondary: "#00629B",
      note: "All-caps serif masthead; sub-titles share the face.",
    }),

    // --- NEJM Group.
    _fam({
      family: "NEJM Group",
      confidence: "high",
      patterns: [/^(the )?new england journal of medicine$/i, /^nejm\b/i],
      font: '"Scala Sans", "Lucida Grande", Georgia, serif',
      primary: "#B31B1B",
      secondary: "#000000",
      note: "Scala Sans (brand) / Quadraat (editorial); circular seal.",
    }),

    // --- JAMA Network.
    _fam({
      family: "JAMA Network",
      confidence: "medium",
      patterns: [/^jama\b/i, /^the journal of the american medical association$/i],
      font: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      primary: "#BF0D3E", // dataset's secondary, promoted: black reads as neutral
      secondary: "#000000",
      note: "Bold JAMA acronym wordmark + specialty suffix.",
    }),

    // --- IEEE (before ACM: "IEEE/ACM Transactions …" → IEEE).
    _fam({
      family: "IEEE",
      confidence: "high",
      patterns: [/\bieee\b/i],
      font: '"Formata", Verdana, Tahoma, sans-serif',
      primary: "#00629B",
      secondary: "#0085E2",
      note: "IEEE Blue (PMS 3015C) master-brand colour; Formata typeface.",
    }),

    // --- ACM.
    _fam({
      family: "ACM",
      confidence: "high",
      patterns: [/\bacm\b/i, /association for computing machinery/i],
      font: '"Saira Semi Condensed", "Arial Narrow", Arial, sans-serif',
      primary: "#001044",
      secondary: "#45639C",
      note: "Single Saira Semi Condensed system across ACM touchpoints.",
    }),

    // --- American Chemical Society.
    _fam({
      family: "American Chemical Society (ACS)",
      confidence: "high",
      patterns: [
        /^acs\b/i,
        /^journal of the american chemical society$/i,
        /^(the )?journal of physical chemistry\b/i,
        /^chemical reviews$/i,
        /^nano letters$/i,
        /^chemistry of materials$/i,
        /^accounts of chemical research$/i,
        /^(analytical|inorganic) chemistry$/i,
        /^organic letters$/i,
        /^macromolecules$/i,
        /^langmuir$/i,
        /^environmental science & technology\b/i,
        /^journal of chemical (theory and computation|information and modeling)$/i,
      ],
      font: '"TheSans", "TheSans ACS", "Century Gothic", Verdana, sans-serif',
      primary: "#00558C",
      secondary: "#8C1D40",
      note: "TheSans ACS brand type; PMS 286 / PMS 123.",
    }),

    // --- arXiv (a preprint node, but a common hub in citation graphs).
    _fam({
      family: "arXiv (Cornell)",
      confidence: "high",
      patterns: [/\barxiv\b/i],
      font: '"Larabiefont", Impact, "Arial Black", sans-serif',
      primary: "#B31B1B",
      secondary: "#1C1A17",
      note: "Cornell Campus Red; Larabiefont + Xenara lockup.",
    }),

    // --- PLOS.
    _fam({
      family: "PLOS",
      confidence: "low-medium",
      patterns: [/^plos\b/i],
      font: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      primary: "#004A85",
      secondary: "#FF6300",
      note: "Shared sans-serif wordmark; per-journal accent colour.",
    }),

    // --- Frontiers (exclude "Frontiers in Bioscience" — a different house).
    _fam({
      family: "Frontiers",
      confidence: "low-medium",
      patterns: [/^frontiers in (?!bioscience)/i],
      font: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
      primary: "#D42027",
      secondary: "#000000",
      note: "Identical logo structure, subject-name suffix only.",
    }),

    // --- PNAS.
    _fam({
      family: "PNAS",
      confidence: "low",
      patterns: [/^proceedings of the national academy of sciences/i, /^pnas\b/i],
      font: 'Georgia, "Times New Roman", serif',
      primary: "#00274C",
      secondary: "#000000",
      note: "Single-journal serif wordmark.",
    }),

    // --- MDPI. Distinctive but generic single-word titles → exact-match an
    //     explicit allow-list so we don't grab lookalikes from other houses.
    _fam({
      family: "MDPI",
      confidence: "medium",
      patterns: [
        /^ijms$/i,
        /^international journal of molecular sciences$/i,
        /^(sensors|sustainability|molecules|nutrients|cancers|cells|polymers|materials|energies|viruses|pharmaceutics|antioxidants|foods|micromachines|metabolites|diagnostics|healthcare|biomolecules|catalysts|processes|symmetry|mathematics|applied sciences|remote sensing|electronics|nanomaterials|coatings|water|minerals)$/i,
      ],
      font: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
      primary: "#2D9CDB",
      secondary: "#000000",
      note: "Consistent template; per-journal colour-coded covers.",
    }),

    // --- BMC (BioMed Central).
    _fam({
      family: "BMC (BioMed Central)",
      confidence: "low",
      patterns: [/^bmc\b/i, /^genome (biology|medicine)$/i, /^molecular cancer$/i, /^microbiome$/i],
      font: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
      primary: "#0D6EAD",
      secondary: "#000000",
      note: "Separate open-access identity on Springer Nature Link.",
    }),

    // --- Royal Society of Chemistry.
    _fam({
      family: "Royal Society of Chemistry (RSC)",
      confidence: "low",
      patterns: [
        /^chemical (science|society reviews|communications)$/i,
        /^energy & environmental science$/i,
        /^journal of materials chemistry\b/i,
        /^(nanoscale|the analyst|soft matter|green chemistry|dalton transactions)$/i,
        /^physical chemistry chemical physics$/i,
      ],
      font: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
      primary: "#8F1E3E",
      secondary: "#000000",
      note: "Shared RSC masthead with per-journal accents.",
    }),

    // --- American Physical Society.
    _fam({
      family: "American Physical Society (APS)",
      confidence: "low",
      patterns: [/^physical review\b/i, /^reviews of modern physics$/i],
      font: 'Georgia, "Times New Roman", serif',
      primary: "#00457C",
      secondary: "#000000",
      note: "Physical Review family masthead, letter-suffix differentiation.",
    }),

    // --- AACR (after Cell Press so "Cancer Cell" stays Cell Press).
    _fam({
      family: "American Association for Cancer Research (AACR)",
      confidence: "low",
      patterns: [
        /^cancer discovery$/i,
        /^cancer research\b/i,
        /^clinical cancer research$/i,
        /^cancer immunology research$/i,
        /^molecular cancer (therapeutics|research)$/i,
        /^cancer (prevention research|epidemiology)/i,
      ],
      font: 'Georgia, "Times New Roman", serif',
      primary: "#8A1B61",
      secondary: "#000000",
      note: "AACR family masthead, distinct from Cell Press.",
    }),

    // --- Oxford University Press (added). Oxford Blue is well documented;
    //     matches are a curated set of flagship OUP journals, best-effort.
    _fam({
      family: "Oxford University Press",
      confidence: "low",
      patterns: [
        /^nucleic acids research$/i,
        /^bioinformatics$/i,
        /^brain$/i,
        /^molecular biology and evolution$/i,
        /^human molecular genetics$/i,
        /^systematic biology$/i,
        /^gigascience$/i,
        /^nar genomics and bioinformatics$/i,
      ],
      font: 'Georgia, "Times New Roman", serif',
      primary: "#002147", // Oxford Blue
      secondary: "#C8102E",
      note: "Added family — Oxford Blue; many OUP titles keep society branding.",
    }),

    // ---------------------------------------------------------------------
    // Publishers that do NOT enforce a single identity across all journals.
    // Kept low-confidence and narrow so precise families above always win;
    // most of their titles fall through to the neutral house style (rule 5).
    // ---------------------------------------------------------------------

    // --- Wiley — a few iconic flagship titles only.
    _fam({
      family: "Wiley",
      confidence: "low",
      patterns: [
        /^angewandte chemie/i,
        /^advanced (materials|functional materials|energy materials|science)\b/i,
      ],
      font: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      primary: "#003C71",
      secondary: "#666666",
      note: "Mostly society-owned branding; corporate CI rarely applied.",
    }),

    // --- Springer (non-Nature) — only venues literally led by "Springer".
    _fam({
      family: "Springer (non-Nature)",
      confidence: "low",
      patterns: [/^springer\b/i],
      font: 'Arial, Helvetica, sans-serif',
      primary: "#FFB81C",
      secondary: "#000000",
      note: "Identity kept separate from Nature Portfolio.",
    }),

    // Elsevier general titles are intentionally left to the neutral default:
    // there is no unified journal-level CI to reproduce (the orange mark lives
    // on ScienceDirect, not the covers). Documented here on purpose — see the
    // dataset's "Elsevier (general/independent titles)" entry, confidence low.
  ];

  // Fail fast in dev if a pattern is malformed.
  for (const f of FAMILIES) {
    for (const p of f.patterns) {
      if (!(p instanceof RegExp)) {
        throw new Error("PublisherCI: non-regex pattern in " + f.style.family);
      }
    }
  }

  // ============================================================== resolve

  const _cache = new Map(); // venue string -> resolved style (memoised)

  /**
   * Resolve a venue/journal name to its publisher CI style.
   * @param {string|null} venue
   * @returns {object} a frozen style object (NEUTRAL when nothing matches)
   */
  function styleFor(venue) {
    if (!venue || typeof venue !== "string") return NEUTRAL;
    const key = venue.trim();
    if (!key) return NEUTRAL;
    if (_cache.has(key)) return _cache.get(key);

    // Respect a user opt-out; when off, every venue is neutral.
    let enabled = true;
    try {
      const pref = Zotero.Prefs.get(
        "extensions.citation-map.journalBranding",
        true
      );
      if (pref === false) enabled = false;
    } catch (e) {
      /* Zotero.Prefs unavailable (tests) → default on */
    }

    let resolved = NEUTRAL;
    if (enabled) {
      for (const fam of FAMILIES) {
        if (fam.patterns.some((re) => re.test(key))) {
          resolved = fam.style;
          break;
        }
      }
    }
    _cache.set(key, resolved);
    return resolved;
  }

  /** Drop the memo cache (e.g. after the branding pref is toggled). */
  function clearCache() {
    _cache.clear();
  }

  return { styleFor, onDark, textOn, clearCache, NEUTRAL, FAMILIES };
})();
