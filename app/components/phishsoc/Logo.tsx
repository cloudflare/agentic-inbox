interface LogoProps {
	size?: number;
	showWordmark?: boolean;
}

// Compass-dial mark + "Phish/SOC" wordmark. Mark uses ink for the dial and
// accent for the indicator; wordmark splits Phish (ink) / SOC (accent) per
// the brand guide.
export default function Logo({ size = 22, showWordmark = true }: LogoProps) {
	return (
		<div className="flex items-center gap-2">
			<svg
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill="none"
				aria-hidden
			>
				<circle cx="12" cy="12" r="10" stroke="var(--ink)" strokeWidth="1.4" />
				<circle cx="12" cy="12" r="1.6" fill="var(--ink)" />
				<path
					d="M12 3 L13.6 12 L12 11.2 L10.4 12 Z"
					fill="var(--accent)"
				/>
				<line x1="12" y1="2" x2="12" y2="4.5" stroke="var(--ink)" strokeWidth="1.2" strokeLinecap="round" />
				<line x1="12" y1="19.5" x2="12" y2="22" stroke="var(--ink-3)" strokeWidth="1.2" strokeLinecap="round" />
				<line x1="2" y1="12" x2="4.5" y2="12" stroke="var(--ink-3)" strokeWidth="1.2" strokeLinecap="round" />
				<line x1="19.5" y1="12" x2="22" y2="12" stroke="var(--ink-3)" strokeWidth="1.2" strokeLinecap="round" />
			</svg>
			{showWordmark && (
				<span className="pp-serif text-[18px] leading-none">
					<span className="text-ink">Phish</span>
					<span className="text-accent">SOC</span>
				</span>
			)}
		</div>
	);
}
