// Light/dark toggle for pages with a #theme button. Follows the system until clicked.
(function () {
  var root = document.documentElement, btn = document.getElementById("theme"), mq = matchMedia("(prefers-color-scheme: dark)");
  var dark = function () { return root.dataset.theme ? root.dataset.theme === "dark" : mq.matches; };
  var sync = function () { btn.textContent = dark() ? "Light mode" : "Dark mode"; };
  btn.onclick = function () { root.dataset.theme = dark() ? "light" : "dark"; sync(); };
  mq.addEventListener("change", sync);
  sync();
})();
