// Preset switcher untuk Meridian.
// Pakai: node switch-preset.js <meridian|arcana|emperor> [--preview]
import fs from "fs";

const which = (process.argv[2] || "").toLowerCase();
const preview = process.argv.includes("--preview");

const available = fs.readdirSync("./presets").filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

if (!available.includes(which)) {
  console.error(`Preset tidak dikenal: "${which}"`);
  console.error("Tersedia:", available.join(", "));
  process.exit(1);
}

let preset, cfg;
try {
  preset = JSON.parse(fs.readFileSync(`./presets/${which}.json`, "utf8"));
  cfg = JSON.parse(fs.readFileSync("./user-config.json", "utf8"));
} catch (e) {
  console.error("Gagal baca file:", e.message);
  process.exit(1);
}

const overrides = preset.overrides || {};
console.log(`\n=== Preset: ${preset.label || preset.name} ===`);
console.log(preset.description + "\n");

let changed = 0;
for (const [k, v] of Object.entries(overrides)) {
  const before = cfg[k];
  if (before !== v) changed++;
  const mark = before !== v ? " *" : "";
  console.log(`  ${k.padEnd(20)} ${String(before).padStart(6)} -> ${String(v).padStart(6)}${mark}`);
  cfg[k] = v;
}
cfg.preset = preset.name;

if (preview) {
  console.log(`\n(preview — ${changed} perubahan, tidak menulis apa pun)`);
  process.exit(0);
}

const backup = `./user-config.before-preset-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
fs.copyFileSync("./user-config.json", backup);
fs.writeFileSync("./user-config.json", JSON.stringify(cfg, null, 2) + "\n");
console.log(`\nTersimpan (${changed} berubah). Backup: ${backup}`);
console.log("Restart: pm2 restart meridian --update-env  (atau pakai ./switch-preset.sh)");
