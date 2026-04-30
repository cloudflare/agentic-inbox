interface SparklineProps {
	values: number[];
	height?: number;
	color?: string;
}

// Fixed virtual width — the SVG stretches to fill its container via
// `preserveAspectRatio="none"`, so callers don't pass a pixel width. This is
// what lets the chart reflow cleanly between a 320px phone and a 1280px
// dashboard pane without overflow or hard-coded magic numbers.
const VIRTUAL_WIDTH = 100;

// Inline SVG line chart. Tiny by design — no axes, no labels, just shape.
// Color defaults to the accent CSS var so it reflows with hue presets.
export default function Sparkline({
	values,
	height = 24,
	color = "var(--accent)",
}: SparklineProps) {
	if (values.length === 0) {
		return <div style={{ width: "100%", height }} />;
	}
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;
	const step =
		values.length > 1 ? VIRTUAL_WIDTH / (values.length - 1) : VIRTUAL_WIDTH;
	const points = values
		.map((v, i) => {
			const x = i * step;
			const y = height - ((v - min) / range) * height;
			return `${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
	return (
		<svg
			width="100%"
			height={height}
			viewBox={`0 0 ${VIRTUAL_WIDTH} ${height}`}
			preserveAspectRatio="none"
			className="overflow-visible"
			aria-hidden
		>
			<polyline
				points={points}
				fill="none"
				stroke={color}
				strokeWidth={1.5}
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}
