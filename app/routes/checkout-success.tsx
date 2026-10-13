// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader } from "@cloudflare/kumo";
import {
	CheckCircleIcon,
	GlobeIcon,
	ShieldCheckIcon,
	SparkleIcon,
	EnvelopeIcon,
	HardDrivesIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import api from "~/services/api";

export function meta() {
	return [{ title: "Domain Activated — Inboxies" }];
}

export default function CheckoutSuccessRoute() {
	const [searchParams] = useSearchParams();
	const domain = searchParams.get("domain") || "your domain";
	const sessionId = searchParams.get("session_id") || "";

	const { data: statusData, isLoading } = useQuery({
		queryKey: ["checkout-status", sessionId, domain],
		queryFn: () => api.getCheckoutStatus({ sessionId, domain }),
		refetchInterval: (query) => (query.state.data?.status === "ready" ? false : 1500),
		staleTime: 1000,
	});

	// checkout-return never signs anyone in, so anonymous buyers sign in with
	// the password they chose at checkout.
	const { data: me } = useQuery({
		queryKey: ["me"],
		queryFn: () => api.getMe(),
		retry: false,
	});
	const isSignedIn = Boolean(me);

	const isReady = statusData?.status === "ready";
	const pricing = statusData?.pricing;
	const domainFee = pricing?.domainFeeUsd ?? 10.44;
	const platformFee = pricing?.platformFeeUsd ?? 9.56;
	const total = pricing?.totalAnnualUsd ?? 20.0;

	return (
		<div className="min-h-screen bg-kumo-recessed flex items-center justify-center p-4">
			<div className="w-full max-w-lg bg-kumo-base rounded-2xl border border-kumo-line shadow-sm overflow-hidden p-6 sm:p-8 space-y-6">
				{/* Header */}
				<div className="flex items-center gap-3 border-b border-kumo-line pb-5">
					<div className="p-2.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
						<CheckCircleIcon size={28} weight="fill" />
					</div>
					<div>
						<h1 className="text-lg font-bold text-kumo-default">
							Subscription & Domain Activated
						</h1>
						<p className="text-xs text-kumo-subtle font-mono mt-0.5">
							{domain}
						</p>
					</div>
				</div>

				{/* Order Summary & Transparent Fee Breakdown */}
				<div className="rounded-xl bg-kumo-recessed border border-kumo-line p-4 space-y-3">
					<div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
						<span>Annual Subscription Breakdown</span>
						<span className="text-emerald-600 dark:text-emerald-400 font-medium lowercase">
							Billed annually
						</span>
					</div>

					<div className="space-y-2 pt-1 border-t border-kumo-line/60 text-sm">
						<div className="flex justify-between items-center text-kumo-default">
							<span className="flex items-center gap-1.5">
								<GlobeIcon size={15} className="text-kumo-subtle" />
								Domain Registration (1 Year)
							</span>
							<span className="font-mono text-xs font-medium">
								${domainFee.toFixed(2)} USD
							</span>
						</div>

						<div className="flex justify-between items-center text-kumo-default">
							<span className="flex items-center gap-1.5">
								<SparkleIcon size={15} className="text-sky-600 dark:text-sky-400" />
								Platform, AI & Cloud Infrastructure
							</span>
							<span className="font-mono text-xs font-medium">
								${platformFee.toFixed(2)} USD
							</span>
						</div>

						<div className="flex justify-between items-center pt-2 border-t border-kumo-line font-bold text-kumo-default">
							<span>Total Annual Cost</span>
							<span className="font-mono text-emerald-600 dark:text-emerald-400">
								${total.toFixed(2)} USD / yr
							</span>
						</div>
					</div>
				</div>

				{/* Included Features */}
				<div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 space-y-2.5 text-xs text-kumo-default">
					<div className="font-semibold text-sky-800 dark:text-sky-300 flex items-center gap-1.5">
						<ShieldCheckIcon size={16} />
						What is included with your subscription:
					</div>
					<ul className="space-y-1.5 text-kumo-subtle pl-1">
						<li className="flex items-center gap-2">
							<SparkleIcon size={14} className="shrink-0 text-sky-600 dark:text-sky-400" />
							<span>Dedicated AI Email Agent (summaries, triage & smart drafting)</span>
						</li>
						<li className="flex items-center gap-2">
							<HardDrivesIcon size={14} className="shrink-0 text-sky-600 dark:text-sky-400" />
							<span>Edge Server Realtime Sync & R2 encrypted storage</span>
						</li>
						<li className="flex items-center gap-2">
							<GlobeIcon size={14} className="shrink-0 text-sky-600 dark:text-sky-400" />
							<span>Global Anycast DNS, SSL certificates & Email Routing</span>
						</li>
						<li className="flex items-center gap-2">
							<EnvelopeIcon size={14} className="shrink-0 text-sky-600 dark:text-sky-400" />
							<span>Automated MX, SPF, DKIM & DMARC spam defense</span>
						</li>
					</ul>
				</div>

				{/* Provisioning Status */}
				<div className="flex items-center gap-2.5 p-3 rounded-lg border border-kumo-line bg-kumo-base text-xs">
					{isReady ? (
						<>
							<CheckCircleIcon size={18} weight="fill" className="text-emerald-500 shrink-0" />
							<span className="text-kumo-default font-medium">
								DNS, Anycast routing, and primary mailbox are active and ready.
							</span>
						</>
					) : (
						<>
							<Loader size="xs" />
							<span className="text-kumo-subtle font-medium">
								Finalizing Anycast DNS records and mailbox staging...
							</span>
						</>
					)}
				</div>

				{/* Action Buttons */}
				<div className="flex flex-col sm:flex-row gap-3 pt-2">
					<Link to={isSignedIn ? "/" : "/login"} className="flex-1">
						<Button variant="primary" className="w-full justify-center">
							{isSignedIn ? "Open Mailbox" : "Sign in to your mailbox"}
						</Button>
					</Link>
					<Link
						to={`/admin?tab=dns&domain=${encodeURIComponent(domain)}&purchased=true`}
						className="flex-1"
					>
						<Button variant="secondary" className="w-full justify-center">
							Manage Domain DNS
						</Button>
					</Link>
				</div>
			</div>
		</div>
	);
}
