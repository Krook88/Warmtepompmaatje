#!/usr/bin/env node
/**
 * Dagelijkse prijsupdate voor data/warmtepompen.json (Warmtepompmaatje).
 *
 * Voor elke aanbieding (winkel-URL) probeert dit script de actuele prijs van de
 * productpagina te lezen, in deze volgorde:
 *   1. JSON-LD structured data (schema.org Product/Offer) - meest betrouwbaar
 *   2. Meta-tags (og:price:amount, product:price:amount, itemprop="price")
 *   3. De productgegevens die de webshop als JSON in de pagina zet
 *   4. Een voorzichtige regex op de zichtbare tekst
 *
 * In het databestand staat het bedrag zoals de winkel het toont. Veel van deze
 * winkels zijn installateurs- en groothandelsshops die exclusief btw prijzen;
 * dat wordt herkend en vastgelegd met "btw_inbegrepen": false. Het omrekenen
 * naar inclusief btw gebeurt pas bij het tonen, in assets/prijs.js, zodat één
 * plek bepaalt welk bedrag de bezoeker ziet en waarom het afwijkt van de winkel.
 * De plausibiliteitscontrole hieronder vergelijkt wél altijd inclusief btw;
 * anders zou een winkel die overstapt op prijzen zonder btw een "daling" van
 * 21% lijken te tonen.
 *
 * Veiligheidsregels:
 *   - Een nieuwe prijs moet altijd binnen de absolute grenzen voor deze
 *     productgroep vallen, én binnen 40% tot 250% van de laatst bekende prijs.
 *   - Een prijs die ver van de richtprijs af ligt, wordt niet stil overgenomen:
 *     die dekt vrijwel altijd iets anders (alleen de buitenunit, of juist een
 *     set met boiler). Zulke gevallen worden gemeld voor handmatige controle.
 *   - Bij fouten of onduidelijke pagina's blijft de oude prijs staan en wordt
 *     "datum" niet bijgewerkt, zodat zichtbaar blijft hoe vers elke prijs is.
 *   - Het script faalt nooit hard op één winkel: fouten worden gelogd
 *     en de rest gaat door.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Per databestand: waar de productlijst staat en welke prijzen geloofwaardig
// zijn. Een hybride warmtepomp begint rond de € 1.500; een all-electric pomp
// met hoge aanvoertemperatuur loopt op tot circa € 16.000 inclusief btw.
const BESTANDEN = [
  { pad: resolve(__dirname, "../data/warmtepompen.json"), lijst: "warmtepompen", min: 1500, max: 16000 },
];

// Btw-tarief op warmtepompen (levering van het losse toestel).
const BTW = 1.21;

// Hoe ver een winkelprijs van de richtprijs mag afliggen voordat we hem
// verdacht vinden. Daaronder dekt de prijs meestal alleen de buitenunit,
// daarboven zit er een boiler of afgifteset in de aanbieding.
const RICHTPRIJS_ONDER = 0.7;
const RICHTPRIJS_BOVEN = 1.4;

const VANDAAG = new Date().toISOString().slice(0, 10);
const TIMEOUT_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Warmtepompmaatje-prijscheck/1.0";

/* ------------------------------------------------------------------
   Bol.com Marketing Catalog API (officiële partnerroute).
   Bol blokkeert gewone scraping (403); met partner-inloggegevens halen
   we prijzen op via de API. Zonder BOL_CLIENT_ID/BOL_CLIENT_SECRET in
   de omgeving wordt dit overgeslagen en blijft de oude prijs staan.
   Auth: https://api.bol.com/marketing/docs/catalog-api/authentication.html
   ------------------------------------------------------------------ */

const BOL_CLIENT_ID = process.env.BOL_CLIENT_ID || "";
const BOL_CLIENT_SECRET = process.env.BOL_CLIENT_SECRET || "";
let bolToken = null;

async function haalBolToken() {
  if (!BOL_CLIENT_ID || !BOL_CLIENT_SECRET) return null;
  if (bolToken) return bolToken;
  const res = await fetch("https://login.bol.com/token?grant_type=client_credentials", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${BOL_CLIENT_ID}:${BOL_CLIENT_SECRET}`).toString("base64"),
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`bol-token HTTP ${res.status}`);
  bolToken = (await res.json()).access_token;
  return bolToken;
}

// Defensief: vind de eerste plausibele price-waarde in de API-respons,
// zodat kleine wijzigingen in het responsformaat ons niet breken.
//
// De grenzen komen uit het databestand en niet uit een vaste marge: met een
// ondergrens van een paar tientjes pakt deze zoektocht net zo goed de
// verzendkosten of een los accessoire uit de respons als de productprijs.
function zoekPrijsInRespons(obj, grenzen) {
  if (obj == null || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const x of obj) { const p = zoekPrijsInRespons(x, grenzen); if (p) return p; }
    return null;
  }
  if (typeof obj.price === "number" && obj.price >= grenzen.min && obj.price <= grenzen.max) return obj.price;
  for (const k of Object.keys(obj)) {
    const p = zoekPrijsInRespons(obj[k], grenzen);
    if (p) return p;
  }
  return null;
}

async function bolApiPrijs(aanbieding, grenzen) {
  const token = await haalBolToken();
  if (!token) return null;
  // Query en fragment eerst weg: bol-links dragen vaak een ?bltgh=-parameter,
  // en dan staat het product-id niet meer aan het eind van de URL.
  const pad = (aanbieding.url || "").split(/[?#]/)[0];
  const m = pad.match(/\/(\d{8,})\/?$/);
  if (!m) { console.log(`  ~ bol-API: geen product-id herkend in ${aanbieding.url}`); return null; }
  const res = await fetch(`https://api.bol.com/marketing/catalog/v1/products/${m[1]}/offers/best?country-code=NL`, {
    headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
  });
  if (!res.ok) {
    console.log(`  ~ bol-API ${m[1]}: HTTP ${res.status} (respons kort: ${(await res.text()).slice(0, 120)})`);
    return null;
  }
  const prijs = zoekPrijsInRespons(await res.json(), grenzen);
  // Bol toont consumentenprijzen: altijd inclusief btw.
  return prijs ? { bedrag: Math.round(prijs), btw: "incl" } : null;
}

/* ------------------------------------------------------------------ */

async function haalPagina(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.6",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parsePrijsWaarde(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/[^\d.,]/g, "");
  if (!s) return null;
  // "1.234,56" (NL) -> 1234.56 ; "1234.56" -> 1234.56 ; "1.299" -> 1299
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  else if (/\.\d{3}$/.test(s)) s = s.replace(/\./g, "");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Toont deze pagina prijzen exclusief btw? Installateurs- en groothandelsshops
 * (Wasco, Installmat, CV Dump) doen dat standaard. We kijken alleen in de buurt
 * van de prijs zelf en niet in de hele pagina: onderaan staat bij bijna elke
 * webshop wel ergens een algemene voorwaarde met het woord "btw" in.
 */
function toontExclBtw(html) {
  const tekst = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;?/gi, " ");
  const excl = /\b(?:excl\.?|exclusief)\s*(?:\d+%\s*)?btw\b/i;
  const incl = /\b(?:incl\.?|inclusief)\s*(?:\d+%\s*)?btw\b/i;
  // Alleen als de pagina wél "excl. btw" zegt en nergens "incl. btw": winkels
  // die beide bedragen tonen, tonen de prijs die wij oppikken vrijwel altijd
  // inclusief btw.
  return excl.test(tekst) && !incl.test(tekst);
}

function prijsUitJsonLd(html) {
  const blokken = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const blok of blokken) {
    const inhoud = blok.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "");
    let data;
    try { data = JSON.parse(inhoud); } catch { continue; }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      const kandidaten = [item, ...(item["@graph"] || [])];
      for (const k of kandidaten) {
        if (!k || typeof k !== "object") continue;
        const offers = k.offers ? (Array.isArray(k.offers) ? k.offers : [k.offers]) : [];
        for (const offer of offers) {
          if (!offer || typeof offer !== "object") continue;
          // Een bedrag in dollars of ponden is niet de prijs die wij zoeken.
          const munt = offer.priceCurrency || offer.priceSpecification?.priceCurrency;
          if (munt && String(munt).toUpperCase() !== "EUR") continue;
          // Een uitverkocht product houdt vaak een oude prijs in de markup.
          const voorraad = String(offer.availability || "");
          if (/OutOfStock|Discontinued|SoldOut/i.test(voorraad)) continue;
          const p = parsePrijsWaarde(offer.price ?? offer.priceSpecification?.price ?? offer.lowPrice);
          if (!p) continue;
          // schema.org kan expliciet zeggen of de btw er al in zit.
          const btwVeld = offer.priceSpecification?.valueAddedTaxIncluded;
          return { bedrag: p, btw: btwVeld === false ? "excl" : btwVeld === true ? "incl" : null };
        }
      }
    }
  }
  return null;
}

function prijsUitMeta(html) {
  const patronen = [
    /<meta[^>]+(?:property|name)=["'](?:og:price:amount|product:price:amount)["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:price:amount|product:price:amount)["']/i,
    /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const p of patronen) {
    const m = html.match(p);
    if (m) {
      const prijs = parsePrijsWaarde(m[1]);
      if (prijs) return { bedrag: prijs, btw: null };
    }
  }
  return null;
}

/**
 * Uit de telling het vaakst voorkomende bedrag pakken; bij gelijkspel het
 * laagste, want dat is bij een webwinkel doorgaans de kale productprijs en
 * niet een set of een variant met toebehoren.
 */
function meestVoorkomend(telling, minimaalAantal) {
  let beste = null, max = 0;
  for (const [prijs, n] of telling) {
    if (n > max || (n === max && beste !== null && prijs < beste)) { max = n; beste = prijs; }
  }
  return max >= minimaalAantal ? beste : null;
}

/**
 * Winkels zetten hun productgegevens vaak als JSON in de pagina, ook wanneer
 * de zichtbare prijs pas door JavaScript wordt ingevuld. Dat blok staat er dus
 * wel in de opgehaalde HTML. Zonder deze route mislukten winkels waar de prijs
 * niet in schema.org-vorm staat maar in de eigen state van de webshop.
 *
 * Bedragen in centen (419900) vallen vanzelf af op de grenzen.
 */
function prijsUitJsonBlob(html, grenzen) {
  const patroon = /"(?:price|prijs|amount|priceAmount|unitPrice|salePrice|current_price)"\s*:\s*"?(\d[\d.,]*)"?/gi;
  const telling = new Map();
  let m;
  while ((m = patroon.exec(html)) !== null) {
    const p = parsePrijsWaarde(m[1]);
    if (p && p >= grenzen.min && p <= grenzen.max) telling.set(p, (telling.get(p) || 0) + 1);
  }
  // Eén treffer volstaat: dit is een benoemd veld en geen los getal in de tekst.
  const bedrag = meestVoorkomend(telling, 1);
  return bedrag ? { bedrag, btw: null } : null;
}

/**
 * Laatste redmiddel: de zichtbare tekst afzoeken op een euroteken met een
 * bedrag erachter.
 *
 * De eerdere versie zocht in de rauwe HTML, en miste daardoor precies de twee
 * schrijfwijzen die webwinkels het meest gebruiken: een euroteken in een eigen
 * element ("<span>€</span><span>4.199</span>") en de entiteit &euro;. Daarom
 * eerst tags en entiteiten opruimen. Scripts gaan eruit, anders telt de JSON
 * die prijsUitJsonBlob al bekijkt hier nog een keer mee.
 */
function prijsUitTekst(html, grenzen) {
  const tekst = String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&euro;|&#8364;|&#x20ac;/gi, "€")
    .replace(/&nbsp;|&#160;/gi, " ");
  // \s* en niet \s?: het opruimen van tags vervangt elke tag door een spatie,
  // dus tussen "€" en het bedrag staan er dan meerdere.
  const matches = tekst.match(/(?:€|EUR)\s*([\d.]{3,7}(?:,\d{2})?)/gi) || [];
  const telling = new Map();
  for (const m of matches) {
    const p = parsePrijsWaarde(m);
    if (p && p >= grenzen.min && p <= grenzen.max) telling.set(p, (telling.get(p) || 0) + 1);
  }
  // Hier wel twee treffers eisen: een los getal in lopende tekst kan van alles
  // zijn, en een winkel noemt de prijs vrijwel altijd meer dan eens.
  const bedrag = meestVoorkomend(telling, 2);
  return bedrag ? { bedrag, btw: null } : null;
}

/**
 * De absolute grenzen gelden altijd, ook als er al een oude prijs staat.
 * Anders kan een prijs met stapjes van 40% per dag onder de ondergrens
 * wegzakken zonder dat één losse controle onplausibel lijkt.
 */
function plausibel(nieuw, oud, grenzen) {
  if (nieuw < grenzen.min || nieuw > grenzen.max) return false;
  if (!oud) return true;
  return nieuw >= oud * 0.4 && nieuw <= oud * 2.5;
}

/* ------------------------------------------------------------------ */

async function updateAanbieding(pomp, aanbieding, grenzen, verdacht) {
  if (!aanbieding.url) return false;
  try {
    let gevonden;
    if (/www\.bol\.com/.test(aanbieding.url) && BOL_CLIENT_ID && BOL_CLIENT_SECRET) {
      gevonden = await bolApiPrijs(aanbieding, grenzen);
    } else {
      const html = await haalPagina(aanbieding.url);
      gevonden = prijsUitJsonLd(html) ?? prijsUitMeta(html) ?? prijsUitJsonBlob(html, grenzen) ?? prijsUitTekst(html, grenzen);
      // Zegt de markup niets over btw, dan bepaalt de pagina zelf het oordeel.
      if (gevonden && gevonden.btw == null) gevonden.btw = toontExclBtw(html) ? "excl" : "incl";
    }
    if (!gevonden) {
      // Een winkel-URL kan alvast vastliggen voordat er ooit een bedrag bij
      // gevonden is; dan is er geen oude prijs om te behouden.
      const staat = typeof aanbieding.prijs_eur === "number"
        ? `oude prijs blijft (€${aanbieding.prijs_eur})`
        : "er staat nog geen prijs bij deze winkel";
      console.log(`  ~ ${pomp.id} @ ${aanbieding.winkel}: geen prijs gevonden, ${staat}`);
      return false;
    }

    // Het databestand bewaart het bedrag zoals de winkel het toont, met
    // btw_inbegrepen erbij. Omrekenen gebeurt bij het tonen, in assets/prijs.js.
    // Zo blijft zichtbaar wat er werkelijk op de productpagina stond, en is er
    // maar één plek waar de btw-regel staat.
    const exclBtw = gevonden.btw === "excl";
    const winkelbedrag = gevonden.bedrag;
    // Vergelijken en controleren gebeurt wel op de prijs inclusief btw, anders
    // wordt een bedrag zonder btw ten onrechte als koopje gezien.
    const nieuw = exclBtw ? Math.round(winkelbedrag * BTW) : winkelbedrag;

    const oudVergelijk = typeof aanbieding.prijs_eur === "number"
      ? (aanbieding.btw_inbegrepen === false ? Math.round(aanbieding.prijs_eur * BTW) : aanbieding.prijs_eur)
      : null;
    if (!plausibel(nieuw, oudVergelijk, grenzen)) {
      console.log(`  ! ${pomp.id} @ ${aanbieding.winkel}: gevonden prijs €${nieuw} niet plausibel t.o.v. €${oudVergelijk}, overgeslagen`);
      return false;
    }

    // Een prijs die ver van de richtprijs ligt, dekt bijna altijd iets anders
    // dan het toestel waar de richtprijs over gaat. Zulke bedragen worden wel
    // opgeslagen, maar ook gemeld zodat iemand ernaar kan kijken.
    if (pomp.richtprijs_eur) {
      const verhouding = nieuw / pomp.richtprijs_eur;
      if (verhouding < RICHTPRIJS_ONDER || verhouding > RICHTPRIJS_BOVEN) {
        verdacht.push(
          `${pomp.id} @ ${aanbieding.winkel}: €${nieuw} is ${Math.round(verhouding * 100)}% van de richtprijs (€${pomp.richtprijs_eur})` +
          ` - controleer of deze prijs hetzelfde dekt (${aanbieding.url})`
        );
      }
    }

    const wasExcl = aanbieding.btw_inbegrepen === false;
    const veranderd = winkelbedrag !== aanbieding.prijs_eur || exclBtw !== wasExcl;
    aanbieding.prijs_eur = winkelbedrag;
    if (exclBtw) aanbieding.btw_inbegrepen = false;
    else delete aanbieding.btw_inbegrepen;
    aanbieding.datum = VANDAAG;
    const btwNoot = exclBtw ? ` excl. btw (€${nieuw} inclusief)` : "";
    console.log(`  ${veranderd ? "✓ NIEUW" : "= gelijk"} ${pomp.id} @ ${aanbieding.winkel}: €${winkelbedrag}${btwNoot}`);
    return veranderd;
  } catch (err) {
    console.log(`  x ${pomp.id} @ ${aanbieding.winkel}: ${err.message} (oude prijs blijft staan)`);
    return false;
  }
}

async function main() {
  let wijzigingen = 0;
  const verdacht = [];

  for (const bestand of BESTANDEN) {
    console.log(`\n=== ${bestand.lijst} (${bestand.pad}) ===`);
    const data = JSON.parse(readFileSync(bestand.pad, "utf8"));

    for (const product of data[bestand.lijst] || []) {
      for (const aanbieding of product.aanbiedingen || []) {
        if (await updateAanbieding(product, aanbieding, bestand, verdacht)) wijzigingen++;
        await new Promise((r) => setTimeout(r, 1500)); // beleefde pauze tussen requests
      }
      // prijs_datum van het product = meest recente controle-datum van zijn aanbiedingen
      const datums = (product.aanbiedingen || []).map((a) => a.datum).filter(Boolean).sort();
      if (datums.length) product.prijs_datum = datums[datums.length - 1];
    }

    data.laatst_bijgewerkt = VANDAAG;
    writeFileSync(bestand.pad, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
  // De warmtepomppagina's en sitemap worden hierna herbouwd door
  // scripts/genereer-warmtepomppaginas.mjs (zie de workflow).

  if (verdacht.length) {
    console.log(`\n!! ${verdacht.length} prijs(en) om na te lopen:`);
    for (const r of verdacht) console.log(`   - ${r}`);
  }

  console.log(`\nKlaar. ${wijzigingen} prijswijziging(en). laatst_bijgewerkt = ${VANDAAG}`);
}

main().catch((err) => {
  console.error("Onverwachte fout:", err);
  process.exit(1);
});
