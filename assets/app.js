/* ==========================================================================
   Warmtepompmaatje - vergelijkingslogica
   Laadt data/warmtepompen.json en rendert kaarten, tabel en vergelijk-modal,
   met dezelfde opzet als de zustersites (Batterijmaatje, Zonnestroommaatje).
   ========================================================================== */

(function () {
  "use strict";

  const state = {
    pompen: [],
    weergave: "kaarten", // of "tabel"
    sortering: "koppel-score",
    tabelSortKolom: null,
    tabelSortRichting: 1,
    vergelijkSelectie: [],
    filters: { zoek: "", type: "alle", merk: "alle", r290: false, stil: false, officieelHa: false },
  };

  const el = (id) => document.getElementById(id);

  const eurFmt = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const datumFmt = new Intl.DateTimeFormat("nl-NL", { dateStyle: "long" });

  // ISO-datum (2026-07-22) leesbaar maken als "22 juli 2026"
  function datumNL(iso) {
    const d = new Date(`${iso}T12:00:00`);
    return Number.isNaN(d.getTime()) ? iso : datumFmt.format(d);
  }

  const TYPE_LABEL = { "hybride": "Hybride (naast de cv-ketel)", "all-electric": "All-electric (van het gas af)" };
  const TYPE_KORT = { "hybride": "Hybride", "all-electric": "All-electric" };

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  function driewaardig(v) {
    if (v && typeof v === "object") return { status: v.status || "deels", tekst: v.tekst || "" };
    if (v === true) return { status: "ja", tekst: "Ja" };
    if (typeof v === "string" && v.trim()) return { status: "deels", tekst: v };
    return { status: "nee", tekst: "Nee" };
  }

  function koopUrl(a) {
    return (a && (a.affiliate_url || a.url)) || "";
  }

  /**
   * Alle bedragen op de site staan inclusief btw en gaan over het losse
   * toestel. Wijkt een aanbieding daarvan af, dan legt dit blokje uit waarom
   * het getoonde bedrag niet gelijk is aan wat je bij de winkel ziet staan.
   *   btw: "excl"  -> de winkel toont een bedrag zonder btw (installateursshop)
   *   dekt: tekst  -> de prijs dekt iets anders dan het complete toestel
   */
  function prijsLetOp(a) {
    const regels = [];
    if (a.btw === "excl") {
      regels.push(`De winkel toont ${eurFmt.format(Math.round(a.prijs_eur / 1.21))} exclusief btw; hierboven staat het bedrag inclusief 21% btw.`);
    }
    if (a.dekt) regels.push(escapeHtml(a.dekt));
    if (!regels.length) return "";
    return `<div class="prijs-let-op">${regels.join(" ")}</div>`;
  }

  /**
   * Een winkel-URL kan alvast in het databestand staan voordat de dagelijkse
   * prijscontrole er een bedrag bij heeft gevonden. Zonder deze functie zou
   * daar "€ NaN" komen te staan.
   */
  function bedragOfWacht(bedrag) {
    return typeof bedrag === "number" ? eurFmt.format(bedrag) : "prijs volgt";
  }

  function bestePrijs(w) {
    const aanbiedingen = (w.aanbiedingen || []).filter((a) => a && a.prijs_eur);
    if (aanbiedingen.length) {
      // Bij gelijke prijs wint de aanbieding met controledatum (geverifieerd)
      return aanbiedingen.reduce((min, a) => (a.prijs_eur < min.prijs_eur || (a.prijs_eur === min.prijs_eur && a.datum && !min.datum) ? a : min));
    }
    if (w.richtprijs_eur) return { winkel: "richtprijs (indicatie)", prijs_eur: w.richtprijs_eur, url: w.product_url };
    return null;
  }

  // Koppel-score: dezelfde transparante 0-6 rekensom als op de zustersites.
  // Drie zaken tellen mee, elk 0-2 punten:
  //  - slimme aansturing: Modbus/EEBUS/eBUS of rijke open koppeling = 2,
  //    alleen SG-ready of via de thermostaat = 1
  //  - Home Assistant: officiële integratie = 2, community-integratie = 1
  //  - Homey: eigen app = 2, community-app of omweg = 1
  function koppelScore(w) {
    const punt = (v) => { const s = driewaardig(v).status; return s === "ja" ? 2 : s === "deels" ? 1 : 0; };
    return punt(w.sturing) + punt(w.home_assistant) + punt(w.homey);
  }

  function koppelScoreBadge(w) {
    const score = koppelScore(w);
    const klasse = score >= 5 ? "zeker-hoog" : score >= 3 ? "zeker-midden" : "zeker-laag";
    return `<span class="badge zeker-score ${klasse}" title="Koppel-score ${score} van 6: punten voor slimme aansturing (SG-ready/Modbus), Home Assistant en Homey (2 punten per onderdeel). Tik voor de details.">${Iconen.svg("koppeling")} Koppel-score ${score}/6</span>`;
  }

  function badgeHtml(label, waarde) {
    const d = driewaardig(waarde);
    const icoon = Iconen.svg(d.status === "ja" ? "ja" : d.status === "deels" ? "deels" : "nee");
    return `<span class="badge ${d.status}" data-uitleg="${escapeHtml(label)}" title="${escapeHtml(d.tekst)}">${icoon} ${escapeHtml(label)}</span>`;
  }

  const isStil = (w) => (w.geluid_db || 99) <= 55;
  const isR290 = (w) => /R290/i.test(w.koudemiddel || "");

  /* ------------------------------------------------------------------
     Filteren, sorteren en URL-status (deelbare links)
     ------------------------------------------------------------------ */

  const FILTER_KEYS = ["type", "merk"];
  const CHECK_KEYS = [["r290", "r290"], ["stil", "stil"], ["officieelHa", "ha"]];

  function syncUrl() {
    const f = state.filters;
    const p = new URLSearchParams();
    FILTER_KEYS.forEach((k) => { if (f[k] !== "alle") p.set(k, f[k]); });
    if (f.zoek) p.set("zoek", f.zoek);
    CHECK_KEYS.forEach(([k, kort]) => { if (f[k]) p.set(kort, "1"); });
    if (state.sortering !== "koppel-score") p.set("sorteer", state.sortering);
    const qs = p.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }

  function leesUrl() {
    const p = new URLSearchParams(location.search);
    FILTER_KEYS.forEach((k) => { if (p.get(k)) state.filters[k] = p.get(k); });
    if (p.get("zoek")) { state.filters.zoek = p.get("zoek"); const zv = el("zoekVeld"); if (zv) zv.value = state.filters.zoek; }
    CHECK_KEYS.forEach(([k, kort]) => { if (p.get(kort) === "1") state.filters[k] = true; });
    if (p.get("sorteer")) state.sortering = p.get("sorteer");
    const zet = (id, w) => { const n = el(id); if (n) n.value = w; };
    zet("filterType", state.filters.type); zet("filterMerk", state.filters.merk); zet("sorteer", state.sortering);
    const vink = (id, w) => { const n = el(id); if (n) n.checked = w; };
    vink("checkR290", state.filters.r290); vink("checkStil", state.filters.stil); vink("checkHa", state.filters.officieelHa);
  }

  function gefilterd() {
    const f = state.filters;
    return state.pompen.filter((w) => {
      if (f.zoek && !`${w.merk} ${w.model}`.toLowerCase().includes(f.zoek.trim().toLowerCase())) return false;
      if (f.type !== "alle" && w.type !== f.type) return false;
      if (f.merk !== "alle" && w.merk !== f.merk) return false;
      if (f.r290 && !isR290(w)) return false;
      if (f.stil && !isStil(w)) return false;
      if (f.officieelHa && driewaardig(w.home_assistant).status !== "ja") return false;
      return true;
    });
  }

  function gesorteerd(lijst) {
    const kopie = [...lijst];
    const prijsVan = (w) => { const b = bestePrijs(w); return b ? b.prijs_eur : Infinity; };
    switch (state.sortering) {
      case "prijs-oplopend": kopie.sort((a, b) => prijsVan(a) - prijsVan(b)); break;
      case "subsidie": kopie.sort((a, b) => (b.isde_indicatie_eur || 0) - (a.isde_indicatie_eur || 0)); break;
      case "geluid": kopie.sort((a, b) => (a.geluid_db || 99) - (b.geluid_db || 99)); break;
      case "rendement": kopie.sort((a, b) => (b.scop || 0) - (a.scop || 0)); break;
      case "koppel-score": kopie.sort((a, b) => koppelScore(b) - koppelScore(a) || prijsVan(a) - prijsVan(b)); break;
    }
    return kopie;
  }

  /* ------------------------------------------------------------------
     Rendering: kaarten
     ------------------------------------------------------------------ */

  function kaartHtml(w) {
    const sturing = driewaardig(w.sturing);
    const ha = driewaardig(w.home_assistant);
    const homey = driewaardig(w.homey);
    const geselecteerd = state.vergelijkSelectie.includes(w.id);
    const beste = bestePrijs(w);
    const uitWinkel = !!(beste && beste.winkel && !beste.winkel.startsWith("richtprijs"));
    return `
    <article class="paneel-kaart" data-id="${escapeHtml(w.id)}">
      <div class="vergelijk-checkbox-wrap">
        <label class="badge" title="Selecteer om te vergelijken (max. 3)">
          <input type="checkbox" class="vergelijk-check" data-id="${escapeHtml(w.id)}" ${geselecteerd ? "checked" : ""}> vergelijk
        </label>
      </div>
      <div class="kaart-kop">
        <div>
          <div class="merk">${escapeHtml(w.merk)}</div>
          <h3>${escapeHtml(w.model)}</h3>
          <span class="type-badge">${escapeHtml(TYPE_KORT[w.type] || w.type)}</span>
        </div>
      </div>
      <div class="kaart-specs">
        <div class="spec"><span class="spec-label">Vermogen</span><span class="spec-waarde">${String(w.vermogen_kw).replace(".", ",")} kW</span></div>
        <div class="spec"><span class="spec-label">Geluid buitenunit</span><span class="spec-waarde">${w.geluid_db ? w.geluid_db + " dB(A)" : "?"}</span></div>
        <div class="spec"><span class="spec-label">Koudemiddel</span><span class="spec-waarde">${escapeHtml(w.koudemiddel || "?")}</span></div>
        <div class="spec"><span class="spec-label">Subsidie (ISDE)</span><span class="spec-waarde">circa ${w.isde_indicatie_eur ? eurFmt.format(w.isde_indicatie_eur) : "?"}</span></div>
      </div>
      <div class="kaart-badges">
        ${koppelScoreBadge(w)}
        ${badgeHtml("Slimme aansturing", w.sturing)}
        ${badgeHtml("Home Assistant", w.home_assistant)}
        ${badgeHtml("Homey", w.homey)}
      </div>
      <button class="details-toggle" data-id="${escapeHtml(w.id)}">Meer details</button>
      <div class="kaart-details" data-details="${escapeHtml(w.id)}" hidden>
        <dt>Slimme aansturing</dt><dd>${escapeHtml(sturing.tekst)}</dd>
        <dt>Home Assistant</dt><dd>${escapeHtml(ha.tekst)}</dd>
        <dt>Homey</dt><dd>${escapeHtml(homey.tekst)}</dd>
        <dt>Rendement</dt><dd>${w.scop ? `SCOP circa ${String(w.scop).replace(".", ",")} · ` : ""}${escapeHtml(w.scop_toelichting || "")}</dd>
        <dt>Geluid</dt><dd>${escapeHtml(w.geluid_toelichting || "")}</dd>
        <dt>Warm tapwater</dt><dd>${escapeHtml(w.tapwater || "?")}</dd>
        <dt>Maximale aanvoertemperatuur</dt><dd>${w.max_aanvoer_c ? w.max_aanvoer_c + " °C" : "?"} (hoe hoger, hoe geschikter voor bestaande radiatoren)</dd>
        ${w.opmerkingen ? `<dt>Goed om te weten</dt><dd>${escapeHtml(w.opmerkingen)}</dd>` : ""}
        ${(w.aanbiedingen || []).length ? `<dt>Verkrijgbaar bij</dt><dd><ul class="winkel-lijst">${w.aanbiedingen.map((a) => `<li><span>${escapeHtml(a.winkel)}</span><span><b>${bedragOfWacht(a.prijs_eur)}</b> &nbsp;<a href="${escapeHtml(koopUrl(a))}" target="_blank" rel="noopener${a.affiliate_url ? " sponsored" : ""}">bekijk</a></span></li>`).join("")}</ul>${w.prijs_datum ? `<span class="datum-stempel" style="display:block;margin-top:8px;">Prijzen gecontroleerd: ${escapeHtml(datumNL(w.prijs_datum))}. Zonder controledatum is de prijs een indicatie.</span>` : ""}</dd>` : ""}
        ${w.product_url ? `<dt>Fabrikant</dt><dd><a href="${escapeHtml(w.product_url)}" target="_blank" rel="noopener">officiële website van ${escapeHtml(w.merk)}</a></dd>` : ""}
      </div>
      <div class="kaart-prijs">
        <div class="prijs-blok">
          <div class="prijs">${beste ? eurFmt.format(beste.prijs_eur) : "Prijs op aanvraag"}</div>
          ${beste ? `<div class="prijs-winkel">${uitWinkel ? "bij " + escapeHtml(beste.winkel) : beste.winkel}</div>` : ""}
          ${w.voorbeeld_variant ? `<div class="prijs-per-kwh">prijs voor: ${escapeHtml(w.voorbeeld_variant)}</div>` : ""}
          ${w.prijs_toelichting ? `<div class="prijs-winkel">${escapeHtml(w.prijs_toelichting)}</div>` : ""}
          ${beste ? prijsLetOp(beste) : ""}
        </div>
      </div>
      <div class="kaart-acties">
        ${beste && beste.url ? `<a class="knop" href="${escapeHtml(koopUrl(beste))}" target="_blank" rel="noopener" aria-label="Bekijk de ${escapeHtml(w.merk)} ${escapeHtml(w.model)}">${uitWinkel ? `Bekijk aanbieding ${Iconen.svg("pijl-rechts")}` : `Naar fabrikant ${Iconen.svg("pijl-rechts")}`}</a>` : ""}
        <a class="knop knop-secundair" href="pomp/${encodeURIComponent(w.id)}.html" title="Alle specificaties, prijzen en koppelingsdetails van de ${escapeHtml(w.merk)} ${escapeHtml(w.model)}">Alle details</a>
        <a class="knop knop-secundair" href="rekenmodule.html?pomp=${encodeURIComponent(w.id)}" title="Bereken de besparing en terugverdientijd van de ${escapeHtml(w.merk)} ${escapeHtml(w.model)}">Terugverdientijd</a>
        <a class="knop knop-secundair" href="advies.html" title="Welke warmtepomp past bij jouw huis? Doe de keuzehulp">Keuzehulp</a>
      </div>
    </article>`;
  }

  /* ------------------------------------------------------------------
     Rendering: tabel
     ------------------------------------------------------------------ */

  const tabelKolommen = [
    { key: "model", label: "Model", get: (w) => `${w.merk} ${w.model}` },
    { key: "type", label: "Type", get: (w) => w.type },
    { key: "vermogen", label: "kW", get: (w) => w.vermogen_kw || 0 },
    { key: "prijs", label: "Prijs", get: (w) => { const b = bestePrijs(w); return b ? b.prijs_eur : Infinity; } },
    { key: "subsidie", label: "ISDE", get: (w) => w.isde_indicatie_eur || 0 },
    { key: "geluid", label: "Geluid", get: (w) => w.geluid_db || 99 },
    { key: "koppel", label: "Koppel-score", get: (w) => koppelScore(w) },
    { key: "ha", label: "Home Assistant", get: (w) => driewaardig(w.home_assistant).status },
    { key: "homey", label: "Homey", get: (w) => driewaardig(w.homey).status },
    { key: "actie", label: "", get: () => "" },
  ];

  function tabelHtml(lijst) {
    let rijen = [...lijst];
    if (state.tabelSortKolom) {
      const kol = tabelKolommen.find((k) => k.key === state.tabelSortKolom);
      rijen.sort((a, b) => {
        const va = kol.get(a), vb = kol.get(b);
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * state.tabelSortRichting;
        return String(va).localeCompare(String(vb), "nl") * state.tabelSortRichting;
      });
    }
    const checkCel = (v) => {
      const d = driewaardig(v);
      if (d.status === "ja") return `<span class="check-ja">${Iconen.svg("ja")}</span>`;
      if (d.status === "deels") return `<span class="check-deels" title="${escapeHtml(d.tekst)}">${Iconen.svg("deels")}</span>`;
      return `<span class="check-nee">${Iconen.svg("nee")}</span>`;
    };
    return `
    <table class="vergelijk-tabel">
      <thead><tr>${tabelKolommen.map((k) => `<th data-kolom="${k.key}">${k.label}${k.key !== "actie" ? ` <span class="sorteer-pijl">${Iconen.svg("sorteren")}</span>` : ""}</th>`).join("")}</tr></thead>
      <tbody>
        ${rijen.map((w) => {
          const beste = bestePrijs(w);
          return `<tr>
            <td><b>${escapeHtml(w.merk)}</b><br>${escapeHtml(w.model)}</td>
            <td>${escapeHtml(TYPE_KORT[w.type] || w.type)}</td>
            <td>${String(w.vermogen_kw).replace(".", ",")}</td>
            <td class="tabel-prijs" title="${escapeHtml(w.prijs_toelichting || "")}">${beste ? eurFmt.format(beste.prijs_eur) : "n.b."}</td>
            <td title="Indicatie ISDE-subsidie; het bedrag per meldcode bij RVO is leidend">${w.isde_indicatie_eur ? "± " + eurFmt.format(w.isde_indicatie_eur) : "?"}</td>
            <td>${w.geluid_db ? w.geluid_db + " dB" : "?"}</td>
            <td title="Punten voor slimme aansturing, Home Assistant en Homey"><b>${koppelScore(w)}/6</b></td>
            <td>${checkCel(w.home_assistant)}</td>
            <td>${checkCel(w.homey)}</td>
            <td>${beste && beste.url ? `<a class="knop" style="padding:7px 12px;font-size:0.85rem;" href="${escapeHtml(koopUrl(beste))}" target="_blank" rel="noopener">Bekijk ${Iconen.svg("pijl-rechts")}</a>` : ""}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
  }

  /* ------------------------------------------------------------------
     Rendering: vergelijk-modal (max. 3 zij aan zij)
     ------------------------------------------------------------------ */

  function vergelijkModalHtml(items) {
    const rij = (label, fn) => `<tr><th style="text-align:left;padding:8px 10px;background:var(--kleur-achtergrond);white-space:nowrap;position:sticky;left:0;z-index:1;box-shadow:2px 0 0 var(--kleur-rand);">${label}</th>${items.map((w) => `<td style="padding:8px 10px;border-bottom:1px solid var(--kleur-rand);">${fn(w)}</td>`).join("")}</tr>`;
    const d3 = (v) => { const d = driewaardig(v); return d.status === "nee" ? `${Iconen.svg("nee")} ${escapeHtml(d.tekst)}` : d.status === "deels" ? `${Iconen.svg("deels")} ${escapeHtml(d.tekst)}` : `${Iconen.svg("ja")} ${escapeHtml(d.tekst)}`; };
    return `
      <h2>Vergelijking</h2>
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:0.93rem;min-width:${220 * items.length + 160}px;">
        ${rij("Model", (w) => `<b>${escapeHtml(w.merk)} ${escapeHtml(w.model)}</b>`)}
        ${rij("Type", (w) => escapeHtml(TYPE_LABEL[w.type] || w.type))}
        ${rij("Vermogen", (w) => `${String(w.vermogen_kw).replace(".", ",")} kW`)}
        ${rij("Prijs", (w) => { const b = bestePrijs(w); return `${b ? `<b>${eurFmt.format(b.prijs_eur)}</b>` : "n.b."}<br><small>${escapeHtml(w.prijs_toelichting || "")}</small>`; })}
        ${rij("Subsidie (ISDE, indicatie)", (w) => (w.isde_indicatie_eur ? `circa ${eurFmt.format(w.isde_indicatie_eur)}` : "?"))}
        ${rij("Geluid buitenunit", (w) => (w.geluid_db ? `${w.geluid_db} dB(A)` : "?"))}
        ${rij("Koudemiddel", (w) => escapeHtml(w.koudemiddel || "?"))}
        ${rij("Max. aanvoertemperatuur", (w) => (w.max_aanvoer_c ? `${w.max_aanvoer_c} °C` : "?"))}
        ${rij("Warm tapwater", (w) => escapeHtml(w.tapwater || "?"))}
        ${rij("Koppel-score", (w) => `<b>${koppelScore(w)}/6</b>`)}
        ${rij("Slimme aansturing", (w) => d3(w.sturing))}
        ${rij("Home Assistant", (w) => d3(w.home_assistant))}
        ${rij("Homey", (w) => d3(w.homey))}
        ${rij("App", (w) => escapeHtml(w.app || "?"))}
        ${rij("Garantie", (w) => (w.garantie_jaar ? w.garantie_jaar + " jaar" : "?"))}
        ${rij("", (w) => { const b = bestePrijs(w); return b && b.url ? `<a class="knop" href="${escapeHtml(koopUrl(b))}" target="_blank" rel="noopener">Naar fabrikant ${Iconen.svg("pijl-rechts")}</a>` : ""; })}
      </table>
      </div>`;
  }

  /* ------------------------------------------------------------------
     Hoofd-render en events
     ------------------------------------------------------------------ */

  function render() {
    syncUrl();
    const lijst = gesorteerd(gefilterd());
    el("resultatenTelling").textContent = `${lijst.length} van ${state.pompen.length} warmtepompen`;

    const doel = el("resultaten");
    if (!lijst.length) {
      doel.innerHTML = '<div class="leeg-melding">Geen warmtepompen gevonden met deze filters. Probeer een filter uit te zetten.</div>';
    } else if (state.weergave === "kaarten") {
      doel.innerHTML = `<div class="kaarten-grid">${lijst.map(kaartHtml).join("")}</div>`;
    } else {
      doel.innerHTML = `<div class="tabel-wrap">${tabelHtml(lijst)}</div>`;
    }

    const balk = el("vergelijkBalk");
    if (balk) {
      if (state.vergelijkSelectie.length >= 2) {
        balk.classList.add("zichtbaar");
        document.body.classList.add("vergelijkbalk-actief");
        el("vergelijkBalkTekst").textContent = `${state.vergelijkSelectie.length} warmtepompen geselecteerd`;
      } else {
        balk.classList.remove("zichtbaar");
        document.body.classList.remove("vergelijkbalk-actief");
      }
    }
  }

  function koppelEvents() {
    [["filterType", "type"], ["filterMerk", "merk"]].forEach(([id, key]) => {
      el(id).addEventListener("change", (e) => { state.filters[key] = e.target.value; render(); });
    });
    [["checkR290", "r290"], ["checkStil", "stil"], ["checkHa", "officieelHa"]].forEach(([id, key]) => {
      el(id).addEventListener("change", (e) => { state.filters[key] = e.target.checked; render(); });
    });
    el("sorteer").addEventListener("change", (e) => { state.sortering = e.target.value; render(); });

    const zoekVeld = el("zoekVeld");
    if (zoekVeld) zoekVeld.addEventListener("input", (e) => { state.filters.zoek = e.target.value; render(); });

    const reset = el("resetFilters");
    if (reset) reset.addEventListener("click", () => {
      state.filters = { zoek: "", type: "alle", merk: "alle", r290: false, stil: false, officieelHa: false };
      ["filterType", "filterMerk"].forEach((id) => { el(id).value = "alle"; });
      ["checkR290", "checkStil", "checkHa"].forEach((id) => { el(id).checked = false; });
      if (zoekVeld) zoekVeld.value = "";
      render();
    });

    el("knopKaarten").addEventListener("click", () => { state.weergave = "kaarten"; el("knopKaarten").classList.add("actief"); el("knopTabel").classList.remove("actief"); render(); });
    el("knopTabel").addEventListener("click", () => { state.weergave = "tabel"; el("knopTabel").classList.add("actief"); el("knopKaarten").classList.remove("actief"); render(); });

    el("resultaten").addEventListener("click", (e) => {
      const badge = e.target.closest(".kaart-badges .badge");
      if (badge) {
        const kaart = badge.closest(".paneel-kaart");
        const details = kaart && kaart.querySelector(".kaart-details");
        const knop = kaart && kaart.querySelector(".details-toggle");
        if (!details) return;
        if (details.hidden) { details.hidden = false; if (knop) knop.textContent = "Verberg details"; }
        const label = badge.dataset.uitleg || "";
        let doel = null;
        details.querySelectorAll("dt").forEach((dt) => {
          if (!doel && label && dt.textContent.trim().startsWith(label)) doel = dt;
        });
        details.querySelectorAll(".uitgelicht").forEach((n) => n.classList.remove("uitgelicht"));
        const uitgelicht = doel ? [doel, doel.nextElementSibling] : [details];
        uitgelicht.forEach((n) => { if (n) { void n.offsetWidth; n.classList.add("uitgelicht"); } });
        (doel || details).scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const toggle = e.target.closest(".details-toggle");
      if (toggle) {
        const details = document.querySelector(`[data-details="${toggle.dataset.id}"]`);
        if (details) {
          details.hidden = !details.hidden;
          toggle.textContent = details.hidden ? "Meer details" : "Verberg details";
        }
        return;
      }
      const th = e.target.closest("th[data-kolom]");
      if (th && th.dataset.kolom !== "actie") {
        if (state.tabelSortKolom === th.dataset.kolom) state.tabelSortRichting *= -1;
        else { state.tabelSortKolom = th.dataset.kolom; state.tabelSortRichting = 1; }
        render();
      }
    });

    el("resultaten").addEventListener("change", (e) => {
      const check = e.target.closest(".vergelijk-check");
      if (!check) return;
      const id = check.dataset.id;
      if (check.checked) {
        if (state.vergelijkSelectie.length >= 3) {
          check.checked = false;
          const tekst = el("vergelijkBalkTekst");
          const oud = tekst.textContent;
          tekst.textContent = "Maximaal 3 warmtepompen tegelijk; haal er eerst één weg.";
          setTimeout(() => { tekst.textContent = oud; }, 2500);
          return;
        }
        state.vergelijkSelectie.push(id);
      } else {
        state.vergelijkSelectie = state.vergelijkSelectie.filter((x) => x !== id);
      }
      render();
    });

    el("openVergelijk").addEventListener("click", () => {
      const items = state.pompen.filter((w) => state.vergelijkSelectie.includes(w.id));
      el("vergelijkModalInhoud").innerHTML = vergelijkModalHtml(items);
      el("vergelijkModal").classList.add("open");
    });
    el("wisVergelijk").addEventListener("click", () => { state.vergelijkSelectie = []; render(); });
    el("sluitModal").addEventListener("click", () => el("vergelijkModal").classList.remove("open"));
    el("vergelijkModal").addEventListener("click", (e) => { if (e.target === el("vergelijkModal")) el("vergelijkModal").classList.remove("open"); });

    const filterToggle = el("filterToggle");
    if (filterToggle) {
      filterToggle.addEventListener("click", () => {
        const balk = el("filterbalk");
        const ingeklapt = balk.classList.toggle("ingeklapt");
        filterToggle.innerHTML = `${Iconen.svg("zoeken")} Filteren en sorteren ${Iconen.svg("chevron", { klasse: ingeklapt ? "" : "gedraaid" })}`;
      });
    }
  }

  /* ------------------------------------------------------------------
     Init
     ------------------------------------------------------------------ */

  async function init() {
    try {
      const res = await fetch("data/warmtepompen.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      state.pompen = data.warmtepompen || [];

      const teller = el("tellerPompen");
      if (teller) teller.textContent = state.pompen.length;

      if (data.laatst_bijgewerkt) {
        const d = new Date(data.laatst_bijgewerkt + "T12:00:00");
        const doel = el("updateDatum");
        if (doel) doel.textContent = datumFmt.format(d);
      }

      const merken = [...new Set(state.pompen.map((w) => w.merk))].sort((a, b) => a.localeCompare(b, "nl"));
      el("filterMerk").innerHTML = '<option value="alle">Alle merken</option>' + merken.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");

      koppelEvents();
      leesUrl();
      render();
    } catch (err) {
      el("resultaten").innerHTML = '<div class="leeg-melding">De warmtepompgegevens konden niet worden geladen. Vernieuw de pagina of probeer het later opnieuw.</div>';
      console.error("Fout bij laden warmtepompen.json:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
