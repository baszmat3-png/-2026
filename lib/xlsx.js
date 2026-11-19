'use strict';
/* Minimal dependency-free .xlsx writer (Office Open XML) with RTL sheets and basic styles. */
const zlib = require('zlib');

/* ---------------- zip ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32); cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cenBuf, end]);
}

/* ---------------- xlsx ---------------- */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
function colName(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

/* style ids: see STYLES below */
const ST = { normal: 0, header: 1, money: 2, title: 3, moneyRed: 4, moneyGreen: 5, sub: 6, bold: 7, moneyBold: 8, pct: 9, muted: 10 };
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/></numFmts>
<fonts count="7">
 <font><sz val="11"/><name val="Arial"/></font>
 <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
 <font><b/><sz val="16"/><color rgb="FF0B8A5A"/><name val="Arial"/></font>
 <font><sz val="11"/><color rgb="FFE5484D"/><name val="Arial"/></font>
 <font><sz val="11"/><color rgb="FF12A150"/><name val="Arial"/></font>
 <font><sz val="10"/><color rgb="FF7A8699"/><name val="Arial"/></font>
 <font><b/><sz val="11"/><name val="Arial"/></font>
</fonts>
<fills count="4">
 <fill><patternFill patternType="none"/></fill>
 <fill><patternFill patternType="gray125"/></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FF0B8A5A"/><bgColor indexed="64"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FFEEF7F2"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
 <border><left/><right/><top/><bottom/><diagonal/></border>
 <border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
 <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="right" vertical="center" readingOrder="2"/></xf>
 <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1" readingOrder="2"/></xf>
 <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
 <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment horizontal="right" readingOrder="2"/></xf>
 <xf numFmtId="164" fontId="3" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
 <xf numFmtId="164" fontId="4" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
 <xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment horizontal="right" readingOrder="2"/></xf>
 <xf numFmtId="0" fontId="6" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="right" vertical="center" readingOrder="2"/></xf>
 <xf numFmtId="164" fontId="6" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
 <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
 <xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"><alignment horizontal="right" readingOrder="2"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * sheet = { name, cols:[widths], rows:[ [cell,...] ], merges:['A1:F1'], freeze: rowIndex }
 * cell = null | string | number | { v, s }  (s = style name from ST)
 */
function sheetXml(sh) {
  const rowsXml = sh.rows.map((row, ri) => {
    const cells = (row || []).map((cell, ci) => {
      if (cell === null || cell === undefined || cell === '') return '';
      const c = typeof cell === 'object' ? cell : { v: cell };
      const ref = colName(ci) + (ri + 1);
      const s = ST[c.s] !== undefined ? ST[c.s] : (typeof c.v === 'number' ? ST.money : ST.normal);
      if (typeof c.v === 'number' && isFinite(c.v)) return `<c r="${ref}" s="${s}"><v>${c.v}</v></c>`;
      return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
    }).join('');
    const ht = sh.heights && sh.heights[ri] ? ` ht="${sh.heights[ri]}" customHeight="1"` : '';
    return `<row r="${ri + 1}"${ht}>${cells}</row>`;
  }).join('');
  const cols = (sh.cols || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const pane = sh.freeze ? `<pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/>` : '';
  const merges = sh.merges && sh.merges.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const filter = sh.autoFilter ? `<autoFilter ref="${sh.autoFilter}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView rightToLeft="1" workbookViewId="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${rowsXml}</sheetData>${filter}${merges}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup orientation="landscape" paperSize="9"/>
</worksheet>`;
}

function buildXlsx(sheets) {
  const files = [];
  files.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>` });
  files.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>` });
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  files.push({ name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>تقرير مصاريفي</dc:title><dc:creator>مصاريفي</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>` });
  files.push({ name: 'docProps/app.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Masareefi</Application></Properties>` });
  files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>` });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` });
  files.push({ name: 'xl/styles.xml', data: STYLES });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
  return zip(files);
}

/* ---------------- report → workbook ---------------- */
function reportWorkbook(R, user) {
  const period = R.filters.from || R.filters.to ? `من ${R.filters.from || 'البداية'} إلى ${R.filters.to || 'اليوم'}` : 'كل الفترات';
  const gen = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const S = R.summary;

  const H = t => ({ v: t, s: 'header' });
  const txRows = R.rows.map((r, i) => [
    i + 1, r.date, r.time, r.type + (r.excluded ? ' (لا يؤثر)' : ''), r.category, r.wallet, r.note, r.priority,
    r.inAmt ? { v: r.inAmt, s: 'moneyGreen' } : '', r.outAmt ? { v: r.outAmt, s: 'moneyRed' } : '', { v: r.balance, s: r.balance < 0 ? 'moneyRed' : 'money' }
  ]);
  const lastTx = 4 + R.rows.length;
  const transactions = {
    name: 'المعاملات',
    cols: [6, 12, 8, 14, 18, 24, 34, 10, 15, 15, 17],
    freeze: 4,
    merges: ['A1:K1', 'A2:K2'],
    autoFilter: R.rows.length ? `A4:K${lastTx}` : null,
    heights: { 0: 26, 3: 24 },
    rows: [
      [{ v: 'تقرير المعاملات — مصاريفي', s: 'title' }],
      [{ v: `${user.name} · ${period} · ${R.filters.wallet} · النوع: ${R.filters.typeLabel} · أُنشئ ${gen}`, s: 'sub' }],
      [],
      ['#', 'التاريخ', 'الوقت', 'النوع', 'القسم', 'المحفظة', 'التفاصيل / الملاحظات', 'الأولوية', 'وارد', 'صادر', 'الرصيد المتبقي'].map(H),
      ...txRows,
      [{ v: 'الإجمالي', s: 'bold' }, { v: '', s: 'bold' }, { v: '', s: 'bold' }, { v: '', s: 'bold' }, { v: '', s: 'bold' }, { v: '', s: 'bold' }, { v: `${R.rows.length} معاملة`, s: 'bold' }, { v: '', s: 'bold' },
        { v: R.rows.reduce((s, r) => s + r.inAmt, 0), s: 'moneyBold' }, { v: R.rows.reduce((s, r) => s + r.outAmt, 0), s: 'moneyBold' }, { v: S.closing, s: 'moneyBold' }]
    ]
  };

  const summary = {
    name: 'الملخص',
    cols: [30, 20],
    merges: ['A1:B1'],
    heights: { 0: 26 },
    rows: [
      [{ v: 'ملخص مالي — مصاريفي', s: 'title' }],
      [{ v: `${user.name} · ${period} · ${R.filters.wallet}`, s: 'sub' }],
      [],
      [H('البند'), H('المبلغ (د.ع)')],
      ['الرصيد في بداية الفترة', S.opening],
      ['إجمالي الوارد (الدخل)', { v: S.income, s: 'moneyGreen' }],
      ['إجمالي الصادر (المصروف)', { v: S.expense, s: 'moneyRed' }],
      ['الصافي (الوارد − الصادر)', { v: S.net, s: S.net < 0 ? 'moneyRed' : 'moneyGreen' }],
      ['تحويلات واردة', S.transfersIn],
      ['تحويلات صادرة', S.transfersOut],
      [{ v: 'الرصيد المتبقي في نهاية الفترة', s: 'bold' }, { v: S.closing, s: 'moneyBold' }],
      ['عدد المعاملات', S.count]
    ]
  };

  const cats = {
    name: 'حسب الأقسام',
    cols: [22, 10, 18, 10, 12],
    rows: [
      [{ v: 'المصاريف والواردات حسب القسم', s: 'title' }],
      [],
      ['القسم', 'النوع', 'المبلغ (د.ع)', 'العدد', 'النسبة'].map(H),
      ...R.byCat.map(c => [c.name, c.type === 'income' ? 'وارد' : 'صادر', { v: c.total, s: c.type === 'income' ? 'moneyGreen' : 'moneyRed' }, c.count, { v: Math.round(c.pct * 10) / 10, s: 'pct' }])
    ]
  };

  const wallets = {
    name: 'المحافظ',
    cols: [24, 18, 18],
    rows: [
      [{ v: 'أرصدة المحافظ الحالية', s: 'title' }],
      [],
      ['المحفظة', 'الرصيد الافتتاحي', 'الرصيد الحالي'].map(H),
      ...R.wallets.map(w => [w.name, w.initial, { v: w.balance, s: w.balance < 0 ? 'moneyRed' : 'money' }]),
      [{ v: 'الإجمالي', s: 'bold' }, { v: R.wallets.reduce((s, w) => s + w.initial, 0), s: 'moneyBold' }, { v: R.wallets.reduce((s, w) => s + w.balance, 0), s: 'moneyBold' }]
    ]
  };

  const debts = {
    name: 'الديون والأقساط',
    cols: [20, 14, 24, 16, 16, 16],
    rows: [
      [{ v: 'الديون والأقساط', s: 'title' }],
      [],
      ['الاسم / الجهة', 'النوع', 'ملاحظة', 'المبلغ الكلي', 'المدفوع', 'المتبقي'].map(H),
      ...R.debts.map(d => [d.person, d.dir, d.note, d.amount, d.paid, { v: d.remaining, s: d.remaining ? 'moneyRed' : 'moneyGreen' }])
    ]
  };

  const goals = {
    name: 'الأهداف',
    cols: [22, 16, 16, 16],
    rows: [
      [{ v: 'الأهداف المالية', s: 'title' }],
      [],
      ['الهدف', 'المطلوب', 'المدخر', 'المتبقي'].map(H),
      ...R.goals.map(g => [g.name, g.target, g.saved, g.remaining])
    ]
  };

  return buildXlsx([transactions, summary, cats, wallets, debts, goals]);
}

module.exports = { buildXlsx, reportWorkbook, zip, crc32 };
