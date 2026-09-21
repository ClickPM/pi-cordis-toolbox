# Web Fetch Plugin

A safe, zero-heavy-dependency web fetcher plugin inspired by `dsh-webfetch` and `@cordisjs/plugin-http`.

## Features

- **SSRF Protection**: Automatically rejects private loopback addresses (127.0.0.1, localhost), link-local IP blocks, and private cloud VPC ranges.
- **HTML to Markdown**: Converts web pages into clean, readable Markdown while discarding script, style, navigation, and footer noise.
- **Size and Timeout Guards**: Protects against denial-of-service or oversized payloads.

## Operations

### `web.fetch`

Fetches a webpage and formats its content into Markdown, raw text, HTML, or structured JSON.

#### Parameters

- `url` (string, required): Full HTTP or HTTPS URL.
- `format` (string, optional): `"markdown"` (default), `"text"`, `"html"`, or `"json"`.
- `maxBytes` (number, optional): Max payload size in bytes (default: 102400 = 100KB).
- `timeoutMs` (number, optional): Request timeout in milliseconds (default: 15000).
