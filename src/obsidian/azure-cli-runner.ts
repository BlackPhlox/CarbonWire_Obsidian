import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
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
function searchPath(): string {
	const extra = isWindows
		? [
				`${process.env.ProgramFiles ?? "C:\\Program Files"}\\Microsoft SDKs\\Azure\\CLI2\\wbin`,
				`${process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Microsoft SDKs\\Azure\\CLI2\\wbin`,
			]
		: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", join(homedir(), ".local", "bin"), "/home/linuxbrew/.linuxbrew/bin", "/snap/bin"];
	return [process.env.PATH ?? "", ...extra].filter(Boolean).join(delimiter);
}

const FLATPAK_DENIED = /org\.freedesktop\.Flatpak|Portal call failed|ServiceUnknown|AccessDenied/i;
const FLATPAK_NOT_FOUND = /Failed to start command|No such file or directory/i;

/** Runs the Azure CLI at `path()`, or `az` from PATH when it is empty. */
export function azureCliRunner(path: () => string): CommandRunner {
	return (args, signal) =>
		new Promise((resolve) => {
			const flatpak = inFlatpak();
			let file = path().trim() || (isWindows ? "az.cmd" : "az");
			let argv = [...args];
			// Node only starts .cmd files through a shell. The arguments are fixed words, a URL and a
			// checked tenant name, so nothing in them needs escaping.
			const shell = isWindows && /\.(cmd|bat)$/i.test(file);
			if (shell) file = `"${file}"`;
			if (flatpak) {
				argv = ["--host", file, ...argv];
				file = "flatpak-spawn";
			}
			execFile(
				file,
				argv,
				{
					env: { ...process.env, PATH: searchPath(), AZURE_CORE_ONLY_SHOW_ERRORS: "true", AZURE_CORE_NO_COLOR: "true" },
					timeout: 60_000,
					maxBuffer: 1_000_000,
					windowsHide: true,
					shell,
					signal,
				},
				(error, stdout, stderr) => {
					if (!error) return resolve({ stdout, stderr, code: 0 });
					if (typeof error.code === "string") return resolve({ stdout, stderr, code: null, error: error.code === "ABORT_ERR" ? "cancelled" : error.code });
					if (flatpak && FLATPAK_DENIED.test(stderr)) {
						return resolve({ stdout, stderr, code: null, error: "Obsidian's Flatpak can't start programs outside its sandbox; allow it with `flatpak override --user --talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian`" });
					}
					if (flatpak && FLATPAK_NOT_FOUND.test(stderr)) return resolve({ stdout, stderr, code: null, error: "az wasn't found on the host" });
					resolve({ stdout, stderr, code: typeof error.code === "number" ? error.code : 1 });
				},
			);
		});
}
