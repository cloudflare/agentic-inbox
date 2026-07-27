// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, DropdownMenu, Input, Tooltip } from "@cloudflare/kumo";
import { CommandIcon, DotsThreeIcon, ExamIcon, GearSixIcon, ListIcon, MagnifyingGlassIcon, PaperPlaneTiltIcon, RobotIcon, ShieldCheckIcon, SignOutIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useCurrentActor } from "~/queries/push";
import { useUIStore } from "~/hooks/useUIStore";
import { useBrand } from "~/hooks/useBrand";
import { MAIL_FOCUS_SEARCH_EVENT } from "~/components/MailKeyboardController";
import { MAIL_COMMAND_PALETTE_OPEN_EVENT } from "~/components/MailCommandPalette";
import WorkspaceViewControl from "~/components/WorkspaceViewControl";

export default function Header() {
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearchExpanded, setIsSearchExpanded] = useState(false);
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const { toggleSidebar, toggleAgentPanel, isAgentPanelOpen } = useUIStore();
	const { quizEnabled } = useBrand();
	// Identity drives the admin link and the account shown on sign-out
	// (see /api/v1/me). Shared query, so a failure retries on refocus instead
	// of silently pretending nobody is signed in.
	const { data: me, isError: identityUnavailable } = useCurrentActor();
	const signOutLabel = me
		? `Sign out (${me.email})`
		: identityUnavailable
			? "Sign out (account details unavailable)"
			: "Sign out";

	useEffect(() => {
		const focusSearch = () => {
			setIsSearchExpanded(true);
			requestAnimationFrame(() => {
				const input = document.querySelector<HTMLInputElement>(
					'input[aria-label="Search emails"]',
				);
				input?.focus();
			});
		};
		window.addEventListener(MAIL_FOCUS_SEARCH_EVENT, focusSearch);
		return () =>
			window.removeEventListener(MAIL_FOCUS_SEARCH_EVENT, focusSearch);
	}, []);

	// /logout is a POST endpoint; submit a throwaway form to hit it.
	const signOut = () => {
		const form = document.createElement("form");
		form.method = "POST";
		form.action = "/logout";
		document.body.appendChild(form);
		form.submit();
	};

	// Sync search input with URL query param so it stays populated
	const urlQuery = searchParams.get("q") || "";
	const navigationDraft =
		typeof (location.state as { aiSearchDraft?: unknown } | null)?.aiSearchDraft === "string"
			? (location.state as { aiSearchDraft: string }).aiSearchDraft
			: "";
	useEffect(() => {
		setSearchQuery(
			location.pathname.includes("/search") ? urlQuery || navigationDraft : "",
		);
	}, [mailboxId, urlQuery, navigationDraft, location.pathname]);

	const performSearch = () => {
		if (mailboxId && searchQuery.trim()) {
			const q = searchQuery.trim();
			navigate(`/mailbox/${mailboxId}/search?q=${encodeURIComponent(q)}`);
			setIsSearchExpanded(false);
		}
	};

	const openAiSearch = () => {
		if (!mailboxId) return;
		navigate(`/mailbox/${mailboxId}/search`, {
			state: { aiSearchDraft: searchQuery.trim() },
		});
		setIsSearchExpanded(false);
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
		<header className="flex items-center gap-2 px-3 py-2.5 bg-kumo-base border-b border-kumo-line sticky top-0 z-10 md:px-5 md:gap-4">
			{/* Hamburger menu - mobile only */}
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={<ListIcon size={20} />}
				onClick={toggleSidebar}
				aria-label="Toggle sidebar"
				className={`${isSearchExpanded ? "hidden" : "shrink-0"} md:hidden`}
			/>

			{/* Search - full on desktop, collapsible on mobile */}
			<div
				className={`flex-1 max-w-2xl transition-all flex items-center gap-1 ${
					isSearchExpanded ? "flex" : "hidden md:flex"
				}`}
			>
				<div className="flex-1 relative flex items-center">
					<Input
						className="w-full"
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
							className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint transition-colors"
							aria-label="Clear search"
						>
							<XIcon size={14} />
						</button>
					)}
				</div>
				<Tooltip content="Search" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						icon={<MagnifyingGlassIcon size={20} />}
						onClick={performSearch}
						aria-label="Search"
					/>
				</Tooltip>
				<Tooltip content="Translate an ordinary-language request into mail filters" side="bottom" asChild>
					<Button
						variant="secondary"
						size="sm"
						icon={<SparkleIcon size={18} />}
						onClick={openAiSearch}
						aria-label="AI search"
						className="min-h-11 shrink-0 px-2"
					>
						<span className="hidden xl:inline">AI search</span>
					</Button>
				</Tooltip>
			</div>

			{/* Search toggle button - mobile only, hidden when search is expanded */}
			{!isSearchExpanded && (
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<MagnifyingGlassIcon size={20} />}
					onClick={() => setIsSearchExpanded(true)}
					aria-label="Search"
					className="md:hidden shrink-0"
				/>
			)}

			<Tooltip content="Commands (⌘K)" side="bottom" asChild>
				<Button
					variant="ghost"
					size="sm"
					icon={<CommandIcon size={20} />}
					onClick={() => window.dispatchEvent(new Event(MAIL_COMMAND_PALETTE_OPEN_EVENT))}
					aria-label="Open command palette"
					className="hidden min-h-11 shrink-0 px-2 xl:inline-flex"
				>
					<span className="hidden lg:inline">Commands</span>
				</Button>
			</Tooltip>
			<div className={`shrink-0 ${isSearchExpanded ? "hidden md:block" : ""}`}>
				<WorkspaceViewControl />
			</div>

			<div className="ml-auto hidden shrink-0 items-center gap-1 xl:flex">
				<Tooltip content={isAgentPanelOpen ? "Hide agent panel" : "Show agent panel"} side="bottom" asChild>
					<Button
						variant={isAgentPanelOpen ? "secondary" : "ghost"}
						shape="square"
						icon={<RobotIcon size={20} />}
						onClick={toggleAgentPanel}
						aria-label="Toggle agent panel"
						className="shrink-0"
					/>
				</Tooltip>
				<Tooltip content="Settings" side="bottom" asChild>
					<Button
						variant={isSettingsActive ? "secondary" : "ghost"}
						shape="square"
						icon={<GearSixIcon size={20} />}
						onClick={() =>
							navigate(
								isSettingsActive
									? `/mailbox/${mailboxId}/emails/inbox`
									: `/mailbox/${mailboxId}/settings`,
							)
						}
						aria-label="Settings"
					/>
				</Tooltip>
				{/* Quizzes is a Whispyr-only module — hidden where FEATURES omits it, e.g.
				    Wiser (WISER-239). quizEnabled is SSR'd via the root loader so the
				    button never flashes on. The routes also 404 server-side. */}
				{quizEnabled && (
					<Tooltip content="Quizzes" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							icon={<ExamIcon size={20} />}
							onClick={() => {
								// Worker-rendered pages (outside the SPA) — full-page nav. Admins land on
								// the management console; everyone else on their quiz list.
								window.location.href = me?.role === "ADMIN" ? "/admin/quizzes" : "/quizzes";
							}}
							aria-label="Quizzes"
						/>
					</Tooltip>
				)}
				<Tooltip content="Bulk send" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						icon={<PaperPlaneTiltIcon size={20} />}
						onClick={() => {
							window.location.href = "/bulk";
						}}
						aria-label="Bulk send"
					/>
				</Tooltip>
				{me?.role === "ADMIN" && (
					<Tooltip content="Admin" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							icon={<ShieldCheckIcon size={20} />}
							onClick={() => {
								window.location.href = "/admin/users";
							}}
							aria-label="Admin"
						/>
					</Tooltip>
				)}
				<Tooltip content={signOutLabel} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						icon={<SignOutIcon size={20} />}
						onClick={signOut}
						aria-label="Sign out"
					/>
				</Tooltip>
			</div>

			<div className={`${isSearchExpanded ? "hidden md:block" : "ml-auto shrink-0"} xl:hidden`}>
				<DropdownMenu>
					<DropdownMenu.Trigger
						render={
							<Button
								variant="ghost"
								shape="square"
								className="min-h-11 min-w-11"
								icon={<DotsThreeIcon size={20} weight="bold" />}
								aria-label="More mail actions"
							/>
						}
					/>
					<DropdownMenu.Content align="end">
						<DropdownMenu.Label>Mail actions</DropdownMenu.Label>
						<DropdownMenu.Item
							icon={RobotIcon}
							className="min-h-11"
							onSelect={toggleAgentPanel}
						>
							{isAgentPanelOpen ? "Hide agent panel" : "Show agent panel"}
						</DropdownMenu.Item>
						<DropdownMenu.Item
							icon={GearSixIcon}
							className="min-h-11"
							onSelect={() =>
								navigate(
									isSettingsActive
										? `/mailbox/${mailboxId}/emails/inbox`
										: `/mailbox/${mailboxId}/settings`,
								)
							}
						>
							{isSettingsActive ? "Back to inbox" : "Settings"}
						</DropdownMenu.Item>
						{quizEnabled && (
							<DropdownMenu.Item
								icon={ExamIcon}
								className="min-h-11"
								onSelect={() => {
									window.location.href = me?.role === "ADMIN" ? "/admin/quizzes" : "/quizzes";
								}}
							>
								Quizzes
							</DropdownMenu.Item>
						)}
						<DropdownMenu.Item
							icon={PaperPlaneTiltIcon}
							className="min-h-11"
							onSelect={() => {
								window.location.href = "/bulk";
							}}
						>
							Bulk send
						</DropdownMenu.Item>
						{me?.role === "ADMIN" && (
							<DropdownMenu.Item
								icon={ShieldCheckIcon}
								className="min-h-11"
								onSelect={() => {
									window.location.href = "/admin/users";
								}}
							>
								Admin
							</DropdownMenu.Item>
						)}
						<DropdownMenu.Separator />
						<DropdownMenu.Item
							icon={SignOutIcon}
							className="min-h-11"
							onSelect={signOut}
						>
							Sign out
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu>
			</div>
		</header>
	);
}
