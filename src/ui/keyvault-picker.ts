import { FuzzySuggestModal, type App } from "obsidian";

/** Lets the user pick one of a vault's secret names; resolves to undefined if dismissed. */
export function pickKeyVaultSecret(app: App, vault: string, names: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		let chosen: string | undefined;
		const modal = new (class extends FuzzySuggestModal<string> {
			override getItems(): string[] {
				return names;
			}

			override getItemText(item: string): string {
				return item;
			}

			override onChooseItem(item: string): void {
				chosen = item;
			}

			override onClose(): void {
				super.onClose();
				// onChooseItem runs after onClose, so wait a tick before deciding nothing was chosen.
				window.setTimeout(() => resolve(chosen), 0);
			}
		})(app);
		modal.setPlaceholder(`Secret in ${vault}`);
		modal.open();
	});
}
