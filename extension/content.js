/**
 * Long Distance Party — Content Script
 * Injected into streaming sites to sync video playback via WebSocket.
 */

(() => {
  // ── Config ──
  const SERVER_URL = window.__LDP_SERVER_URL__ || "http://localhost:3000";
  const SYNC_THRESHOLD = 0.5;
  const HEARTBEAT_INTERVAL = 3000;
  const VIDEO_POLL_INTERVAL = 2000;
  const OVERLAY_ID = "ldp-overlay";

  let socket = null;
  let isHost = false;
  let pendingAction = null;
  let ignoreEvents = false;
  let heartbeatTimer = null;
  let videoPollTimer = null;
  let videoElement = null;
  let roomCode = null;
  let username = null;

  // ── Detect Platform ──

  function detectPlatform() {
    const host = window.location.hostname;
    if (host.includes("primevideo.com") || host.includes("amazon.com")) return "Prime Video";
    if (host.includes("netflix.com")) return "Netflix";
    if (host.includes("youtube.com")) return "YouTube";
    if (host.includes("disneyplus.com")) return "Disney+";
    if (host.includes("hotstar.com")) return "Hotstar";
    return "Unknown";
  }

  // ── Find Video Element ──

  function findVideo() {
    // Try to find the main video element on the page
    const videos = document.querySelectorAll("video");
    if (videos.length === 0) return null;

    // Pick the largest visible video (the main player, not ads/thumbnails)
    let best = null;
    let bestArea = 0;
    videos.forEach((v) => {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea && rect.width > 200) {
        best = v;
        bestArea = area;
      }
    });
    return best;
  }

  function startVideoPolling() {
    if (videoPollTimer) clearInterval(videoPollTimer);
    videoPollTimer = setInterval(() => {
      const v = findVideo();
      if (v && v !== videoElement) {
        videoElement = v;
        attachVideoListeners();
        updateOverlayStatus("synced", "Video detected — ready");
      }
    }, VIDEO_POLL_INTERVAL);
  }

  // ── Video Event Listeners ──

  function attachVideoListeners() {
    if (!videoElement) return;

    videoElement.addEventListener("play", onPlay);
    videoElement.addEventListener("pause", onPause);
    videoElement.addEventListener("seeked", onSeeked);
  }

  function onPlay() {
    if (ignoreEvents || !socket || !isHost) return;
    socket.emit("sync-play", videoElement.currentTime);
    updateOverlayStatus("playing", "Playing — syncing to party");
  }

  function onPause() {
    if (ignoreEvents || !socket || !isHost) return;
    socket.emit("sync-pause", videoElement.currentTime);
    updateOverlayStatus("synced", "Paused");
  }

  function onSeeked() {
    if (ignoreEvents || !socket || !isHost) return;
    socket.emit("sync-seek", videoElement.currentTime);
  }

  // ── Socket Connection ──

  function connectSocket() {
    if (socket) socket.disconnect();

    socket = new LDPSocket(SERVER_URL);
    socket.connect();

    socket.on("connect", () => {
      console.log("[LDP] Connected to server");
      updateOverlayStatus("synced", "Connected to server");

      // If we have pending actions, execute them
      if (pendingAction) {
        pendingAction();
        pendingAction = null;
      }
    });

    socket.on("disconnect", () => {
      updateOverlayStatus("", "Disconnected from server");
    });

    // Room events
    socket.on("room-created", (data) => {
      isHost = true;
      roomCode = data.roomCode;
      updateOverlayRoom(data.roomCode, true);
      updateOverlayMembers(data.members);
      startHeartbeat();
      saveExtSession();
    });

    socket.on("room-joined", (data) => {
      isHost = data.isHost;
      roomCode = data.roomCode;
      updateOverlayRoom(data.roomCode, data.isHost);
      updateOverlayMembers(data.members);
      if (data.isHost) startHeartbeat();
      saveExtSession();
    });

    socket.on("error-message", (msg) => {
      updateOverlayStatus("", "Error: " + msg);
    });

    socket.on("session-expired", () => {
      clearExtSession();
    });

    socket.on("member-update", (members) => {
      updateOverlayMembers(members);
    });

    socket.on("new-host", (newHostId) => {
      if (socket.id === newHostId) {
        isHost = true;
        updateOverlayRoom(roomCode, true);
        startHeartbeat();
      } else {
        isHost = false;
        updateOverlayRoom(roomCode, false);
      }
      saveExtSession();
    });

    // Sync events (for guests)
    socket.on("sync-play", (time) => {
      if (isHost || !videoElement) return;
      ignoreEvents = true;
      videoElement.currentTime = time;
      videoElement.play().finally(() => (ignoreEvents = false));
      updateOverlayStatus("playing", "Playing — synced to host");
    });

    socket.on("sync-pause", (time) => {
      if (isHost || !videoElement) return;
      ignoreEvents = true;
      videoElement.pause();
      videoElement.currentTime = time;
      ignoreEvents = false;
      updateOverlayStatus("synced", "Paused — synced to host");
    });

    socket.on("sync-seek", (time) => {
      if (isHost || !videoElement) return;
      ignoreEvents = true;
      videoElement.currentTime = time;
      ignoreEvents = false;
    });

    socket.on("sync-heartbeat", (hostTime) => {
      if (isHost || !videoElement) return;
      const drift = Math.abs(videoElement.currentTime - hostTime);
      if (drift > SYNC_THRESHOLD) {
        ignoreEvents = true;
        videoElement.currentTime = hostTime;
        ignoreEvents = false;
      }
    });

    socket.on("force-sync", ({ currentTime, playing }) => {
      if (isHost || !videoElement) return;
      ignoreEvents = true;
      videoElement.currentTime = currentTime;
      if (playing) {
        videoElement.play().finally(() => (ignoreEvents = false));
        updateOverlayStatus("playing", "Resynced to host");
      } else {
        videoElement.pause();
        ignoreEvents = false;
        updateOverlayStatus("synced", "Resynced to host (paused)");
      }
    });

    socket.on("chat-message", (data) => {
      appendChatMessage(data);
    });
  }

  // ── Heartbeat ──

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (isHost && videoElement && !videoElement.paused) {
        socket.emit("sync-heartbeat", videoElement.currentTime);
      }
    }, HEARTBEAT_INTERVAL);
  }

  // ── Session Persistence ──

  function saveExtSession() {
    if (roomCode && username) {
      localStorage.setItem("ldp_ext_session", JSON.stringify({ roomCode, username, isHost }));
    }
  }

  function loadExtSession() {
    try {
      return JSON.parse(localStorage.getItem("ldp_ext_session"));
    } catch {
      return null;
    }
  }

  function clearExtSession() {
    localStorage.removeItem("ldp_ext_session");
  }

  // ── Overlay UI ──

  function createOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;

    const platform = detectPlatform();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div class="ldp-header">
        <span class="ldp-title">🎬 LDP</span>
        <span class="ldp-platform">${platform}</span>
        <button class="ldp-toggle" title="Minimize">−</button>
      </div>
      <div class="ldp-body">
        <div class="ldp-section ldp-login" id="ldp-login">
          <input type="text" id="ldp-username" placeholder="Your name" maxlength="20" />
          <div class="ldp-btn-row">
            <button id="ldp-create" class="ldp-btn ldp-btn-primary">Create Room</button>
            <input type="text" id="ldp-room-code" placeholder="Code" maxlength="6" />
            <button id="ldp-join" class="ldp-btn">Join</button>
          </div>
        </div>
        <div class="ldp-section ldp-room hidden" id="ldp-room">
          <div class="ldp-room-info">
            <span>Room: <strong id="ldp-display-code"></strong></span>
            <span id="ldp-host-label" class="ldp-badge"></span>
          </div>
          <div class="ldp-btn-row">
            <button id="ldp-claim-host" class="ldp-btn ldp-btn-small hidden">👑 Claim Host</button>
            <button id="ldp-resync" class="ldp-btn ldp-btn-small">🔄 Resync</button>
            <button id="ldp-leave" class="ldp-btn ldp-btn-small ldp-btn-danger">Leave</button>
          </div>
          <div id="ldp-members" class="ldp-members"></div>
          <div id="ldp-status" class="ldp-status">Waiting...</div>
          <div id="ldp-chat" class="ldp-chat"></div>
          <div class="ldp-chat-input">
            <input type="text" id="ldp-chat-msg" placeholder="Chat..." maxlength="200" />
            <button id="ldp-chat-send" class="ldp-btn ldp-btn-small">Send</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    bindOverlayEvents();
  }

  function bindOverlayEvents() {
    // Toggle minimize
    document.querySelector(".ldp-toggle").addEventListener("click", () => {
      const body = document.querySelector(".ldp-body");
      const btn = document.querySelector(".ldp-toggle");
      body.classList.toggle("hidden");
      btn.textContent = body.classList.contains("hidden") ? "+" : "−";
    });

    // Create room
    document.getElementById("ldp-create").addEventListener("click", () => {
      username = document.getElementById("ldp-username").value.trim();
      if (!username) return;
      pendingAction = () => socket.emit("create-room", username);
      connectSocket();
    });

    // Join room
    document.getElementById("ldp-join").addEventListener("click", () => {
      username = document.getElementById("ldp-username").value.trim();
      const code = document.getElementById("ldp-room-code").value.trim();
      if (!username || !code) return;
      pendingAction = () => socket.emit("join-room", { roomCode: code, username });
      connectSocket();
    });

    // Claim host
    document.getElementById("ldp-claim-host").addEventListener("click", () => {
      if (socket) socket.emit("claim-host");
    });

    // Resync
    document.getElementById("ldp-resync").addEventListener("click", () => {
      if (!socket || !videoElement) return;
      if (isHost) {
        socket.emit("force-sync", {
          currentTime: videoElement.currentTime,
          playing: !videoElement.paused,
        });
        updateOverlayStatus("synced", "Resync sent");
      } else {
        socket.emit("request-resync");
        updateOverlayStatus("synced", "Resync requested");
      }
    });

    // Leave
    document.getElementById("ldp-leave").addEventListener("click", () => {
      if (socket) socket.disconnect();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      clearExtSession();
      isHost = false;
      roomCode = null;
      document.getElementById("ldp-login").classList.remove("hidden");
      document.getElementById("ldp-room").classList.add("hidden");
    });

    // Chat send
    document.getElementById("ldp-chat-send").addEventListener("click", sendChatFromOverlay);
    document.getElementById("ldp-chat-msg").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChatFromOverlay();
    });
  }

  function sendChatFromOverlay() {
    const input = document.getElementById("ldp-chat-msg");
    const msg = input.value.trim();
    if (!msg || !socket) return;
    socket.emit("chat-message", msg);
    input.value = "";
  }

  function updateOverlayRoom(code, host) {
    document.getElementById("ldp-login").classList.add("hidden");
    document.getElementById("ldp-room").classList.remove("hidden");
    document.getElementById("ldp-display-code").textContent = code;
    document.getElementById("ldp-host-label").textContent = host ? "👑 Host" : "🎉 Guest";

    const claimBtn = document.getElementById("ldp-claim-host");
    if (host) {
      claimBtn.classList.add("hidden");
    } else {
      claimBtn.classList.remove("hidden");
    }
  }

  function updateOverlayStatus(state, text) {
    const el = document.getElementById("ldp-status");
    if (el) el.textContent = text;
  }

  function updateOverlayMembers(members) {
    const el = document.getElementById("ldp-members");
    if (!el) return;
    el.innerHTML = members
      .map((m) => {
        const tag = m.isHost ? "👑" : "🟢";
        const you = socket && m.id === socket.id ? " (You)" : "";
        return `<span class="ldp-member">${tag} ${m.username}${you}</span>`;
      })
      .join("");
  }

  function appendChatMessage(data) {
    const chat = document.getElementById("ldp-chat");
    if (!chat) return;
    const div = document.createElement("div");
    div.className = "ldp-chat-msg" + (data.isSystem ? " ldp-system" : "");
    if (data.isSystem) {
      div.textContent = data.message;
    } else {
      div.textContent = `${data.username}: ${data.message}`;
    }
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  // ── Init ──

  function init() {
    createOverlay();
    startVideoPolling();

    // Auto-rejoin if session exists
    const saved = loadExtSession();
    if (saved) {
      username = saved.username;
      pendingAction = () => {
        socket.emit("rejoin-room", {
          roomCode: saved.roomCode,
          username: saved.username,
          wasHost: saved.isHost,
        });
      };
      connectSocket();
    }
  }

  // LDPSocket is loaded as a content script — just init directly
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }
})();
