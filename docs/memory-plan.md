# Evidence-Backed Memory Plan

## Goal

Make memory useful during email drafting without turning it into an opaque or
unsafe second inbox. Sources remain authoritative, retrieval is inspectable,
and internal citations never enter outgoing email content.

## Implemented

- Mailbox-scoped source provenance, draft eligibility, Markdown chunks, and
  reviewable memory facts.
- Keyword retrieval with optional Cloudflare AI Search semantic retrieval and
  deterministic keyword fallback.
- A shared `DraftContextPack` used by the agent and composer source panel.
- Google Drive service-account and Microsoft OneDrive app-only imports for explicitly selected files.
- Background suggested-fact extraction with source-chunk provenance.
- Memory explorer source metadata, preview links, and draft inclusion controls.

## Safety Rules

- Only confirmed facts are included in drafting context.
- Imported files and email content remain untrusted prompt inputs.
- Source excerpts and citations are operator-facing only.
- Every source is mailbox-scoped and deletable.

## Next Iteration

- Add a dedicated fact-review panel for confirming, rejecting, and correcting
  extracted facts.
- Add Drive folder listing/picker and optional scheduled refresh.
- Add focused unit/API tests for chunk offsets, duplicate imports, context
  packing, and citation exclusion.
