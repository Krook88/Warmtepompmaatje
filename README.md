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

De workflow `update-prijzen.yml` werkt dagelijks de prijzen bij en pusht naar `main`; die push start de publicatie vanzelf.
