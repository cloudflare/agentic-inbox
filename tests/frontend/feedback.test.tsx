// Smoke test for the frontend test harness — exercises the hook → kumo
// integration without rendering any real route. If this fails, the harness
// (jsdom + RTL + tsconfig paths) is broken; if it passes, the wiring is sound.

import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const add = vi.fn();
vi.mock("@cloudflare/kumo", () => ({
	useKumoToastManager: () => ({ add }),
}));

import { useFeedback } from "~/lib/feedback";

describe("useFeedback", () => {
	beforeEach(() => {
		add.mockClear();
	});

	it("forwards error() with variant: 'error'", () => {
		const { result } = renderHook(() => useFeedback());
		act(() => result.current.error("nope"));
		expect(add).toHaveBeenCalledWith({ title: "nope", variant: "error" });
	});

	it("forwards success() and info() without a variant", () => {
		const { result } = renderHook(() => useFeedback());
		act(() => result.current.success("yay"));
		act(() => result.current.info("fyi"));
		expect(add).toHaveBeenNthCalledWith(1, { title: "yay" });
		expect(add).toHaveBeenNthCalledWith(2, { title: "fyi" });
	});
});
