import { Modal, Setting, type App } from "obsidian";
import { authorizeUrl, createPkce, EntraError, randomState, type EntraClient, type EntraConfig, type EntraTokens } from "../core/azure/entra";
import { listenForRedirect, type LoopbackRedirect } from "../obsidian/loopback";

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new EntraError("Sign-in was cancelled.", "cancelled"));
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/**
 * Signs in with the browser (authorization code with PKCE and a localhost redirect), or with a
 * device code for accounts or networks where the redirect can't come back.
 */
export class MicrosoftSignInModal extends Modal {
	readonly result: Promise<EntraTokens | undefined>;
	private resolve!: (tokens: EntraTokens | undefined) => void;
	private finished = false;
	/** Aborts whichever flow is running when the user switches flows or closes the dialog. */
	private flow = new AbortController();
	private redirect?: LoopbackRedirect;

	constructor(app: App, private readonly client: EntraClient, private readonly config: EntraConfig, private readonly scopes: string) {
		super(app);
		this.result = new Promise((r) => (this.resolve = r));
	}

	override onOpen(): void {
		this.setTitle("Sign in to Microsoft");
		void this.browserFlow();
	}

	override onClose(): void {
		this.stopFlow();
		this.contentEl.empty();
		if (!this.finished) this.resolve(undefined);
	}

	private stopFlow(): AbortSignal {
		this.flow.abort();
		this.redirect?.close();
		this.redirect = undefined;
		this.flow = new AbortController();
		return this.flow.signal;
	}

	private async browserFlow(): Promise<void> {
		const signal = this.stopFlow();
		this.show("Opening your browser…");
		try {
			const { verifier, challenge } = createPkce();
			const state = randomState();
			const redirect = await listenForRedirect(state);
			if (signal.aborted) return redirect.close();
			this.redirect = redirect;
			const url = authorizeUrl(this.config, { redirectUri: redirect.redirectUri, challenge, state, scope: this.scopes });
			window.open(url);
			this.show("Finish signing in in your browser, then come back here.", (s) => {
				s.addButton((b) => b.setButtonText("Open browser again").onClick(() => void window.open(url)));
				s.addButton((b) => b.setButtonText("Use a code instead").onClick(() => void this.deviceCodeFlow()));
				s.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
			});
			const params = await untilAborted(redirect.params, signal);
			redirect.close();
			const code = params.get("code");
			if (!code) {
				const reason = params.get("error_description")?.split(/\r?\n/)[0] || params.get("error") || "no code was returned";
				throw new EntraError(`Microsoft sign-in failed: ${reason}`, params.get("error") ?? undefined);
			}
			this.show("Finishing sign-in…");
			this.finish(await this.client.redeemCode(code, verifier, redirect.redirectUri, this.scopes, signal));
		} catch (e) {
			if (!signal.aborted) this.failed(e);
		}
	}

	private async deviceCodeFlow(): Promise<void> {
		const signal = this.stopFlow();
		this.show("Getting a sign-in code…");
		try {
			const code = await this.client.startDeviceCode(this.scopes, signal);
			if (signal.aborted) return;
			this.contentEl.empty();
			this.contentEl.createEl("p", { text: `Go to ${code.verificationUri} and enter this code. You can do this on any device.` });
			this.contentEl.createDiv({ cls: "carbonwire-device-code", text: code.userCode });
			new Setting(this.contentEl)
				.addButton((b) =>
					b
						.setButtonText("Copy code and open page")
						.setCta()
						.onClick(() => {
							void navigator.clipboard.writeText(code.userCode);
							window.open(code.verificationUri);
						}),
				)
				.addButton((b) => b.setButtonText("Use the browser instead").onClick(() => void this.browserFlow()))
				.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
			this.finish(await this.client.pollDeviceCode(code, signal));
		} catch (e) {
			if (!signal.aborted) this.failed(e);
		}
	}

	private finish(tokens: EntraTokens): void {
		this.finished = true;
		this.resolve(tokens);
		this.close();
	}

	private failed(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.show(message, (s) => {
			s.addButton((b) => b.setButtonText("Try again").setCta().onClick(() => void this.browserFlow()));
			s.addButton((b) => b.setButtonText("Use a code instead").onClick(() => void this.deviceCodeFlow()));
			s.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		});
	}

	private show(message: string, buttons?: (setting: Setting) => void): void {
		this.contentEl.empty();
		this.contentEl.createEl("p", { text: message });
		if (buttons) buttons(new Setting(this.contentEl));
	}
}
