/* HLM: focus / "zoom to card" from email deep links (?focus=<id> or #<id>)
 *
 * Robust against app.js re-rendering the grid multiple times:
 *   1) seed products render on load  -> we scroll/highlight
 *   2) live inventory arrives later  -> app.js wipes grid.innerHTML & rebuilds
 *      every card. The OLD version disconnected after the first hit, so this
 *      2nd render destroyed the highlighted card and the scroll snapped back to
 *      the top (looked like "just the homepage"). We now KEEP re-anchoring on
 *      each relevant mutation until the grid has been stable for a moment, and
 *      re-apply on age-gate dismissal / loader hide.
 */
(function () {
  function getFocusId() {
    try {
      var p = new URLSearchParams(location.search);
      var f = p.get("focus");
      if (f) return f;
      if (location.hash && location.hash.length > 1) return decodeURIComponent(location.hash.slice(1));
    } catch (e) {}
    return "";
  }
  var FOCUS_ID = getFocusId();
  if (!FOCUS_ID) return;

  function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\\]]/g, "\\$&"); }
  function handleOf(id) { var i = id.indexOf("-"); return i > 0 ? id.slice(i + 1) : id; }

  function findCard(id) {
    // 1) card carrying id="<product.id>"
    var el = document.getElementById(id);
    if (el) return (el.classList && el.classList.contains("card")) ? el : (el.closest ? el.closest(".card") : el);
    // 2) any element carrying data-id="<product.id>"
    var d = document.querySelector('[data-id="' + esc(id) + '"]');
    if (d) return d.closest ? (d.closest(".card") || d) : d;
    // 3) fallback: match the maker link (/products/<handle>) inside a card
    var handle = handleOf(id);
    if (handle) {
      var links = document.querySelectorAll("#grid a[href]");
      for (var k = 0; k < links.length; k++) {
        var h = links[k].getAttribute("href") || "";
        if (h.indexOf("/products/" + handle) > -1) return links[k].closest ? links[k].closest(".card") : null;
      }
    }
    return null;
  }

  var lastCard = null;
  function focusCard(card, force) {
    // Re-scroll/highlight if it's a new node (grid was rebuilt) or forced.
    if (!force && card === lastCard && card.classList.contains("hlm-focus")) return;
    lastCard = card;
    try { card.scrollIntoView({ behavior: "smooth", block: "center" }); }
    catch (e) { try { card.scrollIntoView(); } catch (e2) {} }
    card.classList.remove("hlm-focus");
    // reflow so the animation restarts even if the class was present
    void card.offsetWidth;
    card.classList.add("hlm-focus");
  }

  function attempt(force) {
    var c = findCard(FOCUS_ID);
    if (c) { focusCard(c, force); return true; }
    return false;
  }

  function start() {
    var grid = document.getElementById("grid") || document.body;

    var found = false;
    var settleTimer = null;
    var hardStop = null;
    var obs = null;

    function done() {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      if (hardStop) { clearTimeout(hardStop); hardStop = null; }
      if (obs) { try { obs.disconnect(); } catch (e) {} obs = null; }
    }

    // Re-anchor on every grid mutation; consider it "settled" only after the
    // grid stops changing for a short window (covers the live-inventory reflow).
    function onMutate() {
      if (attempt(true)) {
        found = true;
        if (settleTimer) clearTimeout(settleTimer);
        // Once the DOM is quiet for 1.6s AFTER a successful anchor, stop.
        settleTimer = setTimeout(done, 1600);
      }
    }

    // initial try
    if (attempt(false)) { found = true; settleTimer = setTimeout(done, 1600); }

    obs = new MutationObserver(onMutate);
    try { obs.observe(grid, { childList: true, subtree: true }); }
    catch (e) { try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e2) {} }

    // Backstop polling in case the grid node itself is replaced (observer target lost).
    var tries = 0, MAX = 80; // ~24s
    var iv = setInterval(function () {
      tries++;
      // re-acquire grid if app.js swapped it out
      var g = document.getElementById("grid");
      if (g && obs) { try { obs.observe(g, { childList: true, subtree: true }); } catch (e) {} }
      attempt(false);
      if ((found && !settleTimer) || tries > MAX) { clearInterval(iv); done(); }
    }, 300);

    // Re-focus when the shopper passes the 21+ gate or the loader hides,
    // since those can change layout/scroll after our first anchor.
    var gate = document.getElementById("ageGate");
    if (gate) {
      var gObs = new MutationObserver(function () {
        if (gate.classList.contains("hidden") || gate.style.display === "none") {
          setTimeout(function () { attempt(true); }, 120);
          try { gObs.disconnect(); } catch (e) {}
        }
      });
      try { gObs.observe(gate, { attributes: true, attributeFilter: ["class", "style"] }); } catch (e) {}
    }
    var loader = document.getElementById("hlmLoader");
    if (loader) {
      var lObs = new MutationObserver(function () {
        if (loader.classList.contains("hide")) {
          setTimeout(function () { attempt(true); }, 150);
          try { lObs.disconnect(); } catch (e) {}
        }
      });
      try { lObs.observe(loader, { attributes: true, attributeFilter: ["class"] }); } catch (e) {}
    }

    // Hard cap so nothing lingers.
    hardStop = setTimeout(done, 25000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
