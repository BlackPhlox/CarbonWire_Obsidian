import { createHash, randomBytes } from "node:crypto";
import type { Header } from "../model";
import type { Transport } from "../transport/types";

/**
 * Microsoft's public "Azure CLI" app. It is pre-authorized for Key Vault in every tenant and
 * allows http://localhost redirects, so signing in works without registering an app. The Azure
 * SDKs use it the same way for developer sign-in.
 */
export const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461d-bbee-02f9e1bf7b46";
export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com";
export const KEY_VAULT_SCOPE = "https://vault.azure.net/.default";
/** offline_access returns a refresh token; openid and profile return the account name. */
const SIGN_IN_SCOPES = "offline_access openid profile";

export interface EntraConfig {
	/** Tenant ID or domain, or "organizations" for any work or school account. */
	tenant: string;
	clientId: string;
	/** Login host, for sovereign clouds and tests. */
	authority?: string;
	rejectUnauthorized: boolean;
}

export interface EntraTokens {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	/** Epoch milliseconds. */
	expiresAt: number;
}

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	message: string;
	/** Seconds between polls. */
	interval: number;
	/** Epoch milliseconds. */
	expiresAt: number;
}

export class EntraError extends Error {
	constructor(message: string, readonly code?: string) {
		super(message);
		this.name = "EntraError";
	}
}

export function endpointBase(config: EntraConfig): string {
	const authority = (config.authority || DEFAULT_AUTHORITY).replace(/\/+$/, "");
	return `${authority}/${encodeURIComponent(config.tenant.trim() || "organizations")}/oauth2/v2.0`;
}

/** Scope string for a resource scope plus what sign-in needs. */
export function signInScope(resourceScope: string): string {
	return `${resourceScope} ${SIGN_IN_SCOPES}`;
}

/** RFC 7636 proof key; the verifier stays here and only its hash goes to the browser. */
export function createPkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function randomState(): string {
	return randomBytes(16).toString("base64url");
}

export function authorizeUrl(config: EntraConfig, options: { redirectUri: string; challenge: string; state: string; scope: string }): string {
	const url = new URL(`${endpointBase(config)}/authorize`);
	url.search = new URLSearchParams({
		client_id: config.clientId,
		response_type: "code",
		response_mode: "query",
		redirect_uri: options.redirectUri,
		scope: options.scope,
		code_challenge: options.challenge,
		code_challenge_method: "S256",
		state: options.state,
		prompt: "select_account",
	}).toString();
	return url.toString();
}

/** The signed-in user's name from an ID token. The token is only read, not verified: it is shown, never trusted. */
export function accountName(idToken: string | undefined): string | undefined {
	const payload = idToken?.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
		for (const key of ["preferred_username", "upn", "email", "name"]) {
			if (typeof claims[key] === "string" && claims[key]) return claims[key];
		}
	} catch {
		// Not a JWT; no name to show.
	}
	return undefined;
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new EntraError("Sign-in was cancelled.", "cancelled"));
		const timer = window.setTimeout(done, ms);
		function done() {
			signal?.removeEventListener("abort", abort);
			resolve();
		}
		function abort() {
			window.clearTimeout(timer);
			reject(new EntraError("Sign-in was cancelled.", "cancelled"));
		}
		signal?.addEventListener("abort", abort, { once: true });
	});

/** Talks to the Microsoft identity platform's v2.0 endpoints as a public client: no client secret. */
export class EntraClient {
	constructor(private readonly transport: Transport, private readonly config: () => EntraConfig) {}

	redeemCode(code: string, verifier: string, redirectUri: string, scope: string, signal?: AbortSignal): Promise<EntraTokens> {
		return this.token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, scope }, signal);
	}

	refresh(refreshToken: string, scope: string, signal?: AbortSignal): Promise<EntraTokens> {
		return this.token({ grant_type: "refresh_token", refresh_token: refreshToken, scope }, signal);
	}

	async startDeviceCode(scope: string, signal?: AbortSignal): Promise<DeviceCode> {
		const { status, data } = await this.post("devicecode", { scope }, signal);
		if (status >= 400 || typeof data.device_code !== "string" || typeof data.user_code !== "string") throw errorFrom(status, data);
		const interval = Number(data.interval);
		const expiresIn = Number(data.expires_in);
		return {
			deviceCode: data.device_code,
			userCode: data.user_code,
			verificationUri: typeof data.verification_uri === "string" ? data.verification_uri : "https://microsoft.com/devicelogin",
			message: typeof data.message === "string" ? data.message : "",
			interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
			expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000,
		};
	}

	/** Polls until the user finishes on the device code page, it expires, or `signal` aborts. */
	async pollDeviceCode(code: DeviceCode, signal?: AbortSignal): Promise<EntraTokens> {
		let interval = code.interval;
		while (Date.now() < code.expiresAt) {
			await sleep(interval * 1000, signal);
			try {
				return await this.token({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.deviceCode }, signal);
			} catch (e) {
				if (!(e instanceof EntraError)) throw e;
				if (e.code === "authorization_pending") continue;
				if (e.code === "slow_down") {
					interval += 5;
					continue;
				}
				throw e;
			}
		}
		throw new EntraError("The sign-in code expired. Start again.", "expired_token");
	}

	private async token(form: Record<string, string>, signal?: AbortSignal): Promise<EntraTokens> {
		const { status, data } = await this.post("token", form, signal);
		if (status >= 400 || typeof data.access_token !== "string") throw errorFrom(status, data);
		const expiresIn = Number(data.expires_in);
		return {
			accessToken: data.access_token,
			refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
			idToken: typeof data.id_token === "string" ? data.id_token : undefined,
			expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
		};
	}

	/**
	 * Goes through Node's HTTP stack, which sends no Origin header. Entra only redeems codes for
	 * this kind of app when the request doesn't look like it came from a web page.
	 */
	private async post(endpoint: "token" | "devicecode", fields: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; data: Record<string, unknown> }> {
		const config = this.config();
		const form = new URLSearchParams({ client_id: config.clientId, ...fields });
		const headers: Header[] = [
			["Content-Type", "application/x-www-form-urlencoded"],
			["Accept", "application/json"],
		];
		const response = await this.transport.send({
			method: "POST",
			url: `${endpointBase(config)}/${endpoint}`,
			headers,
			body: new TextEncoder().encode(form.toString()),
			timeoutMs: 30_000,
			followRedirects: false,
			maxRedirects: 0,
			forwardAuthorizationHeader: false,
			rejectUnauthorized: config.rejectUnauthorized,
			maxBodyBytes: 1_000_000,
			signal,
		});
		const text = new TextDecoder().decode(response.body);
		let data: Record<string, unknown> = {};
		try {
			const json: unknown = JSON.parse(text);
			if (json && typeof json === "object") data = json as Record<string, unknown>;
		} catch {
			data = { error_description: text.slice(0, 200) };
		}
		return { status: response.status, data };
	}
}

function errorFrom(status: number, data: Record<string, unknown>): EntraError {
	const code = typeof data.error === "string" ? data.error : undefined;
	// Entra puts trace and correlation IDs on later lines; the first line is the readable part.
	const description = typeof data.error_description === "string" ? data.error_description.split(/\r?\n/)[0] : undefined;
	return new EntraError(`Microsoft sign-in failed (${status}): ${description || code || "unexpected response"}`, code);
}
