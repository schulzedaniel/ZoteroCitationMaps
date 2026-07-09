/**
 * citationMap.js — main controller.
 *
 * Owns everything that touches the Zotero UI shell:
 *   - Tools menu entry + collection context-menu entry
 *   - Opening a "Citation Map" tab and running the build pipeline in it
 *   - Progress display + error handling
 *   - Clean removal of every element it created (bootstrap requirement)
 *
 * Loaded into the CitationMap namespace (`this` === CitationMap).
 */

/* global Zotero */

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
    // collection (including subcollections, per pref).
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

  // -------------------------------------------------------------- pipeline

  /**
   * Collect the items to map: explicit item selection (if requested and
   * more than one item is selected), else the selected collection, else
   * the whole library.
   */
  async _collectItems(win, preferSelection = false) {
    const pane = win.ZoteroPane;

    if (preferSelection) {
      const selected = (pane.getSelectedItems() || []).filter((i) =>
        i.isRegularItem()
      );
      if (selected.length >= 2) {
        return { items: selected, name: "Selected Items", collectionID: null };
      }
    }

    const collection = pane.getSelectedCollection();
    if (collection) {
      const recursive = Zotero.Prefs.get(
        "extensions.citation-map.includeSubcollections",
        true
      );
      const collections = [collection];
      if (recursive) {
        for (const child of collection.getDescendents(false, "collection")) {
          const c = Zotero.Collections.get(child.id);
          if (c) collections.push(c);
        }
      }
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
      items = items.filter((i) => {
        if (!i.isRegularItem() || seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      });
      return { items, name: collection.name, collectionID: collection.id };
    }

    const libraryID = pane.getSelectedLibraryID();
    const all = await Zotero.Items.getAll(libraryID, true, false);
    return {
      items: all.filter((i) => i.isRegularItem()),
      name: "My Library",
      collectionID: null,
    };
  },

  /** Open the Citation Map tab and run the full build for the selection. */
  async open(win, { preferSelection = false } = {}) {
    // Immediate feedback the moment the click arrives, before any work:
    // a slow collection read or an early failure must never look like a
    // dead button.
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
      const { items, name, collectionID } = await this._collectItems(
        win,
        preferSelection
      );
      Zotero.debug(
        `[Citation Map] Collected ${items.length} item(s) from "${name}"`
      );

      if (!items.length) {
        closePopup();
        Zotero.alert(
          win,
          "Citation Map",
          "The selected collection has no items to map."
        );
        return;
      }
      if (items.length > 400) {
        const ok = win.confirm(
          `Citation Map: this will map ${items.length} items, which can take a ` +
            `while on first run. Continue?`
        );
        if (!ok) {
          closePopup();
          return;
        }
      }

      // --- open a tab
      const { id, container } = win.Zotero_Tabs.add({
        type: "citation-map",
        title: "Citation Map — " + name,
        // Zotero 9 reads tab.data.icon unconditionally; omitting `data`
        // makes Zotero_Tabs.add() throw (TypeError on tab.data.icon).
        data: {},
        select: true,
        onClose: () => {
          const idx = this._views.findIndex((v) => v._tabID === id);
          if (idx >= 0) {
            this._views[idx].destroy();
            this._views.splice(idx, 1);
          }
        },
      });
      Zotero.debug("[Citation Map] Tab opened: " + id);
      closePopup();

      await this._buildInto(win, container, id, items, name, collectionID);
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

  async _buildInto(win, container, tabID, items, name, collectionID) {
    const doc = win.document;
    container.textContent = "";

    // --- progress screen
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

    const onProgress = (phase, done, total) => {
      label.textContent = `${phase} — ${done} / ${total}`;
      barInner.style.width =
        (total ? Math.round((done / total) * 100) : 0) + "%";
    };

    // --- build + render
    try {
      const graph = await this._ns.GraphBuilder.build(items, onProgress);
      container.removeChild(prog);

      const ctx = {
        collectionName: name,
        collectionID,
        rebuild: async () => {
          const idx = this._views.findIndex((v) => v._tabID === tabID);
          if (idx >= 0) {
            this._views[idx].destroy();
            this._views.splice(idx, 1);
          }
          await this._buildInto(win, container, tabID, items, name, collectionID);
        },
      };
      const view = new this._ns.GraphView(doc, container, graph, ctx);
      view._tabID = tabID;
      this._views.push(view);
    } catch (e) {
      Zotero.debug("[Citation Map] Build failed: " + e + "\n" + e.stack);
      label.textContent =
        "Could not build the map. Are you online? See Help → Debug Output for details.";
      barInner.style.width = "0%";
    }
  },
};
