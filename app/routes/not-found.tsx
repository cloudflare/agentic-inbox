// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { useNavigate } from "react-router";

export default function NotFoundRoute() {
	const navigate = useNavigate();

	return (
		<div className="flex min-h-screen items-center justify-center bg-kumo-recessed p-6">
			<div className="flex max-w-sm flex-col items-center gap-2 text-center">
				<WarningIcon
					size={40}
					weight="light"
					className="mb-2 text-kumo-inactive"
				/>
				<h1 className="text-[15px] font-medium text-kumo-default">
					404 -- Page Not Found
				</h1>
				<p className="text-sm text-kumo-subtle">
					The page you're looking for doesn't exist.
				</p>
				<Button variant="primary" className="mt-4" onClick={() => navigate("/")}>
					Go Home
				</Button>
			</div>
		</div>
	);
}
