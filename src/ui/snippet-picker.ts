import { FuzzySuggestModal, type App } from "obsidian";
import { SNIPPETS, type SnippetLanguage } from "../core/export/snippets";

/** Asks which language to copy a request as; resolves to undefined if dismissed. */
export function pickSnippetLanguage(app: App): Promise<SnippetLanguage | undefined> {
	return new Promise((resolve) => {
		let chosen: SnippetLanguage | undefined;
		const modal = new (class extends FuzzySuggestModal<SnippetLanguage> {
			override getItems(): SnippetLanguage[] {
				return Object.keys(SNIPPETS) as SnippetLanguage[];
			}

			override getItemText(item: SnippetLanguage): string {
				return SNIPPETS[item].label;
			}

			override onChooseItem(item: SnippetLanguage): void {
				chosen = item;
			}

			override onClose(): void {
				super.onClose();
				// onChooseItem runs after onClose, so wait a tick before deciding nothing was chosen.
				window.setTimeout(() => resolve(chosen), 0);
			}
		})(app);
		modal.setPlaceholder("Copy the request as…");
		modal.open();
	});
}
