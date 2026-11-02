import type { App } from "obsidian";
import type { AzureCliCredential, CliAccount } from "../core/azure/cli";
import { accountName, EntraError, KEY_VAULT_SCOPE, signInScope, type EntraClient, type EntraConfig, type EntraTokens } from "../core/azure/entra";

/** One SecretStorage entry holds the whole sign-in, so it stays on this device and out of the vault. */
const SECRET_ID = "carbonwire--microsoft-account";
const EXPIRY_SKEW_MS = 60_000;

interface StoredAccount {
	account?: string;
	tenant: string;
	clientId: string;
	refreshToken: string;
}

/** "browser": CarbonWire signs in itself. "azure-cli": tokens come from the user's `az login`. */
export type MicrosoftAuthMode = "browser" | "azure-cli";

export interface MicrosoftAccountDeps {
	client: () => Promise<EntraClient>;
	config: () => EntraConfig;
	mode: () => MicrosoftAuthMode;
	cli: () => AzureCliCredential;
	/** Called after signing in or out, so settings can refresh. */
	changed: () => void;
}

/** The signed-in Microsoft account, or the Azure CLI's, and its Key Vault access token. */
export class MicrosoftAccount {
	/** `config` is the tenant and client ID the token was issued for. */
	private access?: { token: string; expiresAt: number; config: string };
	private pending?: Promise<string>;
	private signingIn?: Promise<boolean>;

	constructor(private readonly app: App, private readonly deps: MicrosoftAccountDeps) {}

	/** The sign-in, if it was made with the tenant and client ID currently in settings. */
	private stored(): StoredAccount | undefined {
		const raw = this.app.secretStorage.getSecret(SECRET_ID);
		if (!raw) return undefined;
		try {
			const stored = JSON.parse(raw) as StoredAccount;
			const config = this.deps.config();
			if (typeof stored.refreshToken !== "string" || !stored.refreshToken) return undefined;
			if (stored.tenant !== config.tenant.trim() || stored.clientId !== config.clientId.trim()) return undefined;
			return stored;
		} catch {
			return undefined;
		}
	}

	private configKey(): string {
		const config = this.deps.config();
		return `${this.deps.mode()}\n${config.tenant.trim()}\n${config.clientId.trim()}`;
	}

	usesAzureCli(): boolean {
		return this.deps.mode() === "azure-cli";
	}

	/** Who the Azure CLI is signed in as; rejects with a message saying what to do when it can't tell. */
	azureCliAccount(signal?: AbortSignal): Promise<CliAccount> {
		return this.deps.cli().account(signal);
	}

	/** The in-memory token, if it is still valid and for the current settings. */
	private currentAccess(skewMs = 0): string | undefined {
		const access = this.access;
		if (!access || access.config !== this.configKey() || access.expiresAt - skewMs <= Date.now()) return undefined;
		return access.token;
	}

	/** In Azure CLI mode this is about CarbonWire's own sign-in, which isn't used. */
	isSignedIn(): boolean {
		if (this.usesAzureCli()) return false;
		return this.stored() !== undefined || this.currentAccess() !== undefined;
	}

	/** The account's sign-in name, or undefined when signed out. */
	accountName(): string | undefined {
		if (!this.isSignedIn()) return undefined;
		return this.stored()?.account ?? "Microsoft account";
	}

	/** Opens the sign-in dialog; resolves to false if the user cancels. */
	signIn(): Promise<boolean> {
		this.signingIn ??= this.openSignIn().finally(() => (this.signingIn = undefined));
		return this.signingIn;
	}

	/** Forgets the in-memory token after the tenant or client ID changes in settings. */
	configChanged(): void {
		this.access = undefined;
		this.deps.changed();
	}

	signOut(): void {
		this.app.secretStorage.setSecret(SECRET_ID, "");
		this.access = undefined;
		this.deps.changed();
	}

	/**
	 * A Key Vault access token, refreshed when needed. With `interactive`, opens the sign-in
	 * dialog when there is no usable sign-in; otherwise fails.
	 */
	accessToken(signal?: AbortSignal, interactive = true): Promise<string> {
		const token = this.currentAccess(EXPIRY_SKEW_MS);
		if (token) return Promise.resolve(token);
		this.pending ??= (this.usesAzureCli() ? this.fetchCliToken(signal) : this.fetchToken(signal, interactive)).finally(() => (this.pending = undefined));
		return this.pending;
	}

	/** az caches and refreshes its own tokens; CarbonWire only keeps the access token in memory. */
	private async fetchCliToken(signal: AbortSignal | undefined): Promise<string> {
		const key = this.configKey();
		const token = await this.deps.cli().token(KEY_VAULT_SCOPE, this.deps.config().tenant, signal);
		this.access = { token: token.accessToken, expiresAt: token.expiresAt, config: key };
		return token.accessToken;
	}

	private async fetchToken(signal: AbortSignal | undefined, interactive: boolean): Promise<string> {
		const stored = this.stored();
		if (stored) {
			try {
				const tokens = await (await this.deps.client()).refresh(stored.refreshToken, signInScope(KEY_VAULT_SCOPE), signal);
				this.save(tokens, stored.account);
				return tokens.accessToken;
			} catch (e) {
				// Revoked, expired or blocked by policy: the user has to sign in again.
				if (!(e instanceof EntraError) || (e.code !== "invalid_grant" && e.code !== "interaction_required")) throw e;
				this.signOut();
			}
		}
		if (!interactive) throw new EntraError("Sign in to Microsoft in CarbonWire settings to use Key Vault secrets.", "not_signed_in");
		const token = (await this.signIn()) ? this.currentAccess() : undefined;
		if (!token) throw new EntraError("Microsoft sign-in was cancelled, so Key Vault secrets couldn't be read.", "cancelled");
		return token;
	}

	private async openSignIn(): Promise<boolean> {
		const [{ MicrosoftSignInModal }, client] = await Promise.all([import("../ui/microsoft-sign-in"), this.deps.client()]);
		const modal = new MicrosoftSignInModal(this.app, client, this.deps.config(), signInScope(KEY_VAULT_SCOPE));
		modal.open();
		const tokens = await modal.result;
		if (!tokens) return false;
		this.save(tokens);
		this.deps.changed();
		return true;
	}

	private save(tokens: EntraTokens, previousAccount?: string): void {
		this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt, config: this.configKey() };
		// Entra rotates refresh tokens; keep the newest one.
		const refreshToken = tokens.refreshToken ?? this.stored()?.refreshToken;
		if (!refreshToken) return;
		const config = this.deps.config();
		const stored: StoredAccount = {
			account: accountName(tokens.idToken) ?? previousAccount,
			tenant: config.tenant.trim(),
			clientId: config.clientId.trim(),
			refreshToken,
		};
		this.app.secretStorage.setSecret(SECRET_ID, JSON.stringify(stored));
	}
}
