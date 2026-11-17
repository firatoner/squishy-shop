import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

export type Rpc = <T>(group: "auth" | "write" | "read" | "cash_write" | "partnership_write" | "settings_write" | "stock_write", data: Record<string, unknown>) => Promise<T>;
type Environment = { rpc: Rpc; setupToken?: string; secureCookies: boolean };
type Input = Record<string, unknown>;
type User = { id: number; name: string; username: string };

export class ShopError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SESSION_AGE = 60 * 60 * 24 * 7;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const derive = promisify(pbkdf2);
const cookieName = (env: Environment) => env.secureCookies ? "__Host-squishy_session" : "squishy_session";
const passwordHash = async (password: string, salt: string) =>
  (await derive(password, Buffer.from(salt, "hex"), 600_000, 32, "sha256")).toString("hex");

function fail(message: string): never {
  throw new ShopError(400, message);
}

function object(value: unknown): Input {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("Geçerli bir kayıt gönderin.");
  return value as Input;
}

function strings(value: unknown, label: string, maximum: number, required = true) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") fail(`${label} geçersiz.`);
  const result = value.trim();
  if ((required && !result) || result.length > maximum) fail(`${label} geçersiz veya çok uzun.`);
  return result;
}

function integer(value: unknown, label: string, min = 0, max = 100_000_000) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label} için geçerli bir sayı girin.`);
  }
  return value;
}

const id = (value: unknown) => integer(value, "Kayıt numarası", 1, 2_147_483_647);
const quantity = (value: unknown) => integer(value, "Adet", 1, 100_000);
const money = (value: unknown, name: string, min = 0) => integer(value, name, min, 100_000_000);

function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01") {
    fail("Geçerli bir tarih seçin.");
  }
  const stamp = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(stamp.getTime()) || stamp.toISOString().slice(0, 10) !== value) fail("Geçerli bir tarih seçin.");
  return value;
}

function list<T>(data: unknown, normalize: (line: Input) => T, min = 1): T[] {
  if (!Array.isArray(data) || data.length < min || data.length > 100) fail("Geçerli sayıda ürün satırı ekleyin.");
  return data.map((line) => normalize(object(line)));
}

function uniqueProducts<T extends { productId: number }>(lines: T[]) {
  if (new Set(lines.map((line) => line.productId)).size !== lines.length) fail("Her ürünü tek satırda ekleyin.");
  return lines;
}

function username(value: unknown) {
  const name = strings(value, "Kullanıcı adı", 40).normalize("NFKC").toLocaleLowerCase("tr-TR");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{2,39}$/u.test(name)) fail("Kullanıcı adı 3–40 harf, rakam, nokta, tire veya alt çizgi içermeli.");
  return name;
}

function password(value: unknown, setup: boolean) {
  if (typeof value !== "string" || !value.length || value.length > 128 || (setup && value.length < 12)) {
    fail(setup ? "Şifre en az 12, en fazla 128 karakter olmalı." : "Kullanıcı adı veya şifre hatalı.");
  }
  return value;
}

function parsePhoto(value: string) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return null;
  const image = Buffer.from(match[2], "base64");
  const png = image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const jpeg = image.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
  const webp = image.subarray(0, 4).toString() === "RIFF" && image.subarray(8, 12).toString() === "WEBP";
  if (!(match[1] === "image/png" && png || match[1] === "image/jpeg" && jpeg || match[1] === "image/webp" && webp)) return null;
  return { bytes: new Uint8Array(image), type: match[1] };
}

const partnerShare = (value: unknown) => integer(value, "Ortaklık payı", 0, 100);

function expenseFields(input: Input) {
  return {
    category: strings(input.category, "Gider kategorisi", 80),
    amount: money(input.amount, "Gider tutarı", 1),
    note: strings(input.note, "Not", 500, false),
    firstPartnerShare: input.firstPartnerShare == null ? input.firstPartnerShare : partnerShare(input.firstPartnerShare),
  };
}

function mutation(action: string, input: Input) {
  switch (action) {
    case "product": {
      const productId = input.id === undefined ? undefined : id(input.id);
      let photo = input.photo;
      if (typeof photo === "string" && productId && photo.startsWith(`/api/photo?id=${productId}&v=`)) photo = undefined;
      if (photo !== undefined && photo !== null &&
          (typeof photo !== "string" || photo.length > 600_000 || !parsePhoto(photo))) {
        fail("Fotoğraf 450 KB altında bir JPEG, PNG veya WebP olmalı.");
      }
      const prices = input.dolapListPrice === undefined && input.gardropsListPrice === undefined
        ? { listPrice: money(input.listPrice, "Liste fiyatı") }
        : {
            dolapListPrice: money(input.dolapListPrice, "Dolap liste fiyatı"),
            gardropsListPrice: money(input.gardropsListPrice, "Gardrops liste fiyatı"),
          };
      return { id: productId, name: strings(input.name, "Ürün adı", 120), photo, ...prices,
        firstPartnerShare: input.firstPartnerShare === undefined ? undefined : partnerShare(input.firstPartnerShare),
        lowThreshold: integer(input.lowThreshold, "Düşük stok eşiği", 0, 100_000) };
    }
    case "purchase":
    case "purchase-edit": {
      const lines = list(input.lines, line => ({
        productId: id(line.productId), quantity: quantity(line.quantity), unitCost: money(line.unitCost, "Birim maliyet"),
        lotId: action === "purchase-edit" && line.lotId !== undefined ? id(line.lotId) : undefined,
      }));
      const total = money(input.total, "Koli toplamı", 1);
      if (lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0) !== total) fail("Ürün maliyetleri koli toplamıyla eşleşmeli.");
      const purchase = { name: strings(input.name, "Koli adı", 120), date: date(input.date), total, lines };
      if (action === "purchase-edit") {
        const lotIds = lines.flatMap(line => line.lotId === undefined ? [] : [line.lotId]);
        if (new Set(lotIds).size !== lotIds.length) fail("Her alım satırını bir kez gönderin.");
        return { ...purchase, id: id(input.id), revision: integer(input.revision, "Kayıt sürümü", 0, 2_147_483_647) };
      }
      const payment = input.payment == null ? undefined : object(input.payment);
      return { ...purchase,
        payment: payment && { date: date(payment.date), payerId: id(payment.payerId) } };
    }
    case "purchase-payment":
      return { id: id(input.id), date: date(input.date), payerId: id(input.payerId) };
    case "order": {
      const platform = input.platform;
      if (platform !== "Dolap" && platform !== "Gardrops") fail("Dolap veya Gardrops seçin.");
      const saleTotal = input.saleTotal === undefined ? undefined : money(input.saleTotal, "Toplam satış tutarı");
      const lines = uniqueProducts(list(input.lines, line => ({
        productId: id(line.productId), quantity: quantity(line.quantity),
        agreedPrice: saleTotal === undefined ? money(line.agreedPrice, "Anlaşılan fiyat") : undefined,
      })));
      const gross = saleTotal ?? lines.reduce((sum, line) => sum + line.quantity * (line.agreedPrice ?? 0), 0);
      const netAfterShipping = input.netAfterShipping === undefined ? undefined
        : integer(input.netAfterShipping, "Kargo ve kesinti sonrası net tutar", -100_000_000, 100_000_000);
      if (netAfterShipping !== undefined && netAfterShipping > gross) fail("Net tutar satış toplamını aşamaz.");
      return { platform, date: date(input.date), reference: strings(input.reference, "Sipariş numarası", 120, false), lines, saleTotal, netAfterShipping,
        platformFee: netAfterShipping === undefined ? money(input.platformFee, "Platform kesintisi") : 0,
        shipping: netAfterShipping === undefined ? money(input.shipping, "Kargo") : 0,
        packing: money(input.packing, "Paketleme") };
    }
    case "order-status": {
      const status = input.status;
      if (status !== "packed" && status !== "cancelled" && status !== "returned") fail("Sipariş durumu geçersiz.");
      if (input.sellable !== undefined && typeof input.sellable !== "boolean") fail("İade stok seçimi geçersiz.");
      const returns = input.returns === undefined ? undefined :
        uniqueProducts(list(input.returns, (line) => ({ productId: id(line.productId), quantity: quantity(line.quantity) }), 0));
      return { id: id(input.id), status, date: date(input.date), sellable: input.sellable, returns };
    }
    case "receipt":
      return { id: id(input.id), date: date(input.date), amount: money(input.amount, "Gelen tutar", 1), recipientId: id(input.recipientId) };
    case "order-share":
      return { id: id(input.id), productId: id(input.productId), firstPartnerShare: partnerShare(input.firstPartnerShare) };
    case "partner-transfer": {
      const senderId = id(input.senderId);
      const recipientId = id(input.recipientId);
      if (senderId === recipientId) fail("Transfer için iki farklı ortak seçin.");
      return { senderId, recipientId, date: date(input.date), amount: money(input.amount, "Transfer tutarı", 1),
        note: strings(input.note, "Not", 500, false) };
    }
    case "partner-transfer-delete":
      return { id: id(input.id) };
    case "settings":
      return { defaultPacking: money(input.defaultPacking, "Varsayılan paketleme") };
    case "expense":
      return { ...expenseFields(input), date: date(input.date), payerId: id(input.payerId) };
    case "cash-edit":
    case "cash-delete": {
      const kind = input.kind;
      if (kind !== "purchase" && kind !== "receipt" && kind !== "expense") fail("Kasa işlemi türü geçersiz.");
      const entry = { id: id(input.id), kind };
      if (action === "cash-delete") return entry;
      const details = { ...entry, date: date(input.date), memberId: id(input.memberId) };
      if (kind === "expense") return { ...details, ...expenseFields(input) };
      if (kind === "receipt") return { ...details, amount: money(input.amount, "Gelen tutar", 1) };
      return details;
    }
    default:
      throw new ShopError(404, "İşlem bulunamadı.");
  }
}

function json(data: unknown, status = 200, cookie?: string) {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return Response.json(data, { status, headers });
}

function cookie(env: Environment, token: string, age: number) {
  return `${cookieName(env)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${env.secureCookies ? "; Secure" : ""}`;
}

function getTokenHash(request: Request, env: Environment) {
  const part = request.headers.get("cookie")?.split(";").map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${cookieName(env)}=`));
  const value = part?.slice(cookieName(env).length + 1) ?? "";
  return /^[\w-]{43}$/.test(value) ? hash(value) : "";
}

function rejectCrossOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new ShopError(403, "İstek kaynağı geçersiz.");
  if (origin !== null && origin !== new URL(request.url).origin) throw new ShopError(403, "İstek kaynağı geçersiz.");
}

async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") fail("Geçerli bir JSON istek gönderin.");
  if (Number(request.headers.get("content-length")) > 640_000) throw new ShopError(413, "Gönderilen veri çok büyük.");
  const text = await request.text();
  if (text.length > 640_000) throw new ShopError(413, "Gönderilen veri çok büyük.");
  try { return object(JSON.parse(text)); } catch { return fail("Gönderilen kayıt okunamadı."); }
}

const expiry = () => Math.floor(Date.now() / 1_000) + SESSION_AGE;

async function authenticate(action: string, input: Input, request: Request, env: Environment) {
  const rpc = <T>(p_action: string, p_data: Input) => env.rpc<T>("auth", { p_action, p_data });
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hash(token);
  let user: User;
  if (action === "setup") {
    if (!env.setupToken || env.setupToken.length < 24 || typeof input.token !== "string" ||
        !timingSafeEqual(Buffer.from(hash(input.token), "hex"), Buffer.from(hash(env.setupToken), "hex"))) {
      throw new ShopError(403, "Kurulum anahtarı geçersiz.");
    }
    if (!Array.isArray(input.users) || input.users.length !== 2) fail("İki ayrı hesap oluşturun.");
    const accounts = input.users.map((entry) => {
      const account = object(entry);
      return { name: strings(account.name, "Ad", 80), username: username(account.username), password: password(account.password, true) };
    });
    if (accounts[0].username === accounts[1].username) fail("İki farklı kullanıcı adı seçin.");
    const users = await Promise.all(accounts.map(async (account) => {
      const salt = randomBytes(16).toString("hex");
      return { name: account.name, username: account.username, salt, passwordHash: await passwordHash(account.password, salt) };
    }));
    user = await rpc<User>("setup", { users, tokenHash, expiresAt: expiry() });
  } else {
    const name = username(input.username);
    const secret = password(input.password, false);
    const window = Math.floor(Date.now() / (15 * 60 * 1_000));
    const address = request.headers.get("x-vercel-forwarded-for")?.split(",")[0].trim() || "local";
    const key = hash(`login:${name}:${address}`);
    const limit = await rpc<{ allowed: boolean }>("limit", { key, window, maximum: 10 });
    if (!limit.allowed) throw new ShopError(429, "Çok fazla giriş denemesi. 15 dakika sonra yeniden deneyin.");
    const account = await rpc<(User & { salt: string; passwordHash: string }) | null>("credentials", { username: name });
    const calculated = await passwordHash(secret, account?.salt ?? "0".repeat(32));
    if (!account || !timingSafeEqual(Buffer.from(calculated, "hex"), Buffer.from(account.passwordHash, "hex"))) {
      throw new ShopError(401, "Kullanıcı adı veya şifre hatalı.");
    }
    user = await rpc<User>("login", { id: account.id, tokenHash, expiresAt: expiry() });
    await rpc("clear-limit", { key });
  }
  return json({ ok: true, user }, 200, cookie(env, token, SESSION_AGE));
}

type ExportState = {
  users: User[];
  orders: Array<{ id: number; date: string; reference: string; platform: string; status: string; actorId: number;
    gross: number; discount: number; platformFee: number; shipping: number; packing: number; cost: number;
    netAfterShipping?: number | null;
    expectedReceipt: number; profit: number; receiptDate: string | null; receiptAmount: number | null; recipientId: number | null;
    lines: Array<{ productName: string; quantity: number; listPrice: number; agreedPrice: number; unitCost: number; cost: number }> }>;
  stock: Array<{ date: string; kind: string; productName: string; quantity: number; unitCost: number; reference: string; actorId: number }>;
  expenses: Array<{ date: string; category: string; amount: number; payerId: number; actorId: number; note: string }>;
};

type Cell = string | number | null;
const moneyCsv = (value: number | null) => value === null ? null : (value / 100).toFixed(2).replace(".", ",");
const dateCsv = (value: string | null) => value === null ? null : value.split("-").reverse().join(".");
const csvStatus: Record<string, string> = { pending: "Paketlenecek", packed: "Paketlendi", cancelled: "İptal", returned: "İade", sale: "Satış", purchase: "Alış", adjustment: "Stok düzeltmesi" };

function csvCell(value: Cell) {
  let cell = String(value ?? "");
  const normalized = cell.normalize("NFKC");
  if ((/^[\t\r\n]/.test(normalized) || /^[\s\u200B\uFEFF]*[=+\-@]/u.test(normalized)) && !/^-\d+(?:,\d{2})?$/.test(cell)) cell = "'" + cell;
  return '"' + cell.replaceAll('"', '""') + '"';
}

async function exportCsv(url: URL, env: Environment) {
  const kind = url.searchParams.get("kind");
  if (kind !== "sales" && kind !== "stock" && kind !== "expenses") fail("Geçerli bir rapor seçin.");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from !== null) date(from);
  if (to !== null) date(to);
  if (from && to && from > to) fail("Bitiş tarihi başlangıçtan önce olamaz.");
  const includes = (day: string) => (!from || day >= from) && (!to || day <= to);
  const state = await env.rpc<ExportState>("read", { p_action: "state", p_data: {} });
  const names = new Map(state.users.map((user) => [user.id, user.name]));
  const name = (value: number | null) => value === null ? "" : names.get(value) ?? "";
  let rows: Cell[][];
  if (kind === "sales") {
    rows = [
      ["Satış tarihi", "Platform", "Sipariş", "Durum", "Kaydeden", "Ürün", "Adet", "Birim liste fiyatı (TL)",
        "Birim satış fiyatı (TL)", "Satır maliyeti (TL)", "Sipariş brüt (TL)", "Sipariş indirim (TL)",
        "Kesinti (TL)", "Kargo (TL)", "Paketleme (TL)", "Toplam maliyet (TL)", "Beklenen ödeme (TL)", "Kâr (TL)",
        "Tahsilat tarihi", "Gelen ödeme (TL)", "Alan", "Kargo ve kesinti sonrası net (TL)"],
      ...state.orders.filter((order) => includes(order.date)).flatMap((order) =>
        order.lines.map((line, index) => [
          dateCsv(order.date), order.platform, order.reference || String(order.id), csvStatus[order.status], name(order.actorId),
          line.productName, line.quantity, moneyCsv(line.listPrice), moneyCsv(line.agreedPrice), moneyCsv(line.cost),
          ...(index === 0 ? [moneyCsv(order.gross), moneyCsv(order.discount),
            moneyCsv(order.netAfterShipping == null ? order.platformFee : null), moneyCsv(order.netAfterShipping == null ? order.shipping : null),
            moneyCsv(order.packing), moneyCsv(order.cost), moneyCsv(order.netAfterShipping == null ? order.expectedReceipt : null), moneyCsv(order.profit),
            dateCsv(order.receiptDate), moneyCsv(order.receiptAmount), name(order.recipientId), moneyCsv(order.netAfterShipping ?? null)] : Array<Cell>(12).fill(null)),
        ]),
      ),
    ];
  } else if (kind === "stock") {
    rows = [
      ["Tarih", "Hareket", "Ürün", "Adet", "Birim maliyet (TL)", "Referans", "Kaydeden"],
      ...state.stock.filter((event) => includes(event.date)).map((event) => [
        dateCsv(event.date), csvStatus[event.kind], event.productName, event.quantity, moneyCsv(event.unitCost), event.reference, name(event.actorId),
      ]),
    ];
  } else {
    rows = [
      ["Tarih", "Kategori", "Tutar (TL)", "Ödeyen", "Kaydeden", "Not"],
      ...state.expenses.filter((expense) => includes(expense.date)).map((expense) => [
        dateCsv(expense.date), expense.category, moneyCsv(expense.amount), name(expense.payerId), name(expense.actorId), expense.note,
      ]),
    ];
  }
  const filename = { sales: "satislar", stock: "stok-hareketleri", expenses: "giderler" }[kind];
  return new Response("\uFEFF" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}.csv"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function handleShopRequest(request: Request, action: string, env: Environment): Promise<Response> {
  try {
    const method = request.method;
    if (method === "POST") rejectCrossOrigin(request);
    if (method === "POST" && (action === "setup" || action === "login")) {
      return await authenticate(action, await body(request), request, env);
    }

    const tokenHash = getTokenHash(request, env);
    const auth = <T>(p_action: string, p_data: Input) => env.rpc<T>("auth", { p_action, p_data });
    if (method === "GET" && action === "session") {
      return json(await auth("session", { tokenHash }));
    }
    if (!tokenHash) throw new ShopError(401, "Oturum açmanız gerekiyor.");
    if (method === "POST" && action === "logout") {
      await auth("logout", { tokenHash });
      return json({ ok: true }, 200, cookie(env, "", 0));
    }

    const session = await auth<{ user: User | null }>("session", { tokenHash });
    if (!session.user) throw new ShopError(401, "Oturum açmanız gerekiyor.");

    const read = <T>(p_action: string, p_data: Input) => env.rpc<T>("read", { p_action, p_data });
    const url = new URL(request.url);
    if (method === "GET") {
      if (action === "state") return json(await read("state", {}));
      if (action === "export") return await exportCsv(url, env);
      if (action === "photo") {
        const productId = id(Number(url.searchParams.get("id")));
        const value = await read<string | null>("photo", { id: productId });
        const photo = value ? parsePhoto(value) : null;
        if (!photo) throw new ShopError(404, "Fotoğraf bulunamadı.");
        return new Response(photo.bytes, {
          headers: { "Content-Type": photo.type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
        });
      }
    }
    if (method === "POST") {
      const p_data = mutation(action, await body(request));
      const group = action === "cash-edit" || action === "cash-delete" ? "cash_write"
        : action === "order-share" || action === "partner-transfer" || action === "partner-transfer-delete" ? "partnership_write"
        : action === "settings" ? "settings_write"
        : action === "purchase-edit" ? "stock_write"
        : "write";
      return json(await env.rpc(group, { p_action: action, p_actor: session.user.id, p_data }));
    }
    throw new ShopError(404, "İşlem bulunamadı.");
  } catch (error) {
    if (error instanceof ShopError) return json({ error: error.message }, error.status);
    console.error("Squishy Shop request failed", error instanceof Error ? error.name : "UnknownError");
    return json({ error: "İşlem şu anda tamamlanamadı. Lütfen tekrar deneyin." }, 500);
  }
}



