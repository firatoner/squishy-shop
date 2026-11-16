import assert from "node:assert/strict";
import { test } from "node:test";
import { calculatePartnership } from "../lib/shop-partnership.ts";

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
