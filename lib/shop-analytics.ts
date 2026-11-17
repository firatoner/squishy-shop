import { allocate, type PurchasePayment, type StockLoss } from "./shop-partnership.ts";
import { comparePlatforms } from "./shop-performance.ts";

type AnalysisOrder = Omit<Parameters<typeof comparePlatforms>[0][number], "lines"> & {
  id: number; shippingPayerId?: number | null; receiptDate: string | null; receiptAmount: number | null;
  lines: { productId: number; productName: string; purchaseId: number; quantity: number; agreedPrice: number; unitCost: number }[];
};
type AnalysisPurchase = {
  id: number; name: string; date: string; total: number; openingPayerId?: number | null; paymentDate: string | null; payments: PurchasePayment[];
  lines: { productId: number; quantity: number; usedQuantity: number; unitCost: number }[];
};
type AnalysisData = {
  products: { id: number; name: string }[]; orders: AnalysisOrder[]; purchases: AnalysisPurchase[];
  cash: { kind: string; date: string; amount: number }[]; stockLosses?: StockLoss[];
};
const active = (order: AnalysisOrder) => order.status === "pending" || order.status === "packed";
const inPeriod = (date: string, from: string, through: string) => date >= from && date <= through;

export function boughtTogether(data: Pick<AnalysisData, "orders" | "products">, from: string, through: string) {
  const names = new Map(data.products.map(product => [product.id, product.name]));
  const orders = data.orders.filter(order => active(order) && inPeriod(order.date, from, through));
  const pairs = new Map<string, { firstId: number; secondId: number; firstName: string; secondName: string; orders: number; share: number }>();
  for (const order of orders) {
    const ids = [...new Set(order.lines.map(line => line.productId))].sort((a, b) => a - b);
    for (let first = 0; first < ids.length; first++) {
      for (let second = first + 1; second < ids.length; second++) {
        const firstId = ids[first];
        const secondId = ids[second];
        const key = firstId + ":" + secondId;
        const pair = pairs.get(key) ?? {
          firstId, secondId, firstName: names.get(firstId) ?? order.lines.find(line => line.productId === firstId)!.productName,
          secondName: names.get(secondId) ?? order.lines.find(line => line.productId === secondId)!.productName, orders: 0, share: 0,
        };
        pair.orders += 1;
        pair.share = pair.orders / orders.length * 100;
        pairs.set(key, pair);
      }
    }
  }
  return [...pairs.values()].sort((a, b) => b.orders - a.orders || a.firstId - b.firstId || a.secondId - b.secondId);
}

export function tiedCapital(data: Pick<AnalysisData, "products" | "purchases">, today: string) {
  const rows = new Map(data.products.map(product => [product.id, {
    ...product, quantity: 0, value: 0, paidValue: 0, oldestDate: "", days: 0,
  }]));
  for (const purchase of data.purchases) {
    for (const line of purchase.lines) {
      const quantity = line.quantity - line.usedQuantity;
      if (quantity <= 0) continue;
      const row = rows.get(line.productId);
      if (!row) continue;
      const value = quantity * line.unitCost;
      row.quantity += quantity;
      row.value += value;
      if (purchase.paymentDate !== null || purchase.openingPayerId != null) row.paidValue += value;
      if (!row.oldestDate || purchase.date < row.oldestDate) row.oldestDate = purchase.date;
    }
  }
  for (const row of rows.values()) {
    if (row.oldestDate) row.days = Math.max(0, Math.floor((Date.parse(today + "T00:00:00Z") - Date.parse(row.oldestDate + "T00:00:00Z")) / 86400000));
  }
  return [...rows.values()].filter(row => row.quantity > 0).sort((a, b) => b.value - a.value || b.days - a.days);
}

export function purchaseRecovery(data: Pick<AnalysisData, "purchases" | "orders" | "stockLosses">) {
  const rows = new Map(data.purchases.map(purchase => {
    const paid = purchase.openingPayerId != null ? purchase.total : purchase.payments?.reduce((sum, payment) => sum + payment.amount, 0) ?? (purchase.paymentDate ? purchase.total : 0);
    return [purchase.id, {
      id: purchase.id, name: purchase.name, date: purchase.date, total: purchase.total, paid, collectedNet: 0,
      remainingStock: purchase.lines.reduce((sum, line) => sum + (line.quantity - line.usedQuantity) * line.unitCost, 0),
      soldQuantity: 0, lossCost: 0, remainingToRecover: paid, recoveryRate: null as number | null,
    }];
  }));
  for (const order of data.orders.filter(active)) {
    const weights = order.lines.map(line => line.quantity * line.agreedPrice);
    const hasGross = weights.some(weight => weight > 0);
    const net = order.receiptAmount === null || order.receiptDate === null ? 0
      : order.receiptAmount - (order.netAfterShipping == null || order.shippingPayerId != null ? order.shipping : 0) - order.packing;
    const portions = allocate(net, hasGross ? weights : order.lines.map(line => line.quantity));
    order.lines.forEach((line, index) => {
      const purchase = rows.get(line.purchaseId);
      if (purchase) { purchase.collectedNet += portions[index]; purchase.soldQuantity += line.quantity; }
    });
  }
  for (const loss of data.stockLosses ?? []) {
    for (const line of loss.lines) {
      const purchase = rows.get(line.purchaseId);
      if (purchase) purchase.lossCost += line.quantity * line.unitCost;
    }
  }
  for (const row of rows.values()) {
    row.remainingToRecover = Math.max(0, row.paid - row.collectedNet);
    row.recoveryRate = row.paid > 0 ? row.collectedNet / row.paid * 100 : null;
  }
  return [...rows.values()].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

export function previousPeriod(from: string, through: string) {
  const day = 86400000;
  const start = Date.parse(from + "T00:00:00Z");
  const end = Date.parse(through + "T00:00:00Z");
  const duration = end - start + day;
  return { from: new Date(start - duration).toISOString().slice(0, 10), through: new Date(start - day).toISOString().slice(0, 10) };
}

export function periodSummary(data: Pick<AnalysisData, "orders" | "cash" | "stockLosses">, from: string, through: string) {
  const platforms = comparePlatforms(data.orders, from, through);
  const orders = platforms.reduce((sum, platform) => sum + platform.orders, 0);
  const gross = platforms.reduce((sum, platform) => sum + platform.gross, 0);
  const returns = platforms.reduce((sum, platform) => sum + platform.returned, 0);
  const cancelled = platforms.reduce((sum, platform) => sum + platform.cancelled, 0);
  const totalOrders = orders + returns + cancelled;
  const lossCost = (data.stockLosses ?? []).filter(loss => inPeriod(loss.date, from, through))
    .reduce((sum, loss) => sum + loss.lines.reduce((total, line) => total + line.quantity * line.unitCost, 0), 0);
  return {
    orders, quantity: platforms.reduce((sum, platform) => sum + platform.quantity, 0), gross,
    profit: platforms.reduce((sum, platform) => sum + platform.profit, 0) - lossCost,
    averageBasket: orders ? Math.round(gross / orders) : 0,
    returnRate: totalOrders ? returns / totalOrders * 100 : 0, returns, cancelled, lossCost,
    collected: data.cash.filter(movement => movement.kind === "receipt" && inPeriod(movement.date, from, through)).reduce((sum, movement) => sum + movement.amount, 0),
  };
}
