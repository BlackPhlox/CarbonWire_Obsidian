import { Modal, Notice, Setting, type App } from "obsidian";
import type { OpenApiResult } from "../core/export/openapi";

export type OpenApiFormat = "yaml" | "json";

export interface OpenApiModalOptions {
	title: string;
	result: OpenApiResult;
	/** Where "Save to vault" suggests writing, without an extension. */
	suggestedPath: string;
	format: OpenApiFormat;
	stringify(format: OpenApiFormat): Promise<string>;
	/** Rejects with a message when the file can't be written there. */
	save(path: string, text: string): Promise<void>;
	formatChanged(format: OpenApiFormat): void;
}

const withExtension = (path: string, format: OpenApiFormat) => `${path.replace(/\.(ya?ml|json)$/i, "")}.${format === "yaml" ? "yaml" : "json"}`;

/** Shows what an OpenAPI export contains, and copies or saves it as YAML or JSON. */
export class OpenApiModal extends Modal {
	private format: OpenApiFormat;
	private path: string;

	constructor(app: App, private readonly options: OpenApiModalOptions) {
		super(app);
		this.format = options.format;
		this.path = withExtension(options.suggestedPath, options.format);
	}

	override onOpen(): void {
		const { result } = this.options;
		this.setTitle(`Export ${this.options.title} as OpenAPI`);
		const count = result.operations === 1 ? "1 request" : `${result.operations} requests`;
		this.contentEl.createEl("p", {
			text: `${count} as an OpenAPI 3.1 document. Variables stay as written, so environment values aren't included, and auth is described without credentials.`,
		});
		if (result.warnings.length) {
			const details = this.contentEl.createEl("details", { cls: "carbonwire-openapi-warnings" });
			details.createEl("summary", { text: result.warnings.length === 1 ? "1 request needs attention" : `${result.warnings.length} requests need attention` });
			const list = details.createEl("ul");
			for (const warning of result.warnings) list.createEl("li", { text: warning });
		}

		let pathInput: HTMLInputElement | undefined;
		new Setting(this.contentEl).setName("Format").addDropdown((d) =>
			d
				.addOptions({ yaml: "YAML", json: "JSON" })
				.setValue(this.format)
				.onChange((value) => {
					this.format = value as OpenApiFormat;
					this.path = withExtension(this.path, this.format);
					if (pathInput) pathInput.value = this.path;
					this.options.formatChanged(this.format);
				}),
		);
		new Setting(this.contentEl)
			.setName("File in vault")
			.setDesc("Outside any collection folder, so CarbonWire doesn't read it as a request.")
			.addText((t) => {
				pathInput = t.inputEl;
				t.inputEl.addClass("carbonwire-openapi-path");
				t.setValue(this.path).onChange((v) => (this.path = v.trim()));
			});

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Copy").onClick(() => void this.copy()))
			.addButton((b) => b.setButtonText("Download…").onClick(() => void this.download()))
			.addButton((b) => b.setButtonText("Save to vault").setCta().onClick(() => void this.saveToVault()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private async copy(): Promise<void> {
		await navigator.clipboard.writeText(await this.options.stringify(this.format));
		new Notice("Copied the OpenAPI document.");
	}

	/** Electron shows a save dialog for downloads, so the file can go anywhere on disk. */
	private async download(): Promise<void> {
		const text = await this.options.stringify(this.format);
		const blob = new Blob([text], { type: this.format === "yaml" ? "application/yaml" : "application/json" });
		const url = URL.createObjectURL(blob);
		const link = this.contentEl.createEl("a", { href: url });
		link.download = withExtension(this.path.split("/").pop() || "openapi", this.format);
		link.click();
		link.remove();
		window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}

	private async saveToVault(): Promise<void> {
		const path = withExtension(this.path, this.format);
		if (!path || path.startsWith("/")) {
			new Notice("Enter a path inside the vault.");
			return;
		}
		try {
			await this.options.save(path, await this.options.stringify(this.format));
			new Notice(`Saved ${path}.`);
			this.close();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
		}
	}
}
