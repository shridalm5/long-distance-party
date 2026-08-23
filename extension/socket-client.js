/**
 * Minimal Socket.IO v4 client using native WebSocket.
 * Avoids needing to load the socket.io library (which CSP blocks).
 */

class LDPSocket {
  constructor(serverUrl) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
    this.ws = null;
    this.id = null;
    this.listeners = {};
    this.connected = false;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.pingInterval = 25000;
    this.pingTimeout = 20000;
  }

  connect() {
    const wsUrl = this.serverUrl.replace(/^http/, "ws") + "/socket.io/?EIO=4&transport=websocket";
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      // Wait for Engine.IO open packet
    };

    this.ws.onmessage = (event) => {
      this._handleMessage(event.data);
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._clearTimers();
      this._emit("disconnect");
      // Auto reconnect after 2s
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  _handleMessage(data) {
    if (typeof data !== "string") return;

    // Engine.IO packet types: 0=open, 2=ping, 3=pong, 4=message
    const eioType = data[0];

    if (eioType === "0") {
      // Engine.IO open — parse session info
      try {
        const info = JSON.parse(data.substring(1));
        this.pingInterval = info.pingInterval || 25000;
        this.pingTimeout = info.pingTimeout || 20000;
      } catch (e) {}
      // Send Socket.IO connect packet (namespace /)
      this.ws.send("40");
      this._startPing();
      return;
    }

    if (eioType === "2") {
      // Engine.IO ping → respond with pong
      this.ws.send("3");
      return;
    }

    if (eioType === "3") {
      // Engine.IO pong — ignore
      return;
    }

    if (eioType === "4") {
      // Socket.IO packet
      const sioType = data[1];
      const payload = data.substring(2);

      if (sioType === "0") {
        // Socket.IO connect acknowledgement
        try {
          const info = JSON.parse(payload);
          this.id = info.sid;
        } catch (e) {}
        this.connected = true;
        this._emit("connect");
        return;
      }

      if (sioType === "2") {
        // Socket.IO event
        try {
          const arr = JSON.parse(payload);
          if (Array.isArray(arr) && arr.length >= 1) {
            const eventName = arr[0];
            const eventData = arr[1];
            this._emit(eventName, eventData);
          }
        } catch (e) {}
        return;
      }
    }
  }

  emit(event, data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const packet = data !== undefined ? JSON.stringify([event, data]) : JSON.stringify([event]);
    this.ws.send("42" + packet);
  }

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  off(event) {
    delete this.listeners[event];
  }

  _emit(event, data) {
    const cbs = this.listeners[event];
    if (cbs) cbs.forEach((cb) => cb(data));
  }

  _startPing() {
    this._clearTimers();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send("2");
      }
    }, this.pingInterval);
  }

  _clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }

  disconnect() {
    this._clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.id = null;
  }
}
