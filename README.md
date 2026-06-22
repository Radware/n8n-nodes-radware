# n8n-nodes-radware

This is an n8n community node for interacting with Radware Threat Intelligence service.

It lets you use **Radware IP Insight** in your n8n workflows.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

## Operations

### IP Insight

The Radware IP Insight node enables IP enrichment through Radware’s Threat Intelligence REST API endpoint.

It can process a single or multiple IPv4 addresses from different trigger types, extract IPs automatically from input data, or read them from uploaded files in various formats.

The multifunctional node is designed for secure parsing and supports retry logic for failed IP lookups.

*1)Supports auto-detect that automatically extracts IPs from input.*

* Automatically detects IPs or IP List from your input: free text, complete JSON objects, or delimiter-separated text (space, comma, newline, single quote, double quote)

*2)Body Input Mode: specific field, simple list, and raw JSON.*

* when “Auto-detect Input” turn off, you can select specific input format:

  a. Field – you can select specific or multiple fields

  b. Simple List – one IP per line or comma-separated or IPs with single quote and/or double quote

  c. raw JSON - IP's in JSON format

*3)File Upload support with ability to parse multiple documents formatted with JSON, TXT, CSV, LOG, RTF, DOCX, XLSX, and PDF.*

*4)Provides customizable field projection for specific API response data.*

* Projection defines which fields to return in the API response.

* By default the projection was set to “all” but you can replace it according to your specific use-case.

* Supported fields include country_iso, ip_type, risk_score, actionable_insight and more.

*5)Includes configurable output modes to control response detail level.*

* Choose between “All” (includes IP which was failures to address) or “Valid Only” (successful IP Insight result only)

## Credentials

* This node uses **Radware IP Insight API credentials**.

* To authenticate, you must provide:

  * **Context (API ID)** — Your Radware Cloud tenant/account identifier

  * **x-api-key** — Your Radware API key

* Subscribe to configure Radware API keys here:

  [Radware Threat Intelligence Service](https://www.radware.com/products/threat-intelligence-service/)

## Compatibility

* Minimum n8n version: **compatible with 1.114.4 and recent n8n releases**

* Tested on: self-hosted n8n stable builds

## Resources

[n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## License

* MIT
