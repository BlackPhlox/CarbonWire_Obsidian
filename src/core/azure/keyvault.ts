import type { DefaultsChain, HttpRequest } from "../model";
import type { Transport } from "../transport/types";
import { interpolateDeep, type Scope } from "../variables";

/** `{{$keyvault:vault/secret}}`, `{{$keyvault:vault/secret/version}}` or, with a default vault, `{{$keyvault:secret}}`. */
export const KEY_VAULT_PREFIX = "$keyvault:";
const API_VERSION = "7.5";
const REFERENCE = /\{\{\s*(\$keyvault:[^{}]+?)\s*\}\}/g;
const SECRET_NAME = /^[0-9A-Za-z-]{1,127}$/;
const VAULT_NAME = /^[0-9A-Za-z-]{3,24}$/;

export interface KeyVaultRef {
	/** A vault name, such as "contoso", or a host, such as "contoso.vault.azure.cn". */
	vault: string;
	name: string;
	version?: string;
}

export class KeyVaultError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = "KeyVaultError";
	}
}

export function isKeyVaultVariable(name: string): boolean {
	return name.startsWith(KEY_VAULT_PREFIX);
}

/**
 * Reads a variable name such as `$keyvault:contoso/db-password`. Also accepts a secret
 * identifier URL, as the Azure portal shows it. Returns undefined when it isn't valid.
 */
export function parseKeyVaultReference(variable: string, defaultVault = ""): KeyVaultRef | undefined {
	if (!isKeyVaultVariable(variable)) return undefined;
	const body = variable.slice(KEY_VAULT_PREFIX.length).trim();
	let vault: string;
	let parts: string[];
	if (/^https:\/\//i.test(body)) {
		let url: URL;
		try {
			url = new URL(body);
		} catch {
			return undefined;
		}
		const path = url.pathname.split("/").filter(Boolean);
		if (path[0] !== "secrets") return undefined;
		vault = url.host;
		parts = path.slice(1);
	} else {
		const path = body.split("/").map((p) => p.trim());
		if (path.length === 1) {
			vault = defaultVault.trim();
			parts = path;
		} else {
			vault = path[0]!;
			parts = path.slice(1);
		}
	}
	const [name, version, ...rest] = parts;
	if (!vault || !name || rest.length || !SECRET_NAME.test(name)) return undefined;
	if (!vault.includes(".") && !VAULT_NAME.test(vault)) return undefined;
	if (version !== undefined && !/^[0-9A-Za-z]+$/.test(version)) return undefined;
	return version ? { vault, name, version } : { vault, name };
}

/** `https://contoso.vault.azure.net` for a bare name; a host or URL is kept as given. */
export function vaultUrl(vault: string): string {
	const trimmed = vault.trim().replace(/\/+$/, "");
	if (/^https:\/\//i.test(trimmed)) return trimmed;
	return trimmed.includes(".") ? `https://${trimmed}` : `https://${trimmed}.vault.azure.net`;
}

/** Every `$keyvault:` variable referenced in a JSON-like value, such as a request or its defaults. */
export function keyVaultVariables(value: unknown, out = new Set<string>()): Set<string> {
	if (typeof value === "string") {
		if (value.includes(KEY_VAULT_PREFIX)) for (const m of value.matchAll(REFERENCE)) out.add(m[1]!);
	} else if (Array.isArray(value)) {
		for (const v of value) keyVaultVariables(v, out);
	} else if (value !== null && typeof value === "object") {
		for (const v of Object.values(value)) keyVaultVariables(v, out);
	}
	return out;
}

/**
 * The references a request uses, written in it, in the headers and auth it inherits, or in a
 * variable it uses, such as an environment's `dbPassword: {{$keyvault:contoso/db}}`. Variables
 * that are defined but not used aren't fetched.
 */
export function usedKeyVaultVariables(request: HttpRequest, chain: DefaultsChain, scope: Scope): Set<string> {
	const { runtime, ...rest } = request;
	const own = runtime ? { ...rest, runtime: { ...runtime, variables: undefined } } : rest;
	const inherited = chain.map((d) => ({ headers: d?.headers, auth: d?.auth }));
	return keyVaultVariables(interpolateDeep([own, inherited], scope));
}

export interface KeyVaultOptions {
	rejectUnauthorized: boolean;
	/** How long fetched values are kept in memory; 0 fetches every time. */
	cacheMs: number;
}

/** Reads secrets with the Key Vault REST API, keeping values in memory only. */
export class KeyVaultClient {
	private readonly cache = new Map<string, { value: string; expires: number }>();

	constructor(
		private readonly transport: Transport,
		private readonly accessToken: (signal?: AbortSignal) => Promise<string>,
		private readonly options: () => KeyVaultOptions,
	) {}

	clear(): void {
		this.cache.clear();
	}

	async getSecret(ref: KeyVaultRef, signal?: AbortSignal): Promise<string> {
		const url = `${vaultUrl(ref.vault)}/secrets/${encodeURIComponent(ref.name)}${ref.version ? `/${encodeURIComponent(ref.version)}` : ""}?api-version=${API_VERSION}`;
		const cached = this.cache.get(url);
		if (cached && cached.expires > Date.now()) return cached.value;
		const data = await this.get(url, `secret "${ref.name}" in ${ref.vault}`, signal);
		if (typeof data.value !== "string") throw new KeyVaultError(`Key Vault returned no value for secret "${ref.name}".`);
		const { cacheMs } = this.options();
		if (cacheMs > 0) this.cache.set(url, { value: data.value, expires: Date.now() + cacheMs });
		else this.cache.delete(url);
		return data.value;
	}

	/** Names of the enabled secrets in a vault, sorted. Values aren't fetched. */
	async listSecrets(vault: string, signal?: AbortSignal): Promise<string[]> {
		const base = vaultUrl(vault);
		const names: string[] = [];
		let next: string | undefined = `${base}/secrets?api-version=${API_VERSION}&maxresults=25`;
		for (let page = 0; next && page < 200; page++) {
			// Only follow paging links back to the same vault, so the token never goes elsewhere.
			if (new URL(next).origin !== new URL(base).origin) break;
			const data = await this.get(next, `secrets in ${vault}`, signal);
			for (const item of Array.isArray(data.value) ? (data.value as unknown[]) : []) {
				const entry = item as { id?: unknown; attributes?: { enabled?: unknown }; contentType?: unknown };
				if (typeof entry.id !== "string" || entry.attributes?.enabled === false) continue;
				// Certificates also show up as secrets; their key material isn't something to paste into a request.
				if (entry.contentType === "application/x-pkcs12" || entry.contentType === "application/x-pem-file") continue;
				const name = entry.id.split("/").pop();
				if (name) names.push(name);
			}
			next = typeof data.nextLink === "string" ? data.nextLink : undefined;
		}
		return names.sort((a, b) => a.localeCompare(b));
	}

	/** Fetches every reference, in parallel, keyed by its variable name. */
	async resolve(variables: Iterable<string>, defaultVault: string, signal?: AbortSignal): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		await Promise.all(
			[...new Set(variables)].map(async (variable) => {
				const ref = parseKeyVaultReference(variable, defaultVault);
				if (!ref) {
					const hint = variable.includes("/") ? "" : " Set a default vault in CarbonWire settings, or write {{$keyvault:vault/secret}}.";
					throw new KeyVaultError(`"{{${variable}}}" isn't a valid Key Vault reference.${hint}`);
				}
				out.set(variable, await this.getSecret(ref, signal));
			}),
		);
		return out;
	}

	private async get(url: string, what: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const token = await this.accessToken(signal);
		const response = await this.transport.send({
			method: "GET",
			url,
			headers: [
				["Authorization", `Bearer ${token}`],
				["Accept", "application/json"],
			],
			timeoutMs: 30_000,
			followRedirects: false,
			maxRedirects: 0,
			forwardAuthorizationHeader: false,
			rejectUnauthorized: this.options().rejectUnauthorized,
			maxBodyBytes: 5_000_000,
			signal,
		});
		const text = new TextDecoder().decode(response.body);
		let data: Record<string, unknown> = {};
		try {
			const json: unknown = JSON.parse(text);
			if (json && typeof json === "object") data = json as Record<string, unknown>;
		} catch {
			// Reported below with the status.
		}
		if (response.status >= 400) {
			const error = data.error as { message?: unknown } | undefined;
			const detail = typeof error?.message === "string" ? error.message : text.slice(0, 200) || response.statusText;
			const hint =
				response.status === 403
					? " Your account needs the Key Vault Secrets User role, or a Get/List secret access policy, on this vault."
					: response.status === 404
						? " Check the vault and secret names."
						: "";
			throw new KeyVaultError(`Couldn't read ${what} (${response.status}): ${detail}${hint}`, response.status);
		}
		return data;
	}
}
