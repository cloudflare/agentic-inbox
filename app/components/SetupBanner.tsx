import { WarningIcon } from "@phosphor-icons/react";
import { Link as RouterLink, useLocation } from "react-router";
import { useSetupStatus } from "~/queries/setup";

export function SetupBanner() {
	const location = useLocation();
	const { data } = useSetupStatus();

	if (!data || data.isComplete || location.pathname === "/setup") return null;

	const requiredIncomplete = data.steps.filter((s) => s.required && s.status !== "complete" && s.status !== "info");
	if (requiredIncomplete.length === 0) return null;

	return (
		<div className="bg-kumo-warning/10 border-b border-kumo-warning/20 px-4 py-2.5">
			<div className="mx-auto max-w-7xl flex items-center gap-2">
				<WarningIcon size={16} weight="fill" className="text-kumo-warning shrink-0" />
				<span className="text-sm text-kumo-default">
					Setup incomplete — {requiredIncomplete.length} required step{requiredIncomplete.length > 1 ? "s" : ""} remaining
				</span>
				<RouterLink to="/setup" className="text-sm font-medium text-kumo-default underline underline-offset-2 hover:text-kumo-subtle ml-1">
					Finish setup
				</RouterLink>
			</div>
		</div>
	);
}
