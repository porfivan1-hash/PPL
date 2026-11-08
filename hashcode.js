// Инструмент для кодов PlyPrismLauncher+ (в exe не попадает).
//   node hashcode.js 58317-857396-92057384   → хеш одного кода
//   node hashcode.js gen 10                   → 10 новых кодов и их хеши
// Хеши вставляйте в список PLUS_CODE_HASHES в main.js, сами коды публикуйте в Telegram.
const crypto = require("crypto");
const hash = (c) => crypto.createHash("sha256").update("plyprism+:" + String(c).replace(/\s+/g, "").toUpperCase()).digest("hex");
const digits = (n) => Array.from({ length: n }, () => crypto.randomInt(10)).join("");

if (process.argv[2] === "gen") {
  const n = Math.min(500, parseInt(process.argv[3] || "10", 10) || 10);
  const codes = Array.from({ length: n }, () => `${digits(5)}-${digits(6)}-${digits(8)}`);
  console.log("КОДЫ (для Telegram):\n" + codes.join("\n"));
  console.log("\nХЕШИ (для main.js):\n" + codes.map((c) => `  "${hash(c)}", // ${c.slice(0, 5)}-…`).join("\n"));
} else if (process.argv[2]) {
  console.log(hash(process.argv.slice(2).join("")));
} else {
  console.log("Использование: node hashcode.js КОД   или   node hashcode.js gen 10");
}
