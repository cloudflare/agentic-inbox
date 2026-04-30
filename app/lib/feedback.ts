// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { useKumoToastManager } from "@cloudflare/kumo";

/**
 * Thin wrapper over kumo's toast manager so call sites don't need to
 * remember the {variant: "error"} shape. The hook is the only API — use
 * the returned object's methods inside event handlers / effects.
 */
export function useFeedback() {
  const toasts = useKumoToastManager();
  return {
    error: (title: string) => toasts.add({ title, variant: "error" }),
    success: (title: string) => toasts.add({ title }),
    info: (title: string) => toasts.add({ title }),
  };
}
