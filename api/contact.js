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

  const regels = [
    `Site: ${SITE}`,
    `Naam: ${naam}`,
    `E-mail: ${email}`,
    `Onderwerp: ${onderwerp}`,
    "",
    bericht,
    "",
    "---",
    `Verstuurd via het contactformulier op ${veiligVoorKopregel(req.headers["host"] || SITE)}`,
    `Dit adres (${aan}) is de gedeelde postbus van de maatje-sites:`,
    "Batterijmaatje.nl, Zonnestroommaatje.nl en Warmtepompmaatje.nl.",
    "Dit bericht gaat over warmtepompen.",
  ];

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
      text: regels.join("\n"),
    });
  } catch (fout) {
    console.error("Contactformulier: versturen mislukt:", fout && fout.message);
    return antwoord(req, res, 502, `Het versturen lukte niet. Mail ons rechtstreeks op ${aan}.`);
  }

  return antwoord(req, res, 200, "Bedankt, je bericht is verstuurd. Je krijgt doorgaans binnen een dag antwoord.");
};
