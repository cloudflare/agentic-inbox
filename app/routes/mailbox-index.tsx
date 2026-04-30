// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Navigate } from "react-router";

// SOC framing: the dashboard is the default landing for a selected mailbox.
// Inbox is still reachable via the topbar mailbox section.
export default function MailboxIndexRoute() {
  return <Navigate to="dashboard" replace />;
}
