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
