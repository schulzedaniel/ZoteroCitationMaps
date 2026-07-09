/**
 * bootstrap.js — plugin lifecycle entry point.
 *
 * Zotero calls these hooks at well-defined moments (see
 * https://www.zotero.org/support/dev/zotero_7_for_developers).
 * All real logic lives in modules/*.js; this file only wires
 * loading/unloading so it stays trivially auditable.
 */

/* global Services, Zotero */

var CitationMap; // namespace object populated by the loaded modules

function log(msg) {
  Zotero.debug("[Citation Map] " + msg);
}

/**
 * Load a script into a shared namespace object so all modules can see
 * each other without polluting the global sandbox.
 */
function loadModule(rootURI, path, scope) {
  Services.scriptloader.loadSubScript(rootURI + path, scope);
}

function install() {
  // Nothing to do on install; startup() handles everything.
}

async function startup({ id, version, rootURI }) {
  log(`Starting v${version}`);

  // Shared namespace for all plugin modules.
  CitationMap = { rootURI, id, version };

  // Order matters: later modules may reference earlier ones.
  loadModule(rootURI, "modules/dataSource.js", CitationMap);
  loadModule(rootURI, "modules/publisherCI.js", CitationMap);
  loadModule(rootURI, "modules/graphBuilder.js", CitationMap);
  loadModule(rootURI, "modules/graphView.js", CitationMap);
  loadModule(rootURI, "modules/citationMap.js", CitationMap);

  await CitationMap.Main.startup();

  // Register UI into every already-open main window.
  for (const win of Zotero.getMainWindows()) {
    CitationMap.Main.addToWindow(win);
  }
}

function onMainWindowLoad({ window }) {
  CitationMap.Main.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  CitationMap.Main.removeFromWindow(window);
}

function shutdown() {
  log("Shutting down");
  if (CitationMap && CitationMap.Main) {
    for (const win of Zotero.getMainWindows()) {
      CitationMap.Main.removeFromWindow(win);
    }
    CitationMap.Main.shutdown();
  }
  CitationMap = undefined;
}

function uninstall() {
  // Cache cleanup is intentionally left to the user (Tools menu → Clear cache),
  // so re-installing does not re-download everything.
}
