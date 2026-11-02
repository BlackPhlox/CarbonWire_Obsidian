import type { OAuth2AuthorizationCodeFlow } from "@opencollection/types/common/auth-oauth2";
import { randomBytes } from "node:crypto";
import { Modal, Setting, type App } from "obsidian";
import { authorizationUrl, OAuth2Error, pkceFor, type AuthorizationResult, type Authorizer } from "../core/auth/oauth2";
import { listenForRedirect, loopbackTarget, type LoopbackRedirect } from "../obsidian/loopback";

/** Reads `code` or `error` from a redirect's query, checking it belongs to this attempt. */
export function readRedirect(params: URLSearchParams, state: string): string {
	const error = params.get("error");
	if (error) throw new OAuth2Error(`Authorization failed: ${params.get("error_description")?.split(/\r?\n/)[0] || error}`);
	if (params.get("state") !== state) throw new OAuth2Error("That redirect belongs to a different sign-in. Start again.");
	const code = params.get("code");
	if (!code) throw new OAuth2Error("The redirect has no authorization code.");
	return code;
}

/**
 * Opens the authorization URL in the browser and waits for the code: on a localhost callback
 * it arrives by itself; for any other callback URL, the user pastes the address they end up on.
 */
class AuthorizeModal extends Modal {
	readonly result: Promise<AuthorizationResult>;
	private resolve!: (result: AuthorizationResult) => void;
	private reject!: (error: Error) => void;
	private settled = false;
	private redirect?: LoopbackRedirect;

	constructor(app: App, private readonly auth: OAuth2AuthorizationCodeFlow, private readonly signal?: AbortSignal) {
		super(app);
		this.result = new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
		signal?.addEventListener("abort", () => this.fail(new OAuth2Error("Authorization was cancelled.")), { once: true });
	}

	override onOpen(): void {
		this.setTitle("Authorize with OAuth 2.0");
		void this.start();
	}

	override onClose(): void {
		this.redirect?.close();
		this.contentEl.empty();
		this.fail(new OAuth2Error("Authorization was cancelled."), false);
	}

	private async start(): Promise<void> {
		try {
			const state = randomBytes(16).toString("base64url");
			const pkce = pkceFor(this.auth);
			const callback = this.auth.callbackUrl?.trim() || undefined;
			const listens = !callback || loopbackTarget(callback) !== undefined;
			if (listens) this.redirect = await listenForRedirect(state, callback);
			if (this.settled) return this.redirect?.close();
			const redirectUri = this.redirect?.redirectUri ?? callback!;
			const url = authorizationUrl(this.auth, { redirectUri, state, pkce });
			const finish = (code: string) => this.succeed({ code, redirectUri, codeVerifier: pkce?.verifier });

			this.contentEl.empty();
			this.contentEl.createEl("p", {
				text: listens
					? "Sign in and approve access in your browser. CarbonWire continues by itself when the browser comes back."
					: `Sign in and approve access in your browser. You'll end up on ${callback}; copy that page's address and paste it here.`,
			});
			let pasted = "";
			new Setting(this.contentEl)
				.setName("Redirected address")
				.setDesc(listens ? "Only if the browser can't reach CarbonWire." : "The full address, with ?code= in it.")
				.addText((t) => t.setPlaceholder(`${redirectUri}?code=…`).onChange((v) => (pasted = v.trim())))
				.addButton((b) =>
					b.setButtonText("Continue").onClick(() => {
						try {
							finish(readRedirect(new URL(pasted).searchParams, state));
						} catch (e) {
							this.showError(e);
						}
					}),
				);
			new Setting(this.contentEl)
				.addButton((b) => b.setButtonText("Open browser again").onClick(() => void window.open(url)))
				.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
			window.open(url);

			if (this.redirect) finish(readRedirect(await this.redirect.params, state));
		} catch (e) {
			this.showError(e);
		}
	}

	private showError(error: unknown): void {
		if (this.settled) return;
		const message = error instanceof Error ? error.message : String(error);
		this.contentEl.querySelector(".carbonwire-oauth-error")?.remove();
		this.contentEl.createEl("p", { cls: "carbonwire-oauth-error mod-warning", text: message });
	}

	private succeed(result: AuthorizationResult): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(result);
		this.close();
	}

	private fail(error: Error, close = true): void {
		if (this.settled) return;
		this.settled = true;
		this.reject(error);
		if (close) this.close();
	}
}

export function createAuthorizer(app: App): Authorizer {
	return (auth, signal) => {
		const modal = new AuthorizeModal(app, auth, signal);
		modal.open();
		return modal.result;
	};
}
