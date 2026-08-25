// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Tooltip } from "@cloudflare/kumo";
import { GearSixIcon, ListIcon, MagnifyingGlassIcon, RobotIcon, SignOutIcon, XIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import { logout } from "~/services/auth";

export default function Header() {
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearchExpanded, setIsSearchExpanded] = useState(false);
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const { toggleSidebar, toggleAgentPanel, isAgentPanelOpen } = useUIStore();

	const urlQuery = searchParams.get("q") || "";
	useEffect(() => {
		if (location.pathname.includes("/search") && urlQuery) setSearchQuery(urlQuery);
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
		if (location.pathname.includes("/search") && mailboxId) navigate(`/mailbox/${mailboxId}/emails/inbox`);
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter") performSearch();
		if (e.key === "Escape") {
			if (searchQuery) clearSearch();
			else setIsSearchExpanded(false);
		}
	};

	const isSettingsActive = location.pathname.includes("/settings");

	const handleLogout = async () => {
		try { await logout(); } finally { window.location.replace("/login"); }
	};

	return (
		<header className="flex items-center gap-2 px-3 py-2.5 bg-kumo-base border-b border-kumo-line sticky top-0 z-10 md:px-5 md:gap-4">
			<Button variant="ghost" shape="square" size="sm" icon={<ListIcon size={20} />} onClick={toggleSidebar} aria-label="Toggle sidebar" className="md:hidden shrink-0" />

			<div className={`flex-1 max-w-lg transition-all flex items-center gap-1 ${isSearchExpanded ? "flex" : "hidden md:flex"}`}>
				<div className="flex-1 relative flex items-center">
					<Input className="w-full" aria-label="Search emails" placeholder="Search emails... (try from:name, is:unread, has:attachment)" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={handleKeyDown} />
					{searchQuery && <button type="button" onClick={clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint transition-colors" aria-label="Clear search"><XIcon size={14} /></button>}
				</div>
				<Tooltip content="Search" side="bottom" asChild><Button variant="ghost" shape="square" icon={<MagnifyingGlassIcon size={20} />} onClick={performSearch} aria-label="Search" /></Tooltip>
			</div>

			{!isSearchExpanded && <Button variant="ghost" shape="square" size="sm" icon={<MagnifyingGlassIcon size={20} />} onClick={() => setIsSearchExpanded(true)} aria-label="Search" className="md:hidden shrink-0" />}

			<div className="flex items-center gap-1 ml-auto shrink-0">
				<Tooltip content={isAgentPanelOpen ? "Hide agent panel" : "Show agent panel"} side="bottom" asChild>
					<Button variant={isAgentPanelOpen ? "secondary" : "ghost"} shape="square" icon={<RobotIcon size={20} />} onClick={toggleAgentPanel} aria-label="Toggle agent panel" className="hidden lg:inline-flex" />
				</Tooltip>
				<Tooltip content="Settings" side="bottom" asChild>
					<Button variant={isSettingsActive ? "secondary" : "ghost"} shape="square" icon={<GearSixIcon size={20} />} onClick={() => navigate(isSettingsActive ? `/mailbox/${mailboxId}/emails/inbox` : `/mailbox/${mailboxId}/settings`)} aria-label="Settings" />
				</Tooltip>
				<Tooltip content="Sign out" side="bottom" asChild>
					<Button variant="ghost" shape="square" icon={<SignOutIcon size={20} />} onClick={() => void handleLogout()} aria-label="Sign out" />
				</Tooltip>
			</div>
		</header>
	);
}
