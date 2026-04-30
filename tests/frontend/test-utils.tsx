// Render helper that wraps a component in the provider stack the app uses
// at runtime: kumo (LinkProvider/TooltipProvider/Toasty), react-query, and
// react-router. Returns a fresh QueryClient per render so caches don't bleed.

import { LinkProvider, Toasty, TooltipProvider } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { forwardRef, type AnchorHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { MemoryRouter, Link as RouterLink } from "react-router";

// Mirror `KumoLink` from `app/root.tsx`: kumo's LinkProvider passes an `href`,
// react-router's Link expects `to`. Without this adapter the LinkProvider type
// disagrees with RouterLink and downstream tests fail to typecheck.
const KumoLink = forwardRef<
	HTMLAnchorElement,
	AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }
>(function KumoLink({ href, ...props }, ref) {
	if (href && !href.startsWith("http")) {
		return <RouterLink to={href} ref={ref} {...(props as Record<string, unknown>)} />;
	}
	return <a href={href} ref={ref} {...props} />;
});

function makeTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity },
			mutations: { retry: false },
		},
	});
}

interface ProvidersProps {
	children: ReactNode;
	queryClient: QueryClient;
	initialEntries?: string[];
}

function Providers({ children, queryClient, initialEntries = ["/"] }: ProvidersProps) {
	return (
		<QueryClientProvider client={queryClient}>
			<LinkProvider component={KumoLink}>
				<TooltipProvider>
					<Toasty>
						<MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
					</Toasty>
				</TooltipProvider>
			</LinkProvider>
		</QueryClientProvider>
	);
}

export interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
	queryClient?: QueryClient;
	initialEntries?: string[];
}

export function renderWithProviders(
	ui: ReactElement,
	options: RenderWithProvidersOptions = {},
): RenderResult & { queryClient: QueryClient } {
	const { queryClient = makeTestQueryClient(), initialEntries, ...rest } = options;
	const result = render(ui, {
		wrapper: ({ children }) => (
			<Providers queryClient={queryClient} initialEntries={initialEntries}>
				{children}
			</Providers>
		),
		...rest,
	});
	return { ...result, queryClient };
}
