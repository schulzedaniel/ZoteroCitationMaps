/**
 * mapTheme.js, canvas theme + theme resolution (design system v2.0 "Clear").
 *
 * The canvas cannot read CSS variables per draw call cheaply, so the values
 * below mirror content/styles/tokens.css 1:1. Change both together.
 *
 * Loaded into the CitationMap namespace (`this` === CitationMap). Everything
 * lives inside one function scope, so no top-level lexical name can collide
 * with another module (all modules share one scope, see bootstrap.js).
 */

/* global Zotero */

this.MapTheme = (function () {
  // "auto" | "light" | "dark". (The design handoff calls the pref
  // extensions.zotero-citation-map.appearance; this plugin's pref branch is
  // extensions.citation-map.*, so it lives there with the others.)
  const PREF_THEME = "extensions.citation-map.appearance";

  const FONT =
    '"ZCM Inter", "Inter", -apple-system, "Segoe UI", system-ui, sans-serif';

  const MAP_THEME = {
    light: {
      name: "light",
      canvas: "#FAFBFC",
      band: "rgba(20,23,28,0.025)", // alternating year columns
      grid: "#E6E9ED", // log gridlines, 1px
      axisText: "#6A717D", // ticks, year labels
      labelText: "#14171C",
      labelHalo: "#FAFBFC", // 3px halo = canvas colour
      edge: "#8A929E",
      edgeAlpha: { sparse: 0.45, dense: 0.25 }, // lerp by edge count 50 → 600
      dimAlpha: 0.18,
      softAlpha: 0.12, // ring fill tint (mirrors --zcm-soft-mix)
      selectRing: "#14171C",
      node: {
        library: { fill: "#2B303A", stroke: null },
        suggested: { fill: "rgba(232,89,12,0.12)", stroke: "#E8590C" },
        discover: { fill: "rgba(124,58,237,0.12)", stroke: "#7C3AED" },
        nodata: { fill: "#8A919C", stroke: null },
      },
      cites: "#2563EB", // focused paper → its references (older)
      citedBy: "#DB2777", // newer papers → focused paper
      chain: "#0D9488",
      chainStepText: "#FFFFFF",
      newMarker: "#5A9A0A",
      clusters: [
        "#2F6FDB", "#E0670F", "#13966B", "#D6336C", "#7E57D6", "#B07D00",
        "#0C8FA6", "#C2410C", "#5C8A16", "#5B6BD8", "#B5459B", "#2E8F7E",
      ],
      // oldest → newest, interpolated in OKLCH
      year: ["#4F46E5", "#2F6FDB", "#0E8FA0", "#2E9A5E", "#9A8A00"],
      access: {
        gold: "#B88A00",
        green: "#16A34A",
        hybrid: "#9333EA",
        bronze: "#A9672F",
        diamond: "#0891B2",
        closed: "#6B7280",
        unknown: null, // hollow dashed ring in axisText
      },
    },
    dark: {
      name: "dark",
      canvas: "#111316",
      band: "rgba(255,255,255,0.025)",
      grid: "#23272C",
      axisText: "#8E95A0",
      labelText: "#EDEEF0",
      labelHalo: "#111316",
      edge: "#6B737F",
      edgeAlpha: { sparse: 0.55, dense: 0.3 },
      dimAlpha: 0.22,
      softAlpha: 0.18,
      selectRing: "#EDEEF0",
      node: {
        library: { fill: "#ECE8DD", stroke: null },
        suggested: { fill: "rgba(255,138,61,0.18)", stroke: "#FF8A3D" },
        discover: { fill: "rgba(167,139,250,0.18)", stroke: "#A78BFA" },
        nodata: { fill: "#6B727D", stroke: null },
      },
      cites: "#60A5FA",
      citedBy: "#F472B6",
      chain: "#2DD4BF",
      chainStepText: "#111316",
      newMarker: "#A3E635",
      clusters: [
        "#6EA8FE", "#FF9E57", "#4ED1A1", "#FF7AA8", "#B39CFF", "#F2C94C",
        "#4CC9E0", "#FF8A65", "#A6D96A", "#93A5FF", "#E68AD4", "#6FD6C2",
      ],
      year: ["#8B8CF6", "#60A5FA", "#3CC8D8", "#5DD68E", "#E9D24A"],
      access: {
        gold: "#FACC15",
        green: "#4ADE80",
        hybrid: "#C084FC",
        bronze: "#D9A066",
        diamond: "#67E8F9",
        closed: "#9CA3AF",
        unknown: null,
      },
    },
    // Theme-independent geometry (px at zoom 1)
    geometry: {
      nodeRadius: (ownCites) => Math.min(22, 7 + 4 * Math.sqrt(ownCites)), // 7–22
      ringWidth: 2, // open rings (suggested / discover)
      neighbourRingGap: 3.5, // blue / pink ring outside a neighbour
      neighbourRingWidth: 2,
      selectRingGap: 4,
      selectRingWidth: 1.5,
      edgeWidth: 1,
      focusEdgeWidth: 1.75,
      chainWidth: 2.25,
      chainDash: [6, 4],
      chainSpeed: 24, // px per second (static under reduced motion)
      arrowSize: 5,
      newMarkerRadius: 3,
      chainStepRadius: 8,
      brandRimWidth: 1.75, // "By journal" publisher rim
      hitRadius: 8, // minimum pointer target radius
      labelSize: 11,
      clusterLabelSize: 12,
      tickSize: 10,
      labelHaloWidth: 3,
    },
  };

  // Two example publisher colours for previews of the "By journal" mode
  // (Display popover dots, legend rim key): a blue and a red masthead.
  const BRAND_SAMPLES = ["#00629B", "#C8102E"];

  /** Canvas font shorthand in the bundled face: weight + px size. */
  function font(weight, px) {
    return `${weight} ${px}px ${FONT}`;
  }

  /* ---------- Theme resolution ------------------------------------------
     auto  → follow Zotero's window colour scheme (Settings → General →
             Appearance and Language → Color scheme), which itself may
             follow the OS. Inside Zotero's window this is exposed as
             prefers-color-scheme.
     light / dark → fixed by the user from Display ▸ Appearance.        */
  function darkQuery(win) {
    try {
      return win.matchMedia ? win.matchMedia("(prefers-color-scheme: dark)") : null;
    } catch (e) {
      return null;
    }
  }

  function resolveTheme(win, mode) {
    if (mode === "light" || mode === "dark") return mode;
    const mq = darkQuery(win);
    return mq && mq.matches ? "dark" : "light";
  }

  /** The stored appearance mode, sanitised. */
  function storedMode() {
    let mode = "auto";
    try {
      mode = Zotero.Prefs.get(PREF_THEME, true) || "auto";
    } catch (e) {
      /* no prefs (tests) */
    }
    return mode === "light" || mode === "dark" ? mode : "auto";
  }

  /**
   * Resolve `mode` and write data-theme on `root`; in "auto", keep following
   * the window's colour scheme. `onChange(palette, themeName)` runs whenever
   * the resolved theme changes (including the first call). Returns a
   * disposer; call it when the tab closes or before re-applying.
   */
  function applyTheme(root, win, mode, onChange) {
    const set = () => {
      const theme = resolveTheme(win, mode);
      if (root.getAttribute("data-theme") !== theme) {
        root.setAttribute("data-theme", theme); // CSS tokens switch instantly
        if (onChange) onChange(MAP_THEME[theme], theme); // canvas: swap + redraw
      }
    };
    set();
    const mq = darkQuery(win);
    if (!mq || !mq.addEventListener) return () => {};
    const listener = () => {
      if (mode === "auto") set();
    };
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }

  /**
   * One-shot: stamp the current theme on a standalone .zcm-root (progress
   * screen, dialogs) that has no view managing it.
   */
  function stamp(root, win) {
    try {
      root.setAttribute("data-theme", resolveTheme(win, storedMode()));
    } catch (e) {
      /* falls back to the light tokens */
    }
  }

  /* ---------- Fonts on canvas -------------------------------------------
     Canvas text silently falls back if the bundled face isn't loaded yet. */
  async function ensureMapFonts(doc) {
    try {
      await Promise.all([
        doc.fonts.load(`500 11px "ZCM Inter"`),
        doc.fonts.load(`600 12px "ZCM Inter"`),
      ]);
    } catch (_) {
      /* fall back to system sans; redraw anyway */
    }
  }

  /* ---------- Colour maths ----------------------------------------------- */
  function parseHex(hex) {
    let h = String(hex || "").trim().replace(/^#/, "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function toHex(r, g, b) {
    const c = (v) =>
      Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return "#" + c(r) + c(g) + c(b);
  }
  function lum(hex) {
    const rgb = parseHex(hex) || [0, 0, 0];
    const c = rgb.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }
  function hexToHsl(hex) {
    const rgb = parseHex(hex) || [0, 0, 0];
    const r = rgb[0] / 255;
    const g = rgb[1] / 255;
    const b = rgb[2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h =
        max === r
          ? (g - b) / d + (g < b ? 6 : 0)
          : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
      h *= 60;
    }
    return [h, s * 100, l * 100];
  }
  function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) =>
      255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
    return toHex(f(0), f(8), f(4));
  }

  /** `hex` at `alpha`, as an rgba() string (for soft ring fills). */
  function withAlpha(hex, alpha) {
    const rgb = parseHex(hex);
    if (!rgb) return hex;
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
  }

  /* ---------- Publisher colours (By journal mode) ------------------------
     Third-party brand colours are nudged in lightness until they reach
     3:1 against the current canvas: darker on light, lighter on dark.   */
  const brandCache = new Map();
  function adjustBrandColour(hex, theme) {
    if (!parseHex(hex) || !MAP_THEME[theme]) return hex;
    const ck = theme + hex;
    if (brandCache.has(ck)) return brandCache.get(ck);
    const bg = MAP_THEME[theme].canvas;
    let [h, s, l] = hexToHsl(hex);
    const step = theme === "dark" ? 2 : -2;
    for (let i = 0; i < 50 && contrast(hslToHex(h, s, l), bg) < 3; i++) {
      l = Math.max(0, Math.min(100, l + step));
    }
    const out = hslToHex(h, s, l);
    brandCache.set(ck, out);
    return out;
  }

  /* ---------- Year gradient (By year mode), interpolated in OKLCH -------- */
  function srgbToLinear(v) {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }
  function linearToSrgb(v) {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return c * 255;
  }
  function hexToOklch(hex) {
    const rgb = parseHex(hex) || [0, 0, 0];
    const r = srgbToLinear(rgb[0]);
    const g = srgbToLinear(rgb[1]);
    const b = srgbToLinear(rgb[2]);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return [L, Math.hypot(A, B), Math.atan2(B, A)];
  }
  function oklchToHex(L, C, H) {
    const A = C * Math.cos(H);
    const B = C * Math.sin(H);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    return toHex(
      linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    );
  }
  const yearCache = new Map();
  /** Colour at position t (0 = oldest … 1 = newest) of a theme's year ramp. */
  function yearColour(theme, t) {
    const stops = (MAP_THEME[theme] || MAP_THEME.light).year;
    const q = Math.round(Math.max(0, Math.min(1, t)) * 64); // 65 steps is plenty
    const ck = theme + q;
    if (yearCache.has(ck)) return yearCache.get(ck);
    const pos = (q / 64) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(pos));
    const u = pos - i;
    const a = hexToOklch(stops[i]);
    const b = hexToOklch(stops[i + 1]);
    let dh = b[2] - a[2];
    if (dh > Math.PI) dh -= 2 * Math.PI; // shortest way round the hue circle
    if (dh < -Math.PI) dh += 2 * Math.PI;
    const out = oklchToHex(
      a[0] + (b[0] - a[0]) * u,
      a[1] + (b[1] - a[1]) * u,
      a[2] + dh * u
    );
    yearCache.set(ck, out);
    return out;
  }

  /** Does the system ask for reduced motion? (camera easing, chain march) */
  function reducedMotion(win) {
    try {
      return !!(
        win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches
      );
    } catch (e) {
      return false;
    }
  }

  return {
    PREF_THEME,
    FONT,
    MAP_THEME,
    BRAND_SAMPLES,
    font,
    resolveTheme,
    storedMode,
    applyTheme,
    stamp,
    ensureMapFonts,
    adjustBrandColour,
    yearColour,
    withAlpha,
    contrast,
    reducedMotion,
  };
})();
