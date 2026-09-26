# Modal try-on QA

This path is an opt-in test provider for the authenticated `render-tryon` queue. The `qa-modal` EAS profile adds a public request selector; it contains no Modal credential. The Edge Function rejects the request unless Modal QA is enabled on that backend and the signed-in user ID is allowlisted. All other builds keep the existing provider chain.

## Before enabling

- Revoke the Modal token previously pasted into chat; treat it as compromised and do not reuse it.
- Use a separate non-production Supabase project and approved QA account IDs.
- Apply the database migration before deploying the Edge Function. It enforces one reservation per user per UTC day and three total per UTC day; those limits are not configurable from the client.
- Confirm the current A100 per-second rate in Modal before setting `QA_MODAL_A100_USD_PER_SECOND`.
- Store `QA_MODAL_ENABLED=true`, `QA_MODAL_ENVIRONMENT=qa`, `QA_MODAL_USER_IDS`, `MODAL_QA_ENDPOINT`, `MODAL_PROXY_TOKEN_ID`, `MODAL_PROXY_TOKEN_SECRET`, and the confirmed rate as Supabase Edge Function secrets only. Never put proxy credentials in Expo variables, source files, logs, or chat.
- Obtain explicit approval before caching model weights or deploying the Modal app. `modal run scripts/qwen_modal.py` downloads weights to a persistent CPU volume; it does not run inference, but uses network, CPU, and storage. `modal deploy scripts/qwen_modal.py` exposes only the proxy-authenticated `/generate` route.

## Limits and data handling

- Only standard `tryon` requests with one or two garments and the default pose can select Modal. Restyle, compare, Max tier, pose transfer, and unapproved users are rejected before quota is spent.
- An unclaimed queued request expires at UTC midnight. It is closed without GPU dispatch and must be submitted again; the database claim also checks the current UTC day to prevent delayed queue events from spending outside their reserved day.
- Render rows are server-write-only so clients cannot alter provider selection, allowance pools, or GPU-rate metadata. A durable claim is separate from the dispatch marker; retries can safely recover a claim that never reached Modal.
- The worker has no minimum containers, one A100 container maximum, 24 CFG-free inference steps, a 90-second function timeout, and a QA-window warm scale-down. Inputs are size- and dimension-checked before model loading; failed dispatches are not retried automatically.
- Images travel from private Supabase storage to the server-side Edge Function and then to the private Modal endpoint. Output is written to the private Supabase `renders` bucket. The persistent Modal volume stores model weights, not request images.
- GPU cost in the render ledger is an estimate from the configured rate and worker-reported runtime, rounded up to cents with a 31-second cold-start/scale-down reserve. It is not Modal's invoice. Unknown post-dispatch failures are estimated at the worker's maximum runtime.

## QA procedure and shutdown

1. Confirm the QA migration and Edge Function are deployed only to the non-production project, and the allowlist contains only the test account.
2. After approval, warm the CPU model cache and deploy the private Modal app. Configure the exact Modal endpoint and proxy credentials as server secrets.
3. Build with `eas build --profile qa-modal`; sign in with the allowlisted account and submit one approved sample through the app.
4. Check the render status, private output path, worker logs, and estimated cost. No live inference is run by repository checks.
5. Disable QA with `QA_MODAL_ENABLED=false` or remove the Modal secrets. Confirm the GPU worker has scaled to zero. Remove the model-cache volume only if it is no longer needed and after approval.
