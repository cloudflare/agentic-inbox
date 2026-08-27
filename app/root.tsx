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
import { MutationCache, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
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
import { getCurrentUser } from "~/services/auth";
import "./index.css";

function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => {
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
					return failureCount < 2;
				},
			},
		},
		mutationCache: new MutationCache({ onError: (error) => console.error("Mutation failed:", error) }),
	});
}

let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
	if (typeof window === "undefined") return makeQueryClient();
	if (!browserQueryClient) browserQueryClient = makeQueryClient();
	return browserQueryClient;
}

const KumoLink = forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }>(function KumoLink({ href, ...props }, ref) {
	if (href && !href.startsWith("http")) return <RouterLink to={href} ref={ref} {...(props as Record<string, unknown>)} />;
	return <a href={href} ref={ref} {...props} />;
});

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<meta charSet="UTF-8" />
				<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
				<link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="48x48 32x32 16x16" />
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
	return <div className="flex items-center justify-center h-screen"><Loader size="lg" /></div>;
}

function AuthGate() {
	const location = useLocation();
	const publicRoute = location.pathname === "/login" || location.pathname === "/register";
	const { data: user, isLoading } = useQuery({
		queryKey: ["auth", "me"],
		queryFn: getCurrentUser,
		enabled: !publicRoute,
		staleTime: 60_000,
		retry: false,
	});

	if (publicRoute) return <Outlet />;
	if (isLoading) return <div className="flex items-center justify-center h-screen"><Loader size="lg" /></div>;
	if (!user) {
		if (typeof window !== "undefined") window.location.replace("/login");
		return <div className="flex items-center justify-center h-screen"><Loader size="lg" /></div>;
	}
	return <Outlet />;
}

export default function App() {
	const [queryClient] = useState(getQueryClient);
	return (
		<QueryClientProvider client={queryClient}>
			<LinkProvider component={KumoLink}>
				<TooltipProvider><Toasty><AuthGate /></Toasty></TooltipProvider>
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
		if (error.status === 404) { title = "Page not found"; description = "The page you're looking for doesn't exist or has been moved."; }
		else description = error.statusText || description;
	} else if (error instanceof Error && import.meta.env.DEV) description = error.message;
	return (
		<div className="flex items-center justify-center min-h-screen p-8">
			<Empty icon={<WarningIcon size={48} className="text-kumo-inactive" />} title={status === 404 ? "404 — Page not found" : title} description={description}
				contents={<Button variant="primary" onClick={() => { window.location.href = "/"; }}>Go Home</Button>} />
		</div>
	);
}
