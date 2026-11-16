import assert from "node:assert/strict";
import { test } from "node:test";
import { handleShopRequest, ShopError } from "../lib/shop-api.ts";

test("protects state, mutations, and CSV with individual app sessions", async () => {
  const members = new Map();
  const sessions = new Map();
  const writes = [];
  const env = {
    secureCookies: true,
    setupToken: "isolated-test-setup-key-never-use-in-production",
    async rpc(group, { p_action, p_data, p_actor }) {
      if (group === "write") {
        writes.push({ action: p_action, actorId: p_actor, ...p_data });
        return { ok: true, id: writes.length };
      }
      if (group === "read") {
        return {
          users: [...members.values()].map(({ id, username, name }) => ({ id, username, name })),
          orders: [], stock: [],
          expenses: [{ date: "2026-11-15", category: "Kutu", note: "＝2+2", amount: 150, payerId: 1, actorId: 2 }],
        };
      }
      switch (p_action) {
        case "session":
          return { needsSetup: members.size === 0, user: sessions.get(p_data.tokenHash) ?? null };
        case "setup": {
          if (members.size) throw new ShopError(409, "Recorded");
          p_data.users.forEach((user, index) => members.set(user.username, { id: index + 1, ...user }));
          const { id, username, name } = members.values().next().value;
          const signedIn = { id, username, name };
          sessions.set(p_data.tokenHash, signedIn);
          return signedIn;
        }
        case "limit": return { allowed: true };
        case "credentials": return members.get(p_data.username) ?? null;
        case "login": {
          const { id, username, name } = [...members.values()].find((member) => member.id === p_data.id);
          const signedIn = { id, username, name };
          sessions.set(p_data.tokenHash, signedIn);
          return signedIn;
        }
        case "clear-limit": return {};
        case "logout": sessions.delete(p_data.tokenHash); return {};
        default: throw new Error("Unexpected RPC " + p_action);
      }
    },
  };
  const call = (action, { body, cookie, origin = "https://shop.example" } = {}) => {
    const url = new URL("/api/" + action, "https://shop.example");
    const request = new Request(url, {
      method: body ? "POST" : "GET",
      headers: { ...(body && { "Content-Type": "application/json", Origin: origin }), ...(cookie && { Cookie: cookie }) },
      body: body && JSON.stringify(body),
    });
    return handleShopRequest(request, url.pathname.split("/").at(-1), env);
  };

  assert.deepEqual(await (await call("session")).json(), { needsSetup: true, user: null });
  assert.equal((await call("export?kind=expenses")).status, 401);
  assert.equal((await call("product", { body: {} })).status, 401);
  const users = [
    { name: "Bir", username: "bir", password: "pass-phrase-first" },
    { name: "İki", username: "iki", password: "pass-phrase-second" },
  ];
  assert.equal((await call("setup", { body: { token: "incorrect", users } })).status, 403);
  const setup = await call("setup", { body: { token: env.setupToken, users } });
  assert.equal(setup.status, 200);
  const firstCookie = setup.headers.get("set-cookie");
  assert.match(firstCookie, /^__Host-squishy_session=.*HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure$/);
  assert.notEqual([...members.values()][0].passwordHash, users[0].password);
  assert.equal((await call("login", { body: { ...users[1], password: "wrong" } })).status, 401);
  const login = await call("login", { body: users[1] });
  assert.equal(login.status, 200);
  const secondCookie = login.headers.get("set-cookie").split(";")[0];
  assert.notEqual(firstCookie.split(";")[0], secondCookie);
  const actualFirstCookie = firstCookie.split(";")[0];
  assert.equal((await call("expense", { cookie: secondCookie, origin: "https://outside.example", body: {} })).status, 403);
  const expense = { category: "Kutu", date: "2026-11-15", amount: 150, payerId: 1, actorId: 9 };
  assert.equal((await call("expense", { cookie: secondCookie, body: expense })).status, 200);
  assert.equal(writes[0].actorId, 2);
  const orderStatus = { id: 5, status: "returned", date: "2026-11-15", returns: [{ productId: 2, quantity: 1 }] };
  assert.equal((await call("order-status", { cookie: secondCookie, body: orderStatus })).status, 200);
  assert.deepEqual(writes[1].returns, orderStatus.returns);
  assert.equal((await call("purchase", { cookie: actualFirstCookie, body: { name: "Koli", date: "2026-11-15", total: 2,
    lines: [{ productId: 1, quantity: 1, unitCost: 1 }] } })).status, 400);

  const report = await call("export?kind=expenses&from=2026-11-01&to=2026-11-30", { cookie: secondCookie });
  assert.equal(report.status, 200);
  const csv = await report.text();
  assert.match(csv, /"15\.11\.2026";"Kutu";"1,50";"Bir";"İki";"'＝2\+2"/u);
  const empty = await call("export?kind=expenses&from=2026-12-01", { cookie: secondCookie });
  assert.doesNotMatch(await empty.text(), /Kutu/);
  assert.equal((await call("logout", { cookie: actualFirstCookie, body: {} })).status, 200);
  assert.equal((await call("state", { cookie: actualFirstCookie })).status, 401);
  assert.equal((await call("state", { cookie: secondCookie })).status, 200);
});
