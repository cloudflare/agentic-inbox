interface SparklineProps {
	values: number[];
	width?: number;
	height?: number;
	color?: string;
}

// Inline SVG line chart. Tiny by design — no axes, no labels, just shape.
// Color defaults to the accent CSS var so it reflows with hue presets.
export default function Sparkline({
	values,
	width = 96,
	height = 24,
	color = "var(--accent)",
}: SparklineProps) {
	if (values.length === 0) {
		return <div style={{ width, height }} />;
	}
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;
	const step = values.length > 1 ? width / (values.length - 1) : width;
	const points = values
		.map((v, i) => {
			const x = i * step;
			const y = height - ((v - min) / range) * height;
			return `${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
	return (
		<svg
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
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
			/>
		</svg>
	);
}
