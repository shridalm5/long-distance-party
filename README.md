# 🎬 Long Distance Party

Watch together, miles apart. A sync watch party app for local video files.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Open **http://localhost:3000** in your browser.

## How to Use

1. **Host** enters their name → clicks **Create Room** → gets a 6-character room code
2. **Friends** enter their name + the room code → click **Join**
3. Everyone loads the **same video file** from their local machine
4. **Host controls playback** — play, pause, seek are synced to all guests
5. Chat in real-time in the sidebar!

## Features

- ✅ Room creation with shareable codes
- ✅ Host-controlled video sync (play/pause/seek)
- ✅ Heartbeat-based drift correction (±0.5s tolerance)
- ✅ Auto host transfer if host disconnects
- ✅ Real-time chat
- ✅ Responsive design (mobile-friendly)
- ✅ Dark theme UI

## Tech Stack

| Layer    | Technology          |
|----------|---------------------|
| Frontend | HTML5 + CSS + Vanilla JS |
| Backend  | Node.js + Express   |
| Realtime | Socket.IO           |

## How Sync Works

```
Host plays video
  → WebSocket event sent to server
    → Server broadcasts to all guests
      → Guests adjust their local video player

Every 3 seconds:
  Host sends heartbeat with current timestamp
    → Guests correct drift if > 0.5s off
```

## Project Structure

```
├── server.js      # Express + Socket.IO server
├── index.html     # Main UI
├── style.css      # Dark theme styles
├── app.js         # Client-side sync logic
├── package.json   # Dependencies
└── README.md      # This file
```

## Future Roadmap

- [ ] Browser extension for Netflix/YouTube sync
- [ ] Video call integration
- [ ] Emoji reactions overlay
- [ ] Persistent rooms with passwords
