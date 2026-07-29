/* ==========================================================================
   Prijslogica - één bron van waarheid voor de hele site
   ==========================================================================

   Waarom dit bestand bestaat: prijzen op deze site komen uit verschillende
   winkels en dekken niet allemaal hetzelfde. De ene prijs is een losse
   buitenunit excl. btw bij een installateursshop, de andere een compleet
   toestel incl. btw bij een consumentenwinkel. Wie die getallen ongewijzigd
   naast elkaar zet, vergelijkt appels met peren: een prijs excl. btw lijkt 21%
   goedkoper zonder dat er iets goedkoper is.

   Daarom rekent alles hier eerst om naar één maatstaf - de vergelijkprijs,
   altijd incl. btw - en gebruiken de vergelijker, de keuzehulp, de rekenmodule
   en de generator van de pomppagina's dezelfde functies.

   Datamodel (alle velden optioneel, de standaard is de veiligste aanname):

     aanbieding.btw_inbegrepen   false = deze winkelprijs is excl. btw.
                                 Weggelaten betekent incl. btw, zoals gebruikelijk
                                 bij consumentenverkoop in Nederland.
     aanbieding.omvat            Korte tekst als deze aanbieding iets anders dekt
                                 dan de richtprijs, bijvoorbeeld "alleen de
                                 buitenunit". Zolang dit veld gevuld is, gelden de
                                 richtprijs en deze aanbieding niet als hetzelfde
                                 product en wordt er dus geen korting berekend.
     pomp.richtprijs_btw_inbegrepen
                                 Idem voor de richtprijs zelf.

   Zelfde opzet als op de zustersites, met één afwijking: beste() geeft hier
   voorrang aan aanbiedingen die het complete toestel dekken. Zonder dat kwam
   de Bosch Compress 5800i AW op de kaart te staan voor het bedrag van de losse
   buitenunit (5695 euro), terwijl het complete toestel bij een andere winkel
   7500 kost. Het goedkoopste getal is dan wel het laagste, maar niet de prijs
   van wat je nodig hebt. De deelaanbieding blijft gewoon in de winkellijst
   staan, met de toelichting erbij.

   Werkt zowel in de browser (window.Prijs) als in Node (require).
   ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Prijs = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const BTW_FACTOR = 1.21;

  // Een prijs geldt als incl. btw tenzij het databestand het tegendeel zegt.
  function inclusiefBtw(item) {
    return !item || item.btw_inbegrepen !== false;
  }

  // De vergelijkprijs: hetzelfde getal voor iedereen, altijd incl. btw.
  // Dit is het enige bedrag waarop gesorteerd, gefilterd en gerekend mag worden.
  function vergelijkPrijs(aanbieding) {
    if (!aanbieding || typeof aanbieding.prijs_eur !== "number") return null;
    return inclusiefBtw(aanbieding)
      ? aanbieding.prijs_eur
      : Math.round(aanbieding.prijs_eur * BTW_FACTOR);
  }

  // Is de winkelprijs omgerekend, dan mag de site dat niet stilzwijgend doen.
  function isOmgerekend(aanbieding) {
    return !!aanbieding && !inclusiefBtw(aanbieding);
  }

  function geldigeAanbiedingen(w) {
    return ((w && w.aanbiedingen) || []).filter((a) => a && typeof a.prijs_eur === "number");
  }

  // De richtprijs als aanbieding-achtig object, zodat de rest van de code geen
  // onderscheid hoeft te maken tussen "winkel gevonden" en "alleen richtprijs".
  function richtprijsAlsAanbieding(w) {
    if (!w || typeof w.richtprijs_eur !== "number") return null;
    return {
      winkel: "richtprijs (indicatie)",
      prijs_eur: w.richtprijs_eur,
      url: w.product_url,
      btw_inbegrepen: w.richtprijs_btw_inbegrepen !== false,
      // Geen winkel gevonden: dit is een indicatie, geen bedrag dat je ergens
      // kunt afrekenen. De kaart benoemt dat, anders leest "richtprijs" als
      // de naam van een webshop.
      is_richtprijs: true,
    };
  }

  // Dekt deze aanbieding hetzelfde als de richtprijs? Zo niet, dan is het
  // verschil tussen beide geen korting maar een verschil in wat je krijgt.
  function zelfdeSamenstelling(aanbieding) {
    return !aanbieding || !aanbieding.omvat;
  }

  /**
   * De prijs die de kaart toont.
   *
   * Gekozen op vergelijkprijs en niet op het rauwe getal: anders wint een prijs
   * excl. btw altijd van een eerlijke prijs incl. btw.
   *
   * En binnen die vergelijkprijs eerst kijken naar aanbiedingen die het hele
   * toestel dekken. Een losse buitenunit is bijna altijd goedkoper dan een
   * compleet systeem; die als kopprijs tonen geeft een bedrag waar je niet mee
   * kunt stoken. Zijn er alleen deelaanbiedingen, dan wordt die wel getoond -
   * met de toelichting uit "omvat" eronder.
   */
  function beste(w) {
    const lijst = geldigeAanbiedingen(w);
    const goedkoopste = (l) => l.reduce((min, a) => (vergelijkPrijs(a) < vergelijkPrijs(min) ? a : min));
    const compleet = lijst.filter(zelfdeSamenstelling);
    if (compleet.length) return goedkoopste(compleet);
    if (lijst.length) return goedkoopste(lijst);
    return richtprijsAlsAanbieding(w);
  }

  // Korting bestaat alleen als twee vergelijkbare bedragen worden vergeleken:
  // dezelfde samenstelling en allebei omgerekend naar incl. btw.
  function heeftKorting(w) {
    const aanbieding = beste(w);
    const richtprijs = richtprijsAlsAanbieding(w);
    if (!aanbieding || !richtprijs || aanbieding.is_richtprijs) return false;
    if (!zelfdeSamenstelling(aanbieding)) return false;
    return vergelijkPrijs(aanbieding) < vergelijkPrijs(richtprijs) * 0.97;
  }

  // De van-prijs die je mag doorstrepen, of null als doorstrepen zou misleiden.
  function vanPrijs(w) {
    if (!heeftKorting(w)) return null;
    return vergelijkPrijs(richtprijsAlsAanbieding(w));
  }

  // Korte toevoeging achter de prijs, zodat de bezoeker ziet waaróm het bedrag
  // afwijkt van wat de winkel toont.
  function prijsToelichting(aanbieding) {
    const delen = [];
    if (isOmgerekend(aanbieding)) {
      delen.push(`de winkel toont € ${aanbieding.prijs_eur.toLocaleString("nl-NL")} exclusief btw; hierboven staat het bedrag inclusief 21% btw`);
    }
    if (aanbieding && aanbieding.omvat) delen.push(aanbieding.omvat);
    return delen.join(" · ");
  }

  return {
    BTW_FACTOR,
    inclusiefBtw,
    vergelijkPrijs,
    isOmgerekend,
    geldigeAanbiedingen,
    richtprijsAlsAanbieding,
    beste,
    zelfdeSamenstelling,
    heeftKorting,
    vanPrijs,
    prijsToelichting,
  };
});
