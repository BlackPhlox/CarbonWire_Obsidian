import { findHeader } from "../headers";
import type { Header } from "../model";
import type { MultipartPart, ResolvedRequest } from "../request-builder";
import { toCurl, type CurlOptions } from "./curl";

export type SnippetLanguage = "curl" | "csharp" | "python" | "javascript" | "powershell";

export type SnippetOptions = CurlOptions;

interface Generator {
	label: string;
	generate(request: ResolvedRequest, options: SnippetOptions): string;
}

/** Everything sent is in the snippet, resolved: variables, inherited headers and auth. */
export const SNIPPETS: Record<SnippetLanguage, Generator> = {
	curl: { label: "cURL", generate: toCurl },
	csharp: { label: "C# (HttpClient)", generate: toCSharp },
	python: { label: "Python (requests)", generate: toPython },
	javascript: { label: "JavaScript (fetch)", generate: toJavaScript },
	powershell: { label: "PowerShell", generate: toPowerShell },
};

export function toSnippet(language: SnippetLanguage, request: ResolvedRequest, options: SnippetOptions): string {
	return SNIPPETS[language].generate(request, options);
}

const isContentType = (name: string) => name.toLowerCase() === "content-type";
const fileName = (path: string) => path.split(/[\\/]/).pop() || "file";
/** A double-quoted literal; JSON's escapes are valid in C#, Python and JavaScript strings. */
const dq = (value: string) => JSON.stringify(value);
/** A PowerShell single-quoted literal, which only needs ' doubled. */
const sq = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Headers to send, leaving Content-Type to the body when the client library sets it itself. */
function sentHeaders(request: ResolvedRequest): Header[] {
	return request.body?.kind === "multipart" ? request.headers.filter(([n]) => !isContentType(n)) : request.headers;
}

function contentType(request: ResolvedRequest): string | undefined {
	return findHeader(request.headers, "content-type") ?? (request.body && request.body.kind !== "multipart" ? request.body.contentType : undefined);
}

function digestNote(request: ResolvedRequest, comment: string): string[] {
	return request.pendingAuth?.type === "digest" ? [`${comment} Digest auth isn't included: the client has to answer the server's challenge itself.`] : [];
}

function toCSharp(request: ResolvedRequest, options: SnippetOptions): string {
	const { body, settings } = request;
	const lines: string[] = [...digestNote(request, "//")];
	const handler = [`AllowAutoRedirect = ${settings.followRedirects}`];
	if (settings.followRedirects) handler.push(`MaxAutomaticRedirections = ${Math.max(1, settings.maxRedirects)}`);
	if (findHeader(request.headers, "accept-encoding")) handler.push("AutomaticDecompression = System.Net.DecompressionMethods.All");
	if (options.insecure) handler.push("ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator");
	lines.push(`using var client = new HttpClient(new HttpClientHandler { ${handler.join(", ")} });`);
	if (settings.timeout > 0) lines.push(`client.Timeout = TimeSpan.FromMilliseconds(${settings.timeout});`);
	lines.push(`using var request = new HttpRequestMessage(new HttpMethod(${dq(request.method)}), ${dq(request.url)});`);

	switch (body?.kind) {
		case "text":
			lines.push(`request.Content = new StringContent(${dq(body.text)});`);
			break;
		case "file":
			lines.push(`request.Content = new StreamContent(File.OpenRead(${dq(options.filePath(body.filePath))}));`);
			break;
		case "multipart":
			lines.push("var form = new MultipartFormDataContent();");
			body.parts.forEach((part, i) => lines.push(...csharpPart(part, i, options)));
			lines.push("request.Content = form;");
			break;
	}
	// HttpClient keeps Content-* headers on the content, not the request.
	for (const [name, value] of sentHeaders(request)) {
		if (body && isContentType(name)) lines.push(`request.Content.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse(${dq(value)});`);
		else if (body && /^content-/i.test(name)) lines.push(`request.Content.Headers.TryAddWithoutValidation(${dq(name)}, ${dq(value)});`);
		else if (!isContentType(name)) lines.push(`request.Headers.TryAddWithoutValidation(${dq(name)}, ${dq(value)});`);
	}
	if (body && body.kind !== "multipart" && !findHeader(request.headers, "content-type")) {
		lines.push(`request.Content.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse(${dq(body.contentType)});`);
	}
	lines.push("", "using var response = await client.SendAsync(request);", "Console.WriteLine((int)response.StatusCode);", "Console.WriteLine(await response.Content.ReadAsStringAsync());");
	return lines.join("\n");
}

function csharpPart(part: MultipartPart, i: number, options: SnippetOptions): string[] {
	if (!("filePath" in part)) {
		const content = `new StringContent(${dq(part.value)})`;
		if (!part.contentType) return [`form.Add(${content}, ${dq(part.name)});`];
		return [`var part${i} = ${content};`, `part${i}.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse(${dq(part.contentType)});`, `form.Add(part${i}, ${dq(part.name)});`];
	}
	const lines = [`var part${i} = new StreamContent(File.OpenRead(${dq(options.filePath(part.filePath))}));`];
	if (part.contentType) lines.push(`part${i}.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse(${dq(part.contentType)});`);
	lines.push(`form.Add(part${i}, ${dq(part.name)}, ${dq(fileName(part.filePath))});`);
	return lines;
}

function toPython(request: ResolvedRequest, options: SnippetOptions): string {
	const { body, settings } = request;
	const head = ["import requests"];
	const args = [dq(request.method), dq(request.url)];
	const headers = sentHeaders(request);
	if (headers.length) args.push(`headers={\n${headers.map(([n, v]) => `        ${dq(n)}: ${dq(v)},`).join("\n")}\n    }`);
	switch (body?.kind) {
		case "text":
			args.push(`data=${dq(body.text)}.encode("utf-8")`);
			break;
		case "file":
			args.push(`data=open(${dq(options.filePath(body.filePath))}, "rb")`);
			break;
		case "multipart": {
			// A list of tuples keeps repeated field names; (None, value) sends a plain field.
			const parts = body.parts.map((part) => {
				const value =
					"filePath" in part
						? `(${dq(fileName(part.filePath))}, open(${dq(options.filePath(part.filePath))}, "rb")${part.contentType ? `, ${dq(part.contentType)}` : ""})`
						: `(None, ${dq(part.value)}${part.contentType ? `, ${dq(part.contentType)}` : ""})`;
				return `        (${dq(part.name)}, ${value}),`;
			});
			args.push(`files=[\n${parts.join("\n")}\n    ]`);
			break;
		}
	}
	if (settings.timeout > 0) args.push(`timeout=${settings.timeout / 1000}`);
	if (!settings.followRedirects) args.push("allow_redirects=False");
	if (options.insecure) args.push("verify=False");
	const lines = [...digestNote(request, "#"), ...head, "", `response = requests.request(\n${args.map((a) => `    ${a},`).join("\n")}\n)`];
	lines.push("print(response.status_code)", "print(response.text)");
	return lines.join("\n");
}

function toJavaScript(request: ResolvedRequest, options: SnippetOptions): string {
	const { body, settings } = request;
	const lines: string[] = [...digestNote(request, "//")];
	const needsFile = body?.kind === "file" || (body?.kind === "multipart" && body.parts.some((p) => "filePath" in p));
	if (needsFile) lines.push('// Node.js: files are read from disk.', 'import { openAsBlob } from "node:fs";', "");
	if (options.insecure) lines.push("// Certificates are verified; for a self-signed server run Node with NODE_TLS_REJECT_UNAUTHORIZED=0.", "");

	const init: string[] = [`method: ${dq(request.method)}`];
	const headers = sentHeaders(request);
	if (headers.length) init.push(`headers: {\n${headers.map(([n, v]) => `    ${dq(n)}: ${dq(v)},`).join("\n")}\n  }`);
	switch (body?.kind) {
		case "text":
			init.push(`body: ${dq(body.text)}`);
			break;
		case "file":
			init.push(`body: await openAsBlob(${dq(options.filePath(body.filePath))})`);
			break;
		case "multipart":
			lines.push("const form = new FormData();");
			for (const part of body.parts) {
				if ("filePath" in part) {
					const type = part.contentType ? `, { type: ${dq(part.contentType)} }` : "";
					lines.push(`form.append(${dq(part.name)}, await openAsBlob(${dq(options.filePath(part.filePath))}${type}), ${dq(fileName(part.filePath))});`);
				} else {
					lines.push(`form.append(${dq(part.name)}, ${dq(part.value)});`);
				}
			}
			lines.push("");
			init.push("body: form");
			break;
	}
	init.push(`redirect: ${dq(settings.followRedirects ? "follow" : "manual")}`);
	if (settings.timeout > 0) init.push(`signal: AbortSignal.timeout(${settings.timeout})`);
	lines.push(`const response = await fetch(${dq(request.url)}, {\n${init.map((i) => `  ${i},`).join("\n")}\n});`, "console.log(response.status);", "console.log(await response.text());");
	return lines.join("\n");
}

/** For PowerShell 7, whose Invoke-WebRequest has -Form, -SkipHttpErrorCheck and -SkipCertificateCheck. */
function toPowerShell(request: ResolvedRequest, options: SnippetOptions): string {
	const { body, settings } = request;
	const lines: string[] = [...digestNote(request, "#")];
	const headers = sentHeaders(request).filter(([n]) => !isContentType(n));
	const args = [`-Uri ${sq(request.url)}`, `-Method ${sq(request.method)}`];
	if (headers.length) {
		lines.push("$headers = [ordered]@{", ...headers.map(([n, v]) => `    ${sq(n)} = ${sq(v)}`), "}");
		args.push("-Headers $headers");
	}
	const type = contentType(request);
	switch (body?.kind) {
		case "text":
			if (type) args.push(`-ContentType ${sq(type)}`);
			lines.push(`$body = ${sq(body.text)}`);
			args.push("-Body $body");
			break;
		case "file":
			if (type) args.push(`-ContentType ${sq(type)}`);
			args.push(`-InFile ${sq(options.filePath(body.filePath))}`);
			break;
		case "multipart": {
			const names = body.parts.map((p) => p.name);
			if (new Set(names).size !== names.length) lines.push("# -Form sends one value per field name; repeated fields need System.Net.Http.MultipartFormDataContent.");
			lines.push(
				"$form = [ordered]@{",
				...body.parts.map((p) => `    ${sq(p.name)} = ${"filePath" in p ? `Get-Item -LiteralPath ${sq(options.filePath(p.filePath))}` : sq(p.value)}`),
				"}",
			);
			args.push("-Form $form");
			break;
		}
	}
	args.push(`-MaximumRedirection ${settings.followRedirects ? settings.maxRedirects : 0}`);
	if (settings.timeout > 0) args.push(`-TimeoutSec ${Math.max(1, Math.ceil(settings.timeout / 1000))}`);
	if (options.insecure) args.push("-SkipCertificateCheck");
	args.push("-SkipHttpErrorCheck");
	if (lines.length) lines.push("");
	lines.push(`$response = Invoke-WebRequest ${args.join(" `\n    ")}`, "$response.StatusCode", "$response.Content");
	return lines.join("\n");
}
