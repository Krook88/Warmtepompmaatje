/* ==========================================================================
   Contactpagina: formulier versturen en het mailadres kopiëren
   ==========================================================================

   Het formulier werkt ook zonder JavaScript: het is een gewone POST naar
   /api/contact, en de functie stuurt de bezoeker daarna terug met de uitkomst
   in de URL. Dit bestand maakt het alleen prettiger: versturen zonder dat de
   pagina herlaadt, en meteen zichtbaar of het gelukt is.
   ========================================================================== */

(function () {
  "use strict";

  const el = (id) => document.getElementById(id);

  /* ----- Mailadres kopiëren ----------------------------------------- */

  const kopieerKnop = el("kopieerKnop");
  if (kopieerKnop) {
    kopieerKnop.addEventListener("click", function () {
      const adres = kopieerKnop.dataset.adres || "";
      const status = el("kopieerStatus");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(adres).then(
          () => { status.textContent = "Gekopieerd! Plak het adres in je mail-app of webmail."; },
          () => { status.textContent = "Kopiëren lukte niet; het adres is " + adres; }
        );
      } else {
        status.textContent = "Het adres is " + adres;
      }
    });
  }

  /* ----- Formulier --------------------------------------------------- */

  const formulier = el("contactFormulier");
  if (!formulier) return;

  const status = el("formulierStatus");
  const knop = el("verstuurKnop");

  // Het moment waarop de pagina opende. De serverfunctie gebruikt dit om
  // inzendingen te herkennen die binnen enkele milliseconden binnenkomen;
  // die komen niet van iemand die zit te typen.
  const geopend = el("geopendOp");
  if (geopend) geopend.value = String(Date.now());

  // Kwam de bezoeker terug van een verzending zonder JavaScript, dan staat de
  // uitkomst in de URL. Die tonen we hier en halen we daarna weg, zodat een
  // verversing niet opnieuw "verzonden" meldt.
  const parameters = new URLSearchParams(location.search);
  if (parameters.has("verzonden")) {
    toon("Bedankt, je bericht is verstuurd. Je krijgt doorgaans binnen een dag antwoord.", "gelukt");
    formulier.reset();
  } else if (parameters.has("fout")) {
    toon(parameters.get("fout"), "mislukt");
  }
  if (parameters.has("verzonden") || parameters.has("fout")) {
    history.replaceState(null, "", location.pathname + location.hash);
  }

  function toon(boodschap, soort) {
    status.textContent = boodschap;
    status.className = "formulier-status " + (soort || "");
  }

  formulier.addEventListener("submit", async function (gebeurtenis) {
    gebeurtenis.preventDefault();
    toon("Bezig met versturen…", "");
    knop.disabled = true;

    try {
      // Bewust urlencoded en geen FormData: die stuurt multipart/form-data, en
      // dat formaat leest de serveromgeving niet uit naar losse velden. Dit is
      // ook precies wat het formulier zonder JavaScript zou versturen.
      const antwoord = await fetch(formulier.action, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: new URLSearchParams(new FormData(formulier)).toString(),
      });
      const uitkomst = await antwoord.json().catch(() => ({}));

      if (antwoord.ok) {
        toon(uitkomst.boodschap || "Bedankt, je bericht is verstuurd.", "gelukt");
        formulier.reset();
        if (geopend) geopend.value = String(Date.now());
      } else {
        // Geen bruikbare uitleg van de server (bijvoorbeeld bij een storing):
        // noem dan het mailadres, zodat de bezoeker niet met lege handen staat.
        toon(uitkomst.boodschap || "Er ging iets mis bij het versturen. Mail ons op info@batterijmaatje.nl.", "mislukt");
        if (uitkomst.veld && el(uitkomst.veld)) el(uitkomst.veld).focus();
      }
    } catch (fout) {
      // Netwerk eruit of de functie onbereikbaar: dan is het mailadres de
      // uitweg, in plaats van een bericht dat nergens aankomt.
      toon("Versturen lukte niet. Mail ons rechtstreeks op info@batterijmaatje.nl.", "mislukt");
    } finally {
      knop.disabled = false;
    }
  });
})();
