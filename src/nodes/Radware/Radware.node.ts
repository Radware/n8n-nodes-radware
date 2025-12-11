import {
        IDataObject,
        IBinaryData,
        INodeExecutionData,
        INodeType,
        INodeTypeDescription,
        IHttpRequestOptions,
} from 'n8n-workflow';
import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import JSZip from 'jszip';
const pdfParse = require('pdf-parse');

/* ---------------------------------------- */
/* HELPERS: parsing & extraction utilities  */
/* ---------------------------------------- */

/** Extract unique IPv4s from arbitrary text. */
//  Core IPv4 extractor (dedupes, keeps order).
function extractIpsFromText(text: string): string[] {
        if (!text) return [];
        const candidates = Array.from(text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)).map(m => m[0].trim());
        const seen = new Set<string>();
        const out: string[] = [];
        for (const ip of candidates) if (ip && !seen.has(ip)) { seen.add(ip); out.push(ip); }
        return out;
}

/** Parse simple delimited lists into IPv4s (quotes, commas, whitespace). */
function parseSimpleList(text: string): string[] {
        const cleaned = text
                .replace(/['"]/g, '')
                .replace(/[,;\n\r\t]+/g, ',')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
        return extractIpsFromText(cleaned.join(' '));
}

//  Auto-detect from upstream JSON fields or free text.
function extractAddressesAuto(json: IDataObject): string[] {
        // Accept the entire incoming item if it's a root-level array
        if (Array.isArray(json)) {
                const arr = json as unknown as any[];
                return arr.map(String).map((s: string) => s.trim()).filter(Boolean);
        }

        for (const k of ['addresses', 'ips', 'ipList']) {
                const v = (json as any)[k];
                if (Array.isArray(v)) return v.map(String).map((s: string) => s.trim()).filter(Boolean);
        }
        if (typeof (json as any).ip === 'string' && (json as any).ip.trim()) return [(json as any).ip.trim()];

        // Handle JSON mode where body is an object/array
        const bodyVal = (json as any)?.body;
        if (bodyVal && typeof bodyVal === 'object') {
                // Peel one more "body" level if present
                const inner = (bodyVal as any).body ?? bodyVal;

                if (Array.isArray(inner)) {
                        return (inner as any[]).map(String).map((s: string) => s.trim()).filter(Boolean);
                }
                if (Array.isArray((inner as any).addresses)) {
                        return (inner as any).addresses.map(String).map((s: string) => s.trim()).filter(Boolean);
                }
                if (Array.isArray((inner as any).ips)) {
                        return (inner as any).ips.map(String).map((s: string) => s.trim()).filter(Boolean);
                }
                if (Array.isArray((inner as any).ipList)) {
                        return (inner as any).ipList.map(String).map((s: string) => s.trim()).filter(Boolean);
                }
                // Also support free-text under the inner body (e.g., {"body":{"text":"IPs are ..."}})
                if (typeof (inner as any).text === 'string' && (inner as any).text.trim()) {
                        return extractIpsFromText((inner as any).text.trim());
                }
        }

        for (const k of ['chatInput', 'text', 'message', 'body']) {
                const raw = (json as any)[k];
                if (typeof raw !== 'string' || !raw.trim()) continue;
                const t = raw.trim();
                if (t.startsWith('{') || t.startsWith('[')) {
                        try {
                                const parsed = JSON.parse(t);
                                if (Array.isArray((parsed as any).addresses))
                                        return (parsed as any).addresses.map(String).map((s: string) => s.trim()).filter(Boolean);
                                if (Array.isArray(parsed))
                                        return (parsed as any[]).map(String).map((s: string) => s.trim()).filter(Boolean);
                        } catch { }
                }
                return extractIpsFromText(t);
        }
        return [];
}

/** Very light RTF → text pass to make IPs extractable. */
//  Strips basic RTF control words/braces to plain text.
function stripRtfToText(rtf: string): string {
        return rtf
                .replace(/\\par[d]?/g, '\n')
                .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
                .replace(/\\[a-zA-Z]+\d*(?:\s|)/g, ' ')
                .replace(/[{}]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
}

/** DOCX text extraction via JSZip (no macro execution). */
//  Reads XML payload only; no active content is executed.
async function extractTextFromDocx(buffer: Buffer): Promise<string> {
        const zip = await JSZip.loadAsync(buffer);
        const docXml = await zip.file('word/document.xml')?.async('string');
        if (!docXml) return '';
        return docXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** XLSX text extraction via JSZip (shared strings + sheets). */
//  Collects inline text; avoids executing formulas/macros.
async function extractTextFromXlsx(buffer: Buffer): Promise<string> {
        const zip = await JSZip.loadAsync(buffer);
        let text = '';
        const shared = await zip.file('xl/sharedStrings.xml')?.async('string');
        if (shared) text += ' ' + shared.replace(/<[^>]+>/g, ' ');
        const sheetFolder = zip.folder('xl/worksheets');
        if (sheetFolder) {
                const files = Object.keys((sheetFolder as any).files || {});
                for (const f of files) {
                        if (f.endsWith('.xml')) {
                                const s = await zip.file(f)?.async('string');
                                if (s) text += ' ' + s.replace(/<[^>]+>/g, ' ');
                        }
                }
        }
        return text.replace(/\s+/g, ' ').trim();
}

/** Quick sniff for JSON-looking payloads. */
function looksLikeJson(buffer: Buffer): boolean {
        const s = buffer.slice(0, 32).toString('utf8').trim();
        return s.startsWith('{') || s.startsWith('[');
}

/**
 * Extract addresses from uploaded binary files.
 *  Only returns IPv4s. Supports JSON/TXT/CSV/LOG/RTF/DOCX/XLSX/PDF.
 *  Parsing is text-only; no active content or macros are executed.
 *  Unsupported types throw a clear error.
 */
async function addressesFromBinary(
        buffer: Buffer,
        mime: string | undefined,
        ext: string | undefined,
): Promise<string[]> {
        const lcMime = (mime || '').toLowerCase();
        const lcExt = (ext || '').toLowerCase().replace(/^\./, '');

        // STRICT ALLOW-LIST (The allowed file types)
        const ALLOWED_MIME = new Set<string>([
                'application/json',
                'text/plain',
                'text/csv',
                'application/rtf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // .xlsx
                'application/pdf',
        ]);
        const ALLOWED_EXT = new Set<string>(['json', 'txt', 'csv', 'log', 'rtf', 'docx', 'xlsx', 'pdf']);

        // Reject early if neither MIME nor EXT is allowed
        if (![...ALLOWED_MIME].some((m) => lcMime === m) && !ALLOWED_EXT.has(lcExt)) {
                throw new Error('Unsupported file type. Allowed: JSON, TXT, CSV, LOG, RTF, DOCX, XLSX, PDF');
        }

        // JSON: accept array or { addresses: [...] }, but ALWAYS filter to IPv4s only.
        if (lcMime === 'application/json' || lcExt === 'json' || looksLikeJson(buffer)) {
                const parsed = JSON.parse(buffer.toString('utf8'));
                // Force IPv4-only extraction even from JSON arrays/objects.
                if (Array.isArray(parsed)) {
                        return extractIpsFromText(parsed.map(String).join(' '));
                }
                if (parsed && Array.isArray((parsed as any).addresses)) {
                        return extractIpsFromText((parsed as any).addresses.map(String).join(' '));
                }
                throw new Error('JSON must be an array of IPs or have "addresses" array');
        }

        // Plain text: explicit types only (txt/csv/log)
        if (lcMime === 'text/plain' || lcMime === 'text/csv' || ['txt', 'csv', 'log'].includes(lcExt)) {
                return parseSimpleList(buffer.toString('utf8'));
        }

        // RTF → text → IPv4s
        if (lcMime === 'application/rtf' || lcExt === 'rtf') return extractIpsFromText(stripRtfToText(buffer.toString('utf8')));

        // DOCX → text → IPv4s
        if (lcMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || lcExt === 'docx') {
                return extractIpsFromText(await extractTextFromDocx(buffer));
        }

        // XLSX → text → IPv4s
        if (lcMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || lcExt === 'xlsx') {
                return extractIpsFromText(await extractTextFromXlsx(buffer));
        }

        // PDF → text → IPv4s
        if (lcMime === 'application/pdf' || lcExt === 'pdf') {
                const result = await pdfParse(buffer);
                return extractIpsFromText((result?.text as string) || '');
        }

        throw new Error('Unsupported file type');
}

/** Parse a single-IP Radware response into a consistent {ip, response} shape. */
//  Prefer results; on errors/failures, return the failure payload.
function parseSingleIpResponse(resp: any): { ip: string; response: any } {
        const failures = Array.isArray(resp?.failures) ? resp.failures : [];
        const results = resp?.results || {};
        if (failures.length > 0) {
                const f = failures[0];
                return { ip: f.ip, response: f };
        }
        const ip = Object.keys(results)[0];
        if (ip && results[ip]) return { ip, response: results[ip] };
        return { ip: 'unknown', response: { error: 'No data returned' } };
}

/* ---------------------------------------- */
/* NODE DEFINITION                           */
/* ---------------------------------------- */
export class Radware implements INodeType {
        description: INodeTypeDescription = {
                displayName: 'Radware',
                name: 'radware',
                icon: 'file:radware_v1.svg',
                group: ['transform'],
                version: 1,
                subtitle: '={{"Radware"}}',
                description: 'Radware IP Insight',
                defaults: { name: 'IP Insight' },
                inputs: ['main'],
                outputs: ['main'],
                credentials: [{ name: 'radwareApi', required: true }],
                properties: [
                        { displayName: 'Operation', name: 'operation', type: 'options', default: 'ipInsight', options: [{ name: 'IP Insight', value: 'ipInsight' }] },
                        {
                                displayName: 'Base URL',
                                name: 'baseUrl',
                                type: 'string',
                                default: 'https://api.radwarecloud.app/api/v1/sdcc/threat/core',
                                placeholder: 'https://<host>/api/v1/sdcc/threat/core',
                                description: 'Do NOT include /insight/_bulkResolve — it is appended automatically.',
                        },
                        { displayName: 'HTTP Method', name: 'httpMethod', type: 'options', default: 'POST', options: [{ name: 'POST', value: 'POST' }] },

                        // Reading IPs from files and  supported formats
                        {
                                displayName: 'Read IPs From File',
                                name: 'useBinary',
                                type: 'boolean',
                                default: false,
                                description:
                                        'Enable file upload to process multiple IPs. Specify the parameter name for the file field. Supported formats: JSON, TXT, CSV, LOG, RTF, DOCX, XLSX, PDF.',
                        },

                        // Multiple keys and wildcard support in tooltip/placeholder
                        {
                                displayName: 'File Key Name',
                                name: 'binaryKey',
                                type: 'string',
                                default: 'file',
                                placeholder: 'file, file2  or  *',
                                description:
                                        'Binary key name(s) on the item. Use a single key (e.g. "file"), a comma-separated list (e.g. "file,file2"), or "*" to read all binary keys.',
                                displayOptions: { show: { useBinary: [true] } },
                        },

                        // Auto-detect Input option
                        {
                                displayName: 'Auto-detect Input',
                                name: 'autoDetect',
                                type: 'boolean',
                                noDataExpression: true,
                                default: true,
                                description:
                                        'Automatically detects IPs from your input: free text, JSON paths like ips/ipList or ip, complete JSON objects, or delimiter-separated text (space, comma, newline, single quote,  double quote).',
                        },

                        // Body Mode if you want to give inputs from the Radware Node
                        {
                                displayName: 'Body Input Mode',
                                name: 'bodyMode',
                                type: 'options',
                                default: 'fields',
                                options: [
                                        { name: 'Fields', value: 'fields' },
                                        { name: 'Simple List', value: 'list' },
                                        { name: 'Raw JSON', value: 'raw' },
                                ],
                                description: 'Select input format: single IP address, JSON object with IP data, or Fields for a simple list.',
                                displayOptions: {
                                        show: {
                                                autoDetect: [false],
                                        },
                                },
                        },

                        {
                                displayName: 'Addresses',
                                name: 'addresses',
                                type: 'string',
                                typeOptions: { multipleValues: true, multipleValueButtonText: 'Add IP' },
                                default: [],
                                placeholder: '8.8.8.8',
                                description:
                                        'IP addresses to query. Radware API enforces its own limit — if exceeded, an error will be returned in output.',
                                displayOptions: { show: { bodyMode: ['fields'], autoDetect: [false] } },
                        },
                        {
                                displayName: 'Addresses (List)',
                                name: 'addressesText',
                                type: 'string',
                                typeOptions: { rows: 6 },
                                default: '',
                                placeholder:
                                        'One IP per line or comma-separated (e.g. 8.8.8.8, 1.1.1.1)\n"8.8.8.8", \'1.1.1.1\'',
                                description:
                                        'Paste or drag IPs. Supports: one per line, comma-separated, quoted IPs.',
                                displayOptions: { show: { bodyMode: ['list'], autoDetect: [false] } },
                        },
                        {
                                displayName: 'Raw JSON Body',
                                name: 'rawJsonBody',
                                type: 'string',
                                typeOptions: { rows: 8 },
                                default: `{\n "addresses": []\n}`,
                                description:
                                        'Provide full JSON body. Drag an array pill into "addresses", e.g. {{$json.addresses}}.',
                                displayOptions: { show: { bodyMode: ['raw'], autoDetect: [false] } },
                        },

                        // Projection list
                        {
                                displayName: 'Projection (List)',
                                name: 'projection',
                                type: 'multiOptions',
                                options: [
                                        { name: 'all', value: 'all' },
                                        { name: 'country_iso', value: 'country_iso' },
                                        { name: 'ip_type', value: 'ip_type' },
                                        { name: 'risk_score', value: 'risk_score' },
                                        { name: 'risk_analysis', value: 'risk_analysis' },
                                        { name: 'currently_active_eaaf', value: 'currently_active_eaaf' },
                                        { name: 'eaaf_current_score', value: 'eaaf_current_score' },
                                        { name: 'aso', value: 'aso' },
                                        { name: 'asn', value: 'asn' },
                                        { name: 'cidr', value: 'cidr' },
                                        { name: 'attack_categories', value: 'attack_categories' },
                                        { name: 'attacked_verticals', value: 'attacked_verticals' },
                                        { name: 'actionable_insight', value: 'actionable_insight' },
                                ],
                                default: ['all'],
                                description:
                                        'Select specific fields to return or use "all" for complete data (choosing "all" may impact response time).',
                        },
                        {
                                displayName: 'Additional Projection Keys (List)',
                                name: 'additionalProjKeys',
                                type: 'string',
                                typeOptions: { multipleValues: true, multipleValueButtonText: 'Add key' },
                                default: [],
                                description:
                                        'Optionally add specific keys (e.g. country_iso, ip_type, risk_score, aso, asn, cidr, attack_categories, attacked_verticals, eaaf_current_score, currently_active_eaaf, risk_score, risk_analysis).',
                        },

                        // Output Mode Options
                        {
                            displayName: 'Output Mode',
                            name: 'outputMode',
                            type: 'options',
                            default: 'all',
                            options: [
                                { name: 'All', value: 'all' },
                                { name: 'Valid Only', value: 'validOnly' },
                            ],
                            description: 'Show only valid IPs or include all with errors.',
                        },

                        {
                                displayName: 'Query Parameters',
                                name: 'queryParametersUi',
                                type: 'fixedCollection',
                                typeOptions: { multipleValues: true },
                                default: {},
                                placeholder: 'Add Query Parameter',
                                options: [{
                                        name: 'parameter',
                                        displayName: 'Parameter',
                                        values: [
                                                { displayName: 'Name', name: 'name', type: 'string', default: '' },
                                                { displayName: 'Value', name: 'value', type: 'string', default: '' },
                                        ],
                                }],
                        },
                        {
                                displayName: 'Extra Headers',
                                name: 'headersUi',
                                type: 'fixedCollection',
                                typeOptions: { multipleValues: true },
                                default: {},
                                placeholder: 'Add Header',
                                options: [{
                                        name: 'header',
                                        displayName: 'Header',
                                        values: [
                                                { displayName: 'Name', name: 'name', type: 'string', default: '' },
                                                { displayName: 'Value', name: 'value', type: 'string', default: '' },
                                        ],
                                }],
                        },
                        {
                                displayName: 'Options',
                                name: 'options',
                                type: 'collection',
                                placeholder: 'Add Option',
                                default: {},
                                options: [
                                        { displayName: 'Ignore SSL Issues', name: 'ignoreSslIssues', type: 'boolean', default: false },
                                        { displayName: 'Proxy', name: 'proxy', type: 'string', default: '', placeholder: 'http://user:pass@host:port' },
                                        { displayName: 'Timeout (ms)', name: 'timeout', type: 'number', default: 30000 },
                                        { displayName: 'Return Full Response', name: 'returnFullResponse', type: 'boolean', default: false },
                                ],
                        },
                ],
        };

        async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
                const items = this.getInputData();
                const out: INodeExecutionData[] = [];

                for (let i = 0; i < items.length; i++) {
                        //Operation guard (single supported op).
                        const operation = this.getNodeParameter('operation', i) as string;
                        if (operation !== 'ipInsight') throw new NodeOperationError(this.getNode(), `Unsupported operation: ${operation}`);

                        // Read user options for this item.
                        const baseUrl = (this.getNodeParameter('baseUrl', i) as string) || '';
                        const httpMethod = this.getNodeParameter('httpMethod', i, 'POST') as string;
                        const useBinary = this.getNodeParameter('useBinary', i) as boolean;
                        const autoDetect = this.getNodeParameter('autoDetect', i) as boolean;
                        const outputMode = this.getNodeParameter('outputMode', i) as 'all' | 'validOnly';

                        let body: IDataObject | undefined;

                        //  FILE INPUT PATH — support multiple keys and wildcard
                        if (useBinary) {
                                const binaryKeyParam = this.getNodeParameter('binaryKey', i, 'file') as string;
                                const binMap = items[i].binary as { [key: string]: IBinaryData } | undefined;

                                if (binMap && Object.keys(binMap).length > 0) {
                                        // Resolve which keys to read: single, list, or wildcard '*'
                                        const keysToRead: string[] =
                                                binaryKeyParam.trim() === '*'
                                                        ? Object.keys(binMap)
                                                        : binaryKeyParam
                                                                .split(',')
                                                                .map(k => k.trim())
                                                                .filter(Boolean);

                                        let aggregated: string[] = [];

                                        for (const key of keysToRead) {
                                                const bin = binMap[key];
                                                if (!bin) continue; // skip missing keys gracefully

                                                const buffer = await this.helpers.getBinaryDataBuffer(i, key);
                                                const mime = bin.mimeType;
                                                const ext = bin.fileExtension;
                                                try {
                                                        const addrs = await addressesFromBinary(buffer, mime, ext);
                                                        if (addrs?.length) aggregated.push(...addrs);
                                                } catch (e: any) {
                                                        // Soft-fail per file: keep going with other files.
                                                        // If you prefer to hard-fail, replace with:
                                                        // throw new NodeOperationError(this.getNode(), `Failed to read file "${key}": ${e.message || e}`);
                                                }
                                        }

                                        // De-duplicate while preserving order
                                        if (aggregated.length) {
                                                const seen = new Set<string>();
                                                const addresses = aggregated.filter(ip => !seen.has(ip) && seen.add(ip));
                                                const proj = (this.getNodeParameter('projection', i, ['all']) as string[]) || ['all'];
                                                const extra = (this.getNodeParameter('additionalProjKeys', i, []) as string[]) || [];
                                                body = { addresses, projection: [...new Set([...proj, ...extra])] };
                                        }
                                }
                        }

                        //  AUTO-DETECT FROM INPUT JSON / TEXT
                        // If no file body yet and autoDetect enabled, try to infer addresses from the JSON item.
                        if (!body && autoDetect) {
                                const auto = extractAddressesAuto(items[i].json as IDataObject);
                                if (auto.length) {
                                        const proj = (this.getNodeParameter('projection', i, ['all']) as string[]) || ['all'];
                                        const extra = (this.getNodeParameter('additionalProjKeys', i, []) as string[]) || [];
                                        body = { addresses: auto, projection: [...new Set([...proj, ...extra])] };
                                }
                        }

                        //  EXPLICIT BODY MODES
                        //  Fallback to explicit UI modes (raw JSON / list / fields).
                        if (!body) {
                                const bodyMode = this.getNodeParameter('bodyMode', i, 'list') as 'fields' | 'list' | 'raw';
                                if (bodyMode === 'raw') {
                                        const raw = (this.getNodeParameter('rawJsonBody', i, '') as string) || '';
                                        if (!raw.trim()) throw new NodeOperationError(this.getNode(), 'Raw JSON Body is empty.');
                                        try {
                                                body = JSON.parse(raw);
                                        } catch {
                                                throw new NodeOperationError(this.getNode(), 'Raw JSON Body is not valid JSON.');
                                        }
                                        // Merge UI projection into raw body (if any).
                                        const proj = (this.getNodeParameter('projection', i, ['all']) as string[]) || ['all'];
                                        const extra = (this.getNodeParameter('additionalProjKeys', i, []) as string[]) || [];
                                        const finalProjection = [...new Set([...proj, ...extra])];
                                        if (finalProjection.length > 0 && body) {
                                                body.projection = finalProjection;
                                        }
                                } else if (bodyMode === 'list') {
                                        const addressesText = (this.getNodeParameter('addressesText', i, '') as string) || '';
                                        const addresses = parseSimpleList(addressesText);
                                        if (!addresses.length) throw new NodeOperationError(this.getNode(), 'Please enter at least one IP address in the list.');
                                        const proj = (this.getNodeParameter('projection', i, ['all']) as string[]) || ['all'];
                                        const extra = (this.getNodeParameter('additionalProjKeys', i, []) as string[]) || [];
                                        body = { addresses, projection: [...new Set([...proj, ...extra])] };
                                } else {
                                        const addresses = (this.getNodeParameter('addresses', i, []) as string[]).filter(Boolean);
                                        if (!addresses.length) throw new NodeOperationError(this.getNode(), 'Please add at least one IP address.');
                                        const proj = (this.getNodeParameter('projection', i, ['all']) as string[]) || ['all'];
                                        const extra = (this.getNodeParameter('additionalProjKeys', i, []) as string[]) || [];
                                        body = { addresses, projection: [...new Set([...proj, ...extra])] };
                                }
                        }

                        // REQUEST OPTIONS
                        // Build query params & headers from UI collections.
                        const qpCollection = this.getNodeParameter('queryParametersUi', i, {}) as IDataObject;
                        const headersCollection = this.getNodeParameter('headersUi', i, {}) as IDataObject;
                        const qs: IDataObject = {};
                        if (qpCollection.parameter && Array.isArray(qpCollection.parameter)) {
                                for (const p of qpCollection.parameter as IDataObject[]) if (p.name) qs[p.name as string] = p.value;
                        }
                        const extraHeaders: IDataObject = {};
                        if (headersCollection.header && Array.isArray(headersCollection.header)) {
                                for (const h of headersCollection.header as IDataObject[]) if (h.name) extraHeaders[h.name as string] = h.value;
                        }
                        const options = this.getNodeParameter('options', i, {}) as IDataObject;
                        const timeout = (options.timeout as number) ?? 30000;

                        const requestOptions: IHttpRequestOptions = {
                                method: httpMethod as any,
                                url: `${baseUrl.replace(/\/$/, '')}/insight/_bulkResolve`,
                                json: true,
                                body,
                                headers: { 'Content-Type': 'application/json', ...extraHeaders },
                                qs,
                                timeout,
                        };

                        try {
                                const resp = await this.helpers.httpRequestWithAuthentication.call(this, 'radwareApi', requestOptions);
                                const failures = Array.isArray(resp?.failures) ? resp.failures : [];

                                // BULK FAILURE HANDLING
                                // If bulk has failures, retry each IP individually and merge results.
                                if (failures.length > 0) {
                                        const allResponses: any = { results: resp?.results || {}, failures: [] };
                                        // Keep original failure reasons by IP.
                                        const originalFailureMap = new Map<string, any>();
                                        for (const f of failures) {
                                                if (f.ip) originalFailureMap.set(f.ip.trim(), f);
                                        }

                                        // IPv4 shape check for per-IP retries.
                                        const ipv4FormatRegex = /^\d{1,3}(\.\d{1,3}){3}$/;
                                        const addresses = (body?.addresses as string[]) ?? [];

                                        for (const ip of addresses) {
                                                const trimmedIp = ip.trim();

                                                // Reject non-IPv4 early.
                                                if (!ipv4FormatRegex.test(trimmedIp)) {
                                                        allResponses.failures.push({
                                                                ip: trimmedIp,
                                                                reason: 'Invalid input – not an IPv4 address format',
                                                                raw: 'Invalid input – not an IPv4 address format',
                                                        });
                                                        continue;
                                                }

                                                // Preserve original failure if present.
                                                const originalFailure = originalFailureMap.get(trimmedIp);
                                                if (originalFailure) {
                                                        allResponses.failures.push({
                                                                ip: trimmedIp,
                                                                ...originalFailure,
                                                        });
                                                        continue;
                                                }

                                                // Single-IP fallback call.
                                                const singleReq = {
                                                        ...requestOptions,
                                                        body: { ...body, addresses: [trimmedIp] },
                                                };
                                                try {
                                                        const singleResp = await this.helpers.httpRequestWithAuthentication.call(this, 'radwareApi', singleReq);
                                                        const parsed = parseSingleIpResponse(singleResp);
                                                        if (parsed.response.reason || parsed.response.error) {
                                                                allResponses.failures.push({ ip: trimmedIp, ...parsed.response });
                                                        } else {
                                                                allResponses.results[trimmedIp] = parsed.response;
                                                        }
                                                } catch (e: any) {
                                                        const fallback = originalFailureMap.get(trimmedIp);
                                                        if (fallback) {
                                                                allResponses.failures.push({ ip: trimmedIp, ...fallback });
                                                        } else {
                                                                const errorBody = e.response?.body;
                                                                let reason = 'HTTP request failed';
                                                                if (errorBody) {
                                                                        try {
                                                                                const parsed = typeof errorBody === 'string' ? JSON.parse(errorBody) : errorBody;
                                                                                reason = parsed.message || parsed.error || parsed.reason || JSON.stringify(parsed);
                                                                        } catch {
                                                                                reason = errorBody.toString();
                                                                        }
                                                                }
                                                                allResponses.failures.push({ ip: trimmedIp, reason, raw: reason });
                                                        }
                                                }
                                        }

                                        // Output shaping: either “valid only” rows or the combined object.
                                        if (outputMode === 'validOnly') {
                                                for (const [ip, data] of Object.entries(allResponses.results)) {
                                                        out.push({ json: { ip, response: data as IDataObject } });
                                                }
                                                for (const f of allResponses.failures) {
                                                        out.push({ json: { ip: f.ip, response: f as IDataObject } });
                                                }
                                        } else {
                                                out.push({ json: allResponses as IDataObject });
                                        }
                                        continue;
                                }

                                // SUCCESS PATH (no bulk failures).
                                // Emit either per-IP rows (validOnly) or raw response.
                                if (outputMode === 'validOnly') {
                                        const results = resp?.results || {};
                                        const ips = Array.isArray(resp?.ips) ? resp.ips : Object.keys(results);
                                        for (const ip of ips) {
                                                if (results[ip]) {
                                                        out.push({ json: { ip, response: results[ip] as IDataObject } });
                                                }
                                        }
                                        const failures = Array.isArray(resp?.failures) ? resp.failures : [];
                                        for (const f of failures) {
                                                out.push({ json: { ip: f.ip, response: f as IDataObject } });
                                        }
                                } else {
                                        out.push({ json: resp as IDataObject });
                                }
                        } catch (error: any) {
                                // If the bulk call failed entirely, attempt per-IP single calls for resilience.
                                const addresses = (body?.addresses as string[]) || [];
                                if (addresses.length > 0) {
                                        const allResponses: any = { results: {}, failures: [] };
                                        const ipv4FormatRegex = /^\d{1,3}(\.\d{1,3}){3}$/;

                                        for (const ip of addresses) {
                                                const trimmedIp = ip.trim();

                                                if (!ipv4FormatRegex.test(trimmedIp)) {
                                                        allResponses.failures.push({
                                                                ip: trimmedIp,
                                                                reason: 'Invalid input – not an IPv4 address format',
                                                                raw: 'Invalid input – not an IPv4 address format',
                                                        });
                                                        continue;
                                                }

                                                const singleReq = { ...requestOptions, body: { ...body, addresses: [trimmedIp] } };
                                                try {
                                                        const singleResp = await this.helpers.httpRequestWithAuthentication.call(this, 'radwareApi', singleReq);
                                                        const parsed = parseSingleIpResponse(singleResp);
                                                        if (parsed.response.reason || parsed.response.error) {
                                                                allResponses.failures.push({ ip: trimmedIp, ...parsed.response });
                                                        } else {
                                                                allResponses.results[trimmedIp] = parsed.response;
                                                        }
                                                } catch (e: any) {
                                                        const errorBody = e.response?.body;
                                                        let reason = errorBody?.toString() || e.message || 'HTTP request failed';
                                                        if (errorBody) {
                                                                try {
                                                                        const parsed = typeof errorBody === 'string' ? JSON.parse(errorBody) : errorBody;
                                                                        reason = parsed.message || parsed.error || parsed.reason || JSON.stringify(parsed);
                                                                } catch {}
                                                        }
                                                        allResponses.failures.push({ ip: trimmedIp, reason, raw: reason });
                                                }
                                        }

                                        if (outputMode === 'validOnly') {
                                                for (const [ip, data] of Object.entries(allResponses.results)) {
                                                        out.push({ json: { ip, response: data as IDataObject } });
                                                }
                                                for (const f of allResponses.failures) {
                                                        out.push({ json: { ip: f.ip, response: f as IDataObject } });
                                                }
                                        } else {
                                                out.push({ json: allResponses as IDataObject });
                                        }
                                        continue;
                                }

                                const apiError = error.response?.body || error.error || { error: error.message };
                                out.push({ json: apiError as IDataObject });
                        }
                }

                return [out];
        }
}
