import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface LoopbackRedirect {
	/** `http://localhost:<port>`, which Entra accepts for any port. */
	redirectUri: string;
	/** Query parameters of the redirect: `code` on success, `error` otherwise. */
	params: Promise<URLSearchParams>;
	close(): void;
}

const page = (message: string) =>
	`<!doctype html><meta charset="utf-8"><title>CarbonWire</title><body style="font:16px system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0"><p>${message}</p></body>`;

/**
 * Listens on a free local port for the browser to come back from Microsoft sign-in. Only a
 * redirect carrying `expectedState` is accepted, so another page can't plant a code.
 */
export async function listenForRedirect(expectedState: string): Promise<LoopbackRedirect> {
	let resolve!: (params: URLSearchParams) => void;
	const params = new Promise<URLSearchParams>((r) => (resolve = r));

	const handler: http.RequestListener = (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const query = url.searchParams;
		if (url.pathname !== "/" || (!query.has("code") && !query.has("error"))) {
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
		v4.listen(0, "127.0.0.1", () => done());
	});
	const { port } = v4.address() as AddressInfo;
	// Browsers may resolve localhost to ::1 first, so listen there too when IPv6 is available.
	const v6 = http.createServer(handler);
	v6.on("error", () => undefined);
	v6.listen(port, "::1");

	return {
		redirectUri: `http://localhost:${port}`,
		params,
		close() {
			for (const server of [v4, v6]) {
				server.close(() => undefined);
				server.closeAllConnections();
			}
		},
	};
}
