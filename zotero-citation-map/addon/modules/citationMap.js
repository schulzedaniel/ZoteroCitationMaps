/**
 * citationMap.js — main controller.
 *
 * Owns everything that touches the Zotero UI shell:
 *   - Tools menu entry + collection context-menu entry
 *   - Opening a "Citation Map" tab and running the build pipeline in it
 *   - The subcollection-scope picker (which subfolders to include)
 *   - Importing a previously exported map from JSON
 *   - Progress display + error handling
 *   - Clean removal of every element it created (bootstrap requirement)
 *
 * Loaded into the CitationMap namespace (`this` === CitationMap).
 */

/* global Zotero, IOUtils, ChromeUtils */

this.Main = {
  _ns: this, // the CitationMap namespace
  _windowEntries: new Map(), // window -> [elements to remove]
  _windowCleanups: new Map(), // window -> [functions undoing patches]
  _views: [], // open GraphView instances
  // tabID -> { win, gen }: every tab this plugin opened, and a counter that
  // bumps on each (re)build, so a build that finishes after its tab was
  // closed or rebuilt again knows to throw its result away
  _tabs: new Map(),

  async startup() {
    await this._ns.DataSource.initCache();
    this._scrubSession();
  },

  shutdown() {
    for (const view of this._views) view.destroy();
    this._views = [];
    // Close our tabs too: after a disable/update they would otherwise stay
    // open as blank "Citation Map — …" tabs driven by unloaded code.
    for (const [tabID, t] of this._tabs) {
      try {
        t.win.Zotero_Tabs.close(tabID);
      } catch (e) {
        /* tab or window already gone */
      }
    }
    this._tabs.clear();
  },

  /**
   * Map tabs can't be restored after a restart (their content is built live),
   * and Zotero_Tabs.restoreState() THROWS on a tab type it has no hook for,
   * which aborts the restore of every later tab (PDF readers included). Older
   * versions of this plugin let map tabs into session.json; drop them.
   */
  _scrubSession() {
    try {
      const state = Zotero.Session && Zotero.Session.state;
      for (const w of (state && state.windows) || []) {
        if (Array.isArray(w.tabs)) {
          w.tabs = w.tabs.filter((t) => !t || t.type !== "citation-map");
        }
      }
    } catch (e) {
      Zotero.debug("[Citation Map] session scrub failed: " + e);
    }
  },

  /** Keep this window's map tabs out of the saved session (see above). */
  _patchTabSession(win) {
    const tabs = win.Zotero_Tabs;
    if (!tabs || typeof tabs.getState !== "function") return null;
    const original = tabs.getState;
    const patched = function () {
      return original.apply(this, arguments).filter((t) => t.type !== "citation-map");
    };
    tabs.getState = patched;
    // Safety net for a session saved before this patch existed: the
    // "citation" restore hook resolves to "nothing to restore".
    const hooks = tabs.tabHooks && tabs.tabHooks.restoreState;
    const hook = async () => ({ itemID: null });
    if (hooks && !hooks.citation) hooks.citation = hook;
    return () => {
      if (tabs.getState === patched) tabs.getState = original;
      if (hooks && hooks.citation === hook) delete hooks.citation;
    };
  },

  /** Register a tab this plugin opened. */
  _trackTab(win, tabID) {
    this._tabs.set(tabID, { win, gen: 0 });
  },

  /** Start a new build in a tab; returns a check "is this build still current?". */
  _beginBuild(tabID, container) {
    const t = this._tabs.get(tabID);
    const gen = t ? ++t.gen : 0;
    return () => {
      const cur = this._tabs.get(tabID);
      return !!cur && cur.gen === gen && container.isConnected !== false;
    };
  },

  _onTabClosed(tabID) {
    this._tabs.delete(tabID);
    this._destroyView(tabID);
  },

  // ------------------------------------------------------------- window UI

  addToWindow(win) {
    const doc = win.document;
    const created = [];

    // Stylesheet for the graph view (scoped by .zcm- prefix). A cache-busting
    // query (version + load time) forces Zotero to load the CURRENT css and
    // never a stale cached copy from a previous install at the same URL, which
    // otherwise made cosmetic changes appear not to take effect.
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href =
      this._ns.rootURI +
      "content/graph.css?v=" +
      encodeURIComponent(this._ns.version || "0") +
      "&t=" +
      Date.now();
    doc.documentElement.appendChild(link);
    created.push(link);

    // Tools menu → Show Citation Map
    const toolsPopup = doc.getElementById("menu_ToolsPopup");
    if (toolsPopup) {
      const mi = doc.createXULElement("menuitem");
      mi.id = "zcm-tools-menuitem";
      mi.setAttribute("label", "Show Citation Map");
      mi.addEventListener("command", () => this.open(win));
      toolsPopup.appendChild(mi);
      created.push(mi);

      const miImport = doc.createXULElement("menuitem");
      miImport.id = "zcm-tools-import";
      miImport.setAttribute("label", "Import Citation Map (JSON)…");
      miImport.addEventListener("command", () => this.importJSON(win));
      toolsPopup.appendChild(miImport);
      created.push(miImport);

      const miClear = doc.createXULElement("menuitem");
      miClear.id = "zcm-tools-clear-cache";
      miClear.setAttribute("label", "Citation Map: Clear API Cache");
      miClear.addEventListener("command", async () => {
        await this._ns.DataSource.clearCache();
        win.alert("Citation Map: cache cleared.");
      });
      toolsPopup.appendChild(miClear);
      created.push(miClear);
    }

    // Items toolbar → map button, next to the "Add Item by Identifier" wand.
    // Maps the selected items when several are selected, else the current
    // collection (with a subcollection picker on first use).
    const lookupBtn = doc.getElementById("zotero-tb-lookup");
    const itemsToolbar = lookupBtn
      ? lookupBtn.parentNode
      : doc.getElementById("zotero-items-toolbar");
    if (itemsToolbar) {
      const btn = doc.createXULElement("toolbarbutton");
      btn.id = "zcm-tb-button";
      btn.className = "zotero-tb-button";
      btn.setAttribute(
        "tooltiptext",
        "Show citation map for the current collection " +
          "(or the selected items, if several are selected)"
      );
      btn.addEventListener("command", () =>
        this.open(win, { preferSelection: true })
      );
      itemsToolbar.insertBefore(btn, lookupBtn ? lookupBtn.nextSibling : null);
      created.push(btn);
      Zotero.debug(
        `[Citation Map] v${this._ns.version}: toolbar button installed`
      );
    } else {
      Zotero.debug("[Citation Map] Items toolbar not found — button skipped");
    }

    const cleanups = [];

    // Collection context menu → Show Citation Map for This Collection. The
    // label follows the selection (several collections on Zotero 10, a
    // saved search, a library), and the item hides where a map makes no
    // sense (trash, feeds).
    const collPopup = doc.getElementById("zotero-collectionmenu");
    if (collPopup) {
      const mi = doc.createXULElement("menuitem");
      mi.id = "zcm-collection-menuitem";
      mi.setAttribute("label", "Show Citation Map for This Collection");
      mi.addEventListener("command", () => this.open(win));
      collPopup.appendChild(mi);
      created.push(mi);
      const onShowing = (ev) => {
        if (ev.target !== collPopup) return;
        try {
          const { label, hidden } = this._contextLabel(win.ZoteroPane);
          mi.setAttribute("label", label);
          mi.hidden = hidden;
        } catch (e) {
          /* keep the default label */
        }
      };
      collPopup.addEventListener("popupshowing", onShowing);
      cleanups.push(() => collPopup.removeEventListener("popupshowing", onShowing));
    }

    const unpatch = this._patchTabSession(win);
    if (unpatch) cleanups.push(unpatch);

    this._windowEntries.set(win, created);
    this._windowCleanups.set(win, cleanups);
  },

  removeFromWindow(win) {
    for (const el of this._windowEntries.get(win) || []) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    this._windowEntries.delete(win);
    for (const fn of this._windowCleanups.get(win) || []) {
      try {
        fn();
      } catch (e) {
        /* best-effort */
      }
    }
    this._windowCleanups.delete(win);
  },

  /** Context-menu label for the current collections-pane selection. */
  _contextLabel(pane) {
    const cols = this._selectedCollections(pane);
    if (cols.length > 1) {
      return { label: `Show Citation Map for These ${cols.length} Collections`, hidden: false };
    }
    if (cols.length === 1) {
      return { label: "Show Citation Map for This Collection", hidden: false };
    }
    const row = this._selectedTreeRows(pane)[0];
    const is = (fn) => !!(row && typeof row[fn] === "function" && row[fn]());
    if (is("isTrash") || is("isFeed") || is("isFeedsOrFeed")) {
      return { label: "Show Citation Map", hidden: true };
    }
    if (is("isLibrary") || is("isGroup")) {
      return { label: "Show Citation Map for This Library", hidden: false };
    }
    return { label: "Show Citation Map for These Items", hidden: false };
  },

  // =========================================================== subcollections
  //
  // A collection can be mapped with any subset of its subcollections. The
  // choice ("scope") is stored per collection and reused on later runs, but
  // can be changed from the map's toolbar at any time.
  //
  //   scope = { mode: "all" | "custom", ids: number[] }
  //     "all"    — the collection + every current subcollection
  //     "custom" — the collection + exactly the listed subcollection ids
  //
  // The root collection is always included.

  /** Ordered [{ col, depth }] of a collection's descendant subcollections. */
  _subTree(root) {
    const flat = root.getDescendents(false, "collection") || [];
    const cols = new Map();
    for (const d of flat) {
      const c = Zotero.Collections.get(d.id);
      if (c) cols.set(c.id, c);
    }
    const childrenOf = new Map();
    for (const c of cols.values()) {
      if (!childrenOf.has(c.parentID)) childrenOf.set(c.parentID, []);
      childrenOf.get(c.parentID).push(c);
    }
    const ordered = [];
    const visit = (parentID, depth) => {
      const kids = (childrenOf.get(parentID) || []).sort((a, b) =>
        String(a.name).localeCompare(String(b.name))
      );
      for (const k of kids) {
        ordered.push({ col: k, depth });
        visit(k.id, depth + 1);
      }
    };
    visit(root.id, 1);
    // Any collection whose parent is outside this set (shouldn't happen, but
    // guards against odd trees) is appended at the top level.
    const placed = new Set(ordered.map((o) => o.col.id));
    for (const c of cols.values()) {
      if (!placed.has(c.id)) ordered.push({ col: c, depth: 1 });
    }
    return ordered;
  },

  /** Default scope for a first-time collection, honouring the legacy pref. */
  _defaultScope() {
    const inclAll = Zotero.Prefs.get(
      "extensions.citation-map.includeSubcollections",
      true
    );
    return inclAll === false ? { mode: "custom", ids: [] } : { mode: "all", ids: [] };
  },

  _getScope(collectionID) {
    try {
      const raw = Zotero.Prefs.get("extensions.citation-map.subScopes", true);
      if (!raw) return null;
      const map = JSON.parse(raw);
      const s = map && map[collectionID];
      if (s && (s.mode === "all" || s.mode === "custom")) {
        return {
          mode: s.mode,
          ids: Array.isArray(s.ids) ? s.ids.map(Number) : [],
        };
      }
    } catch (e) {
      Zotero.debug("[Citation Map] scope read failed: " + e);
    }
    return null;
  },

  _setScope(collectionID, scope) {
    try {
      const raw = Zotero.Prefs.get("extensions.citation-map.subScopes", true);
      let map = {};
      if (raw) {
        try {
          map = JSON.parse(raw) || {};
        } catch (e) {
          map = {};
        }
      }
      map[collectionID] = { mode: scope.mode, ids: scope.ids || [] };
      Zotero.Prefs.set(
        "extensions.citation-map.subScopes",
        JSON.stringify(map),
        true
      );
    } catch (e) {
      Zotero.debug("[Citation Map] scope save failed: " + e);
    }
  },

  /** The collections a scope resolves to (root first). */
  _resolveCollections(root, subtree, scope) {
    const cols = [root];
    if (scope.mode === "all") {
      for (const s of subtree) cols.push(s.col);
    } else {
      const inc = new Set((scope.ids || []).map(Number));
      for (const s of subtree) if (inc.has(s.col.id)) cols.push(s.col);
    }
    return cols;
  },

  /** Deduplicated regular items across a set of collections. */
  async _itemsFromCollections(collections) {
    let items = [];
    for (const c of collections) {
      // Child-item data is loaded lazily; getChildItems() throws an
      // UnloadedDataException for any collection Zotero has not loaded yet.
      if (typeof c.loadDataType === "function") {
        await c.loadDataType("childItems");
      }
      items = items.concat(c.getChildItems(false, false));
    }
    const seen = new Set();
    return items.filter((i) => {
      if (!i.isRegularItem() || seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    });
  },

  /**
   * Modal, in-tab picker of which subcollections to include. Renders an
   * overlay over the tab (the map, if any, stays underneath) and resolves to
   * the chosen scope, or null if cancelled (change mode only).
   */
  _showScopePicker(win, container, collection, subtree, currentScope, { initial }) {
    const doc = win.document;
    return new Promise((resolve) => {
      // The overlay is absolutely positioned; give the container a context.
      container.style.position = "relative";

      const overlay = doc.createElement("div");
      overlay.className = "zcm-root zcm-scope-overlay";
      const card = doc.createElement("div");
      card.className = "zcm-scope-card";

      const head = doc.createElement("div");
      head.className = "zcm-scope-head";
      const htitle = doc.createElement("div");
      htitle.className = "zcm-title-name";
      htitle.textContent = "Which subcollections to include?";
      head.appendChild(htitle);
      card.appendChild(head);

      const n = subtree.length;
      const sub = doc.createElement("div");
      sub.className = "zcm-scope-sub";
      sub.textContent =
        `“${collection.name}” has ${n} subcollection${n === 1 ? "" : "s"}. ` +
        "Choose which to map — your choice is remembered for this collection " +
        "and can be changed anytime from the toolbar.";
      card.appendChild(sub);

      const tools = doc.createElement("div");
      tools.className = "zcm-scope-tools";
      const btnAll = doc.createElement("button");
      btnAll.className = "zcm-btn";
      btnAll.textContent = "Select all";
      const btnNone = doc.createElement("button");
      btnNone.className = "zcm-btn";
      btnNone.textContent = "Only this collection";
      tools.appendChild(btnAll);
      tools.appendChild(btnNone);
      card.appendChild(tools);

      const list = doc.createElement("div");
      list.className = "zcm-scope-list";

      // Root row — always included, shown checked and disabled.
      const rootRow = doc.createElement("label");
      rootRow.className = "zcm-scope-row zcm-scope-root";
      const rootCb = doc.createElement("input");
      rootCb.type = "checkbox";
      rootCb.checked = true;
      rootCb.disabled = true;
      rootRow.appendChild(rootCb);
      const rootName = doc.createElement("span");
      rootName.className = "zcm-scope-name";
      rootName.textContent = collection.name;
      rootRow.appendChild(rootName);
      const rootTag = doc.createElement("span");
      rootTag.className = "zcm-scope-tag";
      rootTag.textContent = "this collection";
      rootRow.appendChild(rootTag);
      list.appendChild(rootRow);

      const inc =
        currentScope.mode === "custom"
          ? new Set((currentScope.ids || []).map(Number))
          : null;
      const entries = [];
      for (const { col, depth } of subtree) {
        const row = doc.createElement("label");
        row.className = "zcm-scope-row";
        row.style.paddingLeft = 10 + depth * 18 + "px";
        const cb = doc.createElement("input");
        cb.type = "checkbox";
        cb.checked = currentScope.mode === "all" ? true : inc.has(col.id);
        row.appendChild(cb);
        const nm = doc.createElement("span");
        nm.className = "zcm-scope-name";
        nm.textContent = col.name;
        row.appendChild(nm);
        list.appendChild(row);
        entries.push({ col, cb });
      }
      card.appendChild(list);

      btnAll.addEventListener("click", () =>
        entries.forEach((e) => (e.cb.checked = true))
      );
      btnNone.addEventListener("click", () =>
        entries.forEach((e) => (e.cb.checked = false))
      );

      const finish = (scope) => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(scope);
      };
      const computeScope = () => {
        const checked = entries.filter((e) => e.cb.checked).map((e) => e.col.id);
        if (checked.length === entries.length) return { mode: "all", ids: [] };
        return { mode: "custom", ids: checked };
      };

      const foot = doc.createElement("div");
      foot.className = "zcm-scope-foot";
      if (!initial) {
        const cancel = doc.createElement("button");
        cancel.className = "zcm-btn";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => finish(null));
        foot.appendChild(cancel);
      }
      const primary = doc.createElement("button");
      primary.className = "zcm-btn zcm-btn-primary";
      primary.textContent = initial ? "Show map" : "Update map";
      primary.addEventListener("click", () => finish(computeScope()));
      foot.appendChild(primary);
      card.appendChild(foot);

      overlay.appendChild(card);
      if (!initial) {
        // Click on the dim backdrop = cancel (keep the current map).
        overlay.addEventListener("click", (ev) => {
          if (ev.target === overlay) finish(null);
        });
      }
      container.appendChild(overlay);
    });
  },

  // ------------------------------------------------------- pane selection
  //
  // Zotero 10 made the collections pane multi-select: the singular getters
  // (getSelectedCollection, getSelectedLibraryID, getCollectionTreeRow) now
  // THROW, and plural replacements exist. Zotero 7–9 only have the singular
  // ones. These helpers prefer the plural API and fall back, so one build
  // runs on both.

  /** Selected collections (possibly several on Zotero 10+). */
  _selectedCollections(pane) {
    if (typeof pane.getSelectedCollections === "function") {
      try {
        return (pane.getSelectedCollections() || []).filter(Boolean);
      } catch (e) {
        /* fall back to the singular API below */
      }
    }
    try {
      const c = pane.getSelectedCollection();
      return c ? [c] : [];
    } catch (e) {
      return [];
    }
  },

  /** The library of the current selection (first one, if several). */
  _selectedLibraryID(pane) {
    if (typeof pane.getSelectedLibraryIDs === "function") {
      try {
        const ids = pane.getSelectedLibraryIDs() || [];
        if (ids.length) return ids[0];
      } catch (e) {
        /* fall back */
      }
    }
    try {
      const id = pane.getSelectedLibraryID();
      if (id) return id;
    } catch (e) {
      /* fall back */
    }
    return Zotero.Libraries.userLibraryID;
  },

  /** Selected collection-tree rows (library, search, trash, unfiled, …). */
  _selectedTreeRows(pane) {
    if (typeof pane.getCollectionTreeRows === "function") {
      try {
        return (pane.getCollectionTreeRows() || []).filter(Boolean);
      } catch (e) {
        /* fall back */
      }
    }
    try {
      const row = pane.getCollectionTreeRow();
      return row ? [row] : [];
    } catch (e) {
      return [];
    }
  },

  _libraryName(libraryID) {
    try {
      return Zotero.Libraries.getName(libraryID) || "My Library";
    } catch (e) {
      return "My Library";
    }
  },

  // -------------------------------------------------------------- pipeline

  /**
   * What to map: a multi-item selection, one or several collections, the
   * items a special view shows (saved search, Unfiled, Duplicates, …), or
   * the whole library.
   */
  _resolveSource(win, preferSelection) {
    const pane = win.ZoteroPane;
    if (preferSelection) {
      // A selected note, attachment or annotation stands for its paper.
      const seen = new Set();
      const selected = [];
      for (const sel of pane.getSelectedItems() || []) {
        let it = sel;
        try {
          while (it && !it.isRegularItem() && it.parentItem) it = it.parentItem;
        } catch (e) {
          it = null;
        }
        if (it && it.isRegularItem() && !seen.has(it.id)) {
          seen.add(it.id);
          selected.push(it);
        }
      }
      if (selected.length >= 2) {
        return { kind: "items", items: selected, name: "Selected Items" };
      }
    }
    const collections = this._selectedCollections(pane);
    if (collections.length === 1) {
      const collection = collections[0];
      return { kind: "collection", collection, name: collection.name };
    }
    if (collections.length > 1) {
      const names = collections.map((c) => c.name);
      return {
        kind: "collections",
        collections,
        name:
          names.length <= 3
            ? names.join(" + ")
            : `${names.slice(0, 2).join(" + ")} + ${names.length - 2} more`,
      };
    }

    // Not a collection: a library root, or a special view. A special view
    // maps exactly what the items list shows, mapping the whole library
    // from "Unfiled Items" or a saved search would surprise anyone.
    const row = this._selectedTreeRows(pane)[0];
    const is = (fn) => !!(row && typeof row[fn] === "function" && row[fn]());
    if (is("isTrash")) {
      throw new Error("The trash can't be mapped. Select a collection or a library.");
    }
    if (is("isFeed") || is("isFeedsOrFeed")) {
      throw new Error("Feeds can't be mapped. Select a collection or a library.");
    }
    const isLibraryRoot = is("isLibrary") || is("isGroup");
    if (row && !isLibraryRoot && typeof pane.getSortedItems === "function") {
      const items = (pane.getSortedItems() || []).filter(
        (i) => i && typeof i.isRegularItem === "function" && i.isRegularItem()
      );
      let name = "Current view";
      try {
        name = (row.ref && row.ref.name) || row.getName() || name;
      } catch (e) {
        /* keep the generic name */
      }
      return { kind: "items", items, name };
    }
    const libraryID = this._selectedLibraryID(pane);
    return { kind: "library", libraryID, name: this._libraryName(libraryID) };
  },

  /** Open the Citation Map tab and run the full build for the selection. */
  async open(win, { preferSelection = false } = {}) {
    // Immediate feedback the moment the click arrives, before any work.
    let popup = null;
    try {
      popup = new Zotero.ProgressWindow({ window: win, closeOnClick: true });
      popup.changeHeadline("Citation Map");
      popup.addDescription("Collecting items…");
      popup.show();
    } catch (e) {
      Zotero.debug("[Citation Map] ProgressWindow unavailable: " + e);
    }
    const closePopup = () => {
      try {
        if (popup) popup.close();
      } catch (e) {
        /* already closed */
      }
    };

    try {
      Zotero.debug(
        `[Citation Map] open() v${this._ns.version}, preferSelection=${preferSelection}`
      );
      const source = this._resolveSource(win, preferSelection);

      const { id, container } = win.Zotero_Tabs.add({
        type: "citation-map",
        title: "Citation Map — " + source.name,
        // Zotero 9 reads tab.data.icon unconditionally; omitting `data`
        // makes Zotero_Tabs.add() throw (TypeError on tab.data.icon).
        data: {},
        select: true,
        onClose: () => this._onTabClosed(id),
      });
      this._trackTab(win, id);
      Zotero.debug("[Citation Map] Tab opened: " + id);
      closePopup();

      await this._runPipeline(win, container, id, source, {
        promptIfNeeded: true,
      });
    } catch (e) {
      closePopup();
      Zotero.logError(e);
      Zotero.debug(
        "[Citation Map] open() failed: " + e + "\n" + (e && e.stack)
      );
      Zotero.alert(
        win,
        "Citation Map",
        "Could not create the citation map:\n\n" +
          (e && e.message ? e.message : String(e))
      );
    }
  },

  /**
   * Resolve the item set for a source (asking about subcollections when a
   * collection is mapped for the first time), then build and render.
   */
  async _runPipeline(win, container, tabID, source, { promptIfNeeded }) {
    // promptIfNeeded is false for Rebuild / scope changes: a map is already
    // on screen then, and declining must keep it rather than close the tab.
    const isRebuild = !promptIfNeeded;
    // Returns "built" or "cancelled" (the caller may undo a scope change).
    const decline = (message) => {
      if (isRebuild && this._views.some((v) => v._tabID === tabID)) {
        if (message) Zotero.alert(win, "Citation Map", message);
      } else {
        this._abort(win, tabID, message);
      }
      return "cancelled";
    };
    let items;
    let subInfo = null;

    if (source.kind === "collection") {
      const subtree = this._subTree(source.collection);
      source._subtree = subtree;
      let scope;
      let justPrompted = false;

      if (subtree.length) {
        scope = this._getScope(source.collection.id);
        if (!scope) {
          const def = this._defaultScope();
          if (promptIfNeeded) {
            scope = await this._showScopePicker(
              win,
              container,
              source.collection,
              subtree,
              def,
              { initial: true }
            );
            justPrompted = true;
          } else {
            scope = def;
          }
          this._setScope(source.collection.id, scope);
        }
      } else {
        scope = { mode: "all", ids: [] };
      }
      source._scope = scope;

      const collections = this._resolveCollections(
        source.collection,
        subtree,
        scope
      );
      items = await this._itemsFromCollections(collections);
      if (subtree.length) {
        subInfo = {
          total: subtree.length,
          included: collections.length - 1,
          mode: scope.mode,
          firstTime: justPrompted,
        };
      }
    } else if (source.kind === "collections") {
      // Several collections selected (Zotero 10+): their union, each with
      // its remembered subcollection scope (or the default, no prompt).
      const all = [];
      for (const c of source.collections) {
        const sub = this._subTree(c);
        const scope = sub.length
          ? this._getScope(c.id) || this._defaultScope()
          : { mode: "all", ids: [] };
        all.push(...this._resolveCollections(c, sub, scope));
      }
      items = await this._itemsFromCollections(all);
    } else if (source.kind === "items") {
      items = source.items;
    } else {
      const all = await Zotero.Items.getAll(source.libraryID, true, false);
      items = all.filter((i) => i.isRegularItem());
    }

    Zotero.debug(
      `[Citation Map] Collected ${items.length} item(s) from "${source.name}"`
    );

    if (!items.length) {
      return decline("The selected collection has no items to map.");
    }
    // Two warning tiers: a "this takes a while" confirm, and a strong
    // warning for very large maps (the layout is O(n²)-ish; thousands of
    // items can make Zotero unresponsive).
    const warnAt =
      Zotero.Prefs.get("extensions.citation-map.warnItemCount", true) || 400;
    if (items.length > warnAt * 4) {
      const ok = win.confirm(
        `Citation Map: ${items.length} items is a very large map. Building ` +
          `and laying it out can take a long time and may make Zotero ` +
          `unresponsive — mapping per (sub)collection is strongly ` +
          `recommended instead.\n\nContinue anyway?`
      );
      if (!ok) return decline();
    } else if (items.length > warnAt) {
      const ok = win.confirm(
        `Citation Map: this will map ${items.length} items, which can take a ` +
          `while on first run. Continue?`
      );
      if (!ok) return decline();
    }

    await this._buildAndRender(win, container, tabID, source, items, subInfo);
    return "built";
  },

  /** Close the tab (and its view) and, optionally, explain why. */
  _abort(win, tabID, message) {
    this._destroyView(tabID);
    try {
      win.Zotero_Tabs.close(tabID);
    } catch (e) {
      /* tab may already be gone */
    }
    if (message) {
      try {
        Zotero.alert(win, "Citation Map", message);
      } catch (e) {
        /* best-effort */
      }
    }
  },

  _destroyView(tabID) {
    const idx = this._views.findIndex((v) => v._tabID === tabID);
    if (idx >= 0) {
      this._views[idx].destroy();
      this._views.splice(idx, 1);
    }
  },

  /** The in-tab progress screen; returns update/remove/fail helpers. */
  _progressScreen(doc, container) {
    const prog = doc.createElement("div");
    prog.className = "zcm-root zcm-progress";
    const inner = doc.createElement("div");
    inner.className = "zcm-progress-inner";
    const h = doc.createElement("div");
    h.className = "zcm-title-name";
    h.textContent = "Citation Map";
    const label = doc.createElement("div");
    label.className = "zcm-progress-label";
    label.textContent = "Preparing…";
    const barOuter = doc.createElement("div");
    barOuter.className = "zcm-progress-bar";
    const barInner = doc.createElement("div");
    barInner.className = "zcm-progress-fill";
    barOuter.appendChild(barInner);
    const hint = doc.createElement("div");
    hint.className = "zcm-progress-hint";
    hint.textContent =
      "Reference lists come from OpenAlex and are cached locally — " +
      "the next run of this collection will be nearly instant.";
    const warn = doc.createElement("div");
    warn.className = "zcm-progress-warn";
    inner.appendChild(h);
    inner.appendChild(label);
    inner.appendChild(barOuter);
    inner.appendChild(warn);
    inner.appendChild(hint);
    prog.appendChild(inner);
    container.appendChild(prog);

    return {
      onProgress: (phase, done, total) => {
        label.textContent = `${phase} — ${done} / ${total}`;
        barInner.style.width =
          (total ? Math.round((done / total) * 100) : 0) + "%";
      },
      warn: (msg) => {
        warn.textContent = msg || "";
        warn.style.display = msg ? "block" : "none";
      },
      remove: () => {
        if (prog.parentNode) prog.parentNode.removeChild(prog);
      },
      fail: (msg) => {
        label.textContent = msg;
        barInner.style.width = "0%";
      },
      /** Extra content under the message (e.g. the API-key form). */
      append: (el) => inner.appendChild(el),
    };
  },

  async _buildAndRender(win, container, tabID, source, items, subInfo) {
    const doc = win.document;
    // A newer build (or closing the tab) supersedes this one: its result is
    // then dropped instead of becoming a hidden view that redraws forever.
    const current = this._beginBuild(tabID, container);
    const rebuild = () =>
      this._runPipeline(win, container, tabID, source, {
        promptIfNeeded: false,
      });
    // Replacing an existing map (rebuild / scope change): drop the old view.
    this._destroyView(tabID);
    container.textContent = "";

    const prog = this._progressScreen(doc, container);
    const DS = this._ns.DataSource;
    DS.resetNetState();
    // Progress callback doubles as the network-health display: a slow
    // connection shows a patient hint, a dead one an explanation — so the
    // user always knows WHY nothing seems to happen.
    const onProgress = (phase, done, total) => {
      prog.onProgress(phase, done, total);
      if (DS.netState === "slow") {
        prog.warn(
          "Your connection seems slow — OpenAlex is answering, but it may " +
            "take a few minutes. Everything is cached for next time."
        );
      } else if (DS.netMessage()) {
        prog.warn(DS.netMessage());
      }
    };
    try {
      const graph = await this._ns.GraphBuilder.build(items, onProgress);
      if (!current()) return; // tab closed or rebuilt meanwhile

      // No connection / refused and nothing cached: an all-grey map would
      // only confuse — explain instead.
      if (graph.stats.resolved === 0 && DS.netMessage()) {
        prog.fail(
          DS.netState === "offline"
            ? "No internet connection — OpenAlex could not be reached and " +
                "none of these papers are in the local cache yet. Reconnect " +
                "and use Tools → Show Citation Map again (collections mapped " +
                "while online keep working offline)."
            : DS.netMessage()
        );
        if (DS.netState === "limited") {
          prog.append(this._ns.GraphView.apiKeyForm(doc, rebuild));
        }
        return;
      }

      // "New since last build" highlights: diff against the stored snapshot
      // of this source, then remember the current build. Ad-hoc selections
      // have no stable identity, so they are not diffed.
      const snapKey =
        source.kind === "collection"
          ? "c" + source.collection.id
          : source.kind === "collections"
          ? "m" + source.collections.map((c) => c.id).sort((a, b) => a - b).join(",")
          : source.kind === "library"
          ? "L" + source.libraryID
          : null;
      let changed = null;
      if (snapKey) {
        const prev = this._ns.DataSource.getSnapshot(snapKey);
        changed = this._ns.GraphBuilder.markNew(graph, prev);
        await this._ns.DataSource.putSnapshot(
          snapKey,
          this._ns.GraphBuilder.snapshotOf(graph)
        );
      }

      const ctx = {
        collectionName: source.name,
        collectionID: source.kind === "collection" ? source.collection.id : null,
        // the library new papers go into ("Add to Zotero")
        libraryID:
          source.kind === "collection"
            ? source.collection.libraryID
            : source.kind === "collections"
            ? source.collections[0].libraryID
            : source.kind === "library"
            ? source.libraryID
            : null,
        subInfo,
        changed,
        netState: DS.netState, // view shows a notice when it isn't "ok"
        netMessage: DS.netMessage(),
        importJSON: () => this.importJSON(win),
        rebuild,
        changeScope:
          source.kind === "collection"
            ? async () => this._changeScope(win, container, tabID, source)
            : null,
      };

      // Build the view FIRST, then remove the progress screen — so if the
      // view constructor throws, the progress screen is still on-screen for
      // fail() to show the error, instead of leaving a blank tab.
      const view = new this._ns.GraphView(doc, container, graph, ctx);
      view._tabID = tabID;
      this._views.push(view);
      prog.remove();
    } catch (e) {
      Zotero.debug("[Citation Map] Build failed: " + e + "\n" + (e && e.stack));
      if (!current()) return;
      prog.fail(
        DS.netState === "offline"
          ? "No internet connection — OpenAlex could not be reached. " +
              "Reconnect and try again; collections mapped while online " +
              "keep working offline."
          : DS.netMessage() ||
              "Could not build the map. See Help → Debug Output for details."
      );
    }
  },

  /** Re-open the subcollection picker over the current map, then rebuild. */
  async _changeScope(win, container, tabID, source) {
    const subtree =
      source._subtree && source._subtree.length
        ? source._subtree
        : this._subTree(source.collection);
    if (!subtree.length) return; // nothing to choose
    const current =
      this._getScope(source.collection.id) || this._defaultScope();
    const chosen = await this._showScopePicker(
      win,
      container,
      source.collection,
      subtree,
      current,
      { initial: false }
    );
    if (!chosen) return; // cancelled — leave the map as-is
    const previous = this._getScope(source.collection.id);
    this._setScope(source.collection.id, chosen);
    const status = await this._runPipeline(win, container, tabID, source, {
      promptIfNeeded: false,
    });
    // declined the size warning: the old map stays, so does the old scope
    if (status === "cancelled" && previous) {
      this._setScope(source.collection.id, previous);
    }
  },

  // ---------------------------------------------------------------- import

  /** Import a previously exported map (Export JSON) into a new tab. */
  async importJSON(win) {
    try {
      const path = await this._pickOpenPath(win);
      if (!path) return;

      let text;
      try {
        text = await IOUtils.readUTF8(path);
      } catch (e) {
        Zotero.alert(win, "Citation Map", "Could not read that file.");
        return;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        Zotero.alert(win, "Citation Map", "That file is not valid JSON.");
        return;
      }

      let graph;
      try {
        graph = this._graphFromImport(data);
      } catch (e) {
        Zotero.alert(
          win,
          "Citation Map",
          "That JSON is not a Citation Map export:\n\n" +
            (e && e.message ? e.message : String(e))
        );
        return;
      }

      const baseName =
        data && data.collection
          ? String(data.collection).replace(/\s*\(imported\)\s*$/i, "")
          : "Imported map";
      const { id, container } = win.Zotero_Tabs.add({
        type: "citation-map",
        title: "Citation Map — " + baseName,
        data: {},
        select: true,
        onClose: () => this._onTabClosed(id),
      });
      this._trackTab(win, id);
      container.textContent = "";

      // Offer to reconstruct the map's papers into a new Zotero collection,
      // placed wherever the user picks in the library/collection tree.
      const choice = await this._showImportDialog(win, container, baseName);
      let collectionID = null;
      let displayName = baseName + " (imported)";
      if (choice && choice.action === "create") {
        const created = await this._populateCollection(win, container, graph, choice);
        if (created) {
          collectionID = created.id;
          displayName = created.name;
        }
      }

      if (!this._tabs.has(id)) return; // tab closed during the import
      this._renderImported(win, container, id, graph, displayName, collectionID);
    } catch (e) {
      Zotero.logError(e);
      Zotero.debug("[Citation Map] import failed: " + e + "\n" + (e && e.stack));
      Zotero.alert(
        win,
        "Citation Map",
        "Could not import the citation map:\n\n" +
          (e && e.message ? e.message : String(e))
      );
    }
  },

  _renderImported(win, container, tabID, graph, name, collectionID) {
    const doc = win.document;
    this._destroyView(tabID);
    container.textContent = "";
    const ctx = {
      collectionName: name,
      collectionID,
      subInfo: null,
      imported: true,
      importJSON: () => this.importJSON(win),
      rebuild: () =>
        this._renderImported(win, container, tabID, graph, name, collectionID),
      changeScope: null,
    };
    const view = new this._ns.GraphView(doc, container, graph, ctx);
    view._tabID = tabID;
    this._views.push(view);
  },

  /**
   * In-tab dialog for import: pick where a new collection goes (any editable
   * library or collection, shown as a tree) and name it — or just view. The
   * root collection of the map is always the papers' home.
   */
  _showImportDialog(win, container, defaultName) {
    const doc = win.document;
    return new Promise((resolve) => {
      container.style.position = "relative";

      const overlay = doc.createElement("div");
      overlay.className = "zcm-root zcm-scope-overlay";
      const card = doc.createElement("div");
      card.className = "zcm-scope-card";

      const head = doc.createElement("div");
      head.className = "zcm-scope-head";
      const htitle = doc.createElement("div");
      htitle.className = "zcm-title-name";
      htitle.textContent = "Import map";
      head.appendChild(htitle);
      card.appendChild(head);

      const sub = doc.createElement("div");
      sub.className = "zcm-scope-sub";
      sub.textContent =
        "Reopen this saved map. You can also create a Zotero collection for " +
        "its papers and add them to your library by DOI — or just view the map.";
      card.appendChild(sub);

      const field = doc.createElement("div");
      field.className = "zcm-import-field";
      const flabel = doc.createElement("label");
      flabel.className = "zcm-import-label";
      flabel.textContent = "New collection name";
      const input = doc.createElement("input");
      input.className = "zcm-scope-input";
      input.type = "text";
      input.value = defaultName;
      field.appendChild(flabel);
      field.appendChild(input);
      card.appendChild(field);

      const treeLabel = doc.createElement("div");
      treeLabel.className = "zcm-import-label";
      treeLabel.textContent = "Create it under";
      card.appendChild(treeLabel);

      const list = doc.createElement("div");
      list.className = "zcm-scope-list";
      const rows = this._libraryTree();

      let sel = null;
      const rowEls = [];
      const setSel = (target, el) => {
        sel = target;
        for (const r of rowEls) r.classList.toggle("zcm-sel", r === el);
      };

      let paneColl = null;
      try {
        paneColl = this._selectedCollections(win.ZoteroPane)[0] || null;
      } catch (e) {
        /* no pane */
      }

      for (const r of rows) {
        const row = doc.createElement("div");
        row.className =
          "zcm-scope-row" + (r.type === "library" ? " zcm-scope-lib" : "");
        row.style.paddingLeft = 10 + r.depth * 18 + "px";
        const icon = doc.createElement("span");
        icon.className = "zcm-scope-icon";
        icon.textContent = r.type === "library" ? "📚" : "📁";
        row.appendChild(icon);
        const nm = doc.createElement("span");
        nm.className = "zcm-scope-name";
        nm.textContent =
          r.name + (r.type === "library" ? "  (top level)" : "");
        row.appendChild(nm);
        const target = {
          libraryID: r.libraryID,
          parentID: r.type === "collection" ? r.id : null,
        };
        row.addEventListener("click", () => setSel(target, row));
        list.appendChild(row);
        rowEls.push(row);

        const isDefault = paneColl
          ? r.type === "collection" && r.id === paneColl.id
          : r.type === "library";
        if (isDefault && !sel) setSel(target, row);
      }
      if (!sel && rowEls.length) {
        setSel({ libraryID: rows[0].libraryID, parentID: null }, rowEls[0]);
      }
      card.appendChild(list);

      const finish = (val) => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(val);
      };

      const foot = doc.createElement("div");
      foot.className = "zcm-scope-foot";
      const viewBtn = doc.createElement("button");
      viewBtn.className = "zcm-btn";
      viewBtn.textContent = "Just view the map";
      viewBtn.addEventListener("click", () => finish({ action: "view" }));
      const createBtn = doc.createElement("button");
      createBtn.className = "zcm-btn zcm-btn-primary";
      createBtn.textContent = "Create collection & import";
      createBtn.addEventListener("click", () =>
        finish({
          action: "create",
          name: (input.value || "").trim() || defaultName || "Imported map",
          libraryID: sel ? sel.libraryID : Zotero.Libraries.userLibraryID,
          parentID: sel ? sel.parentID : null,
        })
      );
      foot.appendChild(viewBtn);
      foot.appendChild(createBtn);
      card.appendChild(foot);

      overlay.appendChild(card);
      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) finish({ action: "view" });
      });
      container.appendChild(overlay);
    });
  },

  /** Flat, depth-tagged rows of every editable library and its collections. */
  _libraryTree() {
    const rows = [];
    let libs = [];
    try {
      libs = (Zotero.Libraries.getAll() || []).filter((l) => l.editable);
    } catch (e) {
      libs = [];
    }
    if (!libs.length) {
      libs = [
        { libraryID: Zotero.Libraries.userLibraryID, name: "My Library" },
      ];
    }
    for (const lib of libs) {
      rows.push({
        type: "library",
        libraryID: lib.libraryID,
        name: lib.name,
        depth: 0,
      });
      let tops = [];
      try {
        tops = Zotero.Collections.getByLibrary(lib.libraryID) || [];
      } catch (e) {
        tops = [];
      }
      tops.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const visit = (col, depth) => {
        rows.push({
          type: "collection",
          libraryID: lib.libraryID,
          id: col.id,
          name: col.name,
          depth,
        });
        let kids = [];
        try {
          kids = col.getChildCollections ? col.getChildCollections() : [];
        } catch (e) {
          kids = [];
        }
        kids.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        for (const k of kids) visit(k, depth + 1);
      };
      for (const c of tops) visit(c, 1);
    }
    return rows;
  },

  /**
   * Create the collection and add the map's own library papers to it by DOI
   * (reusing existing items when the DOI already exists in the library), with
   * a progress screen. Links the map's nodes to the resulting items so
   * "Show in library" works; clears stale foreign ids for the rest.
   * Returns { id, name } of the collection, or null if aborted.
   */
  async _populateCollection(win, container, graph, { name, libraryID, parentID }) {
    const DS = this._ns.DataSource;
    const seen = new Set();
    const targets = [];
    for (const n of graph.nodes) {
      if (n.kind !== "library" || !n.doi) continue;
      const norm = DS.normalizeDOI(n.doi);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      targets.push({ raw: n.doi, norm });
    }

    if (targets.length > 120) {
      const ok = win.confirm(
        `This will look up ${targets.length} papers online and may take ` +
          `several minutes. Continue?`
      );
      if (!ok) return null;
    }

    let coll;
    try {
      coll = new Zotero.Collection();
      coll.libraryID = libraryID;
      coll.name = name;
      if (parentID) coll.parentID = parentID;
      await coll.saveTx();
    } catch (e) {
      Zotero.debug("[Citation Map] collection create failed: " + e);
      Zotero.alert(win, "Citation Map", "Could not create the collection.");
      return null;
    }

    const doc = win.document;
    container.textContent = "";
    const prog = this._progressScreen(doc, container);
    const label = `Adding papers to “${name}”`;
    prog.onProgress(label, 0, targets.length);

    const doiToItem = new Map();
    let done = 0;
    for (const t of targets) {
      try {
        let item = await this._findByDOI(libraryID, t.raw);
        if (item) {
          try {
            if (!item.getCollections().includes(coll.id)) {
              item.addToCollection(coll.id);
              await item.saveTx();
            }
          } catch (e) {
            /* couldn't file it — still count it as present */
          }
        } else {
          item = await this._addByDOI(t.raw, coll.id, libraryID);
        }
        if (item) doiToItem.set(t.norm, item.id);
      } catch (e) {
        Zotero.debug("[Citation Map] add by DOI failed (" + t.raw + "): " + e);
      }
      done++;
      prog.onProgress(label, done, targets.length);
      await Zotero.Promise.delay(60); // polite pacing for the lookups
    }
    prog.remove();

    // Point the map's library nodes at the freshly added items.
    for (const n of graph.nodes) {
      if (n.kind !== "library") continue;
      const norm = n.doi ? DS.normalizeDOI(n.doi) : null;
      n.zoteroItemID = (norm && doiToItem.get(norm)) || null;
    }

    return { id: coll.id, name };
  },

  async _addByDOI(doi, collectionID, libraryID) {
    const translate = new Zotero.Translate.Search();
    translate.setIdentifier({ DOI: doi });
    const translators = await translate.getTranslators();
    if (!translators.length) return null;
    translate.setTranslator(translators);
    const items = await translate.translate({
      libraryID,
      collections: collectionID ? [collectionID] : false,
    });
    return items && items.length ? items[0] : null;
  },

  /**
   * The library's regular item with exactly this DOI, or null. The search is
   * a substring match ("10.1/x1" also finds "10.1/x12"), so every hit is
   * checked for an exact, normalized DOI match.
   */
  async _findByDOI(libraryID, doi) {
    const DS = this._ns.DataSource;
    const want = DS.normalizeDOI(doi);
    if (!want) return null;
    try {
      const s = new Zotero.Search();
      s.libraryID = libraryID;
      s.addCondition("DOI", "contains", want);
      const ids = (await s.search()) || [];
      for (const item of Zotero.Items.get(ids)) {
        if (
          item &&
          item.isRegularItem() &&
          DS.normalizeDOI(item.getField("DOI")) === want
        ) {
          return item;
        }
      }
    } catch (e) {
      /* search unavailable — treat as not found */
    }
    return null;
  },

  /**
   * Turn a parsed export object into a clean graph model. Tolerant of older
   * exports (reconstructs `stats` when absent) and hostile input (drops
   * dangling edges/chains), so a hand-edited or foreign file can't crash the
   * renderer.
   */
  _graphFromImport(data) {
    if (!data || typeof data !== "object") throw new Error("Empty file");
    if (!Array.isArray(data.nodes)) {
      throw new Error("No 'nodes' array found.");
    }

    const keys = new Set();
    const nodes = [];
    for (const n of data.nodes) {
      if (!n || n.key == null || keys.has(n.key)) continue;
      const key = String(n.key);
      keys.add(key);
      const kind =
        n.kind === "discovered" || n.kind === "unresolved" ? n.kind : "library";
      nodes.push({
        key,
        kind,
        title: n.title ? String(n.title) : "(untitled)",
        year: Number.isFinite(n.year) ? n.year : null,
        authors: Array.isArray(n.authors) ? n.authors.map(String) : [],
        venue: n.venue != null ? String(n.venue) : null,
        doi: n.doi != null ? String(n.doi) : null,
        zoteroItemID: Number.isFinite(n.zoteroItemID) ? n.zoteroItemID : null,
        citedByCount: Number(n.citedByCount) || 0,
        inLibraryCitations: Number(n.inLibraryCitations) || 0,
        topics: Array.isArray(n.topics)
          ? n.topics.slice(0, 3).map((t) => ({
              id: String((t && t.id) || ""),
              name: String((t && t.name) || ""),
              score: Number(t && t.score) || 0,
            }))
          : [],
        oaStatus: n.oaStatus != null ? String(n.oaStatus) : null,
        via: n.via != null ? String(n.via) : null,
        citesCount: Number(n.citesCount) || 0,
        // older exports lack the flag: re-detect it from the title/venue
        isReview:
          typeof n.isReview === "boolean"
            ? n.isReview
            : this._ns.GraphBuilder.isReviewRecord({
                title: n.title ? String(n.title) : "",
                venue: n.venue != null ? String(n.venue) : null,
              }),
      });
    }
    if (!nodes.length) throw new Error("The file contains no usable nodes.");
    this._relinkImported(nodes);

    const edges = (Array.isArray(data.edges) ? data.edges : [])
      .filter((e) => e && keys.has(String(e.source)) && keys.has(String(e.target)))
      .map((e) => ({ source: String(e.source), target: String(e.target) }));

    const chains = (Array.isArray(data.chains) ? data.chains : []).filter(
      (c) => Array.isArray(c) && c.length && c.every((k) => keys.has(String(k)))
    );

    const coupling = (Array.isArray(data.coupling) ? data.coupling : [])
      .filter((c) => c && keys.has(String(c.a)) && keys.has(String(c.b)))
      .map((c) => ({
        a: String(c.a),
        b: String(c.b),
        shared: Number(c.shared) || 2,
      }));

    const stats =
      data.stats && typeof data.stats === "object"
        ? data.stats
        : {
            items: nodes.filter((n) => n.kind !== "discovered").length,
            resolved: nodes.filter((n) => n.kind === "library").length,
            edges: edges.length,
            discovered: nodes.filter((n) => n.kind === "discovered").length,
          };

    return { nodes, edges, chains, coupling, stats };
  },

  /**
   * Zotero item IDs in an export are local database row numbers: on another
   * machine (or someone else's library) they point at unrelated items, whose
   * notes and tags the map would then show. Keep an ID only if that item
   * here is the same paper (same DOI, or same title when there is no DOI).
   */
  _relinkImported(nodes) {
    const DS = this._ns.DataSource;
    const norm = (t) => String(t || "").toLowerCase().replace(/\W+/g, " ").trim();
    for (const n of nodes) {
      if (n.zoteroItemID == null) continue;
      let keep = false;
      try {
        const item = Zotero.Items.get(n.zoteroItemID);
        if (item && !item.deleted && item.isRegularItem()) {
          keep = n.doi
            ? DS.normalizeDOI(item.getField("DOI")) === DS.normalizeDOI(n.doi)
            : norm(item.getField("title")) === norm(n.title);
        }
      } catch (e) {
        keep = false;
      }
      if (!keep) n.zoteroItemID = null;
    }
  },

  async _pickOpenPath(win) {
    // filePicker.mjs is the Zotero 7+ module (ChromeUtils.import is gone)
    const { FilePicker } = ChromeUtils.importESModule(
      "chrome://zotero/content/modules/filePicker.mjs"
    );
    const fp = new FilePicker();
    fp.init(win, "Import Citation Map", fp.modeOpen);
    fp.appendFilter("Citation Map JSON", "*.json");
    const rv = await fp.show();
    if (rv !== fp.returnOK) return null;
    return fp.file;
  },
};
