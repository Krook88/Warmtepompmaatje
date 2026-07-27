#!/usr/bin/env node
/**
 * Koppelt elke warmtepomp aan de officiële ISDE-meldcodelijst van RVO.
 *
 * Waarom dit bestaat: het subsidiebedrag in data/warmtepompen.json was een
 * schatting. Leidend is het bedrag dat RVO per meldcode publiceert, en dat
 * wijkt er in de praktijk van af. Een bezoeker die op onze indicatie rekent en
 * bij zijn aanvraag een lager bedrag krijgt, is terecht boos.
 *
 * De bron is data/bronnen/isde-meldcodes.csv: de lucht/water-regels uit de
 * meldcodelijst van RVO, die maandelijks wordt bijgewerkt. Verversen gaat zo:
 * download het Excel-bestand van
 * https://www.rvo.nl/subsidies-financiering/isde/meldcodelijsten/warmtepompen
 * en draai `npm run isde:ververs <pad-naar-xlsx>`.
 *
 * Gebruik:
 *   node scripts/isde-meldcodes.mjs            rapport, schrijft niets
 *   node scripts/isde-meldcodes.mjs --schrijf  neemt de zekere treffers over
 *
 * Het script schrijft alleen bij een eenduidige treffer. Twijfelgevallen komen
 * in het rapport met hun kandidaten, zodat een mens kiest; automatisch de
 * "beste" gok overnemen is precies hoe er verkeerde bedragen in komen.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHRIJVEN = process.argv.includes("--schrijf");

/* ------------------------------------------------------------------
   CSV inlezen

   Modelnamen bij RVO bevatten komma's en aanhalingstekens (bijvoorbeeld
   "VITOCAL 250-A AWO-E-AC 251.A16, 3-fase"). Een regel op komma's splitsen
   levert daar stille onzin op: het bedrag schuift een kolom op en er komt
   € 12 subsidie uit. Vandaar een echte parser die aanhalingstekens
   respecteert.
   ------------------------------------------------------------------ */

const VERWACHTE_KOP = "meldcode,merk,model,vermogen_kw,subsidie_eur,subsidie_2e_eur,koudemiddel,gwp";

function splitsCsvRegel(regel) {
  const velden = [];
  let veld = "";
  let inAanhaling = false;
  for (let i = 0; i < regel.length; i++) {
    const teken = regel[i];
    if (inAanhaling) {
      if (teken === '"') {
        if (regel[i + 1] === '"') { veld += '"'; i++; }   // verdubbeld = letterlijk
        else inAanhaling = false;
      } else veld += teken;
    } else if (teken === '"') {
      inAanhaling = true;
    } else if (teken === ",") {
      velden.push(veld); veld = "";
    } else veld += teken;
  }
  velden.push(veld);
  return velden;
}

function leesMeldcodes() {
  const pad = resolve(ROOT, "data/bronnen/isde-meldcodes.csv");
  const inhoud = readFileSync(pad, "utf8").trim();
  const regels = inhoud.split(/\r?\n/);
  if (regels[0].trim() !== VERWACHTE_KOP) {
    throw new Error(`Onverwachte kolommen in ${pad}.\n  verwacht: ${VERWACHTE_KOP}\n  gevonden: ${regels[0]}`);
  }
  return regels.slice(1).map((r) => {
    const [meldcode, merk, model, vermogen_kw, subsidie_eur, subsidie_2e_eur, koudemiddel, gwp] = splitsCsvRegel(r);
    return {
      meldcode, merk, gwp,
      // Sommige namen staan bij RVO tussen losse aanhalingstekens.
      model: String(model || "").replace(/^"+|"+$/g, "").trim(),
      koudemiddel,
      vermogen_kw: Number(vermogen_kw) || null,
      subsidie_eur: Number(subsidie_eur) || null,
      subsidie_2e_eur: Number(subsidie_2e_eur) || null,
    };
  });
}

/* ------------------------------------------------------------------
   Matchen
   ------------------------------------------------------------------ */

// RVO schrijft merken net anders dan wij. Alleen echte verschillen staan
// hier; hoofdletters en leestekens worden sowieso genegeerd.
const MERK_ALIAS = {
  "weheat": "weheat",
  "stiebeleltron": "stiebeleltron",
  "mitsubishielectric": "mitsubishielectric",
  "ithodaalderop": "ithodaalderop",
};

const normaliseer = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Woorden waarop we niet willen matchen: ze staan in bijna elke modelnaam en
// maken elke kandidaat even goed.
const RUIS = new Set(["kw", "warmtepomp", "monoblock", "mono", "a", "s", "t", "v", "230v", "400v"]);

const woorden = (s) =>
  String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !RUIS.has(w));

/**
 * Score van 0 tot 1: welk deel van onze modelwoorden komt terug in de
 * RVO-naam. Het vermogen weegt apart mee, want merken hergebruiken hun
 * modelnaam over de hele reeks.
 */
function score(pomp, regel) {
  // Staat onze modelnaam er letterlijk zo, dan is verder wegen zinloos:
  // "Amber 95" hoort bij "Amber 95" en niet bij "Amber 120".
  if (normaliseer(regel.model) === normaliseer(pomp.model)) return 2;

  const onze = woorden(`${pomp.model} ${pomp.voorbeeld_variant || ""}`);
  if (!onze.length) return 0;
  const hunne = woorden(regel.model);
  const raak = onze.filter((w) => hunne.includes(w)).length;
  let s = raak / onze.length;

  // Basisuitvoering wint van een bijzondere variant met dezelfde woorden erin
  // ("Elga Ace 4 kW" boven "Elga Ace All-in-one 4"), tenzij die extra woorden
  // ook bij ons voorkomen.
  const extra = hunne.filter((w) => !onze.includes(w)).length;
  s -= extra * 0.06;

  // RVO noemt het vermogen volgens EU 811/2013; dat ligt vaak een stap lager
  // dan de marketingnaam. Daarom een ruime marge en geen harde eis.
  if (pomp.vermogen_kw && regel.vermogen_kw) {
    const verschil = Math.abs(pomp.vermogen_kw - regel.vermogen_kw);
    if (verschil <= 1) s += 0.30;
    else if (verschil <= 2) s += 0.15;
    else if (verschil > 4) s -= 0.30;
  }
  return s;
}

function kandidaten(pomp, meldcodes) {
  const merk = MERK_ALIAS[normaliseer(pomp.merk)] || normaliseer(pomp.merk);
  const vanMerk = meldcodes.filter((r) => {
    const m = normaliseer(r.merk);
    return m === merk || m.startsWith(merk) || merk.startsWith(m);
  });
  return vanMerk
    .map((r) => ({ ...r, score: score(pomp, r) }))
    .filter((r) => r.score > 0.35)
    .sort((a, b) => b.score - a.score);
}

/* ------------------------------------------------------------------ */

const eur = (n) => (n == null ? "?" : `€${n.toLocaleString("nl-NL")}`);

function main() {
  const meldcodes = leesMeldcodes();
  const padData = resolve(ROOT, "data/warmtepompen.json");
  const data = JSON.parse(readFileSync(padData, "utf8"));

  let zeker = 0, twijfel = 0, geen = 0, gewijzigd = 0;

  for (const pomp of data.warmtepompen) {
    // Handmatig vastgelegde meldcode gaat voor. Merken als Panasonic, LG,
    // Samsung, Gree en Mitsubishi registreren bij RVO onder een technische
    // typecode (KIT-ADC05JE5, HM051MR) in plaats van de naam waaronder ze
    // verkocht worden. Daar valt niets aan te matchen; die vult een mens
    // eenmalig in, en vanaf dan controleert dit script het bedrag.
    if (pomp.isde_meldcode) {
      const regel = meldcodes.find((r) => r.meldcode === pomp.isde_meldcode);
      if (!regel) {
        geen++;
        console.log(`\n[ meldcode weg ] ${pomp.id}  (${pomp.isde_meldcode})`);
        console.log(`    Staat niet meer op de lijst - product vervallen of code gewijzigd. Nakijken.`);
        continue;
      }
      zeker++;
      const afwijkt = pomp.isde_indicatie_eur !== regel.subsidie_eur;
      console.log(`\n[ ${afwijkt ? "!" : "="} vastgelegd ] ${pomp.id}  ->  ${regel.meldcode}  ${regel.model} (${regel.vermogen_kw} kW)`);
      console.log(`    ISDE: ${eur(pomp.isde_indicatie_eur)} op de site  ->  ${eur(regel.subsidie_eur)} volgens RVO${afwijkt ? "   << WIJKT AF" : ""}`);
      if (SCHRIJVEN && afwijkt) { pomp.isde_indicatie_eur = regel.subsidie_eur; gewijzigd++; }
      continue;
    }

    const lijst = kandidaten(pomp, meldcodes);
    const beste = lijst[0];
    const eenduidig = beste && (lijst.length === 1 || beste.score - lijst[1].score >= 0.25);

    if (!beste) {
      geen++;
      console.log(`\n[ geen treffer ] ${pomp.id}  (${pomp.merk} ${pomp.model}, ${pomp.vermogen_kw} kW)`);
      console.log(`    huidige indicatie: ${eur(pomp.isde_indicatie_eur)} - niet te controleren tegen de lijst`);
      continue;
    }

    const afwijking = pomp.isde_indicatie_eur && beste.subsidie_eur !== pomp.isde_indicatie_eur;

    if (eenduidig) {
      zeker++;
      const teken = afwijking ? "!" : "=";
      console.log(`\n[ ${teken} zeker ] ${pomp.id}  ->  ${beste.meldcode}  ${beste.model} (${beste.vermogen_kw} kW, ${beste.koudemiddel})`);
      console.log(`    ISDE: ${eur(pomp.isde_indicatie_eur)} op de site  ->  ${eur(beste.subsidie_eur)} volgens RVO${afwijking ? "   << WIJKT AF" : ""}`);
      if (SCHRIJVEN) {
        if (afwijking) gewijzigd++;
        pomp.isde_indicatie_eur = beste.subsidie_eur;
        pomp.isde_meldcode = beste.meldcode;
      }
    } else {
      twijfel++;
      console.log(`\n[ twijfel ] ${pomp.id}  (${pomp.merk} ${pomp.model}, ${pomp.vermogen_kw} kW) - kies zelf:`);
      for (const k of lijst.slice(0, 4)) {
        console.log(`    ${k.meldcode}  ${k.model.padEnd(42)} ${String(k.vermogen_kw).padStart(3)} kW  ${eur(k.subsidie_eur).padStart(8)}  (score ${k.score.toFixed(2)})`);
      }
    }
  }

  console.log(`\n${"-".repeat(70)}`);
  console.log(`zeker: ${zeker}   twijfel: ${twijfel}   geen treffer: ${geen}`);

  if (SCHRIJVEN) {
    writeFileSync(padData, JSON.stringify(data, null, 2) + "\n", "utf8");
    console.log(`Geschreven: ${zeker} meldcode(s), waarvan ${gewijzigd} met een gecorrigeerd bedrag.`);
  } else {
    console.log("Rapport, er is niets gewijzigd. Draai met --schrijf om de zekere treffers over te nemen.");
  }
}

main();
