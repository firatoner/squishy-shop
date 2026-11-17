export type WholesalePrice = { productId: number; supplier: string; minimumQuantity: number; unitCost: number };

type PurchaseRecord = {
  supplier?: string | null; orderedOn?: string | null; rejectedUnits?: number | null; date: string;
  lines: { productId: number; quantity: number; unitCost: number }[];
};

const dayMs = 86_400_000;
const dayNumber = (date: string) => Date.parse(date + "T00:00:00Z") / dayMs;

export function supplierStats(purchases: PurchaseRecord[]) {
  const suppliers = new Map<string, {
    name: string; purchases: number; checked: number; received: number; rejected: number; timed: number; days: number;
  }>();
  for (const purchase of purchases) {
    if (!purchase.supplier) continue;
    const key = purchase.supplier.toLocaleLowerCase("tr-TR");
    const row = suppliers.get(key) ?? {
      name: purchase.supplier, purchases: 0, checked: 0, received: 0, rejected: 0, timed: 0, days: 0,
    };
    row.purchases++;
    if (purchase.rejectedUnits != null) {
      row.checked++;
      row.received += purchase.lines.reduce((sum, line) => sum + line.quantity, 0) + purchase.rejectedUnits;
      row.rejected += purchase.rejectedUnits;
    }
    if (purchase.orderedOn) {
      row.days += dayNumber(purchase.date) - dayNumber(purchase.orderedOn);
      row.timed++;
    }
    suppliers.set(key, row);
  }
  return [...suppliers.values()].sort((a, b) => a.name.localeCompare(b.name, "tr"));
}

export function stockoutDays(products: { id: number; stock: number }[],
  movements: { productId: number; date: string; quantity: number; kind: string }[],
  through: string, days: number) {
  const history = new Map<number, { first: number; totals: Map<number, number> }>();
  for (const movement of movements) {
    const day = dayNumber(movement.date);
    const row = history.get(movement.productId) ?? { first: Infinity, totals: new Map() };
    if (movement.kind === "purchase") row.first = Math.min(row.first, day);
    row.totals.set(day, (row.totals.get(day) ?? 0) + movement.quantity);
    history.set(movement.productId, row);
  }
  const end = dayNumber(through);
  const start = end - days + 1;
  return new Map(products.map(product => {
    const row = history.get(product.id);
    if (!row || row.first > end) return [product.id, null];
    let balance = product.stock;
    for (const [day, quantity] of row.totals) if (day > end) balance -= quantity;
    let unavailable = 0;
    for (let day = end; day >= Math.max(start, row.first); day--) {
      if (balance <= 0) unavailable++;
      balance -= row.totals.get(day) ?? 0;
    }
    return [product.id, unavailable];
  }));
}

export function budgetPurchases(
  suggestions: { id: number; name: string; stock: number; dailySales: number; suggestedQuantity: number }[],
  purchases: PurchaseRecord[], prices: WholesalePrice[], budget: number, through: string,
) {
  const latest = new Map<number, { date: string; unitCost: number; supplier: string | null }>();
  for (const purchase of purchases) {
    if (purchase.date > through) continue;
    for (const line of purchase.lines) {
      const original = latest.get(line.productId);
      if (line.unitCost > 0 && (!original || original.date < purchase.date)) {
        latest.set(line.productId, { date: purchase.date, unitCost: line.unitCost, supplier: purchase.supplier ?? null });
      }
    }
  }
  const ordered = suggestions.filter(row => row.suggestedQuantity > 0).sort((a, b) =>
    Number(b.stock === 0) - Number(a.stock === 0) || b.dailySales - a.dailySales || a.name.localeCompare(b.name, "tr"));
  let remaining = budget;
  const rows = ordered.map(row => {
    const tiers = prices.filter(price => price.productId === row.id);
    const fallback = latest.get(row.id);
    const options = tiers.length ? tiers : fallback ? [{ ...fallback, minimumQuantity: 1 }] : [];
    const candidates = options.flatMap(option => {
      const next = tiers.filter(tier => tier.supplier === option.supplier && tier.minimumQuantity > option.minimumQuantity)
        .reduce((limit, tier) => Math.min(limit, tier.minimumQuantity - 1), row.suggestedQuantity);
      const quantity = Math.min(next, Math.floor(remaining / option.unitCost));
      return quantity >= option.minimumQuantity ? [{ ...option, quantity, total: quantity * option.unitCost }] : [];
    });
    candidates.sort((a, b) => b.quantity - a.quantity || a.total - b.total);
    const selected = candidates[0];
    if (selected) remaining -= selected.total;
    return { ...row, selected, priced: options.length > 0, usesTier: tiers.length > 0 };
  });
  return { rows, remaining };
}

export function lastYear(day: string) {
  const year = Number(day.slice(0, 4)) - 1;
  const shifted = String(year).padStart(4, "0") + day.slice(4);
  return day.endsWith("-02-29") && new Date(shifted + "T00:00:00Z").getUTCMonth() !== 1
    ? String(year) + "-02-28" : shifted;
}
