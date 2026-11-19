/* Shared between the web app (browser) and the server (Node).
 * Category definitions + report builder used for the PDF report and the Excel export. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const EXP = [
    { id: 'food', n: 'الغذاء', e: '🍽️', c: '#FF7A3D' }, { id: 'cafe', n: 'المقاهي', e: '☕', c: '#B7791F' },
    { id: 'transport', n: 'المواصلات', e: '🚕', c: '#3B82F6' }, { id: 'fuel', n: 'البنزين', e: '⛽', c: '#F59E0B' },
    { id: 'bills', n: 'الفواتير', e: '🧾', c: '#EC4899' }, { id: 'rent', n: 'الإيجار', e: '🏠', c: '#8B5CF6' },
    { id: 'family', n: 'الأسرة', e: '👨‍👩‍👧', c: '#14B8A6' }, { id: 'shopping', n: 'التسوق', e: '🛍️', c: '#F43F5E' },
    { id: 'health', n: 'الصحة', e: '💊', c: '#EF4444' }, { id: 'edu', n: 'التعليم', e: '📚', c: '#6366F1' },
    { id: 'fun', n: 'الترفيه', e: '🎮', c: '#06B6D4' }, { id: 'subs', n: 'الاشتراكات', e: '📱', c: '#0EA5E9' },
    { id: 'gifts', n: 'تبرعات وهدايا', e: '🎁', c: '#D946EF' }, { id: 'travel', n: 'السفر', e: '✈️', c: '#0891B2' },
    { id: 'cash', n: 'سحب نقدي', e: '🏧', c: '#64748B' }, { id: 'other', n: 'أخرى', e: '📦', c: '#94A3B8' }
  ];
  const INC = [
    { id: 'salary', n: 'الراتب', e: '💼', c: '#12A150' }, { id: 'bonus', n: 'المكافآت', e: '🏆', c: '#EAB308' },
    { id: 'sales', n: 'المبيعات', e: '🏷️', c: '#F97316' }, { id: 'extra', n: 'عمل إضافي', e: '⏱️', c: '#0EA5E9' },
    { id: 'gift_in', n: 'الهدايا', e: '🎁', c: '#D946EF' }, { id: 'other_in', n: 'أخرى', e: '💰', c: '#22C55E' }
  ];
  const CATS = {};
  EXP.forEach(c => CATS[c.id] = c); INC.forEach(c => CATS[c.id] = c);
  CATS.transfer = { id: 'transfer', n: 'تحويل بين المحافظ', e: '🔁', c: '#64748B' };
  const PRIO = { basic: 'أساسي', normal: 'عادي', fun: 'ترفيهي' };
  const TYPE = { income: 'وارد', expense: 'صادر', transfer: 'تحويل' };

  const pad = n => String(n).padStart(2, '0');
  const fmt = n => Math.round(n || 0).toLocaleString('en-US');

  /**
   * opts: { from:'YYYY-MM-DD'|null, to:'YYYY-MM-DD'|null, type:'all'|'income'|'expense'|'transfer', wallet:id|'all' }
   * Running balance ("المتبقي") follows the selected wallet, or all wallets together.
   */
  function buildReport(S, opts) {
    opts = opts || {};
    const wallets = S.wallets || [];
    const wname = id => (wallets.find(w => w.id === id) || {}).name || '—';
    const wf = opts.wallet && opts.wallet !== 'all' ? opts.wallet : null;
    const type = opts.type || 'all';
    const from = opts.from || null, to = opts.to || null;

    const all = (S.tx || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const touches = t => !wf || t.wallet === wf || t.to === wf;
    const effect = t => {
      if (t.exclude) return 0;
      if (t.type === 'income') return !wf || t.wallet === wf ? t.amount : 0;
      if (t.type === 'expense') return !wf || t.wallet === wf ? -t.amount : 0;
      if (t.type === 'transfer' && wf) return (t.to === wf ? t.amount : 0) - (t.wallet === wf ? t.amount : 0);
      return 0;
    };
    let bal = wf ? Number((wallets.find(w => w.id === wf) || {}).initial || 0) : wallets.reduce((s, w) => s + Number(w.initial || 0), 0);
    const initialTotal = bal;
    let opening = null;
    const rows = [];
    let income = 0, expense = 0, transfersIn = 0, transfersOut = 0;
    const byCat = {};

    for (const t of all) {
      const day = t.date.slice(0, 10);
      if (to && day > to) break;
      if (!touches(t)) continue;
      if (from && day < from) { bal += effect(t); continue; }
      if (opening === null) opening = bal;
      bal += effect(t);
      if (type !== 'all' && t.type !== type) continue;

      let inAmt = 0, outAmt = 0;
      if (t.type === 'income') inAmt = t.amount;
      else if (t.type === 'expense') outAmt = t.amount;
      else if (wf) { if (t.to === wf) inAmt = t.amount; if (t.wallet === wf) outAmt = t.amount; }
      else { inAmt = t.amount; outAmt = t.amount; }

      if (!t.exclude) {
        if (t.type === 'income') income += t.amount;
        if (t.type === 'expense') expense += t.amount;
        if (t.type === 'transfer') { transfersIn += inAmt; transfersOut += outAmt; }
        if (t.type !== 'transfer') {
          const k = t.type + ':' + t.cat;
          byCat[k] = byCat[k] || { name: (CATS[t.cat] || CATS.other).n, type: t.type, total: 0, count: 0 };
          byCat[k].total += t.amount; byCat[k].count++;
        }
      }
      const [d, tm] = t.date.split('T');
      const cat = CATS[t.cat] || CATS.other;
      rows.push({
        date: d, time: (tm || '').slice(0, 5),
        type: TYPE[t.type], typeKey: t.type,
        category: cat.n,
        wallet: t.type === 'transfer' ? `${wname(t.wallet)} ← ${wname(t.to)}` : wname(t.wallet),
        note: t.note || '',
        priority: t.priority ? PRIO[t.priority] || '' : '',
        inAmt, outAmt, balance: bal,
        excluded: !!t.exclude
      });
    }
    if (opening === null) opening = bal;
    const cats = Object.values(byCat).sort((a, b) => b.total - a.total);
    cats.forEach(c => c.pct = (c.type === 'income' ? income : expense) ? c.total / (c.type === 'income' ? income : expense) * 100 : 0);

    const walletBal = id => {
      const w = wallets.find(x => x.id === id); let b = Number(w.initial || 0);
      for (const t of S.tx || []) {
        if (t.exclude) continue;
        if (t.type === 'income' && t.wallet === id) b += t.amount;
        else if (t.type === 'expense' && t.wallet === id) b -= t.amount;
        else if (t.type === 'transfer') { if (t.wallet === id) b -= t.amount; if (t.to === id) b += t.amount; }
      }
      return b;
    };

    return {
      rows,
      summary: {
        income, expense, net: income - expense, opening, closing: bal, count: rows.length,
        transfersIn, transfersOut, initialTotal
      },
      byCat: cats,
      wallets: wallets.map(w => ({ name: w.name, initial: Number(w.initial || 0), balance: walletBal(w.id) })),
      debts: (S.debts || []).map(d => ({
        person: d.person, dir: d.dir === 'owed' ? 'لي (أقرضت)' : 'علي (استلفت)', note: d.note || '',
        amount: d.amount, paid: d.paid, remaining: Math.max(0, d.amount - d.paid)
      })),
      goals: (S.goals || []).map(g => ({ name: g.name, target: g.target, saved: g.saved, remaining: Math.max(0, g.target - g.saved) })),
      filters: {
        from, to, type, typeLabel: type === 'all' ? 'الكل' : TYPE[type],
        wallet: wf ? wname(wf) : 'كل المحافظ'
      }
    };
  }

  return { EXP, INC, CATS, PRIO, TYPE, buildReport, fmt, pad };
});
