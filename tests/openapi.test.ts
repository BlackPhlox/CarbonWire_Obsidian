import { describe, expect, it } from "vitest";
import { inferSchema, parseJsonExample, splitUrl, toOpenApi, type OpenApiSource } from "../src/core/export/openapi";

/** Walks the generated JSON by keys, so assertions can compare any part of it. */
function at(value: unknown, ...keys: (string | number)[]): unknown {
	let current = value;
	for (const key of keys) {
		if (current === null || typeof current !== "object") throw new Error(`No ${String(key)} in ${JSON.stringify(current)}`);
		current = (current as Record<string | number, unknown>)[key];
	}
	return current;
}

describe("splitUrl", () => {
	it("separates the server, an OpenAPI path and the query", () => {
		expect(splitUrl("{{baseUrl}}/users/:id?active=true&q=a%20b#top")).toEqual({ server: "{{baseUrl}}", path: "/users/{id}", query: [["active", "true"], ["q", "a b"]] });
		expect(splitUrl("https://api.example.com/v1/users/{{userId}}/posts")).toEqual({ server: "https://api.example.com", path: "/v1/users/{userId}/posts", query: [] });
		expect(splitUrl("api.example.com/health")).toEqual({ server: "https://api.example.com", path: "/health", query: [] });
		expect(splitUrl("https://{{tenant}}.example.com")).toEqual({ server: "https://{{tenant}}.example.com", path: "/", query: [] });
		expect(splitUrl("/relative")).toEqual({ path: "/relative", query: [] });
	});
});

describe("examples", () => {
	it("parses JSON with bare variables and infers a schema", () => {
		const parsed = parseJsonExample('{"name": "{{name}}", "age": {{age}}, "tags": ["a"], "score": 1.5, "ok": true, "none": null}');
		expect(parsed).toEqual({ ok: true, value: { name: "{{name}}", age: "{{age}}", tags: ["a"], score: 1.5, ok: true, none: null } });
		expect(inferSchema({ id: 1, tags: ["a"], score: 1.5, none: null })).toEqual({
			type: "object",
			properties: { id: { type: "integer" }, tags: { type: "array", items: { type: "string" } }, score: { type: "number" }, none: { type: "null" } },
		});
		expect(parseJsonExample("{not json")).toEqual({ ok: false });
	});
});

const source: OpenApiSource = {
	title: "Petstore",
	version: "2.0.0",
	docs: "All about pets.",
	chain: [{ headers: [{ name: "X-Client", value: "carbonwire" }, { name: "Accept", value: "application/json" }], auth: { type: "bearer", token: "{{token}}" } }],
	variables: new Map([
		["baseUrl", "{{host}}/v2"],
		["host", "https://petstore.example.com"],
	]),
	items: [
		{
			kind: "folder",
			folder: {
				name: "Pets",
				docs: { type: "text/markdown", content: "Everything about your pets" },
				defaults: { auth: "inherit" },
				items: [
					{
						kind: "request",
						name: "List pets",
						request: {
							http: {
								method: "GET",
								url: "{{baseUrl}}/pets?limit=10",
								params: [
									{ name: "limit", value: "10", type: "query", description: "How many to return" },
									{ name: "status", value: "sold", type: "query", disabled: true },
								],
								auth: "inherit",
							},
							examples: [
								{
									name: "Two pets",
									response: { status: 200, statusText: "OK", headers: [{ name: "Content-Type", value: "application/json; charset=utf-8" }], body: { type: "json", data: '[{"id": 1, "name": "Rex"}]' } },
								},
							],
						},
					},
					{
						kind: "request",
						name: "Get pet",
						request: { docs: "Returns one pet.", http: { method: "GET", url: "{{baseUrl}}/pets/:petId", params: [{ name: "petId", value: "42", type: "path" }], auth: "inherit" } },
					},
					{
						kind: "request",
						name: "Create pet",
						request: {
							http: {
								method: "POST",
								url: "{{baseUrl}}/pets",
								headers: [{ name: "Content-Type", value: "application/json" }, { name: "X-Request-Id", value: "{{$guid}}" }],
								body: [
									{ title: "Dog", selected: true, body: { type: "json", data: '{"name": "Rex", "age": {{age}}}' } },
									{ title: "Cat", body: { type: "json", data: '{"name": "Tom", "age": 3}' } },
								],
								auth: "inherit",
							},
						},
					},
					{ kind: "request", name: "List pets again", request: { http: { method: "GET", url: "{{baseUrl}}/pets" } } },
					{
						kind: "folder",
						folder: {
							name: "Photos",
							items: [
								{
									kind: "request",
									name: "Upload photo",
									request: {
										http: {
											method: "POST",
											url: "{{baseUrl}}/pets/{{petId}}/photo",
											body: { type: "multipart-form", data: [{ name: "file", type: "file", value: "photo.png", contentType: "image/png" }, { name: "caption", type: "text", value: "Good boy" }] },
											auth: { type: "apikey", key: "X-Api-Key", value: "{{apiKey}}", placement: "header" },
										},
									},
								},
							],
						},
					},
				],
			},
		},
		{
			kind: "request",
			name: "Get token",
			request: {
				http: {
					method: "POST",
					url: "https://auth.example.com/oauth/token",
					body: { type: "form-urlencoded", data: [{ name: "grant_type", value: "client_credentials" }] },
					auth: { type: "oauth2", flow: "client_credentials", accessTokenUrl: "{{host}}/token", credentials: { clientId: "id", clientSecret: "shh" }, scope: "read write" },
				},
			},
		},
		{ kind: "request", name: "Subscribe", request: { http: { method: "SUBSCRIBE", url: "{{baseUrl}}/events" } } },
		{ kind: "request", name: "Get pet", request: { http: { method: "DELETE", url: "{{baseUrl}}/pets/:petId", auth: { type: "basic", username: "u", password: "p" } } } },
	],
};

describe("toOpenApi", () => {
	const { document, operations, warnings } = toOpenApi(source);
	const doc = (...keys: (string | number)[]) => at(document, ...keys);

	it("describes the API and its servers", () => {
		expect(doc("openapi")).toBe("3.1.0");
		expect(doc("info")).toEqual({ title: "Petstore", version: "2.0.0", description: "All about pets." });
		expect(doc("servers")).toEqual([{ url: "{baseUrl}", variables: { baseUrl: { default: "https://petstore.example.com/v2" } } }]);
		expect(doc("paths", "/oauth/token", "post", "servers")).toEqual([{ url: "https://auth.example.com" }]);
		expect(doc("tags")).toEqual([{ name: "Pets", description: "Everything about your pets" }, { name: "Pets / Photos" }]);
		expect(operations).toBe(6);
	});

	it("turns query, path and inherited header values into parameters, without reserved headers", () => {
		const list = doc("paths", "/pets", "get");
		expect(at(list, "operationId")).toBe("listPets");
		expect(at(list, "tags")).toEqual(["Pets"]);
		expect(at(list, "parameters")).toEqual([
			{ name: "limit", in: "query", required: false, description: "How many to return", schema: { type: "string" }, example: "10" },
			{ name: "status", in: "query", required: false, schema: { type: "string" }, example: "sold" },
			{ name: "X-Client", in: "header", required: false, schema: { type: "string" }, example: "carbonwire" },
		]);
		const get = doc("paths", "/pets/{petId}", "get");
		expect(at(get, "description")).toBe("Returns one pet.");
		expect(at(get, "parameters", 0)).toEqual({ name: "petId", in: "path", required: true, schema: { type: "string" }, example: "42" });
		const photo = doc("paths", "/pets/{petId}/photo", "post");
		expect(at(photo, "tags")).toEqual(["Pets / Photos"]);
		expect(at(photo, "parameters", 0)).toEqual({ name: "petId", in: "path", required: true, schema: { type: "string" } });
	});

	it("keeps variables out of examples", () => {
		const create = doc("paths", "/pets", "post");
		expect((at(create, "parameters") as Record<string, unknown>[]).find((p) => p.name === "X-Request-Id")).not.toHaveProperty("example");
		expect((at(create, "parameters") as Record<string, unknown>[]).some((p) => p.name === "Content-Type")).toBe(false);
	});

	it("describes bodies, with variants as named examples", () => {
		const json = doc("paths", "/pets", "post", "requestBody", "content", "application/json");
		expect(at(json, "schema")).toEqual({ type: "object", properties: { name: { type: "string" }, age: { type: "string" } } });
		expect(at(json, "examples")).toEqual({ Dog: { summary: "Dog", value: { name: "Rex", age: "{{age}}" } }, Cat: { summary: "Cat", value: { name: "Tom", age: 3 } } });
		const multipart = doc("paths", "/pets/{petId}/photo", "post", "requestBody", "content", "multipart/form-data");
		expect(at(multipart, "schema", "properties", "file")).toEqual({ type: "string", format: "binary", contentMediaType: "image/png" });
		expect(at(multipart, "example")).toEqual({ caption: "Good boy" });
		expect(doc("paths", "/oauth/token", "post", "requestBody", "content", "application/x-www-form-urlencoded", "example")).toEqual({ grant_type: "client_credentials" });
	});

	it("turns saved examples into responses", () => {
		const ok = doc("paths", "/pets", "get", "responses", "200");
		expect(at(ok, "description")).toBe("OK");
		expect(at(ok, "content", "application/json", "schema")).toEqual({ type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } });
		expect(at(ok, "content", "application/json", "examples", "Two-pets")).toEqual({ summary: "Two pets", value: [{ id: 1, name: "Rex" }] });
		expect(doc("paths", "/pets/{petId}", "get", "responses")).toEqual({ default: { description: "Response" } });
	});

	it("describes auth as security schemes without credentials", () => {
		expect(doc("components", "securitySchemes")).toEqual({
			bearerAuth: { type: "http", scheme: "bearer" },
			apiKeyHeader: { type: "apiKey", in: "header", name: "X-Api-Key" },
			oauth2: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://petstore.example.com/token", scopes: { read: "", write: "" } } } },
			basicAuth: { type: "http", scheme: "basic" },
		});
		expect(doc("paths", "/pets", "get", "security")).toEqual([{ bearerAuth: [] }]);
		expect(doc("paths", "/oauth/token", "post", "security")).toEqual([{ oauth2: ["read", "write"] }]);
		expect(doc("paths", "/pets", "post", "security")).toEqual([{ bearerAuth: [] }]);
		expect(JSON.stringify(document)).not.toMatch(/shh|"p"|apiKey}}/);
	});

	it("gives unique operation IDs and reports what it couldn't export", () => {
		expect(doc("paths", "/pets/{petId}", "delete", "operationId")).toBe("getPet2");
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain('"List pets again" has the same method and path');
		expect(warnings[1]).toContain('"Subscribe" uses SUBSCRIBE');
	});
});
