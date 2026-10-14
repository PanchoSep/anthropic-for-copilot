import { isOfficialAnthropicBaseUrl, normalizeBaseUrl } from './endpoint';

export type CredentialScheme = 'bearer' | 'x-api-key';
export type CredentialSchemeSetting = 'auto' | CredentialScheme;

/**
 * Which variable supplied the credential. `auth-token-env` / `api-key-env`
 * describe the variable name (`*_AUTH_TOKEN` vs `*_API_KEY`) regardless of
 * whether it came from the real environment or a Claude Code settings file.
 */
export type CredentialOrigin = 'auth-token-env' | 'api-key-env' | 'secret-storage' | 'setting';

export interface Credential {
	value: string;
	scheme: CredentialScheme;
	origin: CredentialOrigin;
}

export interface SdkAuthOptions {
	apiKey: string | null;
	authToken: string | null;
	defaultHeaders: Record<string, string | null>;
}

/**
 * Headers that carry the Anthropic credential itself. Anything else — notably
 * a relay side-channel key such as `x-litellm-api-key` — authenticates the
 * caller to the proxy and must coexist with the Anthropic credential.
 */
const ANTHROPIC_AUTH_HEADERS = ['authorization', 'x-api-key'];

/**
 * Anthropic OAuth access tokens (Claude subscription sessions, e.g. from the
 * Claude Code login flow or `claude setup-token`) use this prefix and are
 * otherwise indistinguishable from a plain API key on the wire.
 */
const OAUTH_ACCESS_TOKEN_PREFIX = 'sk-ant-oat';

/**
 * Anthropic's backend answers every request made with an OAuth access token
 * with `429 rate_limit_error` — regardless of which headers are sent — unless
 * the request's system prompt identifies the caller as Claude Code. Callers
 * use this to decide whether to prepend that identity line.
 */
export function isOAuthAccessToken(value: string): boolean {
	return value.startsWith(OAUTH_ACCESS_TOKEN_PREFIX);
}

/**
 * The exact system-prompt text confirmed (by diffing real Claude Code CLI
 * traffic against ours) to be necessary to stop an OAuth access token from
 * being rejected with a 429. On its own it is not sufficient: it must also
 * be sent as its own isolated block at `system[0]` (see
 * `buildSystemWithClaudeCodeIdentity` below) — concatenating it into a
 * single string together with other system content still 429s, even though
 * the text is present verbatim. Shared so the request builder and the
 * wire-level logger agree on what "identity is present" means.
 */
export const CLAUDE_CODE_IDENTITY_SYSTEM_PROMPT =
	"You are Claude Code, Anthropic's official CLI for Claude.";

export interface AnthropicSystemBlock {
	type: 'text';
	text: string;
	cache_control?: { type: 'ephemeral' };
}

/**
 * Builds the `system` value an OAuth access token needs. Confirmed live: the
 * identity must be `system[0]` as its own block — concatenating it with the
 * rest of the system prompt into a single string still 429s, even though the
 * text is present verbatim, because the check requires an isolated block, not
 * merely a substring.
 */
export function buildSystemWithClaudeCodeIdentity(
	system: string | AnthropicSystemBlock[] | undefined,
): AnthropicSystemBlock[] {
	const blocks: AnthropicSystemBlock[] = [
		{ type: 'text', text: CLAUDE_CODE_IDENTITY_SYSTEM_PROMPT },
	];
	if (system) {
		if (typeof system === 'string') {
			blocks.push({ type: 'text', text: system });
		} else {
			blocks.push(...system);
		}
	}
	return blocks;
}

export function resolveCredentialScheme(
	origin: CredentialOrigin,
	baseUrl: string,
	setting: CredentialSchemeSetting,
): CredentialScheme {
	if (setting !== 'auto') {
		return setting;
	}
	if (origin === 'auth-token-env') {
		return 'bearer';
	}
	if (origin === 'api-key-env') {
		return 'x-api-key';
	}

	// Official Anthropic authenticates with x-api-key; third-party relays
	// overwhelmingly expect an OAuth-style bearer token.
	return isOfficialAnthropicBaseUrl(normalizeBaseUrl(baseUrl)) ? 'x-api-key' : 'bearer';
}

export function buildSdkAuth(
	credential: Credential | undefined,
	customHeaders: Record<string, string>,
): SdkAuthOptions {
	const defaultHeaders: Record<string, string | null> = { ...customHeaders };
	const headerOverridesAuth = Object.keys(customHeaders).some((key) =>
		ANTHROPIC_AUTH_HEADERS.includes(key.toLowerCase()),
	);

	if (!credential || headerOverridesAuth) {
		if (!headerOverridesAuth) {
			// Marks the omission as deliberate; otherwise the SDK refuses to
			// build a request at all.
			defaultHeaders['x-api-key'] = null;
		}
		return { apiKey: null, authToken: null, defaultHeaders };
	}

	// The SDK reads ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN whenever these are
	// `undefined`, so the unused field must be an explicit null.
	return credential.scheme === 'bearer'
		? { apiKey: null, authToken: credential.value, defaultHeaders }
		: { apiKey: credential.value, authToken: null, defaultHeaders };
}
