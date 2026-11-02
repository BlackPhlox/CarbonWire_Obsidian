import type { OAuth2AuthorizationCodeFlow } from "@opencollection/types/common/auth-oauth2";
import { createHash } from "node:crypto";
import * as http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { authorizationUrl, OAuth2Tokens, pkceFor, type Authorizer } from "../src/core/auth/oauth2";
import type { Transport, TransportRequest, TransportResponse } from "../src/core/transport/types";
import { listenForRedirect, loopbackTarget } from "../src/obsidian/loopback";

const auth: OAuth2AuthorizationCodeFlow = {
	type: "oauth2",
	flow: "authorization_code",
	authorizationUrl: "https://id.example.com/authorize?audience=api",
	accessTokenUrl: "https://id.example.com/token",
	credentials: { clientId: "spa-client" },
	scope: "openid offline_access",
	additionalParameters: { authorizationRequest: [{ name: "prompt", value: "login", placement: "query" }] },
};

function tokenServer(respond: (form: URLSearchParams, n: number) => object): Transport & { forms: URLSearchParams[]; requests: TransportRequest[] } {
	const forms: URLSearchParams[] = [];
	const requests: TransportRequest[] = [];
	return {
		forms,
		requests,
		send(request) {
			requests.push(request);
			const form = new URLSearchParams(new TextDecoder().decode(request.body));
			forms.push(form);
			const bytes = new TextEncoder().encode(JSON.stringify(respond(form, forms.length)));
			return Promise.resolve({ url: request.url, status: 200, statusText: "OK", httpVersion: "1.1", headers: [], body: bytes, bodyBytes: bytes.length, truncated: false, timings: { dns: 0, connect: 0, tls: 0, wait: 0, download: 0, total: 0, reusedConnection: false }, redirects: [] } satisfies TransportResponse);
		},
		dispose() {},
	};
}

describe("authorization code flow", () => {
	it("builds the authorization URL with PKCE, keeping the URL's own parameters", () => {
		const pkce = pkceFor(auth)!;
		expect(pkce.method).toBe("S256");
		expect(createHash("sha256").update(pkce.verifier).digest("base64url")).toBe(pkce.challenge);
		const url = new URL(authorizationUrl(auth, { redirectUri: "http://localhost:5000/cb", state: "st", pkce }));
		expect(Object.fromEntries(url.searchParams)).toEqual({
			audience: "api",
			response_type: "code",
			client_id: "spa-client",
			redirect_uri: "http://localhost:5000/cb",
			scope: "openid offline_access",
			state: "st",
			code_challenge: pkce.challenge,
			code_challenge_method: "S256",
			prompt: "login",
		});
		expect(pkceFor({ ...auth, pkce: { disabled: true } })).toBeUndefined();
		expect(pkceFor({ ...auth, pkce: { method: "plain" } })).toMatchObject({ method: "plain" });
	});

	it("exchanges the code as a public client, once for concurrent requests, then refreshes", async () => {
		const server = tokenServer((form, n) => ({ access_token: `at${n}`, refresh_token: n === 1 ? "rt1" : undefined, expires_in: n === 1 ? 1 : 3600 }));
		const authorize = vi.fn<Authorizer>(() => Promise.resolve({ code: "c0de", redirectUri: "http://localhost:5000/cb", codeVerifier: "ver" }));
		const tokens = new OAuth2Tokens(server, authorize);
		const options = { rejectUnauthorized: true };

		const [a, b] = await Promise.all([tokens.token(auth, options), tokens.token(auth, options)]);
		expect([a.accessToken, b.accessToken]).toEqual(["at1", "at1"]);
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(Object.fromEntries(server.forms[0]!)).toEqual({ grant_type: "authorization_code", code: "c0de", redirect_uri: "http://localhost:5000/cb", code_verifier: "ver", client_id: "spa-client" });
		expect(server.requests[0]!.headers.some(([n]) => n === "Authorization")).toBe(false);

		// The first token expires within the skew, so the next send refreshes without the browser.
		const refreshed = await tokens.token(auth, options);
		expect(refreshed.accessToken).toBe("at2");
		expect(Object.fromEntries(server.forms[1]!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt1" });
		expect(refreshed.refreshToken).toBe("rt1");
		expect(authorize).toHaveBeenCalledTimes(1);
	});

	it("uses Basic auth for a confidential client", async () => {
		const server = tokenServer(() => ({ access_token: "at", expires_in: 3600 }));
		const tokens = new OAuth2Tokens(server, () => Promise.resolve({ code: "c", redirectUri: "http://localhost/cb" }));
		await tokens.token({ ...auth, credentials: { clientId: "web", clientSecret: "s3" } }, { rejectUnauthorized: true });
		expect(server.requests[0]!.headers).toContainEqual(["Authorization", `Basic ${Buffer.from("web:s3").toString("base64")}`]);
		expect(server.forms[0]!.has("client_id")).toBe(false);
	});

	it("explains a missing browser or authorization URL", async () => {
		const server = tokenServer(() => ({}));
		await expect(new OAuth2Tokens(server).token(auth, { rejectUnauthorized: true })).rejects.toThrow("needs a browser");
		expect(() => authorizationUrl({ ...auth, authorizationUrl: "" }, { redirectUri: "x", state: "s" })).toThrow("authorization URL is empty");
	});
});

describe("callback URLs", () => {
	it("listens only on localhost addresses", () => {
		expect(loopbackTarget("http://localhost:5000/callback")).toEqual({ port: 5000, path: "/callback" });
		expect(loopbackTarget("http://127.0.0.1:8080")).toEqual({ port: 8080, path: "/" });
		expect(loopbackTarget("https://oauth.pstmn.io/v1/callback")).toBeUndefined();
		expect(loopbackTarget("https://localhost:5000")).toBeUndefined();
	});

	it("receives the code on the registered port and path", async () => {
		const probe = http.createServer();
		await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
		const port = (probe.address() as { port: number }).port;
		await new Promise<void>((r) => probe.close(() => r()));

		const redirect = await listenForRedirect("st", `http://localhost:${port}/oauth/callback`);
		try {
			expect(redirect.redirectUri).toBe(`http://localhost:${port}/oauth/callback`);
			const status = (path: string) => new Promise<number>((resolve) => http.get(`http://127.0.0.1:${port}${path}`, (res) => (res.resume(), resolve(res.statusCode ?? 0))));
			expect(await status("/?code=x&state=st")).toBe(404);
			expect(await status("/oauth/callback?code=x&state=st")).toBe(200);
			expect((await redirect.params).get("code")).toBe("x");
		} finally {
			redirect.close();
		}
	});
});
