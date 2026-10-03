// A tiny PDF writer (one page, text only) so invoices need no extra packages.
const esc = s => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
// items: {x, y, size, bold, text, align}; y counted from the top of an A4 page.
exports.page = items => {
  const W = 595, H = 842;
  const width = (t, size, bold) => t.length * size * (bold ? 0.56 : 0.52);
  let c = '';
  for (const it of items) {
    if (it.line) { c += `0.8 g ${it.x} ${H - it.y} ${it.w} 0.8 re f 0 g\n`; continue; }
    const t = esc(it.text), size = it.size || 11;
    let x = it.x; if (it.align === 'right') x = it.x - width(t, size, it.bold);
    c += `BT /${it.bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${(H - it.y).toFixed(1)} Td (${t}) Tj ET\n`;
  }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(c, 'latin1')} >>\nstream\n${c}endstream`
  ];
  let out = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
};
