import { Button, Tooltip } from "@cloudflare/kumo";
import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { applyTheme, readThemePreference, writeThemePreference, type ThemePreference } from "~/lib/theme";

const NEXT: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };
const LABELS: Record<ThemePreference, string> = { light: "Light theme", dark: "Dark theme", system: "System theme" };

export default function ThemeToggle({ className }: { className?: string }) {
	// null until mounted, so SSR and the first client render match.
	const [preference, setPreference] = useState<ThemePreference | null>(null);

	useEffect(() => {
		setPreference(readThemePreference());
	}, []);

	useEffect(() => {
		if (!preference) return;
		applyTheme(preference);
		if (preference !== "system") return;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => applyTheme("system");
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [preference]);

	const current = preference ?? "system";
	const cycle = () => {
		const next = NEXT[current];
		writeThemePreference(next);
		setPreference(next);
	};
	const icon =
		current === "light" ? <SunIcon size={18} /> : current === "dark" ? <MoonIcon size={18} /> : <DesktopIcon size={18} />;

	return (
		<Tooltip content={LABELS[current]} side="bottom" asChild>
			<Button variant="ghost" shape="square" size="sm" icon={icon} onClick={cycle} aria-label={LABELS[current]} className={className} />
		</Tooltip>
	);
}
