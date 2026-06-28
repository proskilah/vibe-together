// VibeTogether - Spicetify Extension for synchronized music listening
// Uses PeerJS for robust P2P connections with free signaling server
// UI based on CoListen extension
// VibeCodeadas Extension

(function p2pSync() {
    if (!Spicetify.Player || !Spicetify.Platform || !Spicetify.React || !Spicetify.ReactDOM) {
        setTimeout(p2pSync, 300);
        return;
    }

    // Load PeerJS from CDN
    const peerjsScript = document.createElement('script');
    peerjsScript.src = 'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js';
    peerjsScript.onload = () => {
        console.log("PeerJS loaded");
        main();
    };
    peerjsScript.onerror = () => {
        console.error("Failed to load PeerJS");
        Spicetify.showNotification('Failed to load PeerJS library');
    };
    document.head.appendChild(peerjsScript);
})();

function main() {
    const { React, ReactDOM } = Spicetify;
    const { useState, useEffect, useRef } = React;

    const STORAGE_KEY = "p2pSync:username";
    const POS_KEY = "p2pSync:panelPos";

    function loadPanelPos() {
        try {
            const p = JSON.parse(Spicetify.LocalStorage.get(POS_KEY) || "null");
            return p && typeof p.x === "number" && typeof p.y === "number" ? p : null;
        } catch { return null; }
    }

    function savePanelPos(x, y) {
        try { Spicetify.LocalStorage.set(POS_KEY, JSON.stringify({ x, y })); } catch {}
    }

    // Drag hook from CoListen
    function useDrag() {
        const stateRef = useRef({
            panelEl: null,
            header: null,
            dragging: false,
            startX: 0, startY: 0, origLeft: 0, origTop: 0,
            onMouseDown: null,
            onMouseMove: null,
            onMouseUp: null,
        });

        if (!stateRef.current.onMouseDown) {
            const st = stateRef.current;

            st.onMouseDown = (e) => {
                if (!st.panelEl) return;
                if (e.target.closest(".p2p-x")) return;
                st.dragging = true;
                const rect = st.panelEl.getBoundingClientRect();
                st.startX = e.clientX; st.startY = e.clientY;
                st.origLeft = rect.left; st.origTop = rect.top;
                st.panelEl.style.right = "auto";
                st.panelEl.style.left  = st.origLeft + "px";
                st.panelEl.style.top   = st.origTop  + "px";
                e.preventDefault();
            };

            st.onMouseMove = (e) => {
                if (!st.dragging || !st.panelEl) return;
                const dx = e.clientX - st.startX;
                const dy = e.clientY - st.startY;
                const newX = Math.max(0, Math.min(window.innerWidth  - st.panelEl.offsetWidth,  st.origLeft + dx));
                const newY = Math.max(0, Math.min(window.innerHeight - st.panelEl.offsetHeight, st.origTop  + dy));
                st.panelEl.style.left = newX + "px";
                st.panelEl.style.top  = newY + "px";
            };

            st.onMouseUp = () => {
                if (!st.dragging || !st.panelEl) return;
                st.dragging = false;
                savePanelPos(parseInt(st.panelEl.style.left), parseInt(st.panelEl.style.top));
            };
        }

        useEffect(() => {
            const st = stateRef.current;
            document.addEventListener("mousemove", st.onMouseMove);
            document.addEventListener("mouseup",   st.onMouseUp);
            return () => {
                document.removeEventListener("mousemove", st.onMouseMove);
                document.removeEventListener("mouseup",   st.onMouseUp);
                if (st.header) {
                    st.header.removeEventListener("mousedown", st.onMouseDown);
                    st.header = null;
                }
                st.panelEl = null;
            };
        }, []);

        return (node) => {
            const st = stateRef.current;
            if (node === st.panelEl) return;
            if (st.header) {
                st.header.removeEventListener("mousedown", st.onMouseDown);
                st.header = null;
            }
            st.panelEl = node;
            if (!node) return;
            const saved = loadPanelPos();
            if (saved) {
                node.style.right = "auto";
                node.style.left  = saved.x + "px";
                node.style.top   = saved.y + "px";
            }
            const header = node.querySelector(".p2p-hd");
            if (header) {
                header.addEventListener("mousedown", st.onMouseDown);
                st.header = header;
            }
        };
    }

    // Configuration
    const CONFIG = {
        SYNC_DELAY: 500,
        MAX_PEERS: 4,
        OWNER_ONLY_MODE: false
    };

    // Session state
    const session = {
        peer: null,
        amHost: false,
        active: false,
        inSession: false,
        code: "",
        myName: "",
        myPeerId: null,
        connections: {}, // peerId -> DataConnection
        members: [],
        permissions: {
            hostOnly: true,
            syncOnPlay: true,
            syncDelay: CONFIG.SYNC_DELAY
        },
        syncTimeout: null,
        ownerOnlyMode: false
    };

    let uiCallback = null;
    function notifyUI() { uiCallback?.(); }

    const log = (...a) => console.log("[P2P]", ...a);
    const err = (...a) => console.error("[P2P]", ...a);

    function getUsername() {
        return Spicetify.LocalStorage.get(STORAGE_KEY) || "Me";
    }
    function saveUsername(n) {
        Spicetify.LocalStorage.set(STORAGE_KEY, n);
    }

    function generateRoomId() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let id = '';
        for (let i = 0; i < 8; i++) {
            id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return id;
    }

    function sendMessageToPeer(peerId, message) {
        if (session.connections[peerId] && session.connections[peerId].open) {
            session.connections[peerId].send(message);
        }
    }

    function broadcastMessage(message) {
        Object.keys(session.connections).forEach(peerId => {
            sendMessageToPeer(peerId, message);
        });
    }

    function isPlayingNow() {
        try {
            const p = Spicetify.Player;
            if (p?.data && typeof p.data.isPaused === "boolean") return !p.data.isPaused;
            if (typeof p?.isPlaying === "function") return !!p.isPlaying();
            if (typeof p?.isPlaying === "boolean") return p.isPlaying;
        } catch {}
        return false;
    }

    function getState() {
        try {
            const d = Spicetify.Player.data;
            if (!d?.item) return null;
            return {
                uri: d.item.uri,
                name: d.item.name || "",
                position: Spicetify.Player.getProgress(),
                isPlaying: !!isPlayingNow(),
                timestamp: Date.now()
            };
        } catch { return null; }
    }

    async function playUri(uri, pos) {
        const fns = [
            () => Spicetify.Platform.PlayerAPI.play({ uri }, {}, { positionMs: pos }),
            () => Spicetify.CosmosAsync.put("sp://player/v2/main", { playing_uri: uri, position: pos }),
        ];
        for (const fn of fns) {
            try { await fn(); return true; } catch {}
        }
        return false;
    }

    async function applyHostState(s) {
        if (!s?.uri) return;
        try {
            log('Applying host state:', s);
            
            // Calculate elapsed time since host sent this state
            const elapsed = Math.max(0, Math.min(Date.now() - s.timestamp, 5000));
            const target = Math.floor((s.position || 0) + (s.isPlaying ? elapsed : 0));

            const cur = Spicetify.Player.data?.item;
            if (!cur || cur.uri !== s.uri) {
                log('Track change detected, playing new URI');
                await playUri(s.uri, target);
                await new Promise(r => setTimeout(r, 600));
                if (s.isPlaying && !isPlayingNow()) Spicetify.Player.play();
                if (!s.isPlaying && isPlayingNow()) Spicetify.Player.pause();
                return;
            }
            
            log('Same track, seeking to position:', target);
            Spicetify.Player.seek(target);
            setTimeout(() => {
                if (s.isPlaying && !isPlayingNow()) Spicetify.Player.play();
                if (!s.isPlaying && isPlayingNow()) Spicetify.Player.pause();
            }, 200);
        } catch(e) {
            err('Error applying host state:', e);
        }
    }

    function canControlPlayback() {
        return session.amHost || !session.permissions.hostOnly || !session.ownerOnlyMode;
    }

    function showOwnerOnlyNotification() {
        // Create a floating notification
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: #e74c3c;
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            animation: slideDown 0.3s ease;
        `;
        notification.textContent = 'ðŸ”’ Owner Only Mode - Ask host to change or leave session';
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transition = 'opacity 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    function manualSync() {
        if (!session.amHost) {
            const playerState = getState();
            if (playerState) {
                broadcastMessage({
                    type: 'requestState',
                    timestamp: Date.now()
                });
                Spicetify.showNotification('ðŸ”„ Sync requested from host');
            }
        } else {
            const playerState = getState();
            if (playerState) {
                broadcastMessage({
                    type: 'state',
                    state: playerState,
                    permissions: session.permissions,
                    timestamp: Date.now()
                });
                Spicetify.showNotification('ðŸ”„ Sync sent to all peers');
            }
        }
    }

    function toggleOwnerOnlyMode() {
        if (!session.amHost) return;
        session.ownerOnlyMode = !session.ownerOnlyMode;
        broadcastMessage({
            type: 'ownerOnlyMode',
            enabled: session.ownerOnlyMode,
            fromHost: true
        });
        notifyUI();
        Spicetify.showNotification(session.ownerOnlyMode ? 'ðŸ”’ Owner Only Mode enabled' : 'ðŸ”“ Owner Only Mode disabled');
    }

    // PeerJS functions
    function createPeer(id = null) {
        if (session.peer) {
            session.peer.destroy();
        }

        const peer = new Peer(id, { debug: 2 });

        peer.on('open', (peerId) => {
            log('My peer ID:', peerId);
            session.myPeerId = peerId;
            // Don't overwrite session.code with peerId - keep the generated room ID
            notifyUI();
        });

        peer.on('connection', (conn) => {
            log('Incoming connection from:', conn.peer);
            handleIncomingConnection(conn);
        });

        peer.on('error', (err) => {
            err('PeerJS error:', err);
            if (err.type === 'peer-unavailable') {
                Spicetify.showNotification('Peer not found. Check the ID.');
            } else if (err.type === 'network') {
                Spicetify.showNotification('Network error. Check your connection.');
            } else {
                Spicetify.showNotification('Connection error: ' + err.type);
            }
        });

        peer.on('disconnected', () => {
            log('Disconnected from signaling server');
            if (session.active) {
                setTimeout(() => {
                    if (session.peer) {
                        session.peer.reconnect();
                    }
                }, 1000);
            }
        });

        session.peer = peer;
        return peer;
    }

    function connectToPeer(peerId) {
        if (!session.peer) {
            Spicetify.showNotification('Not connected to signaling server');
            return;
        }

        log('Connecting to peer:', peerId);
        const conn = session.peer.connect(peerId, {
            reliable: true,
            serialization: 'json'
        });

        setupConnectionHandlers(conn);
    }

    function handleIncomingConnection(conn) {
        setupConnectionHandlers(conn);
    }

    function setupConnectionHandlers(conn) {
        conn.on('open', () => {
            log('Connection opened with:', conn.peer);
            session.connections[conn.peer] = conn;
            session.active = true;
            session.inSession = true;

            if (!session.members.find(m => m.peerId === conn.peer)) {
                session.members.push({ peerId: conn.peer, name: "Guest" });
            }

            if (session.amHost) {
                sendStateToPeer(conn.peer);
                // Also send a joined message to other peers
                broadcastMessage({ type: 'joined', user: session.myName });
            } else {
                conn.send({ type: 'requestState' });
                conn.send({ type: 'joined', user: session.myName });
            }

            Spicetify.showNotification('Connected to peer!');
            notifyUI();
        });

        conn.on('data', (data) => {
            handlePeerMessage(conn.peer, data);
        });

        conn.on('close', () => {
            log('Connection closed with:', conn.peer);
            delete session.connections[conn.peer];
            session.members = session.members.filter(m => m.peerId !== conn.peer);
            session.active = Object.keys(session.connections).length > 0;
            if (!session.active) {
                session.inSession = false;
            }
            notifyUI();
            Spicetify.showNotification('Peer disconnected');
        });

        conn.on('error', (err) => {
            err('Connection error:', err);
        });
    }

    function sendStateToPeer(peerId) {
        const playerState = getState();
        if (!playerState) return;

        const stateMessage = {
            type: 'state',
            state: playerState,
            permissions: session.permissions
        };
        sendMessageToPeer(peerId, stateMessage);
    }

    function handlePeerMessage(peerId, message) {
        log(`Message from ${peerId}:`, message.type);

        switch (message.type) {
            case 'play':
                if (canControlPlayback() || message.fromHost) {
                    if (session.syncTimeout) clearTimeout(session.syncTimeout);
                    session.syncTimeout = setTimeout(() => {
                        Spicetify.Player.resume();
                    }, session.permissions.syncDelay);
                } else if (!session.amHost && session.ownerOnlyMode) {
                    showOwnerOnlyNotification();
                }
                break;
            case 'pause':
                if (canControlPlayback() || message.fromHost) {
                    if (session.syncTimeout) clearTimeout(session.syncTimeout);
                    Spicetify.Player.pause();
                } else if (!session.amHost && session.ownerOnlyMode) {
                    showOwnerOnlyNotification();
                }
                break;
            case 'seek':
                if (canControlPlayback() || message.fromHost) {
                    Spicetify.Player.seek(message.position);
                } else if (!session.amHost && session.ownerOnlyMode) {
                    showOwnerOnlyNotification();
                }
                break;
            case 'track':
                if (canControlPlayback() || message.fromHost) {
                    applyHostState({ uri: message.uri, position: message.position, isPlaying: message.isPlaying, timestamp: message.timestamp });
                }
                break;
            case 'requestState':
                if (session.amHost) {
                    sendStateToPeer(peerId);
                }
                break;
            case 'state':
                if (!session.amHost) {
                    if (message.permissions) {
                        session.permissions = message.permissions;
                    }
                    applyHostState(message.state);
                }
                break;
            case 'permissionChange':
                if (message.fromHost) {
                    session.permissions = message.permissions;
                    notifyUI();
                }
                break;
            case 'ownerOnlyMode':
                if (message.fromHost) {
                    session.ownerOnlyMode = message.enabled;
                    notifyUI();
                }
                break;
            case 'joined':
                if (!session.members.find(m => m.peerId === peerId)) {
                    session.members.push({ peerId, name: message.name || "Guest" });
                }
                Spicetify.showNotification(`ðŸŽµ ${message.name || "Guest"} joined`);
                notifyUI();
                break;
        }
    }

    // Player event listeners
    function setupPlayerListeners() {
        Spicetify.Player.addEventListener('play', () => {
            log('Play event triggered');
            if (session.active) {
                broadcastMessage({
                    type: 'play',
                    fromHost: session.amHost,
                    timestamp: Date.now()
                });
            }
        });

        Spicetify.Player.addEventListener('pause', () => {
            log('Pause event triggered');
            if (session.active) {
                broadcastMessage({
                    type: 'pause',
                    fromHost: session.amHost
                });
            }
        });

        Spicetify.Player.addEventListener('seek', (e) => {
            log('Seek event triggered:', e.data);
            if (session.active) {
                broadcastMessage({
                    type: 'seek',
                    position: e.data,
                    fromHost: session.amHost,
                    timestamp: Date.now()
                });
            }
        });

        Spicetify.Player.addEventListener('songchange', () => {
            log('Songchange event triggered');
            if (session.active) {
                const playerState = getState();
                if (playerState) {
                    broadcastMessage({
                        type: 'track',
                        uri: playerState.uri,
                        position: playerState.position,
                        isPlaying: playerState.isPlaying,
                        fromHost: session.amHost,
                        timestamp: Date.now()
                    });
                }
            }
        });
    }

    function cleanup() {
        if (session.syncTimeout) {
            clearTimeout(session.syncTimeout);
            session.syncTimeout = null;
        }
        
        Object.keys(session.connections).forEach(peerId => {
            try {
                session.connections[peerId].close();
            } catch (e) {
                err('Error closing connection:', e);
            }
        });
        session.connections = {};
        
        if (session.peer) {
            try {
                session.peer.destroy();
            } catch (e) {
                err('Error destroying peer:', e);
            }
            session.peer = null;
        }
        
        session.active = false;
        session.amHost = false;
        session.inSession = false;
        session.code = "";
        session.myPeerId = null;
        session.members = [];
        notifyUI();
    }

    // Inject CSS
    if (!document.getElementById("p2p-css")) {
        const el = document.createElement("style");
        el.id = "p2p-css";
        el.textContent = `
            @keyframes p2p-in   { from{opacity:0;transform:translateY(-10px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)} }
            @keyframes p2p-spin { to{transform:rotate(360deg)} }
            @keyframes p2p-pulse { 0%,100%{opacity:1}50%{opacity:.5} }
            @keyframes slideDown { from{opacity:0;transform:translate(-50%,-20px)}to{opacity:1;transform:translate(-50%,0)} }
            #p2p-root * { box-sizing:border-box; }
            #p2p-root .p2p-panel { position:fixed;top:56px;right:16px;z-index:9999;width:320px;background:#0a0a0a;border:2px solid #1a1a2e;border-radius:16px;box-shadow:0 25px 50px -12px rgba(0,0,0,.5),0 0 0 1px rgba(99,102,241,.1);color:#fff;font-family:'Segoe UI',system-ui,sans-serif;animation:p2p-in .2s cubic-bezier(.34,1.56,.64,1);overflow:hidden;user-select:none;backdrop-filter:blur(10px); }
            #p2p-root .p2p-hd { cursor:grab;display:flex;align-items:center;justify-content:space-between;padding:14px 16px 12px;border-bottom:1px solid #1a1a2e;background:linear-gradient(180deg,rgba(99,102,241,.05) 0%,transparent 100%); }
            #p2p-root .p2p-hd:active { cursor:grabbing; }
            #p2p-root .p2p-hl { display:flex;align-items:center;gap:8px; }
            #p2p-root .p2p-dot { width:8px;height:8px;border-radius:50%;background:#6366f1;box-shadow:0 0 12px #6366f1,0 0 24px #6366f1;animation:p2p-pulse 2s ease-in-out infinite; }
            #p2p-root .p2p-dot.off { background:#2a2a3e;box-shadow:none;animation:none; }
            #p2p-root .p2p-ttl { font-size:13px;font-weight:700;color:#e0e0e0;letter-spacing:.5px;text-transform:uppercase; }
            #p2p-root .p2p-brand { font-size:9px;font-weight:600;color:#6366f1;letter-spacing:1px;text-transform:uppercase;opacity:.7; }
            #p2p-root .p2p-x { background:none;border:none;color:#4a4a5e;cursor:pointer;font-size:18px;line-height:1;padding:0 4px;transition:all .2s;border-radius:4px; }
            #p2p-root .p2p-x:hover { color:#6366f1;background:rgba(99,102,241,.1); }
            #p2p-root .p2p-bd { padding:14px 16px 16px; }
            #p2p-root .p2p-nr { display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:12px;background:#12121f;border-radius:12px;border:1px solid #1a1a2e; }
            #p2p-root .p2p-av { width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0;text-transform:uppercase;box-shadow:0 4px 12px rgba(99,102,241,.3); }
            #p2p-root .p2p-ni { flex:1;background:transparent;border:none;border-bottom:2px solid #1a1a2e;color:#a0a0b0;font-size:13px;padding:4px 0;outline:none;font-family:inherit;transition:all .2s;font-weight:500; }
            #p2p-root .p2p-ni:focus { border-bottom-color:#6366f1;color:#fff; }
            #p2p-root .p2p-ni::placeholder { color:#3a3a4e; }
            #p2p-root .p2p-btn { display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:12px 16px;border-radius:12px;border:none;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;transition:all .2s cubic-bezier(.34,1.56,.64,1);position:relative;overflow:hidden; }
            #p2p-root .p2p-btn::before { content:'';position:absolute;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,rgba(255,255,255,.1) 0%,transparent 100%);opacity:0;transition:opacity .2s; }
            #p2p-root .p2p-btn:hover::before { opacity:1; }
            #p2p-root .p2p-btn:active { transform:scale(.96); }
            #p2p-root .p2p-g  { background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;box-shadow:0 4px 15px rgba(99,102,241,.4); }
            #p2p-root .p2p-g:hover { box-shadow:0 6px 20px rgba(99,102,241,.5);transform:translateY(-1px); }
            #p2p-root .p2p-gh { background:#1a1a2e;color:#a0a0b0;border:1px solid #2a2a3e; }
            #p2p-root .p2p-gh:hover { background:#2a2a3e;color:#fff;border-color:#3a3a4e; }
            #p2p-root .p2p-lv { background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;border:none;box-shadow:0 4px 15px rgba(239,68,68,.3); }
            #p2p-root .p2p-lv:hover { box-shadow:0 6px 20px rgba(239,68,68,.4);transform:translateY(-1px); }
            #p2p-root .p2p-dim { opacity:.3;pointer-events:none; }
            #p2p-root .p2p-st { display:flex;flex-direction:column;gap:8px; }
            #p2p-root .p2p-dv { border:none;border-top:1px solid #1a1a2e;margin:14px 0; }
            #p2p-root .p2p-lb { font-size:11px;font-weight:700;color:#4a4a5e;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px; }
            #p2p-root .p2p-cb { background:#12121f;border:2px solid #1a1a2e;border-radius:14px;padding:20px;text-align:center;margin-bottom:12px;box-shadow:inset 0 2px 8px rgba(0,0,0,.3); }
            #p2p-root .p2p-cv { font-size:32px;font-weight:900;letter-spacing:6px;color:#6366f1;font-family:'Courier New',monospace;display:block;margin-bottom:10px;text-shadow:0 0 20px rgba(99,102,241,.3); }
            #p2p-root .p2p-cp { background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.3);color:#6366f1;border-radius:8px;padding:6px 16px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s;text-transform:uppercase;letter-spacing:.5px; }
            #p2p-root .p2p-cp:hover { background:rgba(99,102,241,.2);border-color:rgba(99,102,241,.5); }
            #p2p-root .p2p-ci { width:100%;background:#12121f;border:2px solid #1a1a2e;border-radius:12px;padding:12px 16px;color:#a0a0b0;font-size:22px;font-weight:700;font-family:'Courier New',monospace;letter-spacing:5px;outline:none;text-align:center;transition:all .2s;margin-bottom:10px;text-transform:uppercase;box-shadow:inset 0 2px 8px rgba(0,0,0,.3); }
            #p2p-root .p2p-ci:focus { border-color:#6366f1;color:#fff;box-shadow:0 0 0 3px rgba(99,102,241,.2); }
            #p2p-root .p2p-ci::placeholder { font-size:14px;letter-spacing:2px;color:#3a3a4e;font-weight:400;text-transform:none; }
            #p2p-root .p2p-er { font-size:12px;color:#ef4444;margin-bottom:10px;font-weight:600;text-align:center; }
            #p2p-root .p2p-sp { display:inline-block;width:12px;height:12px;flex-shrink:0;border:2px solid #1a1a2e;border-top-color:#6366f1;border-radius:50%;animation:p2p-spin .8s linear infinite; }
            #p2p-root .p2p-ml { background:#12121f;border:1px solid #1a1a2e;border-radius:12px;padding:10px 14px;margin-bottom:12px; }
            #p2p-root .p2p-mr { display:flex;align-items:center;gap:8px;font-size:13px;color:#a0a0b0;padding:4px 0;font-weight:500; }
            #p2p-root .p2p-md { width:6px;height:6px;border-radius:50%;background:#6366f1;box-shadow:0 0 10px #6366f1;flex-shrink:0; }
            #p2p-root .p2p-ms { font-size:10px;margin-left:auto;font-weight:700;color:#4a4a5e;text-transform:uppercase; }
            #p2p-root .p2p-np { background:linear-gradient(135deg,rgba(99,102,241,.1),rgba(139,92,246,.1));border:1px solid rgba(99,102,241,.2);border-radius:12px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px; }
            #p2p-root .p2p-npd { width:7px;height:7px;border-radius:50%;background:#6366f1;box-shadow:0 0 15px #6366f1;flex-shrink:0; }
            #p2p-root .p2p-npt { font-size:12px;color:#a0a0b0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:500; }
            #p2p-root .p2p-bar { position:fixed;bottom:90px;right:16px;z-index:9999;background:#0a0a0a;border:2px solid #1a1a2e;border-radius:12px;padding:10px 16px;display:flex;align-items:center;gap:10px;font-family:'Segoe UI',system-ui,sans-serif;font-size:12px;color:#a0a0b0;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.5),0 0 0 1px rgba(99,102,241,.1);animation:p2p-in .25s ease;backdrop-filter:blur(10px); }
            #p2p-root .p2p-bar:hover { background:#12121f;border-color:#2a2a3e; }
            #p2p-root .p2p-bd2 { width:7px;height:7px;border-radius:50%;background:#6366f1;box-shadow:0 0 15px #6366f1;flex-shrink:0; }
            #p2p-root .p2p-ic { display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg,rgba(99,102,241,.05),rgba(139,92,246,.05));border:1px solid rgba(99,102,241,.2);border-radius:12px;padding:10px 14px;margin-bottom:12px; }
            #p2p-root .p2p-iv { font-size:20px;font-weight:900;letter-spacing:5px;color:#6366f1;font-family:'Courier New',monospace;text-shadow:0 0 15px rgba(99,102,241,.3); }
        `;
        document.head.appendChild(el);
    }

    // Panel component
    function Panel({ onClose }) {
        const panelRef = useDrag();

        const getScreen = () => {
            if (!session.active && !session.peer) return "home";
            if (session.amHost && !session.inSession) return "host-wait";
            return "session";
        };

        const [, setTick] = useState(0);
        const [username, setUsername] = useState(getUsername());
        const [paste, setPaste] = useState("");
        const [error, setError] = useState("");
        const [loading, setLoading] = useState(false);
        const [track, setTrack] = useState("");

        const screen = getScreen();
        const e = React.createElement;

        useEffect(() => {
            uiCallback = () => setTick(t => t + 1);
            return () => { uiCallback = null; };
        }, []);

        useEffect(() => {
            const t = setInterval(() => {
                const d = Spicetify.Player.data;
                if (d?.item?.name) setTrack(d.item.name);
            }, 1000);
            return () => clearInterval(t);
        }, []);

        function onName(ev) { setUsername(ev.target.value); saveUsername(ev.target.value); }
        function av() { return (username || "?")[0].toUpperCase(); }
        function copy(t) { navigator.clipboard.writeText(t); Spicetify.showNotification("ðŸ“‹ Copied!"); }

        async function create() {
            setError(""); setLoading(true);
            session.amHost = true;
            session.myName = username;
            const roomId = generateRoomId();
            session.code = roomId;
            createPeer(roomId);
            
            setTimeout(() => {
                setLoading(false);
                setTick(t => t + 1);
            }, 1000);
        }

        async function join() {
            const code = paste.trim();
            if (code.length < 4) { setError("Enter a valid ID."); return; }
            setError(""); setLoading(true);
            session.amHost = false;
            session.myName = username;
            createPeer();
            
            setTimeout(() => {
                connectToPeer(code);
                setLoading(false);
                setTick(t => t + 1);
            }, 1000);
        }

        function leave() {
            broadcastMessage({ type: 'left', user: session.myName });
            cleanup();
            setPaste(""); setError(""); setLoading(false);
        }

        function cmd(action) {
            if (!canControlPlayback() && !session.amHost) {
                showOwnerOnlyNotification();
                return;
            }
            if (session.amHost || canControlPlayback()) {
                try {
                    if (action === "play")  Spicetify.Player.play();
                    if (action === "pause") Spicetify.Player.pause();
                    if (action === "next")  Spicetify.Player.next();
                    if (action === "prev")  Spicetify.Player.back();
                } catch(e) {}
            } else {
                broadcastMessage({ type: action, fromHost: false });
            }
        }

        function Hdr({ dot = false }) {
            return e("div", { className: "p2p-hd" },
                e("div", { className: "p2p-hl" },
                    e("div", { className: `p2p-dot ${dot ? "" : "off"}` }),
                    e("span", { className: "p2p-ttl" }, "P2P Sync")
                ),
                e("button", { className: "p2p-x", onClick: onClose }, "Ã—")
            );
        }

        if (screen === "home") return e("div", { className: "p2p-panel", ref: panelRef },
            e(Hdr, {}),
            e("div", { className: "p2p-bd" },
                e("div", { className: "p2p-nr" },
                    e("div", { className: "p2p-av" }, av()),
                    e("input", { className: "p2p-ni", value: username, placeholder: "Your name", onChange: onName })
                ),
                e("div", { className: "p2p-st" },
                    e("button", {
                        className: `p2p-btn p2p-g ${loading ? "p2p-dim" : ""}`,
                        onClick: create
                    }, loading ? e(React.Fragment, null, e("span", { className: "p2p-sp" }), "Setting upâ€¦") : "Create session")
                ),
                e("hr", { className: "p2p-dv" }),
                e("div", { className: "p2p-lb" }, "Join a session"),
                e("input", {
                    className: "p2p-ci",
                    placeholder: "Enter ID",
                    value: paste,
                    onChange: ev => { setPaste(ev.target.value.toUpperCase()); setError(""); }
                }),
                error && e("div", { className: "p2p-er" }, error),
                e("button", {
                    className: `p2p-btn p2p-gh ${(!paste.trim() || loading) ? "p2p-dim" : ""}`,
                    onClick: join
                }, loading ? e(React.Fragment, null, e("span", { className: "p2p-sp" }), "Connectingâ€¦") : "Join session")
            )
        );

        if (screen === "host-wait") return e("div", { className: "p2p-panel", ref: panelRef },
            e(Hdr, {}),
            e("div", { className: "p2p-bd" },
                e("div", { style: { fontSize: 13, color: "#888", marginBottom: 10 } },
                    "Share this ID with your friend."
                ),
                e("div", { className: "p2p-lb" }, "Room ID"),
                e("div", { className: "p2p-cb" },
                    e("span", { className: "p2p-cv" }, session.code || "Loading..."),
                    session.code && e("button", { className: "p2p-cp", onClick: () => copy(session.code) }, "Copy")
                ),
                session.members.length > 0
                ? e("div", { className: "p2p-st", style: { marginTop: 4 } },
                    e("button", { className: "p2p-btn p2p-g", onClick: () => { session.inSession = true; setTick(t => t + 1); } }, "Go to session â†’"),
                    e("button", { className: "p2p-btn p2p-gh", onClick: leave }, "Cancel")
                  )
                : e(React.Fragment, null,
                    e("div", { style: { fontSize: 12, color: "#555", marginTop: 10 } }, e("span", { className: "p2p-sp" }), "Waiting for friendâ€¦"),
                    e("button", { className: "p2p-btn p2p-gh", style: { marginTop: 4 }, onClick: leave }, "Cancel")
                  )
            )
        );

        if (screen === "session") return e("div", { className: "p2p-panel", ref: panelRef },
            e(Hdr, { dot: true }),
            e("div", { className: "p2p-bd" },
                track && e("div", { className: "p2p-np" },
                    e("div", { className: "p2p-npd" }),
                    e("div", { className: "p2p-npt" }, track)
                ),
                e("div", { className: "p2p-ic" },
                    e("span", { className: "p2p-iv" }, session.code),
                    e("button", { className: "p2p-cp", onClick: () => copy(session.code) }, "Copy")
                ),
                session.amHost && e("div", { style: { marginBottom: 10 } },
                    e("button", {
                        className: `p2p-btn ${session.ownerOnlyMode ? "p2p-lv" : "p2p-gh"}`,
                        style: { fontSize: 11, padding: "8px 12px" },
                        onClick: toggleOwnerOnlyMode
                    }, session.ownerOnlyMode ? "ðŸ”’ Owner Only Mode" : "ðŸ”“ Owner Only Mode")
                ),
                session.members.length > 0 && e("div", { className: "p2p-ml" },
                    session.members.map(m => {
                        const isMe = m.peerId === session.myPeerId;
                        return e("div", { key: m.peerId, className: "p2p-mr" },
                            e("div", { className: "p2p-md" }), m.name || "Guest",
                            isMe && e("span", { style: { marginLeft: "auto", fontSize: 10, color: "#1ed760" } }, session.amHost ? "host" : "you")
                        );
                    })
                ),
                e("div", { className: "p2p-st" },
                    e("button", { 
                        className: "p2p-btn p2p-gh", 
                        style: { marginBottom: 8, fontSize: 11, padding: "8px 12px" },
                        onClick: manualSync 
                    }, "ðŸ”„ Manual Sync"),
                    e("div", { style: { display: "flex", gap: 6 } },
                        [["â®","prev"],["â¸","pause"],["â–¶","play"],["â­","next"]].map(([icon, action]) =>
                            e("button", {
                                key: action,
                                style: { flex: 1, padding: "9px 0", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 8, color: "#888", cursor: "pointer", fontSize: 15 },
                                onClick: () => cmd(action)
                            }, icon)
                        )
                    ),
                    e("button", { className: "p2p-btn p2p-lv", onClick: leave }, "Leave session")
                )
            )
        );

        return null;
    }

    // Bar component (shown when panel is closed but session is active)
    function Bar({ onClick }) {
        const e = React.createElement;
        const trackName = Spicetify.Player.data?.item?.name || "";
        return e("div", { className: "p2p-bar", onClick },
            e("div", { className: "p2p-bd2" }),
            trackName ? `ðŸŽµ ${trackName.slice(0, 28)}${trackName.length > 28 ? "â€¦" : ""}` : "Session active"
        );
    }

    let container = null;
    let isOpen = false;

    function renderUI() {
        if (!container) {
            container = document.createElement("div");
            container.id = "p2p-root";
            document.body.appendChild(container);
        }
        if (isOpen) {
            ReactDOM.render(React.createElement(Panel, { onClose: () => { isOpen = false; renderUI(); } }), container);
        } else if (session.active || session.peer) {
            ReactDOM.render(React.createElement(Bar, { onClick: () => { isOpen = true; renderUI(); } }), container);
        } else {
            ReactDOM.unmountComponentAtNode(container);
        }
    }

    function openPanel() {
        isOpen = !isOpen;
        renderUI();
    }

    // Initialize
    setupPlayerListeners();
    new Spicetify.Topbar.Button("VibeTogether",
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`,
        openPanel,
        false
    );

    log("âœ… VibeTogether loaded (PeerJS + CoListen UI)");
}
