// Reads the persisted Zustand state from localStorage and applies the theme
// + hue to <html> before React hydrates. Loaded synchronously from <head>
// so first paint matches the user's preference. Defaults (dark/Rust) match
// the SSR markup so visitors with empty storage stay consistent.
(function () {
	try {
		var raw = localStorage.getItem("phishsoc-ui");
		var theme = "dark";
		var hue = 35;
		if (raw) {
			var parsed = JSON.parse(raw);
			var s = (parsed && parsed.state) || {};
			if (s.theme === "light" || s.theme === "dark") theme = s.theme;
			if (typeof s.hue === "number") hue = s.hue;
		}
		var el = document.documentElement;
		el.setAttribute("data-theme", theme);
		el.style.setProperty("--hue", String(hue));
	} catch (e) {
		/* fall through to SSR defaults */
	}
})();
