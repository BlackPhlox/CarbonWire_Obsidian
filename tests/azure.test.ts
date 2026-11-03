import { createHash } from "node:crypto";
import * as http from "node:http";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { accountName, authorizeUrl, AZURE_CLI_CLIENT_ID, createPkce, EntraClient, EntraError, endpointBase, KEY_VAULT_SCOPE, signInScope, type EntraConfig } from "../src/core/azure/entra";
import { defaultVault, keyVaultVariables, KeyVaultClient, parseKeyVaultReference, usedKeyVaultVariables, vaultUrl } from "../src/core/azure/keyvault";
import type { HttpRequest } from "../src/core/model";
import { buildRequest } from "../src/core/request-builder";
import type { Transport, TransportRequest, TransportResponse } from "../src/core/transport/types";
import { isDynamicVariable } from "../src/core/variables";
import { listenForRedirect } from "../src/obsidian/loopback";

beforeAll(() => {
	// The plugin uses window timers for popout windows; Node's timers stand in.
	vi.stubGlobal("window", { setTimeout, clearTimeout });
});

type Handler = (request: TransportRequest, body: URLSearchParams) => { status?: number; json: unknown };

/** Answers requests from a handler and records them, without any network. */
function fakeTransport(handler: Handler): Transport & { requests: TransportRequest[] } {
	const requests: TransportRequest[] = [];
	return {
		requests,
		send(request) {
			requests.push(request);
			const body = new URLSearchParams(request.body ? new TextDecoder().decode(request.body) : "");
			const { status = 200, json } = handler(request, body);
			const bytes = new TextEncoder().encode(JSON.stringify(json));
			const response: TransportResponse = {
				url: request.url,
				status,
				statusText: "",
				httpVersion: "1.1",
				headers: [],
				body: bytes,
				bodyBytes: bytes.byteLength,
				truncated: false,
				timings: { dns: 0, connect: 0, tls: 0, wait: 0, download: 0, total: 0, reusedConnection: false },
				redirects: [],
			};
			return Promise.resolve(response);
		},
		dispose() {},
	};
}

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const config: EntraConfig = { tenant: "contoso.onmicrosoft.com", clientId: AZURE_CLI_CLIENT_ID, rejectUnauthorized: true };

describe("Key Vault references", () => {
	it("parses vault/secret, versions, URLs and the default vault", () => {
		expect(parseKeyVaultReference("$keyvault:contoso/db-password")).toEqual({ vault: "contoso", name: "db-password" });
		expect(parseKeyVaultReference("$keyvault:contoso/db/0123abcd")).toEqual({ vault: "contoso", name: "db", version: "0123abcd" });
		expect(parseKeyVaultReference("$keyvault:api-key", "contoso")).toEqual({ vault: "contoso", name: "api-key" });
		expect(parseKeyVaultReference("$keyvault:https://contoso.vault.azure.cn/secrets/db/v1")).toEqual({ vault: "contoso.vault.azure.cn", name: "db", version: "v1" });
		expect(parseKeyVaultReference("$keyvault:contoso.vault.usgovcloudapi.net/db")).toEqual({ vault: "contoso.vault.usgovcloudapi.net", name: "db" });
	});

	it("rejects references it can't use", () => {
		expect(parseKeyVaultReference("$keyvault:api-key")).toBeUndefined();
		expect(parseKeyVaultReference("$keyvault:contoso/bad_name")).toBeUndefined();
		expect(parseKeyVaultReference("$keyvault:ab/secret")).toBeUndefined();
		expect(parseKeyVaultReference("$keyvault:contoso/a/b/c")).toBeUndefined();
		expect(parseKeyVaultReference("$keyvault:https://contoso.vault.azure.net/keys/k")).toBeUndefined();
		expect(parseKeyVaultReference("apiKey")).toBeUndefined();
	});

	it("prefers the active environment's default vault over the one in settings", () => {
		expect(defaultVault({ keyVault: " contoso-dev " }, "contoso")).toBe("contoso-dev");
		expect(defaultVault({ keyVault: "" }, "contoso")).toBe("contoso");
		expect(defaultVault({}, " contoso ")).toBe("contoso");
		expect(defaultVault(undefined, "")).toBe("");
		expect(parseKeyVaultReference("$keyvault:api-key", defaultVault({ keyVault: "contoso-prod" }, "contoso"))).toEqual({ vault: "contoso-prod", name: "api-key" });
	});

	it("builds vault URLs", () => {
		expect(vaultUrl("contoso")).toBe("https://contoso.vault.azure.net");
		expect(vaultUrl("contoso.vault.azure.cn")).toBe("https://contoso.vault.azure.cn");
		expect(vaultUrl("https://contoso.vault.azure.net/")).toBe("https://contoso.vault.azure.net");
	});

	it("counts as a defined variable for highlighting", () => {
		expect(isDynamicVariable("$keyvault:contoso/db")).toBe(true);
		expect(isDynamicVariable("db")).toBe(false);
	});

	it("finds references anywhere in a request", () => {
		const found = keyVaultVariables({ http: { url: "https://x/{{ $keyvault:v1/a }}", headers: [{ name: "X", value: "{{$keyvault:b}}" }] } });
		expect([...found]).toEqual(["$keyvault:v1/a", "$keyvault:b"]);
	});

	it("only fetches references the request uses, including through variables and inherited auth", () => {
		const request: HttpRequest = {
			http: { method: "GET", url: "https://api/{{path}}", headers: [{ name: "X-Key", value: "{{apiKey}}" }] },
			runtime: { variables: [{ name: "unusedHere", value: "{{$keyvault:contoso/unused-request}}" }] },
		};
		const chain = [{ auth: { type: "bearer" as const, token: "{{$keyvault:contoso/token}}" }, variables: [{ name: "x", value: "{{$keyvault:contoso/unused-folder}}" }] }];
		const scope = new Map([
			["apiKey", "{{$keyvault:contoso/api-key}}"],
			["path", "v1"],
			["other", "{{$keyvault:contoso/unused-env}}"],
		]);
		expect([...usedKeyVaultVariables(request, chain, scope)].sort()).toEqual(["$keyvault:contoso/api-key", "$keyvault:contoso/token"]);
	});
});

describe("KeyVaultClient", () => {
	const secrets: Record<string, string> = { "db-password": "hunter2", "api-key": "k-123" };
	function vault() {
		const transport = fakeTransport((request) => {
			const url = new URL(request.url);
			if (request.headers.find(([n]) => n === "Authorization")?.[1] !== "Bearer at") return { status: 401, json: { error: { message: "Unauthorized" } } };
			if (url.pathname === "/secrets") {
				if (!url.searchParams.has("page")) {
					return { json: { value: [{ id: `${url.origin}/secrets/db-password`, attributes: { enabled: true } }, { id: `${url.origin}/secrets/old`, attributes: { enabled: false } }], nextLink: `${url.origin}/secrets?page=2` } };
				}
				return { json: { value: [{ id: `${url.origin}/secrets/api-key`, attributes: { enabled: true } }, { id: `${url.origin}/secrets/cert`, contentType: "application/x-pkcs12" }], nextLink: "https://evil.example/secrets" } };
			}
			const name = url.pathname.split("/")[2]!;
			if (url.pathname.endsWith("/forbidden")) return { status: 403, json: { error: { message: "Caller is not authorized." } } };
			if (!(name in secrets)) return { status: 404, json: { error: { message: `A secret with (name/id) ${name} was not found in this key vault.` } } };
			return { json: { value: secrets[name], id: request.url } };
		});
		const token = vi.fn(() => Promise.resolve("at"));
		const client = new KeyVaultClient(transport, token, () => ({ rejectUnauthorized: true, cacheMs: 60_000 }));
		return { client, transport, token };
	}

	it("fetches a secret with a bearer token and caches it", async () => {
		const { client, transport } = vault();
		expect(await client.getSecret({ vault: "contoso", name: "db-password" })).toBe("hunter2");
		expect(await client.getSecret({ vault: "contoso", name: "db-password" })).toBe("hunter2");
		expect(transport.requests).toHaveLength(1);
		expect(transport.requests[0]!.url).toBe("https://contoso.vault.azure.net/secrets/db-password?api-version=7.5");
		expect(transport.requests[0]!.followRedirects).toBe(false);
		client.clear();
		await client.getSecret({ vault: "contoso", name: "db-password" });
		expect(transport.requests).toHaveLength(2);
	});

	it("resolves references into a scope that interpolates like any variable", async () => {
		const { client } = vault();
		const secretsByName = await client.resolve(["$keyvault:contoso/db-password", "$keyvault:api-key"], "contoso");
		const scope = new Map([["password", "{{$keyvault:contoso/db-password}}"], ...secretsByName]);
		const resolved = buildRequest({ http: { method: "GET", url: "https://api/?p={{password}}&k={{$keyvault:api-key}}" } }, [], scope);
		expect(resolved.url).toBe("https://api/?p=hunter2&k=k-123");
	});

	it("explains missing defaults, permissions and names", async () => {
		const { client } = vault();
		await expect(client.resolve(["$keyvault:api-key"], "")).rejects.toThrow("Set a default vault");
		await expect(client.getSecret({ vault: "contoso", name: "forbidden" })).rejects.toThrow("Key Vault Secrets User");
		await expect(client.getSecret({ vault: "contoso", name: "nope" })).rejects.toThrow("(404)");
	});

	it("lists enabled secrets across pages without following links to other hosts", async () => {
		const { client, transport } = vault();
		expect(await client.listSecrets("contoso")).toEqual(["api-key", "db-password"]);
		expect(transport.requests.every((r) => r.url.startsWith("https://contoso.vault.azure.net/"))).toBe(true);
	});
});

describe("Entra ID", () => {
	it("builds a PKCE authorize URL for the tenant", () => {
		const { verifier, challenge } = createPkce();
		expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
		const url = new URL(authorizeUrl(config, { redirectUri: "http://localhost:1234", challenge, state: "st", scope: signInScope(KEY_VAULT_SCOPE) }));
		expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("scope")).toBe("https://vault.azure.net/.default offline_access openid profile");
		expect(endpointBase({ ...config, tenant: " " })).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0");
	});

	it("reads the account name from an ID token", () => {
		expect(accountName(jwt({ name: "Ada", preferred_username: "ada@contoso.com" }))).toBe("ada@contoso.com");
		expect(accountName("not-a-token")).toBeUndefined();
	});

	it("redeems a code and refreshes as a public client", async () => {
		const transport = fakeTransport((request, body) => {
			expect(request.url).toBe("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token");
			expect(body.get("client_id")).toBe(AZURE_CLI_CLIENT_ID);
			expect(body.has("client_secret")).toBe(false);
			if (body.get("grant_type") === "refresh_token" && body.get("refresh_token") === "revoked") {
				return { status: 400, json: { error: "invalid_grant", error_description: "AADSTS70008: The refresh token has expired.\r\nTrace ID: 1" } };
			}
			return { json: { access_token: `at-${body.get("grant_type")}`, refresh_token: "rt2", id_token: jwt({ preferred_username: "ada@contoso.com" }), expires_in: 3599 } };
		});
		const client = new EntraClient(transport, () => config);
		const tokens = await client.redeemCode("c0de", "verifier", "http://localhost:1234", "scope");
		expect(tokens.accessToken).toBe("at-authorization_code");
		expect(tokens.refreshToken).toBe("rt2");
		expect(new URLSearchParams(new TextDecoder().decode(transport.requests[0]!.body)).get("code_verifier")).toBe("verifier");
		expect((await client.refresh("rt2", "scope")).accessToken).toBe("at-refresh_token");
		const error = await client.refresh("revoked", "scope").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(EntraError);
		expect((error as EntraError).code).toBe("invalid_grant");
		expect((error as EntraError).message).toBe("Microsoft sign-in failed (400): AADSTS70008: The refresh token has expired.");
	});

	it("polls a device code until the user finishes", async () => {
		let polls = 0;
		const transport = fakeTransport((request, body) => {
			if (request.url.endsWith("/devicecode")) {
				return { json: { device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://microsoft.com/devicelogin", interval: 0.01, expires_in: 900 } };
			}
			expect(body.get("device_code")).toBe("dc");
			polls++;
			if (polls === 1) return { status: 400, json: { error: "authorization_pending" } };
			return { json: { access_token: "at", expires_in: 3600 } };
		});
		const client = new EntraClient(transport, () => config);
		const code = await client.startDeviceCode("scope");
		expect(code.userCode).toBe("ABCD-EFGH");
		expect((await client.pollDeviceCode(code)).accessToken).toBe("at");
		expect(polls).toBe(2);

		const controller = new AbortController();
		const pending = client.pollDeviceCode({ ...code, interval: 10 }, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("cancelled");
	});
});

const statusOf = (url: string) =>
	new Promise<number>((resolve, reject) => {
		http.get(url, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		}).on("error", reject);
	});

describe("listenForRedirect", () => {
	it("accepts the redirect with the right state and rejects others", async () => {
		const redirect = await listenForRedirect("good");
		try {
			expect(redirect.redirectUri).toMatch(/^http:\/\/localhost:\d+$/);
			const port = new URL(redirect.redirectUri).port;
			expect(await statusOf(`http://127.0.0.1:${port}/?code=evil&state=bad`)).toBe(400);
			expect(await statusOf(`http://127.0.0.1:${port}/favicon.ico`)).toBe(404);
			expect(await statusOf(`http://127.0.0.1:${port}/?code=c0de&state=good`)).toBe(200);
			expect((await redirect.params).get("code")).toBe("c0de");
		} finally {
			redirect.close();
		}
	});
});
