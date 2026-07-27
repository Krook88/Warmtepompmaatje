# Warmtepompmaatje.nl

Onafhankelijke vergelijkingssite voor warmtepompen (hybride en all-electric) op de Nederlandse markt. Zustersite van Zonnestroommaatje en Batterijmaatje.nl.

Statische site zonder buildstap: HTML + vanilla JavaScript dat `data/warmtepompen.json` laadt. Ontwikkeld in de map `warmtepompmaatje/` van de dev-repo; productie draait op Vercel.

- `index.html` + `assets/app.js`: vergelijker (kaarten, tabel, vergelijk-modal, Koppel-score)
- `advies.html` + `assets/advies.js`: keuzehulp (hybride of all-electric, besparing, subsidie)
- `rekenmodule.html` + `assets/rekenmodule.js`: besparing en terugverdientijd per pomp
- `uitleg.html`, `subsidie.html`: uitleg en ISDE
- `data/warmtepompen.json`: alle pompen met specificaties, prijzen en koppelingsinfo

## Publiceren

Vercel is via de GitHub-app aan deze repo gekoppeld en publiceert automatisch: elke push naar `main` wordt productie, elke andere branch krijgt een preview-URL. Er is geen buildstap; `vercel.json` regelt alleen de headers en zorgt dat URL's zonder `.html` (zoals `/advies`) blijven werken, net als vroeger op GitHub Pages. De `.html`-variant blijft de canonieke URL in de sitemap en de canonical-tags.

De workflow `update-prijzen.yml` werkt dagelijks de prijzen bij en pusht naar `main`; die push start de publicatie vanzelf. `controleer-links.yml` loopt maandagochtend alle interne en externe links na.

## Contactformulier

`api/contact.js` is de enige serverfunctie op de site: het contactformulier stuurt het bericht per mail door naar `info@batterijmaatje.nl`, de gedeelde postbus van de maatje-sites. Omdat die postbus ook de post van de zustersites ontvangt, staat de herkomst in de onderwerpregel (`[Warmtepompmaatje] …`), in de afzendernaam en onderaan de mail.

Instellen in Vercel onder Settings → Environment Variables:

| Variabele | Waarde |
| --- | --- |
| `SMTP_GEBRUIKER` | het mailadres dat verstuurt, bijvoorbeeld `info@batterijmaatje.nl` |
| `SMTP_WACHTWOORD` | het wachtwoord van die mailbox |
| `CONTACT_AAN` | ontvanger; standaard gelijk aan `SMTP_GEBRUIKER` |
| `SMTP_HOST` | standaard `smtp.transip.email` |
| `SMTP_POORT` | standaard `465` |

Zolang `SMTP_GEBRUIKER` of `SMTP_WACHTWOORD` ontbreekt, accepteert het formulier niets en krijgt de bezoeker het mailadres te zien. Het formulier is dan dus niet stuk, alleen niet actief.
