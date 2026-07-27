/* ==========================================================================
   Contactformulier - serverloze functie op Vercel
   ==========================================================================

   De site is verder volledig statisch. Deze ene functie bestaat omdat een
   formulier iets moet doen met wat de bezoeker invult: het bericht wordt per
   mail doorgestuurd naar het adres uit CONTACT_AAN.

   Waarom niet gewoon een mailto-link? Die opent het mailprogramma van de
   bezoeker, en op telefoons of bij webmail werkt dat vaak niet. Bovendien moet
   iemand dan zelf bedenken wat hij erin zet; een formulier vraagt om de dingen
   waar je iets aan hebt.

   Verzending loopt via de mailserver van TransIP, dezelfde die de mailbox van
   het domein bedient. Daardoor is er geen externe maildienst nodig en hoeft er
   niets aan de DNS te veranderen: het SPF-record dat de mail van het domein
   regelt dekt deze verzending al.

   De post komt binnen op info@batterijmaatje.nl, de gedeelde postbus van de
   drie maatje-sites. In een gedeelde postbus is niet vanzelf te zien waar een
   bericht vandaan komt, dus dat staat zowel in de onderwerpregel als onderaan
   de mail. Anders leest een vraag over een warmtepomp als een vraag over een
   thuisbatterij.

   Instellen (Vercel: Settings -> Environment Variables):

     SMTP_GEBRUIKER    Het volledige mailadres van de mailbox die verstuurt,
                       bijvoorbeeld info@batterijmaatje.nl.
     SMTP_WACHTWOORD   Het wachtwoord van die mailbox. Gebruik hiervoor als het
                       kan een aparte mailbox of een apart wachtwoord: deze
                       waarde geeft toegang tot meer dan alleen versturen.
     CONTACT_AAN       Ontvanger. Standaard hetzelfde adres als SMTP_GEBRUIKER.
     CONTACT_VAN       Afzender. Standaard SMTP_GEBRUIKER; TransIP staat alleen
                       verzenden toe namens een adres van de eigen mailbox.
     SMTP_HOST         Standaard smtp.transip.email.
     SMTP_POORT        Standaard 465 (TLS).

   Ontbreken de inloggegevens, dan accepteert het formulier niets en krijgt de
   bezoeker het mailadres te zien, in plaats van dat zijn bericht stilletjes
   verdwijnt. Het formulier is dan dus niet stuk, alleen niet actief.
   ========================================================================== */

"use strict";

const nodemailer = require("nodemailer");

// Gedeelde postbus van de maatje-sites: Batterijmaatje, Zonnestroommaatje en
// Warmtepompmaatje komen alle drie hier binnen.
const FALLBACK_ADRES = "info@batterijmaatje.nl";
const SITE = "Warmtepompmaatje.nl";

const LIMIETEN = {
  naam: 100,
  email: 254,
  onderwerp: 150,
  bericht: 5000,
};

// Een mens heeft tijd nodig om een formulier in te vullen. Een bot plakt zijn
// tekst er in milliseconden in. Dit is geen waterdichte controle, maar het
// scheelt het gros van de geautomatiseerde troep zonder de bezoeker lastig te
// vallen met een puzzel.
const MINIMALE_INVULTIJD_MS = 3000;

// Grofmazige rem per IP. Serverloze functies draaien in meerdere instanties,
// dus dit vangt niet alles af; het beperkt vooral herhaald verzenden vanaf
// dezelfde bezoeker. Echte bescherming tegen een gerichte aanval hoort in de
// firewall van Vercel, niet hier.
const RATELIMIET_AANTAL = 5;
const RATELIMIET_VENSTER_MS = 10 * 60 * 1000;
const verzendingen = new Map();

// Een functie mag op Vercel niet eindeloos wachten. Loopt de mailserver vast,
// dan is een nette foutmelding met het mailadres beter dan een verlopen
// verzoek waar de bezoeker niets van begrijpt.
const SMTP_TIJDSLIMIET_MS = 8000;

function magVerzenden(ip) {
  const nu = Date.now();
  const eerder = (verzendingen.get(ip) || []).filter((t) => nu - t < RATELIMIET_VENSTER_MS);
  if (eerder.length >= RATELIMIET_AANTAL) return false;
  eerder.push(nu);
  verzendingen.set(ip, eerder);
  // Oude IP's opruimen zodat de map niet blijft groeien binnen een instantie
  if (verzendingen.size > 500) {
    for (const [sleutel, tijden] of verzendingen) {
      if (!tijden.some((t) => nu - t < RATELIMIET_VENSTER_MS)) verzendingen.delete(sleutel);
    }
  }
  return true;
}

function tekst(waarde, maximum) {
  return String(waarde == null ? "" : waarde).trim().slice(0, maximum);
}

// Bewust ruim: een adres definitief valideren kan alleen door er iets heen te
// sturen, en te streng afwijzen kost echte berichten.
function lijktOpEmail(waarde) {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(waarde);
}

// Nieuwe regels in een kopregel maken het mogelijk om extra headers te
// smokkelen. De naam van de bezoeker komt in de afzenderregel te staan, dus die
// wordt hier ontdaan van alles wat een regeleinde kan vormen.
function veiligVoorKopregel(waarde) {
  return String(waarde).replace(/[\r\n]+/g, " ").trim();
}

/* ------------------------------------------------------------------
   Opmaak van de mail

   Alles wat de bezoeker invult komt in een HTML-mail terecht, dus het
   moet eerst ontdaan worden van tekens die markup kunnen vormen. Zonder
   dit kan iemand via het berichtveld opmaak of links in jouw postvak
   krijgen.
   ------------------------------------------------------------------ */

function ontsnap(waarde) {
  return String(waarde == null ? "" : waarde)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// Regeleindes uit een textarea worden regeleindes in de mail.
function alinea(waarde) {
  return ontsnap(waarde).replace(/\r?\n/g, "<br>");
}

/* Kleuren van de site. Mailprogramma's kennen geen stylesheet en geen
   custom properties, dus elke regel staat rechtstreeks op het element.
   Om dezelfde reden is de indeling met tabellen gemaakt: Outlook zet
   flexbox en grid gewoon naast zich neer. */
const KLEUR = {
  inkt: "#431407",
  primair: "#c2410c",
  accent: "#f59e0b",
  papier: "#f6f3ec",
  wit: "#ffffff",
  rand: "#e7e1d3",
  tekst: "#24312f",
  tekstLicht: "#5d6d6a",
};

// Figtree staat er wel bij voor het geval een client webfonts toestaat,
// maar vrijwel overal wint de systeemfont erachter. Daarom een stack die
// er ook zonder Figtree rustig uitziet.
const FONT = 'Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * Zet de inhoud in het briefpapier van de site: donkere kop met een amber
 * streepje eronder, zoals de koppen op de website, en een rustige voet.
 *
 * voorvertoning = de regel die postvakken naast het onderwerp tonen. Laat je
 * die weg, dan pakken ze de eerste zin uit de mail, en dat is hier de kop.
 */
function briefpapier({ titel, voorvertoning, inhoud, voet }) {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${ontsnap(titel)}</title>
</head>
<body style="margin:0; padding:0; background:${KLEUR.papier}; color:${KLEUR.tekst}; font-family:${FONT}; font-size:16px; line-height:1.6;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${ontsnap(voorvertoning)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${KLEUR.papier};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; background:${KLEUR.wit}; border:1px solid ${KLEUR.rand}; border-radius:16px; overflow:hidden;">

    <tr><td style="background:${KLEUR.inkt}; padding:22px 28px;">
      <span style="color:${KLEUR.wit}; font-size:19px; font-weight:800; letter-spacing:-0.02em;">Warmtepomp<span style="color:${KLEUR.accent};">maatje</span></span>
    </td></tr>
    <tr><td style="height:4px; background:${KLEUR.accent}; font-size:0; line-height:0;">&nbsp;</td></tr>

    <tr><td style="padding:28px;">
      <h1 style="margin:0 0 16px; font-size:21px; font-weight:800; letter-spacing:-0.02em; color:${KLEUR.inkt};">${ontsnap(titel)}</h1>
      ${inhoud}
    </td></tr>

    <tr><td style="padding:18px 28px 24px; border-top:1px solid ${KLEUR.rand}; background:${KLEUR.papier}; color:${KLEUR.tekstLicht}; font-size:13px; line-height:1.5;">
      ${voet}
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}

// Een rij uit het overzicht bovenaan de meldmail: label links, waarde rechts.
function gegevensRij(label, waarde) {
  return `<tr>
    <td style="padding:7px 12px 7px 0; color:${KLEUR.tekstLicht}; font-size:13px; white-space:nowrap; vertical-align:top;">${ontsnap(label)}</td>
    <td style="padding:7px 0; font-size:15px; font-weight:600; vertical-align:top;">${waarde}</td>
  </tr>`;
}

// De omgeving levert de inhoud van het verzoek soms al uitgepakt aan (bij JSON
// en urlencoded) en soms onbewerkt als Buffer (bij alle andere formaten, zoals
// multipart). Lukt uitpakken niet, dan geeft deze functie null terug in plaats
// van een leeg object: anders lijkt een leesfout op een bezoeker die niets
// invulde, en krijgt hij "vul je naam in" terwijl zijn naam er wel degelijk
// stond.
function velden(req) {
  const body = req.body;
  if (body == null) return null;
  if (Buffer.isBuffer(body)) return uitTekst(body.toString("utf8"));
  if (typeof body === "string") return uitTekst(body);
  if (typeof body === "object") return body;
  return null;
}

function uitTekst(ruw) {
  const inhoud = String(ruw).trim();
  if (!inhoud) return null;
  if (inhoud.startsWith("{")) {
    try { return JSON.parse(inhoud); } catch { return null; }
  }
  if (inhoud.includes("=")) return Object.fromEntries(new URLSearchParams(inhoud));
  return null;
}

function wilJson(req) {
  return String(req.headers["accept"] || "").includes("application/json");
}

function antwoord(req, res, status, boodschap, veld) {
  if (wilJson(req)) {
    return res.status(status).json({ ok: status === 200, boodschap, veld });
  }
  // Zonder JavaScript: terug naar de pagina met de uitkomst in de URL, zodat
  // de bezoeker ziet wat er gebeurd is in plaats van een kale JSON-regel.
  const parameter = status === 200 ? "verzonden=1" : `fout=${encodeURIComponent(boodschap)}`;
  res.setHeader("Location", `/contact.html?${parameter}#formulier`);
  return res.status(303).end();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return antwoord(req, res, 405, "Deze pagina verwacht een ingevuld formulier.");
  }

  const data = velden(req);
  if (!data) {
    console.error("Contactformulier: verzoek niet te lezen, content-type was", req.headers["content-type"]);
    return antwoord(req, res, 400, `Het formulier kon niet gelezen worden. Probeer het opnieuw, of mail naar ${process.env.CONTACT_AAN || FALLBACK_ADRES}.`);
  }

  // Honingpot: een veld dat onzichtbaar is voor bezoekers maar door veel bots
  // wordt ingevuld. Is het gevuld, dan doen we alsof alles goed ging: een bot
  // die een foutmelding krijgt, probeert het net zo lang tot het wel lukt.
  if (tekst(data.website, 100)) {
    return antwoord(req, res, 200, "Bedankt, je bericht is verstuurd.");
  }

  // De tijd komt van de klok van de bezoeker, en die kan verkeerd staan. Alleen
  // afwijzen bij een verschil dat klopt maar te klein is; loopt de klok voor
  // (negatief verschil) of ver achter, dan slaan we de controle over in plaats
  // van een echt bericht te weigeren.
  const geopend = Number(data.geopend_op);
  const invultijd = Date.now() - geopend;
  if (Number.isFinite(geopend) && invultijd >= 0 && invultijd < MINIMALE_INVULTIJD_MS) {
    return antwoord(req, res, 400, "Het formulier werd wel erg snel verstuurd. Probeer het nog een keer.");
  }

  const naam = tekst(data.naam, LIMIETEN.naam);
  const email = tekst(data.email, LIMIETEN.email);
  const onderwerp = tekst(data.onderwerp, LIMIETEN.onderwerp) || "Bericht via het contactformulier";
  const bericht = tekst(data.bericht, LIMIETEN.bericht);

  if (!naam) return antwoord(req, res, 400, "Vul je naam in.", "naam");
  if (!lijktOpEmail(email)) return antwoord(req, res, 400, "Vul een e-mailadres in waarop we je kunnen bereiken.", "email");
  if (bericht.length < 10) return antwoord(req, res, 400, "Schrijf even kort waar je bericht over gaat.", "bericht");

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "onbekend";
  if (!magVerzenden(ip)) {
    return antwoord(req, res, 429, "Er zijn net meerdere berichten verstuurd. Probeer het over een paar minuten opnieuw.");
  }

  const gebruiker = process.env.SMTP_GEBRUIKER;
  const wachtwoord = process.env.SMTP_WACHTWOORD;
  const aan = process.env.CONTACT_AAN || gebruiker || FALLBACK_ADRES;
  const van = process.env.CONTACT_VAN || gebruiker;

  if (!gebruiker || !wachtwoord) {
    console.warn("Contactformulier: SMTP_GEBRUIKER of SMTP_WACHTWOORD ontbreekt, bericht niet verstuurd.");
    return antwoord(req, res, 503, `Het formulier is nog niet ingesteld. Mail zolang naar ${aan}.`);
  }

  const herkomst = veiligVoorKopregel(req.headers["host"] || SITE);

  /* ----- 1. De melding naar de gedeelde postbus ------------------- */

  const meldingTekst = [
    `Site: ${SITE}`,
    `Naam: ${naam}`,
    `E-mail: ${email}`,
    `Onderwerp: ${onderwerp}`,
    "",
    bericht,
    "",
    "---",
    `Verstuurd via het contactformulier op ${herkomst}`,
    `Dit adres (${aan}) is de gedeelde postbus van de maatje-sites:`,
    "Batterijmaatje.nl, Zonnestroommaatje.nl en Warmtepompmaatje.nl.",
    "Dit bericht gaat over warmtepompen.",
  ].join("\n");

  const meldingHtml = briefpapier({
    titel: onderwerp,
    voorvertoning: `${naam}: ${bericht.slice(0, 90)}`,
    inhoud: `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin-bottom:20px;">
        ${gegevensRij("Van", ontsnap(naam))}
        ${gegevensRij("E-mail", `<a href="mailto:${ontsnap(email)}" style="color:${KLEUR.primair};">${ontsnap(email)}</a>`)}
        ${gegevensRij("Onderwerp", ontsnap(onderwerp))}
      </table>
      <div style="border-left:3px solid ${KLEUR.accent}; background:${KLEUR.papier}; border-radius:0 8px 8px 0; padding:14px 16px; font-size:15px;">
        ${alinea(bericht)}
      </div>
      <p style="margin:20px 0 0; font-size:14px; color:${KLEUR.tekstLicht};">Beantwoorden gaat rechtstreeks naar ${ontsnap(naam)}.</p>`,
    voet: `Verstuurd via het contactformulier op ${ontsnap(herkomst)}.<br>
           Dit adres (${ontsnap(aan)}) is de gedeelde postbus van de maatje-sites: Batterijmaatje.nl, Zonnestroommaatje.nl en Warmtepompmaatje.nl.
           <b>Dit bericht gaat over warmtepompen.</b>`,
  });

  /* ----- 2. De bevestiging naar de afzender ----------------------- */

  const bevestigingTekst = [
    `Hoi ${naam},`,
    "",
    "Bedankt voor je bericht aan Warmtepompmaatje. We hebben het goed ontvangen",
    "en je krijgt doorgaans binnen een dag antwoord.",
    "",
    "Dit stuurde je ons:",
    "",
    `Onderwerp: ${onderwerp}`,
    "",
    bericht,
    "",
    "---",
    "Antwoorden komen van info@batterijmaatje.nl. Dat is de gedeelde postbus van",
    "onze drie sites: Batterijmaatje.nl (thuisbatterijen), Zonnestroommaatje.nl",
    "(zonnepanelen) en Warmtepompmaatje.nl (warmtepompen). Je hoeft daar niets",
    "mee te doen; het is dus geen vreemde afzender.",
    "",
    "Op deze mail hoef je niet te reageren.",
  ].join("\n");

  const bevestigingHtml = briefpapier({
    titel: "Bedankt, we hebben je bericht ontvangen",
    voorvertoning: "Je krijgt doorgaans binnen een dag antwoord.",
    inhoud: `
      <p style="margin:0 0 16px;">Hoi ${ontsnap(naam)},</p>
      <p style="margin:0 0 20px;">Bedankt voor je bericht aan Warmtepompmaatje. We hebben het goed ontvangen en je krijgt doorgaans binnen een dag antwoord.</p>
      <p style="margin:0 0 8px; font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:${KLEUR.tekstLicht};">Dit stuurde je ons</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin-bottom:12px;">
        ${gegevensRij("Onderwerp", ontsnap(onderwerp))}
      </table>
      <div style="border-left:3px solid ${KLEUR.accent}; background:${KLEUR.papier}; border-radius:0 8px 8px 0; padding:14px 16px; font-size:15px;">
        ${alinea(bericht)}
      </div>
      <p style="margin:22px 0 0;"><a href="https://warmtepompmaatje.nl/" style="display:inline-block; background:${KLEUR.primair}; color:${KLEUR.wit}; text-decoration:none; font-weight:700; font-size:15px; padding:12px 22px; border-radius:999px;">Terug naar Warmtepompmaatje</a></p>`,
    voet: `Ons antwoord komt van <b>${ontsnap(aan)}</b>, de gedeelde postbus van onze drie sites: Batterijmaatje.nl (thuisbatterijen), Zonnestroommaatje.nl (zonnepanelen) en Warmtepompmaatje.nl (warmtepompen). Dat is dus geen vreemde afzender.<br><br>
           Op deze bevestiging hoef je niet te reageren.`,
  });

  try {
    const poort = Number(process.env.SMTP_POORT) || 465;
    const postbode = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.transip.email",
      port: poort,
      // Poort 465 is versleuteld vanaf het eerste moment; 587 begint open en
      // schakelt over met STARTTLS. Nodemailer regelt dat tweede zelf, mits
      // secure op false staat.
      secure: poort === 465,
      auth: { user: gebruiker, pass: wachtwoord },
      connectionTimeout: SMTP_TIJDSLIMIET_MS,
      greetingTimeout: SMTP_TIJDSLIMIET_MS,
      socketTimeout: SMTP_TIJDSLIMIET_MS,
    });

    await postbode.sendMail({
      // De afzender blijft het eigen adres, want de mailserver staat niet toe
      // dat er namens een vreemd domein wordt verstuurd. De naam van de
      // bezoeker staat ervoor, zodat je in je postvak ziet van wie het komt.
      from: { name: `${veiligVoorKopregel(naam)} via ${SITE}`, address: van },
      to: aan,
      replyTo: { name: veiligVoorKopregel(naam), address: email },
      // De sitenaam staat vooraan in het onderwerp, want deze postbus ontvangt
      // ook de post van de zustersites.
      subject: `[Warmtepompmaatje] ${veiligVoorKopregel(onderwerp)}`,
      text: meldingTekst,
      html: meldingHtml,
    });

    // De bevestiging is een dienst aan de bezoeker, geen voorwaarde. Mislukt
    // die - een postvak dat vol zit, een adres dat toch niet bestaat - dan is
    // het bericht nog steeds bij ons binnen. Daarom een eigen try, en geen
    // foutmelding aan de bezoeker over een mail die hij zelf niet miste.
    try {
      await postbode.sendMail({
        from: { name: SITE, address: van },
        to: { name: veiligVoorKopregel(naam), address: email },
        replyTo: aan,
        subject: `We hebben je bericht ontvangen - ${SITE}`,
        text: bevestigingTekst,
        html: bevestigingHtml,
        // Automatische bevestigingen horen zich als zodanig te melden, zodat
        // afwezigheidsantwoorden en filters er niet op reageren.
        headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
      });
    } catch (fout) {
      console.warn("Contactformulier: bevestiging aan de afzender mislukt:", fout && fout.message);
    }
  } catch (fout) {
    console.error("Contactformulier: versturen mislukt:", fout && fout.message);
    return antwoord(req, res, 502, `Het versturen lukte niet. Mail ons rechtstreeks op ${aan}.`);
  }

  return antwoord(req, res, 200, "Bedankt, je bericht is verstuurd. Je krijgt doorgaans binnen een dag antwoord.");
};
