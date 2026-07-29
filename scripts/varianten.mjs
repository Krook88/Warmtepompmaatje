#!/usr/bin/env node
/**
 * Vult per warmtepomp de andere uitvoeringen van dezelfde reeks in.
 *
 * Waarom: de site toont één variant per model, maar de merken leveren hun
 * reeksen in meerdere vermogens. Van de 940 modellen die onze 23 merken op de
 * ISDE-lijst hebben staan, tonen wij er 25. Wie een groter huis heeft en 11 kW
 * nodig heeft, ziet daardoor een kaart van 6 kW en denkt dat het niet bestaat.
 *
 * Losse kaarten per maat zouden de vergelijking vertroebelen - dan staat
 * dezelfde pomp er vijf keer in. In plaats daarvan krijgt elke kaart de reeks
 * erbij, met het subsidiebedrag per uitvoering. Dat laatste is de vraag waar
 * een bezoeker echt mee zit: wat levert de ISDE op voor de maat die ik nodig heb.
 *
 * Let op de eenheid. Het vermogen op onze kaarten is de marketingaanduiding
 * (een "NIBE S2125-8" heet 8 kW); RVO rekent met het opgegeven vermogen
 * volgens EU 811/2013, en dat ligt vaak een stap lager. De twee getallen naast
 * elkaar zetten zonder uitleg zou verwarrend zijn, dus de reeks wordt getoond
 * met het subsidiebedrag als hoofdzaak en het vermogen expliciet gelabeld als
 * dat van de ISDE-lijst.
 *
 * Gebruik:
 *   node scripts/varianten.mjs            rapport, schrijft niets
 *   node scripts/varianten.mjs --schrijf  neemt de gevonden reeksen over
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHRIJVEN = process.argv.includes("--schrijf");

const VERWACHTE_KOP = "meldcode,merk,model,vermogen_kw,subsidie_eur,subsidie_2e_eur,koudemiddel,gwp";

function splitsCsvRegel(regel) {
  const velden = [];
  let veld = "", inAanhaling = false;
  for (let i = 0; i < regel.length; i++) {
    const t = regel[i];
    if (inAanhaling) {
      if (t === '"') { if (regel[i + 1] === '"') { veld += '"'; i++; } else inAanhaling = false; }
      else veld += t;
    } else if (t === '"') inAanhaling = true;
    else if (t === ",") { velden.push(veld); veld = ""; }
    else veld += t;
  }
  velden.push(veld);
  return velden;
}

function leesMeldcodes() {
  const pad = resolve(ROOT, "data/bronnen/isde-meldcodes.csv");
  const regels = readFileSync(pad, "utf8").trim().split(/\r?\n/);
  if (regels[0].trim() !== VERWACHTE_KOP) throw new Error(`Onverwachte kolommen in ${pad}`);
  return regels.slice(1).map((r) => {
    const [meldcode, merk, model, vermogen_kw, subsidie_eur] = splitsCsvRegel(r);
    return {
      meldcode, merk,
      model: String(model || "").replace(/^"+|"+$/g, "").trim(),
      vermogen_kw: Number(vermogen_kw) || null,
      subsidie_eur: Number(subsidie_eur) || null,
    };
  });
}

/**
 * De naam van de reeks: de modelnaam zonder de maataanduiding.
 *
 * "Elga Ace 4 kW" en "Elga Ace 6 kW" horen bij elkaar, "Amber 95" en
 * "Amber 120" ook. Alle cijfers wegstrepen werkt niet overal: bij een naam als
 * "S2125-8" blijft dan alleen "S" over, en dat matcht met van alles. Daarom
 * valt het terug op de naam mét typenummer zodra er te weinig letters resten.
 */
function reeksNaam(model) {
  const zonderMaat = String(model)
    .replace(/\(.*?\)/g, " ")
    .replace(/\b[\d.,]+\s*kw\b/gi, " ")
    .replace(/[-\s]\d{1,3}(?:\.\d)?\s*$/, " ");
  const letters = zonderMaat.replace(/[^a-z]+/gi, " ").trim().toLowerCase();
  if (letters.replace(/\s/g, "").length >= 3) return letters;
  return String(model)
    .replace(/[-\s]\d{1,3}\s*$/, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function main() {
  const meldcodes = leesMeldcodes();
  const perCode = new Map(meldcodes.map((r) => [r.meldcode, r]));
  const padData = resolve(ROOT, "data/warmtepompen.json");
  const data = JSON.parse(readFileSync(padData, "utf8"));

  let meerdere = 0, enkel = 0, gewijzigd = 0;

  for (const pomp of data.warmtepompen) {
    const eigen = perCode.get(pomp.isde_meldcode);
    if (!eigen) {
      console.log(`\n[ geen meldcode ] ${pomp.id} - overgeslagen`);
      continue;
    }
    const reeks = reeksNaam(eigen.model);
    const leden = meldcodes
      .filter((r) => r.merk === eigen.merk && r.vermogen_kw && reeksNaam(r.model) === reeks)
      .sort((a, b) => a.vermogen_kw - b.vermogen_kw);

    // Eén regel per vermogen: varianten die alleen in fase of boilerinhoud
    // verschillen leveren hetzelfde subsidiebedrag en zouden de lijst vullen.
    const perVermogen = new Map();
    for (const r of leden) if (!perVermogen.has(r.vermogen_kw)) perVermogen.set(r.vermogen_kw, r);
    const varianten = [...perVermogen.values()].map((r) => ({
      vermogen_kw: r.vermogen_kw,
      isde_eur: r.subsidie_eur,
      meldcode: r.meldcode,
    }));

    if (varianten.length <= 1) {
      enkel++;
      console.log(`\n[ enkel ] ${pomp.id} - deze reeks bestaat in één uitvoering`);
      if (SCHRIJVEN) delete pomp.varianten;
      continue;
    }

    meerdere++;
    const kw = varianten.map((v) => v.vermogen_kw);
    const isde = varianten.map((v) => v.isde_eur).filter(Boolean);
    console.log(`\n[ ${varianten.length} uitvoeringen ] ${pomp.id}  (reeks "${reeks}")`);
    console.log(`    vermogen volgens ISDE-lijst: ${kw.join(", ")} kW   (onze kaart noemt ${pomp.vermogen_kw} kW)`);
    console.log(`    ISDE: €${Math.min(...isde)} tot €${Math.max(...isde)}`);
    if (SCHRIJVEN) { pomp.varianten = varianten; gewijzigd++; }
  }

  console.log(`\n${"-".repeat(70)}`);
  console.log(`reeksen met meerdere uitvoeringen: ${meerdere}   enkelvoudig: ${enkel}`);
  if (SCHRIJVEN) {
    writeFileSync(padData, JSON.stringify(data, null, 2) + "\n", "utf8");
    console.log(`Geschreven: ${gewijzigd} pomp(en) met een variantenreeks.`);
  } else {
    console.log("Rapport, er is niets gewijzigd. Draai met --schrijf om over te nemen.");
  }
}

main();
