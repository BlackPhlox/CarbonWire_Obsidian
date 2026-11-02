import type { OpenApiItem, OpenApiSource } from "../core/export/openapi";
import type { Folder, OpenCollection, Variable } from "../core/model";
import { basename, joinPath } from "../core/storage/paths";
import type { CollectionStore } from "../core/storage/store";
import { COLLECTION_FILE, FOLDER_FILE, type CollectionNode, type TreeNode } from "../core/storage/tree";
import { buildScope } from "../core/variables";

export interface ExportTarget {
	collection: CollectionNode;
	/** A folder inside the collection; the whole collection when undefined. */
	folderPath?: string;
}

function findFolder(nodes: readonly TreeNode[], path: string): TreeNode[] | undefined {
	for (const node of nodes) {
		if (node.kind !== "folder") continue;
		if (node.path === path) return node.children;
		if (path.startsWith(`${node.path}/`)) return findFolder(node.children, path);
	}
	return undefined;
}

async function loadItems(store: CollectionStore, nodes: readonly TreeNode[]): Promise<OpenApiItem[]> {
	const items: OpenApiItem[] = [];
	// In sidebar order, so the document follows the collection.
	for (const node of nodes) {
		if (node.kind === "request") {
			items.push({ kind: "request", name: node.name, request: await store.loadRequest(node.path) });
		} else {
			const config = node.hasConfig ? await store.loadDocument<Folder>(joinPath(node.path, FOLDER_FILE)) : undefined;
			items.push({
				kind: "folder",
				folder: { name: config?.info?.name || node.name, docs: config?.docs, defaults: config?.request, items: await loadItems(store, node.children) },
			});
		}
	}
	return items;
}

/**
 * Reads a collection or folder for export. `environment` is the active environment without its
 * secret values, used only to fill in server URLs such as {{baseUrl}}.
 */
export async function loadOpenApiSource(store: CollectionStore, target: ExportTarget, environment: readonly Variable[]): Promise<OpenApiSource> {
	const { collection: node, folderPath } = target;
	const collection = await store.loadDocument<OpenCollection>(joinPath(node.root, COLLECTION_FILE));
	const name = collection.info?.name || node.name;
	if (folderPath === undefined) {
		return {
			title: name,
			version: collection.info?.version,
			summary: collection.info?.summary,
			docs: collection.docs,
			chain: [collection.request],
			items: await loadItems(store, node.children),
			variables: buildScope({ collection: collection.request?.variables, environment }),
		};
	}

	const children = findFolder(node.children, folderPath);
	if (!children) throw new Error("This folder is no longer in the collection.");
	// A path inside the folder gives the defaults chain down to and including the folder itself.
	const { chain } = await store.loadContext(node.root, joinPath(folderPath, "_"));
	const folder = store.exists(joinPath(folderPath, FOLDER_FILE)) ? await store.loadDocument<Folder>(joinPath(folderPath, FOLDER_FILE)) : undefined;
	return {
		title: `${name} – ${folder?.info?.name || basename(folderPath)}`,
		version: collection.info?.version,
		docs: folder?.docs ?? collection.docs,
		chain,
		items: await loadItems(store, children),
		variables: buildScope({ collection: chain[0]?.variables, environment, folders: chain.slice(1).map((d) => d?.variables) }),
	};
}
