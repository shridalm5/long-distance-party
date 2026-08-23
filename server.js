const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from project root
app.use(express.static(__dirname));

// In-memory room store
const rooms = new Map();

// ── Safety Limits ──
const MAX_ROOMS = 50;
const MAX_MEMBERS_PER_ROOM = 10;
const RATE_LIMIT_WINDOW = 1000; // 1 second
const rateLimitMap = new Map();

function isRateLimited(socketId) {
  const now = Date.now();
  const last = rateLimitMap.get(socketId) || 0;
  if (now - last < RATE_LIMIT_WINDOW) return true;
  rateLimitMap.set(socketId, now);
  return false;
}

// Clean up stale rate limit entries every 30s
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW * 10;
  for (const [id, ts] of rateLimitMap) {
    if (ts < cutoff) rateLimitMap.delete(id);
  }
}, 30000);

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create a new room
  socket.on("create-room", (username) => {
    if (isRateLimited(socket.id)) return;
    if (typeof username !== "string" || username.trim().length === 0 || username.length > 20) {
      socket.emit("error-message", "Invalid username.");
      return;
    }
    if (rooms.size >= MAX_ROOMS) {
      socket.emit("error-message", "Server is full. Try again later.");
      return;
    }

    const safeName = username.trim().slice(0, 20);
    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      hostId: socket.id,
      members: [{ id: socket.id, username: safeName, isHost: true }],
      playbackState: { playing: false, currentTime: 0, lastUpdate: Date.now() },
    };
    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = safeName;

    socket.emit("room-created", { roomCode, isHost: true, members: room.members });
    console.log(`Room ${roomCode} created by ${safeName}`);
  });

  // Rejoin after refresh — restore previous session
  socket.on("rejoin-room", ({ roomCode, username, wasHost }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit("error-message", "Room no longer exists.");
      socket.emit("session-expired");
      return;
    }

    // If they were the host and nobody else has claimed it, restore host
    const shouldBeHost = wasHost && room.hostId === room.members.find((m) => m.isHost)?.id;
    const restoreHost = wasHost && !room.members.some((m) => m.isHost && m.id !== socket.id);

    if (restoreHost) {
      room.hostId = socket.id;
    }

    const memberEntry = { id: socket.id, username, isHost: restoreHost };
    room.members.push(memberEntry);
    socket.join(code);
    socket.roomCode = code;
    socket.username = username;

    socket.emit("room-joined", {
      roomCode: code,
      isHost: restoreHost,
      members: room.members,
      playbackState: room.playbackState,
      rejoined: true,
    });

    io.to(code).emit("member-update", room.members);
    io.to(code).emit("chat-message", {
      username: "System",
      message: `${username} reconnected 🔄`,
      isSystem: true,
    });

    console.log(`${username} rejoined room ${code}${restoreHost ? " (host restored)" : ""}`);
  });

  // Join an existing room
  socket.on("join-room", ({ roomCode, username }) => {
    if (isRateLimited(socket.id)) return;
    if (typeof username !== "string" || username.trim().length === 0 || username.length > 20) {
      socket.emit("error-message", "Invalid username.");
      return;
    }

    const code = roomCode.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit("error-message", "Room not found. Check the code and try again.");
      return;
    }

    if (room.members.length >= MAX_MEMBERS_PER_ROOM) {
      socket.emit("error-message", "Room is full (max 10 members).");
      return;
    }

    const safeName = username.trim().slice(0, 20);
    room.members.push({ id: socket.id, username: safeName, isHost: false });
    socket.join(code);
    socket.roomCode = code;
    socket.username = safeName;

    socket.emit("room-joined", {
      roomCode: code,
      isHost: false,
      members: room.members,
      playbackState: room.playbackState,
    });

    io.to(code).emit("member-update", room.members);
    io.to(code).emit("chat-message", {
      username: "System",
      message: `${safeName} joined the party! 🎉`,
      isSystem: true,
    });

    console.log(`${safeName} joined room ${code}`);
  });

  // Sync events: any member can control playback
  socket.on("sync-play", (currentTime) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.playbackState = { playing: true, currentTime, lastUpdate: Date.now() };
    socket.to(socket.roomCode).emit("sync-play", currentTime);
  });

  socket.on("sync-pause", (currentTime) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.playbackState = { playing: false, currentTime, lastUpdate: Date.now() };
    socket.to(socket.roomCode).emit("sync-pause", currentTime);
  });

  socket.on("sync-seek", (currentTime) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.playbackState = { ...room.playbackState, currentTime, lastUpdate: Date.now() };
    socket.to(socket.roomCode).emit("sync-seek", currentTime);
  });

  // Heartbeat: the user who last triggered play sends periodic time updates
  socket.on("sync-heartbeat", (currentTime) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.playbackState.currentTime = currentTime;
    room.playbackState.lastUpdate = Date.now();
    socket.to(socket.roomCode).emit("sync-heartbeat", currentTime);
  });

  // Chat
  socket.on("chat-message", (message) => {
    if (!socket.roomCode) return;
    if (isRateLimited(socket.id)) return;
    if (typeof message !== "string" || message.trim().length === 0) return;

    const safeMessage = message.trim().slice(0, 200);
    io.to(socket.roomCode).emit("chat-message", {
      username: socket.username,
      message: safeMessage,
      isSystem: false,
    });
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (!socket.roomCode) return;

    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.members = room.members.filter((m) => m.id !== socket.id);

    if (room.members.length === 0) {
      rooms.delete(socket.roomCode);
      console.log(`Room ${socket.roomCode} deleted (empty)`);
      return;
    }

    // If host left, assign new host
    if (room.hostId === socket.id) {
      room.hostId = room.members[0].id;
      room.members[0].isHost = true;
      io.to(socket.roomCode).emit("new-host", room.members[0].id);
      io.to(socket.roomCode).emit("chat-message", {
        username: "System",
        message: `${room.members[0].username} is now the host 👑`,
        isSystem: true,
      });
    }

    io.to(socket.roomCode).emit("member-update", room.members);
    io.to(socket.roomCode).emit("chat-message", {
      username: "System",
      message: `${socket.username} left the party.`,
      isSystem: true,
    });

    console.log(`${socket.username} left room ${socket.roomCode}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 Long Distance Party running at http://localhost:${PORT}`);
});
