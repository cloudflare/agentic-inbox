// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: {
    v8_viteEnvironmentApi: true,
    // Pre-scan route modules so Vite doesn't re-optimize React mid-load
    // (that reload causes "Cannot read properties of null (reading 'useContext')").
    unstable_optimizeDeps: true,
  },
} satisfies Config;
