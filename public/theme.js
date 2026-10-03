// Wada plate 325 via Nonarkara/palette. Screen adaptations, not printed inks.
(function () {
  "use strict";
  const themes = ["dark", "light", "contrast"];
  let selected;
  try { selected = localStorage.getItem("hcmc-atlas-theme"); } catch (e) {}
  if (!themes.includes(selected)) {
    selected = window.matchMedia("(prefers-contrast: more)").matches ? "contrast"
      : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function apply(theme, persist) {
    if (!themes.includes(theme)) return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
    if (persist) { try { localStorage.setItem("hcmc-atlas-theme", theme); } catch (e) {} }
    const select = document.getElementById("atlas-theme");
    if (select) select.value = theme;
    window.dispatchEvent(new CustomEvent("atlas:theme", { detail: theme }));
  }
  apply(selected, false);
  document.addEventListener("DOMContentLoaded", function () {
    const select = document.getElementById("atlas-theme");
    if (!select) return;
    select.value = document.documentElement.dataset.theme;
    select.addEventListener("change", function () { apply(select.value, true); });
  });
})();
