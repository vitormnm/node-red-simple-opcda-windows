"use strict";

const path = require("path");

module.exports = function (RED) {
    function OpcDaClientNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.connection = RED.nodes.getNode(config.connection);
        node.mode = config.mode || "read";
        node.groupName = (config.groupName || "").trim() || "Group_" + node.id;
        node.updateRate = Number(config.updateRate) || 1000;
        node.recursiveValues = config.recursiveValues === true;

        // Parse configured tags from tree selection first, falling back to raw list
        node.configuredTags = [];
        if (config.selectedItems) {
            try {
                const parsed = typeof config.selectedItems === "string" ? JSON.parse(config.selectedItems) : config.selectedItems;
                node.configuredTags = (parsed || [])
                    .map(item => {
                        var id = item.itemID !== undefined && item.itemID !== null ? item.itemID : item.nodeID;
                        return id !== undefined && id !== null ? String(id).trim() : null;
                    })
                    .filter(t => t !== null);
            } catch (e) {
                node.configuredTags = [];
            }
        }
        if (node.configuredTags.length === 0) {
            node.configuredTags = (config.tags || "")
                .split(/[\n,]+/)
                .map(t => t.trim())
                .filter(t => t.length > 0);
        }

        node.activeSubscription = false;
        node.subscribedTags = null;

        const updateStatus = () => {
            if (!node.connection) {
                node.status({ fill: "grey", shape: "ring", text: "no connection node" });
            } else if (node.connection.isConnected) {
                if (node.mode === "subscription" && node.activeSubscription) {
                    node.status({ fill: "green", shape: "dot", text: "subscribed" });
                } else {
                    node.status({ fill: "green", shape: "dot", text: "connected" });
                }
            } else if (node.connection.isConnecting) {
                node.status({ fill: "yellow", shape: "ring", text: "connecting..." });
            } else {
                node.status({ fill: "red", shape: "ring", text: "disconnected" });
            }
        };

        if (node.connection) {
            updateStatus();

            const tryAutoSubscribe = async (label) => {
                const tags = node.subscribedTags;
                if (tags && tags.length > 0) {
                    try {
                        node.log(`Auto-subscribing (${label})...`);
                        node.status({ fill: "yellow", shape: "ring", text: "subscribing..." });
                        node.connection.addSubscriptionListener(node.groupName, handleDataChange);
                        await node.connection.executeCommand("subscribe", {
                            groupName: node.groupName,
                            requestedUpdateRate: node.updateRate,
                            tags: tags,
                            mode: "replace"
                        });
                        node.activeSubscription = true;
                        node.status({ fill: "green", shape: "dot", text: "subscribed" });
                        node.log("Subscribed successfully.");
                    } catch (err) {
                        node.activeSubscription = false;
                        node.status({ fill: "red", shape: "ring", text: "subscription failed" });
                        node.error(`Failed to auto-subscribe (${label}): ` + err.message);
                    }
                }
            };

            const onConnected = async () => {
                updateStatus();
                if (node.mode === "subscription" && node.activeSubscription) {
                    await tryAutoSubscribe("reconnect");
                }
            };
            node.connection.on("connected", onConnected);

            const onShutdown = (message) => {
                updateStatus();
                node.error("OPC DA connection lost: " + message, {});
            };
            node.connection.on("shutdown", onShutdown);
        }

        function getNameMap(msg) {
            const nameMap = new Map();
            if (config.selectedItems) {
                try {
                    const parsed = typeof config.selectedItems === "string" ? JSON.parse(config.selectedItems) : config.selectedItems;
                    (parsed || []).forEach(item => {
                        const id = item.itemID || item.nodeID;
                        if (id && item.name) {
                            nameMap.set(id, item.name);
                        }
                    });
                } catch (e) {}
            }
            if (msg && Array.isArray(msg.payload)) {
                msg.payload.forEach(item => {
                    if (item && typeof item === "object") {
                        const id = String(item.itemID || item.itemId || item.tag || "").trim();
                        if (id && item.name) {
                            nameMap.set(id, item.name);
                        }
                    }
                });
            } else if (msg && msg.payload && typeof msg.payload === "object") {
                const id = String(msg.payload.itemID || msg.payload.itemId || msg.payload.tag || "").trim();
                if (id && msg.payload.name) {
                    nameMap.set(id, msg.payload.name);
                }
            }
            return nameMap;
        }

        const handleDataChange = (data) => {
            if (node.mode === "subscription" && !node.activeSubscription) {
                node.activeSubscription = true;
                updateStatus();
            }
            const nameMap = getNameMap();
            const formatted = (data || []).map(res => {
                const friendlyName = nameMap.get(res.tag) || res.tag.split(".").pop();
                return {
                    itemID: res.tag,
                    name: friendlyName,
                    value: res.value,
                    quality: res.quality,
                    timestamp: res.timestamp,
                    error: res.error
                };
            });
            node.send({
                topic: node.groupName,
                payload: formatted
            });
        };

        node.on("input", async function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };

            if (!node.connection) {
                node.error("No OPC DA client connection node configured", msg);
                node.status({ fill: "red", shape: "ring", text: "no connection" });
                if (done) done();
                return;
            }

            try {
                if (node.mode === "subscription") {
                    let subMode = config.subscriptionMode || "replace";
                    let groupName = node.groupName;
                    let updateRate = node.updateRate;
                    let action = "subscribe";

                    if (msg.opcda && typeof msg.opcda === "object") {
                        if (msg.opcda.subscriptionMode === "replace" || msg.opcda.subscriptionMode === "append" || msg.opcda.subscriptionMode === "clear") {
                            subMode = msg.opcda.subscriptionMode;
                        }
                        if (msg.opcda.mode === "replace" || msg.opcda.mode === "append" || msg.opcda.mode === "clear") {
                            subMode = msg.opcda.mode;
                        }
                        if (typeof msg.opcda.groupName === "string" && msg.opcda.groupName.trim()) {
                            groupName = msg.opcda.groupName.trim();
                        }
                        if (Number(msg.opcda.updateRate) > 0) {
                            updateRate = Number(msg.opcda.updateRate);
                        }
                        if (msg.opcda.action === "unsubscribe" || msg.opcda.action === "clear") {
                            action = "unsubscribe";
                        }
                    }

                    if (msg.payload === null || (Array.isArray(msg.payload) && msg.payload.length === 0)) {
                        action = "unsubscribe";
                        subMode = "clear";
                    }

                    if (action === "unsubscribe" || subMode === "clear") {
                        const tags = (action === "unsubscribe" && subMode !== "clear") ? getTagsList(msg) : [];
                        const response = await node.connection.executeCommand("unsubscribe", {
                            groupName: groupName,
                            tags: tags
                        });

                        if (tags.length === 0) {
                            node.activeSubscription = false;
                            node.subscribedTags = null;
                            updateStatus();
                        } else if (node.subscribedTags) {
                            node.subscribedTags = node.subscribedTags.filter(t => !tags.includes(t));
                            if (node.subscribedTags.length === 0) {
                                node.activeSubscription = false;
                                node.subscribedTags = null;
                                updateStatus();
                            }
                        }

                        msg.payload = response.data;
                        send(msg);
                    } else {
                        const tags = getTagsList(msg);
                        if (tags.length === 0) {
                            throw new Error("No tags specified for subscription");
                        }

                        node.connection.addSubscriptionListener(groupName, handleDataChange);

                        const response = await node.connection.executeCommand("subscribe", {
                            groupName: groupName,
                            requestedUpdateRate: updateRate,
                            tags: tags,
                            mode: subMode
                        });

                        node.activeSubscription = true;
                        if (subMode === "append" && node.subscribedTags) {
                            node.subscribedTags = Array.from(new Set([...node.subscribedTags, ...tags]));
                        } else {
                            node.subscribedTags = tags;
                        }
                        updateStatus();

                        const nameMap = getNameMap(msg);
                        const formatted = (response.data.results || []).map(res => {
                            const friendlyName = nameMap.get(res.tag) || res.tag.split(".").pop();
                            return {
                                itemID: res.tag,
                                name: friendlyName,
                                value: res.value,
                                quality: res.quality,
                                timestamp: res.timestamp,
                                error: res.error
                            };
                        });

                        msg.payload = formatted;
                        send(msg);
                    }
                } 
                else if (node.mode === "read") {
                    const tags = getTagsList(msg);
                    if (tags.length === 0) {
                        throw new Error("No tags specified for read");
                    }

                    const response = await node.connection.executeCommand("read", {
                        tags: tags
                    });

                    const nameMap = getNameMap(msg);
                    const formatted = (response.data.results || []).map(res => {
                        const friendlyName = nameMap.get(res.tag) || res.tag.split(".").pop();
                        return {
                            itemID: res.tag,
                            name: friendlyName,
                            value: res.value,
                            quality: res.quality,
                            timestamp: res.timestamp,
                            error: res.error
                        };
                    });

                    msg.payload = formatted;
                    send(msg);
                    node.status({ fill: "green", shape: "dot", text: "read " + formatted.length + " tags" });
                } 
                else if (node.mode === "write") {
                    const items = getWriteItems(msg);
                    if (items.length === 0) {
                        throw new Error("No items specified for write");
                    }

                    const response = await node.connection.executeCommand("write", {
                        items: items
                    });

                    msg.payload = response.data.results;
                    send(msg);
                    node.status({ fill: "green", shape: "dot", text: "write " + response.data.results.length + " tags" });
                } 
                else if (node.mode === "browse") {
                    let paths = [];
                    if (Array.isArray(msg.payload)) {
                        paths = msg.payload.map(item => {
                            if (item && typeof item === "object") {
                                return String(item.itemID || item.itemId || item.tag || "").trim();
                            }
                            return String(item).trim();
                        }).filter(Boolean);
                    } else if (msg.payload && typeof msg.payload === "object") {
                        const p = String(msg.payload.itemID || msg.payload.itemId || msg.payload.tag || "").trim();
                        if (p) paths = [p];
                    } else if (msg.payload && typeof msg.payload === "string" && msg.payload.trim()) {
                        paths = [msg.payload.trim()];
                    }

                    if (paths.length === 0 && node.configuredTags && node.configuredTags.length > 0) {
                        paths = node.configuredTags;
                    }

                    if (paths.length === 0) {
                        paths = [""]; // Default to root
                    }

                    const nameMap = getNameMap(msg);
                    const results = [];
                    for (const p of paths) {
                        try {
                            const response = await node.connection.executeCommand("browse", {
                                path: p
                            });

                            if (!response || !response.status) {
                                throw new Error(response ? response.message : "Browse failed");
                            }

                            const formattedBranches = (response.data.branches || []).map(b => {
                                return {
                                    itemID: p ? `${p}.${b}` : b,
                                    name: b,
                                    isFolder: true
                                };
                            });

                            const formattedLeaves = (response.data.leaves || []).map(l => {
                                return {
                                    itemID: l.itemId || l.name,
                                    name: l.name,
                                    isFolder: false
                                };
                            });

                            results.push({
                                itemID: p,
                                name: nameMap.get(p) || p.split(".").pop() || "Root",
                                children: [...formattedLeaves, ...formattedBranches]
                            });
                        } catch (err) {
                            results.push({
                                itemID: p,
                                name: nameMap.get(p) || p.split(".").pop() || "Root",
                                error: err.message
                            });
                        }
                    }

                    msg.payload = results;
                    send(msg);
                    node.status({ fill: "green", shape: "dot", text: "browsed " + results.length + " paths" });
                }
                else if (node.mode === "browseRecursive") {
                    let paths = [];
                    if (Array.isArray(msg.payload)) {
                        paths = msg.payload.map(item => {
                            if (item && typeof item === "object") {
                                return String(item.itemID || item.itemId || item.tag || "").trim();
                            }
                            return String(item).trim();
                        }).filter(Boolean);
                    } else if (msg.payload && typeof msg.payload === "object") {
                        const p = String(msg.payload.itemID || msg.payload.itemId || msg.payload.tag || "").trim();
                        if (p) paths = [p];
                    } else if (msg.payload && typeof msg.payload === "string" && msg.payload.trim()) {
                        paths = [msg.payload.trim()];
                    }

                    if (paths.length === 0 && node.configuredTags && node.configuredTags.length > 0) {
                        paths = node.configuredTags;
                    }

                    if (paths.length === 0) {
                        paths = [""]; // Default to root
                    }

                    const nameMap = getNameMap(msg);
                    const results = [];
                    for (const p of paths) {
                        try {
                            const response = await node.connection.executeCommand("browserecursive", {
                                path: p,
                                readValues: !!node.recursiveValues
                            });

                            if (!response || !response.status) {
                                throw new Error(response ? response.message : "Recursive browse failed");
                            }

                            if (response.data && Array.isArray(response.data)) {
                                results.push(...response.data);
                            } else if (response.data && response.data.results && Array.isArray(response.data.results)) {
                                results.push(...response.data.results);
                            }
                        } catch (err) {
                            results.push({
                                itemID: p,
                                name: nameMap.get(p) || p.split(".").pop() || "Root",
                                error: err.message
                            });
                        }
                    }

                    msg.payload = results;
                    send(msg);
                    node.status({ fill: "green", shape: "dot", text: "browsed recursive " + results.length + " paths" });
                }

                if (done) done();
            } catch (err) {
                node.error("Command failed: " + err.message, msg);
                node.status({ fill: "red", shape: "ring", text: node.mode + " failed" });
                if (done) done(err);
            }
        });

        function getTagsList(msg) {
            if (Array.isArray(msg.payload)) {
                return msg.payload.map(t => {
                    if (t && typeof t === "object") {
                        return String(t.itemID || t.itemId || t.tag || "").trim();
                    }
                    return String(t).trim();
                }).filter(t => t.length > 0);
            }
            if (msg.payload && typeof msg.payload === "string" && msg.payload.trim()) {
                return [msg.payload.trim()];
            }
            if (msg.payload && typeof msg.payload === "object" && (msg.payload.itemID || msg.payload.itemId || msg.payload.tag)) {
                return [String(msg.payload.itemID || msg.payload.itemId || msg.payload.tag).trim()];
            }
            return node.configuredTags;
        }

        function getWriteItems(msg) {
            // 1. Explicit array in payload (highest priority)
            if (Array.isArray(msg.payload)) {
                return msg.payload.map(item => {
                    if (item && typeof item === "object") {
                        const tag = String(item.itemID || item.itemId || item.tag || "").trim();
                        if (tag && item.value !== undefined) {
                            return { tag: tag, value: item.value };
                        }
                    }
                    return null;
                }).filter(item => item !== null);
            }

            // 2. Explicit single item in payload
            if (msg.payload && typeof msg.payload === "object" && (msg.payload.itemID || msg.payload.itemId || msg.payload.tag) && msg.payload.value !== undefined) {
                const tag = String(msg.payload.itemID || msg.payload.itemId || msg.payload.tag || "").trim();
                return [{ tag: tag, value: msg.payload.value }];
            }

            // 3. Evaluate configured tag property mappings in the node panel
            if (config.selectedItems) {
                try {
                    const parsed = typeof config.selectedItems === "string" ? JSON.parse(config.selectedItems) : config.selectedItems;
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        const items = [];
                        parsed.forEach(item => {
                            const tag = item.itemID || item.nodeID;
                            if (!tag) return;

                            const property = typeof item.valueProperty === "string" && item.valueProperty.trim() ? item.valueProperty.trim() : "payload";
                            const type = item.valuePropertyType === "flow" || item.valuePropertyType === "global" ? item.valuePropertyType : "msg";

                            let value;
                            if (type === "msg") {
                                value = RED.util.getMessageProperty(msg, property);
                            } else if (type === "flow") {
                                value = node.context().flow.get(property);
                            } else if (type === "global") {
                                value = node.context().global.get(property);
                            }

                            if (value !== undefined) {
                                items.push({ tag: tag, value: value });
                            }
                        });

                        if (items.length > 0) {
                            return items;
                        }
                    }
                } catch (e) {
                    node.error("Failed to parse selectedItems mappings: " + e.message);
                }
            }

            // 4. Default fallback to first configured tag with raw msg.payload
            if (node.configuredTags.length > 0 && msg.payload !== undefined) {
                return [{ tag: node.configuredTags[0], value: msg.payload }];
            }

            return [];
        }


        node.on("close", function (done) {
            if (node.connection) {
                node.connection.removeListener("connected", onConnected);
                node.connection.removeListener("shutdown", onShutdown);
                node.connection.removeSubscriptionListener(node.groupName, handleDataChange);

                if (node.activeSubscription) {
                    node.connection.executeCommand("unsubscribe", {
                        groupName: node.groupName
                    }).catch(() => {}).finally(() => {
                        done();
                    });
                    return;
                }
            }
            done();
        });
    }

    RED.nodes.registerType("opcda-client", OpcDaClientNode);
};
