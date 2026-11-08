const { contextBridge, ipcRenderer } = require("electron");

// Страница получает только эти функции, а не весь Node.js
contextBridge.exposeInMainWorld("launcher", {
  loginGoogle: () => ipcRenderer.invoke("login:google"),
  loginMicrosoft: () => ipcRenderer.invoke("login:microsoft"),
  play: (pack, account, skin) => ipcRenderer.invoke("game:play", { pack, account, skin }),
  getDefaultSkins: () => ipcRenderer.invoke("skins:defaults"),
  plusStatus: () => ipcRenderer.invoke("plus:status"),
  plusActivate: (code) => ipcRenderer.invoke("plus:activate", code),
  aiStatus: () => ipcRenderer.invoke("ai:status"),
  aiSetKey: (key) => ipcRenderer.invoke("ai:setKey", key),
  aiChat: (messages, mcHint) => ipcRenderer.invoke("ai:chat", { messages, mcHint }),
  javaStatus: (mc) => ipcRenderer.invoke("java:status", mc),
  javaInstall: (component) => ipcRenderer.invoke("java:install", component),
  cleanScan: (pack) => ipcRenderer.invoke("clean:scan", pack),
  cleanRun: (pack, cats) => ipcRenderer.invoke("clean:run", { pack, cats }),
  getCapes: (uuid) => ipcRenderer.invoke("capes:list", uuid),
  setCape: (uuid, capeId) => ipcRenderer.invoke("capes:set", { uuid, capeId }),
  onMonitor: (cb) => ipcRenderer.on("monitor:tick", (_e, m) => cb(m)),
  uploadSkin: (data, model, uuid) => ipcRenderer.invoke("skins:upload", { data, model, uuid }),
  onGameProgress: (cb) => ipcRenderer.on("game:progress", (_e, p) => cb(p)),
  onGameExit: (cb) => ipcRenderer.on("game:exit", (_e, p) => cb(p)),
});
