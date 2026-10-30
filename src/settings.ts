import { normalizePath, PluginSettingTab, Setting, type App, type SettingDefinitionItem } from "obsidian";
import { AZURE_CLI_CLIENT_ID } from "./core/azure/entra";
import type { SortOrder } from "./core/storage/order";
import type CarbonWirePlugin from "./main";

export interface RequestLayout {
	/** "vertical": request on the left, response on the right. */
	orientation: "vertical" | "horizontal";
	/** Share of the space given to the request panel, from 0 to 1. */
	ratio: number;
}

export interface CarbonWireSettings {
	/** Where new collections are created; empty means the vault root. */
	collectionsFolder: string;
	/** Environments are shared by every collection and live in this folder. */
	environmentsFolder: string;
	/** Active environment name; empty means none. */
	activeEnvironment: string;
	maxResponseMB: number;
	/** Most recent sends kept in history on this device; 0 turns history off. */
	historySize: number;
	/** Wrap long lines in response bodies instead of scrolling sideways. */
	wrapResponseLines: boolean;
	rejectUnauthorized: boolean;
	requestLayout: RequestLayout;
	sortOrder: SortOrder;
	/** Collection roots in the order they were dragged to; others follow by name. */
	collectionOrder: string[];
	/** Environment names in the order they were dragged to; others follow by name. */
	environmentOrder: string[];
	/** Entra ID tenant to sign in to; "organizations" accepts any work or school account. */
	microsoftTenant: string;
	/** App (client) ID used to sign in; defaults to Microsoft's public Azure CLI app. */
	microsoftClientId: string;
	/** Vault used by {{$keyvault:secret}} references that don't name one. */
	keyVaultDefault: string;
	/** Minutes fetched Key Vault values stay in memory; 0 fetches on every send. */
	keyVaultCacheMinutes: number;
}

export const DEFAULT_SETTINGS: CarbonWireSettings = {
	collectionsFolder: "API Collections",
	environmentsFolder: "API Collections/Environments",
	activeEnvironment: "",
	maxResponseMB: 20,
	historySize: 100,
	wrapResponseLines: true,
	rejectUnauthorized: true,
	requestLayout: { orientation: "vertical", ratio: 0.5 },
	sortOrder: "manual",
	collectionOrder: [],
	environmentOrder: [],
	microsoftTenant: "organizations",
	microsoftClientId: AZURE_CLI_CLIENT_ID,
	keyVaultDefault: "",
	keyVaultCacheMinutes: 5,
};

const TEXT = {
	folder: ["Collections folder", "New collections are created in this folder. Existing collections are found anywhere in the vault."],
	environments: ["Environments folder", "Environments are shared by every collection. The active one overrides collection variables."],
	maxResponse: ["Response size limit", "In megabytes. Larger response bodies are truncated in memory; the full size is still reported."],
	wrap: ["Wrap long lines in responses", "Otherwise long lines scroll sideways. Also toggled from the response toolbar."],
	history: ["History size", "How many recent requests to keep, on this device only. Set to 0 to turn history off."],
	tls: ["Verify TLS certificates", "Turn off only for local servers with self-signed certificates."],
	account: ["Microsoft account", "Sign in to read secrets from Azure Key Vault with {{$keyvault:vault/secret}} variables. The sign-in is kept in Obsidian's secret storage on this device."],
	tenant: ["Tenant", "Directory (tenant) ID or domain, such as contoso.onmicrosoft.com. Use organizations for any work or school account."],
	clientId: ["Client ID", "Application (client) ID to sign in with. The default is Microsoft's public Azure CLI app, which already has Key Vault access. Use your own app registration if your organization blocks it."],
	defaultVault: ["Default vault", "Vault name or URL used by {{$keyvault:secret}} when the reference doesn't name a vault."],
	cache: ["Keep secrets in memory", "In minutes. Fetched values are never written to disk. Set to 0 to fetch on every send."],
} as const;

export class CarbonWireSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: CarbonWirePlugin) {
		super(app, plugin);
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: TEXT.folder[0], desc: TEXT.folder[1], control: { type: "folder", key: "collectionsFolder", includeRoot: true, placeholder: "Vault root" } },
			{ name: TEXT.environments[0], desc: TEXT.environments[1], control: { type: "folder", key: "environmentsFolder", placeholder: DEFAULT_SETTINGS.environmentsFolder } },
			{ name: TEXT.maxResponse[0], desc: TEXT.maxResponse[1], control: { type: "number", key: "maxResponseMB", min: 1, step: 1 } },
			{ name: TEXT.history[0], desc: TEXT.history[1], control: { type: "number", key: "historySize", min: 0, step: 10 } },
			{ name: TEXT.wrap[0], desc: TEXT.wrap[1], control: { type: "toggle", key: "wrapResponseLines" } },
			{ name: TEXT.tls[0], desc: TEXT.tls[1], control: { type: "toggle", key: "rejectUnauthorized" } },
			{
				type: "group",
				heading: "Azure Key Vault",
				items: [
					{ name: TEXT.account[0], desc: TEXT.account[1], aliases: ["Entra ID", "Azure AD", "sign in"], render: (setting) => this.renderAccount(setting) },
					{ name: TEXT.tenant[0], desc: TEXT.tenant[1], control: { type: "text", key: "microsoftTenant", placeholder: DEFAULT_SETTINGS.microsoftTenant } },
					{ name: TEXT.clientId[0], desc: TEXT.clientId[1], control: { type: "text", key: "microsoftClientId", placeholder: DEFAULT_SETTINGS.microsoftClientId } },
					{ name: TEXT.defaultVault[0], desc: TEXT.defaultVault[1], control: { type: "text", key: "keyVaultDefault", placeholder: "contoso" } },
					{ name: TEXT.cache[0], desc: TEXT.cache[1], control: { type: "number", key: "keyVaultCacheMinutes", min: 0, step: 1 } },
				],
			},
		];
	}

	/** Shows who is signed in, with a sign-in or sign-out button, and follows changes. */
	private renderAccount(setting: Setting): () => void {
		const account = this.plugin.microsoft;
		const paint = () => {
			const name = account.accountName();
			setting.setDesc(name ? `Signed in as ${name}. ${TEXT.account[1]}` : TEXT.account[1]);
			setting.controlEl.empty();
			if (name) setting.addButton((b) => b.setButtonText("Sign out").onClick(() => account.signOut()));
			else setting.addButton((b) => b.setButtonText("Sign in").setCta().onClick(() => void account.signIn()));
		};
		paint();
		return this.plugin.onMicrosoftAccountChanged(paint);
	}

	/** Only used by Obsidian versions before 1.13, which lack declarative settings. */
	override display(): void {
		const { containerEl } = this;
		const { settings } = this.plugin;
		containerEl.empty();

		new Setting(containerEl).setName(TEXT.folder[0]).setDesc(TEXT.folder[1]).addText((text) =>
			text.setPlaceholder("Vault root").setValue(settings.collectionsFolder).onChange(async (value) => {
				settings.collectionsFolder = value.trim() ? normalizePath(value) : "";
				await this.plugin.saveSettings();
			}),
		);
		new Setting(containerEl).setName(TEXT.environments[0]).setDesc(TEXT.environments[1]).addText((text) =>
			text.setPlaceholder(DEFAULT_SETTINGS.environmentsFolder).setValue(settings.environmentsFolder).onChange(async (value) => {
				settings.environmentsFolder = value.trim() ? normalizePath(value) : DEFAULT_SETTINGS.environmentsFolder;
				await this.plugin.saveSettings();
			}),
		);
		new Setting(containerEl).setName(TEXT.maxResponse[0]).setDesc(TEXT.maxResponse[1]).addText((text) =>
			text.setValue(String(settings.maxResponseMB)).onChange(async (value) => {
				const mb = Number(value);
				if (!Number.isFinite(mb) || mb <= 0) return;
				settings.maxResponseMB = mb;
				await this.plugin.saveSettings();
			}),
		);
		new Setting(containerEl).setName(TEXT.history[0]).setDesc(TEXT.history[1]).addText((text) =>
			text.setValue(String(settings.historySize)).onChange(async (value) => {
				const size = Number(value);
				if (!Number.isInteger(size) || size < 0) return;
				settings.historySize = size;
				await this.plugin.saveSettings();
			}),
		);
		new Setting(containerEl).setName(TEXT.wrap[0]).setDesc(TEXT.wrap[1]).addToggle((toggle) =>
			toggle.setValue(settings.wrapResponseLines).onChange((value) => void this.plugin.setWrapResponseLines(value)),
		);
		new Setting(containerEl).setName(TEXT.tls[0]).setDesc(TEXT.tls[1]).addToggle((toggle) =>
			toggle.setValue(settings.rejectUnauthorized).onChange(async (value) => {
				settings.rejectUnauthorized = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl).setName("Azure Key Vault").setHeading();
		this.cleanupAccount?.();
		this.cleanupAccount = this.renderAccount(new Setting(containerEl).setName(TEXT.account[0]));
		const text = (label: readonly [string, string], key: "microsoftTenant" | "microsoftClientId" | "keyVaultDefault", placeholder: string) =>
			new Setting(containerEl).setName(label[0]).setDesc(label[1]).addText((t) =>
				t.setPlaceholder(placeholder).setValue(settings[key]).onChange(async (value) => {
					settings[key] = value.trim() || (key === "keyVaultDefault" ? "" : DEFAULT_SETTINGS[key]);
					await this.plugin.saveSettings();
				}),
			);
		text(TEXT.tenant, "microsoftTenant", DEFAULT_SETTINGS.microsoftTenant);
		text(TEXT.clientId, "microsoftClientId", DEFAULT_SETTINGS.microsoftClientId);
		text(TEXT.defaultVault, "keyVaultDefault", "contoso");
		new Setting(containerEl).setName(TEXT.cache[0]).setDesc(TEXT.cache[1]).addText((t) =>
			t.setValue(String(settings.keyVaultCacheMinutes)).onChange(async (value) => {
				const minutes = Number(value);
				if (!Number.isFinite(minutes) || minutes < 0) return;
				settings.keyVaultCacheMinutes = minutes;
				await this.plugin.saveSettings();
			}),
		);
	}

	private cleanupAccount?: () => void;

	override hide(): void {
		this.cleanupAccount?.();
		this.cleanupAccount = undefined;
		super.hide();
	}
}
