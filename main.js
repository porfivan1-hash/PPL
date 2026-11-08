const { app, BrowserWindow, ipcMain, shell, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const os = require("os");
const { execFile } = require("child_process");
const config = require("./config");
const gl = require("./launcher");

// Разработчик определяется здесь, в главном процессе, по подтверждённой почте Google
const isDeveloper = (info) =>
  !!info.email_verified && (config.DEVELOPER_EMAILS || []).some((e) => e.toLowerCase() === String(info.email).toLowerCase());

let win;
const gamePids = new Set(); // процессы запущенной игры (для датчика памяти)
const msSessions = new Map(); // uuid -> сессия Microsoft (хранится только здесь, в главном процессе)

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#0d0e0f",
    title: "PlyPrismLauncher",
    autoHideMenuBar: true,
    show: false, // показываем только после первой отрисовки — так не бывает чёрного/белого мигания
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  setupCapture();

  // Абсолютный путь надёжнее относительного: работает и в exe, и при запуске из исходников
  const page = path.join(__dirname, "need.html");
  win.loadFile(page).catch((e) => showLoadError(e && e.message));

  win.once("ready-to-show", () => win.show());

  // Если страница не загрузилась, вместо чёрного окна показываем понятное сообщение
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3) return; // ERR_ABORTED — обычная отмена навигации
    console.error("Не удалось загрузить страницу:", code, desc, url);
    showLoadError(`${desc} (${code})`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("Процесс отрисовки завершился:", details);
    showLoadError(`Процесс отрисовки завершился: ${details.reason}`);
  });

  // Внешние ссылки открываем в обычном браузере, а внутри окна уходить с файла нельзя
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) e.preventDefault();
  });
}

// Запасная страница на случай, если need.html не загрузился
function showLoadError(details) {
  if (!win || win.isDestroyed()) return;
  const html = `<!doctype html><meta charset="utf-8"><title>PlyPrismLauncher</title>
  <body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0e0f;color:#ededed;font:16px system-ui">
  <div style="max-width:560px;padding:28px;border:2px solid #33373a;background:#1a1c1e">
    <h1 style="font-size:20px;margin:0 0 12px">Не удалось запустить интерфейс</h1>
    <p style="margin:0 0 8px">Файл <b>need.html</b> не загрузился.</p>
    <p style="margin:0 0 8px;color:#9b9fa3">${String(details || "неизвестная ошибка").replace(/[<>&]/g, "")}</p>
    <p style="margin:0;color:#9b9fa3">Попробуйте запустить PlyPrismLauncher.exe ещё раз. Если ошибка повторяется — проверьте, что антивирус не удалил файлы рядом с exe.</p>
  </div></body>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  if (!win.isVisible()) win.show();
}

// Проверка сборки: PLY_CAPTURE=путь.png сохранит снимок окна и закроет приложение.
// Нужна только для тестов, обычному запуску не мешает.
function setupCapture() {
  const target = process.env.PLY_CAPTURE;
  if (!target) return;
  win.webContents.once("did-finish-load", () => {
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(target, image.toPNG());
        console.log("Снимок окна сохранён:", target);
      } catch (e) {
        console.error("Не удалось сохранить снимок окна:", e);
      }
      app.quit();
    }, 3500);
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

/* ───────── Google: вход через accounts.google.com в системном браузере ─────────
   Встроенные окна Google блокирует, поэтому открываем обычный браузер.
   Схема: OAuth 2.0 + PKCE, ответ приходит на локальный адрес 127.0.0.1. */

const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Офлайн-UUID так же, как считает сам Minecraft: MD5("OfflinePlayer:ник"), версия 3
function offlineUuid(name) {
  const h = crypto.createHash("md5").update("OfflinePlayer:" + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function makeNick(info) {
  let nick = (info.email || "").split("@")[0].replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
  if (nick.length < 3) nick = (nick + "Player").slice(0, 16);
  return nick;
}

const resultPage = (text) =>
  `<!doctype html><meta charset="utf-8"><title>MC Launcher</title>
   <body style="font:18px system-ui;background:#1b1f22;color:#e6e9e4;display:grid;place-items:center;height:100vh;margin:0">
   <p>${text}</p></body>`;

function loginGoogle() {
  return new Promise((resolve, reject) => {
    const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = config;
    if (!clientId || clientId.startsWith("PUT_")) {
      return reject(new Error("Не заполнен GOOGLE_CLIENT_ID в config.js"));
    }

    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    let redirectUri = "";
    let finished = false;

    const finish = (err, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      err ? reject(err) : resolve(value);
    };

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const code = u.searchParams.get("code");
      if (u.searchParams.get("state") !== state || !code) {
        res.end(resultPage("Вход отменён. Можно закрыть вкладку."));
        return finish(new Error("Вход через Google отменён"));
      }
      try {
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret || "",
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
            code_verifier: verifier,
          }),
        });
        const tokens = await tokenRes.json();
        if (!tokenRes.ok) throw new Error(tokens.error_description || tokens.error || "Ошибка Google");

        const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
          headers: { Authorization: "Bearer " + tokens.access_token },
        });
        const info = await infoRes.json();
        if (!infoRes.ok) throw new Error("Не удалось получить профиль Google");

        // Токены нигде не сохраняем: нам нужен только ник
        const name = makeNick(info);
        res.end(resultPage("Готово! Вернитесь в лаунчер, эту вкладку можно закрыть."));
        win && win.focus();
        if (isDeveloper(info)) writePlus({ devEmail: info.email }); // разработчик получает PlyPrismLauncher+ бесплатно
        finish(null, { name, uuid: offlineUuid(name), email: info.email, developer: isDeveloper(info) });
      } catch (e) {
        res.end(resultPage("Ошибка входа. Вернитесь в лаунчер."));
        finish(e);
      }
    });

    const timer = setTimeout(() => finish(new Error("Время входа истекло")), 3 * 60 * 1000);

    server.on("error", finish);
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const url =
        "https://accounts.google.com/o/oauth2/v2/auth?" +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "openid email profile",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          prompt: "select_account",
        });
      shell.openExternal(url);
    });
  });
}

ipcMain.handle("login:google", () => loginGoogle());

/* ───────── Microsoft (лицензия Minecraft) через msmc ───────── */

ipcMain.handle("login:microsoft", async () => {
  const { Auth } = require("msmc");
  const auth = new Auth("select_account");
  const xbox = await auth.launch("electron");
  const mc = await xbox.getMinecraft();
  const id = mc.profile.id;
  const uuid = id.includes("-")
    ? id
    : `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  msSessions.set(uuid.replace(/-/g, ""), mc);
  return { name: mc.profile.name, uuid };
});

/* ───────── Запуск игры ───────── */

const safeName = (s) => String(s).replace(/[^\p{L}\p{N}_\- ]/gu, "_").trim().slice(0, 60) || "pack";

ipcMain.handle("game:play", async (event, { pack, account, skin }) => {
  if (!pack || !Array.isArray(pack.mods) || !account) throw new Error("Неверные данные запуска");

  let auth;
  if (account.type === "online") {
    const sess = msSessions.get(String(account.uuid).replace(/-/g, ""));
    if (!sess) throw new Error("Сессия Microsoft закончилась. Откройте список аккаунтов слева, нажмите «Добавить аккаунт» и войдите в Microsoft снова.");
    const m = sess.mclc();
    auth = { name: m.name, uuid: m.uuid, token: m.access_token, type: "msa" };
  } else {
    auth = { name: account.name, uuid: account.uuid, token: "0", type: "legacy" };
  }

  let last = 0;
  const send = (stage, done, total) => {
    const now = Date.now();
    if (done !== total && now - last < 120) return;
    last = now;
    if (!event.sender.isDestroyed()) event.sender.send("game:progress", { stage, done, total });
  };

  const res = await gl.play({
    root: path.join(app.getPath("userData"), "shared"),
    dir: path.join(app.getPath("userData"), "instances", safeName(pack.folder || pack.name)), // старые сборки без folder остаются в прежних папках
    pack,
    auth,
    skin: isPlus() ? skin : null, // скины только в PlyPrismLauncher+
    plus: isPlus(),
    send,
    onExit: (code, log, pid) => {
      gamePids.delete(pid);
      if (!event.sender.isDestroyed()) event.sender.send("game:exit", { code, log });
    },
  });
  gamePids.add(res.pid);
  return { mc: res.mc, loader: res.loader };
});

/* ───────── Скины ───────── */

ipcMain.handle("skins:defaults", () => {
  needPlus("Скины");
  return gl.getDefaultSkins(path.join(app.getPath("userData"), "shared"));
});

ipcMain.handle("skins:upload", async (_event, { data, model, uuid }) => {
  needPlus("Скины");
  const sess = msSessions.get(String(uuid).replace(/-/g, ""));
  if (!sess) throw new Error("Сессия Microsoft закончилась. Откройте список аккаунтов слева, нажмите «Добавить аккаунт» и войдите в Microsoft снова.");
  const m = sess.mclc();
  await gl.uploadSkin(m.access_token, data, model);
  return true;
});

/* ───────── Java, плащи, очистка, мониторинг ───────── */

const sharedDir = () => path.join(app.getPath("userData"), "shared");
const instDirOf = (pack) => path.join(app.getPath("userData"), "instances", safeName(pack.folder || pack.name));

function msProfile(uuid) {
  const sess = msSessions.get(String(uuid).replace(/-/g, ""));
  if (!sess) throw new Error("Сессия Microsoft закончилась. Откройте список аккаунтов слева, нажмите «Добавить аккаунт» и войдите в Microsoft снова.");
  return sess.mclc();
}

function progressSender(event) {
  let last = 0;
  return (stage, done, total) => {
    const now = Date.now();
    if (done !== total && now - last < 120) return;
    last = now;
    if (!event.sender.isDestroyed()) event.sender.send("game:progress", { stage, done, total });
  };
}

ipcMain.handle("java:status", (_e, mc) => gl.javaStatus(sharedDir(), mc ? String(mc) : null));
ipcMain.handle("java:install", (event, component) => gl.installJava(sharedDir(), String(component), progressSender(event)));

ipcMain.handle("capes:list", (_e, uuid) => {
  needPlus("Плащи");
  return gl.getCapes(msProfile(uuid).access_token);
});
ipcMain.handle("capes:set", (_e, { uuid, capeId }) => {
  needPlus("Плащи");
  return gl.setCape(msProfile(uuid).access_token, capeId ? String(capeId) : null);
});

ipcMain.handle("clean:scan", (_e, pack) => {
  if (!pack || !pack.name) throw new Error("Неверная сборка");
  return gl.cleanScan(sharedDir(), instDirOf(pack), pack);
});
ipcMain.handle("clean:run", (_e, { pack, cats }) => {
  if (!pack || !pack.name || !Array.isArray(cats)) throw new Error("Неверные данные очистки");
  return gl.cleanRun(sharedDir(), instDirOf(pack), pack, cats);
});

// Датчики: нагрузка ЦП и ОЗУ системы + память процесса игры (раз в 2 секунды)
let prevCpu = os.cpus();
function cpuLoad() {
  const cur = os.cpus();
  let idle = 0, total = 0;
  cur.forEach((c, i) => {
    for (const k in c.times) total += c.times[k] - prevCpu[i].times[k];
    idle += c.times.idle - prevCpu[i].times.idle;
  });
  prevCpu = cur;
  return total ? Math.max(0, Math.min(100, Math.round(100 * (1 - idle / total)))) : 0;
}

function gameMemMB(pid) {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const line = String(out).split("\n").find((l) => l.startsWith('"'));
      if (!line) return resolve(null);
      const kb = parseInt((line.split('","')[4] || "").replace(/\D/g, ""), 10);
      resolve(Number.isFinite(kb) ? Math.round(kb / 1024) : null);
    });
  });
}

async function monitorTick() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  const total = os.totalmem();
  let gameMB = null;
  for (const pid of gamePids) {
    const m = await gameMemMB(pid);
    if (m != null) gameMB = (gameMB || 0) + m;
  }
  win.webContents.send("monitor:tick", {
    cpu: cpuLoad(),
    ramUsedMB: Math.round((total - os.freemem()) / 1048576),
    ramTotalMB: Math.round(total / 1048576),
    gameMB,
  });
}
app.whenReady().then(() => setInterval(monitorTick, 2000));

/* ───────── PlyPrismLauncher+ ─────────
   Подписка бесплатная. Коды публикуются в Telegram: https://t.me/clevi01
   Здесь лежат только хеши кодов. Новые коды: node hashcode.js gen 10 → вставить хеши в список.
   Убрать хеш из списка = отозвать код. */
const PLUS_CODE_HASHES = [
  "1e63153ed704898afd8e52947e00a4f71fc53191f30700ca55354c473bd8c83c", // 58317-…
];
const AI_LIMITS = { free: 5, plus: 50 }; // сообщений ИИ в сутки

const normCode = (c) => String(c).replace(/\s+/g, "").toUpperCase();
const hashCode = (c) => crypto.createHash("sha256").update("plyprism+:" + normCode(c)).digest("hex");
const plusFile = () => path.join(app.getPath("userData"), "plus.json");
function readPlus() {
  try { return JSON.parse(fs.readFileSync(plusFile(), "utf8")); } catch { return {}; }
}
function writePlus(patch) {
  fs.mkdirSync(path.dirname(plusFile()), { recursive: true });
  fs.writeFileSync(plusFile(), JSON.stringify({ ...readPlus(), ...patch }));
}
function plusStatus() {
  const s = readPlus();
  if (s.devEmail && (config.DEVELOPER_EMAILS || []).some((e) => e.toLowerCase() === String(s.devEmail).toLowerCase())) return { plus: true, via: "developer" };
  if (s.codeHash && PLUS_CODE_HASHES.includes(s.codeHash)) return { plus: true, via: "code" };
  return { plus: false, via: null };
}
const isPlus = () => plusStatus().plus;
function needPlus(what) {
  if (!isPlus()) throw new Error(`${what}: доступно только в PlyPrismLauncher+. Код бесплатный, он в Telegram: t.me/clevi01`);
}

let badTries = 0, lockUntil = 0;
ipcMain.handle("plus:status", () => plusStatus());
ipcMain.handle("plus:activate", async (_e, code) => {
  if (Date.now() < lockUntil) throw new Error("Слишком много неверных попыток. Подождите минуту.");
  const h = hashCode(code);
  if (!PLUS_CODE_HASHES.includes(h)) {
    if (++badTries >= 5) { lockUntil = Date.now() + 60000; badTries = 0; }
    await new Promise((r) => setTimeout(r, 600));
    throw new Error("Неверный код. Коды выкладываются в Telegram: t.me/clevi01");
  }
  badTries = 0;
  writePlus({ codeHash: h });
  return plusStatus();
});

/* ───────── ИИ-помощник ───────── */

const AI_SYSTEM = `Ты помощник лаунчера PlyPrismLauncher. Ты помогаешь собрать сборку Minecraft из модов, шейдеров и ресурспаков с Modrinth.
Отвечай ТОЛЬКО одним JSON-объектом без markdown и пояснений вокруг:
{"reply":"короткий ответ по-русски","pack":null или {"name":"название","mc":"1.20.1","loader":"fabric","mods":["slug"],"shaders":["slug"],"resourcepacks":["slug"]}}
Правила:
- В списках используй slug проектов Modrinth (например sodium, lithium, iris, modmenu). Не больше 25 модов, 3 шейдеров и 3 ресурспаков.
- Не добавляй fabric-api, архитектурные библиотеки и другие обязательные зависимости: лаунчер добавит их сам.
- mc: релизная версия вида 1.20.1. Если пользователь её не назвал, возьми подсказку из сообщения или 1.20.1.
- loader: fabric, quilt, forge или neoforge. Если пользователь не просил иного, выбирай fabric.
- Если не хватает важных деталей, задай один уточняющий вопрос в reply и поставь pack: null.
- Не предлагай читы, чит-клиенты и моды для обхода защиты серверов.`;

const usageFile = () => path.join(app.getPath("userData"), "ai-usage.json");
const keyFile = () => path.join(app.getPath("userData"), "ai-key.bin");
function aiUsage() {
  const day = new Date().toISOString().slice(0, 10);
  let u = {};
  try { u = JSON.parse(fs.readFileSync(usageFile(), "utf8")); } catch {}
  return u.day === day ? u : { day, count: 0 };
}
function aiKey() {
  if (config.ANTHROPIC_API_KEY && !String(config.ANTHROPIC_API_KEY).startsWith("PUT_")) return config.ANTHROPIC_API_KEY;
  try {
    if (safeStorage.isEncryptionAvailable() && fs.existsSync(keyFile())) return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {}
  return null;
}

ipcMain.handle("ai:status", () => {
  const plus = isPlus();
  return { used: aiUsage().count, limit: plus ? AI_LIMITS.plus : AI_LIMITS.free, hasKey: !!aiKey(), plus };
});

ipcMain.handle("ai:setKey", (_e, key) => {
  key = String(key || "").trim();
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) throw new Error("Ключ Claude API должен начинаться с sk-ant-");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("На этом компьютере Windows не даёт зашифровать ключ");
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key));
  return true;
});

ipcMain.handle("ai:chat", async (_e, { messages, mcHint }) => {
  const key = aiKey();
  if (!key) throw new Error("Не задан ключ Claude API. Добавьте его в «Настройках».");
  const u = aiUsage(), limit = isPlus() ? AI_LIMITS.plus : AI_LIMITS.free;
  if (u.count >= limit) throw new Error(`Лимит ${limit} сообщений на сегодня исчерпан.` + (isPlus() ? "" : " В PlyPrismLauncher+ лимит больше."));

  const msgs = (Array.isArray(messages) ? messages : []).slice(-12)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") throw new Error("Пустой запрос");
  if (/^\d+\.\d+(\.\d+)?$/.test(String(mcHint || ""))) msgs[msgs.length - 1].content += `\n(Подсказка: сейчас выбрана версия Minecraft ${mcHint})`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: config.AI_MODEL || "claude-sonnet-5-5", max_tokens: 1500, system: AI_SYSTEM, messages: msgs }),
  });
  if (!r.ok) throw new Error(r.status === 401 ? "Ключ Claude API не подошёл" : `ИИ сейчас недоступен (HTTP ${r.status})`);
  const j = await r.json();
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  fs.writeFileSync(usageFile(), JSON.stringify({ day: u.day, count: u.count + 1 }));
  return { ...gl.parseAiReply(text), raw: text.slice(0, 4000) };
});
