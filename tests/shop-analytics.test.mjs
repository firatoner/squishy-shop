import { budgetPurchases, lastYear, stockoutDays, supplierStats } from "../lib/shop-planning.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boughtTogether, tiedCapital, purchaseRecovery, previousPeriod, periodSummary } from "../lib/shop-analytics.ts";

const products = [{ id: 1, name: "Peach" }, { id: 2, name: "Berry" }, { id: 3, name: "Third" }];
const date = "2026-11-18";
const from = "2026-11-01";
const through = "2026-11-30";
const order = { id: 1, platform: "Dolap", date, status: "packed", gross: 10000, platformFee: 500, shipping: 1000, packing: 500, cost: 1200,
  receiptDate: date, receiptAmount: 9000, lines: [
    { productId: 1, productName: "Peach", purchaseId: 1, quantity: 3, agreedPrice: 2000, unitCost: 200 },
    { productId: 2, productName: "Berry", purchaseId: 2, quantity: 2, agreedPrice: 2000, unitCost: 300 },
  ],
};
const purchases = [
  { id: 1, name: "First", date: from, total: 2000, paymentDate: from, payments: [{ payerId: 1, amount: 2000, date: from }],
    lines: [{ productId: 1, quantity: 10, usedQuantity: 4, unitCost: 200 }] },
  { id: 2, name: "Second", date: "2026-11-10", total: 1500, paymentDate: null, payments: [],
    lines: [{ productId: 2, quantity: 5, usedQuantity: 2, unitCost: 300 }] },
];

test("basket pairs count unique products once per active order", () => {
  const multi = { ...order, lines: [...order.lines, { ...order.lines[0], quantity: 1 }, { ...order.lines[0], productId: 3, productName: "Third" }] };
  const rows = boughtTogether({ products, orders: [multi, order, { ...order, lines: [order.lines[0]] },
    { ...order, status: "cancelled" }, { ...order, status: "returned" }, { ...order, date: "2026-10-31" }] }, from, through);
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].firstId, rows[0].secondId, rows[0].orders], [1, 2, 2]);
  assert.equal(rows[0].share, 2 / 3 * 100);
});

test("capital is the cost of current remaining FIFO units including unpaid stock", () => {
  const result = tiedCapital({ products, purchases }, date);
  assert.deepEqual(result.map(row => [row.id, row.quantity, row.value, row.paidValue, row.days]), [[1, 6, 1200, 1200, 17], [2, 3, 900, 0, 8]]);
});

test("purchase recovery allocates net collected money exactly and retains unpaid targets", () => {
  const result = purchaseRecovery({ purchases, orders: [order, { ...order, status: "cancelled" }],
    stockLosses: [{ date, lines: [{ purchaseId: 1, quantity: 1, unitCost: 200 }] }] });
  const first = result.find(row => row.id === 1);
  const second = result.find(row => row.id === 2);
  assert.deepEqual([first.collectedNet, first.recoveryRate, first.remainingToRecover, first.lossCost], [4500, 225, 0, 200]);
  assert.deepEqual([second.collectedNet, second.paid, second.recoveryRate], [3000, 0, null]);
  assert.equal(result.reduce((sum, row) => sum + row.collectedNet, 0), 7500);
  const direct = purchaseRecovery({ purchases, orders: [{ ...order, netAfterShipping: 8500 }] });
  assert.equal(direct.reduce((sum, row) => sum + row.collectedNet, 0), 8500);
});

test("period comparison uses equal duration across leap dates and includes stock losses", () => {
  assert.deepEqual(previousPeriod("2026-11-01", "2026-11-18"), { from: "2026-10-14", through: "2026-10-31" });
  assert.deepEqual(previousPeriod("2024-03-01", "2024-03-31"), { from: "2024-01-30", through: "2024-02-29" });
  const result = periodSummary({ orders: [order, { ...order, status: "cancelled" }, { ...order, status: "returned" }],
    cash: [{ kind: "receipt", date, amount: 9000 }, { kind: "receipt", date: "2026-10-31", amount: 1000 }],
    stockLosses: [{ date, lines: [{ unitCost: 200, quantity: 1 }] }],
  }, from, through);
  assert.deepEqual([result.orders, result.quantity, result.gross, result.profit, result.collected, result.averageBasket], [1, 5, 10000, 6600, 9000, 10000]);
  assert.ok(Math.abs(result.returnRate - 100 / 3) < 0.0000001);
});

test("supplier quality uses inspected deliveries and delivery time ignores missing order dates", () => {
  const lines = [{ productId: 1, quantity: 8, unitCost: 100 }];
  const [row] = supplierStats([
    { supplier: "A", lines, orderedOn: "2026-10-01", date: "2026-10-05", rejectedUnits: 2 },
    { supplier: "a", lines, date: "2026-10-06", rejectedUnits: null },
    { supplier: "A", lines, date: "2026-10-07", rejectedUnits: 0 },
  ]);
  assert.deepEqual(row, { name: "A", purchases: 3, checked: 2, received: 18, rejected: 2, timed: 1, days: 4 });
});

test("stockout days use end-of-day stock and begin at the first acquired stock", () => {
  const moves = [
    { productId: 1, date: "2026-10-03", quantity: 2, kind: "purchase" },
    { productId: 1, date: "2026-10-05", quantity: -2, kind: "sale" },
    { productId: 1, date: "2026-10-07", quantity: 1, kind: "purchase" },
  ];
  const result = stockoutDays([{ id: 1, stock: 1 }, { id: 2, stock: 0 }], moves, "2026-10-06", 7);
  assert.equal(result.get(1), 2);
  assert.equal(result.get(2), null);
  assert.equal(lastYear("2024-02-29"), "2023-02-28");
});

test("budget list respects quantity tiers and keeps prioritized purchases within available money", () => {
  const suggestions = [
    { id: 2, name: "Other", stock: 1, dailySales: 10, suggestedQuantity: 3 },
    { id: 1, name: "Out", stock: 0, dailySales: 2, suggestedQuantity: 10 },
  ];
  const prices = [
    { productId: 1, supplier: "A", minimumQuantity: 1, unitCost: 120 },
    { productId: 1, supplier: "A", minimumQuantity: 10, unitCost: 80 },
  ];
  const purchases = [{ date: "2026-10-01", supplier: "B", lines: [{ productId: 2, quantity: 5, unitCost: 50 }] }];
  const plan = budgetPurchases(suggestions, purchases, prices, 875, "2026-10-10");
  assert.deepEqual(plan.rows.map(row => [row.id, row.selected.quantity, row.selected.total]), [[1, 10, 800], [2, 1, 50]]);
  assert.equal(plan.remaining, 25);
});
