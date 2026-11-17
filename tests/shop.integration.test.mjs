import assert from "node:assert/strict";
import { test } from "node:test";

const baseUrl = process.env.SHOP_TEST_BASE_URL;
const setupToken = process.env.SHOP_TEST_SETUP_TOKEN;

assert.ok(baseUrl && setupToken, "Set SHOP_TEST_BASE_URL and SHOP_TEST_SETUP_TOKEN for a disposable test instance with a fresh database.");

test("Two members track inventory, sales, supplier payments, and expenses", async () => {
  const users = [
    { username: "mert", name: "Mert", password: "local-test-mert-password" },
    { username: "ayse", name: "Ay\u015fe", password: "local-test-ayse-password" },
  ];
  const date = "2026-09-15";

  function client() {
    let cookie;
    return async (path, body) => {
      const url = new URL(`/api/${path}`, baseUrl);
      const response = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: {
          ...(body && { "Content-Type": "application/json", Origin: url.origin }),
          ...(cookie && { Cookie: cookie }),
        },
        body: body && JSON.stringify(body),
      });
      if (response.headers.has("set-cookie")) {
        cookie = response.headers.get("set-cookie").split(";")[0];
      }
      const data = response.headers.get("content-type")?.includes("json")
        ? await response.json()
        : await response.text();
      return { status: response.status, data, headers: response.headers };
    };
  }

  const anonymous = client();
  const mert = client();
  const ayse = client();
  async function ok(call) {
    const { status, data } = await call;
    assert.ok(status >= 200 && status < 300, `Expected success, got ${status} ${JSON.stringify(data)}`);
    return data;
  }

  assert.deepEqual(await ok(anonymous("session")), { user: null, needsSetup: true });
  assert.equal((await anonymous("state")).status, 401);
  assert.equal((await anonymous("export?kind=sales")).status, 401);
  assert.equal((await anonymous("product", { name: "Blocked", listPrice: 100, lowThreshold: 0 })).status, 401);
  assert.ok((await anonymous("setup", { token: "wrong", users })).status >= 400);
  await ok(anonymous("setup", { token: setupToken, users }));
  assert.ok((await anonymous("setup", { token: setupToken, users })).status >= 400);
  assert.ok((await mert("login", { ...users[0], password: "wrong" })).status >= 400);
  for (const [call, user] of [[mert, users[0]], [ayse, users[1]]]) {
    const login = await call("login", { username: user.username, password: user.password });
    assert.ok(login.status < 300, JSON.stringify(login.data));
    assert.match(login.headers.get("set-cookie"), /HttpOnly/i);
    assert.equal((await ok(call("session"))).user.username, user.username);
  }

  const mertId = (await ok(mert("session"))).user.id;
  const ayseId = (await ok(ayse("session"))).user.id;
  assert.notEqual(mertId, ayseId);
  const productId = (await ok(mert("product", { name: "Peach", dolapListPrice: 60000, gardropsListPrice: 70000, lowThreshold: 1, firstPartnerShare: 70 }))).id;
  const purchaseId = (await ok(mert("purchase", {
    name: "Wholesale September", date, total: 20000,
    lines: [{ productId, quantity: 1, unitCost: 20000 }],
  }))).id;
  const state = () => ok(mert("state"));
  assert.equal((await state()).settings.defaultPacking, 1000);
  const makeOrder = (call, reference) => call("order", {
    platform: "Dolap", date, reference, platformFee: 4000, shipping: 0, packing: 1000,
    lines: [{ productId, quantity: 1, agreedPrice: 55000 }],
  });

  const competingOrders = await Promise.all([makeOrder(mert, "D-001"), makeOrder(ayse, "D-002")]);
  const statuses = competingOrders.map(({ status }) => status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], JSON.stringify(competingOrders));
  const firstOrderId = competingOrders.find(({ status }) => status === 200).data.id;
  const soldState = await state();
  assert.equal(soldState.products[0].stock, 0);
  assert.equal(soldState.orders.length, 1);
  assert.equal(soldState.stock.filter(({ kind }) => kind === "sale").length, 1);

  await ok(mert("product", { id: productId, name: "Peach", dolapListPrice: 65000, gardropsListPrice: 75000, lowThreshold: 1, firstPartnerShare: 25 }));
  const updatedState = await state();
  const { dolapListPrice, gardropsListPrice } = updatedState.products.find(({ id }) => id === productId);
  assert.deepEqual([dolapListPrice, gardropsListPrice], [65000, 75000]);
  const order = updatedState.orders.find(({ id }) => id === firstOrderId);
  assert.equal(order.lines[0].listPrice, 60000);
  assert.equal(order.lines[0].firstPartnerShare, 70);
  assert.equal(order.lines[0].purchaseId, purchaseId);
  assert.equal(order.discount, 5000);
  assert.equal(order.gross, 55000);
  assert.equal(order.expectedReceipt, 51000);
  assert.equal(order.profit, 30000);

  await ok(ayse("order-status", { id: firstOrderId, status: "cancelled", date }));
  assert.equal((await ayse("order-status", { id: firstOrderId, status: "cancelled", date })).status, 409);
  assert.equal((await state()).products[0].stock, 1);
  assert.equal((await state()).stock.filter(({ kind }) => kind === "cancelled").length, 1);

  const returnId = (await ok(makeOrder(mert, "D-003"))).id;
  await ok(mert("order-status", { id: returnId, status: "packed", date }));
  await ok(ayse("order-status", { id: returnId, status: "returned", date, returns: [{ productId, quantity: 1 }] }));
  assert.equal((await ayse("order-status", { id: returnId, status: "returned", date, returns: [{ productId, quantity: 1 }] })).status, 409);
  assert.equal((await state()).products[0].stock, 1);
  assert.equal((await state()).stock.filter(({ kind }) => kind === "returned").length, 1);

  const receiptOrderId = (await ok(makeOrder(mert, "D-004"))).id;
  await ok(mert("order-status", { id: receiptOrderId, status: "packed", date }));
  assert.equal((await state()).cash.filter(({ kind }) => kind === "receipt").length, 0);
  await ok(ayse("receipt", { id: receiptOrderId, date, amount: 51000, recipientId: mertId }));
  const damagedProduct = (await ok(mert("product", { name: "Berry", dolapListPrice: 2500, gardropsListPrice: 3000, lowThreshold: 0 }))).id;
  await ok(mert("purchase", {
    name: "Wholesale Berry", date, total: 1000, lines: [{ productId: damagedProduct, quantity: 1, unitCost: 1000 }],
  }));
  const damagedOrder = (await ok(mert("order", {
    platform: "Gardrops", date, reference: "G-001", platformFee: 0, shipping: 0, packing: 0,
    lines: [{ productId: damagedProduct, quantity: 1, agreedPrice: 2000 }],
  }))).id;
  const gardropsOrder = (await state()).orders.find(({ id }) => id === damagedOrder);
  assert.equal(gardropsOrder.lines[0].listPrice, 3000);
  assert.equal(gardropsOrder.lines[0].firstPartnerShare, null);
  const lateShare = { id: damagedOrder, productId: damagedProduct, firstPartnerShare: 35 };
  await ok(ayse("order-share", lateShare));
  assert.equal((await ayse("order-share", { ...lateShare, firstPartnerShare: 40 })).status, 409);
  assert.equal((await state()).orders.find(({ id }) => id === damagedOrder).lines[0].firstPartnerShare, 35);
  assert.equal(gardropsOrder.discount, 1000);
  await ok(mert("order-status", { id: damagedOrder, status: "packed", date }));
  await ok(ayse("order-status", { id: damagedOrder, status: "returned", date, returns: [] }));
  assert.equal((await state()).products.find(({ id }) => id === damagedProduct).stock, 0);

  assert.ok(!(await state()).cash.some(({ kind, id }) => kind === "purchase" && id === purchaseId));
  await ok(ayse("purchase-payment", { id: purchaseId, date, payerId: mertId }));
  assert.equal((await ayse("purchase-payment", { id: purchaseId, date, payerId: mertId })).status, 409);
  const expenseId = (await ok(mert("expense", { category: "Supplies", date, amount: 260, payerId: ayseId, note: "Tape and mailers" }))).id;
  const { cash } = await state();
  const receipts = cash.filter(({ kind }) => kind === "receipt");
  assert.equal(receipts.length, 1);
  assert.deepEqual([receipts[0].amount, receipts[0].memberId, receipts[0].actorId], [51000, mertId, ayseId]);
  const payments = cash.filter(({ kind }) => kind === "purchase");
  assert.equal(payments.length, 1);
  assert.deepEqual([payments[0].amount, payments[0].memberId, payments[0].actorId], [-20000, mertId, ayseId]);
  const expenses = cash.filter(({ kind }) => kind === "expense");
  assert.equal(expenses.length, 1);
  assert.deepEqual([expenses[0].amount, expenses[0].memberId, expenses[0].actorId], [-260, ayseId, mertId]);
  assert.equal(cash.reduce((sum, movement) => sum + movement.amount, 0), 30740);

  for (const [kind, expected] of [["sales", "D-004"], ["stock", "Peach"], ["expenses", "Tape and mailers"]]) {
    const report = await mert(`export?kind=${kind}&from=2026-09-01&to=2026-09-30`);
    assert.equal(report.status, 200);
    assert.match(report.headers.get("content-type"), /text\/csv/i);
    assert.ok(report.data.includes(expected), `Missing ${expected} in ${kind} CSV: ${report.data}`);
    const outsideRange = await ok(ayse(`export?kind=${kind}&from=2026-10-01&to=2026-10-31`));
    assert.ok(!outsideRange.includes(expected));
  }

  const corrections = [
    { kind: "receipt", id: receiptOrderId, date: "2026-09-17", amount: 50000, memberId: ayseId },
    { kind: "purchase", id: purchaseId, date: "2026-09-18", memberId: ayseId },
    { kind: "expense", id: expenseId, date: "2026-09-19", amount: 580, memberId: mertId, category: "Kargo", note: "Updated shipping", firstPartnerShare: 0 },
  ];
  assert.equal((await client()("cash-delete", corrections[0])).status, 401);
  assert.equal((await ayse("cash-edit", { ...corrections[0], amount: 0 })).status, 400);
  for (const correction of corrections) await ok(ayse("cash-edit", correction));
  const corrected = await state();
  const receipt = corrected.orders.find(({ id }) => id === receiptOrderId);
  assert.equal(receipt.lines[0].firstPartnerShare, 70);
  assert.deepEqual([receipt.receiptDate, receipt.receiptAmount, receipt.recipientId], ["2026-09-17", 50000, ayseId]);
  const purchase = corrected.purchases.find(({ id }) => id === purchaseId);
  assert.deepEqual([purchase.paymentDate, purchase.payerId, purchase.total], ["2026-09-18", ayseId, 20000]);
  const expense = corrected.expenses.find(({ id }) => id === expenseId);
  assert.deepEqual([expense.date, expense.amount, expense.payerId, expense.actorId, expense.category, expense.note],
    ["2026-09-19", 580, mertId, mertId, "Kargo", "Updated shipping"]);
  assert.equal(expense.firstPartnerShare, 0);
  assert.equal(corrected.summary.cashBalance, 29420);
  assert.match(await ok(mert("export?kind=expenses")), /Updated shipping/);

  for (const correction of corrections) await ok(ayse("cash-delete", correction));
  assert.equal((await ayse("cash-delete", corrections[0])).status, 404);
  assert.equal((await ayse("cash-edit", corrections[2])).status, 404);
  const cleared = await state();
  assert.equal(cleared.summary.cashBalance, 0);
  assert.deepEqual(cleared.cash, []);
  assert.deepEqual(cleared.expenses, []);
  assert.equal(cleared.orders.find(({ id }) => id === receiptOrderId).receiptDate, null);
  assert.equal(cleared.purchases.find(({ id }) => id === purchaseId).paymentDate, null);
  assert.deepEqual(cleared.stock, corrected.stock);
  assert.doesNotMatch(await ok(mert("export?kind=expenses")), /Updated shipping/);
  await ok(ayse("receipt", { id: receiptOrderId, date, amount: 51000, recipientId: mertId }));
  await ok(ayse("purchase-payment", { id: purchaseId, date, payerId: mertId }));
  const transferPayload = { senderId: mertId, recipientId: ayseId, date, amount: 12345, note: "Partner settlement" };
  assert.equal((await client()("partner-transfer", transferPayload)).status, 401);
  assert.equal((await ayse("partner-transfer", { ...transferPayload, recipientId: mertId })).status, 400);
  const transferId = (await ok(mert("partner-transfer", transferPayload))).id;
  const transferred = await state();
  assert.deepEqual(transferred.partnerTransfers, [{ id: transferId, ...transferPayload }]);
  assert.equal(transferred.summary.cashBalance, 31000);
  await ok(ayse("partner-transfer-delete", { id: transferId }));
  assert.deepEqual((await state()).partnerTransfers, []);
  assert.equal((await client()("settings", { defaultPacking: 1275 })).status, 401);
  assert.equal((await ayse("settings", { defaultPacking: -1 })).status, 400);
  await ok(ayse("settings", { defaultPacking: 1275 }));
  const withSettings = await state();
  assert.equal(withSettings.settings.defaultPacking, 1275);
  assert.equal(withSettings.orders.find(({ id }) => id === receiptOrderId).packing, 1000);
  assert.equal(withSettings.summary.cashBalance, 31000);
  await ok(mert("settings", { defaultPacking: 1000 }));

  // The bundle uses the selected channel prices and retains the remainder cent across FIFO lots.
  const [bundleA, bundleB] = await Promise.all([2000, 4000].map(async (gardropsListPrice) =>
    (await ok(mert("product", { name: "Bundle " + gardropsListPrice, dolapListPrice: 0, gardropsListPrice, lowThreshold: 0 }))).id));
  await ok(mert("purchase", { name: "First lot", date, total: 800, lines: [{ productId: bundleA, quantity: 2, unitCost: 400 }] }));
  await ok(mert("purchase", { name: "Second lot", date, total: 1100, lines: [
    { productId: bundleA, quantity: 1, unitCost: 400 }, { productId: bundleB, quantity: 1, unitCost: 700 },
  ] }));
  const bundle = {
    date, reference: "BUNDLE-1", platform: "Gardrops", saleTotal: 8002, netAfterShipping: 6900, packing: 925,
    lines: [{ productId: bundleA, quantity: 3 }, { productId: bundleB, quantity: 1 }],
  };
  assert.equal((await ayse("order", { ...bundle, netAfterShipping: 8003 })).status, 400);
  const bundleId = (await ok(ayse("order", bundle))).id;
  const bundled = (await state()).orders.find(({ id }) => id === bundleId);
  assert.deepEqual([bundled.gross, bundled.discount, bundled.netAfterShipping, bundled.packing, bundled.cost, bundled.profit],
    [8002, 1998, 6900, 925, 1900, 4075]);
  assert.equal(bundled.lines.filter(line => line.productId === bundleA).reduce((sum, line) => sum + line.agreedPrice * line.quantity, 0), 4801);
  assert.deepEqual(bundled.lines.filter(line => line.productId === bundleA).map(line => line.agreedPrice).sort(), [1600, 1600, 1601]);
  assert.equal(bundled.lines.find(line => line.productId === bundleB).agreedPrice, 3201);
  const bundleCsv = await ok(mert("export?kind=sales"));
  assert.match(bundleCsv, /Kargo ve kesinti sonrası net \(TL\)/);
  assert.ok(bundleCsv.split("\r\n").some(line => line.includes('"BUNDLE-1"') && line.endsWith('"69,00"')));
  await ok(ayse("order-status", { id: bundleId, status: "cancelled", date }));
  const zeroListBundle = { ...bundle, platform: "Dolap", reference: "BUNDLE-2", saleTotal: 3, netAfterShipping: -25, packing: 0 };
  const zeroListId = (await ok(ayse("order", zeroListBundle))).id;
  const fallback = (await state()).orders.find(({ id }) => id === zeroListId);
  assert.equal(fallback.lines.filter(line => line.productId === bundleA).reduce((sum, line) => sum + line.agreedPrice * line.quantity, 0), 2);
  assert.equal(fallback.profit, -1925);
  assert.equal((await state()).summary.cashBalance, 31000);

  const [editableProduct, replacementProduct] = await Promise.all(["Editable stock", "Replacement stock"].map(async name =>
    (await ok(mert("product", { name, dolapListPrice: 5000, gardropsListPrice: 5000, lowThreshold: 0, firstPartnerShare: 50 }))).id));
  const editedPurchaseId = (await ok(mert("purchase", {
    name: "Stock to correct", date, total: 2200, payment: { date, payerId: mertId },
    lines: [{ productId: editableProduct, quantity: 2, unitCost: 800 }, { productId: bundleA, quantity: 2, unitCost: 300 }],
  }))).id;
  const originalPurchase = (await state()).purchases.find(purchase => purchase.id === editedPurchaseId);
  const [firstLot, wrongLot] = originalPurchase.lines;
  const correction = { id: editedPurchaseId, revision: originalPurchase.revision, date: "2026-09-16", name: "Corrected stock", total: 3400,
    lines: [{ lotId: firstLot.lotId, productId: editableProduct, quantity: 3, unitCost: 1000 },
      { lotId: wrongLot.lotId, productId: replacementProduct, quantity: 1, unitCost: 400 }] };
  assert.equal((await client()("purchase-edit", correction)).status, 401);
  await ok(ayse("purchase-edit", correction));
  assert.equal((await mert("purchase-edit", correction)).status, 409);
  const afterCorrection = await state();
  const editedPurchase = afterCorrection.purchases.find(purchase => purchase.id === editedPurchaseId);
  assert.deepEqual([editedPurchase.name, editedPurchase.date, editedPurchase.paymentDate, editedPurchase.payerId, editedPurchase.total],
    ["Corrected stock", "2026-09-16", date, mertId, 3400]);
  assert.deepEqual(afterCorrection.cash.filter(movement => movement.kind === "purchase" && movement.id === editedPurchaseId)
    .map(({ amount, description }) => [amount, description]), [[-3400, "Corrected stock"]]);
  assert.deepEqual(afterCorrection.stock.filter(item => item.kind === "adjustment" && item.reference === "Corrected stock")
    .map(({ productId, quantity }) => [productId, quantity]).sort((a, b) => a[0] - b[0]),
    [[bundleA, -2], [editableProduct, 1], [replacementProduct, 1]].sort((a, b) => a[0] - b[0]));
  assert.match(await ok(mert("export?kind=stock")), /Stok düzeltmesi/);

  const stockEditOrderId = (await ok(mert("order", {
    date, platform: "Dolap", reference: "STOCK-EDIT", platformFee: 0, shipping: 0, packing: 0,
    lines: [{ productId: editableProduct, quantity: 2, agreedPrice: 5000 }],
  }))).id;
  const revise = { ...correction, revision: editedPurchase.revision };
  const reviseFirst = (quantity, unitCost, total) => ({ ...revise, total,
    lines: [{ ...revise.lines[0], quantity, unitCost }, revise.lines[1]] });
  assert.equal((await ayse("purchase-edit", reviseFirst(1, 1000, 1400))).status, 409);
  assert.equal((await ayse("purchase-edit", reviseFirst(3, 900, 3100))).status, 409);
  assert.equal((await ayse("purchase-edit", { ...revise, total: 400, lines: [revise.lines[1]] })).status, 409);
  await ok(ayse("purchase-edit", reviseFirst(2, 1000, 2400)));
  const reduced = await state();
  assert.equal(reduced.products.find(product => product.id === editableProduct).stock, 0);
  const lockedLot = reduced.purchases.find(purchase => purchase.id === editedPurchaseId).lines[0];
  assert.deepEqual([lockedLot.usedQuantity, lockedLot.hasSalesHistory], [2, true]);
  assert.equal(reduced.orders.find(order => order.id === stockEditOrderId).cost, 2000);
  assert.equal(reduced.cash.find(movement => movement.kind === "purchase" && movement.id === editedPurchaseId).amount, -2400);

  const lotProduct = (await ok(mert("product", { name: "Mixed ownership", dolapListPrice: 3000, gardropsListPrice: 3000, lowThreshold: 0 }))).id;
  const lotPurchases = [];
  for (const [firstPartnerShare, unitCost, payerId] of [[100, 1000, mertId], [0, 2000, ayseId]]) {
    const id = (await ok(mert("purchase", { name: "Lot " + firstPartnerShare, date, total: unitCost * 2,
      payment: { date, payerId }, lines: [{ productId: lotProduct, quantity: 2, unitCost, firstPartnerShare }] }))).id;
    lotPurchases.push(id);
  }
  const mixedOrderId = (await ok(mert("order", { date, platform: "Dolap", reference: "MIXED-LOT", saleTotal: 9000, netAfterShipping: 8500, packing: 100,
    lines: [{ productId: lotProduct, quantity: 3 }] }))).id;
  const mixedState = await state();
  const mixedOrder = mixedState.orders.find(order => order.id === mixedOrderId);
  assert.deepEqual(mixedOrder.lines.map(line => [line.purchaseId, line.quantity, line.firstPartnerShare]),
    [[lotPurchases[0], 2, 100], [lotPurchases[1], 1, 0]]);
  await ok(ayse("receipt", { id: mixedOrderId, date, amount: 8500, recipientId: mertId }));
  const sharePurchase = (await state()).purchases.find(purchase => purchase.id === lotPurchases[0]);
  await ok(ayse("purchase-edit", { id: sharePurchase.id, revision: sharePurchase.revision, name: sharePurchase.name, date, total: sharePurchase.total,
    lines: sharePurchase.lines.map(line => ({ ...line, firstPartnerShare: 50 })) }));
  const editOrder = { id: mixedOrderId, revision: mixedOrder.revision, date: "2026-09-17", platform: "Dolap", reference: "MIXED-EDIT",
    saleTotal: 9000, netAfterShipping: 8200, packing: 200, lines: [{ productId: lotProduct, quantity: 3 }] };
  assert.equal((await client()("order-edit", editOrder)).status, 401);
  await ok(ayse("order-edit", editOrder));
  const editedState = await state();
  const editedMixed = editedState.orders.find(order => order.id === mixedOrderId);
  assert.deepEqual(editedMixed.lines.map(line => [line.purchaseId, line.quantity, line.firstPartnerShare]),
    [[lotPurchases[0], 2, 100], [lotPurchases[1], 1, 0]]);
  assert.deepEqual([editedMixed.gross, editedMixed.cost, editedMixed.profit, editedMixed.receiptAmount], [9000, 4000, 4000, 8500]);
  assert.equal(editedState.summary.cashBalance, mixedState.summary.cashBalance + 8500);
  assert.equal((await ayse("order-edit", editOrder)).status, 409);
  const excessiveEdit = { ...editOrder, revision: editedMixed.revision, lines: [{ productId: lotProduct, quantity: 99 }] };
  assert.equal((await ayse("order-edit", excessiveEdit)).status, 409);
  assert.deepEqual((await state()).orders.find(order => order.id === mixedOrderId), editedMixed);
  assert.equal((await state()).products.find(product => product.id === lotProduct).stock, 1);
  await ok(mert("order-edit", { ...editOrder, revision: editedMixed.revision, saleTotal: 3500, netAfterShipping: 3000, packing: 250,
    lines: [{ productId: lotProduct, quantity: 1 }] }));
  const reducedMixed = (await state()).orders.find(order => order.id === mixedOrderId);
  assert.deepEqual([reducedMixed.gross, reducedMixed.cost, reducedMixed.profit, reducedMixed.lines[0].firstPartnerShare], [3500, 1000, 1750, 100]);
  assert.equal((await state()).products.find(product => product.id === lotProduct).stock, 3);
  await ok(mert("order-status", { id: mixedOrderId, date, status: "cancelled" }));
  assert.equal((await state()).products.find(product => product.id === lotProduct).stock, 4);
  assert.equal((await mert("order-edit", { ...editOrder, revision: reducedMixed.revision })).status, 409);

  const priceOrderId = (await ok(mert("order", { date, platform: "Dolap", reference: "PRICE-PRESERVATION", platformFee: 0, shipping: 0, packing: 100,
    lines: [{ productId: lotProduct, quantity: 1, agreedPrice: 3500 }, { productId: replacementProduct, quantity: 1, agreedPrice: 2000 }] }))).id;
  const priceOrder = (await state()).orders.find(order => order.id === priceOrderId);
  await ok(mert("product", { id: lotProduct, name: "Mixed ownership", dolapListPrice: 9999, gardropsListPrice: 9999, lowThreshold: 0 }));
  await ok(mert("order-edit", { id: priceOrderId, revision: priceOrder.revision, date, platform: "Dolap", reference: "PRICE-PRESERVATION",
    saleTotal: 5500, platformFee: 0, shipping: 0, packing: 300,
    lines: [{ productId: lotProduct, quantity: 1 }, { productId: replacementProduct, quantity: 1 }] }));
  const pricesAfterEdit = (await state()).orders.find(order => order.id === priceOrderId);
  assert.deepEqual(pricesAfterEdit.lines.map(line => [line.productId, line.quantity, line.agreedPrice, line.listPrice]),
    priceOrder.lines.map(line => [line.productId, line.quantity, line.agreedPrice, line.listPrice]));
  assert.equal(pricesAfterEdit.packing, 300);

  const supplyProduct = (await ok(mert("product", { name: "Shared inventory", dolapListPrice: 900, gardropsListPrice: 900, lowThreshold: 0 }))).id;
  const sharedPurchaseId = (await ok(mert("purchase", { name: "Shared supplier payment", date, total: 1000,
    lines: [{ productId: supplyProduct, quantity: 5, unitCost: 200, firstPartnerShare: 50 }],
    payment: { date, payments: [{ payerId: mertId, amount: 400 }, { payerId: ayseId, amount: 600 }] },
  }))).id;
  let sharedState = await state();
  let sharedPurchase = sharedState.purchases.find(purchase => purchase.id === sharedPurchaseId);
  assert.equal(sharedPurchase.payerId, null);
  assert.deepEqual(sharedPurchase.payments.map(payment => payment.amount), [400, 600]);
  assert.deepEqual(sharedState.cash.filter(entry => entry.kind === "purchase" && entry.id === sharedPurchaseId).map(entry => entry.amount).sort(), [-400, -600]);
  await ok(ayse("purchase-edit", { ...sharedPurchase, total: 2000, lines: sharedPurchase.lines.map(line => ({ ...line, quantity: 10 })) }));
  sharedPurchase = (await state()).purchases.find(purchase => purchase.id === sharedPurchaseId);
  assert.deepEqual(sharedPurchase.payments.map(payment => payment.amount), [800, 1200]);
  assert.equal((await mert("cash-edit", { kind: "purchase", id: sharedPurchaseId, date, memberId: mertId })).status, 409);
  await ok(mert("purchase-payment-edit", { id: sharedPurchaseId, date,
    payments: [{ payerId: mertId, amount: 1000 }, { payerId: ayseId, amount: 1000 }] }));
  assert.equal((await mert("purchase-payment-edit", { id: sharedPurchaseId, date, payments: [{ payerId: mertId, amount: 100 }] })).status, 400);

  const beforeLoss = await state();
  const lossId = (await ok(mert("stock-loss", { productId: supplyProduct, quantity: 3, reason: "damaged", date, note: "Damaged in storage" }))).id;
  const afterLoss = await state();
  assert.equal(afterLoss.products.find(product => product.id === supplyProduct).stock, 7);
  assert.equal(afterLoss.summary.cashBalance, beforeLoss.summary.cashBalance);
  assert.equal(afterLoss.stockLosses.find(loss => loss.id === lossId).lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0), 600);
  assert.equal((await ayse("stock-loss", { productId: supplyProduct, quantity: 99, reason: "lost", date })).status, 409);
  assert.equal((await state()).stockLosses.length, afterLoss.stockLosses.length);
  await ok(ayse("stock-loss-delete", { id: lossId, date }));
  assert.equal((await state()).products.find(product => product.id === supplyProduct).stock, 10);
  assert.equal((await ayse("stock-loss-delete", { id: lossId, date })).status, 404);

  const box = (await ok(mert("packaging-material", { name: "Box", perOrder: 2, lowThreshold: 3 }))).id;
  await ok(ayse("packaging-move", { id: box, quantity: 3, direction: "in", date, note: "Purchased boxes" }));
  const packageOrder = async reference => (await ok(mert("order", { date, platform: "Dolap", reference, saleTotal: 900, netAfterShipping: 800, packing: 100,
    lines: [{ productId: supplyProduct, quantity: 1 }] }))).id;
  const packedId = await packageOrder("PACKAGING-1");
  await ok(mert("order-status", { id: packedId, date, status: "packed" }));
  assert.equal((await state()).packagingMaterials.find(material => material.id === box).quantity, 1);
  assert.equal((await mert("order-status", { id: packedId, date, status: "packed" })).status, 409);
  const nextPackageId = await packageOrder("PACKAGING-2");
  assert.equal((await mert("order-status", { id: nextPackageId, date, status: "packed" })).status, 409);
  assert.equal((await state()).orders.find(order => order.id === nextPackageId).status, "pending");
  await ok(mert("packaging-move", { id: box, quantity: 2, direction: "in", date }));
  await ok(mert("order-status", { id: nextPackageId, date, status: "packed" }));
  const packed = await state();
  assert.equal(packed.packagingMaterials.find(material => material.id === box).quantity, 1);
  assert.equal(packed.packagingMovements.filter(move => move.orderId !== null).length, 2);
  await ok(mert("order-status", { id: nextPackageId, date, status: "cancelled" }));
  assert.equal((await state()).packagingMaterials.find(material => material.id === box).quantity, 1);

  const roundedPurchaseId = (await ok(mert("purchase", { name: "Rounding payment", date, total: 100,
    lines: [{ productId: supplyProduct, quantity: 1, unitCost: 100, firstPartnerShare: 50 }],
    payment: { date, payments: [{ payerId: mertId, amount: 1 }, { payerId: ayseId, amount: 99 }] },
  }))).id;
  let roundedPurchase = (await state()).purchases.find(purchase => purchase.id === roundedPurchaseId);
  await ok(mert("purchase-edit", { ...roundedPurchase, total: 1, lines: roundedPurchase.lines.map(line => ({ ...line, unitCost: 1 })) }));
  roundedPurchase = (await state()).purchases.find(purchase => purchase.id === roundedPurchaseId);
  assert.deepEqual(roundedPurchase.payments.map(payment => [payment.payerId, payment.amount]), [[ayseId, 1]]);
  await ok(mert("purchase-edit", { ...roundedPurchase, total: 2, lines: roundedPurchase.lines.map(line => ({ ...line, unitCost: 2 })) }));
  assert.equal((await state()).purchases.find(purchase => purchase.id === roundedPurchaseId).payerId, ayseId);
  await ok(mert("cash-edit", { id: roundedPurchaseId, kind: "purchase", date, memberId: mertId }));
  assert.equal((await state()).purchases.find(purchase => purchase.id === roundedPurchaseId).payerId, mertId);

  const historyState = await state();
  assert.deepEqual(historyState.productHistory.filter(entry => entry.productId === productId && entry.kind === "price").map(entry => entry.dolapPrice).sort(), [60000, 65000]);
  assert.ok(historyState.productHistory.some(entry => entry.purchaseId === editedPurchaseId && entry.kind === "cost" && entry.unitCost === 800));
  assert.ok(historyState.productHistory.some(entry => entry.purchaseId === editedPurchaseId && entry.kind === "cost" && entry.unitCost === 1000));
  const deleteProduct = (await ok(mert("product", { name: "Delete stock", dolapListPrice: 1000, gardropsListPrice: 1000, lowThreshold: 0 }))).id;
  await ok(mert("purchase", { name: "Deletion test stock", date, total: 1000,
    lines: [{ productId: deleteProduct, quantity: 10, unitCost: 100, firstPartnerShare: 50 }] }));
  for (const material of (await state()).packagingMaterials) {
    await ok(mert("packaging-move", { id: material.id, date, direction: "in", quantity: 20 }));
  }
  for (const status of ["pending", "packed", "cancelled", "returned"]) {
    const beforeDeleteOrder = await state();
    const saleId = (await ok(mert("order", { date, platform: "Dolap", reference: "DELETE-" + status, saleTotal: 2000, netAfterShipping: 1800, packing: 100,
      lines: [{ productId: deleteProduct, quantity: 2 }] }))).id;
    await ok(mert("receipt", { id: saleId, date, amount: 1800, recipientId: mertId }));
    if (status !== "pending") await ok(mert("order-status", { id: saleId, date, status: "packed" }));
    if (status === "returned") await ok(mert("order-status", { id: saleId, date, status, returns: [{ productId: deleteProduct, quantity: 1 }] }));
    if (status === "cancelled") await ok(mert("order-status", { id: saleId, date, status }));
    const toDelete = (await state()).orders.find(order => order.id === saleId);
    assert.equal((await client()("order-delete", { id: saleId, revision: toDelete.revision })).status, 401);
    assert.equal((await mert("order-delete", { id: saleId, revision: toDelete.revision + 1 })).status, 409);
    await ok(ayse("order-delete", { id: saleId, revision: toDelete.revision }));
    const afterDeleteOrder = await state();
    assert.equal(afterDeleteOrder.orders.some(order => order.id === saleId), false);
    assert.equal(afterDeleteOrder.cash.some(entry => entry.kind === "receipt" && entry.id === saleId), false);
    assert.equal(afterDeleteOrder.products.find(product => product.id === deleteProduct).stock, 10);
    assert.equal(afterDeleteOrder.summary.cashBalance, beforeDeleteOrder.summary.cashBalance);
    assert.deepEqual(afterDeleteOrder.packagingMaterials.map(material => material.quantity), beforeDeleteOrder.packagingMaterials.map(material => material.quantity));
    assert.equal(afterDeleteOrder.packagingMovements.some(move => move.orderId === saleId), false);
    assert.equal((await ayse("order-delete", { id: saleId, revision: toDelete.revision })).status, 404);
  }

  await ok(mert("logout", {}));
  assert.equal((await ok(mert("session"))).user, null);
  assert.equal((await mert("state")).status, 401);
  assert.equal((await ok(ayse("session"))).user.id, ayseId);
});

