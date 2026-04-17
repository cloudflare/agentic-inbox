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
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { forwardRef, useState } from "react";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Link as RouterLink,
	Scripts,
	ScrollRestoration,
	useLocation,
} from "react-router";
import { ApiError } from "~/services/api";
import { useSetupStatus } from "~/queries/setup";
import "./index.css";

function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => {
					// Don't retry 4xx errors (not found, unauthorized, etc.)
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						return false;
					}
					return failureCount < 2;
				},
			},
		},
		mutationCache: new MutationCache({
			onError: (error) => {
				// Global fallback for mutations that don't handle errors themselves.
				// Consumers using mutateAsync + try/catch handle their own errors.
				console.error("Mutation failed:", error);
			},
		}),
	});
}

// Lazy singleton for the browser — avoids module-scope instantiation that
// leaks cache across SSR requests.
let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
	if (typeof window === "undefined") {
		// SSR: always create a fresh client per request to prevent cross-user cache leaks
		return makeQueryClient();
	}
	// Browser: reuse the same client across navigations
	if (!browserQueryClient) browserQueryClient = makeQueryClient();
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
	return (
		<html lang="en">
			<head>
				<meta charSet="UTF-8" />
				<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
				<link
					rel="icon"
					type="image/x-icon"
					href="/favicon.ico"
					sizes="48x48 32x32 16x16"
				/>
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Agentic Inbox</title>
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

function SetupBanner() {
	const location = useLocation();
	const { data } = useSetupStatus();

	if (!data || data.isComplete || location.pathname === "/setup") return null;

	const requiredIncomplete = data.steps.filter((s) => s.required && s.status !== "complete" && s.status !== "info");
	if (requiredIncomplete.length === 0) return null;

	return (
		<div className="bg-kumo-warning/10 border-b border-kumo-warning/20 px-4 py-2.5">
			<div className="mx-auto max-w-7xl flex items-center gap-2">
				<WarningIcon size={16} weight="fill" className="text-kumo-warning shrink-0" />
				<span className="text-sm text-kumo-default">
					Setup incomplete — {requiredIncomplete.length} required step{requiredIncomplete.length > 1 ? "s" : ""} remaining
				</span>
				<RouterLink to="/setup" className="text-sm font-medium text-kumo-default underline underline-offset-2 hover:text-kumo-subtle ml-1">
					Finish setup
				</RouterLink>
			</div>
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
						<SetupBanner />
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
	let isSetupError = false;

	if (isRouteErrorResponse(error)) {
		status = error.status;
		if (error.status === 404) {
			title = "Page not found";
			description =
				"The page you're looking for doesn't exist or has been moved.";
		} else {
			title = `Error ${error.status}`;
			description = error.statusText || description;
		}
	} else if (error instanceof ApiError) {
		status = error.status;
		title = `Error ${error.status}`;
		description = error.message;
		if (error.body?.code === "ACCESS_NOT_CONFIGURED" || error.body?.code === "ACCESS_TOKEN_MISSING" || error.body?.code === "ACCESS_TOKEN_INVALID") {
			isSetupError = true;
			title = "Configuration required";
			description = error.body.error as string || "Cloudflare Access is not configured.";
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
					<div className="flex items-center gap-2">
						{isSetupError && (
							<RouterLink to="/setup">
								<Button variant="primary">
									Go to Setup
								</Button>
							</RouterLink>
						)}
						<Button
							variant={isSetupError ? "secondary" : "primary"}
							onClick={() => {
								window.location.href = "/";
							}}
						>
							Go Home
						</Button>
					</div>
				}
			/>
		</div>
	);
}
