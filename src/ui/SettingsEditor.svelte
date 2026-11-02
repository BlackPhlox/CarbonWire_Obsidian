<script lang="ts">
	import type { HttpRequestSettings } from "../core/model";
	import { DEFAULT_SETTINGS } from "../core/inheritance";

	let {
		settings,
		canInherit = true,
		onchange,
	}: {
		settings: HttpRequestSettings | undefined;
		/** A request or folder can inherit; a collection only has CarbonWire's defaults above it. */
		canInherit?: boolean;
		onchange: (next: HttpRequestSettings) => void;
	} = $props();

	type BoolKey = "followRedirects" | "encodeUrl" | "forwardAuthorizationHeader";
	type NumberKey = "timeout" | "maxRedirects";

	const onOff = (value: boolean) => (value ? "on" : "off");
	const fallback = (key: BoolKey | NumberKey) => {
		const value = DEFAULT_SETTINGS[key];
		const text = typeof value === "boolean" ? onOff(value) : key === "timeout" && value === 0 ? "none" : String(value);
		return canInherit ? `Inherit (default: ${text})` : `Default (${text})`;
	};

	/** Inheriting, or using the default, is stored by leaving the key out. */
	function set<K extends keyof HttpRequestSettings>(key: K, value: HttpRequestSettings[K] | undefined) {
		const next: HttpRequestSettings = { ...settings };
		if (value === undefined || value === "inherit") delete next[key];
		else next[key] = value;
		onchange(next);
	}

	function boolValue(key: BoolKey): string {
		const value = settings?.[key];
		return typeof value === "boolean" ? onOff(value) : "";
	}

	function numberValue(key: NumberKey): string {
		const value = settings?.[key];
		return typeof value === "number" ? String(key === "timeout" ? value / 1000 : value) : "";
	}

	function setNumber(key: NumberKey, input: HTMLInputElement) {
		const text = input.value.trim();
		if (text === "") return set(key, undefined);
		const n = Number(text);
		if (!Number.isFinite(n) || n < 0) return;
		set(key, key === "timeout" ? Math.round(n * 1000) : Math.round(n));
	}

	const BOOLS: { key: BoolKey; label: string; hint: string }[] = [
		{ key: "followRedirects", label: "Follow redirects", hint: "Follow 3xx responses to their Location." },
		{ key: "encodeUrl", label: "Encode URL", hint: "Percent-encode query and path parameter values. Turn off to send them exactly as written." },
		{
			key: "forwardAuthorizationHeader",
			label: "Keep Authorization on redirects to other hosts",
			hint: "Off is safer: the header is dropped when a redirect leaves the original host.",
		},
	];
</script>

<div class="carbonwire-auth carbonwire-request-settings">
	<label class="carbonwire-field">
		<span>Timeout, in seconds</span>
		<input type="number" min="0" step="1" placeholder={fallback("timeout")} value={numberValue("timeout")} onchange={(e) => setNumber("timeout", e.currentTarget)} />
		<small class="carbonwire-muted">0 waits as long as the server takes.</small>
	</label>
	{#each BOOLS as { key, label, hint } (key)}
		<label class="carbonwire-field">
			<span>{label}</span>
			<select class="dropdown" value={boolValue(key)} onchange={(e) => set(key, e.currentTarget.value === "" ? undefined : e.currentTarget.value === "on")}>
				<option value="">{fallback(key)}</option>
				<option value="on">On</option>
				<option value="off">Off</option>
			</select>
			<small class="carbonwire-muted">{hint}</small>
		</label>
		{#if key === "followRedirects"}
			<label class="carbonwire-field">
				<span>Most redirects to follow</span>
				<input type="number" min="0" step="1" placeholder={fallback("maxRedirects")} value={numberValue("maxRedirects")} onchange={(e) => setNumber("maxRedirects", e.currentTarget)} />
			</label>
		{/if}
	{/each}
</div>
