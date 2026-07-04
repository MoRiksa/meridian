// shadow-sim.js — paper-simulation preset lain pada entry yang SAMA dengan posisi nyata.
// Menumpang PnL poller (0 API tambahan): hanya matematika dari data yang sudah ditarik.
//
// MODEL (perkiraan, bukan eksekusi on-chain):
//   Posisi single-side SOL bid: deposit tersebar UNIFORM di N bin di bawah harga entry.
//   Komposisi DLMM bersifat deterministik terhadap active bin saat ini:
//     - bin di atas active  -> sudah terkonversi jadi token (nilai turun saat harga turun)
//     - bin di bawah active -> masih SOL
//   IL% = (nilai_sekarang / deposit_awal - 1) * 100
//   Fee di-skala dari fee nyata dengan faktor kepadatan (N_nyata / N_preset).
//   Exit rules (trailing TP + stop loss) tiap preset disimulasikan per-tick (peak tracking).
//
// Semua dibungkus try/catch di pemanggil — TIDAK BOLEH memecahkan poll asli.

import fs from "fs";
import { repoPath } from "./repo-root.js";
import { getTrackedPosition } from "./state.js";

const FILE = repoPath("shadow-sim.json");

// Definisi preset (harus selaras dengan presets/*.json).
export const SHADOW_PRESETS = {
  meridian: { label: "Meridian (default)", bins: 69, trigger: 3, drop: 1.5, sl: -50 },
  arcana:   { label: "Arcana (menengah)",  bins: 35, trigger: 1, drop: 1.25, sl: -7 },
  emperor:  { label: "Emperor (agresif)",  bins: 20, trigger: 1, drop: 1.25, sl: -7 },
};

let _state = null;
function load() {
  if (_state) return _state;
  try {
    _state = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    _state = { updatedAt: null, positions: {} };
  }
  return _state;
}
function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(_state, null, 2));
  } catch {
    /* jangan pernah throw dari poller */
  }
}

// Fraksi nilai posisi single-side bid (1.0 = impas sebelum fee) pada active bin sekarang.
export function valueFraction(entryBin, N, binStep, activeBin) {
  const s = binStep / 10000;
  const L = 1 / N;
  let frac = 0;
  // N bin di bawah active saat deploy: b dari (entryBin - N) sampai (entryBin - 1)
  for (let b = entryBin - N; b <= entryBin - 1; b++) {
    if (activeBin >= b) frac += L;                       // masih SOL
    else frac += L * Math.pow(1 + s, activeBin - b);     // token, nilai kini (harga turun)
  }
  return frac;
}

// Hitung shadow untuk satu preset (IL model + fee tersimulasi).
export function presetPnl(preset, entryBin, binStep, activeBin, realFeePct, realBins) {
  const il = (valueFraction(entryBin, preset.bins, binStep, activeBin) - 1) * 100;
  // fee skala kepadatan: bin lebih sempit -> fee lebih tinggi. Hanya berlaku bila masih in-range.
  const inRange = activeBin >= entryBin - preset.bins && activeBin <= entryBin;
  const density = realBins > 0 ? realBins / preset.bins : 1;
  const fee = inRange ? realFeePct * density : realFeePct * density; // fee kumulatif (approx)
  return { il: round(il, 2), fee: round(fee, 2), pnl: round(il + fee, 2), inRange };
}

function round(v, d = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// Dipanggil tiap poll dengan array posisi (bentuk dari computePositions/getMyPositions).
export function updateShadowSim(positions) {
  const st = load();
  const seen = new Set();

  for (const p of positions || []) {
    const addr = p.position;
    if (!addr) continue;
    seen.add(addr);

    const tracked = getTrackedPosition(addr) || {};
    const br = tracked.bin_range || {};
    const entryBin = tracked.active_bin_at_deploy ?? br.max ?? p.active_bin;
    const binStep = tracked.bin_step ?? 100;
    const realBins = br.bins_below ?? 20;
    const activeBin = p.active_bin ?? entryBin;
    if (entryBin == null || activeBin == null) continue;

    // fee nyata (% dari deposit) untuk di-skala ke preset lain
    const feeUsd = (p.unclaimed_fees_usd || 0) + (p.collected_fees_usd || 0);
    const depositUsd = (p.total_value_usd || 0) + feeUsd - (p.pnl_usd || 0);
    const realFeePct = depositUsd > 0 ? (feeUsd / depositUsd) * 100 : 0;

    let entry = st.positions[addr];
    if (!entry || entry.entryBin !== entryBin) {
      entry = {
        pair: p.pair, entryBin, binStep, realBins,
        deployedAt: tracked.deployed_at || new Date().toISOString(),
        realPnlPct: p.pnl_pct,
        presets: {}
      };
      for (const name of Object.keys(SHADOW_PRESETS)) {
        entry.presets[name] = { open: true, peak: 0, pnl: 0, il: 0, fee: 0, closedPnl: null, closedReason: null, closedAt: null };
      }
    }
    entry.pair = p.pair;
    entry.realPnlPct = p.pnl_pct;
    entry.updatedAt = new Date().toISOString();

    for (const [name, preset] of Object.entries(SHADOW_PRESETS)) {
      const sh = entry.presets[name] || (entry.presets[name] = { open: true, peak: 0, pnl: 0, il: 0, fee: 0, closedPnl: null, closedReason: null, closedAt: null });
      if (!sh.open) continue; // sudah "tutup" di simulasi — bekukan

      const r = presetPnl(preset, entryBin, binStep, activeBin, realFeePct, realBins);
      sh.pnl = r.pnl; sh.il = r.il; sh.fee = r.fee; sh.inRange = r.inRange;
      if (r.pnl > sh.peak) sh.peak = r.pnl;

      // exit rules
      if (r.pnl <= preset.sl) {
        sh.open = false; sh.closedPnl = r.pnl; sh.closedReason = `Stop loss (<= ${preset.sl}%)`; sh.closedAt = entry.updatedAt;
      } else if (sh.peak >= preset.trigger && r.pnl <= sh.peak - preset.drop) {
        sh.open = false; sh.closedPnl = r.pnl; sh.closedReason = `Trailing TP: peak ${round(sh.peak)}% -> ${round(r.pnl)}%`; sh.closedAt = entry.updatedAt;
      }
    }

    st.positions[addr] = entry;
  }

  // buang shadow untuk posisi yang sudah tidak terbuka
  for (const addr of Object.keys(st.positions)) {
    if (!seen.has(addr)) delete st.positions[addr];
  }

  st.updatedAt = new Date().toISOString();
  save();
}
