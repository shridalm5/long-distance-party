const socket = io();

// DOM elements
const landingScreen = document.getElementById("landing-screen");
const roomScreen = document.getElementById("room-screen");
const usernameInput = document.getElementById("username");
const roomCodeInput = document.getElementById("room-code-input");
const btnCreate = document.getElementById("btn-create");
const btnJoin = document.getElementById("btn-join");
const errorMessage = document.getElementById("error-message");
const displayRoomCode = document.getElementById("display-room-code");
const btnCopyCode = document.getElementById("btn-copy-code");
const hostBadge = document.getElementById("host-badge");
const guestBadge = document.getElementById("guest-badge");
const videoPlayer = document.getElementById("video-player");
const videoPlaceholder = document.getElementById("video-placeholder");
const videoFileInput = document.getElementById("video-file");
const syncStatus = document.getElementById("sync-status");
const membersList = document.getElementById("members-list");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const btnSendChat = document.getElementById("btn-send-chat");

let isHost = false;
let ignoreEvents = false; // prevent echo loops
const SYNC_THRESHOLD = 0.5; // seconds of allowed drift
const HEARTBEAT_INTERVAL = 3000; // ms

// ── Session Persistence ──

function saveSession(roomCode, username, isHost) {
  sessionStorage.setItem("ldp_session", JSON.stringify({ roomCode, username, isHost }));
}

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem("ldp_session"));
  } catch {
    return null;
  }
}

function clearSession() {
  sessionStorage.removeItem("ldp_session");
}

// Auto-rejoin on page load
const savedSession = loadSession();
if (savedSession) {
  socket.emit("rejoin-room", {
    roomCode: savedSession.roomCode,
    username: savedSession.username,
    wasHost: savedSession.isHost,
  });
}

// ── Screen Navigation ──

function showRoom() {
  landingScreen.classList.remove("active");
  roomScreen.classList.add("active");
}

function showError(msg) {
  errorMessage.textContent = msg;
  setTimeout(() => (errorMessage.textContent = ""), 4000);
}

// ── Landing Actions ──

btnCreate.addEventListener("click", () => {
  const name = usernameInput.value.trim();
  if (!name) return showError("Please enter your name.");
  socket.emit("create-room", name);
});

btnJoin.addEventListener("click", () => {
  const name = usernameInput.value.trim();
  const code = roomCodeInput.value.trim();
  if (!name) return showError("Please enter your name.");
  if (!code) return showError("Please enter a room code.");
  socket.emit("join-room", { roomCode: code, username: name });
});

// Allow Enter key on inputs
usernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnCreate.click();
});
roomCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnJoin.click();
});

// ── Room Events ──

socket.on("room-created", (data) => {
  isHost = data.isHost;
  displayRoomCode.textContent = data.roomCode;
  hostBadge.classList.remove("hidden");
  updateMembers(data.members);
  saveSession(data.roomCode, usernameInput.value.trim(), true);
  showRoom();
  startHeartbeat();
});

socket.on("room-joined", (data) => {
  isHost = data.isHost;
  displayRoomCode.textContent = data.roomCode;
  if (data.isHost) {
    hostBadge.classList.remove("hidden");
    guestBadge.classList.add("hidden");
    startHeartbeat();
  } else {
    guestBadge.classList.remove("hidden");
    hostBadge.classList.add("hidden");
  }
  updateMembers(data.members);
  const session = loadSession();
  saveSession(data.roomCode, session?.username || usernameInput.value.trim(), data.isHost);
  showRoom();

  // If rejoining, show a prompt to reload their video
  if (data.rejoined) {
    updateSyncStatus("synced", "Reconnected! Please reload your video file.");
  }
});

socket.on("error-message", (msg) => showError(msg));

socket.on("session-expired", () => {
  clearSession();
});

socket.on("new-host", (newHostId) => {
  if (socket.id === newHostId) {
    isHost = true;
    hostBadge.classList.remove("hidden");
    guestBadge.classList.add("hidden");
    const session = loadSession();
    if (session) saveSession(session.roomCode, session.username, true);
    startHeartbeat();
  }
});

// ── Copy Room Code ──

btnCopyCode.addEventListener("click", () => {
  const code = displayRoomCode.textContent;
  navigator.clipboard.writeText(code).then(() => {
    btnCopyCode.textContent = "✅ Copied!";
    setTimeout(() => (btnCopyCode.textContent = "📋 Copy"), 2000);
  });
});

// ── Members ──

socket.on("member-update", updateMembers);

function updateMembers(members) {
  membersList.innerHTML = "";
  members.forEach((m) => {
    const li = document.createElement("li");
    li.className = m.isHost ? "member-host" : "member-guest";
    li.textContent = m.username + (m.id === socket.id ? " (You)" : "");
    membersList.appendChild(li);
  });
}

// ── Video Loading ──

videoFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  videoPlayer.src = url;
  videoPlayer.classList.add("loaded");
  videoPlaceholder.classList.add("hidden");

  updateSyncStatus("synced", "Video loaded — ready to play");
});

// ── Sync: Host → Server ──

videoPlayer.addEventListener("play", () => {
  if (ignoreEvents) return;
  if (isHost) {
    socket.emit("sync-play", videoPlayer.currentTime);
    updateSyncStatus("playing", "Playing — syncing to party");
  }
});

videoPlayer.addEventListener("pause", () => {
  if (ignoreEvents) return;
  if (isHost) {
    socket.emit("sync-pause", videoPlayer.currentTime);
    updateSyncStatus("synced", "Paused");
  }
});

videoPlayer.addEventListener("seeked", () => {
  if (ignoreEvents) return;
  if (isHost) {
    socket.emit("sync-seek", videoPlayer.currentTime);
  }
});

// ── Sync: Server → Guest ──

socket.on("sync-play", (time) => {
  if (isHost) return;
  ignoreEvents = true;
  videoPlayer.currentTime = time;
  videoPlayer.play().finally(() => (ignoreEvents = false));
  updateSyncStatus("playing", "Playing — synced to host");
});

socket.on("sync-pause", (time) => {
  if (isHost) return;
  ignoreEvents = true;
  videoPlayer.pause();
  videoPlayer.currentTime = time;
  ignoreEvents = false;
  updateSyncStatus("synced", "Paused — synced to host");
});

socket.on("sync-seek", (time) => {
  if (isHost) return;
  ignoreEvents = true;
  videoPlayer.currentTime = time;
  ignoreEvents = false;
});

socket.on("sync-heartbeat", (hostTime) => {
  if (isHost) return;
  if (!videoPlayer.src) return;

  const drift = Math.abs(videoPlayer.currentTime - hostTime);
  if (drift > SYNC_THRESHOLD) {
    ignoreEvents = true;
    videoPlayer.currentTime = hostTime;
    ignoreEvents = false;
  }
});

// ── Heartbeat (host sends current time periodically) ──

function startHeartbeat() {
  setInterval(() => {
    if (isHost && !videoPlayer.paused && videoPlayer.src) {
      socket.emit("sync-heartbeat", videoPlayer.currentTime);
    }
  }, HEARTBEAT_INTERVAL);
}

// ── Sync Status UI ──

function updateSyncStatus(state, text) {
  syncStatus.className = "sync-status " + state;
  syncStatus.innerHTML = `<span class="sync-dot"></span> ${text}`;
}

// ── Chat ──

socket.on("chat-message", (data) => {
  const div = document.createElement("div");
  div.className = "chat-msg" + (data.isSystem ? " system" : "");

  if (data.isSystem) {
    div.textContent = data.message;
  } else {
    div.innerHTML = `<span class="chat-user">${escapeHtml(data.username)}:</span> ${escapeHtml(data.message)}`;
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

btnSendChat.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit("chat-message", msg);
  chatInput.value = "";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
