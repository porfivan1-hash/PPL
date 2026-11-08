// Установка и запуск Minecraft: файлы Mojang, Java, Fabric/Quilt, сборки Modrinth (.mrpack)
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const AdmZip = require("adm-zip");

const MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const JAVA_ALL = "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";
const ASSET_HOST = "https://resources.download.minecraft.net/";
const OS_NAME = "windows";
const FOLDERS = { mod: "mods", shader: "shaderpacks", resourcepack: "resourcepacks" };
const ALLOWED_HOSTS = ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "gitlab.com"];

/* ───── сеть и файлы ───── */
const sha1Buf = (b) => crypto.createHash("sha1").update(b).digest("hex");

function checkUrl(u) {
  const x = new URL(u);
  if (x.protocol !== "https:" || !ALLOWED_HOSTS.includes(x.hostname)) {
    throw new Error("Недопустимый адрес загрузки: " + x.hostname);
  }
}

function safeJoin(dir, rel) {
  const base = path.resolve(dir);
  const p = path.resolve(base, rel);
  if (!p.startsWith(base + path.sep)) throw new Error("Небезопасный путь в сборке: " + rel);
  return p;
}

async function getJson(url) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (t === 2) throw new Error(`Не удалось получить ${url}: ${e.message}`);
    }
  }
}

// Скачивает файл, если его нет (или размер не совпал). Проверяет sha1, если он известен.
async function fetchTo(url, dest, sha1, size) {
  try {
    const st = await fsp.stat(dest);
    if (!url || !size || st.size === size) return;
  } catch {}
  if (!url) throw new Error(`Нет файла ${path.basename(dest)}: установка загрузчика не завершилась`);
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (sha1 && sha1Buf(buf) !== sha1) throw new Error("контрольная сумма не совпала");
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
      return;
    } catch (e) {
      if (t === 2) throw new Error(`Не скачался ${url}: ${e.message}`);
    }
  }
}

async function pool(list, n, fn) {
  let i = 0;
  const worker = async () => {
    while (i < list.length) await fn(list[i++]);
  };
  await Promise.all(Array.from({ length: n }, worker));
}

/* ───── правила Mojang (os / features) ───── */
function allowed(rules) {
  if (!rules) return true;
  let ok = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== OS_NAME) match = false;
      if (r.os.arch && !["x64", "x86_64", "amd64"].includes(r.os.arch)) match = false;
      if (r.os.version && !new RegExp(r.os.version).test(os.release())) match = false;
    }
    if (r.features) match = false;
    if (match) ok = r.action === "allow";
  }
  return ok;
}

/* ───── Minecraft от Mojang ───── */
async function ensureVanilla(root, mc, send) {
  const vdir = path.join(root, "versions", mc);
  const vjson = path.join(vdir, mc + ".json");
  const jar = path.join(vdir, mc + ".jar");
  if (fs.existsSync(vjson) && fs.existsSync(jar)) return JSON.parse(await fsp.readFile(vjson, "utf8"));

  send("Получаем список версий Minecraft…");
  const man = await getJson(MANIFEST);
  const e = man.versions.find((v) => v.id === mc);
  if (!e) throw new Error(`Версия ${mc} не найдена у Mojang`);
  await fetchTo(e.url, vjson, e.sha1);
  const v = JSON.parse(await fsp.readFile(vjson, "utf8"));
  send(`Скачиваем клиент Minecraft ${mc}…`);
  await fetchTo(v.downloads.client.url, jar, v.downloads.client.sha1, v.downloads.client.size);
  return v;
}

// Fabric и Quilt: готовый профиль версии с их сервера метаданных
async function ensureLoader(root, loader, mc, loaderVersion, vanilla, send) {
  if (loader === "forge" || loader === "neoforge") return ensureForgeLike(root, loader, mc, loaderVersion, vanilla, send);
  if (loader !== "fabric" && loader !== "quilt") throw new Error(`Неизвестный загрузчик: ${loader}`);
  const base = loader === "fabric"
    ? "https://meta.fabricmc.net/v2/versions/loader/"
    : "https://meta.quiltmc.org/v3/versions/loader/";
  let lv = loaderVersion;
  if (!lv) {
    const list = await getJson(base + mc);
    if (!list.length) throw new Error(`${loader} не поддерживает Minecraft ${mc}`);
    lv = (list.find((x) => x.loader.stable !== false) || list[0]).loader.version;
  }
  const prof = await getJson(`${base}${mc}/${lv}/profile/json`);
  const dir = path.join(root, "versions", prof.id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, prof.id + ".json"), JSON.stringify(prof));
  return prof.id;
}

/* ───── Forge и NeoForge: запускаем их официальный установщик ───── */
async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Не удалось получить ${url}: HTTP ${r.status}`);
  return r.text();
}

async function resolveForgeVersion(mc) {
  const p = await getJson("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json");
  const v = p.promos[`${mc}-recommended`] || p.promos[`${mc}-latest`];
  if (!v) throw new Error(`Для Minecraft ${mc} нет Forge`);
  return v;
}

async function resolveNeoVersion(mc) {
  const m = mc.match(/^1\.(\d+)(?:\.(\d+))?$/);
  if (!m || +m[1] < 20 || (+m[1] === 20 && +(m[2] || 0) < 2)) {
    throw new Error("NeoForge поддерживает Minecraft 1.20.2 и новее. Для более старых версий используйте Forge.");
  }
  const prefix = `${m[1]}.${m[2] || 0}.`;
  const xml = await getText("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((x) => x[1]).filter((v) => v.startsWith(prefix));
  const stable = all.filter((v) => !v.includes("-"));
  const v = (stable.length ? stable : all).pop();
  if (!v) throw new Error(`Для Minecraft ${mc} нет NeoForge`);
  return v;
}

function runInstaller(java, jar, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(java, ["-jar", jar, "--installClient", root], { cwd: root, windowsHide: true });
    let tail = "";
    const grab = (d) => { tail = (tail + d).slice(-2000); };
    child.stdout.on("data", grab);
    child.stderr.on("data", grab);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Установщик завершился с ошибкой (${code}):\n` + tail.trim().split("\n").slice(-4).join("\n")));
    });
  });
}

async function ensureForgeLike(root, loader, mc, loaderVersion, vanilla, send) {
  const label = loader === "forge" ? "Forge" : "NeoForge";
  const regFile = path.join(root, "loaders.json"); // что уже установлено: ключ -> id версии
  let reg = {};
  try { reg = JSON.parse(await fsp.readFile(regFile, "utf8")); } catch {}
  const prefix = `${loader}:${mc}:`;

  let ver = loaderVersion;
  if (!ver) {
    try {
      ver = loader === "forge" ? await resolveForgeVersion(mc) : await resolveNeoVersion(mc);
    } catch (e) {
      const k = Object.keys(reg).reverse().find((x) => x.startsWith(prefix)); // нет сети: берём установленную
      if (k) return reg[k];
      throw e;
    }
  }
  const key = prefix + ver;
  if (reg[key] && fs.existsSync(path.join(root, "versions", reg[key], reg[key] + ".json"))) return reg[key];

  const url = loader === "forge"
    ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${ver}/forge-${mc}-${ver}-installer.jar`
    : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`;
  send(`Скачиваем установщик ${label} ${ver}…`);
  const jarPath = path.join(root, "installers", `${loader}-${mc}-${ver}.jar`);
  await fetchTo(url, jarPath);

  // id версии берём из самого установщика
  const zip = new AdmZip(jarPath);
  let id;
  if (zip.getEntry("version.json")) id = JSON.parse(zip.readAsText("version.json")).id;
  else id = JSON.parse(zip.readAsText("install_profile.json")).versionInfo?.id;
  if (!id) throw new Error(`Не удалось определить версию ${label}`);

  const profiles = path.join(root, "launcher_profiles.json"); // установщик требует этот файл
  if (!fs.existsSync(profiles)) await fsp.writeFile(profiles, JSON.stringify({ profiles: {}, version: 3 }));

  const java = await ensureJava(root, vanilla, send);
  send(`Устанавливаем ${label} (несколько минут, не закрывайте лаунчер)…`);
  await runInstaller(java, jarPath, root);
  if (!fs.existsSync(path.join(root, "versions", id, id + ".json"))) throw new Error(`${label} не установился`);

  reg[key] = id;
  await fsp.writeFile(regFile, JSON.stringify(reg));
  return id;
}

async function loadMerged(root, id) {
  const v = JSON.parse(await fsp.readFile(path.join(root, "versions", id, id + ".json"), "utf8"));
  if (!v.inheritsFrom) return { ...v, baseId: id };
  const p = await loadMerged(root, v.inheritsFrom);
  return {
    ...p,
    ...v,
    baseId: p.baseId,
    libraries: [...(v.libraries || []), ...p.libraries],
    arguments: {
      game: [...(p.arguments?.game || []), ...(v.arguments?.game || [])],
      jvm: [...(p.arguments?.jvm || []), ...(v.arguments?.jvm || [])],
    },
  };
}

function mavenPath(name) {
  const [g, a, ver, cls] = name.split(":");
  return `${g.replace(/\./g, "/")}/${a}/${ver}/${a}-${ver}${cls ? "-" + cls : ""}.jar`;
}

function listLibs(v) {
  const seen = new Set();
  const out = [];
  for (const lib of v.libraries) {
    if (!allowed(lib.rules)) continue;
    const [g, a, , cls] = lib.name.split(":");
    const key = `${g}:${a}:${cls || ""}`;
    if (seen.has(key)) continue; // при совпадении берём первую (библиотеки загрузчика идут раньше)
    seen.add(key);
    const d = lib.downloads;
    if (d?.artifact) {
      out.push({ path: d.artifact.path, url: d.artifact.url, sha1: d.artifact.sha1, size: d.artifact.size });
    } else if (!d) {
      const p = mavenPath(lib.name);
      out.push({ path: p, url: (lib.url || "https://libraries.minecraft.net/") + p, sha1: lib.sha1 });
    }
    if (lib.natives && lib.natives[OS_NAME]) {
      const cls2 = lib.natives[OS_NAME].replace("${arch}", "64");
      const a2 = d?.classifiers?.[cls2];
      if (a2) out.push({ path: a2.path, url: a2.url, sha1: a2.sha1, size: a2.size, native: true, exclude: lib.extract?.exclude || [] });
    }
  }
  return out;
}

async function ensureLibraries(root, libs, nativesDir, send) {
  let done = 0;
  send("Скачиваем библиотеки…", 0, libs.length);
  await pool(libs, 8, async (l) => {
    await fetchTo(l.url, path.join(root, "libraries", l.path), l.sha1, l.size);
    send("Скачиваем библиотеки…", ++done, libs.length);
  });
  await fsp.mkdir(nativesDir, { recursive: true });
  for (const l of libs.filter((x) => x.native)) {
    const zip = new AdmZip(path.join(root, "libraries", l.path));
    for (const ent of zip.getEntries()) {
      if (ent.isDirectory || l.exclude.some((x) => ent.entryName.startsWith(x))) continue;
      zip.extractEntryTo(ent, nativesDir, false, true);
    }
  }
}

async function ensureAssets(root, v, send) {
  const ai = v.assetIndex;
  const idxPath = path.join(root, "assets", "indexes", ai.id + ".json");
  await fetchTo(ai.url, idxPath, ai.sha1, ai.size);
  const idx = JSON.parse(await fsp.readFile(idxPath, "utf8"));
  const map = new Map();
  for (const o of Object.values(idx.objects)) map.set(o.hash, o.size);
  const list = [...map.entries()];
  let done = 0;
  send("Скачиваем звуки и текстуры (первый запуск, это долго)…", 0, list.length);
  await pool(list, 16, async ([hash, size]) => {
    const pre = hash.slice(0, 2);
    await fetchTo(`${ASSET_HOST}${pre}/${hash}`, path.join(root, "assets", "objects", pre, hash), hash, size);
    send("Скачиваем звуки и текстуры (первый запуск, это долго)…", ++done, list.length);
  });
}

async function ensureLogConfig(root, v) {
  const c = v.logging?.client;
  if (!c?.file) return null;
  const dest = path.join(root, "assets", "log_configs", c.file.id);
  await fetchTo(c.file.url, dest, c.file.sha1, c.file.size);
  return c.argument.replace("${path}", dest);
}

// Java берём у Mojang: нужная для версии игры (java-runtime-gamma и т. д.)
async function ensureJava(root, v, send) {
  const comp = v.javaVersion?.component || "jre-legacy";
  const dir = path.join(root, "runtime", comp);
  const exe = path.join(dir, "bin", "java.exe");
  if (fs.existsSync(path.join(dir, ".ok"))) return exe;

  send(`Скачиваем Java (${comp})…`);
  const all = await getJson(JAVA_ALL);
  const entry = all["windows-x64"]?.[comp]?.[0];
  if (!entry) throw new Error("Mojang не отдаёт Java " + comp + " для Windows x64");
  const man = await getJson(entry.manifest.url);
  const files = Object.entries(man.files).filter(([, f]) => f.type === "file");
  let done = 0;
  await pool(files, 12, async ([rel, f]) => {
    await fetchTo(f.downloads.raw.url, safeJoin(dir, rel), f.downloads.raw.sha1, f.downloads.raw.size);
    send(`Скачиваем Java (${comp})…`, ++done, files.length);
  });
  await fsp.writeFile(path.join(dir, ".ok"), "ok");
  return exe;
}

/* ───── моды, шейдеры, ресурспаки сборки ───── */
async function syncItems(pack, dir, send) {
  const items = pack.mods || [];
  const mf = path.join(dir, ".managed.json");
  let old = [];
  try { old = JSON.parse(await fsp.readFile(mf, "utf8")); } catch {}
  const now = items.map((m) => path.join(FOLDERS[m.type || "mod"], path.basename(m.file)));
  for (const o of old) if (!now.includes(o)) await fsp.rm(path.join(dir, o), { force: true });

  let done = 0;
  send("Скачиваем моды и ресурсы…", 0, items.length);
  for (const m of items) {
    checkUrl(m.url);
    await fetchTo(m.url, path.join(dir, FOLDERS[m.type || "mod"], path.basename(m.file)), m.sha1);
    send("Скачиваем моды и ресурсы…", ++done, items.length);
  }
  await fsp.writeFile(mf, JSON.stringify(now));
}

/* ───── готовая сборка Modrinth (.mrpack) ───── */
async function installMrpack(pack, dir, send) {
  const meta = path.join(dir, ".pack.json");
  try {
    const m = JSON.parse(await fsp.readFile(meta, "utf8"));
    if (m.url === pack.mrpack.url) return m;
  } catch {}

  checkUrl(pack.mrpack.url);
  send("Скачиваем сборку с Modrinth…");
  const tmp = path.join(os.tmpdir(), `ply-${Date.now()}.mrpack`);
  await fetchTo(pack.mrpack.url, tmp, pack.mrpack.sha1);
  const zip = new AdmZip(tmp);
  const idx = JSON.parse(zip.readAsText("modrinth.index.json"));

  const files = idx.files.filter((f) => f.env?.client !== "unsupported");
  let done = 0;
  await pool(files, 6, async (f) => {
    checkUrl(f.downloads[0]);
    await fetchTo(f.downloads[0], safeJoin(dir, f.path), f.hashes?.sha1, f.fileSize);
    send("Скачиваем файлы сборки…", ++done, files.length);
  });

  for (const ent of zip.getEntries()) {
    if (ent.isDirectory) continue;
    for (const pre of ["overrides/", "client-overrides/"]) {
      if (!ent.entryName.startsWith(pre)) continue;
      const dest = safeJoin(dir, ent.entryName.slice(pre.length));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, ent.getData());
    }
  }
  await fsp.rm(tmp, { force: true });

  const d = idx.dependencies || {};
  const loaders = { "fabric-loader": "fabric", "quilt-loader": "quilt", forge: "forge", neoforge: "neoforge" };
  const key = Object.keys(loaders).find((k) => d[k]);
  const info = { url: pack.mrpack.url, mc: d.minecraft, loader: key ? loaders[key] : "vanilla", loaderVersion: key ? d[key] : null };
  await fsp.writeFile(meta, JSON.stringify(info));
  return info;
}

/* ───── аргументы запуска ───── */
function buildArgs(v, vars, extraJvm) {
  const rep = (s) => s.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const flat = (list) => {
    const o = [];
    for (const a of list || []) {
      if (typeof a === "string") o.push(a);
      else if (allowed(a.rules)) o.push(...[].concat(a.value));
    }
    return o;
  };
  let jvm = flat(v.arguments?.jvm);
  if (!jvm.includes("-cp") && !jvm.includes("-classpath")) {
    jvm = ["-Djava.library.path=${natives_directory}", "-cp", "${classpath}", ...jvm];
  }
  const game = [...(v.minecraftArguments ? v.minecraftArguments.split(" ") : []), ...flat(v.arguments?.game)];
  return { jvm: [...extraJvm, ...jvm.map(rep)], game: game.map(rep) };
}

/* ───── Скины ───── */
// Офлайн-аккаунт: скин подкладываем ресурспаком поверх стандартных скинов игры.
// Аккаунт Microsoft: скин загружается на серверы Mojang через их API.
const PACK_FORMATS = [["1.21.4", 46], ["1.21.2", 42], ["1.21", 34], ["1.20.5", 32], ["1.20.3", 22], ["1.20.2", 18], ["1.20", 15],
  ["1.19.4", 13], ["1.19.3", 12], ["1.19", 9], ["1.18", 8], ["1.17", 7], ["1.16.2", 6], ["1.15", 5], ["1.13", 4], ["1.9", 2], ["1.6", 1]];
const SKIN_NAMES = ["alex", "ari", "efe", "kai", "makena", "noor", "steve", "sunny", "zuri"];
const PACK_FILE = "PlyPrismSkin.zip";

function cmpVer(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

function packFormat(mc) {
  if (!/^\d+\.\d+(\.\d+)?$/.test(mc)) return 46;
  return (PACK_FORMATS.find(([v]) => cmpVer(mc, v) >= 0) || [null, 1])[1];
}

function dataToPng(data) {
  return Buffer.from(String(data || "").split(",")[1] || "", "base64");
}

function checkPng(buf) {
  if (buf.length < 24 || buf.length > 300 * 1024 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("Скин должен быть PNG-файлом до 300 КБ");
  }
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w % 64 || !(h === w || h * 2 === w)) throw new Error("Нужен PNG 64×64 или 64×32");
}

// Включает или выключает ресурспак со скином в options.txt, остальные настройки не трогаем
async function setPackEnabled(dir, mc, enabled) {
  const file = path.join(dir, "options.txt");
  let txt = "";
  try { txt = await fsp.readFile(file, "utf8"); } catch {}
  const old = cmpVer(mc, "1.13") < 0; // до 1.13 формат без «file/» и без «vanilla»
  const entry = old ? PACK_FILE : "file/" + PACK_FILE;
  const lines = txt.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const idx = lines.findIndex((l) => l.startsWith("resourcePacks:"));
  if (!enabled && idx < 0) return;
  let list = old ? [] : ["vanilla"];
  if (idx >= 0) {
    try { list = JSON.parse(lines[idx].slice("resourcePacks:".length)); } catch {}
  }
  list = list.filter((x) => x !== entry && x !== PACK_FILE && x !== "file/" + PACK_FILE);
  if (enabled) list.push(entry); // последний в списке = самый приоритетный
  const line = "resourcePacks:" + JSON.stringify(list);
  if (idx >= 0) lines[idx] = line; else lines.push(line);
  await fsp.writeFile(file, lines.join("\n") + "\n");
}

async function applySkinPack(dir, mc, skin) {
  const zipPath = path.join(dir, "resourcepacks", PACK_FILE);
  if (!skin?.data) {
    await fsp.rm(zipPath, { force: true });
    await setPackEnabled(dir, mc, false);
    return;
  }
  const png = dataToPng(skin.data);
  checkPng(png);
  const zip = new AdmZip();
  zip.addFile("pack.mcmeta", Buffer.from(JSON.stringify({
    pack: {
      pack_format: packFormat(mc),
      supported_formats: { min_inclusive: 1, max_inclusive: 999 },
      description: "PlyPrismLauncher: ваш скин",
    },
  })));
  const base = "assets/minecraft/textures/entity/";
  zip.addFile(base + "steve.png", png); // до 1.19.2
  zip.addFile(base + "alex.png", png);
  for (const n of SKIN_NAMES) { // с 1.19.3
    zip.addFile(`${base}player/wide/${n}.png`, png);
    zip.addFile(`${base}player/slim/${n}.png`, png);
  }
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });
  zip.writeZip(zipPath);
  await setPackEnabled(dir, mc, true);
}

// Готовые скины Minecraft берём из клиента игры (jar), если его ещё нет, скачиваем последний релиз
async function findSkinJar(root) {
  let names = [];
  try { names = await fsp.readdir(path.join(root, "versions")); } catch {}
  names = names.filter((n) => /^\d+\.\d+(\.\d+)?$/.test(n)).sort(cmpVer).reverse();
  for (const n of names) {
    const jar = path.join(root, "versions", n, n + ".jar");
    if (!fs.existsSync(jar)) continue;
    const z = new AdmZip(jar);
    if (z.getEntry("assets/minecraft/textures/entity/player/wide/steve.png") || z.getEntry("assets/minecraft/textures/entity/steve.png")) return jar;
  }
  return null;
}

async function getDefaultSkins(root) {
  let jar = await findSkinJar(root);
  if (!jar) {
    const man = await getJson(MANIFEST);
    const id = man.latest.release;
    await ensureVanilla(root, id, () => {});
    jar = path.join(root, "versions", id, id + ".jar");
  }
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const out = [];
  for (const e of new AdmZip(jar).getEntries()) {
    let m = e.entryName.match(/^assets\/minecraft\/textures\/entity\/player\/(wide|slim)\/(\w+)\.png$/);
    let model = m && (m[1] === "slim" ? "slim" : "classic");
    if (!m) {
      m = e.entryName.match(/^assets\/minecraft\/textures\/entity\/(steve|alex)\.png$/);
      if (m) { m = [m[0], m[1] === "alex" ? "slim" : "wide", m[1]]; model = m[1] === "slim" ? "slim" : "classic"; }
    }
    if (!m) continue;
    out.push({ id: `${m[1]}-${m[2]}`, name: cap(m[2]), model, data: "data:image/png;base64," + e.getData().toString("base64") });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.model.localeCompare(b.model));
}

async function uploadSkin(token, data, model) {
  const png = dataToPng(data);
  checkPng(png);
  const fd = new FormData();
  fd.append("variant", model === "slim" ? "slim" : "classic");
  fd.append("file", new Blob([png], { type: "image/png" }), "skin.png");
  const r = await fetch("https://api.minecraftservices.com/minecraft/profile/skins", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: fd,
  });
  if (!r.ok) throw new Error(`Mojang отклонил загрузку скина (HTTP ${r.status}). Возможно, нужно войти в Microsoft заново.`);
}

/* ───── Java, плащи, очистка ───── */
async function javaStatus(root, mc) {
  const all = await getJson(JAVA_ALL);
  const comps = all["windows-x64"] || {};
  const list = Object.entries(comps).filter(([, a]) => a.length).map(([id, a]) => {
    const name = a[0].version?.name || "";
    const m = name.match(/^1\.(\d+)/) || name.match(/^(\d+)/);
    return { id, version: name, major: m ? +m[1] : 0, installed: fs.existsSync(path.join(root, "runtime", id, ".ok")) };
  }).sort((a, b) => a.major - b.major);
  let required = null;
  if (mc) {
    try {
      const vjson = path.join(root, "versions", mc, mc + ".json");
      let v;
      if (fs.existsSync(vjson)) v = JSON.parse(await fsp.readFile(vjson, "utf8"));
      else {
        const man = await getJson(MANIFEST);
        const e = man.versions.find((x) => x.id === mc);
        if (e) v = await getJson(e.url);
      }
      if (v) required = { component: v.javaVersion?.component || "jre-legacy", major: v.javaVersion?.majorVersion || 8 };
    } catch {}
  }
  return { list, required };
}

async function installJava(root, component, send) {
  const all = await getJson(JAVA_ALL);
  if (!all["windows-x64"]?.[component]?.length) throw new Error("Неизвестная версия Java");
  await ensureJava(root, { javaVersion: { component } }, send);
}

async function getCapes(token) {
  const r = await fetch("https://api.minecraftservices.com/minecraft/profile", { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error(`Mojang не отдал профиль (HTTP ${r.status}). Возможно, нужно войти в Microsoft заново.`);
  const j = await r.json();
  const out = [];
  for (const c of j.capes || []) {
    try {
      const img = await fetch(c.url);
      out.push({ id: c.id, alias: c.alias, active: c.state === "ACTIVE", data: "data:image/png;base64," + Buffer.from(await img.arrayBuffer()).toString("base64") });
    } catch {}
  }
  return out;
}

async function setCape(token, capeId) {
  const url = "https://api.minecraftservices.com/minecraft/profile/capes/active";
  const r = capeId
    ? await fetch(url, { method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ capeId }) })
    : await fetch(url, { method: "DELETE", headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error(`Mojang отклонил смену плаща (HTTP ${r.status})`);
}

async function pathStat(p) {
  let st;
  try { st = await fsp.stat(p); } catch { return { bytes: 0, count: 0 }; }
  if (!st.isDirectory()) return { bytes: st.size, count: 1 };
  let bytes = 0, count = 0;
  for (const e of await fsp.readdir(p)) {
    const r = await pathStat(path.join(p, e));
    bytes += r.bytes;
    count += r.count;
  }
  return { bytes, count };
}

async function listDir(p) {
  try { return (await fsp.readdir(p)).map((n) => path.join(p, n)); } catch { return []; }
}

async function brokenConfigs(dir) {
  const out = [];
  for (const f of await listDir(dir)) {
    let st;
    try { st = await fsp.stat(f); } catch { continue; }
    if (st.isDirectory()) { out.push(...(await brokenConfigs(f))); continue; }
    if (st.size === 0) { out.push(f); continue; }
    if (f.toLowerCase().endsWith(".json") && st.size < 1024 * 1024) {
      const txt = await fsp.readFile(f, "utf8");
      if (/\/\/|\/\*/.test(txt)) continue; // JSON с комментариями не трогаем
      try { JSON.parse(txt); } catch { out.push(f); }
    }
  }
  return out;
}

async function cleanTargets(root, dir, pack) {
  const t = [];
  t.push({ id: "logs", title: "Логи игры", hint: "Файлы в папке logs. Игра создаст новые.", safe: true, paths: await listDir(path.join(dir, "logs")) });
  const hs = (await listDir(dir)).filter((f) => /^hs_err_pid.*\.log$/.test(path.basename(f)));
  t.push({ id: "crash", title: "Отчёты о сбоях", hint: "Папка crash-reports и файлы hs_err_pid*.log.", safe: true, paths: [...(await listDir(path.join(dir, "crash-reports"))), ...hs] });
  const tmp = (await listDir(os.tmpdir())).filter((f) => /^ply-.*\.mrpack$/.test(path.basename(f)));
  t.push({ id: "temp", title: "Временные файлы лаунчера", hint: "Остатки скачивания сборок Modrinth.", safe: true, paths: tmp });
  t.push({ id: "installers", title: "Установщики Forge и NeoForge", hint: "Нужны только при установке. Если понадобятся снова, скачаются заново.", safe: true, paths: await listDir(path.join(root, "installers")) });
  let shaders = [];
  if (!pack.mrpack) {
    let managed = [];
    try { managed = JSON.parse(await fsp.readFile(path.join(dir, ".managed.json"), "utf8")); } catch {}
    const keep = new Set(managed.map((m) => path.basename(m.replace(/\\/g, "/"))));
    shaders = (await listDir(path.join(dir, "shaderpacks"))).filter((f) => {
      const n = path.basename(f);
      return !keep.has(n) && !n.endsWith(".txt");
    });
  }
  t.push({ id: "shaders", title: "Лишние шейдеры", hint: "Шейдеры, которых нет в списке сборки (например, добавленные вручную). Проверьте, прежде чем удалять.", safe: false, paths: shaders });
  t.push({ id: "configs", title: "Пустые и повреждённые настройки", hint: "Файлы в папке config. Мод создаст их заново со значениями по умолчанию.", safe: false, paths: await brokenConfigs(path.join(dir, "config")) });
  return t;
}

async function cleanScan(root, dir, pack) {
  const out = [];
  for (const c of await cleanTargets(root, dir, pack)) {
    let bytes = 0, count = 0;
    for (const p of c.paths) {
      const r = await pathStat(p);
      bytes += r.bytes;
      count += r.count;
    }
    out.push({ id: c.id, title: c.title, hint: c.hint, safe: c.safe, bytes, count });
  }
  return out;
}

async function cleanRun(root, dir, pack, cats) {
  let freed = 0;
  for (const c of await cleanTargets(root, dir, pack)) {
    if (!cats.includes(c.id)) continue;
    for (const p of c.paths) {
      const r = await pathStat(p);
      try { await fsp.rm(p, { recursive: true, force: true }); freed += r.bytes; } catch {}
    }
  }
  return { freed };
}

/* ───── Игровые настройки без захода в Minecraft ───── */
async function setOptions(dir, kv) {
  const file = path.join(dir, "options.txt");
  let txt = "";
  try { txt = await fsp.readFile(file, "utf8"); } catch {}
  const lines = txt.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  for (const [k, v] of Object.entries(kv)) {
    const i = lines.findIndex((l) => l.startsWith(k + ":"));
    if (i >= 0) lines[i] = `${k}:${v}`; else lines.push(`${k}:${v}`);
  }
  await fsp.writeFile(file, lines.join("\n") + "\n");
}

// Дальность прорисовки и яркость записываются в options.txt перед запуском (fullbright только для Plus)
async function applyGameOptions(dir, settings, plus) {
  const kv = {};
  const marker = path.join(dir, ".plyprism-gamma");
  const rd = Number(settings?.renderDistance);
  if (settings?.renderDistance != null && Number.isInteger(rd) && rd >= 2 && rd <= 32) kv.renderDistance = rd;
  if (plus && settings?.fullbright) {
    kv.gamma = "15.0";
    await fsp.writeFile(marker, "1");
  } else if (fs.existsSync(marker)) { // fullbright выключили: возвращаем обычную яркость
    kv.gamma = "1.0";
    await fsp.rm(marker, { force: true });
  }
  if (Object.keys(kv).length) await setOptions(dir, kv);
}

/* ───── Ответ ИИ: разбор и проверка ───── */
function parseAiReply(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let j;
  try { j = JSON.parse(t); } catch {
    const m = t.match(/\{[\s\S]*\}/);
    try { j = m && JSON.parse(m[0]); } catch {}
  }
  if (!j || typeof j !== "object") return { reply: String(text).slice(0, 1500), pack: null };
  const list = (a, n) => (Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter((x) => x && x.length <= 60).slice(0, n);
  const p = j.pack;
  let pack = null;
  if (p && typeof p === "object" && /^\d+\.\d+(\.\d+)?$/.test(String(p.mc)) && ["fabric", "quilt", "forge", "neoforge"].includes(p.loader)) {
    pack = { name: String(p.name || "Сборка ИИ").slice(0, 40), mc: String(p.mc), loader: p.loader,
      mods: list(p.mods, 25), shaders: list(p.shaders, 3), resourcepacks: list(p.resourcepacks, 3) };
  }
  return { reply: String(j.reply || "").slice(0, 1500), pack };
}

/* ───── главная функция ───── */
async function play({ root, dir, pack, auth, skin, plus, send, onExit }) {
  await fsp.mkdir(dir, { recursive: true });
  let { mc, loader } = pack;
  let loaderVersion = null;

  if (pack.mrpack) {
    const info = await installMrpack(pack, dir, send);
    ({ mc, loader, loaderVersion } = info);
  }
  await syncItems(pack, dir, send);
  await applySkinPack(dir, mc, auth.type === "legacy" ? skin : null); // скин для офлайн-аккаунта
  await applyGameOptions(dir, pack.settings, plus);

  const vanilla = await ensureVanilla(root, mc, send);
  const id = loader === "vanilla" ? mc : await ensureLoader(root, loader, mc, loaderVersion, vanilla, send);
  const v = await loadMerged(root, id);

  const nativesDir = path.join(root, "versions", id, "natives");
  const libs = listLibs(v);
  await ensureLibraries(root, libs, nativesDir, send);
  await ensureAssets(root, v, send);
  const logArg = await ensureLogConfig(root, v);
  const java = await ensureJava(root, v, send);

  send("Запускаем Minecraft…");
  const clientJar = path.join(root, "versions", v.baseId, v.baseId + ".jar");
  const cp = [...new Set([...libs.filter((l) => !l.native).map((l) => path.join(root, "libraries", l.path)), clientJar])].join(";");
  const vars = {
    auth_player_name: auth.name,
    version_name: v.baseId, // Forge/NeoForge сверяют по этому имени, какой jar игнорировать
    game_directory: dir,
    assets_root: path.join(root, "assets"),
    assets_index_name: v.assetIndex.id,
    auth_uuid: auth.uuid.replace(/-/g, ""),
    auth_access_token: auth.token,
    auth_session: auth.token,
    user_type: auth.type,
    version_type: v.type || "release",
    natives_directory: nativesDir,
    launcher_name: "PlyPrismLauncher",
    launcher_version: "2.1.0",
    classpath: cp,
    library_directory: path.join(root, "libraries"),
    classpath_separator: ";",
    clientid: "0",
    auth_xuid: "0",
    user_properties: "{}",
    game_assets: path.join(root, "assets", "virtual", "legacy"),
  };
  const extra = [`-Xmx${pack.ram || 3072}M`, "-Xms512M"];
  if (logArg) extra.push(logArg);
  const args = buildArgs(v, vars, extra);

  await fsp.mkdir(path.join(dir, "logs"), { recursive: true });
  const logPath = path.join(dir, "logs", "launcher.log");
  const out = fs.openSync(logPath, "w");
  const child = spawn(java, [...args.jvm, v.mainClass, ...args.game], { cwd: dir, stdio: ["ignore", out, out], windowsHide: true });
  await new Promise((res, rej) => {
    child.once("spawn", res);
    child.once("error", rej);
  });
  child.on("exit", (code) => onExit(code, logPath, child.pid));
  return { mc, loader, pid: child.pid };
}

module.exports = { play, applyGameOptions, parseAiReply, getDefaultSkins, uploadSkin, applySkinPack, javaStatus, installJava, getCapes, setCape, cleanScan, cleanRun };
