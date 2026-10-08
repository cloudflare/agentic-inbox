export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "agentic-inbox-theme";

function isPreference(value: unknown): value is ThemePreference {
	return value === "light" || value === "dark" || value === "system";
}

export function readThemePreference(): ThemePreference {
	try {
		const value = localStorage.getItem(THEME_STORAGE_KEY);
		if (isPreference(value)) return value;
	} catch {}
	return "system";
}

export function writeThemePreference(preference: ThemePreference) {
	try {
		localStorage.setItem(THEME_STORAGE_KEY, preference);
	} catch {}
}

export function applyTheme(preference: ThemePreference) {
	const dark =
		preference === "dark" ||
		(preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.setAttribute("data-mode", dark ? "dark" : "light");
}

// Runs in <head> before first paint so dark-mode users never see a light flash.
export const THEME_INIT_SCRIPT = `(function(){var p="system";try{var v=localStorage.getItem("${THEME_STORAGE_KEY}");if(v==="light"||v==="dark"||v==="system")p=v}catch(e){}var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-mode",d?"dark":"light")})();`;
