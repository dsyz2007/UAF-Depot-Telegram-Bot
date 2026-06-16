// Minimal, dependency-free .xlsx (OOXML) writer for the parade export.
//
// We emit a REAL .xlsx (a ZIP of XML parts) rather than the old SpreadsheetML
// 2003 format — modern Excel had started flagging the latter as "corrupted",
// especially with multiple worksheets. This opens cleanly with one tab per sheet.
//
// Design for the Workers free tier: STORED (uncompressed) ZIP entries + inline
// strings. No deflate, no sharedStrings — just string building (with a fast-path
// xmlEscape) plus one CRC32 pass per part. This is pure synchronous CPU that
// scales with cell count, so the CALLER must bound it (parade.ts caps the export
// to ≤7 days — ~1–2k rows, a few ms — plus a row-count safety net).

const CRC_TABLE: Uint32Array = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
	return (c ^ 0xffffffff) >>> 0;
}

// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /[&<>"'\x00-\x08\x0B\x0C\x0E-\x1F]/;
// Single-pass escape with a fast path: the vast majority of cells (names, dates,
// statuses, plain reasons) contain none of these, so we return the string
// untouched after one regex test — this is the dominant cost saver for a big
// export. Only cells that actually need escaping take the char-by-char branch
// (which also drops XML-1.0-illegal control chars, keeping tab/LF/CR).
function xmlEscape(s: string): string {
	if (!NEEDS_ESCAPE.test(s)) return s;
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const ch = s.charCodeAt(i);
		switch (ch) {
			case 38: out += '&amp;'; break;
			case 60: out += '&lt;'; break;
			case 62: out += '&gt;'; break;
			case 34: out += '&quot;'; break;
			case 39: out += '&apos;'; break;
			default:
				if (ch < 0x20 && ch !== 9 && ch !== 10 && ch !== 13) break; // drop illegal control char
				out += s[i];
		}
	}
	return out;
}

// Excel sheet names: max 31 chars, none of : \ / ? * [ ], non-blank.
function sanitizeSheetName(name: string, fallback: string): string {
	const n = name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim();
	return n || fallback;
}

// A cell is either a plain string (default style) or { v, s } where s is a
// cellXfs index from STYLES_XML below: 1 = green fill, 2 = red fill.
export type XlsxCell = string | { v: string; s: number };
export interface XlsxSheet {
	name: string;
	rows: XlsxCell[][]; // every row (caller includes its own header row first)
}

// Styles part: 3 cell formats — 0 default (no fill), 1 green fill, 2 red fill.
// Standard Excel "Good"/"Bad" pastel fills. fills index 0/1 are reserved by
// convention (none + gray125), so green/red are fills 2/3, referenced by cellXfs.
const STYLES_XML =
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
	`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
	`<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
	`<fills count="4">` +
	`<fill><patternFill patternType="none"/></fill>` +
	`<fill><patternFill patternType="gray125"/></fill>` +
	`<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill>` +
	`<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>` +
	`</fills>` +
	`<borders count="1"><border/></borders>` +
	`<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
	`<cellXfs count="3">` +
	`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
	`<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>` +
	`<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>` +
	`</cellXfs>` +
	`<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
	`</styleSheet>`;

// Cell `r` references (A1/B1…) are OPTIONAL in OOXML — Excel and openpyxl infer
// position from order — so we omit them (no per-cell colRef work, smaller XML).
// Built with string concatenation in tight loops (V8-friendly) to keep CPU low
// on a large export.
function sheetXml(sheet: XlsxSheet): string {
	let rows = '';
	for (let r = 0; r < sheet.rows.length; r++) {
		const cells = sheet.rows[r];
		let cs = '';
		for (let c = 0; c < cells.length; c++) {
			const cell = cells[c];
			if (typeof cell === 'string') {
				cs += `<c t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`;
			} else {
				cs += `<c t="inlineStr" s="${cell.s}"><is><t>${xmlEscape(cell.v)}</t></is></c>`;
			}
		}
		rows += `<row r="${r + 1}">${cs}</row>`;
	}
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

function concat(arrs: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const a of arrs) len += a.length;
	const out = new Uint8Array(len);
	let o = 0;
	for (const a of arrs) {
		out.set(a, o);
		o += a.length;
	}
	return out;
}

const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

// Assemble a ZIP using only STORED (method 0) entries.
function zipStore(files: { path: string; data: Uint8Array }[]): Uint8Array {
	const enc = new TextEncoder();
	const locals: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;

	for (const f of files) {
		const nameBytes = enc.encode(f.path);
		const crc = crc32(f.data);
		const size = f.data.length;
		const lfh = concat([
			u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
			u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0),
			nameBytes, f.data,
		]);
		locals.push(lfh);
		const cdh = concat([
			u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
			u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0),
			u16(0), u16(0), u32(0), u32(offset),
			nameBytes,
		]);
		central.push(cdh);
		offset += lfh.length;
	}

	const cd = concat(central);
	const eocd = concat([
		u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
		u32(cd.length), u32(offset), u16(0),
	]);
	return concat([...locals, cd, eocd]);
}

// Build a complete .xlsx workbook (one tab per sheet) as raw bytes.
export function buildXlsx(sheetsIn: XlsxSheet[]): Uint8Array {
	const enc = new TextEncoder();
	// At least one sheet; unique, valid names.
	const used = new Set<string>();
	const sheets = (sheetsIn.length ? sheetsIn : [{ name: 'Sheet1', rows: [] }]).map((s, i) => {
		const base = sanitizeSheetName(s.name, `Sheet${i + 1}`);
		let nm = base;
		let k = 2;
		while (used.has(nm.toLowerCase())) nm = `${base.slice(0, 28)} ${k++}`;
		used.add(nm.toLowerCase());
		return { name: nm, rows: s.rows };
	});

	const files: { path: string; data: Uint8Array }[] = [];
	const add = (path: string, text: string) => files.push({ path, data: enc.encode(text) });

	const overrides = sheets
		.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
		.join('');
	add(
		'[Content_Types].xml',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`,
	);
	add(
		'_rels/.rels',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
	);
	const sheetTags = sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
	add(
		'xl/workbook.xml',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`,
	);
	const sheetRels = sheets
		.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
		.join('');
	const stylesRel = `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
	add(
		'xl/_rels/workbook.xml.rels',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}${stylesRel}</Relationships>`,
	);
	add('xl/styles.xml', STYLES_XML);
	sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));

	return zipStore(files);
}
