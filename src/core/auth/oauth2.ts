import { createHash, randomBytes } from "node:crypto";
import type {
	AuthOAuth2,
	OAuth2AdditionalParameter,
	OAuth2AuthorizationCodeFlow,
	OAuth2ClientCredentialsFlow,
	OAuth2ResourceOwnerPasswordFlow,
} from "@opencollection/types/common/auth-oauth2";
import type { Header } from "../model";
import type { Transport, TransportResponse } from "../transport/types";

export interface TokenSet {
	accessToken: string;
	idToken?: string;
	refreshToken?: string;
	tokenType?: string;
	/** Epoch milliseconds. */
	expiresAt?: number;
}

export interface TokenRequestOptions {
	rejectUnauthorized: boolean;
	signal?: AbortSignal;
}

export class OAuth2Error extends Error {
	constructor(message: string, readonly response?: TransportResponse) {
		super(message);
		this.name = "OAuth2Error";
	}
}

const EXPIRY_SKEW_MS = 30_000;

type TokenFlow = OAuth2ClientCredentialsFlow | OAuth2ResourceOwnerPasswordFlow | OAuth2AuthorizationCodeFlow;

/** What the browser step of the authorization code flow returns. */
export interface AuthorizationResult {
	code: string;
	/** The redirect URI the code was issued for; the token request must repeat it. */
	redirectUri: string;
	/** The PKCE verifier, when the authorization request carried a challenge. */
	codeVerifier?: string;
}

/** Sends the user to the authorization URL and waits for the code to come back. */
export type Authorizer = (auth: OAuth2AuthorizationCodeFlow, signal?: AbortSignal) => Promise<AuthorizationResult>;

/** A PKCE pair for the flow's method; undefined when PKCE is turned off. */
export function pkceFor(auth: OAuth2AuthorizationCodeFlow): { verifier: string; challenge: string; method: "S256" | "plain" } | undefined {
	if (auth.pkce?.disabled) return undefined;
	const verifier = randomBytes(32).toString("base64url");
	if (auth.pkce?.method === "plain") return { verifier, challenge: verifier, method: "plain" };
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), method: "S256" };
}

/** The URL to open in the browser to start the authorization code flow. */
export function authorizationUrl(auth: OAuth2AuthorizationCodeFlow, options: { redirectUri: string; state: string; pkce?: { challenge: string; method: string } }): string {
	if (!auth.authorizationUrl) throw new OAuth2Error("The OAuth 2.0 authorization URL is empty.");
	let url: URL;
	try {
		url = new URL(auth.authorizationUrl);
	} catch {
		throw new OAuth2Error(`The OAuth 2.0 authorization URL isn't valid: ${auth.authorizationUrl}`);
	}
	const params = url.searchParams;
	params.set("response_type", "code");
	params.set("client_id", auth.credentials?.clientId ?? "");
	params.set("redirect_uri", options.redirectUri);
	if (auth.scope) params.set("scope", auth.scope);
	params.set("state", options.state);
	if (options.pkce) {
		params.set("code_challenge", options.pkce.challenge);
		params.set("code_challenge_method", options.pkce.method);
	}
	for (const p of auth.additionalParameters?.authorizationRequest ?? []) {
		if (p.name && p.placement !== "header" && p.placement !== "body") params.append(p.name, p.value ?? "");
	}
	return url.toString();
}

/**
 * Fetches and caches OAuth 2.0 tokens, in memory only. Client credentials and password need no
 * browser; the authorization code flow asks `authorize` to send the user through one.
 */
export class OAuth2Tokens {
	private readonly cache = new Map<string, TokenSet>();
	private readonly pending = new Map<string, Promise<TokenSet>>();

	constructor(private readonly transport: Transport, private readonly authorize?: Authorizer) {}

	clear(): void {
		this.cache.clear();
	}

	async token(auth: AuthOAuth2, options: TokenRequestOptions): Promise<TokenSet> {
		if (auth.flow !== "client_credentials" && auth.flow !== "resource_owner_password_credentials" && auth.flow !== "authorization_code") {
			throw new OAuth2Error(`The OAuth 2.0 "${auth.flow}" flow is not supported yet.`);
		}
		if (!auth.accessTokenUrl) throw new OAuth2Error("The OAuth 2.0 access token URL is empty.");

		const key = cacheKey(auth);
		const cached = this.cache.get(key);
		if (cached && (cached.expiresAt === undefined || cached.expiresAt - EXPIRY_SKEW_MS > Date.now())) return cached;
		// Requests sent together share one token fetch, so the browser opens only once.
		const pending = this.pending.get(key);
		if (pending) return pending;
		const fetch = this.fetchToken(auth, key, cached, options).finally(() => this.pending.delete(key));
		this.pending.set(key, fetch);
		return fetch;
	}

	private async fetchToken(auth: TokenFlow & { accessTokenUrl?: string }, key: string, cached: TokenSet | undefined, options: TokenRequestOptions): Promise<TokenSet> {
		const accessTokenUrl = auth.accessTokenUrl!;

		let token: TokenSet | undefined;
		if (cached?.refreshToken && auth.settings?.autoRefreshToken !== false) {
			token = await this.request(auth, auth.refreshTokenUrl || accessTokenUrl, {
				grant_type: "refresh_token",
				refresh_token: cached.refreshToken,
			}, auth.additionalParameters?.refreshTokenRequest, options).catch(() => undefined);
		}
		if (!token && auth.flow === "authorization_code") {
			if (!this.authorize) throw new OAuth2Error("The authorization code flow needs a browser, which isn't available here.");
			const result = await this.authorize(auth, options.signal);
			const grant: Record<string, string> = { grant_type: "authorization_code", code: result.code, redirect_uri: result.redirectUri };
			if (result.codeVerifier) grant.code_verifier = result.codeVerifier;
			token = await this.request(auth, accessTokenUrl, grant, auth.additionalParameters?.accessTokenRequest, options);
		} else if (!token) {
			const grant: Record<string, string> = { grant_type: auth.flow === "client_credentials" ? "client_credentials" : "password" };
			if (auth.flow === "resource_owner_password_credentials") {
				grant.username = auth.resourceOwner?.username ?? "";
				grant.password = auth.resourceOwner?.password ?? "";
			}
			token = await this.request(auth, accessTokenUrl, grant, auth.additionalParameters?.accessTokenRequest, options);
		}
		// A refresh may leave out the refresh token, meaning the old one stays valid.
		if (!token.refreshToken && cached?.refreshToken) token = { ...token, refreshToken: cached.refreshToken };
		this.cache.set(key, token);
		return token;
	}

	private async request(
		auth: TokenFlow,
		url: string,
		grant: Record<string, string>,
		extra: readonly OAuth2AdditionalParameter[] | undefined,
		options: TokenRequestOptions,
	): Promise<TokenSet> {
		const form = new URLSearchParams(grant);
		// The code already carries its scope; repeating it is only for the other grants.
		if (auth.scope && grant.grant_type !== "authorization_code") form.set("scope", auth.scope);
		const headers: Header[] = [
			["Content-Type", "application/x-www-form-urlencoded"],
			["Accept", "application/json"],
		];

		const clientId = auth.credentials?.clientId ?? "";
		const clientSecret = auth.credentials?.clientSecret ?? "";
		// A public client (no secret) identifies itself in the body; Basic auth needs a secret.
		const publicClient = auth.flow === "authorization_code" && !clientSecret;
		if (auth.credentials?.placement === "body" || publicClient) {
			form.set("client_id", clientId);
			if (clientSecret) form.set("client_secret", clientSecret);
		} else if (clientId) {
			// RFC 6749 §2.3.1: credentials are form-encoded before being joined for Basic auth.
			const basic = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
			headers.push(["Authorization", `Basic ${Buffer.from(basic).toString("base64")}`]);
		}

		const target = new URL(url);
		for (const p of extra ?? []) {
			if (!p.name) continue;
			const value = p.value ?? "";
			if (p.placement === "header") headers.push([p.name, value]);
			else if (p.placement === "query") target.searchParams.append(p.name, value);
			else form.append(p.name, value);
		}

		const response = await this.transport.send({
			method: "POST",
			url: target.toString(),
			headers,
			body: new TextEncoder().encode(form.toString()),
			timeoutMs: 30_000,
			followRedirects: true,
			maxRedirects: 5,
			forwardAuthorizationHeader: false,
			rejectUnauthorized: options.rejectUnauthorized,
			maxBodyBytes: 1_000_000,
			signal: options.signal,
		});
		const text = new TextDecoder().decode(response.body);
		const data = parseTokenResponse(text);
		if (response.status >= 400 || typeof data.access_token !== "string") {
			const reason = typeof data.error_description === "string" ? data.error_description : typeof data.error === "string" ? data.error : text.slice(0, 200);
			throw new OAuth2Error(`Token request failed (${response.status}): ${reason}`, response);
		}
		const expiresIn = Number(data.expires_in);
		return {
			accessToken: data.access_token,
			idToken: typeof data.id_token === "string" ? data.id_token : undefined,
			refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
			tokenType: typeof data.token_type === "string" ? data.token_type : undefined,
			expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
		};
	}
}

/** Header name and value, or query key and value, for attaching a token to a request. */
export function tokenPlacement(auth: AuthOAuth2, token: TokenSet): { header: Header } | { query: [string, string] } {
	const value = auth.tokenConfig?.source === "id_token" ? (token.idToken ?? token.accessToken) : token.accessToken;
	const placement = auth.tokenConfig?.placement;
	if (placement && "query" in placement) return { query: [placement.query || "access_token", value] };
	const prefix = placement && "header" in placement ? placement.header : "Bearer";
	return { header: ["Authorization", prefix ? `${prefix} ${value}` : value] };
}

/** Some providers (e.g. GitHub without an Accept header) answer form-encoded instead of JSON. */
function parseTokenResponse(text: string): Record<string, unknown> {
	try {
		const json: unknown = JSON.parse(text);
		if (json && typeof json === "object") return json as Record<string, unknown>;
	} catch {
		// Fall through to form decoding.
	}
	return Object.fromEntries(new URLSearchParams(text));
}

function cacheKey(auth: TokenFlow): string {
	const username = auth.flow === "resource_owner_password_credentials" ? auth.resourceOwner?.username : undefined;
	const authorizationUrl = auth.flow === "authorization_code" ? auth.authorizationUrl : undefined;
	return JSON.stringify([auth.flow, auth.accessTokenUrl, auth.credentials?.clientId, auth.scope, username, authorizationUrl, auth.tokenConfig?.id]);
}
