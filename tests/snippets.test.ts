import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SNIPPETS, toSnippet } from "../src/core/export/snippets";
import type { HttpRequest } from "../src/core/model";
import { buildRequest } from "../src/core/request-builder";

interface Seen {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

let server: http.Server;
let base: string;
const seen: Seen[] = [];
const dir = mkdtempSync(join(tmpdir(), "carbonwire-snippets-"));
writeFileSync(join(dir, "photo.png"), "PNGDATA");
const files = { filePath: (p: string) => join(dir, p) };

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
			res.writeHead(201, { "Content-Type": "application/json" }).end('{"ok":true}');
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const json = (): HttpRequest => ({
	http: {
		method: "POST",
		url: `${base}/users?tag=it's "quoted"`,
		headers: [{ name: "X-Note", value: 'it\'s "both"' }],
		body: { type: "json", data: '{"name": "Ann\\nLee", "emoji": "✓"}' },
		auth: { type: "bearer", token: "t0k" },
	},
	settings: { timeout: 5000 },
});

const multipart = (): HttpRequest => ({
	http: {
		method: "POST",
		url: `${base}/upload`,
		body: { type: "multipart-form", data: [{ name: "caption", type: "text", value: "Good boy" }, { name: "file", type: "file", value: "photo.png", contentType: "image/png" }] },
	},
});

function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile(file, args, { timeout: 20_000 }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout))),
	);
}

async function execute(language: "python" | "javascript", request: HttpRequest): Promise<{ stdout: string; seen: Seen }> {
	const code = toSnippet(language, buildRequest(request, [], new Map()), files);
	const path = join(dir, language === "python" ? "snippet.py" : "snippet.mjs");
	writeFileSync(path, code);
	const before = seen.length;
	const stdout = await run(language === "python" ? "python3" : process.execPath, [path]);
	expect(seen.length).toBe(before + 1);
	return { stdout, seen: seen.at(-1)! };
}

describe.each(["python", "javascript"] as const)("%s snippets, run for real", (language) => {
	it("send the method, URL, headers and JSON body exactly", async () => {
		const { stdout, seen } = await execute(language, json());
		expect(stdout.split("\n")[0]).toBe("201");
		expect(seen.method).toBe("POST");
		expect(decodeURIComponent(seen.url)).toBe(`/users?tag=it's "quoted"`);
		expect(seen.headers["x-note"]).toBe('it\'s "both"');
		expect(seen.headers.authorization).toBe("Bearer t0k");
		expect(seen.headers["content-type"]).toBe("application/json");
		expect(seen.body).toBe('{"name": "Ann\\nLee", "emoji": "✓"}');
	});

	it("send multipart fields and files", async () => {
		const { seen } = await execute(language, multipart());
		expect(seen.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
		expect(seen.body).toContain('name="caption"');
		expect(seen.body).toContain("Good boy");
		expect(seen.body).toMatch(/name="file"; filename="photo.png"/);
		expect(seen.body).toContain("Content-Type: image/png");
		expect(seen.body).toContain("PNGDATA");
	});
});

describe("C# and PowerShell snippets", () => {
	const resolved = buildRequest(json(), [], new Map());

	it("build an HttpRequestMessage, with Content-Type on the content", () => {
		const code = toSnippet("csharp", resolved, { ...files, insecure: true });
		expect(code).toContain(`new HttpMethod("POST")`);
		expect(code).toContain(`request.Headers.TryAddWithoutValidation("X-Note", "it's \\"both\\"");`);
		expect(code).toContain(`request.Content = new StringContent("{\\"name\\": \\"Ann\\\\nLee\\", \\"emoji\\": \\"✓\\"}");`);
		expect(code).toContain(`request.Content.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse("application/json");`);
		expect(code).toContain("client.Timeout = TimeSpan.FromMilliseconds(5000);");
		expect(code).toContain("DangerousAcceptAnyServerCertificateValidator");
		expect(code).not.toContain(`request.Headers.TryAddWithoutValidation("Content-Type"`);
		const form = toSnippet("csharp", buildRequest(multipart(), [], new Map()), files);
		expect(form).toContain(`form.Add(part1, "file", "photo.png");`);
	});

	it("use Invoke-WebRequest with single-quoted strings", () => {
		const code = toSnippet("powershell", resolved, files);
		expect(code).toContain(`'X-Note' = 'it''s "both"'`);
		expect(code).toContain("-ContentType 'application/json'");
		expect(code).toContain("-TimeoutSec 5");
		expect(code).not.toMatch(/'Content-Type' =/);
		const form = toSnippet("powershell", buildRequest(multipart(), [], new Map()), files);
		expect(form).toContain(`'file' = Get-Item -LiteralPath '${join(dir, "photo.png")}'`);
	});

	it("note digest auth they can't do", () => {
		const digest = buildRequest({ http: { url: "https://x.test", auth: { type: "digest", username: "u", password: "p" } } }, [], new Map());
		for (const language of ["csharp", "python", "javascript", "powershell"] as const) expect(toSnippet(language, digest, files)).toContain("Digest auth isn't included");
		expect(Object.keys(SNIPPETS)).toEqual(["curl", "csharp", "python", "javascript", "powershell"]);
	});
});
