// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useState } from "react";

// SSR-safe `matchMedia` subscription. Returns `false` until mount so server
// renders never assume desktop layout — a brief slide-over flash on hydration
// at desktop sizes is preferable to dropping `role=dialog` semantics on a
// truly narrow viewport.
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(false);

	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const mq = window.matchMedia(query);
		setMatches(mq.matches);
		const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
		mq.addEventListener("change", listener);
		return () => mq.removeEventListener("change", listener);
	}, [query]);

	return matches;
}
