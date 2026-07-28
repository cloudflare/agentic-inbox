// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Empty,
	LinkProvider,
	Loader,
	Toasty,
	TooltipProvider,
} from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { forwardRef, useState } from "react";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Link as RouterLink,
	Scripts,
	ScrollRestoration,
} from "react-router";
import { useBrand } from "~/hooks/useBrand";
import { ServiceWorkerRegistrar } from "~/components/pwa/ServiceWorkerRegistrar";
import SendOutcomeWatcher from "~/components/SendOutcomeWatcher";
import { createMailQueryClient } from "~/lib/mail-query-client";
import { resolveBrand } from "../workers/routes/brand";
import {
	isQuizEnabled,
	isSemanticSearchEnabled,
} from "../workers/lib/features";
import type { Route } from "./+types/root";
import "./index.css";

// BRAND selects the active brand (WISER-238). Resolved server-side so the
// <html data-brand> below is set before first paint — no flash of the wrong
// palette. Mirrors the static data-mode="light". resolveBrand fails safe to
// whispyr for an unset/unknown value. quizEnabled is SSR'd the same way so the
// Header's Quizzes button never flashes on before a brand that omits it (WISER-239).
export async function loader({ context }: Route.LoaderArgs) {
	const env = context.cloudflare.env;
	const b = resolveBrand(env.BRAND);
	return {
		brand: b.id,
		name: b.name,
		appName: b.appName,
		favicon: b.favicon,
		appleTouchIcon: b.appleTouchIcon,
		legacyFavicon: b.legacyFavicon,
		legacyFaviconType: b.legacyFaviconType,
		legacyFaviconSizes: b.legacyFaviconSizes,
		quizEnabled: isQuizEnabled(env.FEATURES, b.id),
		semanticSearchEnabled: isSemanticSearchEnabled(env.FEATURES, b.id),
		themeColor: b.themeColor,
	};
}

// Lazy singleton for the browser — avoids module-scope instantiation that
// leaks cache across SSR requests.
let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
	if (typeof window === "undefined") {
		// SSR: always create a fresh client per request to prevent cross-user cache leaks
		return createMailQueryClient();
	}
	// Browser: reuse the same client across navigations
	if (!browserQueryClient) browserQueryClient = createMailQueryClient();
	return browserQueryClient;
}

const KumoLink = forwardRef<
	HTMLAnchorElement,
	React.AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }
>(function KumoLink({ href, ...props }, ref) {
	if (href && !href.startsWith("http")) {
		return (
			<RouterLink to={href} ref={ref} {...(props as Record<string, unknown>)} />
		);
	}
	return <a href={href} ref={ref} {...props} />;
});

export function Layout({ children }: { children: React.ReactNode }) {
	const {
		brand,
		appName,
		favicon,
		appleTouchIcon,
		legacyFavicon,
		legacyFaviconType,
		legacyFaviconSizes,
		themeColor,
	} = useBrand();
	return (
		<html lang="en" data-mode="light" data-theme="kumo" data-brand={brand}>
			<head>
				<meta charSet="UTF-8" />
				{/* PWA: installable + home-screen behaviour (WISER-240). */}
				<link rel="manifest" href="/manifest.webmanifest" />
				<meta name="theme-color" content={themeColor} />
				{/* No legacy apple-mobile-web-app-capable tag: it routes the install
				    down iOS's pre-manifest web-clip path, whose push identity is
				    empty — webpushd then reports permission "denied" without ever
				    prompting. The manifest's display:standalone covers iOS 16.4+. */}
				<meta name="mobile-web-app-capable" content="yes" />
				<meta name="apple-mobile-web-app-status-bar-style" content="default" />
				<meta name="apple-mobile-web-app-title" content={appName} />
				<link rel="apple-touch-icon" href={appleTouchIcon} />
				<link
					rel="icon"
					type="image/svg+xml"
					href={favicon}
				/>
				<link
					rel="icon"
					type={legacyFaviconType}
					href={legacyFavicon}
					sizes={legacyFaviconSizes}
				/>
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>{appName}</title>
				<Meta />
				<Links />
			</head>
			<body className="bg-kumo-recessed text-kumo-default antialiased">
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export function HydrateFallback() {
	return (
		<div className="flex items-center justify-center h-screen">
			<Loader size="lg" />
		</div>
	);
}

export default function App() {
	// Use useState to ensure each SSR request gets a fresh client while the
	// browser reuses the same singleton across navigations.
	const [queryClient] = useState(getQueryClient);
	return (
		<QueryClientProvider client={queryClient}>
			<LinkProvider component={KumoLink}>
				<TooltipProvider>
					<Toasty>
						<ServiceWorkerRegistrar />
						{/* Above the Outlet so no in-app navigation can unmount a send
						    watch: it needs only the toast manager, the query client and
						    the store, all of which live here. */}
						<SendOutcomeWatcher />
						<Outlet />
					</Toasty>
				</TooltipProvider>
			</LinkProvider>
		</QueryClientProvider>
	);
}

export function ErrorBoundary({ error }: { error: unknown }) {
	let title = "Something went wrong";
	let description = "An unexpected error occurred. Please try again.";
	let status: number | null = null;

	if (isRouteErrorResponse(error)) {
		status = error.status;
		if (error.status === 404) {
			title = "Page not found";
			description =
				"The page you’re looking for doesn’t exist or has been moved.";
		} else {
			title = `Error ${error.status}`;
			description = error.statusText || description;
		}
	} else if (error instanceof Error && import.meta.env.DEV) {
		description = error.message;
	}

	return (
		<div className="flex items-center justify-center min-h-screen p-8">
			<Empty
				icon={<WarningIcon size={48} className="text-kumo-inactive" />}
				title={status === 404 ? "404 — Page not found" : title}
				description={description}
				contents={
					<Button
						variant="primary"
						onClick={() => {
							window.location.href = "/";
						}}
					>
						Go Home
					</Button>
				}
			/>
		</div>
	);
}
