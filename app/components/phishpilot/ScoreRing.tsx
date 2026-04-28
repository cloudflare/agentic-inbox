interface ScoreRingProps {
	score: number;
	size?: number;
	stroke?: number;
}

// Circular progress + big serif number. Color is keyed to the same severity
// thresholds as scoreToneClass(); we use raw CSS vars here so the SVG stroke
// updates with theme changes.
export default function ScoreRing({ score, size = 80, stroke = 6 }: ScoreRingProps) {
	const clamped = Math.max(0, Math.min(100, score));
	const radius = (size - stroke) / 2;
	const circumference = 2 * Math.PI * radius;
	const dash = (clamped / 100) * circumference;

	const color = clamped >= 80
		? "var(--danger)"
		: clamped >= 70
			? "var(--suspect)"
			: clamped >= 60
				? "color-mix(in oklch, var(--suspect) 70%, transparent)"
				: "var(--ink-3)";

	return (
		<div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
			<svg width={size} height={size} className="rotate-[-90deg]">
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					fill="none"
					stroke="var(--line)"
					strokeWidth={stroke}
				/>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					fill="none"
					stroke={color}
					strokeWidth={stroke}
					strokeLinecap="round"
					strokeDasharray={`${dash} ${circumference}`}
				/>
			</svg>
			<div className="absolute inset-0 flex flex-col items-center justify-center">
				<span className="pp-serif leading-none" style={{ fontSize: size * 0.42, color }}>
					{Math.round(clamped)}
				</span>
				<span className="text-[9px] uppercase tracking-wider text-ink-3 mt-0.5">
					/ 100
				</span>
			</div>
		</div>
	);
}
