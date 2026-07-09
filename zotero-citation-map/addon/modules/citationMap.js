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
  _views: [], // open GraphView instances

  async startup() {
    await this._ns.DataSource.initCache();
  },

  shutdown() {
    for (const view of this._views) view.destroy();
    this._views = [];
  },

  // ------------------------------------------------------------- window UI

  addToWindow(win) {
    const doc = win.document;
    const created = [];

    // Stylesheet for the graph view (scoped by .zcm- prefix).
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = this._ns.rootURI + "content/graph.css";
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

    // Collection context menu → Show Citation Map for This Collection
    const collPopup = doc.getElementById("zotero-collectionmenu");
    if (collPopup) {
      const mi = doc.createXULElement("menuitem");
      mi.id = "zcm-collection-menuitem";
      mi.setAttribute("label", "Show Citation Map for This Collection");
      mi.addEventListener("command", () => this.open(win));
      collPopup.appendChild(mi);
      created.push(mi);
    }

    this._windowEntries.set(win, created);
  },

  removeFromWindow(win) {
    for (const el of this._windowEntries.get(win) || []) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    this._windowEntries.delete(win);
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

  // -------------------------------------------------------------- pipeline

  /** What to map: a multi-item selection, a collection, or the whole library. */
  _resolveSource(win, preferSelection) {
    const pane = win.ZoteroPane;
    if (preferSelection) {
      const selected = (pane.getSelectedItems() || []).filter((i) =>
        i.isRegularItem()
      );
      if (selected.length >= 2) {
        return { kind: "items", items: selected, name: "Selected Items" };
      }
    }
    const collection = pane.getSelectedCollection();
    if (collection) {
      return { kind: "collection", collection, name: collection.name };
    }
    return {
      kind: "library",
      libraryID: pane.getSelectedLibraryID(),
      name: "My Library",
    };
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
        onClose: () => this._destroyView(id),
      });
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
      this._abort(win, tabID, "The selected collection has no items to map.");
      return;
    }
    if (items.length > 400) {
      const ok = win.confirm(
        `Citation Map: this will map ${items.length} items, which can take a ` +
          `while on first run. Continue?`
      );
      if (!ok) {
        this._abort(win, tabID);
        return;
      }
    }

    await this._buildAndRender(win, container, tabID, source, items, subInfo);
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
    inner.appendChild(h);
    inner.appendChild(label);
    inner.appendChild(barOuter);
    inner.appendChild(hint);
    prog.appendChild(inner);
    container.appendChild(prog);

    return {
      onProgress: (phase, done, total) => {
        label.textContent = `${phase} — ${done} / ${total}`;
        barInner.style.width =
          (total ? Math.round((done / total) * 100) : 0) + "%";
      },
      remove: () => {
        if (prog.parentNode) prog.parentNode.removeChild(prog);
      },
      fail: (msg) => {
        label.textContent = msg;
        barInner.style.width = "0%";
      },
    };
  },

  async _buildAndRender(win, container, tabID, source, items, subInfo) {
    const doc = win.document;
    // Replacing an existing map (rebuild / scope change): drop the old view.
    this._destroyView(tabID);
    container.textContent = "";

    const prog = this._progressScreen(doc, container);
    try {
      const graph = await this._ns.GraphBuilder.build(items, prog.onProgress);
      prog.remove();

      const ctx = {
        collectionName: source.name,
        collectionID: source.kind === "collection" ? source.collection.id : null,
        subInfo,
        importJSON: () => this.importJSON(win),
        rebuild: async () => {
          await this._runPipeline(win, container, tabID, source, {
            promptIfNeeded: false,
          });
        },
        changeScope:
          source.kind === "collection"
            ? async () => this._changeScope(win, container, tabID, source)
            : null,
      };

      const view = new this._ns.GraphView(doc, container, graph, ctx);
      view._tabID = tabID;
      this._views.push(view);
    } catch (e) {
      Zotero.debug("[Citation Map] Build failed: " + e + "\n" + (e && e.stack));
      prog.fail(
        "Could not build the map. Are you online? See Help → Debug Output for details."
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
    this._setScope(source.collection.id, chosen);
    await this._runPipeline(win, container, tabID, source, {
      promptIfNeeded: false,
    });
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
        onClose: () => this._destroyView(id),
      });
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
        paneColl = win.ZoteroPane.getSelectedCollection();
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

  async _findByDOI(libraryID, doi) {
    try {
      const s = new Zotero.Search();
      s.libraryID = libraryID;
      s.addCondition("DOI", "contains", doi);
      const ids = await s.search();
      return ids && ids.length ? Zotero.Items.get(ids[0]) : null;
    } catch (e) {
      return null;
    }
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
      });
    }
    if (!nodes.length) throw new Error("The file contains no usable nodes.");

    const edges = (Array.isArray(data.edges) ? data.edges : [])
      .filter((e) => e && keys.has(String(e.source)) && keys.has(String(e.target)))
      .map((e) => ({ source: String(e.source), target: String(e.target) }));

    const chains = (Array.isArray(data.chains) ? data.chains : []).filter(
      (c) => Array.isArray(c) && c.length && c.every((k) => keys.has(String(k)))
    );

    const stats =
      data.stats && typeof data.stats === "object"
        ? data.stats
        : {
            items: nodes.filter((n) => n.kind !== "discovered").length,
            resolved: nodes.filter((n) => n.kind === "library").length,
            edges: edges.length,
            discovered: nodes.filter((n) => n.kind === "discovered").length,
          };

    return { nodes, edges, chains, stats };
  },

  async _pickOpenPath(win) {
    let FilePicker;
    try {
      ({ FilePicker } = ChromeUtils.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs"
      ));
    } catch (e) {
      ({ FilePicker } = ChromeUtils.import(
        "chrome://zotero/content/modules/filePicker.jsm"
      ));
    }
    const fp = new FilePicker();
    fp.init(win, "Import Citation Map", fp.modeOpen);
    fp.appendFilter("Citation Map JSON", "*.json");
    const rv = await fp.show();
    if (rv !== fp.returnOK) return null;
    return fp.file;
  },
};
