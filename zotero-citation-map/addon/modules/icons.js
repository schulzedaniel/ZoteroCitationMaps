/**
 * icons.js, the pictogram set (design system v2.0 "Clear").
 *
 * 16px grid, 12px live area, 1.5px strokes, round caps and joins, drawn in
 * currentColor (see .zcm-ic in components.css). Icons are created as inline
 * <svg> elements rather than <use href> references to a sprite, so they need
 * no extra document-level node in Zotero's window and nothing to clean up.
 *
 * Loaded into the CitationMap namespace (`this` === CitationMap); wrapped in
 * a function scope so no top-level name can collide with another module.
 */

this.Icons = (function () {
  const SVG_NS = "http://www.w3.org/2000/svg";

  // name → inner markup (viewBox 0 0 16 16)
  const PATHS = {
    timeline: '<path d="M2.5 2.5v11h11"/><circle cx="6" cy="9.5" r="1.5"/><circle cx="9" cy="6.5" r="1.5"/><circle cx="12.5" cy="4.25" r="1.5"/>',
    network: '<circle cx="4" cy="4.5" r="1.75"/><circle cx="12" cy="4" r="1.75"/><circle cx="8" cy="12" r="1.75"/><path d="M5.75 4.4h4.5M4.85 6.05l2.3 4.4M11.15 5.6l-2.3 4.8"/>',
    search: '<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3.25 3.25"/>',
    filter: '<path d="M2.5 3.5h11l-4.25 5.25v3.75l-2.5 1.25v-5z"/>',
    sliders: '<path d="M2.5 5h2M8 5h5.5M2.5 11h6M12 11h1.5"/><circle cx="6.25" cy="5" r="1.75"/><circle cx="10.25" cy="11" r="1.75"/>',
    more: '<circle cx="3.75" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.25" cy="8" r=".6"/>',
    refresh: '<path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M13.25 2.5v3h-3"/>',
    bulb: '<path d="M6 12.25h4M6.75 14.25h2.5"/><path d="M8 1.75a4.25 4.25 0 0 0-2.4 7.76c.35.24.4.5.4.9v.34h4v-.34c0-.4.05-.66.4-.9A4.25 4.25 0 0 0 8 1.75z"/>',
    compass: '<circle cx="8" cy="8" r="5.75"/><path d="m10.5 5.5-1.25 3.75L5.5 10.5l1.25-3.75z"/>',
    chain: '<path d="m6.5 9.5 3-3"/><path d="m8.5 4.5.9-.9a2.5 2.5 0 0 1 3.5 3.5l-.9.9"/><path d="m7.5 11.5-.9.9a2.5 2.5 0 0 1-3.5-3.5l.9-.9"/>',
    books: '<path d="M2.5 2.75H5v10.5H2.5zM6.5 2.75H9v10.5H6.5z"/><path d="m10.25 3.6 2.2-.5 1.9 9.8-2.2.5z"/>',
    "arrow-left": '<path d="M13 8H3.5M7 4.5 3.5 8 7 11.5"/>',
    "arrow-right": '<path d="M3 8h9.5M9 4.5l3.5 3.5L9 11.5"/>',
    sparkle: '<path d="M8 2.75c.45 2.8 2.45 4.8 5.25 5.25-2.8.45-4.8 2.45-5.25 5.25-.45-2.8-2.45-4.8-5.25-5.25 2.8-.45 4.8-2.45 5.25-5.25z"/>',
    review: '<path d="M5.5 2.5h4l2.5 2.5v8.5H5.5z"/><path d="M9.5 2.5V5H12M7.5 8.25h2.5M7.5 10.75h2.5M3.5 4.75v9.75h6"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    minus: '<path d="M3.5 8h9"/>',
    fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
    help: '<circle cx="8" cy="8" r="5.75"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.3 1.6c-.45.18-.7.55-.7 1v.3"/><path d="M8 11.1v.05"/>',
    close: '<path d="m4.5 4.5 7 7m0-7-7 7"/>',
    add: '<circle cx="8" cy="8" r="5.75"/><path d="M8 5.5v5M5.5 8h5"/>',
    external: '<path d="M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>',
    sun: '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>',
    moon: '<path d="M13.25 9.6A5.5 5.5 0 1 1 6.4 2.75a4.4 4.4 0 0 0 6.85 6.85z"/>',
    auto: '<circle cx="8" cy="8" r="5.75"/><path d="M8 2.25a5.75 5.75 0 0 1 0 11.5z" fill="currentColor" stroke="none"/>',
    warning: '<path d="M7.13 2.98a1 1 0 0 1 1.74 0l5.2 9.02a1 1 0 0 1-.87 1.5H2.8a1 1 0 0 1-.87-1.5z"/><path d="M8 6.5v3M8 11.6v.05"/>',
    info: '<circle cx="8" cy="8" r="5.75"/><path d="M8 7.5v3.25M8 5.3v.05"/>',
    error: '<circle cx="8" cy="8" r="5.75"/><path d="m6.1 6.1 3.8 3.8m0-3.8-3.8 3.8"/>',
    folder: '<path d="M2.5 4.25a1 1 0 0 1 1-1h2.6l1.4 1.5h5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
    "chev-down": '<path d="m4.5 6.25 3.5 3.5 3.5-3.5"/>',
    "chev-up": '<path d="m4.5 9.75 3.5-3.5 3.5 3.5"/>',
    "chev-left": '<path d="M9.75 4.5 6.25 8l3.5 3.5"/>',
    "chev-right": '<path d="m6.25 4.5 3.5 3.5-3.5 3.5"/>',
    "eye-off": '<path d="M2 8s2.2-4.25 6-4.25S14 8 14 8s-2.2 4.25-6 4.25S2 8 2 8z"/><circle cx="8" cy="8" r="1.75"/><path d="m3 13 10-10"/>',
    tag: '<path d="M2.75 2.75h5l5.5 5.5-5 5-5.5-5.5z"/><path d="M5.5 5.5v.05"/>',
    calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
    download: '<path d="M8 2.5v8M4.75 7.25 8 10.5l3.25-3.25M2.75 13.5h10.5"/>',
    upload: '<path d="M8 10.5v-8M4.75 5.75 8 2.5l3.25 3.25M2.75 13.5h10.5"/>',
    key: '<circle cx="5.5" cy="10.5" r="3"/><path d="m7.6 8.4 5.65-5.65M11.25 4.75l1.5 1.5"/>',
    file: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
    locate: '<circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.25"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/>',
    check: '<path d="m3.5 8.25 3 3 6-6.5"/>',
    keyboard: '<rect x="1.75" y="4" width="12.5" height="8" rx="1.5"/><path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5 9.5h6"/>',
    link2: '<circle cx="4.5" cy="8" r="2"/><circle cx="11.5" cy="8" r="2"/><path d="M6.5 8h3" stroke-dasharray="1 1.5"/>',
    sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/>',
    note: '<path d="M3.5 2.5h9v7l-3.5 4h-5.5z"/><path d="M12.5 9.5H9v4M5.75 5.5h4.5M5.75 8h2.5"/>',
    spinner: '<path d="M8 2.25A5.75 5.75 0 1 1 2.25 8"/>',
  };

  // Brand mark: a small citation map. A focused paper (centre), the older
  // papers it cites in blue, the newer ones citing it in pink (one of them a
  // suggestion, drawn as an open ring), and a neutral link between two of
  // the older papers. viewBox 0 0 32 32; colours come from the .logo-*
  // classes (feature tokens).
  const LOGO =
    '<path class="logo-cites" d="M12.9 19.01L8.48 22.99" fill="none" stroke-width="2.0" stroke-linecap="round"/>' +
    '<path class="logo-cites" d="M12.83 13.88L8.89 10.54" fill="none" stroke-width="2.0" stroke-linecap="round"/>' +
    '<path class="logo-citedby" d="M18.98 18.66L23.59 21.94" fill="none" stroke-width="2.0" stroke-linecap="round"/>' +
    '<path class="logo-citedby" d="M18.5 13.58L22.02 9.9" fill="none" stroke-width="2.0" stroke-linecap="round"/>' +
    '<path class="logo-edge" d="M6.44 11.9L5.99 21.5" fill="none" stroke-width="1.4" stroke-linecap="round"/>' +
    '<circle class="logo-ink" cx="5.8" cy="25.4" r="2.6"/>' +
    '<circle class="logo-ink" cx="6.6" cy="8.6" r="2.0"/>' +
    '<circle class="logo-ink" cx="26.2" cy="23.8" r="2.2"/>' +
    '<circle class="logo-ink" cx="15.8" cy="16.4" r="2.9"/>' +
    '<circle class="logo-sug" cx="25.0" cy="6.8" r="2.4" stroke-width="1.8"/>';

  const templates = new Map(); // key → parsed <svg> element (cloned per use)

  function template(doc, key, viewBox, inner) {
    let tpl = templates.get(key);
    if (!tpl) {
      const parser = new doc.defaultView.DOMParser();
      const parsed = parser.parseFromString(
        `<svg xmlns="${SVG_NS}" viewBox="${viewBox}">${inner}</svg>`,
        "image/svg+xml"
      );
      tpl = parsed.documentElement;
      templates.set(key, tpl);
    }
    return doc.importNode(tpl, true);
  }

  /** A pictogram as an inline <svg class="zcm-ic …" aria-hidden="true">. */
  function make(doc, name, cls) {
    const inner = PATHS[name] || PATHS.info;
    const svg = template(doc, "i-" + name, "0 0 16 16", inner);
    svg.setAttribute("class", "zcm-ic" + (cls ? " " + cls : ""));
    svg.setAttribute("aria-hidden", "true");
    return svg;
  }

  /** The full-colour brand mark. */
  function logo(doc, label) {
    const svg = template(doc, "logo", "0 0 32 32", LOGO);
    svg.setAttribute("class", "zcm-logo");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label || "Citation Map");
    return svg;
  }

  /**
   * A small legend / kind-line mark built from raw SVG markup, e.g.
   * shape(doc, '<circle class="m-lib" cx="6" cy="6" r="5"/>', 12).
   */
  function shape(doc, inner, size) {
    const s = size || 12;
    const svg = template(doc, "s" + s + inner, `0 0 ${s} ${s}`, inner);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "zcm-mark");
    return svg;
  }

  return { make, logo, shape, has: (name) => !!PATHS[name] };
})();
