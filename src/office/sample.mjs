import fsp from 'node:fs/promises';
import path from 'node:path';
import { workbookBuffer } from './excel.mjs';
import { csvBuffer } from './csv.mjs';

/**
 * Synthetic test data sets with PLANTED anomalies and an answer key.
 *
 * An analysis app (duplicate detection, off-hours sales, split refunds, self-approval …) is built
 * and tested without touching real data: the generator writes realistic but fully fictitious
 * business records, hides known anomalies among them and writes the list of those records to a
 * key file. The `findsAll` expectation of the office check then measures how many the app found.
 *
 * Every value is made up (names are random first name + surname pairs, numbers are sequential).
 */

export const SAMPLE_TEMPLATES = {
  sales: 'Store and online sales with a staff sheet — duplicate receipts, store sales outside opening hours, refunds split below an approval threshold, round refunds, staff selling to their own loyalty card, outliers, missing data, negative amounts',
  expenses: 'Expense claims with per-type limits — duplicate invoices, self-approval, weekend expenses, over-limit claims, split invoices, round amounts',
  invoices: 'Customer invoices with product-group terms — discount above the maximum, payment term over the maximum, amount over the limit, wrong overdue status, missing required approval, weekend invoices',
};

const FIRST = ['James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda', 'David', 'Elizabeth', 'William', 'Susan', 'Richard', 'Jessica', 'Joseph', 'Sarah', 'Thomas', 'Karen', 'Daniel', 'Lisa', 'Matthew', 'Nancy', 'Anthony', 'Emily', 'Mark', 'Laura', 'Paul', 'Anna', 'Steven', 'Grace'];
const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Martin', 'Jackson', 'White', 'Harris', 'Clark', 'Lewis', 'Walker', 'Hall', 'Allen', 'Young', 'King', 'Wright'];
const STORES = [['S01', 'Downtown'], ['S02', 'Riverside'], ['S03', 'Harbor'], ['S04', 'Hillside'], ['S05', 'Lakeside'], ['S06', 'Old Town'], ['S07', 'Westgate'], ['S08', 'Eastfield'], ['S09', 'Northpoint'], ['S10', 'Southbank'], ['S11', 'Airport'], ['S12', 'University']];
const ONLINE = ['WEB', 'Online Store'];

function rng(seed) {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    money: (min, max) => Math.round((min + (max - min) * next() ** 2.2) * 100) / 100,
    name: () => `${r.pick(FIRST)} ${r.pick(LAST)}`,
  };
  return r;
}

const pad = (n, w) => String(n).padStart(w, '0');
const iso = (d) => d.toISOString().slice(0, 10);
const weekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
function randomDay(r, year, { workday = false, weekendOnly = false } = {}) {
  for (;;) {
    const d = new Date(Date.UTC(year, 0, 1) + r.int(0, 364) * 86400000);
    if (workday && weekend(d)) continue;
    if (weekendOnly && !weekend(d)) continue;
    return d;
  }
}
const time = (h, m) => `${pad(h, 2)}:${pad(m, 2)}`;

// ------------------------------------------------------------------ sales

function sales(r, rows, { year, anomalyRate }) {
  const customers = Array.from({ length: Math.max(60, Math.round(rows / 4)) }, (_, i) => ({ no: String(50000001 + i), name: r.name(), cards: Array.from({ length: r.int(1, 2) }, (_, k) => `KRT${pad(i + 1, 6)}${k + 1}`), typical: r.money(200, 8000) }));
  const staff = Array.from({ length: STORES.length * 3 }, (_, i) => {
    const s = STORES[i % STORES.length];
    const own = customers[r.int(0, customers.length - 1)];
    return { id: `E${pad(i + 1, 4)}`, name: r.name(), store: s, title: r.pick(['Cashier', 'Sales Associate', 'Department Lead', 'Assistant Store Manager']), customer: own.no };
  });
  // Refunds above 5,000 need a manager; ordinary refunds stay well below that.
  const TYPES = { 'Cash Sale': [20, 15000], 'Card Sale': [20, 40000], 'Installment Sale': [500, 60000], 'Gift Card Sale': [100, 3000], Refund: [20, 4000] };
  const CHANNEL_TYPES = { Store: Object.keys(TYPES), Online: ['Card Sale', 'Installment Sale', 'Gift Card Sale', 'Refund'], 'Mobile App': ['Card Sale', 'Installment Sale', 'Gift Card Sale', 'Refund'] };
  const out = [];
  let seq = 0;
  const id = () => `RCP${pad(++seq, 7)}`;
  const anomalies = [];
  const mark = (rec, type, description, group = null, related = null) => anomalies.push({ id: rec.no, type, description, ...(group ? { group } : {}), ...(related ? { related: [related] } : {}) });
  const normal = (overrides = {}) => {
    const channel = overrides.channel || r.pick(['Store', 'Store', 'Store', 'Online', 'Mobile App']);
    let c = overrides.customer || r.pick(customers);
    const type = overrides.type || r.pick(CHANNEL_TYPES[channel]);
    const store = overrides.store || r.pick(STORES);
    const d = overrides.date || randomDay(r, year);
    // Stores are open 10:00–22:00 every day; online sales happen at any hour.
    const t = overrides.time || (channel === 'Store' ? time(r.int(10, 21), r.int(0, 59)) : time(r.int(0, 23), r.int(0, 59)));
    const [lo, hi] = TYPES[type];
    // Ordinary amounts stay within 0.5–1.5× the customer's usual amount (and the type's range), so
    // no unplanted record is ever 20× the customer's median.
    let base = c.typical * (0.5 + r.next());
    if (base > hi) base = hi * (0.5 + 0.5 * r.next());
    if (base < lo) base = lo * (1 + r.next());
    const amount = overrides.amount ?? Math.round(base * 100) / 100;
    const staffMember = channel === 'Store' ? overrides.staff || r.pick(staff.filter((s) => s.store[0] === store[0])) || r.pick(staff) : null;
    // An unplanted record must never be an anomaly by accident (staff on their own card).
    while (!overrides.customer && staffMember && staffMember.customer === c.no) c = r.pick(customers);
    return {
      no: id(), date: d, time: t, store: channel === 'Store' ? store : ONLINE, channel, type,
      customer: c.no, card: overrides.card ?? r.pick(c.cards), amount, currency: 'TRY',
      text: `${type} - ${c.name}`, staff: staffMember?.id || '', _c: c,
    };
  };
  const target = Math.max(1, Math.round(rows * anomalyRate));
  for (let i = 0; i < rows - target * 2; i++) out.push(normal());
  // Planted anomalies, round-robin over the types until the target count is reached.
  const planters = [
    () => {
      const o = r.pick(out.filter((x) => !x._anomaly));
      const [h, m] = o.time.split(':').map(Number);
      const dup = { ...o, no: id(), time: time(h, Math.min(59, m + r.int(1, 3))), _anomaly: true };
      out.push(dup);
      mark(dup, 'duplicate_receipt', `Duplicate of ${o.no}: same customer, card, type, amount and day within minutes.`, null, o.no);
    },
    () => {
      const rec = normal({ channel: 'Store', time: time(r.pick([23, 0, 1, 2, 3, 4, 5, 6, 7]), r.int(0, 59)) });
      rec._anomaly = true;
      out.push(rec);
      mark(rec, 'outside_hours', `Store sale at ${rec.time}, outside opening hours (10:00–22:00).`);
    },
    () => {
      const c = r.pick(customers);
      const d = randomDay(r, year);
      const n = r.int(3, 4);
      const group = `S${anomalies.length + 1}`;
      for (let k = 0; k < n; k++) {
        const rec = normal({ customer: c, channel: 'Store', type: 'Refund', date: d, time: time(11 + k * 2, r.int(0, 59)), amount: r.int(4500, 4995) });
        rec._anomaly = true;
        out.push(rec);
        mark(rec, 'split_refund', `${n} refunds to customer ${c.no} on ${iso(d)}, each just below the 5,000 approval threshold (total above it).`, group);
      }
    },
    () => {
      const rec = normal({ channel: 'Store', type: 'Refund', amount: r.pick([10000, 15000, 20000, 25000]) });
      rec._anomaly = true;
      out.push(rec);
      mark(rec, 'round_refund', `Round refund of ${rec.amount.toLocaleString('en-US')}.`);
    },
    () => {
      const s = r.pick(staff);
      const c = customers.find((x) => x.no === s.customer);
      const rec = normal({ customer: c, channel: 'Store', store: s.store, staff: s });
      rec._anomaly = true;
      out.push(rec);
      mark(rec, 'staff_own_card', `Employee ${s.id} processed a sale on their own customer card ${c.no}.`);
    },
    () => {
      const rec = normal();
      if (r.chance(0.5)) rec.customer = '';
      else rec.card = '';
      rec._anomaly = true;
      out.push(rec);
      mark(rec, 'missing_data', `Missing ${rec.customer ? 'card number' : 'customer number'}.`);
    },
    () => {
      const rec = normal();
      rec.amount = -rec.amount;
      rec._anomaly = true;
      out.push(rec);
      mark(rec, 'negative_amount', 'Negative amount.');
    },
  ];
  const outliers = Math.max(1, Math.round(target / 8));
  for (let k = 0; anomalies.length < target - outliers; k++) planters[k % planters.length]();
  while (out.length < rows - outliers) out.push(normal());
  // No accidental duplicates among ordinary records (a planted duplicate keeps its original).
  const keys = new Set();
  for (const x of out) {
    if (x._anomaly) continue;
    let key;
    while (keys.has((key = [x.customer, x.card, x.type, x.amount, x.date.getTime()].join('|')))) x.amount = Math.round((x.amount + 0.01) * 100) / 100;
    keys.add(key);
  }
  // Outliers last: measured against the customer's real history, which then no longer changes.
  const median = (a) => {
    const v = [...a].sort((p, q) => p - q);
    return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  };
  for (let k = 0; k < outliers; k++) {
    const history = new Map();
    const tainted = new Set(out.filter((x) => x._anomaly).map((x) => x._c));
    for (const x of out) if (!tainted.has(x._c)) history.set(x._c, [...(history.get(x._c) || []), Math.abs(x.amount)]);
    const candidates = [...history].filter(([, a]) => a.length >= 3);
    const [c, amounts] = candidates.length ? r.pick(candidates) : [r.pick(customers), [r.pick(customers).typical]];
    const rec = normal({ customer: c, channel: r.pick(['Online', 'Mobile App']), type: 'Card Sale', amount: Math.round(Math.max(c.typical * r.int(40, 80), median(amounts) * r.int(30, 60))) });
    rec._anomaly = true;
    out.push(rec);
    mark(rec, 'unusual_amount', `Card sale of ${rec.amount.toLocaleString('en-US')}, about ${Math.round(rec.amount / median(amounts))}× the customer's median amount.`);
  }
  out.sort((a, b) => a.date - b.date || a.time.localeCompare(b.time));
  // Renumber in date order so the ids give nothing away; keep the key in step.
  const rename = new Map();
  out.forEach((rec, i) => {
    const next = `RCP${pad(i + 1, 7)}`;
    rename.set(rec.no, next);
    rec.no = next;
  });
  for (const a of anomalies) {
    a.id = rename.get(a.id);
    if (a.related) a.related = a.related.map((x) => rename.get(x) || x);
    a.description = a.description.replace(/RCP\d{7}/g, (m) => rename.get(m) || m);
  }
  const header = ['Receipt No', 'Date', 'Time', 'Store Code', 'Store Name', 'Channel', 'Type', 'Customer No', 'Card No', 'Amount', 'Currency', 'Description', 'Employee ID'];
  const formats = { Date: 'date', Amount: 'money' };
  return {
    idColumn: 'Receipt No',
    sheets: [
      { name: 'Sales', columns: header.map((h) => ({ header: h, format: formats[h] })), rows: out.map((x) => [x.no, x.date, x.time, x.store[0], x.store[1], x.channel, x.type, x.customer, x.card, x.amount, x.currency, x.text, x.staff]) },
      { name: 'Employees', columns: ['Employee ID', 'Name', 'Store Code', 'Store Name', 'Role', 'Customer No'].map((h) => ({ header: h })), rows: staff.map((s) => [s.id, s.name, s.store[0], s.store[1], s.title, s.customer]) },
    ],
    anomalies,
    rules: [
      'Duplicate receipt: same customer, card, type, amount and day, a few minutes apart.',
      'Outside opening hours: a Store channel sale outside 10:00–22:00.',
      'Split refund: several refunds to the same customer on the same day, each just below the 5,000 approval threshold (4,500–4,999).',
      'Round refund: refunds of 10,000 or more that are a multiple of 5,000.',
      'Employee on their own card: the Customer No of the sale equals the Customer No of the employee (Employee ID) in the Employees sheet.',
      'Unusual amount: a card sale far above the customer\'s usual amount (e.g. more than 20× the median).',
      'Missing data: Customer No or Card No is empty.',
      'Negative amount.',
    ],
  };
}

// ------------------------------------------------------------------ expenses

function expenses(r, rows, { year, anomalyRate }) {
  const LIMITS = { Meals: 1500, Taxi: 1000, Hotel: 6000, Flights: 9000, Hospitality: 10000, 'Office Supplies': 2000 };
  const VENDORS = { Meals: ['Corner Bistro', 'Green Kitchen', 'Harbor Grill'], Taxi: ['City Cabs', 'Metro Taxi'], Hotel: ['Park Hotel', 'Harbor Inn', 'Central Suites'], Flights: ['Skyline Air', 'Blue Air'], Hospitality: ['Riverside Restaurant', 'Grand Dining'], 'Office Supplies': ['Office World', 'Paper Point'] };
  const UNITS = ['Sales', 'Finance', 'IT', 'Human Resources', 'Marketing', 'Logistics'];
  const people = Array.from({ length: 40 }, (_, i) => ({ id: `E${pad(i + 1, 4)}`, name: r.name(), unit: r.pick(UNITS) }));
  const managers = people.slice(0, 8);
  const out = [];
  let invoice = 100000;
  const anomalies = [];
  // One claim per person, vendor and day unless a planted anomaly says otherwise: two ordinary
  // claims on the same day at the same vendor would look like a split invoice.
  const used = new Set();
  const notRound = (a) => (a % 100 === 0 ? a + r.int(1, 99) / 100 : a);
  const slot = (p, vendor, d) => `${p.id}|${vendor}|${d.getTime()}`;
  const make = (o = {}) => {
    const p = o.person || r.pick(people.slice(8));
    const type = o.type || r.pick(Object.keys(LIMITS));
    const vendor = o.vendor || r.pick(VENDORS[type]);
    let date = o.date || randomDay(r, year, { workday: true });
    if (!o.shared) while (used.has(slot(p, vendor, date))) date = o.weekend ? randomDay(r, year, { weekendOnly: true }) : new Date(date.getTime() + 86400000 * (weekend(new Date(date.getTime() + 86400000)) ? 3 : 1));
    used.add(slot(p, vendor, date));
    return { no: '', person: p, date, type, vendor, invoice: o.invoice || `INV${++invoice}`, amount: o.amount ?? notRound(r.money(LIMITS[type] * 0.05, LIMITS[type] * 0.9)), approver: o.approver || r.pick(managers.filter((m) => m.id !== p.id)), text: o.text || `${type} expense` };
  };
  const target = Math.max(1, Math.round(rows * anomalyRate));
  for (let i = 0; i < rows - target * 2; i++) out.push(make());
  const add = (rec, type, description, group, related = null) => {
    out.push(rec);
    rec._a = { type, description, group, related };
  };
  const planters = [
    () => {
      const o = r.pick(out.filter((x) => !x._a));
      // A weekday, chosen before make() reserves the person/vendor/day slot.
      let date = new Date(o.date.getTime() + r.int(3, 40) * 86400000);
      if (weekend(date)) date = new Date(date.getTime() + (date.getUTCDay() === 6 ? 2 : 1) * 86400000);
      const copy = make({ person: r.chance(0.5) ? o.person : r.pick(people.slice(8)), type: o.type, vendor: o.vendor, invoice: o.invoice, amount: o.amount, date });
      add(copy, 'duplicate_invoice', `Invoice ${o.invoice} from ${o.vendor} claimed twice.`, null, o);
    },
    () => {
      const m = r.pick(managers);
      add(make({ person: m, approver: m }), 'self_approval', `Expense approved by the claimant (${m.id}).`);
    },
    () => add(make({ date: randomDay(r, year, { weekendOnly: true }), weekend: true, type: r.pick(['Meals', 'Taxi', 'Hospitality']) }), 'weekend_expense', 'Expense dated on a weekend.'),
    () => {
      const type = r.pick(Object.keys(LIMITS));
      add(make({ type, amount: Math.round(LIMITS[type] * (1.1 + r.next()) * 100) / 100 }), 'over_limit', `Above the ${LIMITS[type].toLocaleString('en-US')} limit for ${type}.`);
    },
    () => {
      const type = r.pick(['Hotel', 'Hospitality', 'Flights']);
      const p = r.pick(people.slice(8));
      const d = randomDay(r, year, { workday: true });
      const vendor = r.pick(VENDORS[type]);
      const group = `B${out.length}`;
      let when = d;
      for (let k = 0; k < 2; k++) {
        const part = make({ person: p, type, vendor, date: when, shared: k > 0, amount: Math.round(LIMITS[type] * (0.8 + r.next() * 0.18) * 100) / 100 });
        when = part.date;
        add(part, 'split_invoice', `Split claim: ${p.id}, ${vendor}, ${iso(when)} — each part below the ${type} limit, together above it.`, group);
      }
    },
    () => add(make({ type: 'Hospitality', amount: r.pick([5000, 7500, 8000, 9000]) }), 'round_amount', 'Round amount for a hospitality expense.'),
  ];
  for (let k = 0; out.filter((x) => x._a).length < target; k++) planters[k % planters.length]();
  while (out.length < rows) out.push(make());
  out.sort((a, b) => a.date - b.date);
  out.forEach((x, i) => (x.no = `EXP${pad(i + 1, 6)}`));
  for (const x of out) if (x._a) anomalies.push({ id: x.no, type: x._a.type, description: x._a.description, ...(x._a.group ? { group: x._a.group } : {}), ...(x._a.related ? { related: [x._a.related.no] } : {}) });
  return {
    idColumn: 'Expense No',
    sheets: [
      { name: 'Expenses', columns: [{ header: 'Expense No' }, { header: 'Employee ID' }, { header: 'Name' }, { header: 'Department' }, { header: 'Date', format: 'date' }, { header: 'Category' }, { header: 'Vendor' }, { header: 'Invoice No' }, { header: 'Amount', format: 'money' }, { header: 'Approver ID' }, { header: 'Description' }], rows: out.map((x) => [x.no, x.person.id, x.person.name, x.person.unit, x.date, x.type, x.vendor, x.invoice, x.amount, x.approver.id, x.text]) },
      { name: 'Limits', columns: [{ header: 'Category' }, { header: 'Limit per Receipt', format: 'money' }], rows: Object.entries(LIMITS) },
    ],
    anomalies,
    rules: ['Duplicate invoice: the same vendor + invoice number claimed more than once.', 'Self-approval: Approver ID = Employee ID.', 'Expense dated on a weekend.', 'Over the limit: amount above the per-receipt limit in the Limits sheet.', 'Split invoice: same employee, vendor and day; each part below the limit, together above it.', 'Round amount for a hospitality expense.'],
  };
}

// ------------------------------------------------------------------ invoices

function invoices(r, rows, { year, anomalyRate }) {
  const GROUPS = { Electronics: { maxDisc: 10, maxTerm: 60, maxAmount: 500000, approval: true }, Appliances: { maxDisc: 12, maxTerm: 90, maxAmount: 1000000, approval: true }, Textiles: { maxDisc: 20, maxTerm: 90, maxAmount: 250000, approval: false }, Food: { maxDisc: 5, maxTerm: 30, maxAmount: 150000, approval: false } };
  const SUFFIX = ['Trading', 'Foods', 'Construction', 'Textiles', 'Logistics', 'Electric', 'Furniture'];
  const firms = Array.from({ length: 200 }, (_, i) => ({ no: String(70000001 + i), name: `${r.pick(LAST)} ${r.pick(SUFFIX)} Ltd.` }));
  const out = [];
  const status = (late) => (late > 90 ? 'At Risk' : late >= 30 ? 'Overdue' : 'Current');
  const make = (o = {}) => {
    const group = o.group || r.pick(Object.keys(GROUPS));
    const g = GROUPS[group];
    const late = o.late ?? (r.chance(0.8) ? 0 : r.chance(0.6) ? r.int(1, 29) : r.chance(0.6) ? r.int(30, 90) : r.int(91, 400));
    const firm = r.pick(firms);
    return {
      no: '', customer: firm.no, name: firm.name, region: r.pick(STORES)[1], group,
      date: o.date || randomDay(r, year, { workday: true }), amount: o.amount ?? Math.round(r.money(g.maxAmount * 0.02, g.maxAmount * 0.95) / 100) * 100,
      term: o.term ?? r.pick([15, 30, 45, 60, 90].filter((t) => t <= g.maxTerm)), discount: o.discount ?? Math.round(r.next() * g.maxDisc * 100) / 100,
      late, status: o.status || status(late), approver: o.approver || (g.approval ? `E${pad(r.int(1, 8), 4)}` : r.pick(['None', 'None', `E${pad(r.int(1, 8), 4)}`])), rep: `E${pad(r.int(9, 36), 4)}`,
    };
  };
  const target = Math.max(1, Math.round(rows * anomalyRate));
  for (let i = 0; i < rows - target; i++) out.push(make());
  const add = (rec, type, description) => {
    rec._a = { type, description };
    out.push(rec);
  };
  const planters = [
    () => {
      const group = r.pick(Object.keys(GROUPS));
      const discount = GROUPS[group].maxDisc + r.int(3, 10);
      add(make({ group, discount }), 'discount_over_max', `${group} invoice with ${discount}% discount (maximum ${GROUPS[group].maxDisc}%).`);
    },
    () => {
      const group = r.pick(['Electronics', 'Food']);
      const term = GROUPS[group].maxTerm + r.pick([15, 30]);
      add(make({ group, term }), 'term_over_max', `${group} invoice with a ${term}-day term (maximum ${GROUPS[group].maxTerm}).`);
    },
    () => {
      const group = r.pick(Object.keys(GROUPS));
      const amount = Math.round(GROUPS[group].maxAmount * (1.1 + r.next() * 0.5) / 100) * 100;
      add(make({ group, amount }), 'amount_over_limit', `${group} invoice of ${amount.toLocaleString('en-US')} (limit ${GROUPS[group].maxAmount.toLocaleString('en-US')}).`);
    },
    () => {
      const late = r.chance(0.5) ? r.int(91, 300) : r.int(30, 90);
      add(make({ late, status: late > 90 ? r.pick(['Current', 'Overdue']) : 'Current' }), 'wrong_status', `${late} days overdue but marked "${late > 90 ? 'not At Risk' : 'Current'}".`);
    },
    () => {
      const group = r.pick(['Electronics', 'Appliances']);
      add(make({ group, approver: 'None' }), 'missing_approval', `${group} invoice without the required approval.`);
    },
    () => add(make({ date: randomDay(r, year, { weekendOnly: true }) }), 'weekend_invoice', 'Invoice dated on a weekend.'),
  ];
  for (let k = 0; out.filter((x) => x._a).length < target; k++) planters[k % planters.length]();
  while (out.length < rows) out.push(make());
  out.sort((a, b) => a.date - b.date);
  out.forEach((x, i) => (x.no = `INV${pad(i + 1, 6)}`));
  return {
    idColumn: 'Invoice No',
    sheets: [
      { name: 'Invoices', columns: [{ header: 'Invoice No' }, { header: 'Customer No' }, { header: 'Customer Name' }, { header: 'Region' }, { header: 'Product Group' }, { header: 'Invoice Date', format: 'date' }, { header: 'Amount', format: 'money' }, { header: 'Term (Days)', format: 'integer' }, { header: 'Discount (%)', format: 'number' }, { header: 'Days Overdue', format: 'integer' }, { header: 'Collection Status' }, { header: 'Approver' }, { header: 'Sales Rep' }], rows: out.map((x) => [x.no, x.customer, x.name, x.region, x.group, x.date, x.amount, x.term, x.discount, x.late, x.status, x.approver, x.rep]) },
      { name: 'Product Group Terms', columns: [{ header: 'Product Group' }, { header: 'Max Discount (%)', format: 'number' }, { header: 'Max Term (Days)', format: 'integer' }, { header: 'Max Amount', format: 'money' }, { header: 'Approval Required' }], rows: Object.entries(GROUPS).map(([k, g]) => [k, g.maxDisc, g.maxTerm, g.maxAmount, g.approval ? 'Yes' : 'No']) },
    ],
    anomalies: out.filter((x) => x._a).map((x) => ({ id: x.no, type: x._a.type, description: x._a.description })),
    rules: ['Discount above the maximum of the product group.', 'Payment term above the maximum of the product group.', 'Amount above the maximum of the product group.', 'Collection status: more than 90 days overdue → At Risk; 30–90 days → Overdue; otherwise → Current; any other value is wrong.', 'Approver is "None" in a group that requires approval.', 'Invoice dated on a weekend.'],
  };
}

const GENERATORS = { sales, expenses, invoices };

/**
 * Generate a sample data set and its answer key.
 * @returns {{ file, keyFile, rulesFile, rows, anomalies, types }}
 */
export async function generateSample({ template = 'sales', out, rows, seed = 42, year = 2025, anomalyRate = 0.03, encoding = 'utf-8', keyFile = null, baseDir = process.cwd() } = {}) {
  const gen = GENERATORS[template];
  if (!gen) throw new Error(`Unknown sample template "${template}". Available: ${Object.keys(GENERATORS).join(', ')}.`);
  const n = Math.max(50, Math.min(200000, Number(rows) || (template === 'sales' ? 1000 : 300)));
  const data = gen(rng(Number(seed) || 42), n, { year: Number(year) || 2025, anomalyRate: Math.min(0.3, Math.max(0.005, Number(anomalyRate) || 0.03)) });
  const file = path.resolve(baseDir, out || `${template}.xlsx`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (/\.csv$/i.test(file)) {
    const s = data.sheets[0];
    await fsp.writeFile(file, csvBuffer([s.columns.map((c) => c.header), ...s.rows], { delimiter: ',', encoding, bom: /utf-?8/i.test(encoding) }));
  } else {
    await fsp.writeFile(file, await workbookBuffer({ sheets: data.sheets, properties: { title: `SYNTHETIC DATA — ${template} (seed ${seed})`, creator: 'SleepPilot sample generator' } }));
  }
  const key = path.resolve(baseDir, keyFile || file.replace(/\.(xlsx|csv)$/i, '') + '.key.json');
  await fsp.mkdir(path.dirname(key), { recursive: true });
  const types = {};
  for (const a of data.anomalies) types[a.type] = (types[a.type] || 0) + 1;
  await fsp.writeFile(key, JSON.stringify({ sleeppilotSampleKey: 1, template, seed: Number(seed), rows: n, file: path.basename(file), idColumn: data.idColumn, types, rules: data.rules, anomalies: data.anomalies }, null, 2));
  const rulesFile = file.replace(/\.(xlsx|csv)$/i, '') + '.rules.md';
  await fsp.writeFile(rulesFile, `# ${template} — rules to detect (synthetic data)\n\nWhat the app should find in ${path.basename(file)}. The record ids are in the answer key (${path.basename(key)}); the app must NOT read it.\n\n${data.rules.map((t) => `- ${t}`).join('\n')}\n`);
  return { file, keyFile: key, rulesFile, rows: n, anomalies: data.anomalies.length, types };
}
