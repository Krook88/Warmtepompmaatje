/* ==========================================================================
   Warmtepompmaatje - rekenmodule besparing en terugverdientijd
   Rekent per warmtepomp uit wat hij per jaar bespaart op gas, wat de extra
   stroom kost en in hoeveel jaar de investering is terugverdiend.
   Aannames staan uitgelegd op de pagina onder "Hoe rekenen wij?" en zijn
   gelijk aan de vuistregels van de keuzehulp.
   ========================================================================== */

(function () {
  "use strict";

  const el = (id) => document.getElementById(id);
  const eurFmt = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const numFmt = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });

  // Vaste aannames (toegelicht op de pagina onder "Hoe rekenen wij?")
  const AANDEEL_VERWARMING = 0.75;   // circa 75% van het gas gaat naar verwarming (Milieu Centraal)
  const KWH_PER_M3 = 8.8;            // nuttige warmte per m3 gas via een moderne cv-ketel
  const HYBRIDE_DEKKING = 0.6;       // aandeel van de totale warmtevraag dat een hybride overneemt (gelijk aan de keuzehulp)
  const HYBRIDE_SCOP = 4.5;          // hybride draait vooral op gunstige momenten
  const ALLEL_SCOP = 4.0;            // all-electric praktijkrendement voor verwarming
  const TAPWATER_COP = 2.5;          // warm water en koken via boilervat en inductie
  const INSTALLATIE_HYBRIDE = 2500;  // schatting montage en inregelen
  const INSTALLATIE_ALLEL = 4500;    // schatting montage, boiler en aanpassingen
  const LEVENSDUUR_JAAR = 15;        // gemiddelde levensduur van een warmtepomp
  const CO2_PER_M3 = 1.78;           // kg CO2 per m3 aardgas (co2emissiefactoren.nl)
  const CO2_PER_KWH = 0.27;          // kg CO2 per kWh Nederlandse stroommix (indicatie)

  let pompen = [];

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  function bestePrijs(w) {
    const aanbiedingen = (w.aanbiedingen || []).filter((a) => a && a.prijs_eur);
    if (aanbiedingen.length) {
      return aanbiedingen.reduce((min, a) => (a.prijs_eur < min.prijs_eur || (a.prijs_eur === min.prijs_eur && a.datum && !min.datum) ? a : min));
    }
    if (w.richtprijs_eur) return { winkel: null, prijs_eur: w.richtprijs_eur, url: w.product_url };
    return null;
  }

  function gekozenPomp() {
    const id = el("keuzePomp").value;
    return pompen.find((w) => w.id === id) || null;
  }

  function invoer() {
    const w = gekozenPomp();
    const beste = w ? bestePrijs(w) : null;
    const type = w ? w.type : "hybride";
    const eigenInstallatie = Number(el("installatiekosten").value) || 0;
    return {
      w, type, beste,
      gas: Math.max(300, Number(el("gasverbruik").value) || 1200),
      gasprijs: Number(el("gasprijs").value) || 1.45,
      stroomprijs: Number(el("stroomprijs").value) || 0.30,
      vastrecht: Number(el("vastrecht").value) || 0,
      afsluitkosten: Number(el("afsluitkosten").value) || 0,
      gasAf: type === "all-electric" && el("checkGasAf").checked,
      toestelPrijs: beste ? beste.prijs_eur : 0,
      installatie: eigenInstallatie > 0 ? eigenInstallatie : (type === "hybride" ? INSTALLATIE_HYBRIDE : INSTALLATIE_ALLEL),
      installatieGeschat: eigenInstallatie <= 0,
      isde: w ? (w.isde_indicatie_eur || 0) : 0,
    };
  }

  function bereken() {
    const s = invoer();
    if (!s.w) return;

    // Warmtevraag opsplitsen: circa 75% verwarming, 25% warm water en koken
    const verwarmingGas = s.gas * AANDEEL_VERWARMING;
    const restGas = s.gas - verwarmingGas;

    let gasBespaard, stroomKwh;
    if (s.type === "hybride") {
      // De hybride neemt circa 60% van de totale warmtevraag over (circa 80% van de
      // verwarming; warm water en piekkou blijven bij de ketel), gelijk aan de keuzehulp
      gasBespaard = s.gas * HYBRIDE_DEKKING;
      stroomKwh = (gasBespaard * KWH_PER_M3) / HYBRIDE_SCOP;
    } else {
      // All-electric vervangt alles: verwarming via de pomp, warm water via het boilervat
      gasBespaard = s.gas;
      stroomKwh = (verwarmingGas * KWH_PER_M3) / ALLEL_SCOP + (restGas * KWH_PER_M3) / TAPWATER_COP;
    }

    const vastrechtBesparing = s.gasAf ? s.vastrecht : 0;
    const besparingJaar = gasBespaard * s.gasprijs + vastrechtBesparing - stroomKwh * s.stroomprijs;

    const investering = s.toestelPrijs + s.installatie + (s.gasAf ? s.afsluitkosten : 0);
    const netto = Math.max(0, investering - s.isde);

    const tvt = besparingJaar > 0 ? netto / besparingJaar : null;
    const tvtTekst = tvt === null || tvt > 40 ? "meer dan 40 jaar" : `${tvt.toFixed(1).replace(".", ",")} jaar`;

    const besparingLevensduur = besparingJaar * LEVENSDUUR_JAAR;
    const co2 = Math.round(gasBespaard * CO2_PER_M3 - stroomKwh * CO2_PER_KWH);
    const gasOver = Math.round(s.gas - gasBespaard);

    // Staafdiagram voor en na: energiekosten voor verwarming, warm water en koken.
    // "Voor" is de huidige situatie met cv-ketel; "na" met de gekozen warmtepomp.
    // Voor − na is precies de besparing per jaar hierboven.
    // Kleuren met betekenis: gas is terracotta (vlam), stroom is blauw, vaste kosten grijs
    const voorDelen = [
      { label: "gas", kleur: "var(--kleur-primair)", bedrag: s.gas * s.gasprijs },
      { label: "vaste gaskosten", kleur: "#a8a29e", bedrag: s.vastrecht },
    ];
    const naDelen = [
      { label: "gas", kleur: "var(--kleur-primair)", bedrag: gasOver * s.gasprijs },
      { label: "vaste gaskosten", kleur: "#a8a29e", bedrag: s.gasAf ? 0 : s.vastrecht },
      { label: "stroom warmtepomp", kleur: "var(--kleur-blauw, #2563eb)", bedrag: stroomKwh * s.stroomprijs },
    ];
    const totaalVoor = voorDelen.reduce((t, d) => t + d.bedrag, 0);
    const totaalNa = naDelen.reduce((t, d) => t + d.bedrag, 0);
    const maxTotaal = Math.max(totaalVoor, totaalNa) || 1;
    const balk = (delen) => `<div class="vgl-balk">${delen.filter((d) => d.bedrag > 0.5).map((d) =>
      `<span title="${d.label}: ${eurFmt.format(d.bedrag)}" style="width:${(d.bedrag / maxTotaal) * 100}%;background:${d.kleur};"></span>`).join("")}</div>`;
    const legendaKleuren = [...new Map([...voorDelen, ...naDelen].filter((d) => d.bedrag > 0.5).map((d) => [d.label, d.kleur])).entries()];
    const voorNaDiagram = `
      <div class="vgl-blok" role="img" aria-label="Energiekosten per jaar: nu ${eurFmt.format(totaalVoor)}, met deze warmtepomp ${eurFmt.format(totaalNa)}.">
        <p class="vgl-titel">Je energiekosten voor warmte, per jaar</p>
        <div class="vgl-tabel">
          <div class="vgl-rij"><span class="vgl-label">Nu (cv-ketel)</span>${balk(voorDelen)}<b class="vgl-bedrag">${eurFmt.format(totaalVoor)}</b></div>
          <div class="vgl-rij"><span class="vgl-label">Met deze pomp</span>${balk(naDelen)}<b class="vgl-bedrag">${eurFmt.format(totaalNa)}</b></div>
        </div>
        <p class="vgl-legenda">${legendaKleuren.map(([label, kleur]) => `<span><i style="background:${kleur};"></i>${label}</span>`).join(" ")}</p>
        <p class="vgl-verschil">${besparingJaar >= 0 ? `${Iconen.svg("omlaag")} ${eurFmt.format(besparingJaar)} per jaar lager` : `${Iconen.svg("omhoog")} ${eurFmt.format(-besparingJaar)} per jaar hoger`}</p>
      </div>`;

    el("resultaatInhoud").innerHTML = `
      <div class="resultaat-groot">${tvtTekst}</div>
      <p class="hint" style="margin:0 0 14px;">geschatte terugverdientijd${s.installatieGeschat ? " (bij geschatte installatiekosten)" : ""}</p>
      <div class="resultaat-rij"><span>Warmtepomp</span><b>${escapeHtml(s.w.merk)} ${escapeHtml(s.w.model)} (${s.type === "hybride" ? "hybride" : "all-electric"})</b></div>
      <div class="resultaat-rij"><span>Toestel ${s.beste && s.beste.winkel ? `<small>(laagste prijs, bij ${escapeHtml(s.beste.winkel)})</small>` : "<small>(richtprijs)</small>"}</span><b>${eurFmt.format(s.toestelPrijs)}</b></div>
      <div class="resultaat-rij"><span>Installatie ${s.installatieGeschat ? "<small>(schatting)</small>" : ""}${s.gasAf && s.afsluitkosten ? ` <small>+ gas afsluiten ${eurFmt.format(s.afsluitkosten)}</small>` : ""}</span><b>${eurFmt.format(s.installatie + (s.gasAf ? s.afsluitkosten : 0))}</b></div>
      <div class="resultaat-rij"><span>ISDE-subsidie <small>(indicatie)</small></span><b>− ${eurFmt.format(s.isde)}</b></div>
      <div class="resultaat-rij"><span>Netto investering</span><b>${eurFmt.format(netto)}</b></div>
      <div class="resultaat-rij"><span>Gasbesparing per jaar</span><b>${numFmt.format(gasBespaard)} m³${s.type === "hybride" ? ` <small style="font-weight:400;color:var(--kleur-tekst-licht);">(${numFmt.format(gasOver)} m³ blijft voor piekkou en warm water)</small>` : ""}</b></div>
      <div class="resultaat-rij"><span>Extra stroomverbruik per jaar</span><b>${numFmt.format(stroomKwh)} kWh</b></div>
      ${vastrechtBesparing ? `<div class="resultaat-rij"><span>Vaste gaskosten vervallen</span><b>${eurFmt.format(vastrechtBesparing)} per jaar</b></div>` : ""}
      <div class="resultaat-rij"><span>Besparing per jaar</span><b>${eurFmt.format(besparingJaar)} <small style="font-weight:400;color:var(--kleur-tekst-licht);">(≈ ${eurFmt.format(besparingJaar / 12)} per maand)</small></b></div>
      <div class="resultaat-rij"><span>Besparing over ${LEVENSDUUR_JAAR} jaar <small>(gemiddelde levensduur)</small></span><b>${eurFmt.format(besparingLevensduur)}</b></div>
      <div class="resultaat-rij"><span>Netto voordeel over ${LEVENSDUUR_JAAR} jaar</span><b>${eurFmt.format(besparingLevensduur - netto)}</b></div>
      <div class="resultaat-rij"><span>Vermeden CO₂-uitstoot per jaar <small>(indicatie)</small></span><b>circa ${numFmt.format(co2)} kg</b></div>
      ${voorNaDiagram}
      ${tvt !== null && tvt > LEVENSDUUR_JAAR ? `<p class="hint" style="margin-top:12px;background:var(--kleur-accent-licht);border-radius:8px;padding:10px 12px;">${Iconen.svg("let-op")} De terugverdientijd is langer dan de gemiddelde levensduur van ${LEVENSDUUR_JAAR} jaar. Financieel is dit dan vooral een duurzame keuze. Check of een goedkopere pomp, een hybride of eerst isoleren beter uitpakt; de <a href="advies.html">keuzehulp</a> helpt daarbij.</p>` : ""}
      ${s.type === "all-electric" && !s.gasAf ? `<p class="hint" style="margin-top:12px;">${Iconen.svg("tip")} Laat je de gasaansluiting aan (bijvoorbeeld om op gas te koken), dan blijf je circa ${eurFmt.format(s.vastrecht)} per jaar aan vaste gaskosten betalen. Die zijn hier niet als besparing meegerekend.</p>` : ""}
      <p style="margin-top:14px;"><a href="pomp/${encodeURIComponent(s.w.id)}.html">Alle details van de ${escapeHtml(s.w.merk)} ${escapeHtml(s.w.model)} ${Iconen.svg("pijl-rechts")}</a></p>
      <p class="hint" style="margin-top:10px;">Indicatie op basis van jouw invoer en onze aannames; geen offerte of financieel advies.</p>
    `;
  }

  function toonGasAfVeld() {
    const w = gekozenPomp();
    const allElectric = w && w.type === "all-electric";
    const veld = el("veldGasAf");
    // Van het gas af is bij all-electric het gangbare doel: standaard aangevinkt
    if (allElectric && veld.hidden) el("checkGasAf").checked = true;
    if (!allElectric) el("checkGasAf").checked = false;
    veld.hidden = !allElectric;
  }

  async function init() {
    try {
      const res = await fetch("data/warmtepompen.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      pompen = ((await res.json()).warmtepompen || []).slice()
        .sort((a, b) => (a.type === b.type ? 0 : a.type === "hybride" ? -1 : 1) || `${a.merk} ${a.model}`.localeCompare(`${b.merk} ${b.model}`, "nl"));

      const select = el("keuzePomp");
      select.innerHTML = pompen.map((w) => {
        const b = bestePrijs(w);
        return `<option value="${escapeHtml(w.id)}">${escapeHtml(w.merk)} ${escapeHtml(w.model)} — ${w.type === "hybride" ? "hybride" : "all-electric"}, ${b ? eurFmt.format(b.prijs_eur) : "prijs onbekend"}</option>`;
      }).join("");

      // Voorselectie via ?pomp=<id> (vanuit de vergelijker en de keuzehulp)
      const params = new URLSearchParams(location.search);
      const gevraagd = params.get("pomp");
      if (gevraagd && pompen.some((w) => w.id === gevraagd)) select.value = gevraagd;
      const gevraagdGas = Number(params.get("gas"));
      if (gevraagdGas >= 300 && gevraagdGas <= 6000) el("gasverbruik").value = gevraagdGas;

      ["keuzePomp", "gasverbruik", "gasprijs", "stroomprijs", "vastrecht", "afsluitkosten", "installatiekosten"].forEach((id) => {
        el(id).addEventListener("input", bereken);
        el(id).addEventListener("change", bereken);
      });
      el("keuzePomp").addEventListener("change", () => { toonGasAfVeld(); bereken(); });
      el("checkGasAf").addEventListener("change", bereken);

      toonGasAfVeld();
      bereken();
    } catch (err) {
      el("resultaatInhoud").innerHTML = '<p class="hint">De gegevens konden niet worden geladen. Vernieuw de pagina of probeer het later opnieuw.</p>';
      console.error("Fout bij laden warmtepompen.json:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
