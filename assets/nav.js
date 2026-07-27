/* Kleine gedeelde navigatie-helper: sluit het "Meer"-menu zodra er
   buiten het menu wordt getikt of geklikt, zodat het paneel niet als
   onzichtbare overlay over de pagina blijft hangen. */
(function () {
  "use strict";
  document.addEventListener("click", function (e) {
    document.querySelectorAll("details.nav-meer[open]").forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute("open");
    });
  });
})();
