// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { CompassIcon } from "@phosphor-icons/react";
import Sparkline from "~/components/phishsoc/Sparkline";

const STUB_SPARK = [4, 6, 5, 8, 7, 9, 6, 11, 10, 14, 12, 9];

// POC stub. Real dashboard needs aggregation endpoints (verdict mix, fleet
// stats, pipeline snapshot) — not in scope for the preview branch.
export default function DashboardRoute() {
	return (
		<div className="px-6 md:px-10 py-8 max-w-[1280px] space-y-6">
			<div>
				<div className="text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-1">
					Operations · preview
				</div>
				<h1 className="pp-serif text-[40px] leading-none text-ink mb-2">
					Good morning.
				</h1>
				<p className="pp-serif text-[24px] leading-tight text-ink-3 max-w-2xl">
					Here's what changed overnight.
				</p>
			</div>

			<div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
				{[
					{ label: "Threats blocked · 24h", value: "—" },
					{ label: "Open cases", value: "—" },
					{ label: "Pipeline p50", value: "—" },
					{ label: "Intel feed lift", value: "—" },
				].map((k) => (
					<div key={k.label} className="pp-card p-4">
						<div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-3 mb-2">
							{k.label}
						</div>
						<div className="flex items-end justify-between gap-2">
							<div className="pp-serif text-[36px] leading-none text-ink">
								{k.value}
							</div>
							<Sparkline values={STUB_SPARK} />
						</div>
					</div>
				))}
			</div>

			<div
				className="rounded-[14px] p-5 border flex items-start gap-3"
				style={{
					background: "var(--accent-tint)",
					borderColor: "color-mix(in oklch, var(--accent) 25%, transparent)",
				}}
			>
				<span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-paper shrink-0">
					<CompassIcon size={16} weight="fill" />
				</span>
				<div>
					<div className="text-[13px] font-medium text-accent-ink mb-1">
						Co-pilot briefing
					</div>
					<p className="text-[12.5px] text-accent-ink opacity-90 leading-relaxed">
						Dashboard data lights up once we wire the aggregation endpoints
						(verdict mix, fleet stats, pipeline snapshot). For the preview,
						use the <span className="pp-mono">Cases</span> view to evaluate
						the new visual language end-to-end.
					</p>
				</div>
			</div>
		</div>
	);
}
