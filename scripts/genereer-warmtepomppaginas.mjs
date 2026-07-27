/* ==========================================================================
   Warmtepompmaatje - generator voor productpagina's (pomp/<id>.html)
   Zelfde opzet als de paneelpagina's van Zonnestroommaatje en de
   batterijpagina's van Batterijmaatje. Draaien: node scripts/genereer-warmtepomppaginas.mjs
   Herbouwt ook sitemap.xml.
   ========================================================================== */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://warmtepompmaatje.nl";
const ASSET_VERSIE = "20260727b";
const VANDAAG = new Date().toISOString().slice(0, 10);

const data = JSON.parse(readFileSync(join(ROOT, "data", "warmtepompen.json"), "utf8"));
const pompen = data.warmtepompen;

const esc = (s) => String(s == null ? "" : s)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const eur = (n) => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
const datumNL = (iso) => { const d = new Date(`${iso}T12:00:00`); return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("nl-NL", { dateStyle: "long" }).format(d); };

function driewaardig(v) {
  if (v && typeof v === "object") return { status: v.status || "deels", tekst: v.tekst || "" };
  if (typeof v === "string" && v.trim()) return { status: "deels", tekst: v };
  return { status: "nee", tekst: "Nee" };
}
const punt = (v) => { const s = driewaardig(v).status; return s === "ja" ? 2 : s === "deels" ? 1 : 0; };
const koppelScore = (w) => punt(w.sturing) + punt(w.home_assistant) + punt(w.homey);
const d3html = (v) => { const d = driewaardig(v); const icoon = d.status === "ja" ? "✓" : d.status === "deels" ? "~" : "✕"; return `<b>${icoon}</b> ${esc(d.tekst)}`; };

function bestePrijs(w) {
  const aanbiedingen = (w.aanbiedingen || []).filter((a) => a && a.prijs_eur);
  if (aanbiedingen.length) {
    return aanbiedingen.reduce((min, a) => (a.prijs_eur < min.prijs_eur || (a.prijs_eur === min.prijs_eur && a.datum && !min.datum) ? a : min));
  }
  if (w.richtprijs_eur) return { winkel: null, prijs_eur: w.richtprijs_eur, url: w.product_url };
  return null;
}

// JSON-LD: Product (met prijs/aanbieding) + BreadcrumbList, gelijk aan de zustersites
function productLd(w) {
  const naam = `${w.merk} ${w.model}`;
  const beste = bestePrijs(w);
  const aanbiedingen = (w.aanbiedingen || []).filter((a) => a && a.prijs_eur);
  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": naam,
    "brand": { "@type": "Brand", "name": w.merk },
    "category": w.type === "hybride" ? "Hybride warmtepomp" : "All-electric warmtepomp",
    "description": `${naam}: ${w.type === "hybride" ? "hybride" : "all-electric"} warmtepomp${w.vermogen_kw ? ` van ${String(w.vermogen_kw).replace(".", ",")} kW` : ""}${w.scop ? `, SCOP ${String(w.scop).replace(".", ",")}` : ""}. Koppel-score ${koppelScore(w)}/6.`.slice(0, 300),
    "url": `${SITE}/pomp/${w.id}.html`,
  };
  if (aanbiedingen.length === 1) {
    ld.offers = { "@type": "Offer", "price": aanbiedingen[0].prijs_eur, "priceCurrency": "EUR", "url": aanbiedingen[0].affiliate_url || aanbiedingen[0].url, "availability": "https://schema.org/InStock" };
  } else if (aanbiedingen.length > 1) {
    const prijzen = aanbiedingen.map((a) => a.prijs_eur);
    ld.offers = { "@type": "AggregateOffer", "lowPrice": Math.min(...prijzen), "highPrice": Math.max(...prijzen), "priceCurrency": "EUR", "offerCount": aanbiedingen.length };
  } else if (beste) {
    ld.offers = { "@type": "Offer", "price": beste.prijs_eur, "priceCurrency": "EUR", "url": beste.url, "availability": "https://schema.org/InStock" };
  }
  const kruimel = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Warmtepompen", "item": `${SITE}/` },
      { "@type": "ListItem", "position": 2, "name": naam, "item": `${SITE}/pomp/${w.id}.html` },
    ],
  };
  return `<script type="application/ld+json">\n${JSON.stringify(ld, null, 2)}\n  </script>\n  <script type="application/ld+json">\n${JSON.stringify(kruimel, null, 2)}\n  </script>`;
}

function kop(actief, diepte) {
  const p = diepte ? "../" : "";
  return `<header class="site-header">
  <div class="container">
    <a class="logo" href="${p}index.html">
      <span class="logo-icoon">🔥</span>
      <span>Warmtepomp<b>maatje</b></span>
    </a>
    <nav class="hoofdnav">
      <a href="${p}index.html"${actief === "index" ? ' class="actief"' : ""}>Warmtepompen</a>
      <a href="${p}advies.html">Keuzehulp</a>
      <a href="${p}rekenmodule.html">Terugverdientijd</a>
      <a href="${p}uitleg.html">Uitleg</a>
      <a href="${p}subsidie.html">Subsidie</a>
      <details class="nav-meer">
        <summary>Meer ▾</summary>
        <div class="nav-meer-paneel">
          <a href="${p}over-ons.html">Over ons</a>
          <a href="${p}contact.html">Contact</a>
          <a href="${p}privacy.html">Privacy &amp; disclaimer</a>
        </div>
      </details>
    </nav>
  </div>
</header>`;
}

function voet(diepte) {
  const p = diepte ? "../" : "";
  return `<footer class="site-footer">
  <div class="container">
    <b>🔥 Warmtepompmaatje</b>
    <p>Onafhankelijke vergelijking van warmtepompen voor Nederlandse huishoudens. Zustersite van <a href="https://zonnestroommaatje.nl/" target="_blank" rel="noopener">Zonnestroommaatje</a> (zonnepanelen en omvormers) en <a href="https://batterijmaatje.nl/" target="_blank" rel="noopener">Batterijmaatje.nl</a> (thuisbatterijen).</p>
    <p><a href="${p}index.html">Warmtepompen</a> · <a href="${p}advies.html">Keuzehulp</a> · <a href="${p}rekenmodule.html">Terugverdientijd</a> · <a href="${p}uitleg.html">Uitleg</a> · <a href="${p}subsidie.html">Subsidie</a> · <a href="${p}over-ons.html">Over ons</a> · <a href="${p}contact.html">Contact</a> · <a href="${p}privacy.html">Privacy &amp; disclaimer</a></p>
    <p class="disclaimer">Disclaimer: prijzen en specificaties zijn indicaties; er kunnen geen rechten aan worden ontleend. De prijs en voorwaarden op de website van de aanbieder zijn altijd leidend.</p>
  </div>
</footer>`;
}

function pompPagina(w) {
  const naam = `${w.merk} ${w.model}`;
  const beste = bestePrijs(w);
  const uitWinkel = !!(beste && beste.winkel);
  const score = koppelScore(w);
  const aanbiedingen = (w.aanbiedingen || []).filter((a) => a && a.prijs_eur);
  const specRij = (label, waarde) => waarde == null || waarde === "" ? "" : `<tr><th>${label}</th><td>${waarde}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(naam)}: prijs, subsidie, geluid en slimme koppeling | Warmtepompmaatje.nl</title>
  <meta name="description" content="Alles over de ${esc(naam)} (${esc(w.type)}): actuele prijs, ISDE-subsidie, geluid van de buitenunit, rendement en of hij koppelt met Home Assistant en Homey (Koppel-score ${score}/6).">
  <link rel="canonical" href="${SITE}/pomp/${esc(w.id)}.html">
  <meta property="og:title" content="${esc(naam)}: prijs, subsidie en slimme koppeling">
  <meta property="og:description" content="${esc(w.type === "hybride" ? "Hybride warmtepomp" : "All-electric warmtepomp")}, Koppel-score ${score}/6, ISDE-indicatie ${w.isde_indicatie_eur ? eur(w.isde_indicatie_eur) : "onbekend"}.">
  <meta property="og:type" content="product">
  <meta property="og:url" content="${SITE}/pomp/${esc(w.id)}.html">
  <meta property="og:locale" content="nl_NL">
  <meta property="og:site_name" content="Warmtepompmaatje.nl">
  <meta property="og:image" content="${SITE}/assets/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  ${productLd(w)}
  <link rel="stylesheet" href="../assets/style.css?v=${ASSET_VERSIE}">
  <script src="../assets/nav.js?v=${ASSET_VERSIE}" defer></script>
  <link rel="icon" href="../assets/favicon.svg?v=1" type="image/svg+xml">
  <style>
    .product-indeling { display: grid; grid-template-columns: 1fr 340px; gap: 24px; align-items: start; margin: 20px 0 40px; }
    @media (max-width: 860px) { .product-indeling { grid-template-columns: 1fr; } }
    .product-indeling > * { min-width: 0; }
    .product-paneel { background: var(--kleur-wit); border: 1px solid var(--kleur-rand); border-radius: var(--radius); box-shadow: var(--schaduw); padding: 22px; }
    .spec-tabel { width: 100%; border-collapse: collapse; font-size: 0.95rem; table-layout: fixed; }
    .spec-tabel th { text-align: left; padding: 9px 12px 9px 0; color: var(--kleur-tekst-licht); font-weight: 600; vertical-align: top; width: 42%; overflow-wrap: anywhere; }
    .spec-tabel td { padding: 9px 0; border-bottom: 1px dotted var(--kleur-rand); vertical-align: top; overflow-wrap: anywhere; }
    .spec-tabel tr:last-child td { border-bottom: none; }
    .prijs-groot { font-size: 1.9rem; font-weight: 800; color: var(--kleur-primair-donker); }
    .breadcrumb { font-size: 0.85rem; color: var(--kleur-tekst-licht); margin: 16px 0 0; }
    .koppel-blok dt { font-weight: 700; margin-top: 10px; }
    .koppel-blok dd { margin: 2px 0 0; font-size: 0.93rem; color: var(--kleur-tekst-licht); }
  </style>
</head>
<body>

${kop("index", true)}

<main class="container">
  <p class="breadcrumb"><a href="../index.html">Warmtepompen</a> › ${esc(naam)}</p>
  <h1 style="margin:8px 0 4px;">${esc(naam)}</h1>
  <p style="margin:0 0 6px;color:var(--kleur-tekst-licht);">${w.type === "hybride" ? "Hybride warmtepomp (werkt samen met je cv-ketel)" : "All-electric warmtepomp (vervangt de cv-ketel volledig)"}${w.voorbeeld_variant ? ` · prijzen voor: ${esc(w.voorbeeld_variant)}` : ""}</p>
  <p style="margin:0 0 10px;"><span class="badge zeker-score ${score >= 5 ? "zeker-hoog" : score >= 3 ? "zeker-midden" : "zeker-laag"}">🔗 Koppel-score ${score}/6</span></p>

  <div class="product-indeling">
    <div class="product-paneel">
      <h2 style="margin-top:0;">Specificaties</h2>
      <table class="spec-tabel">
        ${specRij("Type", w.type === "hybride" ? "Hybride (naast de cv-ketel)" : "All-electric (van het gas af)")}
        ${specRij("Vermogen", w.vermogen_kw ? `${String(w.vermogen_kw).replace(".", ",")} kW` : null)}
        ${specRij("Rendement (SCOP)", w.scop ? `${String(w.scop).replace(".", ",")}${w.scop_toelichting ? ` <small>(${esc(w.scop_toelichting)})</small>` : ""}` : (w.scop_toelichting ? esc(w.scop_toelichting) : null))}
        ${specRij("Geluid buitenunit", w.geluid_db ? `${w.geluid_db} dB(A)${w.geluid_toelichting ? ` <small>(${esc(w.geluid_toelichting)})</small>` : ""}` : null)}
        ${specRij("Koudemiddel", w.koudemiddel ? esc(w.koudemiddel) : null)}
        ${specRij("Warm tapwater", typeof w.tapwater === "string" ? esc(w.tapwater) : d3html(w.tapwater))}
        ${specRij("Maximale aanvoertemperatuur", w.max_aanvoer_c ? `${w.max_aanvoer_c} °C` : null)}
        ${specRij("ISDE-subsidie (indicatie)", w.isde_indicatie_eur ? `${eur(w.isde_indicatie_eur)} <small>(check de meldcode bij <a href="https://www.rvo.nl/subsidies-financiering/isde/woningeigenaren/warmtepomp" target="_blank" rel="noopener">RVO</a>)</small>` : null)}
      </table>

      <div class="info-kader" style="margin-top:14px;">
        <b>Wat je nodig hebt voor je ISDE-aanvraag</b>
        <p style="margin:6px 0 0;">De ISDE-subsidie loopt per goedgekeurd apparaat, elk met een eigen meldcode. Wij vermelden die meldcode bewust niet: RVO werkt de lijst regelmatig bij en één model heeft vaak meerdere codes per vermogensvariant. Zoek de juiste meldcode op met deze gegevens van deze warmtepomp:</p>
        <ul style="margin:8px 0 0;">
          <li><b>Merk:</b> ${esc(w.merk)}</li>
          <li><b>Model:</b> ${esc(w.model)}</li>
          <li><b>Uitvoering:</b> ${w.type === "hybride" ? "hybride" : "all-electric"}</li>
          ${w.vermogen_kw ? `<li><b>Vermogen:</b> ${String(w.vermogen_kw).replace(".", ",")} kW${w.voorbeeld_variant ? ` <small>(variant: ${esc(w.voorbeeld_variant)})</small>` : ""}</li>` : ""}
        </ul>
        <p style="margin:8px 0 0;">Zoek dit apparaat op de <a href="https://www.rvo.nl/subsidies-financiering/isde/woningeigenaren/warmtepomp" target="_blank" rel="noopener">apparatenlijst bij RVO</a>. De meldcode en het exacte subsidiebedrag daar zijn leidend.</p>
      </div>

      <h2>Slim koppelen (Koppel-score ${score}/6)</h2>
      <dl class="koppel-blok" style="margin:0;">
        <dt>${driewaardig(w.sturing).status === "ja" ? "✓" : driewaardig(w.sturing).status === "deels" ? "~" : "✕"} Slimme aansturing</dt><dd>${esc(driewaardig(w.sturing).tekst)}</dd>
        <dt>${driewaardig(w.home_assistant).status === "ja" ? "✓" : driewaardig(w.home_assistant).status === "deels" ? "~" : "✕"} Home Assistant</dt><dd>${esc(driewaardig(w.home_assistant).tekst)}</dd>
        <dt>${driewaardig(w.homey).status === "ja" ? "✓" : driewaardig(w.homey).status === "deels" ? "~" : "✕"} Homey</dt><dd>${esc(driewaardig(w.homey).tekst)}</dd>
      </dl>
      <p class="hint" style="margin-top:12px;">Integraties veranderen per firmware- en appversie; controleer de actuele status vóór aankoop. <a href="../index.html#koppel-score">Zo werkt de Koppel-score →</a></p>
    </div>

    <div class="product-paneel">
      <h2 style="margin-top:0;">Prijs</h2>
      <div class="prijs-groot">${beste ? eur(beste.prijs_eur) : "Prijs op aanvraag"}</div>
      <p class="hint" style="margin:2px 0 10px;">${uitWinkel ? `laagste prijs, bij ${esc(beste.winkel)}` : "richtprijs (indicatie), exclusief installatie"}${w.prijs_toelichting ? `<br>${esc(w.prijs_toelichting)}` : ""}</p>
      ${aanbiedingen.length ? `<ul class="winkel-lijst" style="list-style:none;padding:0;margin:0 0 10px;">${aanbiedingen.map((a) => `<li style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:6px 0;border-bottom:1px dotted var(--kleur-rand);min-width:0;"><span style="min-width:0;overflow-wrap:anywhere;">${esc(a.winkel)}</span><span style="white-space:nowrap;"><b>${eur(a.prijs_eur)}</b> <a href="${esc(a.affiliate_url || a.url)}" target="_blank" rel="noopener${a.affiliate_url ? " sponsored" : ""}">bekijk</a></span></li>`).join("")}</ul>` : ""}
      ${w.prijs_datum ? `<p class="datum-stempel" style="margin:0 0 12px;">Prijzen gecontroleerd: ${esc(datumNL(w.prijs_datum))}. Zonder controledatum is de prijs een indicatie.</p>` : ""}
      <p style="margin:0;display:flex;flex-direction:column;gap:8px;">
        ${beste && (beste.url || beste.affiliate_url) ? `<a class="knop" href="${esc(beste.affiliate_url || beste.url)}" target="_blank" rel="noopener">${uitWinkel ? "Bekijk aanbieding →" : "Naar fabrikant →"}</a>` : ""}
        <a class="knop knop-secundair" href="../rekenmodule.html?pomp=${encodeURIComponent(w.id)}">Bereken je terugverdientijd →</a>
        <a class="knop knop-secundair" href="../advies.html">Past deze pomp bij mijn huis? →</a>
      </p>
    </div>
  </div>

  <section class="content-pagina" style="padding-top:0;">
    <h2>Over de ${esc(naam)}</h2>
    <p>${esc(w.omschrijving || `${naam} is een ${w.type === "hybride" ? "hybride warmtepomp die samenwerkt met je cv-ketel: de pomp doet het gros van de verwarming, de ketel vangt piekkou en warm water op" : "all-electric warmtepomp die de cv-ketel volledig vervangt, inclusief warm tapwater via een boilervat"}.`)}</p>
    <p>Twijfel je nog over het type of het merk? Doe de <a href="../advies.html">keuzehulp</a>, of zet deze pomp naast twee andere in de <a href="../index.html">vergelijker</a> (vink "vergelijk" aan op maximaal drie kaarten).</p>
  </section>
</main>

${voet(true)}

</body>
</html>
`;
}

mkdirSync(join(ROOT, "pomp"), { recursive: true });
for (const w of pompen) {
  writeFileSync(join(ROOT, "pomp", `${w.id}.html`), pompPagina(w));
}
console.log(`${pompen.length} productpagina's gegenereerd in /pomp/`);

// Sitemap herbouwen
const vast = [
  { loc: `${SITE}/`, prio: "1.0" },
  { loc: `${SITE}/advies.html`, prio: "0.9" },
  { loc: `${SITE}/rekenmodule.html`, prio: "0.9" },
  { loc: `${SITE}/uitleg.html`, prio: "0.8" },
  { loc: `${SITE}/subsidie.html`, prio: "0.8" },
  { loc: `${SITE}/over-ons.html`, prio: "0.4" },
  { loc: `${SITE}/contact.html`, prio: "0.4" },
  { loc: `${SITE}/privacy.html`, prio: "0.2" },
];
const urls = [...vast, ...pompen.map((w) => ({ loc: `${SITE}/pomp/${w.id}.html`, prio: "0.7" }))];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${VANDAAG}</lastmod><priority>${u.prio}</priority></url>`).join("\n") +
  `\n</urlset>\n`;
writeFileSync(join(ROOT, "sitemap.xml"), sitemap);
console.log(`sitemap.xml herbouwd met ${urls.length} URL's`);
