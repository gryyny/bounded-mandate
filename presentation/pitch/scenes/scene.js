// Shows one board in one build state (?board=<id>&state=<n>) and exposes a layout check for ../build.mjs.
//   data-show="n"  visible from state n      data-hide="n"  hidden from state n
//   data-on="n"    adds class "on" (or data-on-class) from state n
(() => {
  const q = new URLSearchParams(location.search);
  const board = document.getElementById(q.get("board") ?? "");
  const state = Number(q.get("state") ?? "1");
  if (board === null) throw new Error(`unknown board ${q.get("board")}`);
  board.classList.add("active");
  for (const el of board.querySelectorAll("[data-show]")) if (state < Number(el.dataset.show)) el.classList.add("off");
  for (const el of board.querySelectorAll("[data-hide]")) if (state >= Number(el.dataset.hide)) el.classList.add("off");
  for (const el of board.querySelectorAll("[data-on]")) if (state >= Number(el.dataset.on)) el.classList.add(el.dataset.onClass ?? "on");

  const SMALL = ".tag, .pill, .cap, .end, .shotcap, .wlabel, .out";
  const HEAD = ".headline, h1";
  const CONTENT_BOTTOM = 870; // captions own the band below
  window.__check = () => {
    const problems = [];
    const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().replace(/\s+/g, ".") : ""} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
    const visible = (el) => getComputedStyle(el).visibility !== "hidden" && el.getClientRects().length > 0;
    for (const el of [document.querySelector(".tag"), ...board.querySelectorAll("*")]) {
      if (el === null || !visible(el)) continue;
      const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
      if (ownText) {
        const px = parseFloat(getComputedStyle(el).fontSize);
        const min = el.closest(HEAD) ? 72 : el.closest(SMALL) ? 26 : 44;
        if (px < min) problems.push(`font ${px}px < ${min}px: ${name(el)}`);
        const r = el.getBoundingClientRect();
        const bottom = el.closest(".tag") ? 1080 : CONTENT_BOTTOM;
        if (r.left < 0 || r.top < 0 || r.right > 1920 + 0.5 || r.bottom > bottom + 0.5) problems.push(`outside the frame (${Math.round(r.left)},${Math.round(r.top)})-(${Math.round(r.right)},${Math.round(r.bottom)}): ${name(el)}`);
      }
      if (el.matches(".headline") && el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).fontSize) * 1.6) problems.push(`headline wraps: ${name(el)}`);
      if (el.matches(".box, .card") && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) problems.push(`content overflows its box: ${name(el)}`);
    }
    return problems;
  };
})();
