import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { AzureCliCredential, parseCliAccount, parseCliToken, tokenArgs, type CommandRunner } from "../src/core/azure/cli";
import { AZURE_CLI_CLIENT_ID, KEY_VAULT_SCOPE, type EntraClient } from "../src/core/azure/entra";
import { azureCliRunner } from "../src/obsidian/azure-cli-runner";
import { MicrosoftAccount, type MicrosoftAuthMode } from "../src/obsidian/microsoft-account";

describe("Azure CLI arguments and output", () => {
	it("passes a tenant only when one is named, and refuses anything that isn't a tenant", () => {
		expect(tokenArgs(KEY_VAULT_SCOPE, "organizations")).toEqual(["account", "get-access-token", "--scope", KEY_VAULT_SCOPE, "--output", "json"]);
		expect(tokenArgs(KEY_VAULT_SCOPE, " ").at(-1)).toBe("json");
		expect(tokenArgs(KEY_VAULT_SCOPE, "contoso.onmicrosoft.com").slice(-2)).toEqual(["--tenant", "contoso.onmicrosoft.com"]);
		expect(() => tokenArgs(KEY_VAULT_SCOPE, "x & calc")).toThrow("isn't a tenant");
	});

	it("reads tokens from new and old versions", () => {
		expect(parseCliToken(JSON.stringify({ accessToken: "at", expires_on: 1_900_000_000, expiresOn: "2030-03-17 19:46:40.000000" }))).toEqual({ accessToken: "at", expiresAt: 1_900_000_000_000 });
		const old = parseCliToken(JSON.stringify({ accessToken: "at", expiresOn: "2030-03-17 19:46:40.000000" }));
		expect(old.expiresAt).toBe(new Date("2030-03-17T19:46:40.000").getTime());
		expect(() => parseCliToken("WARNING: something")).toThrow("didn't return a token");
	});

	it("reads the account", () => {
		expect(parseCliAccount(JSON.stringify({ name: "Dev", tenantId: "t-id", tenantDefaultDomain: "contoso.onmicrosoft.com", user: { name: "ada@contoso.com", type: "user" } }))).toEqual({
			user: "ada@contoso.com",
			tenant: "contoso.onmicrosoft.com",
			subscription: "Dev",
		});
	});

	it("explains failures", async () => {
		const run = (result: Awaited<ReturnType<CommandRunner>>): CommandRunner => () => Promise.resolve(result);
		await expect(new AzureCliCredential(run({ stdout: "", stderr: "", code: null, error: "ENOENT" })).token(KEY_VAULT_SCOPE, "")).rejects.toThrow("Couldn't run the Azure CLI (ENOENT)");
		await expect(new AzureCliCredential(run({ stdout: "", stderr: "ERROR: Please run 'az login' to setup account.", code: 1 })).token(KEY_VAULT_SCOPE, "")).rejects.toThrow("Run `az login`");
		await expect(new AzureCliCredential(run({ stdout: "", stderr: "ERROR: Tenant 'x' not found.\nCheck your tenant.", code: 1 })).account()).rejects.toThrow("The Azure CLI failed: Tenant 'x' not found.");
	});
});

describe("azureCliRunner", () => {
	const dir = mkdtempSync(join(tmpdir(), "carbonwire-az-"));
	const az = join(dir, "az");
	writeFileSync(az, `#!/bin/sh\nif [ "$1" = "account" ] && [ "$2" = "get-access-token" ]; then echo '{"accessToken":"from-cli","expires_on":"1900000000","args":"'"$*"'"}'; else echo "ERROR: Please run 'az login' to setup account." >&2; exit 1; fi\n`);
	chmodSync(az, 0o755);

	it.skipIf(process.platform === "win32")("runs az and reads its token", async () => {
		const credential = new AzureCliCredential(azureCliRunner(() => az));
		expect(await credential.token(KEY_VAULT_SCOPE, "contoso.onmicrosoft.com")).toEqual({ accessToken: "from-cli", expiresAt: 1_900_000_000_000 });
		await expect(credential.account()).rejects.toThrow("Run `az login`");
	});

	it("reports a missing CLI", async () => {
		await expect(new AzureCliCredential(azureCliRunner(() => join(dir, "missing-az"))).token(KEY_VAULT_SCOPE, "")).rejects.toThrow("Couldn't run the Azure CLI");
	});
});

describe("MicrosoftAccount with the Azure CLI", () => {
	function setup() {
		let mode: MicrosoftAuthMode = "azure-cli";
		let calls = 0;
		const run = vi.fn<CommandRunner>(() => Promise.resolve({ stdout: JSON.stringify({ accessToken: `cli-${++calls}`, expires_on: Math.floor(Date.now() / 1000) + 3600 }), stderr: "", code: 0 }));
		const secrets = new Map<string, string>();
		const app = { secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, v: string) => void secrets.set(id, v) } } as unknown as App;
		const client = vi.fn<() => Promise<EntraClient>>(() => Promise.reject(new Error("browser sign-in shouldn't be used")));
		const account = new MicrosoftAccount(app, {
			client,
			config: () => ({ tenant: "organizations", clientId: AZURE_CLI_CLIENT_ID, rejectUnauthorized: true }),
			mode: () => mode,
			cli: () => new AzureCliCredential(run),
			changed: () => undefined,
		});
		return { account, run, client, setMode: (m: MicrosoftAuthMode) => (mode = m) };
	}

	it("gets one token from az for concurrent sends and reuses it", async () => {
		const { account, run, client } = setup();
		const tokens = await Promise.all([account.accessToken(), account.accessToken(), account.accessToken()]);
		expect(tokens).toEqual(["cli-1", "cli-1", "cli-1"]);
		expect(await account.accessToken()).toBe("cli-1");
		expect(run).toHaveBeenCalledTimes(1);
		expect(client).not.toHaveBeenCalled();
		expect(account.isSignedIn()).toBe(false);
	});

	it("asks az again after settings change, and stops using its token in browser mode", async () => {
		const { account, run, setMode } = setup();
		await account.accessToken();
		account.configChanged();
		expect(await account.accessToken()).toBe("cli-2");
		setMode("browser");
		await expect(account.accessToken(undefined, false)).rejects.toThrow("Sign in to Microsoft");
		expect(run).toHaveBeenCalledTimes(2);
	});
});
