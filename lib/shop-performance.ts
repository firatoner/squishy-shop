import { calculatePartnership } from "./shop-partnership.ts";

type PerformanceData = Parameters<typeof calculatePartnership>[0] & {
  products: { id: number; name: string; stock: number }[];
  purchases: {
    id: number; date: string; paymentDate: string | null; payerId: number | null;
    lines: { productId: number; quantity: number; usedQuantity: number }[];
  }[];
};

export function calculatePerformance(data: PerformanceData, from: string, through: string, today: string) {
  const sales = new Map(calculatePartnership(data, from, through).products.map(product => [product.productId, product]));
  const stockDates = new Map<number, string>();
  for (const purchase of data.purchases) {
    for (const line of purchase.lines) {
      if (line.quantity <= line.usedQuantity) continue;
      const current = stockDates.get(line.productId);
      if (!current || purchase.date < current) stockDates.set(line.productId, purchase.date);
    }
  }
  return data.products.map(product => {
    const sale = sales.get(product.id);
    const oldest = stockDates.get(product.id);
    const daysInStock = oldest ? Math.max(0, Math.floor((Date.parse(today + "T00:00:00Z") - Date.parse(oldest + "T00:00:00Z")) / 86400000)) : 0;
    return {
      id: product.id, name: product.name, stock: product.stock, daysInStock,
      quantity: sale?.quantity ?? 0, gross: sale?.gross ?? 0, profit: sale?.profit ?? 0,
      margin: sale?.gross ? sale.profit / sale.gross * 100 : null,
    };
  });
}

type PlatformOrder = {
  platform: string; date: string; status: string; gross: number; platformFee: number; shipping: number;
  packing: number; cost: number; netAfterShipping?: number | null; lines: { quantity: number }[];
};

export function comparePlatforms(orders: PlatformOrder[], from: string, through: string) {
  return ["Dolap", "Gardrops"].map(platform => {
    const period = orders.filter(order => order.platform === platform && order.date >= from && order.date <= through);
    const active = period.filter(order => order.status === "pending" || order.status === "packed");
    const gross = active.reduce((sum, order) => sum + order.gross, 0);
    const deductions = active.reduce((sum, order) =>
      sum + (order.netAfterShipping == null ? order.platformFee + order.shipping : order.gross - order.netAfterShipping), 0);
    const packing = active.reduce((sum, order) => sum + order.packing, 0);
    const cost = active.reduce((sum, order) => sum + order.cost, 0);
    const profit = gross - deductions - packing - cost;
    return {
      platform, orders: active.length, quantity: active.reduce((sum, order) => sum + order.lines.reduce((count, line) => count + line.quantity, 0), 0),
      gross, deductions, packing, cost, profit,
      averageBasket: active.length ? Math.round(gross / active.length) : null,
      margin: gross > 0 ? profit / gross * 100 : null,
      cancelled: period.filter(order => order.status === "cancelled").length,
      returned: period.filter(order => order.status === "returned").length,
    };
  });
}

export function restockSuggestions(
  data: Pick<PerformanceData, "products" | "orders">, today: string, windowDays: number, targetDays: number,
) {
  if (!Number.isInteger(windowDays) || !Number.isInteger(targetDays) || windowDays < 1 || targetDays < 1 || windowDays > 365 || targetDays > 365) {
    throw new RangeError("Gün sayısı 1–365 arasında olmalı.");
  }
  const start = new Date(today + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - windowDays + 1);
  const from = start.toISOString().slice(0, 10);
  const sold = new Map<number, number>();
  for (const order of data.orders) {
    if (order.date < from || order.date > today || (order.status !== "pending" && order.status !== "packed")) continue;
    for (const line of order.lines) sold.set(line.productId, (sold.get(line.productId) ?? 0) + line.quantity);
  }
  return data.products.map(product => {
    const quantity = sold.get(product.id) ?? 0;
    const targetStock = Math.ceil(quantity * targetDays / windowDays);
    return {
      ...product, quantity, dailySales: quantity / windowDays,
      daysRemaining: quantity ? product.stock * windowDays / quantity : null,
      targetStock, suggestedQuantity: Math.max(0, targetStock - product.stock),
    };
  });
}
