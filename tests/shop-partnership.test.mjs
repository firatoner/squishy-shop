import assert from "node:assert/strict";
import { test } from "node:test";
import { calculatePartnership } from "../lib/shop-partnership.ts";
import { calculatePerformance, comparePlatforms, restockSuggestions, performanceTrend } from "../lib/shop-performance.ts";

const from = "2026-11-01";
const through = "2026-11-30";
const date = "2026-11-16";
const sale = {
  id: 1, date, status: "packed", platformFee: 10000, shipping: 3000, packing: 2000,
  receiptAmount: 90000, receiptDate: date, recipientId: 1,
  lines: [
    { productId: 1, productName: "Peach", purchaseId: 1, quantity: 1, agreedPrice: 15000, unitCost: 4000, firstPartnerShare: 70 },
    { productId: 1, productName: "Peach", purchaseId: 2, quantity: 3, agreedPrice: 15000, unitCost: 2000, firstPartnerShare: 70 },
    { productId: 2, productName: "Berry", purchaseId: 2, quantity: 2, agreedPrice: 20000, unitCost: 5000, firstPartnerShare: 25 },
  ],
};
const fixtures = {
  users: [{ id: 2 }, { id: 1 }],
  orders: [sale],
  purchases: [{ id: 1, paymentDate: "2026-10-31", payerId: 1 }, { id: 2, paymentDate: date, payerId: 2 }],
  expenses: [{ date, amount: 5000, payerId: 2, firstPartnerShare: 50 }],
  cash: [
    { kind: "receipt", date, amount: 90000, memberId: 1 },
    { kind: "expense", date, amount: -5000, memberId: 2 },
    { kind: "purchase", date, amount: -20000, memberId: 2 },
  ],
  partnerTransfers: [],
};

test("splits each product at its sale rate, reimburses sold FIFO stock, and nets completed transfers", () => {
  const before = calculatePartnership(fixtures, from, through);
  assert.deepEqual(before.products.map(product => [product.name, product.quantity, product.profit, product.firstProfit, product.secondProfit]),
    [["Peach", 4, 41000, 28700, 12300], ["Berry", 2, 24000, 6000, 18000]]);
  assert.deepEqual(before.partners.map(partner => [partner.receipts, partner.stockPaid, partner.expensesPaid, partner.realizedShare]),
    [[90000, 0, 0, 34800], [0, 20000, 5000, 30200]]);
  assert.equal(before.firstBalance, -51200);
  const withTransfer = { ...fixtures, partnerTransfers: [{ senderId: 1, recipientId: 2, date: "2026-12-01", amount: 51200 }] };
  assert.equal(calculatePartnership(withTransfer, from, through).firstBalance, -51200);
  const nextPeriod = calculatePartnership(withTransfer, "2026-12-01", "2026-12-31");
  assert.equal(nextPeriod.firstBalance, 0);
  assert.deepEqual(nextPeriod.products, []);
});

test("holds back orders with missing shares or unpaid stock and excludes cancelled receipts", () => {
  const missing = { ...sale, id: 2, lines: [{ ...sale.lines[0], firstPartnerShare: null }] };
  const cancelled = { ...sale, id: 3, status: "cancelled" };
  const result = calculatePartnership({
    ...fixtures,
    orders: [sale, missing, cancelled],
    purchases: [{ id: 1, paymentDate: date, payerId: 1 }, { id: 2, paymentDate: null, payerId: null }],
    expenses: [{ ...fixtures.expenses[0], firstPartnerShare: null }],
  }, from, through);
  assert.deepEqual([...result.missingShares], [2]);
  assert.deepEqual([...result.awaitingStockPayments], [1]);
  assert.equal(result.excludedReceipts, 90000);
  assert.equal(result.unassignedExpenses, 1);
  assert.equal(result.firstBalance, 0);
});

test("allocates the final cent exactly across products, including zero-gross orders", () => {
  const free = {
    ...sale, platformFee: 1, shipping: 0, packing: 0, receiptAmount: null, receiptDate: null,
    lines: sale.lines.map(line => ({ ...line, agreedPrice: 0, unitCost: 0 })),
  };
  const result = calculatePartnership({ ...fixtures, orders: [free], expenses: [] }, from, through);
  assert.equal(result.products.reduce((sum, product) => sum + product.profit, 0), -1);
  for (const product of result.products) assert.equal(product.firstProfit + product.secondProfit, product.profit);
});

test("uses the order's direct net before packing to calculate product profits", () => {
  const direct = { ...sale, netAfterShipping: 87500, platformFee: 0, shipping: 0 };
  const result = calculatePartnership({ ...fixtures, orders: [direct] }, from, through);
  assert.deepEqual(result.products.map(product => product.profit), [41300, 24200]);
  assert.equal(result.firstBalance, -51200);
});

test("splits the same product using each FIFO lot's independent share", () => {
  const mixed = { ...sale, packing: 0, shipping: 0, platformFee: 0, netAfterShipping: null, receiptAmount: 60000,
    lines: [
      { ...sale.lines[0], agreedPrice: 30000, quantity: 1, unitCost: 10000, firstPartnerShare: 100 },
      { ...sale.lines[0], purchaseId: 2, agreedPrice: 30000, quantity: 1, unitCost: 10000, firstPartnerShare: 0 },
    ],
  };
  const result = calculatePartnership({ ...fixtures, orders: [mixed], expenses: [] }, from, through);
  assert.equal(result.products.length, 1);
  assert.deepEqual([result.products[0].profit, result.products[0].firstProfit, result.products[0].secondProfit], [40000, 20000, 20000]);
  assert.equal(result.firstBalance, -30000);
});

test("performance uses active sales and the oldest remaining lot for stock age", () => {
  const data = { ...fixtures,
    products: [{ id: 1, name: "Peach", stock: 3 }, { id: 2, name: "Berry", stock: 0 }, { id: 3, name: "Unsold", stock: 2 }],
    orders: [sale, { ...sale, id: 4, status: "cancelled" }, { ...sale, id: 5, status: "returned" }],
    purchases: [
      { ...fixtures.purchases[0], date: "2026-09-01", lines: [{ productId: 1, quantity: 2, usedQuantity: 2 }] },
      { ...fixtures.purchases[1], date: "2026-11-10", lines: [{ productId: 1, quantity: 4, usedQuantity: 1 }, { productId: 3, quantity: 2, usedQuantity: 0 }] },
    ],
  };
  const result = calculatePerformance(data, from, through, "2026-11-18");
  assert.deepEqual(result.map(row => [row.quantity, row.profit, row.stock, row.daysInStock]), [[4, 41000, 3, 8], [2, 24000, 0, 0], [0, 0, 2, 8]]);
  assert.equal(result.reduce((sum, row) => sum + row.profit, 0), 65000);
  assert.deepEqual(calculatePerformance(data, "2026-12-01", "2026-12-31", "2026-11-18").map(row => row.quantity), [0, 0, 0]);
});

test("platform comparison reconciles direct nets, fees and costs and excludes closed orders from totals", () => {
  const platformSale = { ...sale, platform: "Dolap", gross: 100000, cost: 20000 };
  const otherPlatform = { ...platformSale, platform: "Gardrops", netAfterShipping: 87500, platformFee: 0, shipping: 0 };
  const compared = comparePlatforms([
    platformSale, otherPlatform, { ...platformSale, status: "cancelled" }, { ...otherPlatform, status: "returned" },
    { ...platformSale, date: "2026-10-31" }, { ...otherPlatform, date: "2026-12-01" },
  ], from, through);
  assert.deepEqual(compared.map(row => [row.platform, row.orders, row.quantity, row.gross, row.deductions, row.profit, row.averageBasket, row.cancelled, row.returned]),
    [["Dolap", 1, 6, 100000, 13000, 65000, 100000, 1, 0], ["Gardrops", 1, 6, 100000, 12500, 65500, 100000, 0, 1]]);
  const empty = comparePlatforms([], from, through);
  assert.ok(empty.every(row => row.profit === 0 && row.margin === null && row.averageBasket === null));
});

test("restock uses an inclusive rolling window, exact target rounding and current stock", () => {
  const data = { products: [{ id: 1, name: "Peach", stock: 2 }, { id: 2, name: "No sales", stock: 0 }], orders: [
    { ...sale, date: "2026-11-18", lines: [{ ...sale.lines[0], quantity: 12 }] },
    { ...sale, date: "2026-10-20", lines: [{ ...sale.lines[0], quantity: 3 }] },
    { ...sale, date: "2026-10-19" }, { ...sale, date: "2026-11-19" },
    { ...sale, status: "cancelled" }, { ...sale, status: "returned" },
  ] };
  const result = restockSuggestions(data, "2026-11-18", 30, 14);
  assert.deepEqual(result.map(row => [row.quantity, row.targetStock, row.suggestedQuantity, row.daysRemaining]), [[15, 7, 5, 4], [0, 0, 0, null]]);
  assert.equal(restockSuggestions(data, "2026-11-18", 30, 60)[0].suggestedQuantity, 28);
  assert.equal(restockSuggestions({ ...data, products: [{ id: 1, name: "Peach", stock: 100 }] }, "2026-11-18", 30, 14)[0].suggestedQuantity, 0);
});

test("shared payments reimburse each partner and preserve total cents across partial sales and losses", () => {
  const purchase = { id: 1, total: 2, payerId: null, paymentDate: date,
    payments: [{ payerId: 1, amount: 1, date }, { payerId: 2, amount: 1, date }] };
  const order = { ...sale, packing: 0, platformFee: 0, shipping: 0, receiptAmount: 10,
    lines: [{ ...sale.lines[0], quantity: 1, unitCost: 1, agreedPrice: 10, firstPartnerShare: 50 }] };
  const result = calculatePartnership({ ...fixtures, purchases: [purchase], orders: [order], expenses: [],
    stockLosses: [{ id: 1, productId: 1, productName: "Peach", quantity: 1, date, reason: "damaged", note: "",
      lines: [{ purchaseId: 1, quantity: 1, unitCost: 1, firstPartnerShare: 50 }] }],
  }, from, through);
  assert.equal(result.firstBalance, -5);
  assert.deepEqual(result.partners.map(partner => partner.realizedShare), [4, 4]);
  assert.deepEqual([result.products[0].profit, result.products[0].lossCost], [8, 1]);
});

test("trend totals agree with product results including loss costs", () => {
  const data = { ...fixtures, products: [{ id: 1, name: "Peach", stock: 1 }],
    purchases: fixtures.purchases.map(purchase => ({ ...purchase, date, lines: [] })),
    stockLosses: [{ id: 1, productId: 1, productName: "Peach", quantity: 1, date, reason: "lost", note: "",
      lines: [{ purchaseId: 1, quantity: 1, unitCost: 1000, firstPartnerShare: 50 }] }],
  };
  const trend = performanceTrend(data, from, through);
  assert.ok(trend.length <= 12);
  assert.equal(trend.reduce((sum, point) => sum + point.gross, 0), 100000);
  assert.equal(trend.reduce((sum, point) => sum + point.profit, 0), 64000);
});
