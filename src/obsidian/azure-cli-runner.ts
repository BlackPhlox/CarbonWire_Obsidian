import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { CommandRunner } from "../core/azure/cli";

const isWindows = process.platform === "win32";

/** Inside a Flatpak sandbox the host's az isn't visible, so it is started through flatpak-spawn. */
function inFlatpak(): boolean {
	return !isWindows && (!!process.env.FLATPAK_ID || existsSync("/.flatpak-info"));
}

/**
 * Apps started from the dock or a desktop launcher often get a minimal PATH, without where
 * Homebrew, pip or the Windows installer put az, so those places are searched too.
 */
export function searchDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
	const sep = platform === "win32" ? ";" : ":";
	const fromEnv = (env.PATH ?? env.Path ?? "").split(sep).filter(Boolean);
	const extra =
		platform === "win32"
			? [
					`${env.ProgramFiles ?? "C:\\Program Files"}\\Microsoft SDKs\\Azure\\CLI2\\wbin`,
					`${env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Microsoft SDKs\\Azure\\CLI2\\wbin`,
					`${env.LOCALAPPDATA ?? `${home}\\AppData\\Local`}\\Programs\\Microsoft SDKs\\Azure\\CLI2\\wbin`,
				]
			: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", `${home}/.local/bin`, "/home/linuxbrew/.linuxbrew/bin", "/snap/bin"];
	return [...new Set([...fromEnv, ...extra])];
}

export interface Launch {
	file: string;
	args: string[];
	/** Only for a .cmd that has to go through cmd.exe. */
	shell: boolean;
}

/**
 * Works out how to start az. On Windows the installer's az.cmd only runs
 * `..\python.exe -IBm azure.cli`, and it finds that python from its own location, which cmd.exe
 * gets wrong when the script is found through PATH (az then prints "Failed to load python
 * executable" and exits with code 1). So that python is started directly when it is there, and
 * az.cmd is otherwise started by its full path.
 */
export function planLaunch(
	platform: NodeJS.Platform,
	configured: string,
	args: readonly string[],
	dirs: readonly string[],
	exists: (file: string) => boolean,
): Launch {
	const p = platform === "win32" ? path.win32 : path.posix;
	let file = configured.trim();
	if (platform !== "win32") {
		if (!file) file = dirs.map((d) => p.join(d, "az")).find(exists) ?? "az";
		return { file, args: [...args], shell: false };
	}

	if (file && !/\.[A-Za-z0-9]+$/.test(file)) file += ".cmd";
	if (!file) file = dirs.map((d) => p.join(d, "az.cmd")).find(exists) ?? "az.cmd";
	if (p.isAbsolute(file)) {
		const python = p.join(p.dirname(file), "..", "python.exe");
		if (/\.cmd$/i.test(file) && exists(python)) return { file: python, args: ["-IBm", "azure.cli", ...args], shell: false };
	}
	// Node starts .cmd files only through a shell. The arguments are fixed words, a URL and a
	// checked tenant name, so nothing in them needs escaping.
	const shell = /\.(cmd|bat)$/i.test(file);
	return { file: shell ? `"${file}"` : file, args: [...args], shell };
}

/**
 * The child's environment with the wider search path. Windows names the variable "Path" and
 * treats names case-insensitively, so every spelling of it is replaced rather than duplicated.
 */
function childEnv(dirs: readonly string[]): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (key.toUpperCase() !== "PATH") env[key] = value;
	return { ...env, PATH: dirs.join(path.delimiter), AZURE_CORE_ONLY_SHOW_ERRORS: "true", AZURE_CORE_NO_COLOR: "true" };
}

const FLATPAK_DENIED = /org\.freedesktop\.Flatpak|Portal call failed|ServiceUnknown|AccessDenied/i;
const FLATPAK_NOT_FOUND = /Failed to start command|No such file or directory/i;

/** Runs the Azure CLI at `configuredPath()`, or finds az when it is empty. */
export function azureCliRunner(configuredPath: () => string): CommandRunner {
	return (args, signal) =>
		new Promise((resolve) => {
			const flatpak = inFlatpak();
			const dirs = searchDirs(process.platform, process.env, homedir());
			let { file, args: argv, shell } = flatpak
				? { file: configuredPath().trim() || "az", args: [...args], shell: false }
				: planLaunch(process.platform, configuredPath(), args, dirs, existsSync);
			if (flatpak) {
				argv = ["--host", file, ...argv];
				file = "flatpak-spawn";
			}
			execFile(
				file,
				argv,
				{ env: childEnv(dirs), timeout: 60_000, maxBuffer: 1_000_000, windowsHide: true, shell, signal },
				(error, stdout, stderr) => {
					if (!error) return resolve({ stdout, stderr, code: 0 });
					if (typeof error.code === "string") return resolve({ stdout, stderr, code: null, error: error.code === "ABORT_ERR" ? "cancelled" : error.code });
					if (flatpak && FLATPAK_DENIED.test(stderr)) {
						return resolve({ stdout, stderr, code: null, error: "Obsidian's Flatpak can't start programs outside its sandbox; allow it with `flatpak override --user --talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian`" });
					}
					if (flatpak && FLATPAK_NOT_FOUND.test(stderr)) return resolve({ stdout, stderr, code: null, error: "az wasn't found on the host" });
					if (error.killed) return resolve({ stdout, stderr: stderr || "az didn't answer within a minute.", code: 1 });
					resolve({ stdout, stderr, code: typeof error.code === "number" ? error.code : 1 });
				},
			);
		});
}
