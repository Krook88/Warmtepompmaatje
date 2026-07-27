#!/usr/bin/env node
/**
 * Controleert of de links op de site nog werken.
 *
 * Twee soorten, met een verschillende strengheid:
 *
 *   Interne links (pagina's, afbeeldingen, scripts, stylesheets) worden tegen
 *   de bestanden in de repository gehouden. Klopt er één niet, dan is dat
 *   altijd onze eigen fout, dus daar stopt het script mee met een foutcode.
 *
 *   Externe links (winkels, fabrikanten, bronnen) worden echt opgehaald. Die
 *   kunnen om allerlei redenen weigeren zonder dat er iets kapot is: een
 *   webshop die bots buiten houdt, een tijdelijke storing, een trage server.
 *   Daarom zijn die niet fataal, maar komen ze in een lijst die een mens
 *   bekijkt. Een winkel die zijn productpagina weghaalt is namelijk wél een
 *   probleem: de bezoeker klikt dan op "Bekijk aanbieding" en landt op een
 *   foutpagina, terwijl wij nog een prijs tonen.
 *
 * Gebruik:
 *   node scripts/controleer-links.mjs              alles
 *   node scripts/controleer-links.mjs --intern     alleen interne links (geen internet nodig)
 *   node scripts/controleer-links.mjs --streng     externe fouten geven ook een foutcode
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ALLEEN_INTERN = process.argv.includes("--intern");
const STRENG = process.argv.includes("--streng");

// Sommige winkels weigeren alles wat geen browser is. Een nette user-agent met
// contactmogelijkheid voorkomt dat we onnodig als bot worden geweerd.
const USER_AGENT =
  "Mozilla/5.0 (compatible; WarmtepompmaatjeLinkcheck/1.0; +https://warmtepompmaatje.nl/contact.html)";
const TIJDSLIMIET_MS = 20000;
const GELIJKTIJDIG = 4;
const PAUZE_PER_HOST_MS = 1500;

/* ------------------------------------------------------------------
   Bestanden verzamelen
   ------------------------------------------------------------------ */

function htmlBestanden(map = ROOT, gevonden = []) {
  for (const naam of readdirSync(map)) {
    if (naam === ".git" || naam === "node_modules" || naam === "api") continue;
    const pad = join(map, naam);
    if (statSync(pad).isDirectory()) htmlBestanden(pad, gevonden);
    else if (naam.endsWith(".html")) gevonden.push(pad);
  }
  return gevonden;
}

const VERWIJZING = /(?:href|src)="([^"]+)"/g;

function verwijzingen(html) {
  const uit = [];
  let m;
  while ((m = VERWIJZING.exec(html)) !== null) uit.push(m[1]);
  return uit;
}

/* ------------------------------------------------------------------
   Interne links
   ------------------------------------------------------------------ */

function controleerIntern() {
  const kapot = [];
  let gecontroleerd = 0;

  for (const bestand of htmlBestanden()) {
    const html = readFileSync(bestand, "utf8");
    const mapVanBestand = dirname(bestand);

    for (const ruw of verwijzingen(html)) {
      if (/^(https?:|mailto:|tel:|data:|#|\/\/)/i.test(ruw)) continue;

      // Ankers en cachebusters horen niet bij de bestandsnaam
      const pad = ruw.split("#")[0].split("?")[0];
      if (!pad) continue;

      const doel = pad.startsWith("/") ? join(ROOT, pad) : join(mapVanBestand, pad);
      gecontroleerd++;
      if (!existsSync(doel)) {
        kapot.push({ bestand: bestand.replace(ROOT + "/", ""), link: ruw });
      }
    }
  }

  console.log(`Interne links: ${gecontroleerd} gecontroleerd, ${kapot.length} kapot`);
  for (const k of kapot) console.log(`  x ${k.bestand} verwijst naar ${k.link}`);
  return kapot;
}

/* ------------------------------------------------------------------
   Externe links
   ------------------------------------------------------------------ */

function externeLinks() {
  const bronnen = new Map(); // url -> waar hij vandaan komt

  const noteer = (url, herkomst) => {
    if (!/^https?:/i.test(url)) return;
    if (!bronnen.has(url)) bronnen.set(url, herkomst);
  };

  const data = JSON.parse(readFileSync(resolve(ROOT, "data/warmtepompen.json"), "utf8"));
  for (const w of data.warmtepompen || []) {
    if (w.product_url) noteer(w.product_url, `${w.id} (fabrikant)`);
    for (const a of w.aanbiedingen || []) {
      if (a.url) noteer(a.url, `${w.id} @ ${a.winkel}`);
      if (a.affiliate_url) noteer(a.affiliate_url, `${w.id} @ ${a.winkel} (commissielink)`);
    }
  }

  for (const bestand of htmlBestanden()) {
    const kort = bestand.replace(ROOT + "/", "");
    for (const ruw of verwijzingen(readFileSync(bestand, "utf8"))) {
      if (/^https?:/i.test(ruw)) noteer(ruw, kort);
    }
  }

  return bronnen;
}

const laatsteHost = new Map();

async function wachtVoorHost(host) {
  const vorige = laatsteHost.get(host) || 0;
  const wachten = PAUZE_PER_HOST_MS - (Date.now() - vorige);
  if (wachten > 0) await new Promise((r) => setTimeout(r, wachten));
  laatsteHost.set(host, Date.now());
}

async function haalOp(url, methode) {
  const stop = AbortSignal.timeout(TIJDSLIMIET_MS);
  return fetch(url, {
    method: methode,
    redirect: "follow",
    signal: stop,
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "nl,en;q=0.8" },
  });
}

async function controleerUrl(url) {
  const host = new URL(url).host;
  await wachtVoorHost(host);
  try {
    // Eerst HEAD: scheelt bandbreedte bij de winkel. Niet elke server snapt
    // dat, dus bij een weigering alsnog GET proberen voordat we iets afkeuren.
    let reactie = await haalOp(url, "HEAD");
    if (reactie.status === 405 || reactie.status === 403 || reactie.status === 501) {
      reactie = await haalOp(url, "GET");
    }
    return { url, status: reactie.status, eind: reactie.url };
  } catch (fout) {
    return { url, status: 0, melding: fout.name === "TimeoutError" ? "geen antwoord binnen 20 seconden" : fout.message };
  }
}

async function controleerExtern(bronnen) {
  const lijst = [...bronnen.keys()];
  const uitkomsten = [];
  let volgende = 0;

  async function werker() {
    while (volgende < lijst.length) {
      const url = lijst[volgende++];
      const uitkomst = await controleerUrl(url);
      uitkomst.herkomst = bronnen.get(url);
      uitkomsten.push(uitkomst);
      const teken = uitkomst.status >= 200 && uitkomst.status < 400 ? "." : "x";
      process.stdout.write(teken);
    }
  }

  await Promise.all(Array.from({ length: GELIJKTIJDIG }, werker));
  process.stdout.write("\n");
  return uitkomsten;
}

/* ------------------------------------------------------------------ */

function samenvatting(regels) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, regels.join("\n") + "\n");
}

async function main() {
  const kapotIntern = controleerIntern();

  if (ALLEEN_INTERN) {
    if (kapotIntern.length) process.exit(1);
    return;
  }

  const bronnen = externeLinks();
  console.log(`\nExterne links: ${bronnen.size} adressen controleren...`);
  const uitkomsten = await controleerExtern(bronnen);

  // 401/403/429 betekent doorgaans "wij houden bots buiten", niet "de pagina
  // bestaat niet". Die apart houden, anders verdrinkt een echte 404 in de ruis.
  const stuk = uitkomsten.filter((u) => u.status === 0 || (u.status >= 400 && ![401, 403, 429].includes(u.status)));
  const geweerd = uitkomsten.filter((u) => [401, 403, 429].includes(u.status));
  const goed = uitkomsten.length - stuk.length - geweerd.length;

  console.log(`\n${goed} in orde, ${stuk.length} kapot, ${geweerd.length} niet te controleren (server weert bots)`);

  if (stuk.length) {
    console.log("\nKapotte links:");
    for (const u of stuk.sort((a, b) => a.herkomst.localeCompare(b.herkomst))) {
      console.log(`  ${u.status || "geen antwoord"}  ${u.herkomst}\n     ${u.url}${u.melding ? `  (${u.melding})` : ""}`);
    }
  }

  const regels = [`### Linkcontrole: ${goed} in orde, ${stuk.length} kapot`];
  if (stuk.length) {
    regels.push(
      "",
      "Een bezoeker die hierop klikt komt op een foutpagina terwijl wij nog een prijs tonen.",
      "",
      "| Waar | Status | Link |",
      "| --- | --- | --- |",
      ...stuk.map((u) => `| ${u.herkomst} | ${u.status || u.melding} | ${u.url} |`),
    );
  }
  if (geweerd.length) {
    regels.push("", `${geweerd.length} adres(sen) konden niet gecontroleerd worden omdat de server geautomatiseerde verzoeken weert.`);
  }
  samenvatting(regels);

  if (kapotIntern.length) process.exit(1);
  if (STRENG && stuk.length) process.exit(1);
}

main().catch((fout) => {
  console.error("Onverwachte fout:", fout);
  process.exit(1);
});
