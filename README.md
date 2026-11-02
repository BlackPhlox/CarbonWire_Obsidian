# CarbonWire

**A fast REST API client for Obsidian.** Send HTTP requests, inspect responses and keep your API collections right next to your notes. Bring your collections over from Postman, Insomnia and Bruno, or just paste a curl command.

![CarbonWire request and response in Obsidian](assets/hero.png)

## Why CarbonWire

- **Fast.** The sidebar indexes 5,000 requests in under 5 ms and filters them as you type. Big JSON responses are formatted in the background, so Obsidian stays responsive.
- **Your files, your vault.** Collections are plain YAML files in the OpenCollection format that Bruno uses. They sync, diff and version like the rest of your notes, and Bruno's YAML collections open as they are.
- **Bring everything with you.** Import from Postman, Insomnia, Bruno, HTTPie, Hoppscotch, curl, HAR and `.http` files, environments included.
- **Private by design.** No account, no cloud, no telemetry. Requests go only where you send them, and secrets stay in Obsidian's secret storage.

## Quick start

1. Select the CarbonWire icon in the ribbon to open your collections.
2. Select **+ → New request**, or **Import** to bring in a Postman, Insomnia or Bruno collection.
3. Type a URL, or paste a curl command, and press `Ctrl/Cmd + Enter`.
4. Select **Save** to keep the request in a collection. From then on, changes save automatically.

## Features

**Requests**
- Any method, query and path parameters, headers, and JSON, XML, text, form, multipart or file bodies
- `{{variables}}` everywhere, shown in blue when defined and red when not, plus dynamic values like `{{$guid}}` and `{{$timestamp}}`
- Auth: Basic, Bearer token, API key, Digest and OAuth 2.0 (client credentials and password)
- Paste a curl command into the URL bar and the whole request fills in. Copy any request back out as curl.
- Start a request in a new tab without saving it, then save it to a collection when you want to keep it

**Azure Key Vault**
- Sign in with your Microsoft work or school account, in the browser or with a device code, or reuse your Azure CLI sign-in (`az login`)
- Use `{{$keyvault:vault/secret}}` anywhere a variable works, and CarbonWire fetches the value when you send
- Point an environment variable at a secret, so each environment can read from its own vault
- Values are kept in memory only, for a few minutes, and never written to your vault or history

**Responses**
- Status, time and size at a glance, with live progress while connecting, waiting and downloading
- Pretty-printed, searchable JSON with syntax colouring, and a JSON tree view for large payloads
- HTML preview, images and PDFs right in the panel
- Headers and a timing breakdown: DNS, connect, TLS, waiting and download

**Collections and environments**
- Collections and folders share variables, headers and auth with every request inside them
- One list of environments, one active at a time, each with its own colour. Names like dev, test, staging and prod get matching colours automatically.
- Drag to reorder or move requests, folders, collections and environments. Sort by name, creation or last update.

**History**
- Every request you send is kept with its response, saved or not
- Open a request and its last response is already there
- Kept on this device only, never synced

<p align="center"><img src="assets/sidebar.png" alt="Collections, history and environments" width="560"></p>

## Performance

| Task | Time |
|---|---|
| Index 5,000 requests for the sidebar | under 5 ms |
| Filter 5,000 requests as you type | under 1 ms |
| Sort 5,000 requests by name | about 1 ms |
| Import a Postman collection with 1,000 requests | under 10 ms |
| Pretty-print a 2.7 MB JSON response | about 25 ms, off the main thread |
| Build JSON tree rows for 25,000 objects | under 5 ms |
| Time added to each request over Node's own HTTP client | under 10 µs |
| Plugin size | 385 KB, nothing downloaded at runtime |

Median times on an Intel Core i5-1135G7 laptop with Node 24. Run `npm run bench` to measure on your machine.

## Import from

| Source | What comes across |
|---|---|
| Postman | Collections (v2.0 and v2.1) and environments |
| Insomnia | v4 JSON and v5 YAML exports, with environments |
| Bruno | `.bru` collections and OpenCollection YAML folders |
| HTTPie | Desktop and web exports |
| Hoppscotch | Collections and environments |
| curl | Any command, pasted or imported |
| HAR | Browser network exports |
| `.http` files | JetBrains HTTP Client and VS Code REST Client, with `http-client.env.json` |

<p align="center"><img src="assets/import.png" alt="Import dialog detecting a Postman collection" width="600"></p>

## Azure Key Vault secrets

1. Open **Settings → CarbonWire → Azure Key Vault** and select **Sign in**, or run **Sign in to Microsoft for Azure Key Vault** from the command palette. Your browser opens; pick your account. If the browser can't come back to Obsidian, select **Use a code instead** and enter the code at microsoft.com/devicelogin.
   Already use the Azure CLI? Set **Sign in with** to **Azure CLI (az login)** instead. CarbonWire then asks `az` for a Key Vault token each time it needs one and stores no sign-in of its own. See [Using the Azure CLI](#using-the-azure-cli).
2. Reference a secret anywhere a variable works: the URL, headers, body, auth or an environment variable.

| Reference | Reads |
|---|---|
| `{{$keyvault:contoso/db-password}}` | The latest `db-password` in the `contoso` vault |
| `{{$keyvault:contoso/db-password/4f2a…}}` | A specific version |
| `{{$keyvault:db-password}}` | `db-password` in the default vault from settings |
| `{{$keyvault:contoso.vault.azure.cn/db-password}}` | A vault in another Azure cloud, by host name |
| `{{$keyvault:https://contoso.vault.azure.net/secrets/db-password}}` | The secret identifier as the Azure portal shows it |

To use a different vault per environment, give each environment a variable such as `dbPassword: {{$keyvault:contoso-dev/db-password}}` and use `{{dbPassword}}` in your requests. Only the secrets a request actually uses are fetched.

Run **Copy Azure Key Vault secret reference** to pick a secret from a vault's list and copy its reference.

### Using the Azure CLI

With **Sign in with** set to **Azure CLI (az login)**, CarbonWire runs `az account get-access-token --scope https://vault.azure.net/.default` and uses the token for Key Vault. Sign in, switch accounts or tenants with `az login` in a terminal as usual; **Check** in settings shows which account CarbonWire will use. Set **Tenant** to read from a tenant other than az's current one.

- `az` is looked up on your PATH and in the usual install folders (Homebrew, `~/.local/bin`, the Windows installer). If it lives elsewhere, set **Azure CLI path**.
- In the Flatpak build of Obsidian, CarbonWire starts `az` on the host with `flatpak-spawn`. Allow that once with `flatpak override --user --talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian`.

Your account needs the **Key Vault Secrets User** role on the vault (or a *Get* secret access policy; *List* too for the picker). By default CarbonWire signs in as Microsoft's public Azure CLI app, the same one the Azure SDKs use for developer sign-in, so there's nothing to register. If your organization blocks it, register a public client app with the `http://localhost` redirect URI and the Azure Key Vault `user_impersonation` permission, then put its client ID and your tenant in settings.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Send the request | `Ctrl/Cmd + Enter`, or `Enter` in the URL bar |
| Save an unsaved request | `Ctrl/Cmd + S` |
| Find in the response or body | `Ctrl/Cmd + F` |

Commands in the palette: **Open collections**, **New request**, **Import collection, environment or cURL**, **Send request**, **Sign in to Microsoft for Azure Key Vault**, **Sign out of Microsoft**, **Copy Azure Key Vault secret reference** and **Forget fetched Azure Key Vault secrets**. Assign your own hotkeys to any of them.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Collections folder | `API Collections` | Where new collections are created. Existing collections are found anywhere in the vault. |
| Environments folder | `API Collections/Environments` | Where environments are kept. They're shared by every collection. |
| Response size limit | 20 MB | Larger bodies are cut short in memory; the full size is still shown. |
| History size | 100 | How many recent requests to keep. Set to 0 to turn history off. |
| Wrap long lines in responses | On | Wraps long lines instead of scrolling sideways. Also on the response toolbar. |
| Verify TLS certificates | On | Turn off only for local servers with self-signed certificates. |
| Sign in with | Microsoft sign-in | Microsoft sign-in in the browser, or the Azure CLI's `az login`. |
| Azure CLI path | Empty | Full path to `az`, if it isn't found on its own. |
| Tenant | `organizations` | Entra ID tenant ID or domain to sign in to. `organizations` accepts any work or school account. |
| Client ID | Azure CLI app | App (client) ID used for Microsoft sign-in. |
| Default vault | Empty | Vault used by `{{$keyvault:secret}}` references that don't name one. |
| Keep secrets in memory | 5 minutes | How long fetched Key Vault values are reused. 0 fetches on every send. |

## Install

In Obsidian, open **Settings → Community plugins → Browse**, search for **CarbonWire**, then select **Install** and **Enable**.

CarbonWire needs Obsidian 1.11.4 or later, on desktop.

## Privacy and network use

- CarbonWire sends requests only to the URLs you enter, and only when you send them. For OAuth 2.0 it also calls the token URL you set, including when you copy a request as curl.
- There's no telemetry and no account. Microsoft sign-in is optional and only used for Azure Key Vault.
- With the Azure CLI option, CarbonWire runs `az account get-access-token` (and `az account show` when you select **Check**) and keeps only the short-lived access token, in memory.
- When you sign in, CarbonWire talks to login.microsoftonline.com and briefly listens on a random localhost port for the browser to return. The sign-in (a refresh token) is kept in Obsidian's secret storage on this device, never in your vault. It's tied to the tenant and client ID in settings; change either and you sign in again.
- Key Vault is called only when you send or copy a request that uses a `{{$keyvault:...}}` reference, or when you list a vault's secrets. Fetched values stay in memory and are never written to disk.
- A request body can be a file anywhere on your computer, such as `-F file=@/path/to/report.pdf` in an imported curl command. CarbonWire reads that file only when you send the request, and never writes outside your vault.
- Secret environment values are kept in Obsidian's secret storage, never in your vault.
- History, including response bodies up to 1 MB each, stays on this device. Requests are stored as written, so secrets aren't copied into history. Clear it from the History tab or turn it off in settings.
- HTML previews run no scripts and load nothing from the network.

## Coming next

- [ ] Request settings: timeout, redirects and URL encoding
- [ ] Export to Postman and OpenCollection
- [ ] GraphQL
- [ ] gRPC
- [ ] WebSocket and server-sent events
- [ ] OpenAPI import
- [ ] Pre-request and test scripts, with a collection runner
- [ ] Cookies, proxies and client certificates
- [ ] OAuth 2.0 authorization code with PKCE
- [ ] Code snippets for other languages
- [ ] Mobile support

## Development

Requires Node 24 (`nvm use`).

```sh
npm install
npm run dev      # rebuild main.js and styles.css on change
npm test         # unit and transport tests
npm run bench    # performance benchmarks
npm run lint
npm run build    # type-check and production build
npm run analyze  # production build with a size breakdown
```

To try a build, link the repository into a vault's `.obsidian/plugins/carbonwire` folder and enable CarbonWire under Community plugins.

## License

[MIT](LICENSE)
