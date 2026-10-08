# CLAUDE.md
This file provides guidance coding agenrs when working with code in this repository.

## Project overview

VS Code extension that implements `vscode.LanguageModelChatProvider` (vendor id `anthropic-copilot`, `VENDOR_ID` in `src/consts.ts`) so Anthropic Claude models (Sonnet 5, Opus 5, Fable 5.1, Haiku 4.5, plus user-defined custom models) appear directly in the native GitHub Copilot Chat model picker. The extension is a translation layer between VS Code's Language Model Chat API and Anthropic's Messages API — it does not implement any chat UI itself; Copilot Chat's UI, agent mode, and tool calling are reused as-is.

The vendor id is deliberately **not** `'anthropic'`: GitHub Copilot Chat bundles its own native Anthropic BYOK provider that registers that exact vendor id near-unconditionally for any individual Copilot subscriber. VS Code's runtime `_providers` registry allows only one registrant per vendor id — whichever extension calls `registerLanguageModelChatProvider` second throws synchronously, which previously made this extension's activation fail depending on activation-order race timing (only a full window reload, which resets the registry, reliably "fixed" it). Do not revert this vendor id back to `'anthropic'`.

Node >= 24 is required (see `.nvmrc`); no bundler is used, `tsc` compiles `src/` straight to `out/`.

## Commands

- `npm run compile` — clean `out/` and run `tsc -p ./` (what `vscode:prepublish` runs before packaging)
- `npm run watch` — same as compile but in `tsc -watch` mode
- `npm run lint` — `oxlint` (config: `.oxlintrc.json`)
- `npm run format` / `npm run format:check` — `oxfmt` over `src/` (tabs, single quotes — see `.oxfmtrc.json`; `.gitattributes` pins LF checkouts because oxfmt rejects CRLF)
- `npm test` — compiles `tests/` (via `tests/tsconfig.json`) then runs the offline suite in `tests/unit/`
- `npm run test:live` — the network integration test in `tests/live/` (needs real credentials; not run by CI)
- `npm run package` — `vsce package -o dist/` produces the installable `.vsix`

In VS Code, F5 (`Run Extension (Current VS Code)` launch config) starts an Extension Development Host with `npm: watch` as the pre-launch task.

CI (`.github/workflows/ci.yml`) runs lint, format:check, compile, `npm test`, and package. Only the offline suite runs there; `test:live` is never run by CI.

### Releasing

Releasing is fully automatic — nobody edits a version number. `ci.yml` runs on every push to `main` and on `workflow_dispatch`; once lint/format/compile/test are green, the `build` job's **Plan release** step decides what to publish:

- **Only the newest push to main publishes.** The plan refetches `origin/main` and stands down when `github.sha` is behind the tip, and the workflow-level concurrency group serializes runs per ref, so a queued run can never race an in-flight bump.
- **Version choice.** If `package.json`'s version has no `v<version>` tag yet, that version is published as-is (this keeps a hand-written bump in a PR meaningful). If it was already released, the version is bumped (`npm version … --no-git-tag-version`, plus a generated `## [<version>]` CHANGELOG section from the commit subjects since the previous tag) so that every merged change ships. So merging a fix to `main` publishes a new patch version with no further action.
- **Skips.** Pull requests never publish; pushes that touch only documentation/CI paths (`*.md`, `docs/**`, `.github/**`, `.vscode/**`, `LICENSE`, `.gitignore`, `.gitattributes`, `.nvmrc`, `.ox*.json`) are built but not released; a `chore(release):` commit on HEAD is ignored as a loop guard. A `::notice::` in the log always states which branch of this decision was taken.
- **On-demand.** Running the workflow manually (on `main`) forces a release; the `bump` input selects `auto` (default), `patch`, `minor`, `major`, or `none` (build only).

The `release` job (GitHub environment `production`, created automatically on first use — put the tokens there or at repository scope, whichever you prefer) reuses the VSIX the `build` job produced — it is never rebuilt — and verifies the version inside the package matches the plan before doing anything. Then it: adopts the bumped `package.json`/`package-lock.json`/`CHANGELOG.md` (shipped over as an artifact, so the released tree matches the published VSIX byte for byte), commits them to `main` as `chore(release): v<version> [skip ci]` **before** publishing (so a push that cannot land, e.g. a protected `main`, fails loudly instead of leaving the Marketplace ahead of the repository), publishes to the VS Code Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`), and finally — once those steps have run and provided none of them failed — creates the tag plus a GitHub Release whose body is the matching `## [<version>]` CHANGELOG section and that carries the packaged `.vsix` as a release asset (the `build` job's workflow artifact is the same file, but expires).

A failed publish therefore leaves `main` holding an untagged version that the next run simply publishes as-is — no manual repair, no double bump. **A token that is not configured is not a failure**: that target is skipped with a `::warning::` and a note in the job summary, so a push to `main` still yields the tag, the GitHub Release and the VSIX — the Marketplace simply lags behind the tags until the secret exists and Rescue Publish is run against them. A token that *is* configured but cannot publish (e.g. a `VSCE_PAT` without Marketplace scope) still fails the run before anything is tagged. There are no repository variables to maintain. `.github/workflows/rescue.yml` (`workflow_dispatch`) publishes any ref by hand — to catch up a skipped target or to retry a release that failed part-way; it refuses to re-point an existing tag at a different commit — bump the version instead.

Note the bump commit is pushed with the default `GITHUB_TOKEN`, and GitHub never starts workflow runs for pushes made with that token, which is what keeps the automation loop-free; the `[skip ci]` marker is a second guard for when someone pushes such a commit with a personal token.

### Tests

`tests/unit/` is the offline suite and the one CI gates on. `tests/mock-vscode.js` is preloaded via `--require`; it patches `Module.prototype.require` to stub the `vscode` module and exposes `globalThis.__vscodeMock` so a test can drive settings by full id (`__vscodeMock.config['anthropic-copilot.customHeaders'] = ...`) and `reset()` between cases. Most logic under test lives in vscode-free modules (`src/credentials.ts`, `src/model-id.ts`, `src/claude-code.ts`, `src/client/base-url.ts`) so it can be imported directly.

`tests/unit/client-wire.test.ts` is the important one: it stubs `globalThis.fetch`, builds a real `AnthropicClient`, and asserts the headers that actually reach the wire. The SDK resolves its fetch implementation **in the constructor**, so the stub must be installed before the client is built — that is why the helper takes a factory rather than an instance. Any test touching `config.ts` must also set `anthropic-copilot.useClaudeCodeSettings` to `false`, or it will read the developer's real `~/.claude/settings.json`.

`tests/live/proxy.test.ts` opens a real streaming connection to an Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL`) using real credentials and fails immediately if none are set. Keep it out of the default `npm test` path.

## Architecture

### Activation flow

`src/extension.ts` re-exports `activate`/`deactivate` from `src/runtime/lifecycle.ts`, which on activation: initializes diagnostics, registers commands (`runtime/commands.ts`), registers URI handlers for deep-linked actions (`runtime/actions.ts` — e.g. `vscode://<ext-id>/setApiKey`, used by error messages and notices to link back into the extension), then builds and registers the provider (`runtime/provider.ts`), which constructs `AnthropicChatProvider` and calls `vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider)`. It also nudges `github.copilot-chat` to activate so the model picker refreshes promptly, and shows the walkthrough on first run (`runtime/welcome.ts`).

### The provider (`src/provider/index.ts`)

`AnthropicChatProvider` implements the three `LanguageModelChatProvider` methods:

- **`provideLanguageModelChatInformation`** — returns the model list. `getAllModels()` (`config.ts`) merges the built-in `MODELS` array (`consts.ts`) with user `customModels` and any *new* keys found in `modelIdOverrides` (auto-registered as custom models so pointing an override at an unknown ID doesn't hide it from the picker). Pricing/currency display comes from `pricing/currency.ts` + `pricing/schedule.ts` and is cosmetic only. Fires `onDidChangeLanguageModelChatInformation` (debounced 300ms) whenever relevant settings/secrets change.
- **`provideLanguageModelChatResponse`** — the per-turn pipeline, in order:
  1. `resolveConversationSegment` (`provider/segment.ts`) and `classifyProviderRequest` (`provider/routing/`) — used only for diagnostics/logging grouping.
  2. `dumpProviderInput` (`provider/debug/dump.ts`) — writes raw provider input to disk under `context.globalStorageUri` when `debugMode` is `verbose`.
  3. `processToolFlow` (`provider/tools/flow.ts`) — the experimental `stabilizeToolList` preflight. It can short-circuit the whole call (`preflightHandled: true`) by emitting synthetic tool-call parts that pre-activate Copilot's `activate_*` virtual tools across bounded rounds (`MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST`), so the `tools` array Anthropic sees is complete/stable turn-to-turn (stability matters for Anthropic's prompt cache — see `docs/notices/tool-drift.*.md`).
  4. `prepareChatRequest` (`provider/request.ts`) — resolves the API key (`AuthManager`), builds an `AnthropicClient`, resolves vision input (`provider/vision/`), converts VS Code messages/tools to Anthropic's schema (`provider/convert.ts`), and derives a thinking token budget from the requested reasoning effort.
  5. `streamChatCompletion` (`provider/stream.ts`) — drives `AnthropicClient.streamChatCompletion`'s callbacks, translating Anthropic SSE events into `vscode.LanguageModelTextPart` / `LanguageModelThinkingPart` / `LanguageModelToolCallPart` progress reports, and reports a trailing replay-marker part plus a Copilot-usage data part once the stream ends.
- **`provideTokenCount`** — a chars-per-token heuristic that self-calibrates from each turn's real `usage` numbers (see `updateCharsPerToken` in `stream.ts`); skipped when the turn included native images, since image tokens break the char-ratio estimate.

### Auth & config resolution (`src/auth.ts`, `src/config.ts`, `src/credentials.ts`, `src/claude-code.ts`)

This project targets "BYOK behind a relay" setups (Claude Code, CC-Switch, LiteLLM), which drives two decisions that are easy to break.

**The credential carries a scheme, not just a value.** `AuthManager.getCredential()` returns a `Credential` — `{ value, scheme, origin }` — because relays commonly accept *only* `Authorization: Bearer` and reject `x-api-key`. When that distinction is lost the relay falls back to its own upstream account and the failure surfaces as a **billing error** ("Your credit balance is too low"), not an auth error, which makes it very hard to diagnose. `resolveCredentialScheme()` maps `*_AUTH_TOKEN` to bearer, `*_API_KEY` to x-api-key, and a stored key to x-api-key on the official endpoint or bearer elsewhere; `anthropic-copilot.authScheme` overrides it.

**Relay side-channel headers coexist with the credential.** `buildSdkAuth()` only stands down when the user supplies `authorization` or `x-api-key` themselves. A header like `x-litellm-api-key` authenticates the caller *to the relay* and must be sent alongside the Anthropic credential — treating it as a replacement is what caused the billing error above. The unused SDK field is set to an explicit `null`, because the SDK silently reads `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the environment when it is `undefined`.

**OAuth access tokens reject Copilot's `mcp_` tool names outright.** With a `sk-ant-oat…` OAuth access token (`isOAuthAccessToken()`), Anthropic's subscription gateway classifies any request whose `tools` array contains a name matching `^mcp_[a-z][a-z0-9_]*$` (Copilot's lowercase `mcp_<server>_<tool>` naming, e.g. `mcp_upgrade_open_dashboard`) as third-party usage and 400s the *whole* request with `"You're out of extra usage"` — this is why Copilot Agent mode can fail while Ask mode (no MCP tools) works. `mcp__a__b` (Claude Code's own double-underscore naming), names with an uppercase letter, `mcp-a-b`, and bare `mcp_` all pass; only that exact shape trips it. `filterUnsupportedMcpTools()` (`provider/tools/mcp-filter.ts`) drops matching tools before the request is built, for OAuth tokens only, and logs what it removed — better than letting the whole turn fail. Do not "fix" this by renaming tools on the wire to dodge the check; that would circumvent the provider's own usage classification.

**Resolution order.** `~/.claude/settings.json` (its `env` block) → real `process.env` → VS Code settings. Claude Code injects that `env` block only into its own child processes, so a VS Code launched from the Start Menu sees none of those variables; reading the file directly (`src/claude-code.ts`, mtime-cached, JSONC-tolerant) lets one configuration serve both tools. Disable with `anthropic-copilot.useClaudeCodeSettings`. The one exception is `getBaseUrl()`, where an explicitly changed `baseUrl` setting still beats `process.env` — Claude Code settings outrank both.

- **API key**: `ANTHROPIC_AUTH_TOKEN`/`CLAUDE_AUTH_TOKEN` (bearer, used exclusively when present) → `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` (x-api-key) → `SecretStorage` → `anthropic-copilot.apiKey`.
- **Model ID**: `modelIdOverrides` → `ANTHROPIC_DEFAULT_{SONNET,OPUS,FABLE,HAIKU}_MODEL` → the VS Code model id.
- **Custom headers** (`customHeaders` setting / `ANTHROPIC_CUSTOM_HEADERS`, JSON or `Key: Value` lines).
- `getDebugMode()` reads `debugMode`; the legacy boolean `debug` setting is migrated to `debugMode: metadata` on activation.

### Message conversion (`src/provider/convert.ts`)

**Empty text parts must never become text blocks.** Copilot replays every historical assistant turn that called a tool without saying anything as an empty `LanguageModelTextPart` in front of the `LanguageModelToolCallPart`. Anthropic rejects the *whole* request over a `{"type":"text","text":""}` block with `400 invalid_request_error: messages: text content blocks must be non-empty`, so `convertMessages()` only emits a block when `part.value.length > 0`; the turn survives on its `tool_use` block. The empty blocks accumulate one per tool round, and the official endpoint tolerates them where some relays do not — which is why this presented as an Agent-mode failure that only appeared after several tool rounds and only on a relay `baseUrl`. Regression coverage: `tests/unit/convert-empty-text.test.ts`.

### Model IDs and betas (`src/model-id.ts`)

`[1M]` is a **Claude Code client-side convention**, not an Anthropic model name — the real API answers `404 not_found_error` for `claude-sonnet-5[1M]`. `parseModelId()` strips the suffix and returns the `context-1m-2025-08-07` beta instead, which the client sends as `anthropic-beta`. This is what makes `modelIdOverrides` and `ANTHROPIC_DEFAULT_*_MODEL` copy-paste compatible with a Claude Code config.

### Base URL (`src/client/base-url.ts`)

The SDK posts to `/v1/messages` *relative to* `baseURL`, so `normalizeSdkBaseUrl()` strips any trailing `/v1/messages`, `/messages`, or `/v1` the user pasted. Adding a `/v1` here instead produces `…/v1/v1/messages`. Use `buildMessagesEndpoint()` when logging the target — never reconstruct it by hand.

### Vision (`src/provider/vision/`)

The most involved subsystem. Two image-handling modes, chosen per model by `capabilities.nativeImageInput`:

- **native** — images are forwarded as-is inside the Anthropic request (model supports vision natively).
- **proxy** — the model has no native vision, so images are replaced with a text description produced by a separate "vision describer" before the request is built (`pipeline.ts` → `resolve.ts`).

Describer sources (`service.ts`, configured via `Anthropic: Set Vision Model` / the `anthropic-copilot.visionModel` setting, with a webview config panel under `ui/`):
- `vscode-lm` — delegates description to another installed VS Code language model.
- `api-endpoint` — calls an external OpenAI- or Anthropic-compatible vision endpoint (`protocols/providers/{anthropic,openai}/`), with its own stored API key (`sources/endpoint/config.ts`).

Because VS Code's chat history is opaque/text-only between turns, resolved vision text (and accumulated reasoning) is round-tripped through **replay markers** (`src/provider/replay/`): an invisible `LanguageModelDataPart` (mime `REPLAY_MARKER_MIME`) appended to the assistant's response, parsed back out of history on the next turn (`parseFirstReplayMarker`) so old image messages don't need to be re-described or re-sent. `resolve.ts` only actually describes/forwards the *most recent* image message; older ones are satisfied from their replay marker or dropped — see the counters in `stats.ts` for exactly what happened to each message.

### Other subsystems

- **`provider/pricing/`** — `currency.ts`'s `BalanceCurrencyResolver` queries the official Anthropic balance API (only when `baseUrl` is the official host) to decide whether to display USD or CNY pricing in the model picker, caching the result in extension global state; `schedule.ts` resolves the current peak/off-peak pricing tier from `MODELS[].pricing`.
- **`provider/debug/`** — `verbose` debug mode dumps full request/response payloads (hashed/truncated) to disk under global storage, browsable via `Anthropic: Open Request Dumps Folder`; `diagnostics.ts`'s cache-diagnostics recorder tracks Anthropic prompt-cache hit/miss behavior per request for troubleshooting cache misses caused by e.g. unstable tool lists or changing vision marker text.
- **`provider/skills/`** — trims Copilot's Agent Skills index. Copilot lists every discovered skill as a `<skill>` entry inside a `<skills>` block in the system prompt (1,551 entries / 480 KB in one measured setup). When `totalCount > anthropic-copilot.skillIndex.threshold` (default 128; 0 = always), `processSkillIndex` (`flow.ts`, called from `provider/index.ts` after `processToolFlow`) swaps the block for a fixed stub and appends a `<relevant_skills>` block with at most `maxRelevant` (default 12) entries to every user message that counts as a request. Normally that is each message's `<userRequest>` inner text; but when *no* message in the conversation carries a `<userRequest>` tag at all (non-agent surfaces), every text-bearing user message becomes a request instead, each scored on its own full text — never just the last one. Three invariants: (1) selection (`select.ts`) is a pure lexical IDF function of the request text, the previous request text, the index and K, so history messages re-render byte-identically each turn and the prompt-cache prefix survives — never add non-deterministic inputs; (2) which messages are requests, and the text each is scored on, is content-addressed rather than positional: picking "the last text-bearing message" would make a message's bytes depend on how many turns follow it, silently invalidating the cached prefix from that message on as the conversation grows — and for the same reason *whether* to trim is decided from whether the prompt carries a parseable `<skills>` block, never from `requestKind`: the classifier reports `terminal-steering` for Copilot's own `[Terminal … notification: …]` follow-ups, which still carry the full index; (3) any parse failure or exception forwards the messages untouched — a parse failure reports `stats.action` = `absent` (or `not-applicable` on a non-`main-agent` request) with a `stats.reason` naming which guard refused, while an unexpected exception reports `stats.action` = `error` and sets no reason. Entries are re-emitted as their raw bytes.
- **`i18n.ts`** — an in-house zero-dependency `t()` lookup keyed off `vscode.env.language` (English default, `zh-cn` translated); separate from `package.nls.json`/`package.nls.zh-cn.json`, which localize static `package.json` contribution strings via `%key%` placeholders.
- **`client/`** — `AnthropicClient` (`core.ts`) wraps `@anthropic-ai/sdk`'s streaming `messages.stream()` call; `error/` normalizes SDK/network errors into user-facing messages and sanitizes headers before logging.

### Module layout convention

Most directories under `src/` expose a single `index.ts` barrel that re-exports the public surface; sibling files like `consts.ts`, `types.ts`, and internal implementation modules are meant to be reached only through that barrel, not imported directly from outside the folder. Follow this pattern for new modules.
