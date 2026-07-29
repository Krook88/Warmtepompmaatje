/* ==========================================================================
   Warmtepompmaatje - keuzehulp
   Adviseert hybride of all-electric op basis van woning en gasverbruik, en
   kiest de best passende warmtepompen uit data/warmtepompen.json.
   Aannames staan uitgelegd op de pagina onder "Hoe komt dit advies tot stand?".
   ========================================================================== */

(function () {
  "use strict";

  const el = (id) => document.getElementById(id);
  const eurFmt = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const numFmt = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });

  let pompen = [];

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  function driewaardig(v) {
    if (v && typeof v === "object") return { status: v.status || "deels", tekst: v.tekst || "" };
    return { status: "nee", tekst: "Nee" };
  }

  const punt = (v) => { const s = driewaardig(v).status; return s === "ja" ? 2 : s === "deels" ? 1 : 0; };
  const koppelScore = (w) => punt(w.sturing) + punt(w.home_assistant) + punt(w.homey);

  // Prijslogica: zie assets/prijs.js. De keuzehulp rekent uitsluitend met de
  // vergelijkprijs (altijd incl. btw), anders zou een pomp die bij een
  // installateursshop staat 21% te goedkoop uit de scoring komen.
  const bestePrijs = (w) => Prijs.beste(w);
  const vergelijkPrijs = (a) => Prijs.vergelijkPrijs(a);

  function invoer() {
    return {
      gas: Math.max(300, Number(el("gasverbruik").value) || 1200),
      cvKetel: el("cvKetel").value,             // recent | oud | geen
      isolatie: el("isolatie").value,           // goed | redelijk | matig
      afgifte: el("afgifte").value,             // vloer | mix | radiatoren
      buren: el("buren").value,                 // vrij | dichtbij
      smartHome: el("smartHome").value,         // geen | home_assistant | homey
      zon: el("checkZon").checked,
      batterij: el("checkBatterij").checked,
      gasprijs: 1.45,
      stroomprijs: 0.30,
    };
  }

  /* ------------------------------------------------------------------
     Advies: hybride of all-electric
     ------------------------------------------------------------------ */

  function typeAdvies(s) {
    // Zonder cv-ketel is hybride technisch niet mogelijk: die pompt naast een ketel
    if (s.cvKetel === "geen") {
      if (s.isolatie === "matig") {
        return { type: "all-electric", reden: "Zonder cv-ketel is hybride niet mogelijk, dus wordt het all-electric. Let op: bij matige isolatie is eerst (na)isoleren sterk aan te raden, en kies een pomp met hoge aanvoertemperatuur. Laat de installateur het warmteverlies doorrekenen." };
      }
      return { type: "all-electric", reden: "Zonder cv-ketel is hybride niet mogelijk: een hybride warmtepomp werkt altijd naast een ketel. All-electric is dan de logische keuze en levert bovendien de hoogste subsidie op." };
    }
    // All-electric vraagt om een laag warmteverlies of hoge aanvoertemperatuur;
    // bij matige isolatie is hybride de veilige route (zie uitleg op de pagina)
    if (s.isolatie === "goed") {
      const ketelZin = s.cvKetel === "oud"
        ? " Je ketel is toch aan vervanging toe: een mooi moment om hem er meteen uit te doen."
        : " Je huidige ketel kan dan weg; wil je hem toch laten hangen, dan is hybride een goedkoper alternatief.";
      return { type: "all-electric", reden: "Je woning is goed geïsoleerd: all-electric kan de cv-ketel volledig vervangen en levert de grootste besparing en de hoogste subsidie op." + ketelZin };
    }
    if (s.isolatie === "redelijk" && s.afgifte !== "radiatoren") {
      return { type: "all-electric", reden: "Met redelijke isolatie en (deels) vloerverwarming kan all-electric, mits de installateur het warmteverlies doorrekent. Kies een pomp met hoge aanvoertemperatuur als reserve." + (s.cvKetel === "oud" ? " Je ketel is toch aan vervanging toe, dus dit is een natuurlijk moment." : "") };
    }
    if (s.isolatie === "redelijk") {
      const ketelZin = s.cvKetel === "oud"
        ? " Let op: een hybride heeft een goed werkende ketel naast zich nodig. Is jouw ketel echt op, reken dan ook een nieuwe ketel mee of overweeg toch all-electric na (na)isolatie."
        : " Jouw ketel kan gewoon blijven hangen en vangt de piekkou op.";
      return { type: "hybride", reden: "Redelijke isolatie met alleen radiatoren: een hybride pakt nu al 50 tot 70% gasbesparing, zonder risico op een koud huis. All-electric kan later, na (na)isolatie of met hoge-temperatuurradiatoren." + ketelZin };
    }
    const ketelZin = s.cvKetel === "oud"
      ? " Omdat je ketel aan vervanging toe is: reken een nieuwe (of goed nagekeken) ketel mee, want de hybride leunt op hem tijdens piekkou."
      : " Jouw ketel blijft gewoon hangen en vangt de piekkou op.";
    return { type: "hybride", reden: "Bij een ouder, matig geïsoleerd huis is hybride de verstandige eerste stap: grote gasbesparing, terwijl de ketel de piekkou opvangt. Isoleer eerst verder voordat je all-electric overweegt." + ketelZin };
  }

  /* ------------------------------------------------------------------
     Besparingsindicatie (vuistregels, uitgelegd op de pagina)
     ------------------------------------------------------------------ */

  function besparing(s, type) {
    // 1 m3 gas levert circa 8,8 kWh nuttige warmte via een moderne cv-ketel.
    // Dezelfde vuistregels als de rekenmodule (terugverdientijd).
    let gasBespaard, stroomKwh;
    if (type === "hybride") {
      gasBespaard = s.gas * 0.6;                          // circa 60% van de totale warmtevraag
      stroomKwh = (gasBespaard * 8.8) / 4.5;              // hybride draait vooral op gunstige momenten
    } else {
      gasBespaard = s.gas;                                // all-electric vervangt alles
      const verwarmingGas = s.gas * 0.75;                 // circa 75% verwarming (Milieu Centraal)
      stroomKwh = (verwarmingGas * 8.8) / 4.0 + ((s.gas - verwarmingGas) * 8.8) / 2.5; // warm water via boilervat
    }
    const nettoPerJaar = gasBespaard * s.gasprijs - stroomKwh * s.stroomprijs;
    return { gasBespaard: Math.round(gasBespaard), stroomKwh: Math.round(stroomKwh), nettoPerJaar: Math.round(nettoPerJaar) };
  }

  /* ------------------------------------------------------------------
     Pompen scoren binnen het geadviseerde type
     ------------------------------------------------------------------ */

  /**
   * Een ontbrekend gegeven mocht eerder als slechtste waarde meetellen: geen
   * bekende prijs gold als de duurste, geen geluidswaarde als 60 dB. Daardoor
   * zakten pompen waarvan wíj iets niet weten steevast naar de onderkant en
   * haalden ze de top drie nooit - een oordeel over onze administratie, niet
   * over de pomp.
   *
   * Nu telt zo'n criterium mee met het gemiddelde van de andere pompen: we
   * weten het niet, dus gaan we uit van doorsnee. De redenen onder het advies
   * benoemen wat er ontbreekt, zodat de bezoeker het zelf kan wegen.
   */
  function scorePompen(s, type) {
    const kandidaten = pompen.filter((w) => w.type === type);
    const nettoVan = (w) => { const b = vergelijkPrijs(bestePrijs(w)); return b == null ? null : b - (w.isde_indicatie_eur || 0); };
    const prijzen = kandidaten.map(nettoVan).filter((n) => n != null);
    const minP = Math.min(...prijzen), maxP = Math.max(...prijzen);

    const gemiddelde = (fn) => {
      const w = kandidaten.map(fn).filter((n) => n != null);
      return w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0;
    };
    const gemPrijsDeel = gemiddelde((w) => { const n = nettoVan(w); return n == null ? null : (maxP - n) / (maxP - minP || 1); });
    const gemStil = gemiddelde((w) => (w.geluid_db ? Math.max(0, 60 - w.geluid_db) / 10 : null));
    const gemAanvoer = gemiddelde((w) => (w.max_aanvoer_c ? (w.max_aanvoer_c >= 70 ? 1 : 0) : null));
    const gemScop = gemiddelde((w) => (w.scop ? (w.scop - 4) * 1.2 : null));

    return kandidaten.map((w) => {
      let score = 0;
      // Nettoprijs (prijs minus subsidie-indicatie): goedkoper = beter
      const netto = nettoVan(w);
      score += 2.5 * (netto == null ? gemPrijsDeel : (maxP - netto) / (maxP - minP || 1));
      // Geluid weegt zwaar bij buren dichtbij
      const stil = w.geluid_db ? Math.max(0, 60 - w.geluid_db) / 10 : gemStil; // 0 (60 dB) tot ~1 (50 dB)
      score += stil * (s.buren === "dichtbij" ? 3 : 1);
      // Smart home-platform
      if (s.smartHome === "home_assistant") score += punt(w.home_assistant) * 1.5;
      else if (s.smartHome === "homey") score += punt(w.homey) * 1.5;
      else score += punt(w.sturing) * 0.5;
      // Zonnepanelen: slimme aansturing laat de pomp op zonnestroom draaien
      if (s.zon) score += punt(w.sturing) * 1.2;
      // Thuisbatterij: slimme aansturing laat de pomp op goedkope of eigen stroom draaien
      if (s.batterij) score += punt(w.sturing) * 1.2;
      // Bestaande radiatoren: hoge aanvoertemperatuur is dan waardevol
      if (s.afgifte === "radiatoren" && type === "all-electric") score += 1.5 * (w.max_aanvoer_c ? (w.max_aanvoer_c >= 70 ? 1 : 0) : gemAanvoer);
      // Rendement
      score += w.scop ? (w.scop - 4) * 1.2 : gemScop;
      return { w, score, netto };
    }).sort((a, b) => b.score - a.score).slice(0, 3);
  }

  function redenVoor(w, s) {
    const redenen = [];
    // Expliciet op "bekend" toetsen en niet op (w.geluid_db || 99): dat idioom
    // gaf hier het juiste antwoord, maar in de vergelijker leverde het een
    // onbekende waarde af als 99 dB(A). Nergens meer, dus.
    if (typeof w.geluid_db === "number" && w.geluid_db <= 55) redenen.push(`stil (${w.geluid_db} dB(A))`);
    if (s.smartHome === "home_assistant" && driewaardig(w.home_assistant).status === "ja") redenen.push("officiële Home Assistant-integratie");
    if (s.smartHome === "home_assistant" && driewaardig(w.home_assistant).status === "deels") redenen.push("Home Assistant via community-route");
    if (s.smartHome === "homey" && driewaardig(w.homey).status !== "nee") redenen.push(driewaardig(w.homey).status === "ja" ? "Homey-app beschikbaar" : "Homey via community-app");
    if ((s.zon || s.batterij) && driewaardig(w.sturing).status === "ja") redenen.push("slim aan te sturen op eigen of goedkope stroom");
    if (/R290/i.test(w.koudemiddel || "")) redenen.push("natuurlijk koudemiddel (R290)");
    if ((w.max_aanvoer_c || 0) >= 70 && s.afgifte === "radiatoren") redenen.push(`hoge aanvoertemperatuur (${w.max_aanvoer_c} °C) voor bestaande radiatoren`);
    redenen.push(`Koppel-score ${koppelScore(w)}/6`);
    // Eerlijk zijn over wat we niet weten: die punten zijn met een gemiddelde
    // ingevuld, dus de bezoeker moet kunnen zien waar dat is gebeurd.
    const onbekend = [
      !bestePrijs(w) && "prijs",
      !w.geluid_db && "geluid",
      !w.max_aanvoer_c && "aanvoertemperatuur",
    ].filter(Boolean);
    if (onbekend.length) redenen.push(`let op: ${onbekend.join(" en ")} nog niet vastgesteld`);
    return redenen.slice(0, 4).join(" · ");
  }

  /* ------------------------------------------------------------------
     Renderen
     ------------------------------------------------------------------ */

  function adviseer() {
    const s = invoer();
    const advies = typeAdvies(s);
    const b = besparing(s, advies.type);
    const top = scorePompen(s, advies.type);
    const plekken = [`${Iconen.svg("medaille")} Beste match`, `${Iconen.svg("medaille")} Tweede keus`, `${Iconen.svg("medaille")} Derde keus`];

    const smartRegel = (() => {
      if (!top.length) return "";
      const w = top[0].w;
      if (s.smartHome === "home_assistant") {
        const d = driewaardig(w.home_assistant);
        return `Home Assistant: ${d.status === "ja" ? `${Iconen.svg("ja")} officiële integratie` : d.status === "deels" ? `${Iconen.svg("deels")} via community-integratie` : `${Iconen.svg("nee")} geen bekende integratie`}`;
      }
      if (s.smartHome === "homey") {
        const d = driewaardig(w.homey);
        return `Homey: ${d.status === "ja" ? `${Iconen.svg("ja")} app beschikbaar` : d.status === "deels" ? `${Iconen.svg("deels")} via community-app` : `${Iconen.svg("nee")} geen app; verbruik wel zichtbaar via de Homey Energy Dongle (P1)`}`;
      }
      return "";
    })();

    el("adviesInhoud").innerHTML = `
      <div class="advies-samenvatting">
        <div class="groot">${advies.type === "hybride" ? "Hybride warmtepomp" : "All-electric warmtepomp"}</div>
        <p style="margin:6px 0 0;">${advies.reden}</p>
        <p style="margin:8px 0 0;">Indicatie: circa <b>${numFmt.format(b.gasBespaard)} m³ gas minder</b> per jaar, tegen circa ${numFmt.format(b.stroomKwh)} kWh extra stroom. Netto besparing: <b>circa ${eurFmt.format(b.nettoPerJaar)} per jaar</b> (≈ ${eurFmt.format(b.nettoPerJaar / 12)} per maand).</p>
        ${s.zon ? `<p class="hint" style="margin:6px 0 0;">${Iconen.svg("zon")} Met zonnepanelen wordt het voordeliger: een slim aangestuurde pomp draait extra wanneer je panelen stroom over hebben. Daarom wegen wij slimme aansturing zwaarder mee.</p>` : ""}
        ${s.batterij ? `<p class="hint" style="margin:6px 0 0;">${Iconen.svg("batterij")} Met een thuisbatterij loont slimme aansturing dubbel: de pomp verwarmt op momenten dat stroom goedkoop is of de batterij vol zit. Daarom wegen wij slimme aansturing zwaarder mee. Nog geen batterij? Vergelijk ze op <a href="https://batterijmaatje.nl/" target="_blank" rel="noopener">Batterijmaatje.nl</a>.</p>` : ""}
        ${s.buren === "dichtbij" ? `<p class="hint" style="margin:6px 0 0;">${Iconen.svg("stil")} Omdat je buren dichtbij wonen, wegen wij het geluid van de buitenunit zwaar mee. Op de erfgrens geldt in de nacht een eis van 40 dB.</p>` : ""}
      </div>

      <h2 style="margin-top:20px;">De drie best passende warmtepompen</h2>
      ${top.map(({ w, netto }, i) => {
        const beste = bestePrijs(w);
        return `
        <div class="advies-kaart">
          <span class="plek">${plekken[i]}</span>
          <h3>${escapeHtml(w.merk)} ${escapeHtml(w.model)}</h3>
          <div class="reden">${redenVoor(w, s)}</div>
          <p style="margin:8px 0 0;font-size:0.95rem;">${beste && !beste.is_richtprijs ? `laagste prijs <b>${eurFmt.format(vergelijkPrijs(beste))}</b>, goedkoopst bij <a href="${escapeHtml(beste.url || "")}" target="_blank" rel="noopener">${escapeHtml(beste.winkel)}</a>` : `richtprijs <b>${beste ? eurFmt.format(vergelijkPrijs(beste)) : "?"}</b>`} · ISDE-subsidie circa <b>${w.isde_indicatie_eur ? eurFmt.format(w.isde_indicatie_eur) : "?"}</b> · netto circa <b>${eurFmt.format(netto)}</b> voor het toestel (excl. installatie)</p>
          ${Prijs.prijsToelichting(beste) ? `<p class="hint" style="margin:4px 0 0;font-size:0.88rem;">${escapeHtml(Prijs.prijsToelichting(beste))}</p>` : ""}
          <p style="margin:8px 0 0;">${beste && !beste.is_richtprijs && beste.url ? `<a class="knop" style="padding:8px 14px;font-size:0.88rem;" href="${escapeHtml(beste.url)}" target="_blank" rel="noopener">Bekijk aanbieding ${Iconen.svg("pijl-rechts")}</a> ` : ""}<a class="knop knop-secundair" style="padding:8px 14px;font-size:0.88rem;" href="rekenmodule.html?pomp=${encodeURIComponent(w.id)}&gas=${s.gas}">Terugverdientijd ${Iconen.svg("pijl-rechts")}</a> <a class="knop knop-secundair" style="padding:8px 14px;font-size:0.88rem;" href="pomp/${encodeURIComponent(w.id)}.html">Alle details ${Iconen.svg("pijl-rechts")}</a></p>
        </div>`;
      }).join("")}
      ${smartRegel ? `<p style="margin:12px 0 0;font-size:0.92rem;">${Iconen.svg("huis")} ${smartRegel}</p>` : ""}

      <div class="advies-kaart" style="margin-top:18px;">
        <span class="plek">${Iconen.svg("koppeling")} Maak het compleet</span>
        <p style="margin:8px 0 0;font-size:0.95rem;">Een warmtepomp draait het voordeligst op eigen zonnestroom. Vergelijk zonnepanelen en omvormers op <a href="https://zonnestroommaatje.nl/" target="_blank" rel="noopener">Zonnestroommaatje</a>, en thuisbatterijen op <a href="https://batterijmaatje.nl/" target="_blank" rel="noopener">Batterijmaatje.nl</a>. Check daarna de <a href="subsidie.html">ISDE-subsidie</a>: die geldt per apparaat. Of bekijk alles in één keer met <a href="https://zonnestroommaatje.nl/energieplan.html" target="_blank" rel="noopener">het energieplan ${Iconen.svg("pijl-rechts")}</a></p>
      </div>
      <p class="hint" style="margin-top:12px;">Dit advies is een startpunt, geen offerte of warmteverliesberekening. Laat een installateur altijd het vermogen bepalen; een te grote pomp pendelt en een te kleine wordt duur. <a href="javascript:window.print()">${Iconen.svg("printen")} Advies afdrukken</a></p>
    `;
  }

  async function init() {
    try {
      const res = await fetch("data/warmtepompen.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      pompen = (await res.json()).warmtepompen || [];
      ["gasverbruik", "cvKetel", "isolatie", "afgifte", "buren", "smartHome"].forEach((id) => {
        el(id).addEventListener("input", adviseer);
        el(id).addEventListener("change", adviseer);
      });
      el("checkZon").addEventListener("change", adviseer);
      el("checkBatterij").addEventListener("change", adviseer);
      adviseer();
    } catch (err) {
      el("adviesInhoud").innerHTML = '<p class="hint">De gegevens konden niet worden geladen. Vernieuw de pagina of probeer het later opnieuw.</p>';
      console.error("Fout bij laden warmtepompen.json:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
