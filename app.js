/* Madame — entrance + hand parallax (the only interactive bit) */
(function () {
  const ready = () => document.body.classList.add("is-ready");
  if (document.readyState !== "loading") ready();
  else document.addEventListener("DOMContentLoaded", ready);

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canHover = window.matchMedia("(hover: hover)").matches;
  if (reduce || !canHover) return;

  document.querySelectorAll(".stage").forEach((stage) => {
    const hand = stage.querySelector(".layer-hand");
    if (!hand) return;
    stage.dataset.hand = "on";

    let raf = null, tx = 0, ty = 0, cx = 0, cy = 0;
    const lerp = (a, b, n) => a + (b - a) * n;

    function tick() {
      cx = lerp(cx, tx, 0.12);
      cy = lerp(cy, ty, 0.12);
      stage.style.setProperty("--px", cx.toFixed(4));
      stage.style.setProperty("--py", cy.toFixed(4));
      if (Math.abs(cx - tx) > 0.001 || Math.abs(cy - ty) > 0.001) {
        raf = requestAnimationFrame(tick);
      } else { raf = null; }
    }
    function move(e) {
      const r = stage.getBoundingClientRect();
      // -1 .. 1 from the stage centre
      tx = ((e.clientX - r.left) / r.width  - 0.5) * 2;
      ty = ((e.clientY - r.top)  / r.height - 0.5) * 2;
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function leave() { tx = 0; ty = 0; if (!raf) raf = requestAnimationFrame(tick); }

    window.addEventListener("pointermove", move, { passive: true });
    stage.addEventListener("pointerleave", leave, { passive: true });
  });
})();
