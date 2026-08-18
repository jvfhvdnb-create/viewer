const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const os = require("os");
const http = require("http");
const dgram = require("dgram");
const WebSocket = require("ws");

const WS_PORT_START = 8765;
const WS_PORT_END = 8785;
const DISCOVERY_PORT_START = 8766;
const DISCOVERY_PORT_END = 8786;
const DISCOVER_MESSAGE = "IMAGEBOARD_DISCOVER_V2";
const ADMIN_MESSAGE = "IMAGEBOARD_ADMIN_V2";

let mainWindow = null;
let httpServer = null;
let wss = null;
let discoverySocket = null;
let wsPort = null;
let discoveryPort = null;
let quitting = false;

const viewers = new Set();

function getLanAddress() {
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  return "127.0.0.1";
}

function notifyViewerStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("viewer:status", viewers.size > 0);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1250,
    height: 820,
    minWidth: 950,
    minHeight: 650,
    backgroundColor: "#080d18",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error("Admin renderer failed to load:", code, description, url);
  });

  if (!app.isPackaged) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createWebSocketServer() {
  httpServer = http.createServer((req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ImageBoard Admin");
  });

  wss = new WebSocket.Server({ server: httpServer });

  wss.on("connection", (ws) => {
    viewers.add(ws);
    notifyViewerStatus();

    const cleanup = () => {
      viewers.delete(ws);
      notifyViewerStatus();
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  wss.on("error", (error) => {
    console.error("WebSocket server error:", error);
  });
}

function listenHttpOnPort(port) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup();
      resolve(port);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      httpServer.off("listening", onListening);
      httpServer.off("error", onError);
    };

    httpServer.once("listening", onListening);
    httpServer.once("error", onError);
    httpServer.listen(port, "0.0.0.0");
  });
}

async function startWebSocketServer() {
  createWebSocketServer();

  let lastError = null;

  for (let port = WS_PORT_START; port <= WS_PORT_END; port += 1) {
    try {
      wsPort = await listenHttpOnPort(port);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  const error = new Error(
    `تعذر العثور على منفذ TCP متاح بين ${WS_PORT_START} و ${WS_PORT_END}`
  );
  error.cause = lastError;
  throw error;
}

function bindUdpOnPort(port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");

    const onListening = () => {
      cleanupStartupListeners();
      resolve(socket);
    };

    const onError = (error) => {
      cleanupStartupListeners();
      try {
        socket.close();
      } catch {}
      reject(error);
    };

    const cleanupStartupListeners = () => {
      socket.off("listening", onListening);
      socket.off("error", onError);
    };

    socket.once("listening", onListening);
    socket.once("error", onError);
    socket.bind(port, "0.0.0.0");
  });
}

async function startDiscoveryServer() {
  let lastError = null;

  for (
    let port = DISCOVERY_PORT_START;
    port <= DISCOVERY_PORT_END;
    port += 1
  ) {
    try {
      const socket = await bindUdpOnPort(port);
      discoverySocket = socket;
      discoveryPort = port;
      break;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  if (!discoverySocket) {
    const error = new Error(
      `تعذر العثور على منفذ UDP متاح بين ${DISCOVERY_PORT_START} و ${DISCOVERY_PORT_END}`
    );
    error.cause = lastError;
    throw error;
  }

  discoverySocket.on("error", (error) => {
    console.error("UDP discovery error:", error);
  });

  discoverySocket.on("message", (message, remote) => {
    if (message.toString().trim() !== DISCOVER_MESSAGE) {
      return;
    }

    const response = Buffer.from(`${ADMIN_MESSAGE}|${wsPort}`);

    // مهم: الرد يجب أن يذهب إلى منفذ المصدر الخاص بالـ Viewer، وليس إلى 8766.
    discoverySocket.send(response, remote.port, remote.address, (error) => {
      if (error) {
        console.error("Discovery response error:", error);
      }
    });
  });
}

async function startNetwork() {
  await startWebSocketServer();

  try {
    await startDiscoveryServer();
  } catch (error) {
    try {
      wss?.close();
    } catch {}
    try {
      httpServer?.close();
    } catch {}
    throw error;
  }
}

async function stopNetwork() {
  for (const ws of viewers) {
    try {
      ws.close();
    } catch {}
  }
  viewers.clear();

  try {
    discoverySocket?.close();
  } catch {}
  discoverySocket = null;

  try {
    wss?.close();
  } catch {}
  wss = null;

  if (httpServer?.listening) {
    await new Promise((resolve) => {
      try {
        httpServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  httpServer = null;
}

ipcMain.handle("network:info", () => ({
  address: getLanAddress(),
  wsPort,
  discoveryPort,
}));

ipcMain.handle("image:send", async (_event, payload) => {
  if (!payload?.buffer) {
    throw new Error("بيانات الصورة ناقصة");
  }

  const buffer = Buffer.from(payload.buffer);
  const header = JSON.stringify({
    type: "image",
    name: payload.name || "image",
    mime: payload.mime || "image/jpeg",
    size: buffer.length,
  });

  let sent = 0;

  for (const ws of viewers) {
    if (ws.readyState !== WebSocket.OPEN) {
      continue;
    }

    try {
      ws.send(header);
      ws.send(buffer, { binary: true });
      sent += 1;
    } catch (error) {
      console.error("Image send error:", error);
      viewers.delete(ws);
    }
  }

  notifyViewerStatus();

  return {
    sent,
    count: sent,
    bytes: buffer.length,
  };
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      await startNetwork();
      createWindow();
    } catch (error) {
      console.error("Failed to start ImageBoard Admin:", error);
      dialog.showErrorBox(
        "ImageBoard Admin",
        `تعذر تشغيل خدمة الشبكة.\n\n${error?.message || error}`
      );
      await stopNetwork();
      app.quit();
    }
  });

  app.on("before-quit", (event) => {
    if (quitting) {
      return;
    }

    quitting = true;
    event.preventDefault();

    stopNetwork().finally(() => {
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
