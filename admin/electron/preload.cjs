const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("imageBoard", {
  sendImage: (buffer, name, mime) =>
    ipcRenderer.invoke("image:send", { buffer, name, mime }),
  getNetworkInfo: () => ipcRenderer.invoke("network:info"),
  onStatus: (callback) =>
    ipcRenderer.on("viewer:status", (_event, value) => callback(value)),
});
