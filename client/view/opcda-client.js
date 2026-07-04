(function () {
    console.log("opcda-client frontend script loaded");
    var selectedItemsState = [];
    var selectedItemIdSet = {};
    var browseState = null;
    var expansionState = {};
    var browseSearchValue = "";
    var browseSearchTerm = "";
    var contextMenuPath = "";
    var browseSelectedPath = "";
    var renderPending = false;

    function debounce(fn, delay) {
        var timer;
        return function () {
            var ctx = this, args = arguments;
            clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(ctx, args); }, delay);
        };
    }

    function rebuildItemIdIndex() {
        selectedItemIdSet = {};
        selectedItemsState.forEach(function (item, i) {
            var id = item.itemID;
            if (id !== undefined && id !== null) selectedItemIdSet[id] = i;
        });
    }

    function openBrowseModal() { 
        $("#node-input-opcda-browse-modal").show(); 
        $("body").addClass("opcda-tree-modal-open"); 
    }

    function closeBrowseModal() {
        hideTreeContextMenu();
        $("#node-input-opcda-browse-modal").hide();
        $("body").removeClass("opcda-tree-modal-open");
    }

    function getBrowseCacheKey() {
        var connectionId = $("#node-input-connection").val() || "";
        if (!connectionId) return "";
        return "opcda-client-browse-cache:" + connectionId;
    }

    function saveBrowseSession() {
        var key = getBrowseCacheKey();
        if (!key || !window.sessionStorage) return;
        try {
            sessionStorage.setItem(key, JSON.stringify({
                browseState: browseState,
                expansionState: expansionState
            }));
        } catch (error) { }
    }

    function loadBrowseSession() {
        var key = getBrowseCacheKey();
        if (!key || !window.sessionStorage) return false;
        try {
            var raw = sessionStorage.getItem(key);
            if (!raw) return false;
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") return false;
            browseState = parsed.browseState && typeof parsed.browseState === "object" ? parsed.browseState : null;
            expansionState = parsed.expansionState && typeof parsed.expansionState === "object" ? parsed.expansionState : {};
            return !!browseState;
        } catch (error) {
            return false;
        }
    }

    function parseSelectedItems(rawValue) {
        if (!rawValue) return [];
        try {
            var parsed = rawValue;
            if (typeof rawValue === "string") {
                parsed = JSON.parse(rawValue);
            }
            if (!Array.isArray(parsed)) return [];

            return parsed
                .filter(function (item) {
                    return item && typeof item === "object" && !Array.isArray(item);
                })
                .map(function (item) {
                    var id = "";
                    if (typeof item.itemID === "string") id = item.itemID;
                    else if (typeof item.nodeID === "string") id = item.nodeID;
                    else if (typeof item.nodeId === "string") id = item.nodeId;
                    else if (item.itemID !== undefined && item.itemID !== null) id = String(item.itemID);
                    else if (item.nodeID !== undefined && item.nodeID !== null) id = String(item.nodeID);
                    else if (item.nodeId !== undefined && item.nodeId !== null) id = String(item.nodeId);

                    return {
                        name: typeof item.name === "string" ? item.name.trim() : "",
                        itemID: id.trim(),
                        nodeClass: typeof item.nodeClass === "string" ? item.nodeClass.trim() : "Variable",
                        valueProperty: typeof item.valueProperty === "string" && item.valueProperty.trim() ? item.valueProperty.trim() : "payload",
                        valuePropertyType: (item.valuePropertyType === "msg" || item.valuePropertyType === "flow" || item.valuePropertyType === "global") ? item.valuePropertyType : "msg"
                    };
                })
                .filter(function (item) {
                    return item.itemID !== undefined && item.itemID !== null;
                });
        } catch (error) {
            return [];
        }
    }

    function serializeSelectedItems(items) {
        return JSON.stringify(items.map(function (item) {
            var result = {
                name: item.name || item.itemID,
                itemID: item.itemID,
                nodeClass: item.nodeClass || "Variable"
            };

            if (item.valueProperty) result.valueProperty = item.valueProperty;
            if (item.valuePropertyType) result.valuePropertyType = item.valuePropertyType;

            return result;
        }), null, 2);
    }

    function escapeHtml(value) {
        return String(value || "").replace(/[&<>"']/g, function (char) {
            return {
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;"
            }[char];
        });
    }

    function updateSelectedItemsField() {
        var serialized = serializeSelectedItems(selectedItemsState);
        console.log("[OPC-DA View] updateSelectedItemsField - serialized values:", serialized);
        $("#node-input-selectedItems").val(serialized).trigger("change");
        var tagList = selectedItemsState.map(function (item) { return item.itemID; }).join("\n");
        console.log("[OPC-DA View] updateSelectedItemsField - tagList:", tagList);
        $("#node-input-tags").val(tagList).trigger("change");
    }

    function commitSelectedItemsState(node) {
        console.log("[OPC-DA View] commitSelectedItemsState - selectedItemsState:", selectedItemsState);
        updateSelectedItemsField();

        if (!node) return;

        node.selectedItems = $("#node-input-selectedItems").val() || "[]";
        node.tags = $("#node-input-tags").val() || "";
        console.log("[OPC-DA View] commitSelectedItemsState - node.selectedItems committed:", node.selectedItems);
        console.log("[OPC-DA View] commitSelectedItemsState - node.tags committed:", node.tags);
    }

    function normalizeSearchTerm(value) {
        return String(value || "").trim().toLowerCase();
    }

    function textForSearch(item) {
        if (!item || typeof item !== "object") return "";
        return [
            item.name,
            item.itemID
        ].filter(Boolean).join(" ").toLowerCase();
    }

    function nodeMatchesSearch(item, term) {
        if (!term) return true;
        return textForSearch(item).indexOf(term) >= 0;
    }

    function branchHasSearchMatch(item, term) {
        if (nodeMatchesSearch(item, term)) return true;
        if (!item || !Array.isArray(item.browse)) return false;
        for (var i = 0; i < item.browse.length; i += 1) {
            if (branchHasSearchMatch(item.browse[i], term)) return true;
        }
        return false;
    }

    function renderSelectedItems() {
        var container = $("#node-input-selected-tags");
        if (!container.length) return;
        container.empty();

        if (!selectedItemsState.length) {
            container.append('<div class="opcda-tree-empty">No tags selected.</div>');
            return;
        }

        var writeMode = $("#node-input-mode").val() === "write";

        selectedItemsState.forEach(function (item, index) {
            var row = $('<div class="opcda-client-tag-chip" style="margin-bottom:4px;"></div>');
            var icon = item.nodeClass === "Object" ? "fa-folder" : "fa-tag";
            row.append('<div class="opcda-tree-icon"><i class="fa ' + icon + '"></i></div>');
            row.append('<div class="opcda-tree-title">' + escapeHtml(item.name || item.itemID) + '</div>');
            
            if (writeMode) {
                var type = (item.valuePropertyType === "flow" || item.valuePropertyType === "global") ? item.valuePropertyType : "msg";
                var prop = item.valueProperty || "payload";
                row.append('<div class="opcda-client-tag-write">'
                    + '<input type="text" class="opcda-client-item-value-prop" id="opcda-client-item-value-prop-' + index + '" data-index="' + index + '" value="' + escapeHtml(prop) + '" placeholder="payload">'
                    + '<input type="hidden" class="opcda-client-item-value-type" id="opcda-client-item-value-type-' + index + '" data-index="' + index + '" value="' + escapeHtml(type) + '">'
                    + "</div>");
            }
            row.append('<div class="opcda-client-tag-right">'
                + '<div class="opcda-client-nodeid-label">' + escapeHtml(item.itemID) + '</div>'
                + '<div class="opcda-tree-actions"><a href="#" class="editor-button editor-button-small opcda-client-remove-tag" data-index="' + index + '"><i class="fa fa-trash"></i></a></div>'
                + "</div>");
            container.append(row);
        });

        initializeSelectedItemTypedInputs();
    }

    function initializeSelectedItemTypedInputs() {
        $(".opcda-client-item-value-prop").each(function () {
            var input = $(this);
            var index = Number(input.attr("data-index"));
            var typeField = "#opcda-client-item-value-type-" + index;
            if (input.data("typedInputInitialized")) {
                input.typedInput("types", ["msg", "flow", "global"]);
                return;
            }

            input.typedInput({
                type: $(typeField).val() || "msg",
                types: ["msg", "flow", "global"],
                typeField: typeField
            });
            input.data("typedInputInitialized", true);
        });
    }

    function syncSelectedItems() {
        rebuildItemIdIndex();
        updateSelectedItemsField();
        renderSelectedItems();
        renderBrowseTree();
    }

    // Targeted DOM patch — updates only the single row that changed selection state.
    // Avoids re-rendering the entire tree, which is expensive for large namespaces.
    function patchRowSelectionUI(path, isSelected) {
        var container = document.getElementById("node-input-opcda-browse-tree");
        if (!container) return;
        // Escape double-quotes in path to avoid breaking the attribute selector
        var safePath = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        var row = container.querySelector('.opcda-tree-row[data-path="' + safePath + '"]');
        if (!row) return; // row is collapsed/not visible — nothing to patch

        if (isSelected) {
            row.classList.add("is-selected");
        } else {
            row.classList.remove("is-selected");
        }

        var btn = row.querySelector(".opcda-client-toggle-tag");
        if (btn) {
            btn.innerHTML = '<i class="fa ' + (isSelected ? "fa-minus" : "fa-plus") + '"></i> ' + (isSelected ? "Remove" : "Add");
        }
    }

    function isExpanded(path, defaultValue) {
        if (expansionState[path] === undefined) {
            expansionState[path] = !!defaultValue;
        }
        return expansionState[path];
    }

    function selectedIndexByItemId(itemId) {
        var idx = selectedItemIdSet[itemId];
        return (idx !== undefined) ? idx : -1;
    }

    function canExpand(item) {
        return item && item.isFolder;
    }

    function itemIdOf(item) {
        if (!item) return "";
        var id = item.itemID !== undefined && item.itemID !== null ? item.itemID :
                 item.nodeId !== undefined && item.nodeId !== null ? item.nodeId :
                 item.nodeID !== undefined && item.nodeID !== null ? item.nodeID : null;
        return id !== null ? String(id).trim() : "";
    }

    function loadBrowse(itemId) {
        var connectionId = $("#node-input-connection").val();
        if (!connectionId) {
            RED.notify("Select an OPC DA connection before browsing.", "warning");
            return $.Deferred().reject().promise();
        }

        return $.getJSON("opcda-client-config/" + encodeURIComponent(connectionId) + "/browse", {
            itemID: itemId || ""
        });
    }

    function renderBrowseTree() {
        if (renderPending) return;
        renderPending = true;
        setTimeout(function () {
            renderPending = false;
            _doRenderBrowseTree();
        }, 0);
    }

    function _doRenderBrowseTree() {
        var container = $("#node-input-opcda-browse-tree");
        var frag = document.createDocumentFragment();

        if (!browseState) {
            var empty = document.createElement("div");
            empty.className = "opcda-tree-empty";
            empty.textContent = "Click Browse to load the server tree.";
            frag.appendChild(empty);
            container[0].innerHTML = "";
            container[0].appendChild(frag);
            return;
        }

        if (browseSearchTerm) {
            if (!branchHasSearchMatch(browseState, browseSearchTerm)) {
                var noMatch = document.createElement("div");
                noMatch.className = "opcda-tree-empty";
                noMatch.textContent = "No items found in the already explored items.";
                frag.appendChild(noMatch);
                container[0].innerHTML = "";
                container[0].appendChild(frag);
                return;
            }
            renderBrowseRootFiltered(browseState, "root", 0, frag, browseSearchTerm);
            container[0].innerHTML = "";
            container[0].appendChild(frag);
            return;
        }

        renderBrowseRoot(browseState, "root", 0, frag);
        container[0].innerHTML = "";
        container[0].appendChild(frag);
    }

    function browseIconFor(item) {
        return item && item.isFolder ? "fa-folder" : "fa-tag";
    }

    function makeEl(tag, className, html) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (html !== undefined) el.innerHTML = html;
        return el;
    }

    function makeTreeRow(path, extraClass) {
        var row = document.createElement("div");
        row.className = "opcda-tree-row" + (extraClass ? " " + extraClass : "");
        row.setAttribute("data-path", path);
        return row;
    }

    function renderBrowseRoot(root, path, depth, frag) {
        var expanded = isExpanded(path, true);
        var itemId = "";
        var selectedIndex = selectedIndexByItemId(itemId);
        var row = makeTreeRow(path, selectedIndex >= 0 ? "is-selected" : "");
        
        var actions = '<div class="opcda-tree-actions"><a href="#" class="editor-button editor-button-small opcda-client-toggle-tag" data-nodeid="' + escapeHtml(itemId) + '" data-path="' + escapeHtml(path) + '"><i class="fa ' + (selectedIndex >= 0 ? 'fa-minus' : 'fa-plus') + '"></i> ' + (selectedIndex >= 0 ? 'Remove' : 'Add') + '</a></div>';

        row.innerHTML = '<span class="opcda-tree-indent"></span>'
            + '<span class="opcda-tree-twisty opcda-client-toggle-tree" data-path="' + escapeHtml(path) + '">'
            + (expanded ? '<i class="fa fa-caret-down"></i>' : '<i class="fa fa-caret-right"></i>') + '</span>'
            + '<span class="opcda-tree-icon"><i class="fa fa-sitemap"></i></span>'
            + '<span class="opcda-tree-label">' + escapeHtml(root.name || "RootFolder") + '</span>'
            + actions;
        frag.appendChild(row);

        if (!expanded) return;

        if (!Array.isArray(root.browse) || !root.browse.length) {
            frag.appendChild(makeEl("div", "opcda-tree-empty", "No items found.."));
        } else {
            root.browse.forEach(function (item, index) {
                renderBrowseItem(item, path + ".browse." + index, depth + 1, frag);
            });
        }
    }

    function renderBrowseItem(item, path, depth, frag) {
        var expanded = isExpanded(path, false);
        var itemId = itemIdOf(item);
        var selectedIndex = selectedIndexByItemId(itemId);
        var hasChildren = canExpand(item);
        var row = makeTreeRow(path, selectedIndex >= 0 ? "is-selected" : "");

        var indents = "";
        for (var i = 0; i < depth; i += 1) indents += '<span class="opcda-tree-indent"></span>';

        var twisty = '<span class="opcda-tree-twisty' + (hasChildren ? ' opcda-client-toggle-tree' : '') + '" data-path="' + escapeHtml(path) + '">'
            + (hasChildren ? '<i class="fa ' + (expanded ? 'fa-caret-down' : 'fa-caret-right') + '"></i>' : '') + '</span>';

        var actions = itemId
            ? '<div class="opcda-tree-actions"><a href="#" class="editor-button editor-button-small opcda-client-toggle-tag" data-nodeid="' + escapeHtml(itemId) + '" data-path="' + escapeHtml(path) + '"><i class="fa ' + (selectedIndex >= 0 ? 'fa-minus' : 'fa-plus') + '"></i> ' + (selectedIndex >= 0 ? 'Remove' : 'Add') + '</a></div>'
            : '';

        row.innerHTML = indents + twisty
            + '<span class="opcda-tree-icon"><i class="fa ' + browseIconFor(item) + '"></i></span>'
            + '<span class="opcda-tree-label">' + escapeHtml(item.name || item.itemID) + '</span>'
            + '<span class="opcda-client-nodeid-label">' + escapeHtml(itemId) + '</span>'
            + actions;
        frag.appendChild(row);

        if (expanded && hasChildren) {
            if (Array.isArray(item.browse)) {
                if (!item.browse.length) {
                    frag.appendChild(makeEl("div", "opcda-tree-empty", "No children found.."));
                } else {
                    item.browse.forEach(function (child, index) {
                        renderBrowseItem(child, path + ".browse." + index, depth + 1, frag);
                    });
                }
            } else {
                frag.appendChild(makeEl("div", "opcda-tree-empty", "Searching for items..."));
            }
        }
    }

    function renderBrowseRootFiltered(root, path, depth, frag, term) {
        var row = makeTreeRow(path);
        row.innerHTML = '<span class="opcda-tree-indent"></span>'
            + '<span class="opcda-tree-twisty"><i class="fa fa-caret-down"></i></span>'
            + '<span class="opcda-tree-icon"><i class="fa fa-sitemap"></i></span>'
            + '<span class="opcda-tree-label">' + escapeHtml(root.name || "RootFolder") + '</span>';
        frag.appendChild(row);

        if (!Array.isArray(root.browse) || !root.browse.length) {
            frag.appendChild(makeEl("div", "opcda-tree-empty", "No items found."));
            return;
        }

        root.browse.forEach(function (item, index) {
            if (branchHasSearchMatch(item, term)) {
                renderBrowseItemFiltered(item, path + ".browse." + index, depth + 1, frag, term, false);
            }
        });
    }

    function renderBrowseItemFiltered(item, path, depth, frag, term, ancestorMatched) {
        if (!branchHasSearchMatch(item, term)) return;

        var itemId = itemIdOf(item);
        var selectedIndex = selectedIndexByItemId(itemId);
        var hasChildren = canExpand(item);
        var subtreeVisible = !!ancestorMatched || nodeMatchesSearch(item, term);
        var hasMatchingLoadedChild = hasChildren && Array.isArray(item.browse) && item.browse.some(function (child) {
            return branchHasSearchMatch(child, term);
        });
        var hasExplicitExpansion = expansionState[path] !== undefined;
        var expanded = hasChildren && (hasExplicitExpansion
            ? !!expansionState[path]
            : ((subtreeVisible && Array.isArray(item.browse)) || hasMatchingLoadedChild));

        var row = makeTreeRow(path, selectedIndex >= 0 ? "is-selected" : "");

        var indents = "";
        for (var i = 0; i < depth; i += 1) indents += '<span class="opcda-tree-indent"></span>';

        var twisty = '<span class="opcda-tree-twisty' + (hasChildren ? ' opcda-client-toggle-tree' : '') + '" data-path="' + escapeHtml(path) + '">'
            + (hasChildren ? '<i class="fa ' + (expanded ? 'fa-caret-down' : 'fa-caret-right') + '"></i>' : '') + '</span>';

        var actions = itemId
            ? '<div class="opcda-tree-actions"><a href="#" class="editor-button editor-button-small opcda-client-toggle-tag" data-nodeid="' + escapeHtml(itemId) + '" data-path="' + escapeHtml(path) + '"><i class="fa ' + (selectedIndex >= 0 ? 'fa-minus' : 'fa-plus') + '"></i> ' + (selectedIndex >= 0 ? 'Remove' : 'Add') + '</a></div>'
            : '';

        row.innerHTML = indents + twisty
            + '<span class="opcda-tree-icon"><i class="fa ' + browseIconFor(item) + '"></i></span>'
            + '<span class="opcda-tree-label">' + escapeHtml(item.name || item.itemID) + '</span>'
            + '<span class="opcda-client-nodeid-label">' + escapeHtml(itemId) + '</span>'
            + actions;
        frag.appendChild(row);

        if (expanded && hasChildren) {
            if (Array.isArray(item.browse)) {
                if (!item.browse.length) {
                    frag.appendChild(makeEl("div", "opcda-tree-empty", "No children found."));
                } else {
                    item.browse.forEach(function (child, index) {
                        if (subtreeVisible || branchHasSearchMatch(child, term)) {
                            renderBrowseItemFiltered(child, path + ".browse." + index, depth + 1, frag, term, subtreeVisible);
                        }
                    });
                }
            } else {
                frag.appendChild(makeEl("div", "opcda-tree-empty", "Expanding..."));
            }
        }
    }

    function getItemAtPath(path) {
        var tokens = String(path || "").split(".");
        var current = browseState;

        for (var index = 0; index < tokens.length; index += 1) {
            var token = tokens[index];
            if (!token || token === "root") continue;
            if (!current) return null;
            if (/^\d+$/.test(token)) {
                current = current[Number(token)];
            } else {
                current = current[token];
            }
        }

        return current || null;
    }

    function addSelectedItem(item) {
        var itemId = itemIdOf(item);
        var normalized = {
            name: item.name || itemId,
            itemID: itemId,
            nodeClass: item.isFolder ? "Object" : "Variable",
            valueProperty: "payload",
            valuePropertyType: "msg"
        };
        var currentIndex = selectedIndexByItemId(normalized.itemID);

        if (currentIndex >= 0) {
            selectedItemsState[currentIndex] = normalized;
        } else {
            selectedItemsState.push(normalized);
        }

        syncSelectedItems();
    }

    function toggleSelectedNode(path) {
        var item = getItemAtPath(path);
        if (!item) return;
        var itemId = itemIdOf(item);
        if (itemId === null || itemId === undefined) return;

        var currentIndex = selectedIndexByItemId(itemId);
        var isSelected;
        if (currentIndex >= 0) {
            selectedItemsState.splice(currentIndex, 1);
            isSelected = false;
        } else {
            selectedItemsState.push({
                name: item.name || itemId,
                itemID: itemId,
                nodeClass: item.isFolder ? "Object" : "Variable",
                valueProperty: "payload",
                valuePropertyType: "msg"
            });
            isSelected = true;
        }

        rebuildItemIdIndex();
        updateSelectedItemsField();
        renderSelectedItems();
        patchRowSelectionUI(path, isSelected);
    }

    function refreshBrowseRoot() {
        var container = $("#node-input-opcda-browse-tree");
        container.html('<div class="opcda-tree-empty">Loading...</div>');

        loadBrowse("").done(function (payload) {
            browseState = payload || {};
            browseState.itemID = "";
            browseState.name = "RootFolder";
            browseState.isFolder = true;
            expansionState = { root: true };
            saveBrowseSession();
            renderBrowseTree();
        }).fail(function (xhr) {
            var message = xhr && xhr.responseJSON && xhr.responseJSON.error
                ? xhr.responseJSON.error
                : "Failed to browse the OPC DA server.";
            browseState = null;
            container.html('<div class="opcda-tree-empty">' + escapeHtml(message) + '</div>');
            RED.notify(message, "error");
        });
    }

    function hideTreeContextMenu() {
        contextMenuPath = "";
        $("#node-input-opcda-browse-context-menu").hide();
    }

    function showTreeContextMenu(x, y, path) {
        var menu = $("#node-input-opcda-browse-context-menu");
        var item = getItemAtPath(path);
        contextMenuPath = path || "";
        var isFolder = !!item && item.isFolder;
        var hasId = !!itemIdOf(item);

        $("#node-input-opcda-browse-context-refresh").toggle(isFolder);
        $("#node-input-opcda-browse-context-copy-itemid").toggle(hasId);
        $("#node-input-opcda-browse-context-read-value").toggle(!!item && !isFolder && hasId);
        menu.css({ left: x + "px", top: y + "px" }).show();
    }

    function copyNodeIdFromPath(path) {
        var item = getItemAtPath(path);
        var itemId = itemIdOf(item);
        if (!itemId) {
            RED.notify("itemID not found for the selected item.", "warning");
            return;
        }

        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(itemId).then(function () {
                RED.notify("itemID copied.", "success");
            }).catch(function () {
                RED.notify("Failed to copy itemID.", "error");
            });
            return;
        }

        var input = $("<textarea readonly></textarea>").val(itemId).css({
            position: "fixed",
            left: "-9999px",
            top: "0"
        });
        $("#node-input-opcda-browse-modal").append(input);
        input[0].select();
        try {
            document.execCommand("copy");
            RED.notify("itemID copied.", "success");
        } catch (error) {
            RED.notify("Failed to copy itemID.", "error");
        }
        input.remove();
    }

    function readValueFromPath(path) {
        var item = getItemAtPath(path);
        var itemId = itemIdOf(item);
        if (!itemId) {
            RED.notify("itemID not found for the selected item.", "warning");
            return;
        }

        var connectionId = $("#node-input-connection").val();
        if (!connectionId) {
            RED.notify("Select an OPC DA connection before reading.", "warning");
            return;
        }

        $.getJSON("opcda-client-config/" + encodeURIComponent(connectionId) + "/read", {
            itemID: itemId
        }).done(function (payload) {
            if (payload && payload.error) {
                RED.notify("Read failed: " + payload.error, "error");
            } else if (payload) {
                var valueText = payload.value !== undefined ? String(payload.value) : "undefined";
                RED.notify("Tag value: " + valueText, "success");
            } else {
                RED.notify("No value returned from the server.", "warning");
            }
        }).fail(function (xhr) {
            var message = xhr && xhr.responseJSON && xhr.responseJSON.error
                ? xhr.responseJSON.error
                : "Failed to read tag value.";
            RED.notify(message, "error");
        });
    }

    function setBrowseSelectedPath(path) {
        browseSelectedPath = path || "";
        $(".opcda-tree-row").removeClass("is-selected");
        if (browseSelectedPath) {
            $('.opcda-tree-row[data-path="' + browseSelectedPath + '"]').addClass("is-selected");
        }
    }

    function refreshNode(path) {
        if (!path) return;
        if (path === "root") {
            refreshBrowseRoot();
            return;
        }

        var item = getItemAtPath(path);
        if (!item || !item.isFolder) return;

        item.browse = undefined;
        expansionState[path] = true;
        saveBrowseSession();
        renderBrowseTree();
        expandNode(path);
    }

    function expandNode(path) {
        var item = getItemAtPath(path);
        if (!item || !canExpand(item)) return;

        if (isExpanded(path, false) && !Array.isArray(item.browse)) {
            renderBrowseTree();
        } else {
            expansionState[path] = !isExpanded(path, false);
            saveBrowseSession();
            if (!expansionState[path]) {
                renderBrowseTree();
                return;
            }
        }

        if (Array.isArray(item.browse)) {
            renderBrowseTree();
            return;
        }

        renderBrowseTree();
        var browseItemId = item.itemID;
        loadBrowse(browseItemId).done(function (payload) {
            try {
                if (!payload) {
                    console.error("Browse returned empty payload for node " + browseItemId);
                    item.browse = [];
                } else if (payload.error) {
                    console.error("Browse returned error for node " + browseItemId + ":", payload.error);
                    RED.notify(payload.error, "error");
                    item.browse = [];
                } else {
                    item.browse = Array.isArray(payload.browse) ? payload.browse : [];
                }
                saveBrowseSession();
                renderBrowseTree();
            } catch (e) {
                console.error("Error processing browse results for node " + browseItemId, e);
                item.browse = [];
                expansionState[path] = false;
                saveBrowseSession();
                renderBrowseTree();
            }
        }).fail(function (xhr) {
            item.browse = [];
            expansionState[path] = false;
            saveBrowseSession();
            renderBrowseTree();
            var message = xhr && xhr.responseJSON && xhr.responseJSON.error
                ? xhr.responseJSON.error
                : "Failed to browse child nodes.";
            RED.notify(message, "error");
        });
    }

    function removeSelectedItemByIndex(index) {
        if (index >= 0 && index < selectedItemsState.length) {
            selectedItemsState.splice(index, 1);
            syncSelectedItems();
        }
    }

    // Attach DOM event listeners
    RED.events.on("editor:prepare", function (node) {
        console.log("[OPC-DA View] editor:prepare called", node.type, node);
        if (node.type !== "opcda-client") return;

        console.log("[OPC-DA View] node.selectedItems on enter:", node.selectedItems);
        console.log("[OPC-DA View] #node-input-selectedItems value in DOM:", $("#node-input-selectedItems").val());

        // Sync initial selections
        var savedVal = node.selectedItems;
        if (savedVal && typeof savedVal === "object") {
            savedVal = JSON.stringify(savedVal);
        } else {
            savedVal = savedVal || $("#node-input-selectedItems").val() || "[]";
        }
        selectedItemsState = parseSelectedItems(savedVal);

        // Fallback to node.tags if selectedItemsState is empty
        if (selectedItemsState.length === 0) {
            var tagsVal = node.tags || $("#node-input-tags").val() || "";
            if (tagsVal) {
                var tagsList = tagsVal.split(/[\n,]+/).map(function (t) { return t.trim(); }).filter(Boolean);
                if (tagsList.length > 0) {
                    selectedItemsState = tagsList.map(function (tag) {
                        var parts = tag.split(".");
                        var name = parts[parts.length - 1] || tag;
                        return {
                            name: name,
                            itemID: tag,
                            nodeClass: "Variable",
                            valueProperty: "payload",
                            valuePropertyType: "msg"
                        };
                    });
                    // Sync back to hidden fields
                    updateSelectedItemsField();
                }
            }
        }

        rebuildItemIdIndex();
        renderSelectedItems();

        if (loadBrowseSession()) {
            renderBrowseTree();
        } else {
            browseState = null;
            expansionState = {};
            renderBrowseTree();
        }

        // Hook up open browse button
        $("#node-input-opcda-open-browse-modal").off("click").on("click", function (e) {
            e.preventDefault();
            openBrowseModal();
            if (!browseState) {
                refreshBrowseRoot();
            }
        });

        $("#node-input-opcda-close-browse-modal").off("click").on("click", function (e) {
            e.preventDefault();
            closeBrowseModal();
        });

        $("#node-input-opcda-browse-root").off("click").on("click", function (e) {
            e.preventDefault();
            refreshBrowseRoot();
        });

        // Twisty expansion click
        $("#node-input-opcda-browse-tree").off("click", ".opcda-client-toggle-tree").on("click", ".opcda-client-toggle-tree", function (e) {
            e.preventDefault();
            e.stopPropagation();
            var path = $(this).attr("data-path");
            expandNode(path);
        });

        // Add/Remove tag toggle click
        $("#node-input-opcda-browse-tree").off("click", ".opcda-client-toggle-tag").on("click", ".opcda-client-toggle-tag", function (e) {
            e.preventDefault();
            e.stopPropagation();
            var path = $(this).attr("data-path");
            toggleSelectedNode(path);
        });

        // Row select click
        $("#node-input-opcda-browse-tree").off("click", ".opcda-tree-row").on("click", ".opcda-tree-row", function (e) {
            e.preventDefault();
            var path = $(this).attr("data-path");
            setBrowseSelectedPath(path);

            if (e.ctrlKey || e.metaKey) {
                e.stopPropagation();
                toggleSelectedNode(path);
            }
        });

        // Row double click to expand/collapse
        $("#node-input-opcda-browse-tree").off("dblclick", ".opcda-tree-row").on("dblclick", ".opcda-tree-row", function (e) {
            e.preventDefault();
            var path = $(this).attr("data-path");
            expandNode(path);
        });

        // Row context menu right click
        $("#node-input-opcda-browse-tree").off("contextmenu", ".opcda-tree-row").on("contextmenu", ".opcda-tree-row", function (e) {
            e.preventDefault();
            var path = $(this).attr("data-path");
            setBrowseSelectedPath(path);
            showTreeContextMenu(e.clientX, e.clientY, path);
        });

        // Hide context menu on click elsewhere
        $(document).off("mousedown.opcda-menu").on("mousedown.opcda-menu", function (e) {
            if (!$(e.target).closest("#node-input-opcda-browse-context-menu").length) {
                hideTreeContextMenu();
            }
        });

        // Context menu actions
        $("#node-input-opcda-browse-context-refresh").off("click").on("click", function (e) {
            e.preventDefault();
            hideTreeContextMenu();
            refreshNode(contextMenuPath);
        });

        $("#node-input-opcda-browse-context-copy-itemid").off("click").on("click", function (e) {
            e.preventDefault();
            hideTreeContextMenu();
            copyNodeIdFromPath(contextMenuPath);
        });

        $("#node-input-opcda-browse-context-read-value").off("click").on("click", function (e) {
            e.preventDefault();
            hideTreeContextMenu();
            readValueFromPath(contextMenuPath);
        });

        // Remove tag action on selected tags list
        $("#node-input-selected-tags").off("click", ".opcda-client-remove-tag").on("click", ".opcda-client-remove-tag", function (e) {
            e.preventDefault();
            var idx = Number($(this).attr("data-index"));
            removeSelectedItemByIndex(idx);
        });

        // Change value property updates
        $("#node-input-selected-tags").off("change", ".opcda-client-item-value-prop").on("change", ".opcda-client-item-value-prop", function () {
            var input = $(this);
            var index = Number(input.attr("data-index"));
            if (selectedItemsState[index]) {
                selectedItemsState[index].valueProperty = input.val();
                updateSelectedItemsField();
            }
        });

        $("#node-input-selected-tags").off("change", ".opcda-client-item-value-type").on("change", ".opcda-client-item-value-type", function () {
            var input = $(this);
            var index = Number(input.attr("data-index"));
            if (selectedItemsState[index]) {
                selectedItemsState[index].valuePropertyType = input.val();
                updateSelectedItemsField();
            }
        });

        // Debounce search in browse tree
        var searchInput = $("#node-input-opcda-browse-search");
        var clearSearch = $("#node-input-opcda-browse-search-clear");
        
        var performSearch = debounce(function () {
            browseSearchTerm = normalizeSearchTerm(browseSearchValue);
            renderBrowseTree();
        }, 200);

        searchInput.off("input").on("input", function () {
            browseSearchValue = $(this).val();
            clearSearch.toggle(!!browseSearchValue);
            performSearch();
        });

        clearSearch.off("click").on("click", function (e) {
            e.preventDefault();
            searchInput.val("");
            browseSearchValue = "";
            clearSearch.hide();
            performSearch();
        });

        // Redraw tag chips if mode changes to 'write' to display Value property configuration
        $("#node-input-mode").off("change.renderSelected").on("change.renderSelected", function () {
            renderSelectedItems();
        });
    });

    RED.events.on("editor:cancel", function (node) {
        console.log("[OPC-DA View] editor:cancel called", node.type);
        if (node.type === "opcda-client") {
            hideTreeContextMenu();
            $(document).off("mousedown.opcda-menu");
        }
    });

    RED.events.on("editor:save", function (node) {
        console.log("[OPC-DA View] editor:save called", node.type);
        if (node.type === "opcda-client") {
            commitSelectedItemsState(node);
            hideTreeContextMenu();
            $(document).off("mousedown.opcda-menu");
        }
    });
})();
