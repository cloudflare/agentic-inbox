import {
	BellIcon,
	BriefcaseIcon,
	CaretRightIcon,
	GaugeIcon,
	GearSixIcon,
	GraphIcon,
	MagnifyingGlassIcon,
	MoonIcon,
	SparkleIcon,
	SunIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import { useDashboardSummary } from "~/queries/dashboard";
import { useMailbox, useMailboxes } from "~/queries/mailboxes";
import Logo from "./Logo";

type PipelineTone = "safe" | "suspect" | "danger" | "muted";

interface PipelineState {
	tone: PipelineTone;
	label: string;
	pulse: boolean;
}

// Map the dashboard summary's pipelineSuccess (0..1, or null) to a visible
// pill state. Thresholds match the issue spec (#86): >=0.95 healthy, >=0.5
// degraded, otherwise failing. Null/loading shows muted "No data" — never a
// fake-green dot.
function computePipelineState(
	pipelineSuccess: number | null | undefined,
): PipelineState {
	if (pipelineSuccess == null) {
		return { tone: "muted", label: "No data", pulse: false };
	}
	if (pipelineSuccess >= 0.95) {
		return { tone: "safe", label: "Pipeline online", pulse: true };
	}
	if (pipelineSuccess >= 0.5) {
		return { tone: "suspect", label: "Degraded", pulse: false };
	}
	return { tone: "danger", label: "Pipeline failing", pulse: false };
}

const PIPELINE_DOT_BG: Record<PipelineTone, string> = {
	safe: "bg-safe",
	suspect: "bg-suspect",
	danger: "bg-danger",
	muted: "bg-ink-4",
};

interface NavItemProps {
	to: string;
	icon: ReactNode;
	label: string;
	count?: number | string;
	end?: boolean;
}

function NavItem({ to, icon, label, count, end }: NavItemProps) {
	return (
		<NavLink
			to={to}
			end={end}
			className={({ isActive }) =>
				`relative flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] transition-colors ${
					isActive
						? "bg-paper-3 text-ink"
						: "text-ink-2 hover:bg-paper-2 hover:text-ink"
				}`
			}
		>
			{({ isActive }) => (
				<>
					{isActive && (
						<span
							aria-hidden
							className="absolute left-[-12px] top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-full bg-accent"
						/>
					)}
					<span className="shrink-0 text-current">{icon}</span>
					<span className="flex-1 truncate">{label}</span>
					{count !== undefined && (
						<span className="pp-mono text-[11px] text-ink-3 tabular-nums">
							{count}
						</span>
					)}
				</>
			)}
		</NavLink>
	);
}

function SectionLabel({ children }: { children: ReactNode }) {
	return (
		<div className="px-3 pt-4 pb-1.5 text-[10.5px] uppercase tracking-[0.08em] text-ink-4">
			{children}
		</div>
	);
}

export default function Shell({ children }: { children: ReactNode }) {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const { theme, toggleTheme } = useUIStore();
	const { data: mailbox } = useMailbox(mailboxId);
	const { data: mailboxes } = useMailboxes();
	const mailboxCount = mailboxes?.length ?? 0;
	const orgDomain = mailbox?.email?.split("@")[1] ?? "—";
	const orgInitial = (mailbox?.name || mailbox?.email || "?")[0]?.toUpperCase();

	const base = mailboxId ? `/mailbox/${encodeURIComponent(mailboxId)}` : "";

	const { data: dashboardSummary } = useDashboardSummary(mailboxId);
	const pipelineState = computePipelineState(dashboardSummary?.pipelineSuccess);

	const searchInputRef = useRef<HTMLInputElement>(null);
	const [searchQuery, setSearchQuery] = useState("");

	useEffect(() => {
		// Cmd/Ctrl+K from anywhere focuses the search input.
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				searchInputRef.current?.focus();
				searchInputRef.current?.select();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const handleSearchSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const q = searchQuery.trim();
		if (!q || !mailboxId) return;
		navigate(
			`/mailbox/${encodeURIComponent(mailboxId)}/search?q=${encodeURIComponent(q)}`,
		);
	};

	return (
		<div className="flex h-screen overflow-hidden bg-paper text-ink">
			{/* Sidebar — 232px on desktop, hidden on mobile (mobile collapse not in scope for POC). */}
			<aside className="hidden md:flex w-[232px] shrink-0 flex-col bg-paper-2 border-r border-line">
				<div className="px-4 pt-4 pb-3">
					<Logo />
				</div>

				{/* Org switcher card — clicking it would open a tenant switcher;
				    in POC it just routes to the home picker. */}
				<button
					type="button"
					onClick={() => navigate("/")}
					className="mx-3 flex items-center gap-2.5 rounded-md border border-line bg-paper px-2.5 py-2 text-left hover:border-line-strong transition-colors"
				>
					<span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-tint text-accent-ink pp-serif text-[15px]">
						{orgInitial}
					</span>
					<span className="flex-1 min-w-0">
						<span className="block truncate text-[12.5px] font-medium text-ink">
							{mailbox?.name || "Select mailbox"}
						</span>
						<span className="block truncate text-[10.5px] text-ink-3">
							{orgDomain} · {mailboxCount} mailbox{mailboxCount === 1 ? "" : "es"}
						</span>
					</span>
					<CaretRightIcon size={12} className="text-ink-3 shrink-0" />
				</button>

				<nav className="mt-3 px-3 flex-1 overflow-y-auto">
					{mailboxId ? (
						<>
							<NavItem
								to={`${base}/dashboard`}
								icon={<GaugeIcon size={16} />}
								label="Dashboard"
							/>
							<NavItem
								to={`${base}/cases`}
								icon={<BriefcaseIcon size={16} />}
								label="Cases"
							/>
							<NavItem
								to={`${base}/emails/inbox`}
								icon={<TrayIcon size={16} />}
								label="Mail review"
							/>
							<NavItem
								to={`${base}/hub`}
								icon={<GraphIcon size={16} />}
								label="Threat-intel hub"
							/>
							<SectionLabel>System</SectionLabel>
							<NavItem
								to={`${base}/settings`}
								icon={<GearSixIcon size={16} />}
								label="Settings"
							/>
						</>
					) : (
						<div className="px-3 py-2 text-[12px] text-ink-3">
							Pick a mailbox to begin.
						</div>
					)}
				</nav>

				{/* Pipeline status pill. State derives from the dashboard summary's
				    `pipelineSuccess` (#86). Real p50/p95 latency is tracked in #71
				    and isn't surfaced here yet — the previous static "p50 —"
				    placeholder was misleading and has been removed. */}
				{mailboxId && (
					<button
						type="button"
						role="status"
						aria-live="polite"
						aria-label={`Pipeline status: ${pipelineState.label}`}
						onClick={() => navigate(`${base}/dashboard`)}
						className="mx-3 mb-3 flex items-center gap-2 rounded-md border border-line bg-paper px-2.5 py-1.5 text-left hover:border-line-strong transition-colors"
					>
						<span className="relative flex h-2 w-2">
							{pipelineState.pulse && (
								<span
									aria-hidden
									className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${PIPELINE_DOT_BG[pipelineState.tone]}`}
								/>
							)}
							<span
								aria-hidden
								className={`relative inline-flex h-2 w-2 rounded-full ${PIPELINE_DOT_BG[pipelineState.tone]}`}
							/>
						</span>
						<span className="text-[11px] text-ink-2">
							{pipelineState.label}
						</span>
					</button>
				)}

				<div className="border-t border-line px-3 py-2.5 flex items-center gap-2">
					<div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-tint text-accent-ink text-[11px] font-medium">
						SA
					</div>
					<div className="flex-1 min-w-0">
						<div className="text-[12px] text-ink truncate">SOC analyst</div>
						<div className="text-[10.5px] text-ink-3 truncate">Preview</div>
					</div>
					<button
						type="button"
						onClick={toggleTheme}
						className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 hover:bg-paper-3 hover:text-ink transition-colors"
						aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
					>
						{theme === "dark" ? <SunIcon size={14} /> : <MoonIcon size={14} />}
					</button>
				</div>
			</aside>

			{/* Main column. Topbar pinned, content scrolls. */}
			<div className="flex-1 flex flex-col min-w-0">
				<header className="flex items-center gap-3 h-[52px] px-4 md:px-6 border-b border-line bg-paper">
					<form
						role="search"
						onSubmit={handleSearchSubmit}
						className="flex items-center gap-2 flex-1 max-w-xl"
					>
						<MagnifyingGlassIcon size={14} className="text-ink-3 shrink-0" />
						<input
							ref={searchInputRef}
							type="search"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="flex-1 bg-transparent border-0 outline-none text-[13px] text-ink placeholder:text-ink-4"
							placeholder="Search emails…  ⌘K"
							aria-label="Search"
						/>
					</form>
					<div className="ml-auto flex items-center gap-1.5 shrink-0">
						<button
							type="button"
							className="flex h-8 w-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink transition-colors"
							aria-label="Notifications"
						>
							<BellIcon size={16} />
						</button>
						<button
							type="button"
							className="flex items-center gap-1.5 rounded-md bg-accent-tint border border-[color-mix(in_oklch,var(--accent)_25%,transparent)] px-2.5 py-1.5 text-[12px] font-medium text-accent-ink hover:bg-[color-mix(in_oklch,var(--accent-tint)_70%,var(--paper))] transition-colors"
						>
							<SparkleIcon size={13} weight="fill" className="text-accent" />
							Ask co-pilot
						</button>
					</div>
				</header>

				<main className="flex-1 overflow-y-auto">{children}</main>
			</div>
		</div>
	);
}
