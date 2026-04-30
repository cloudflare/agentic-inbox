// Loaded by vitest (`setupFiles`) for the frontend project. Adds jest-dom's
// custom matchers (`toBeInTheDocument`, `toHaveTextContent`, …) and runs RTL's
// cleanup after each test so portals (toasts, tooltips) don't leak between tests.

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
	cleanup();
});
