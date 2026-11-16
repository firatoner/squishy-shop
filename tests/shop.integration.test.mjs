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
  const productId = (await ok(mert("product", { name: "Peach", listPrice: 60000, lowThreshold: 1 }))).id;
  const purchaseId = (await ok(mert("purchase", {
    name: "Wholesale September", date, total: 20000,
    lines: [{ productId, quantity: 1, unitCost: 20000 }],
  }))).id;
  const state = () => ok(mert("state"));
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

  await ok(mert("product", { id: productId, name: "Peach", listPrice: 65000, lowThreshold: 1 }));
  const order = (await state()).orders.find(({ id }) => id === firstOrderId);
  assert.equal(order.lines[0].listPrice, 60000);
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
  const damagedProduct = (await ok(mert("product", { name: "Berry", listPrice: 2000, lowThreshold: 0 }))).id;
  await ok(mert("purchase", {
    name: "Wholesale Berry", date, total: 1000, lines: [{ productId: damagedProduct, quantity: 1, unitCost: 1000 }],
  }));
  const damagedOrder = (await ok(mert("order", {
    platform: "Gardrops", date, reference: "G-001", platformFee: 0, shipping: 0, packing: 0,
    lines: [{ productId: damagedProduct, quantity: 1, agreedPrice: 2000 }],
  }))).id;
  await ok(mert("order-status", { id: damagedOrder, status: "packed", date }));
  await ok(ayse("order-status", { id: damagedOrder, status: "returned", date, returns: [] }));
  assert.equal((await state()).products.find(({ id }) => id === damagedProduct).stock, 0);

  assert.ok(!(await state()).cash.some(({ kind, id }) => kind === "purchase" && id === purchaseId));
  await ok(ayse("purchase-payment", { id: purchaseId, date, payerId: mertId }));
  assert.equal((await ayse("purchase-payment", { id: purchaseId, date, payerId: mertId })).status, 409);
  await ok(mert("expense", { category: "Supplies", date, amount: 260, payerId: ayseId, note: "Tape and mailers" }));
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

  await ok(mert("logout", {}));
  assert.equal((await ok(mert("session"))).user, null);
  assert.equal((await mert("state")).status, 401);
  assert.equal((await ok(ayse("session"))).user.id, ayseId);
});

