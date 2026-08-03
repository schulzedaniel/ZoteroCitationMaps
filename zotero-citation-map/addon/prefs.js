/* Default preferences for Citation Map.
 * Access in code via Zotero.Prefs.get("extensions.citation-map.<key>", true)
 */

// Minimum number of library papers that must cite an external work
// before the discovery engine surfaces it as a suggestion.
pref("extensions.citation-map.discoveryThreshold", 2);

// Maximum number of suggested (discovered) papers shown on the map.
pref("extensions.citation-map.maxDiscovered", 15);

// Default for the first-run subcollection picker: true = start with every
// subfolder checked, false = start with only the selected collection.
pref("extensions.citation-map.includeSubcollections", true);

// Remembered per-collection subcollection choice, as JSON:
//   { "<collectionID>": { "mode": "all" | "custom", "ids": [<collectionID>...] } }
// Managed automatically by the in-map "Subfolders" picker.
pref("extensions.citation-map.subScopes", "{}");

// Minimum length (number of nodes) for a highlighted citation chain.
pref("extensions.citation-map.minChainLength", 3);

// Days before a cached OpenAlex record is considered stale.
pref("extensions.citation-map.cacheDays", 30);

// Whether the in-map guide has been shown once (it auto-opens on first use).
pref("extensions.citation-map.guideShown", false);

// Whether the short first-run tour has been shown once (the "?" map button
// reopens it anytime).
pref("extensions.citation-map.tourShown", false);

// Distance between papers on the map, in percent (the "Spacing" slider).
pref("extensions.citation-map.nodeSpacing", 100);

// Thickness of the citation lines, in percent (the "Lines" slider).
pref("extensions.citation-map.edgeWidth", 100);

// Which sidebar tab was last open: "suggested", "chains" or "papers".
pref("extensions.citation-map.sideTab", "suggested");

// How suggested papers appear on the map: "off", "top" (a few, teased) or "all".
pref("extensions.citation-map.suggestDisplay", "top");

// Minimum number of your papers that must cite a suggestion for it to be
// listed/shown (the ×N filter in the sidebar).
pref("extensions.citation-map.suggestMinCiters", 2);

// How many suggestions the "Top" map mode shows.
pref("extensions.citation-map.suggestTopCount", 4);

// Polite-pool contact for OpenAlex requests (recommended by OpenAlex).
// Set to your e-mail address in Config Editor for faster, more reliable API access.
pref("extensions.citation-map.mailto", "");

// Tint papers with their journal's publisher corporate identity (brand colour
// + logo-style font for the journal name). Set false for the neutral house
// style everywhere. See modules/publisherCI.js.
pref("extensions.citation-map.journalBranding", true);

// What the dot colors encode: "kind" (the neutral default — library /
// suggested / no-data in distinct colors, no journal coloring), "publisher"
// (journal branding rims), "year" (publication-year gradient), "cluster"
// (citation cluster) or "oa" (open-access status).
pref("extensions.citation-map.colorMode", "kind");

// Sidebar width in px and whether it starts collapsed (both adjustable from
// the map: drag the divider, click the collapse chevron).
pref("extensions.citation-map.sidebarWidth", 320);
pref("extensions.citation-map.sidebarCollapsed", false);

// Remembered Discover time filter: "any", "2y", "5y", "10y", or a 4-digit
// year string for a custom cutoff.
pref("extensions.citation-map.discoverSince", "any");

// Draw bibliographic-coupling links (two of your papers sharing several
// references) as a second, dashed layer on the map.
pref("extensions.citation-map.showCoupling", false);

// Minimum number of shared references before two papers count as coupled.
pref("extensions.citation-map.couplingMinShared", 3);

// The plugin version whose "What's new" overlay was last shown. Managed
// automatically; upgraders see the overlay once per feature release.
pref("extensions.citation-map.lastSeenVersion", "");

// Hide review / secondary-literature articles everywhere (map, suggestions,
// Discover results, My papers). Toggled from the toolbar.
pref("extensions.citation-map.hideReviews", false);

// Discover search: which sources are enabled by default.
pref("extensions.citation-map.discoverCiting", true);
pref("extensions.citation-map.discoverTopics", true);
pref("extensions.citation-map.discoverRelated", true);

// Ask for confirmation before mapping more than this many items, and refuse
// gently above 4x this (very large maps can make Zotero unresponsive).
pref("extensions.citation-map.warnItemCount", 400);
