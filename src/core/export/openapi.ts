import { mergeHeaders, resolveAuth } from "../inheritance";
import type { Auth, DefaultsChain, HttpRequest, HttpRequestBody, HttpRequestDetails, HttpRequestExample, HttpRequestParam, RequestDefaults } from "../model";
import { interpolate } from "../variables";

/** A folder to export, with its folder.yml defaults and docs. */
export interface OpenApiFolder {
	name: string;
	docs?: unknown;
	defaults?: RequestDefaults;
	items: OpenApiItem[];
}

export type OpenApiItem = { kind: "folder"; folder: OpenApiFolder } | { kind: "request"; name: string; request: HttpRequest };

export interface OpenApiSource {
	title: string;
	version?: string;
	summary?: string;
	docs?: unknown;
	/** Defaults of the collection, and of folders above the exported one, outermost first. */
	chain: DefaultsChain;
	items: OpenApiItem[];
	/**
	 * Values for {{variables}} in server URLs and OAuth 2.0 URLs, such as {{baseUrl}}. Only pass
	 * values that may be published: secret environment values should be left out.
	 */
	variables?: ReadonlyMap<string, string>;
	/** Tags for requests in the top level of what is exported, e.g. the exported folder's path. */
	tags?: string[];
}

export interface OpenApiResult {
	document: Record<string, unknown>;
	operations: number;
	warnings: string[];
}

type Json = Record<string, unknown>;

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
/** OpenAPI says these header parameters are ignored; they're described by content types and security instead. */
const RESERVED_HEADERS = new Set(["accept", "authorization", "content-type"]);
const RAW_TYPES: Record<string, string> = { json: "application/json", text: "text/plain", xml: "application/xml", sparql: "application/sparql-query" };
const EXAMPLE_TYPES: Record<string, string> = { json: "application/json", text: "text/plain", xml: "application/xml", html: "text/html", binary: "application/octet-stream" };

const text = (value: unknown): string | undefined => {
	if (typeof value === "string") return value.trim() || undefined;
	if (value && typeof value === "object" && "content" in value && typeof value.content === "string") return value.content.trim() || undefined;
	return undefined;
};
const hasPlaceholder = (s: string) => s.includes("{{");

/**
 * Builds an OpenAPI 3.1 document from a collection or folder. Literal values become examples;
 * {{variables}} are never resolved into examples, so environment values stay out of the spec.
 */
export function toOpenApi(source: OpenApiSource): OpenApiResult {
	const ctx = new Exporter(source);
	ctx.walk(source.items, source.chain, source.tags ?? []);
	return ctx.finish();
}

class Exporter {
	private readonly paths = new Map<string, Json>();
	private readonly tags = new Map<string, string | undefined>();
	private readonly schemes = new Map<string, Json>();
	private readonly schemeKeys = new Map<string, string>();
	private readonly operationIds = new Set<string>();
	/** Server URL template → how many operations use it, in order of first use. */
	private readonly servers = new Map<string, { url: string; variables?: Json; count: number }>();
	private readonly operationServers = new Map<Json, string>();
	private readonly warnings: string[] = [];
	private operations = 0;

	constructor(private readonly source: OpenApiSource) {}

	walk(items: readonly OpenApiItem[], chain: DefaultsChain, tags: string[]): void {
		for (const item of items) {
			if (item.kind === "folder") {
				const { folder } = item;
				const tag = [...tags.slice(-1), folder.name].join(" / ");
				if (!this.tags.has(tag)) this.tags.set(tag, text(folder.docs));
				this.walk(folder.items, [...chain, folder.defaults], [tag]);
			} else {
				this.addOperation(item.name, item.request, chain, tags);
			}
		}
	}

	private addOperation(name: string, request: HttpRequest, chain: DefaultsChain, tags: string[]): void {
		const http = request.http ?? {};
		const method = (http.method ?? "GET").toLowerCase();
		if (!METHODS.has(method)) {
			this.warnings.push(`"${name}" uses ${method.toUpperCase()}, which OpenAPI can't describe; it was skipped.`);
			return;
		}
		const { server, path, query } = splitUrl(http.url ?? "");
		const item = this.paths.get(path) ?? {};
		if (item[method]) {
			this.warnings.push(`"${name}" has the same method and path as another request (${method.toUpperCase()} ${path}); only the first was exported.`);
			return;
		}

		const operation: Json = { summary: name };
		const description = text(request.docs) ?? text(request.info?.description);
		if (description) operation.description = description;
		operation.operationId = this.operationId(name, method, path);
		if (tags.length) operation.tags = tags;

		const parameters = this.parameters(path, http.params ?? [], query, mergeHeaders(chain, http.headers), http.headers ?? []);
		if (parameters.length) operation.parameters = parameters;
		const body = requestBody(http.body);
		if (body) operation.requestBody = body;
		operation.responses = responses(request.examples ?? []);
		const security = this.security(name, resolveAuth(http.auth, chain));
		if (security) operation.security = security;
		if (server !== undefined) this.useServer(operation, server);

		item[method] = operation;
		this.paths.set(path, item);
		this.operations++;
	}

	private operationId(name: string, method: string, path: string): string {
		const words = (name.match(/[A-Za-z0-9]+/g) ?? []).map((w) => w.toLowerCase());
		const base = words.length
			? words[0]! + words.slice(1).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")
			: method + path.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""));
		let id = base;
		for (let i = 2; this.operationIds.has(id); i++) id = `${base}${i}`;
		this.operationIds.add(id);
		return id;
	}

	private parameters(
		path: string,
		params: readonly HttpRequestParam[],
		urlQuery: [string, string][],
		headers: readonly (readonly [string, string])[],
		ownHeaders: readonly { name: string; description?: unknown }[],
	): Json[] {
		const out: Json[] = [];
		const withExample = (p: Json, value: string, description: unknown) => {
			const d = text(description);
			if (d) p.description = d;
			p.schema = { type: "string" };
			if (value !== "" && !hasPlaceholder(value)) p.example = value;
			return p;
		};

		const pathParams = params.filter((p) => p.type === "path");
		for (const [, name] of path.matchAll(/\{([^{}]+)\}/g)) {
			const param = pathParams.find((p) => p.name === name);
			out.push(withExample({ name, in: "path", required: true }, param?.value ?? "", param?.description));
		}

		const queryParams = params.filter((p) => p.type === "query");
		const queries = queryParams.length ? queryParams : urlQuery.map(([name, value]): HttpRequestParam => ({ name, value, type: "query" }));
		const seen = new Set<string>();
		for (const p of queries) {
			if (!p.name || seen.has(p.name)) continue;
			seen.add(p.name);
			out.push(withExample({ name: p.name, in: "query", required: false }, p.value, p.description));
		}

		for (const [name, value] of headers) {
			if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
			const own = ownHeaders.find((h) => h.name.toLowerCase() === name.toLowerCase());
			out.push(withExample({ name, in: "header", required: false }, value, own?.description));
		}
		return out;
	}

	private security(name: string, auth: Exclude<Auth, "inherit"> | undefined): Json[] | undefined {
		if (!auth) return undefined;
		const resolve = (s: string | undefined) => interpolate(s ?? "", this.source.variables ?? new Map());
		let scheme: Json;
		let base: string;
		let scopes: string[] = [];
		switch (auth.type) {
			case "basic":
			case "digest":
				scheme = { type: "http", scheme: auth.type };
				base = `${auth.type}Auth`;
				break;
			case "bearer":
				scheme = { type: "http", scheme: "bearer" };
				base = "bearerAuth";
				break;
			case "apikey": {
				const key = resolve(auth.key);
				if (!key) return undefined;
				const where = auth.placement === "query" ? "query" : "header";
				scheme = { type: "apiKey", in: where, name: key };
				base = `apiKey${where === "query" ? "Query" : "Header"}`;
				break;
			}
			case "oauth2": {
				scopes = (auth.scope ?? "").split(/\s+/).filter(Boolean);
				const scopeMap = Object.fromEntries(scopes.map((s) => [s, ""]));
				let flows: Json;
				switch (auth.flow) {
					case "client_credentials":
						flows = { clientCredentials: { tokenUrl: resolve(auth.accessTokenUrl), scopes: scopeMap } };
						break;
					case "resource_owner_password_credentials":
						flows = { password: { tokenUrl: resolve(auth.accessTokenUrl), scopes: scopeMap } };
						break;
					case "authorization_code":
						flows = { authorizationCode: { authorizationUrl: resolve(auth.authorizationUrl), tokenUrl: resolve(auth.accessTokenUrl), scopes: scopeMap } };
						break;
					case "implicit":
						flows = { implicit: { authorizationUrl: resolve(auth.authorizationUrl), scopes: scopeMap } };
						break;
					default:
						this.warnings.push(`"${name}" uses an OAuth 2.0 flow OpenAPI can't describe; its security was left out.`);
						return undefined;
				}
				const refresh = "refreshTokenUrl" in auth && auth.refreshTokenUrl ? resolve(auth.refreshTokenUrl) : "";
				if (refresh) for (const flow of Object.values(flows)) (flow as Json).refreshUrl = refresh;
				scheme = { type: "oauth2", flows };
				base = "oauth2";
				break;
			}
			default:
				this.warnings.push(`"${name}" uses ${String((auth as { type?: unknown }).type)} auth, which OpenAPI can't describe; its security was left out.`);
				return undefined;
		}
		return [{ [this.schemeName(base, scheme)]: scopes }];
	}

	/** The same scheme always gets the same name; different ones with the same base get numbered. */
	private schemeName(base: string, scheme: Json): string {
		const key = JSON.stringify(scheme);
		const existing = this.schemeKeys.get(key);
		if (existing) return existing;
		let name = base;
		for (let i = 2; this.schemes.has(name); i++) name = `${base}${i}`;
		this.schemes.set(name, scheme);
		this.schemeKeys.set(key, name);
		return name;
	}

	private useServer(operation: Json, server: string): void {
		const url = server.replace(PLACEHOLDER, (_, name: string) => `{${name}}`);
		let entry = this.servers.get(url);
		if (!entry) {
			const variables: Json = {};
			for (const [, name] of server.matchAll(PLACEHOLDER)) {
				const value = this.source.variables?.get(name!);
				const resolved = value === undefined ? "" : interpolate(value, this.source.variables!);
				variables[name!] = { default: hasPlaceholder(resolved) ? "" : resolved };
			}
			entry = { url, count: 0, ...(Object.keys(variables).length ? { variables } : {}) };
			this.servers.set(url, entry);
		}
		entry.count++;
		this.operationServers.set(operation, url);
	}

	finish(): OpenApiResult {
		const { source } = this;
		const info: Json = { title: source.title || "API", version: source.version || "1.0.0" };
		if (source.summary) info.summary = source.summary;
		const description = text(source.docs);
		if (description) info.description = description;

		const document: Json = { openapi: "3.1.0", info };
		const servers = [...this.servers.values()];
		// The most used server is the default; operations on other servers name theirs.
		const main = servers.reduce<(typeof servers)[number] | undefined>((best, s) => (!best || s.count > best.count ? s : best), undefined);
		if (main) {
			document.servers = [serverObject(main)];
			for (const [operation, url] of this.operationServers) {
				if (url !== main.url) operation.servers = [serverObject(this.servers.get(url)!)];
			}
		}
		const tags = [...this.tags].map(([name, description]) => (description ? { name, description } : { name }));
		if (tags.length) document.tags = tags;
		document.paths = Object.fromEntries([...this.paths].sort(([a], [b]) => a.localeCompare(b)));
		if (this.schemes.size) document.components = { securitySchemes: Object.fromEntries(this.schemes) };
		return { document, operations: this.operations, warnings: this.warnings };
	}
}

function serverObject(server: { url: string; variables?: Json }): Json {
	return server.variables ? { url: server.url, variables: server.variables } : { url: server.url };
}

/**
 * Splits a request URL into a server (scheme and host, or a leading {{variable}} such as
 * {{baseUrl}}), an OpenAPI path with {params}, and the query string's pairs.
 */
export function splitUrl(raw: string): { server?: string; path: string; query: [string, string][] } {
	let url = raw.trim();
	const hashAt = url.indexOf("#");
	if (hashAt >= 0) url = url.slice(0, hashAt);
	const queryAt = url.indexOf("?");
	const queryString = queryAt >= 0 ? url.slice(queryAt + 1) : "";
	if (queryAt >= 0) url = url.slice(0, queryAt);

	let server: string | undefined;
	let path: string;
	const variableHost = /^\{\{\s*[^{}]+?\s*\}\}/.exec(url);
	const schemeHost = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/.exec(url);
	if (variableHost) {
		server = variableHost[0];
		path = url.slice(server.length);
	} else if (schemeHost) {
		server = schemeHost[0];
		path = url.slice(server.length);
	} else if (url.startsWith("/")) {
		path = url;
	} else {
		// "api.example.com/users", as typed without a scheme.
		const slash = url.indexOf("/");
		const host = slash >= 0 ? url.slice(0, slash) : url;
		server = host ? `https://${host}` : undefined;
		path = slash >= 0 ? url.slice(slash) : "";
	}

	path = path
		.replace(/\/:([A-Za-z0-9_.-]+)/g, "/{$1}")
		.replace(PLACEHOLDER, (_, name: string) => `{${name.replace(/[{}]/g, "")}}`);
	if (!path.startsWith("/")) path = `/${path}`;

	const query = queryString
		.split("&")
		.filter(Boolean)
		.map((pair): [string, string] => {
			const eq = pair.indexOf("=");
			const decode = (s: string) => {
				try {
					return decodeURIComponent(s.replace(/\+/g, " "));
				} catch {
					return s;
				}
			};
			return eq >= 0 ? [decode(pair.slice(0, eq)), decode(pair.slice(eq + 1))] : [decode(pair), ""];
		});
	return { server, path, query };
}

/** Parses a JSON example; bare {{variables}}, as in `"age": {{age}}`, are read as strings. */
export function parseJsonExample(data: string): { ok: true; value: unknown } | { ok: false } {
	for (const candidate of [data, data.replace(/(?<!")\{\{\s*[^{}]+?\s*\}\}(?!")/g, (m) => JSON.stringify(m))]) {
		try {
			return { ok: true, value: JSON.parse(candidate) };
		} catch {
			// Try the next candidate.
		}
	}
	return { ok: false };
}

/** A JSON Schema describing the shape of an example value. */
export function inferSchema(value: unknown, depth = 0): Json {
	if (value === null) return { type: "null" };
	if (Array.isArray(value)) return value.length && depth < 20 ? { type: "array", items: inferSchema(value[0], depth + 1) } : { type: "array" };
	switch (typeof value) {
		case "string":
			return { type: "string" };
		case "number":
			return { type: Number.isInteger(value) ? "integer" : "number" };
		case "boolean":
			return { type: "boolean" };
		case "object": {
			if (depth >= 20) return { type: "object" };
			const properties = Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, inferSchema(v, depth + 1)]));
			return { type: "object", properties };
		}
		default:
			return {};
	}
}

const binary = (contentType: string): Json => ({ type: "string", format: "binary", contentMediaType: contentType });

/** One media type entry for a body: its type, schema and example. */
function bodyMedia(body: HttpRequestBody): { type: string; media: Json } | undefined {
	switch (body.type) {
		case "json": {
			const parsed = parseJsonExample(body.data);
			if (!body.data.trim()) return { type: RAW_TYPES.json!, media: {} };
			return parsed.ok
				? { type: RAW_TYPES.json!, media: { schema: inferSchema(parsed.value), example: parsed.value } }
				: { type: RAW_TYPES.json!, media: { example: body.data } };
		}
		case "text":
		case "xml":
		case "sparql":
			return { type: RAW_TYPES[body.type]!, media: { schema: { type: "string" }, ...(body.data ? { example: body.data } : {}) } };
		case "form-urlencoded":
		case "multipart-form": {
			const properties: Json = {};
			const example: Json = {};
			for (const entry of body.data) {
				if (!entry.name) continue;
				const value = Array.isArray(entry.value) ? entry.value[0] ?? "" : entry.value;
				const isFile = "type" in entry && entry.type === "file";
				const schema: Json = isFile ? binary(("contentType" in entry && entry.contentType) || "application/octet-stream") : { type: "string" };
				const description = text(entry.description);
				if (description) schema.description = description;
				properties[entry.name] = schema;
				if (!isFile && value && !hasPlaceholder(value)) example[entry.name] = value;
			}
			const media: Json = { schema: { type: "object", properties } };
			if (Object.keys(example).length) media.example = example;
			return { type: body.type === "multipart-form" ? "multipart/form-data" : "application/x-www-form-urlencoded", media };
		}
		case "file": {
			const variant = body.data.find((v) => v.selected) ?? body.data[0];
			const type = variant?.contentType || "application/octet-stream";
			return { type, media: { schema: binary(type) } };
		}
	}
	return undefined;
}

/** Body variants become named examples, with the selected one first. */
function requestBody(body: HttpRequestDetails["body"]): Json | undefined {
	if (!body) return undefined;
	const variants = Array.isArray(body) ? [...body].sort((a, b) => Number(!!b.selected) - Number(!!a.selected)) : [{ title: "", body }];
	const content: Json = {};
	for (const variant of variants) {
		const entry = bodyMedia(variant.body);
		if (!entry) continue;
		const existing = content[entry.type] as Json | undefined;
		if (!existing) {
			content[entry.type] = { ...entry.media };
			if (variants.length > 1 && entry.media.example !== undefined) {
				const media = content[entry.type] as Json;
				media.examples = { [exampleKey(variant.title, {})]: namedExample(variant.title, entry.media.example) };
				delete media.example;
			}
		} else if (entry.media.example !== undefined) {
			const examples = (existing.examples ??= {}) as Json;
			examples[exampleKey(variant.title, examples)] = namedExample(variant.title, entry.media.example);
		}
	}
	return Object.keys(content).length ? { content } : undefined;
}

const namedExample = (summary: string | undefined, value: unknown): Json => (summary ? { summary, value } : { value });

function exampleKey(title: string, taken: Json): string {
	const base = title.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "example";
	let key = base;
	for (let i = 2; key in taken; i++) key = `${base}-${i}`;
	return key;
}

/** Saved examples become responses; without any, a default response keeps the document valid. */
function responses(examples: readonly HttpRequestExample[]): Json {
	const out: Json = {};
	for (const example of examples) {
		const response = example.response;
		if (!response) continue;
		const status = response.status && response.status >= 100 && response.status <= 599 ? String(response.status) : "default";
		const entry = (out[status] ??= { description: response.statusText || example.name || "Response" }) as Json;
		const body = response.body;
		if (!body || body.data === undefined) continue;
		const declared = response.headers?.find((h) => h.name.toLowerCase() === "content-type")?.value.split(";")[0]?.trim();
		const type = declared || EXAMPLE_TYPES[body.type] || "application/octet-stream";
		let value: unknown = body.data;
		let schema: Json | undefined;
		if (type.includes("json")) {
			const parsed = parseJsonExample(body.data);
			if (parsed.ok) {
				value = parsed.value;
				schema = inferSchema(parsed.value);
			}
		}
		const content = (entry.content ??= {}) as Json;
		const media = (content[type] ??= schema ? { schema } : {}) as Json;
		const examples = (media.examples ??= {}) as Json;
		examples[exampleKey(example.name ?? "", examples)] = namedExample(example.name, value);
	}
	if (!Object.keys(out).length) out.default = { description: "Response" };
	return out;
}
