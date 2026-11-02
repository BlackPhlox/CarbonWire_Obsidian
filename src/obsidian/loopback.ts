import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface LoopbackRedirect {
	/** `http://localhost:<port>` by default, which Entra accepts for any port. */
	redirectUri: string;
	/** Query parameters of the redirect: `code` on success, `error` otherwise. */
	params: Promise<URLSearchParams>;
	close(): void;
}

const page = (message: string) =>
	`<!doctype html><meta charset="utf-8"><title>CarbonWire</title><body style="font:16px system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0"><p>${message}</p></body>`;

/** Where an http://localhost, 127.0.0.1 or [::1] callback URL listens; undefined for other URLs. */
export function loopbackTarget(callbackUrl: string): { port: number; path: string } | undefined {
	let url: URL;
	try {
		url = new URL(callbackUrl);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
	return { port: url.port ? Number(url.port) : 80, path: url.pathname || "/" };
}

/**
 * Listens on a local port for the browser to come back from signing in: a free port unless
 * `callbackUrl` names one. Only a redirect carrying `expectedState` is accepted, so another page
 * can't plant a code.
 */
export async function listenForRedirect(expectedState: string, callbackUrl?: string): Promise<LoopbackRedirect> {
	const target = callbackUrl ? loopbackTarget(callbackUrl) : undefined;
	if (callbackUrl && !target) throw new Error(`CarbonWire can only receive the redirect at an http://localhost address, not ${callbackUrl}.`);
	const expectedPath = target?.path ?? "/";
	let resolve!: (params: URLSearchParams) => void;
	const params = new Promise<URLSearchParams>((r) => (resolve = r));

	const handler: http.RequestListener = (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const query = url.searchParams;
		if (url.pathname !== expectedPath || (!query.has("code") && !query.has("error"))) {
			res.writeHead(404).end();
			return;
		}
		const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
		if (query.get("state") !== expectedState) {
			res.writeHead(400, headers).end(page("This sign-in response doesn't match the one CarbonWire started. Start signing in again from Obsidian."));
			return;
		}
		const failed = query.has("error");
		res.writeHead(200, headers).end(page(failed ? "Sign-in didn't finish. Go back to Obsidian for details." : "Signed in. You can close this tab and go back to Obsidian."));
		resolve(query);
	};

	const v4 = http.createServer(handler);
	await new Promise<void>((done, fail) => {
		v4.once("error", fail);
		v4.listen(target?.port ?? 0, "127.0.0.1", () => done());
	});
	const { port } = v4.address() as AddressInfo;
	// Browsers may resolve localhost to ::1 first, so listen there too when IPv6 is available.
	const v6 = http.createServer(handler);
	v6.on("error", () => undefined);
	v6.listen(port, "::1");

	return {
		redirectUri: callbackUrl ?? `http://localhost:${port}`,
		params,
		close() {
			for (const server of [v4, v6]) {
				server.close(() => undefined);
				server.closeAllConnections();
			}
		},
	};
}
