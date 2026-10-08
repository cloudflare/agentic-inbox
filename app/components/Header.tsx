// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Tooltip } from "@cloudflare/kumo";
import { GearSixIcon, ListIcon, MagnifyingGlassIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import ThemeToggle from "~/components/ThemeToggle";
import { useUIStore } from "~/hooks/useUIStore";

// 32px quiet ghost icon buttons; the active state uses the selected tone instead of a ring.
const iconButtonClass = "shrink-0 size-8 rounded-lg text-kumo-subtle hover:text-kumo-default";
const activeIconButtonClass = "bg-kumo-selected text-kumo-accent hover:bg-kumo-selected hover:text-kumo-accent";

export default function Header() {
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearchExpanded, setIsSearchExpanded] = useState(false);
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const { toggleSidebar, toggleAgentPanel, isAgentPanelOpen } = useUIStore();

	// Sync search input with URL query param so it stays populated
	const urlQuery = searchParams.get("q") || "";
	useEffect(() => {
		if (location.pathname.includes("/search") && urlQuery) {
			setSearchQuery(urlQuery);
		}
	}, [urlQuery, location.pathname]);

	const performSearch = () => {
		if (mailboxId && searchQuery.trim()) {
			const q = searchQuery.trim();
			navigate(`/mailbox/${mailboxId}/search?q=${encodeURIComponent(q)}`);
			setIsSearchExpanded(false);
		}
	};

	const clearSearch = () => {
		setSearchQuery("");
		if (location.pathname.includes("/search") && mailboxId) {
			navigate(`/mailbox/${mailboxId}/emails/inbox`);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			performSearch();
		}
		if (e.key === "Escape") {
			if (searchQuery) {
				clearSearch();
			} else {
				setIsSearchExpanded(false);
			}
		}
	};

	const isSettingsActive = location.pathname.includes("/settings");

	return (
		<header className="flex items-center h-14 px-4 gap-3 bg-kumo-base border-b border-kumo-line sticky top-0 z-10">
			{/* Hamburger menu - mobile only */}
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={<ListIcon size={18} />}
				onClick={toggleSidebar}
				aria-label="Toggle sidebar"
				className={`md:hidden ${iconButtonClass}`}
			/>

			{/* Search - full on desktop, collapsible on mobile */}
			<div
				className={`flex-1 max-w-xl items-center ${
					isSearchExpanded ? "flex" : "hidden md:flex"
				}`}
			>
				<div className="flex-1 relative flex items-center">
					<Input
						className="w-full h-9 rounded-lg pl-9 pr-8 text-sm bg-kumo-tint ring-transparent transition-colors focus:bg-kumo-base focus:ring-kumo-ring"
						aria-label="Search emails"
						placeholder="Search emails... (try from:name, is:unread, has:attachment)"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={handleKeyDown}
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={clearSearch}
							className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center size-5 rounded-md text-kumo-subtle hover:text-kumo-default hover:bg-kumo-fill-hover transition-colors"
							aria-label="Clear search"
						>
							<XIcon size={14} />
						</button>
					)}
					{/* Leading search icon doubles as the submit button */}
					<Tooltip content="Search" side="bottom" asChild>
						<button
							type="button"
							onClick={performSearch}
							className="absolute left-2 top-1/2 -translate-y-1/2 flex items-center justify-center size-6 rounded-md text-kumo-subtle hover:text-kumo-default transition-colors"
							aria-label="Search"
						>
							<MagnifyingGlassIcon size={16} />
						</button>
					</Tooltip>
				</div>
			</div>

			{/* Search toggle button - mobile only, hidden when search is expanded */}
			{!isSearchExpanded && (
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<MagnifyingGlassIcon size={18} />}
					onClick={() => setIsSearchExpanded(true)}
					aria-label="Search"
					className={`md:hidden ${iconButtonClass}`}
				/>
			)}

			<div className="flex items-center gap-0.5 ml-auto shrink-0">
				<Tooltip content={isAgentPanelOpen ? "Hide agent panel" : "Show agent panel"} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<RobotIcon size={18} />}
						onClick={toggleAgentPanel}
						aria-label="Toggle agent panel"
						className={`hidden lg:inline-flex ${iconButtonClass} ${isAgentPanelOpen ? activeIconButtonClass : ""}`}
					/>
				</Tooltip>
				<ThemeToggle className={iconButtonClass} />
				<Tooltip content="Settings" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<GearSixIcon size={18} />}
						onClick={() =>
							navigate(
								isSettingsActive
									? `/mailbox/${mailboxId}/emails/inbox`
									: `/mailbox/${mailboxId}/settings`,
							)
						}
						aria-label="Settings"
						className={`${iconButtonClass} ${isSettingsActive ? activeIconButtonClass : ""}`}
					/>
				</Tooltip>
			</div>
		</header>
	);
}
