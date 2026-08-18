const { app, BrowserWindow } = require("electron");
const path = require("path");
const os = require("os");
const dgram = require("dgram");
const WebSocket = require("ws");

const WS_PORT_FALLBACK = 8765;
const DISCOVERY_PORT_START = 8766;
const DISCOVERY_PORT_END = 8786;
const DISCOVER_MESSAGE = "IMAGEBOARD_DISCOVER_V2";
const ADMIN_MESSAGE = "IMAGEBOARD_ADMIN_V2";
const DISCOVERY_TIMEOUT_MS = 1300;
const RECONNECT_DELAY_MS = 1200;

let win = null;
let socket = null;
let retryTimer = null;
let discoveryTimer = null;
let discoverySocket = null;
let discoveryInProgress = false;
let currentEndpoint = null;
let quitting = false;

function notifyConnection(value) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("viewer:connection", value);
  }
}

function createWindow() {
  win = new BrowserWindow({
    show: false,
    fullscreen: true,
    kiosk: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error("Viewer renderer failed to load:", code, description, url);
  });

  if (!app.isPackaged) {
    win.loadURL("http://127.0.0.1:5174");
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  win.once("ready-to-show", () => {
    win.show();
    win.setFullScreen(true);
    win.setKiosk(true);
    win.focus();
  });

  win.on("closed", () => {
    win = null;
  });
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleDiscovery(delay = RECONNECT_DELAY_MS) {
  if (quitting) {
    return;
  }

  clearRetryTimer();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    discover();
  }, delay);
}

function closeDiscoverySocket() {
  if (discoveryTimer) {
    clearTimeout(discoveryTimer);
    discoveryTimer = null;
  }

  if (discoverySocket) {
    try {
      discoverySocket.close();
    } catch {}
    discoverySocket = null;
  }

  discoveryInProgress = false;
}

function parseAdminResponse(message) {
  const text = message.toString().trim();
  const parts = text.split("|");

  if (parts[0] !== ADMIN_MESSAGE) {
    return null;
  }

  const port = Number(parts[1] || WS_PORT_FALLBACK);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return { port };
}

function connect(host, port) {
  if (quitting) {
    return;
  }

  const endpoint = `${host}:${port}`;

  if (
    currentEndpoint === endpoint &&
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  clearRetryTimer();
  closeDiscoverySocket();

  try {
    socket?.removeAllListeners();
    socket?.close();
  } catch {}

  currentEndpoint = endpoint;
  socket = new WebSocket(`ws://${host}:${port}`, {
    handshakeTimeout: 3500,
  });

  let metadata = null;

  socket.on("open", () => {
    notifyConnection(true);
  });

  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed?.type === "image") {
          metadata = parsed;
        }
      } catch {}
      return;
    }

    if (!metadata || !win || win.isDestroyed()) {
      return;
    }

    win.webContents.send("viewer:image", {
      buffer: Buffer.from(data),
      mime: metadata.mime || "image/jpeg",
      name: metadata.name || "image",
    });

    metadata = null;
  });

  socket.on("close", () => {
    socket = null;
    currentEndpoint = null;
    notifyConnection(false);
    scheduleDiscovery();
  });

  socket.on("error", () => {
    notifyConnection(false);
  });
}

function getDirectedBroadcastAddresses() {
  const addresses = new Set(["255.255.255.255"]);

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (
        entry.family !== "IPv4" ||
        entry.internal ||
        !entry.address ||
        !entry.netmask
      ) {
        continue;
      }

      const ipParts = entry.address.split(".").map(Number);
      const maskParts = entry.netmask.split(".").map(Number);

      if (ipParts.length !== 4 || maskParts.length !== 4) {
        continue;
      }

      const broadcast = ipParts.map(
        (value, index) => (value & maskParts[index]) | (~maskParts[index] & 255)
      );

      addresses.add(broadcast.join("."));
    }
  }

  return [...addresses];
}

function discover() {
  if (
    quitting ||
    discoveryInProgress ||
    (socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING))
  ) {
    return;
  }

  discoveryInProgress = true;
  const udp = dgram.createSocket("udp4");
  discoverySocket = udp;
  let found = false;

  udp.once("error", () => {
    if (udp !== discoverySocket) {
      return;
    }
    closeDiscoverySocket();
    scheduleDiscovery();
  });

  udp.on("message", (message, remote) => {
    if (found) {
      return;
    }

    const response = parseAdminResponse(message);
    if (!response) {
      return;
    }

    found = true;
    closeDiscoverySocket();
    connect(remote.address, response.port);
  });

  udp.bind(0, "0.0.0.0", () => {
    try {
      udp.setBroadcast(true);
    } catch {
      closeDiscoverySocket();
      scheduleDiscovery();
      return;
    }

    const payload = Buffer.from(DISCOVER_MESSAGE);
    const targets = getDirectedBroadcastAddresses();

    for (const target of targets) {
      for (
        let port = DISCOVERY_PORT_START;
        port <= DISCOVERY_PORT_END;
        port += 1
      ) {
        udp.send(payload, port, target, () => {});
      }
    }
  });

  discoveryTimer = setTimeout(() => {
    if (found || udp !== discoverySocket) {
      return;
    }

    closeDiscoverySocket();
    scheduleDiscovery();
  }, DISCOVERY_TIMEOUT_MS);
}

function shutdown() {
  clearRetryTimer();
  closeDiscoverySocket();

  try {
    socket?.removeAllListeners();
    socket?.close();
  } catch {}

  socket = null;
  currentEndpoint = null;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win || win.isDestroyed()) {
      return;
    }

    win.show();
    win.setFullScreen(true);
    win.setKiosk(true);
    win.focus();
  });

  app.whenReady().then(() => {
    createWindow();

    if (process.platform === "win32" && app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
      });
    }

    discover();
  });

  app.on("before-quit", () => {
    quitting = true;
    shutdown();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
