import type { ReactNode } from "react";
import type { VerdictTone } from "./verdict";

interface VerdictPillProps {
	tone: VerdictTone;
	icon?: ReactNode;
	children: ReactNode;
	className?: string;
	title?: string;
}

const TONE_CLASS: Record<VerdictTone, string> = {
	safe: "pp-pill-safe",
	suspect: "pp-pill-suspect",
	danger: "pp-pill-danger",
	info: "pp-pill-info",
	muted: "pp-pill-muted",
	accent: "pp-pill-accent",
};

export default function VerdictPill({
	tone,
	icon,
	children,
	className,
	title,
}: VerdictPillProps) {
	return (
		<span
			title={title}
			className={`pp-pill ${TONE_CLASS[tone]}${className ? ` ${className}` : ""}`}
		>
			{icon}
			{children}
		</span>
	);
}
