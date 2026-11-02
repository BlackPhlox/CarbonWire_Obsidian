/** Runs a program with arguments and collects its output; `code` is null if it couldn't start. */
export type CommandRunner = (args: readonly string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string; code: number | null; error?: string }>;

export interface CliToken {
	accessToken: string;
	/** Epoch milliseconds. */
	expiresAt: number;
}

export interface CliAccount {
	user?: string;
	tenant?: string;
	subscription?: string;
}

export class AzureCliError extends Error {
	constructor(message: string, readonly code: "not_found" | "not_logged_in" | "failed") {
		super(message);
		this.name = "AzureCliError";
	}
}

/** Tenants that mean "whichever one az is signed in to", so no --tenant is passed. */
const ANY_TENANT = new Set(["", "organizations", "common", "consumers"]);
/** Tenant IDs and domains only, since on Windows the arguments pass through a shell. */
const TENANT = /^[A-Za-z0-9.-]+$/;

export function tokenArgs(scope: string, tenant: string): string[] {
	const args = ["account", "get-access-token", "--scope", scope, "--output", "json"];
	const t = tenant.trim();
	if (ANY_TENANT.has(t.toLowerCase())) return args;
	if (!TENANT.test(t)) throw new AzureCliError(`"${t}" isn't a tenant ID or domain.`, "failed");
	return [...args, "--tenant", t];
}

/**
 * Reads `az account get-access-token` output. Newer versions give `expires_on` in epoch seconds;
 * older ones only `expiresOn`, a local time without a zone.
 */
export function parseCliToken(stdout: string): CliToken {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		throw new AzureCliError("The Azure CLI didn't return a token. Update it with `az upgrade`.", "failed");
	}
	if (typeof data.accessToken !== "string" || !data.accessToken) throw new AzureCliError("The Azure CLI returned no access token.", "failed");
	const epoch = Number(data.expires_on);
	let expiresAt = Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : NaN;
	if (Number.isNaN(expiresAt) && typeof data.expiresOn === "string") expiresAt = new Date(data.expiresOn.replace(" ", "T")).getTime();
	// Unknown expiry: reuse the token briefly rather than not at all.
	if (!Number.isFinite(expiresAt)) expiresAt = Date.now() + 5 * 60_000;
	return { accessToken: data.accessToken, expiresAt };
}

export function parseCliAccount(stdout: string): CliAccount {
	try {
		const data = JSON.parse(stdout) as { user?: { name?: unknown }; tenantId?: unknown; tenantDefaultDomain?: unknown; name?: unknown };
		const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
		return { user: str(data.user?.name), tenant: str(data.tenantDefaultDomain) ?? str(data.tenantId), subscription: str(data.name) };
	} catch {
		return {};
	}
}

function failure(result: { stdout: string; stderr: string; code: number | null; error?: string }): AzureCliError {
	if (result.code === null) {
		return new AzureCliError(
			`Couldn't run the Azure CLI${result.error ? ` (${result.error})` : ""}. Install it, or set its full path in CarbonWire settings.`,
			"not_found",
		);
	}
	// Some failures, such as az.cmd not finding its python, are only printed to stdout.
	const output = result.stderr.trim() || result.stdout.trim();
	if (/is not recognized as an internal or external command|command not found/i.test(output)) {
		return new AzureCliError("Couldn't find the Azure CLI. Install it, or set its full path in CarbonWire settings.", "not_found");
	}
	if (/az login|not logged in|no subscription found|refresh token has expired|AADSTS(50173|70043|700082)/i.test(output)) {
		return new AzureCliError("The Azure CLI isn't signed in, or its sign-in expired. Run `az login` in a terminal, then try again.", "not_logged_in");
	}
	// az prints "ERROR: <message>" followed by hints; the first line is what matters.
	const first = output.split(/\r?\n/).find((l) => l.trim())?.replace(/^ERROR:\s*/, "");
	return new AzureCliError(
		first ? `The Azure CLI failed (exit code ${result.code}): ${first}` : `The Azure CLI exited with code ${result.code} without saying why. Check that \`az account get-access-token\` works in a terminal.`,
		"failed",
	);
}

/** Gets tokens from the user's own `az login`, so CarbonWire never handles a sign-in or refresh token. */
export class AzureCliCredential {
	constructor(private readonly run: CommandRunner) {}

	async token(scope: string, tenant: string, signal?: AbortSignal): Promise<CliToken> {
		const result = await this.run(tokenArgs(scope, tenant), signal);
		if (result.code !== 0) throw failure(result);
		return parseCliToken(result.stdout);
	}

	async account(signal?: AbortSignal): Promise<CliAccount> {
		const result = await this.run(["account", "show", "--output", "json"], signal);
		if (result.code !== 0) throw failure(result);
		return parseCliAccount(result.stdout);
	}
}
