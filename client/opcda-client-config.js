"use strict";

const { spawn, exec } = require("child_process");
const path = require("path");
const readline = require("readline");
const fs = require("fs");

module.exports = function (RED) {
    // Check if OPCDAAuto.dll is registered on startup (checking both 64-bit and 32-bit registry hives)
    exec('reg query "HKCR\\CLSID\\{28E68F9A-8D75-11D1-8DC3-3C302A000000}"', (err, stdout, stderr) => {
        const isRegistered64 = !err;
        
        exec('reg query "HKCR\\Wow6432Node\\CLSID\\{28E68F9A-8D75-11D1-8DC3-3C302A000000}"', (err32, stdout32, stderr32) => {
            const isRegistered32 = !err32;

            if (!isRegistered64 && !isRegistered32) {
                RED.log.warn("OPC DA: OPCDAAuto.dll is not registered in the system. Attempting to register...");
                
                const dllPath = path.join(__dirname, "../bin/OPCDAAuto.dll");
                if (fs.existsSync(dllPath)) {
                    // Execute registration with UAC elevation request
                    const psCommand = `Start-Process C:\\Windows\\SysWOW64\\regsvr32.exe -ArgumentList '/s "${dllPath}"' -Verb RunAs`;
                    exec(`powershell -Command "${psCommand}"`, (psErr, psStdout, psStderr) => {
                        if (psErr) {
                            RED.log.error("OPC DA: Failed to trigger UAC elevation for registration: " + psErr.message);
                        } else {
                            RED.log.info("OPC DA: Registration UAC command sent to system.");
                        }
                    });
                } else {
                    RED.log.error("OPC DA: OPCDAAuto.dll not found in bin folder: " + dllPath);
                }
            } else {
                RED.log.info(`OPC DA: OPCDAAuto.dll is already registered (32-bit: ${isRegistered32}, 64-bit: ${isRegistered64}).`);
            }
        });
    });

    function OpcDaClientConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server = (config.server || "").trim();
        node.nodeName = (config.nodeName || "").trim();
        node.commandTimeout = Number(config.commandTimeout) || 15000;
        node.name = (config.name || "").trim();
        node.autoReconnect = config.autoReconnect !== false;
        node.reconnectInterval = Number(config.reconnectInterval) || 5000;

        node.child = null;
        node.rl = null;
        node.requestIdCounter = 0;
        node.pendingRequests = new Map();
        node.subscriptionListeners = new Map();
        node.isConnected = false;
        node.isConnecting = false;
        node.isClosing = false;
        node.reconnectTimer = null;

        node.connect = function () {
            if (node.isClosing) return;
            if (node.child) return;

            node.isConnecting = true;
            node.log("Starting OPC DA C# process...");

            // Go up one directory from Node-RED/client/ to Node-RED/, then to bin/
            const binaryPath = path.join(__dirname, "../bin/ConsoleApp_simple_opcda.exe");

            try {
                node.child = spawn(binaryPath, [], {
                    windowsHide: true
                });
            } catch (err) {
                node.error("Failed to spawn OPC DA process: " + err.message);
                node.isConnecting = false;
                node.triggerReconnect();
                return;
            }

            node.rl = readline.createInterface({
                input: node.child.stdout,
                terminal: false
            });

            node.rl.on("line", (line) => {
                try {
                    const response = JSON.parse(line);
                    if (response.id && node.pendingRequests.has(response.id)) {
                        const { resolve, reject, timer } = node.pendingRequests.get(response.id);
                        node.pendingRequests.delete(response.id);
                        clearTimeout(timer);

                        if (response.status) {
                            resolve(response);
                        } else {
                            reject(new Error(response.message || "Unknown error"));
                        }
                    } else if (response.action === "event") {
                        const groupName = response.groupName;
                        if (node.subscriptionListeners.has(groupName)) {
                            node.subscriptionListeners.get(groupName).forEach(callback => {
                                callback(response.data);
                            });
                        }
                    } else if (response.action === "shutdown") {
                        node.error("OPC Server shutdown event received: " + response.message);
                        node.emit("shutdown", response.message);
                        node.cleanupProcess();
                        node.triggerReconnect();
                    }
                } catch (e) {
                    node.error("Failed to parse JSON response from C# process: " + e.message + " Line: " + line);
                }
            });

            node.child.stderr.on("data", (data) => {
                node.warn("C# Client Diagnostic: " + data.toString().trim());
            });

            node.child.on("error", (err) => {
                node.error("C# Client Process Error: " + err.message);
            });

            node.child.on("exit", (code, signal) => {
                node.log(`C# Client Process exited with code ${code} and signal ${signal}`);
                if (!node.isClosing) {
                    node.emit("shutdown", `C# Client Process exited with code ${code}`);
                }
                node.cleanupProcess();
                if (!node.isClosing) {
                    node.triggerReconnect();
                }
            });

            // Send connect command to child process
            const reqId = node.nextId();
            node.sendRawCommand({
                id: reqId,
                action: "connect",
                params: {
                    server: node.server,
                    nodeName: node.nodeName
                }
            }).then(() => {
                node.log("Connected to OPC DA Server: " + node.server);
                node.isConnected = true;
                node.isConnecting = false;
                
                // Let the OPC Server namespace/address space settle for 1000ms before notifying client nodes
                setTimeout(() => {
                    node.emit("connected");
                }, 1000);
            }).catch((err) => {
                node.error("Failed to connect to OPC DA Server: " + err.message);
                node.isConnecting = false;
                node.cleanupProcess();
                node.triggerReconnect();
            });
        };

        node.nextId = function () {
            node.requestIdCounter++;
            return String(node.requestIdCounter);
        };

        node.sendRawCommand = function (cmd) {
            return new Promise((resolve, reject) => {
                if (!node.child) {
                    return reject(new Error("C# client process is not running"));
                }

                let timeoutMs = node.commandTimeout;
                if (cmd.action === "browserecursive") {
                    timeoutMs = Math.max(timeoutMs, 120000);
                }
                const timer = setTimeout(() => {
                    if (node.pendingRequests.has(cmd.id)) {
                        node.pendingRequests.delete(cmd.id);
                        reject(new Error(`Command timeout after ${timeoutMs / 1000} seconds`));
                    }
                }, timeoutMs);

                node.pendingRequests.set(cmd.id, { resolve, reject, timer });

                try {
                    node.child.stdin.write(JSON.stringify(cmd) + "\n");
                } catch (err) {
                    node.pendingRequests.delete(cmd.id);
                    clearTimeout(timer);
                    reject(new Error("Failed to write to stdin: " + err.message));
                }
            });
        };

        node.executeCommand = function (action, params) {
            if (action === "connect" || action === "listservers") {
                const reqId = node.nextId();
                const cmd = {
                    id: reqId,
                    action: action,
                    params: params || {}
                };
                return node.sendRawCommand(cmd);
            }

            return new Promise((resolve, reject) => {
                const sendCmd = () => {
                    const reqId = node.nextId();
                    const cmd = {
                        id: reqId,
                        action: action,
                        params: params || {}
                    };
                    node.sendRawCommand(cmd).then(resolve).catch(reject);
                };

                if (node.isConnected) {
                    sendCmd();
                } else if (node.isConnecting) {
                    node.log(`OPC DA: Connection is in progress. Queuing command '${action}'...`);
                    node.once("connected", () => {
                        sendCmd();
                    });
                } else {
                    reject(new Error("OPC DA client is not connected"));
                }
            });
        };

        node.triggerReconnect = function () {
            if (node.isClosing || !node.autoReconnect || node.reconnectTimer) return;

            node.log(`Attempting reconnect in ${node.reconnectInterval}ms...`);
            node.reconnectTimer = setTimeout(() => {
                node.reconnectTimer = null;
                node.connect();
            }, node.reconnectInterval);
        };

        node.cleanupProcess = function () {
            node.isConnected = false;
            node.isConnecting = false;

            // Reject all pending requests
            node.pendingRequests.forEach(({ reject, timer }) => {
                clearTimeout(timer);
                reject(new Error("Connection to OPC DA client process was lost"));
            });
            node.pendingRequests.clear();

            if (node.rl) {
                try { node.rl.close(); } catch (e) {}
                node.rl = null;
            }

            if (node.child) {
                try { node.child.stdin.end(); } catch (e) {}
                try { node.child.kill(); } catch (e) {}
                node.child = null;
            }
        };

        node.addSubscriptionListener = function (groupName, callback) {
            if (!node.subscriptionListeners.has(groupName)) {
                node.subscriptionListeners.set(groupName, new Set());
            }
            node.subscriptionListeners.get(groupName).add(callback);
        };

        node.removeSubscriptionListener = function (groupName, callback) {
            if (node.subscriptionListeners.has(groupName)) {
                const listeners = node.subscriptionListeners.get(groupName);
                listeners.delete(callback);
                if (listeners.size === 0) {
                    node.subscriptionListeners.delete(groupName);
                }
            }
        };

        // Start connection on load
        node.connect();

        node.on("close", function (done) {
            node.isClosing = true;
            if (node.reconnectTimer) {
                clearTimeout(node.reconnectTimer);
                node.reconnectTimer = null;
            }

            if (node.child) {
                node.executeCommand("disconnect", {})
                    .catch(() => {})
                    .finally(() => {
                        node.cleanupProcess();
                        done();
                    });
            } else {
                done();
            }
        });
    }

    RED.nodes.registerType("opcda-client-config", OpcDaClientConfigNode);

    RED.httpAdmin.get("/opcda-client-config/:id/browse", RED.auth.needsPermission("flows.read"), async function (req, res) {
        try {
            const configNode = RED.nodes.getNode(req.params.id);
            if (!configNode) {
                res.status(404).json({ error: "OPC DA client configuration not found" });
                return;
            }

            let path = req.query.itemID || req.query.nodeId || req.query.path || "";
            if (path === "i=84") {
                path = ""; // Translate OPC UA root ID to OPC DA root
            }

            const response = await configNode.executeCommand("browse", { path: path });
            if (!response || !response.status) {
                throw new Error(response ? response.message : "No response from client process");
            }

            const browseResults = [];
            if (response.data.branches) {
                response.data.branches.forEach(branch => {
                    const branchPath = path ? `${path}.${branch}` : branch;
                    browseResults.push({
                        name: branch,
                        itemID: branchPath,
                        isFolder: true
                    });
                });
            }

            if (response.data.leaves) {
                response.data.leaves.forEach(leaf => {
                    browseResults.push({
                        name: leaf.name,
                        itemID: leaf.itemId || leaf.name,
                        isFolder: false
                    });
                });
            }

            res.json({ browse: browseResults });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    RED.httpAdmin.get("/opcda-client-config/:id/read", RED.auth.needsPermission("flows.read"), async function (req, res) {
        try {
            const configNode = RED.nodes.getNode(req.params.id);
            if (!configNode) {
                res.status(404).json({ error: "OPC DA client configuration not found" });
                return;
            }

            const itemId = req.query.itemID || req.query.nodeId;
            if (!itemId) {
                throw new Error("Missing itemID parameter");
            }

            const response = await configNode.executeCommand("read", { tags: [itemId] });
            if (!response || !response.status || !response.data || !response.data.results || response.data.results.length === 0) {
                throw new Error(response ? response.message : "Read failed");
            }

            const result = response.data.results[0];
            if (result.error) {
                throw new Error(result.error);
            }

            res.json({ value: result.value });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    RED.httpAdmin.get("/opcda-client-config/discover", RED.auth.needsPermission("flows.read"), async function (req, res) {
        const nodeName = req.query.nodeName || "";
        const binaryPath = path.join(__dirname, "../bin/ConsoleApp_simple_opcda.exe");

        let tempChild = null;
        let tempRl = null;
        let responded = false;

        const cleanup = () => {
            if (tempRl) {
                try { tempRl.close(); } catch(e) {}
            }
            if (tempChild) {
                try { tempChild.stdin.end(); } catch (e) {}
                try { tempChild.kill(); } catch (e) {}
            }
        };

        const timer = setTimeout(() => {
            if (!responded) {
                responded = true;
                cleanup();
                res.status(504).json({ error: "Discovery timed out after 10 seconds" });
            }
        }, 10000);

        try {
            tempChild = spawn(binaryPath, [], { windowsHide: true });
            tempRl = readline.createInterface({
                input: tempChild.stdout,
                terminal: false
            });

            tempRl.on("line", (line) => {
                try {
                    const response = JSON.parse(line);
                    if (response.action === "listservers" && !responded) {
                        responded = true;
                        clearTimeout(timer);
                        cleanup();
                        if (response.status) {
                            res.json({ servers: response.data.servers || [] });
                        } else {
                            res.status(500).json({ error: response.message || "Failed to list servers" });
                        }
                    }
                } catch (e) {
                    // Ignore malformed json
                }
            });

            // Send command
            const cmd = {
                id: "discover",
                action: "listservers",
                params: {
                    nodeName: nodeName
                }
            };
            tempChild.stdin.write(JSON.stringify(cmd) + "\n");
        } catch (err) {
            if (!responded) {
                responded = true;
                clearTimeout(timer);
                cleanup();
                res.status(500).json({ error: "Failed to spawn discovery process: " + err.message });
            }
        }
    });
};
