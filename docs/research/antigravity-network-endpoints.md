# Antigravity CLI (`agy` 1.1.13) — Network Hostname/Endpoint Inventory

Research executor report. Scope: all network hostnames/domains the locally installed
Antigravity CLI `agy` 1.1.13 (`/home/tiezbro/.local/bin/agy`) may access for
authentication, model discovery, inference, updates/downloads, telemetry, and
auxiliary web/tool features. First-party evidence only. No credentials, tokens,
cookies, or client secrets are reproduced in this file.

## Evidence sources & commands

| # | Source | Evidence | Commands used |
|---|--------|----------|----------------|
| E1 | Local binary (stripped ELF x86-64, 196.6 MB, Go build) | URL/hostname constants, env-var names, gRPC service names, error strings | `file ~/.local/bin/agy`; `strings -n 8 ~/.local/bin/agy` filtered for URL, host, and env patterns |
| E2 | Runtime CLI log (living state dir `~/.gemini/antigravity-cli/log/cli-*.log`, incl. `cli-20260816_102243.log`) | Per-request `http_helpers.go:232] URL: ...` trace lines; auto-updater, OAuth, language-server messages | `grep -hE 'URL: https?://' .../log/*.log`; `grep -hE 'auto_updater|server_oauth|server.go:5..'` |
| E3 | CLI state/config files | `settings.json` (model: "Gemini 3.1 Pro (Low)"), `updater/update_status.json` ("Already on the latest version."), `jetski_state.pbtxt`, `installation_id`, `antigravity-oauth-token` (present; contents NOT read/printed) | `rtk read` on state files; `find ~/.gemini/antigravity-cli` |
| E4 | Conversation transcripts `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript{,_full}.jsonl` | `SEARCH_WEB` step entries carrying Vertex AI Search grounding redirects; browser-tool page assets | `grep -hoE 'https?://[^ ]+'` + JSON step-type inspection |
| E5 | Official docs & changelog (public, fetched live) | `https://antigravity.google.com/docs`, `https://antigravity.google` (marketing), `https://raw.githubusercontent.com/google-antigravity/antigravity-cli/refs/heads/main/CHANGELOG.md` — 1.1.13 entry documents `GEMINI_API_KEY` / `modelProvider: "gemini"` / `GOOGLE_GEMINI_BASE_URL`; 1.1.10 documents Business/Gemini-Enterprise sign-in (region/Vertex), Workforce Identity Federation, ADC | `webfetch` of both docs URLs and the raw CHANGELOG |

### Host-environment caveat (important)

DNS on this host is a **catch-all sandbox resolver**: every queried name —
including `definitely-not-a-real-domain-xyz987123.com` — resolves to `198.18.x.x`
(`getent ahosts`). Therefore local DNS resolution of any candidate host proves
nothing about public reachability; public-reachability claims below rest only on
the live fetches in E5. All hosts were still queried and are listed; resolution
detail is omitted from the tables because it is uninformative in this environment.

## Classification key

- **(A) Directly observed** in this host's real runtime (CLI logs/transcripts today).
- **(B) Statically present** in the exact local binary (and/or cited by the official
  changelog/docs). Not proven to be exercised in this host's sessions.
- **(C) Conservative wildcard** recommendations — not individually proven necessary.

---

## Section A — Directly observed in this runtime (highest confidence)

| Hostname | Port/Protocol | What | Evidence |
|----------|---------------|------|----------|
| `daily-cloudcode-pa.googleapis.com` | 443/TLS, HTTP(S) JSON; SSE streaming | **Primary API + auth + models + inference.** RPC paths observed: `/v1internal:loadCodeAssist`, `/v1internal:fetchAvailableModels`, `/v1internal:streamGenerateContent?alt=sse` | 3,251 occurrences in E2; e.g. `I0816 10:22:47.509928 http_helpers.go:232] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` |
| `play.googleapis.com/log` | 443/TLS, HTTP(S) POST | Telemetry upload (Google "Clearcut"/Play log pipeline; also Playwright's telemetry endpoint). "Uploading error to Clearcut" string in binary corroborates | 1 occurrence in E2; `https://play.googleapis.com/log` in binary (E1) |
| `playwright.azureedge.net` (+ `playwright-akamai.azureedge.net`, `playwright-verizon.azureedge.net`) | 443/TLS, HTTPS GET archive | Downloads Playwright browser driver for the browser/web-tool features: `.../builds/driver/playwright-1.57.0-linux.zip` | ~2,170 lines in E2 (3 mirrors, attempt fallback chain). Binary template `%s/builds/driver/next/playwright-%s-%s.zip` in E1 |
| `vertexaisearch.cloud.google.com` | 443/TLS, HTTPS | Built-in **web search** (`SEARCH_WEB` step): Google-search grounding redirects opened via the browser tool, path `/grounding-api-redirect/…` | Many entries in E4 (step type `SEARCH_WEB`, status `DONE`) |
| `fonts.gstatic.com` | 443/TLS | Font assets of pages rendered in the CLI's browser tool (incidental page content) | E4 browser sessions |

Note: transcripts also show agent-initiated *user* sites (`app.paseo.sh`, `github.mindstacklab.ai`)
opened via the browser tool — these are user/agent-driven destinations, not Antigravity
infrastructure; include in any allowlist only if the CLI's browser tool should freely navigate.

Runtime-process observations (loopback only, no outer hostnames):
- OAuth session already established: `server_oauth.go:194] OAuth: authenticated successfully as …` with `authMethod=consumer` (consumer tier; token stored in `~/.gemini/antigravity-cli/antigravity-oauth-token` — contents not inspected/printed).
- Auto-updater active: `auto_updater.go:252] Last check was less than 15 minutes ago, skipping update (fast path)`; `auto_updater.go:305] Spawned background update process with PID …`; `updater/update_status.json` reports success (E2/E3).
- Language server binds **random** loopback ports (e.g. `Language server listening on random port at 40761 for HTTP`, `…43123 for HTTPS (gRPC)`).

---

## Section B — Statically present in the local binary (and/or official docs)

### B1. Sites & OAuth

| Hostname | What | Evidence |
|----------|------|----------|
| `antigravity.google.com` | Product site / API universe (`https://antigravity.google.comSearchCode` string); docs at `/docs` | E1; live-fetched OK in E5 |
| `antigravity.google` | Docs/changelog/support host: `/docs`, `/docs/cli/reference`, `/docs/enterprise`, `/changelog`, `/oauth-callback`, `/auth-success?app=%s`, `/support`, `/terms`, `/g1-credits`, `/g1-activity` | E1; cited as "marketing site" by E5 |
| `accounts.google.com` | 3-legged OAuth: `/o/oauth2/auth` (authorization + browser sign-in); device registration strings | E1 |
| `oauth2.googleapis.com` | `/device/code` (device flow), `/token` | E1 |
| `oauth2.mtls.googleapis.com` | `/token` (mtLS variant used by some Google auth paths) | E1 |
| `www.googleapis.com` | `/oauth2/v2/userinfo` (profile fetch — "failed to get profile picture"), `/drive/v3` (Drive tool: `drive.files.list`, exports), auth scopes (`drive.*`, `userinfo.*`, `cloud-platform`, `aicode`) | E1 |
| `www.mtls.googleapis.com` | `/drive/v3` + `/oauth2/...` mtLS variants | E1 |
| `auth.cloud.google` | `/authorize` — ADC external-account authorization (enterprise) | E1 |
| `gaiastaging.corp.google.com` (internal) | `/o/oauth2/auth`, `/o/oauth2/token` — GAIA staging sign-in (corp network only) | E1 |

### B2. Model discovery & inference hosts

| Hostname | What | Evidence |
|----------|------|----------|
| `daily-cloudcode-pa.googleapis.com` | Production consumer API (see Section A; also a constant in the binary) | E1+E2 |
| `cloudcode-pa.googleapis.com` | Alternative/fallback Code Assist PA API host | E1 |
| `aicode.googleapis.com` | `aicode` API host ("failed to dial aicode endpoint"); gRPC service `google.gca.aicode.v1main.PredictionService` | E1 |
| `businessaicode.googleapis.com` | Business-tier endpoint; gRPC `google.cloud.businessaicode.v1main.PredictionService`, `QueryConfig` | E1 |
| `generativelanguage.googleapis.com` | Gemini API — default base for the BYO-key route added in 1.1.13 (`modelProvider: "gemini"` + `GEMINI_API_KEY`; overridable via `GOOGLE_GEMINI_BASE_URL`) | E1 + changelog 1.1.13 in E5 |
| `aiplatform.googleapis.com` / `https://%s-aiplatform.googleapis.com` / `https://aiplatform.%s.rep.googleapis.com` | Vertex AI endpoints (regional pattern) — used by Business/Gemini-Enterprise sign-in and ADC (changelog 1.1.10); "Making Vertex AI request to: %s" | E1 + E5 |
| `alkalimakersuiteapplets.pa.googleapis.com` | `/v1/exports/…:download` — makersuite applet export download (auxiliary) | E1 |

### B3. Telemetry, policy, security

| Hostname | What | Evidence |
|----------|------|----------|
| `play.googleapis.com/log` | Clearcut telemetry ("Uploading error to Clearcut: %s") — see Section A | E1+E2 |
| `safebrowsing.googleapis.com` | `/v5/urls:search?urls=%s` — Safe Browsing URL denylist checks ([PolicyGuardian] / `CheckUrlDenylist`) | E1 |
| `csp.withgoogle.com` | `/csp/JetskiWeb` — CSP violation reporting | E1 |
| `symbolize.corp.google.com` (internal) | `/r/?trace=` — crash symbolization (needs symbols server; corp-only) | E1 |

### B4. Updates & downloads

| Hostname | What | Evidence |
|----------|------|----------|
| `antigravity-cli-auto-updater-974169037036.us-central1.run.app` | **Auto-updater service** (Google Cloud Run). Update check on startup (15-min fast path, background spawn observed in E2) | E1; activity E2/E3 |
| `raw.githubusercontent.com/google-antigravity/antigravity-cli/refs/heads/main/CHANGELOG.md` | `agy changelog` / `/changelog` content | E1; live-fetched OK in E5 |
| `https://github.com/cli/cli/releases/download/v%` | `gh` CLI bootstrap download (GitHub integration) | E1 |
| `https://github.com/astral-sh/python-build-standalone/releases/download/%s/%s` | Standalone Python download for the terminal sandbox ("Downloading standalone python from %s") | E1 |
| `https://exafunction.github.io/public/changelog/%d.%d.md` | Bundled editor-extension changelog (Exafunction/Codeium legacy component — likely dead/auxiliary) | E1 |

### B5. Runtime-environment helpers (sandbox/ADC libraries)

| Hostname | What | Evidence |
|----------|------|----------|
| `sts.googleapis.com` (`/v1/oauthtoken`) | Secure Token Service — workload/workforce identity federation (enterprise) | E1 |
| `iamcredentials.googleapis.com` | `/:generateAccessToken`, `workloadIdentityPools`/`workforcePools` `allowedLocations` (ADC federation) | E1 |
| `secretmanager.googleapis.com`, `cloudkms.googleapis.com`, `cloudaudit.googleapis.com`, `speech.googleapis.com` | ADC/enterprise support libraries (not exercised on consumer tier) | E1 |
| `api.deps.dev` | `/v3alpha` deps.dev API (bundled dependency-scanner library) | E1 |
| `pypi.org` | `/simple/` — pip index for the Python sandbox | E1 |
| `github.com` | GitHub integration: `/login/oauth/authorize`, `/login/device/code`, `/login/oauth/access_token`, `api.github.com`, `github.com/{owner}/{repo}.git` clones (user-triggered) | E1 |

### B6. Internal-only (Google corp VPN; deny by default in external proxies)

| Hostname | What |
|----------|------|
| `jetski.corp.google.com` | "enable-trustedcli-config-files", Google3 plugin installs ("only available in Google environments") |
| `jetski-autopush.corp.google.com` | Internal autopush release channel |
| `gaiastaging.corp.google.com` | GAIA staging OAuth |
| `symbolize.corp.google.com` | Crash symbolization |
| `prod-blue-layer1-no-cloudpath-wd.l.google.com` | WebRTC/browser-remote signaling default (also WebRTC TURN/STUN strings in binary) |
| `csp.withgoogle.com` | CSP reports (see B3) |

### B7. Documented env-var endpoint overrides (names only — official routing knobs)

`BAICODE_PREDICTION_ENDPOINT_URL`, `BAICODE_MANAGEMENT_ENDPOINT_URL`,
`BAICODE_TELEMETRY_ENDPOINT_URL`, `BAICODE_MANAGEMENT_RESOURCE_LOCATION`,
`GOOGLE_GEMINI_BASE_URL` (1.1.13), plus internal `UNIVERSE_DOMAIN` template
(`https://sts.UNIVERSE_DOMAIN/v1/token`). If any of these are set, traffic may
leave the Google domains above entirely.

---

## Section C — Conservative wildcard allowlist recommendations (operationally safe, not individually proven)

```
*.googleapis.com        # all Google APIs incl. future universe/regional hosts (daily-cloudcode-pa, cloudcode-pa, aicode, businessaicode, aiplatform, oauth2, sts, iamcredentials, safebrowsing, play, www, generative language …)
*.google.com            # accounts.google.com, search (www.google.com aid via browser), *.corp.google.com (corp; deny in external proxies)
*.google / *.goog       # antigravity.google (docs/auth redirects), antigravity-unleash.goog (feature flags)
*.gstatic.com           # page/font assets for browser tool
*.googleusercontent.com  # user-visible page assets through browser tool
*.run.app               # future auto-updater Cloud Run instances
*.azureedge.net         # Playwright browser-driver CDN mirrors
*.github.com + raw.githubusercontent.com + api.github.com   # changelog, gh, git clones, releases
*.pypi.org + *.pythonhosted.org                              # Python sandbox packages
```

---

## Ports & protocols summary

- All remote (outside-host) services: **TCP 443 / TLS (HTTPS)**; inference streaming
  additionally uses **SSE** over the same TLS channel (`?alt=sse`).
- No plaintext remote endpoints and no non-443 remote ports were observed.
- Loopback-only listeners (no outer host): OAuth callback `http://localhost:%d/auth/callback`
  (dynamic port); language server (random ports ~38k–47k, HTTP + gRPC/HTTPS, observed in E2);
  Chrome DevTools/CDP debug server `http://127.0.0.1:%d`; MCP servers on localhost.
- WebRTC (browser remoting) uses STUN/TURN — signaled default host is internal-only (B6).

## Highest-confidence proxy allowlist (must-have for normal consumer use)

```
daily-cloudcode-pa.googleapis.com            # required — all API/auth/models/inference
play.googleapis.com                          # telemetry
playwright.azureedge.net, playwright-akamai.azureedge.net, playwright-verizon.azureedge.net  # browser driver downloads
vertexaisearch.cloud.google.com              # web search grounding
accounts.google.com, oauth2.googleapis.com   # sign-in (initial + refresh)
antigravity-cli-auto-updater-974169037036.us-central1.run.app   # auto-update
raw.githubusercontent.com (google-antigravity/antigravity-cli)  # changelog
antigravity.google.com, antigravity.google   # docs/auth-success/oauth-callback redirects
```

## Remaining unknowns

1. **Unleash feature-flag traffic** (`antigravity-unleash.goog`) is in the binary
   (`/api/InitializeUnleash`) but never appears in this host's logs — unknown
   whether it is called at runtime on the consumer tier.
2. **OAuth callback port** is dynamic (format `localhost:%d`); exact default not
   pinned from this host's logs (auth was already cached).
3. **Update-check host at runtime** is inferred (binary constant + updater activity);
   the log does not record which host the background updater contacted.
4. **Crash-report upload target** (coroner flow) not logged; presumed Clearcut
   (`play.googleapis.com/log`) or the `/v1internal` API.
5. **Public resolvability of `antigravity.google` / `*.goog`** could not be tested
   from this host (catch-all sandbox DNS); Google's own docs link to
   `https://antigravity.google/` as the marketing site.
6. **Enterprise/Vertex specifics** (regional `%s-aiplatform.googleapis.com`
   selection, `businessaicode` usage) unobserved on this consumer-tier host.
7. WebRTC TURN/STUN server addresses for browser remoting are not extractable as
   fixed hostnames (signaling default is an internal `l.google.com` name).

## Compliance notes

- Credentials/tokens/cookies: not printed, not stored; OAuth token file and
  embedded OAuth client-secret constants were deliberately not reproduced.
- PII redacted (the consumer account email observed in logs is omitted).
- No repo path other than the single output file was modified; no git index/refs,
  proxy, network, or daemon configuration was touched.