"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Activity, Archive, Boxes, CalendarDays, Check, Download, Heart, House, LogOut, Plus, Receipt, ShoppingBag, Sparkles, Wallet, X } from "lucide-react";

type Member = { id: number; username: string; name: string };
type Session = { user: Member | null; needsSetup: boolean };
type Platform = "Dolap" | "Gardrops";
type Product = { id: number; name: string; photo: string | null; dolapListPrice: number; gardropsListPrice: number; lowThreshold: number; stock: number };
type Purchase = {
  id: number; name: string; date: string; total: number; actorId: number;
  paymentDate: string | null; payerId: number | null;
  lines: { productId: number; productName: string; quantity: number; unitCost: number }[];
};
type OrderStatus = "pending" | "packed" | "cancelled" | "returned";
type Order = {
  id: number; platform: Platform; reference: string | null; date: string; status: OrderStatus;
  gross: number; discount: number; platformFee: number; shipping: number; packing: number; cost: number;
  expectedReceipt: number; profit: number; actorId: number; receiptDate: string | null; receiptAmount: number | null;
  recipientId: number | null; returnSellable?: boolean | null; returnLines?: { productId: number; quantity: number }[];
  lines: { productId: number; productName: string; quantity: number; listPrice: number; agreedPrice: number; unitCost: number; cost?: number }[];
};
type Expense = { id: number; category: string; amount: number; date: string; payerId: number; actorId: number; note: string | null };
type Stock = { id: number; productId: number; productName: string; date: string; kind: string; quantity: number; unitCost: number; actorId: number; reference: string };
type CashKind = "purchase" | "receipt" | "expense";
type CashEntry = { kind: CashKind; id: number; date: string; amount: number; description: string };
type Cash = CashEntry & { memberId: number; actorId: number };
type Audit = { id: number; action: string; entityId: number; actorId: number; createdAt: string; businessDate: string | null; status: OrderStatus | null };
type Shop = {
  users: Member[]; products: Product[]; purchases: Purchase[]; orders: Order[]; expenses: Expense[]; stock: Stock[]; cash: Cash[]; audit: Audit[];
  summary: { month: string; gross: number; collected: number; profit: number; cashBalance: number };
};
type PageName = "dashboard" | "products" | "orders" | "stock" | "cash" | "reports";
type Editor =
  | { type: "product"; product?: Product }
  | { type: "purchase" | "order" }
  | { type: "expense"; expense?: Expense }
  | { type: "cash-payment-edit"; payment: Cash }
  | { type: "cash-delete"; entry: CashEntry }
  | { type: "purchase-payment"; purchase: Purchase }
  | { type: "receipt" | "order-detail"; order: Order }
  | { type: "order-status"; order: Order; status: "packed" | "cancelled" | "returned" };

const sections = [
  { id: "dashboard", label: "Genel Bakış", Icon: House },
  { id: "products", label: "Ürünler", Icon: Heart },
  { id: "orders", label: "Satışlar", Icon: ShoppingBag },
  { id: "stock", label: "Stok", Icon: Boxes },
  { id: "cash", label: "Kasa ve Giderler", Icon: Wallet },
  { id: "reports", label: "Raporlar", Icon: Download },
] as const;
const statusLabel: Record<OrderStatus, string> = {
  pending: "Paketlenecek", packed: "Paketlendi", cancelled: "İptal edildi", returned: "İade edildi",
};
const stockLabel: Record<string, string> = {
  purchase: "Stok alımı", sale: "Satış", cancelled: "Satış iptali", returned: "Satılabilir iade",
};
const expenseCategories = ["Ambalaj", "Kargo", "Malzeme", "Pazarlama", "Diğer"];
const cashLabels: Record<CashKind, string> = { purchase: "Stok ödemesi", receipt: "Tahsilat", expense: "Gider" };
const turkishMoney = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" });
function money(value: number) { return turkishMoney.format(value / 100); }
function moneyInput(value: number) { return (value / 100).toFixed(2).replace(".", ","); }
function toMoney(value: string) {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return NaN;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
function requiredMoney(value: string) {
  const amount = toMoney(value);
  if (!Number.isSafeInteger(amount)) throw new Error("Tutarları 125,50 biçiminde yazın.");
  return amount;
}
function today() {
  const parts = new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)?.value).join("-");
}
function dateLabel(value: string, monthOnly = false) {
  const normalized = value.length === 7 ? value + "-01" : value;
  return new Intl.DateTimeFormat("tr-TR", monthOnly
    ? { month: "long", year: "numeric", timeZone: "UTC" }
    : { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }
  ).format(new Date(normalized + "T12:00:00Z"));
}
function field(data: FormData, name: string) { return String(data.get(name) ?? ""); }

async function api<T>(action: string, body?: unknown): Promise<T> {
  const result = await fetch("/api/" + action, body === undefined
    ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await result.json().catch(() => null);
  if (!result.ok) throw Object.assign(new Error(payload?.error || "İşlem tamamlanamadı. Yeniden deneyin."), { status: result.status });
  return payload as T;
}
function isUnauthorized(error: unknown) {
  return error instanceof Error && "status" in error && error.status === 401;
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Bir hata oluştu.";
}
function Brand() {
  return <div className="brand"><span className="brand-mark"><Heart aria-hidden="true" /></span><span>Squishy Shop</span></div>;
}
function HeroArtwork() {
  return <div className="hero-art" aria-hidden="true">
    <span className="art-orbit" />
    <Sparkles className="art-sparkles" strokeWidth={1.4} />
    <div className="squishy squishy-pink">
      <span className="squishy-eye left" /><span className="squishy-eye right" /><span className="squishy-smile" />
      <span className="squishy-cheek left" /><span className="squishy-cheek right" />
    </div>
    <div className="squishy squishy-cream">
      <span className="squishy-eye left" /><span className="squishy-eye right" /><span className="squishy-smile" />
      <span className="squishy-cheek left" /><span className="squishy-cheek right" />
    </div>
  </div>;
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="empty"><Sparkles className="icon" aria-hidden="true" />{children}</p>;
}
function Panel({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return <section className="panel"><div className="panel-head"><h2>{title}</h2>{meta}</div>{children}</section>;
}
function SectionHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <header className="section-header"><div><h1>{title}</h1><p>{description}</p></div>{children}</header>;
}
function AddButton({ children, onClick, primary = false }: { children: ReactNode; onClick: () => void; primary?: boolean }) {
  return <button className={primary ? "primary" : undefined} onClick={onClick}><Plus className="icon" aria-hidden="true" />{children}</button>;
}
function OrderActions({ order, open, compact = false }: { order: Order; open: (editor: Editor) => void; compact?: boolean }) {
  const active = order.status === "pending" || order.status === "packed";
  return <div className="actions">
    {order.status === "pending" && <button className="primary" onClick={() => open({ type: "order-status", order, status: "packed" })}>Paketlendi</button>}
    {!compact && active && order.receiptDate === null && <button onClick={() => open({ type: "receipt", order })}>Tahsilat gir</button>}
    {!compact && active && <button className="danger" onClick={() => open({ type: "order-status", order, status: "cancelled" })}>İptal et</button>}
    {!compact && order.status === "packed" && <button className="danger" onClick={() => open({ type: "order-status", order, status: "returned" })}>İade kaydet</button>}
    <button onClick={() => open({ type: "order-detail", order })}>Detay</button>
  </div>;
}
function OrderRow({ order, open, compact = false }: { order: Order; open: (editor: Editor) => void; compact?: boolean }) {
  const statusClass = order.status === "pending" ? "warning" : order.status === "packed" ? "ok" : "";
  return <article className="row">
    <div>
      <h3>{order.platform} · {order.reference || "#" + order.id}</h3>
      <p className="subtle">{dateLabel(order.date)} · {order.lines.map(line => line.quantity + " × " + line.productName).join(", ")}</p>
      {!compact && <p><span className={"pill " + statusClass}>{statusLabel[order.status]}</span> <span className="subtle">{money(order.gross)}</span></p>}
    </div>
    <OrderActions order={order} open={open} compact={compact}/>
  </article>;
}
function Dashboard({ data, open }: { data: Shop; open: (editor: Editor) => void }) {
  const pending = data.orders.filter(order => order.status === "pending");
  const lowStock = data.products.filter(product => product.stock <= product.lowThreshold);
  const receivables = data.orders.filter(order => order.receiptDate === null && (order.status === "pending" || order.status === "packed"));
  const bills = data.purchases.filter(purchase => !purchase.paymentDate);
  const month = dateLabel(data.summary.month, true);
  const metrics = [
    { label: "Brüt satış", value: data.summary.gross, Icon: ShoppingBag },
    { label: "Tahsil edilen", value: data.summary.collected, Icon: Wallet },
    { label: "Sipariş kârı", value: data.summary.profit, Icon: Activity },
  ];
  return <>
    <section className="hero">
      <HeroArtwork />
      <div className="hero-content">
        <h1>Mağaza özeti</h1>
        <p>Dolap ve Gardrops satışlarını, stoklarını ve giderlerini tek yerden takip et.</p>
        <div className="actions">
          <AddButton primary onClick={() => open({ type: "order" })}>Satış Ekle</AddButton>
          <AddButton onClick={() => open({ type: "purchase" })}>Stok Ekle</AddButton>
          <AddButton onClick={() => open({ type: "expense" })}>Gider Ekle</AddButton>
        </div>
      </div>
    </section>
    <div className="metrics">{metrics.map(({ label, value, Icon }) =>
      <article key={label} className="metric"><Icon className="icon" aria-hidden="true" /><h3>{label}</h3><strong className="metric-value">{money(value)}</strong><span className="subtle">{month}</span></article>,
    )}</div>
    <div className="dashboard-grid">
      <div className="stack">
        <Panel title="Paketlenecek siparişler" meta={<span className="pill">{pending.length} sipariş</span>}>
          {pending.length ? <div className="list">{pending.map(order => <OrderRow key={order.id} order={order} open={open} compact />)}</div> : <Empty>Paketleme bekleyen sipariş yok.</Empty>}
        </Panel>
        <Panel title="Düşük stok" meta={<span className="pill warning">{lowStock.length} ürün</span>}>
          {lowStock.length ? <div className="list">{lowStock.map(product => <div className="row" key={product.id}><strong>{product.name}</strong><span className="pill warning">{product.stock} adet</span></div>)}</div> : <Empty>Düşük stoklu ürün yok.</Empty>}
        </Panel>
      </div>
      <div className="stack">
        <Panel title="Bekleyen tahsilatlar" meta={<span className="pill">{receivables.length} sipariş</span>}>
          {receivables.length ? <div className="list">{receivables.map(order => <div className="row" key={order.id}><div><h3>{order.platform} · {order.reference || "#" + order.id}</h3><p className="subtle">Beklenen {money(order.expectedReceipt)}</p></div><div className="actions"><button onClick={() => open({ type: "receipt", order })}>Tahsilat gir</button></div></div>)}</div> : <Empty>Bekleyen tahsilat yok.</Empty>}
        </Panel>
        <Panel title="Ödenecek stok alımları" meta={<span className="pill">{bills.length} alım</span>}>
          {bills.length ? <div className="list">{bills.map(purchase => <div className="row" key={purchase.id}><div><h3>{purchase.name}</h3><p className="subtle">{money(purchase.total)}</p></div><div className="actions"><button onClick={() => open({ type: "purchase-payment", purchase })}>Ödeme gir</button></div></div>)}</div> : <Empty>Ödeme bekleyen stok alımı yok.</Empty>}
        </Panel>
      </div>
    </div>
  </>;
}
function Products({ products, open }: { products: Product[]; open: (editor: Editor) => void }) {
  const [query, setQuery] = useState("");
  const shown = products.filter(product => product.name.toLocaleLowerCase("tr-TR").includes(query.toLocaleLowerCase("tr-TR").trim()));
  return <>
    <SectionHeader title="Ürünler" description="Squishy kataloğunu, liste fiyatlarını ve stok eşiklerini yönet."><AddButton primary onClick={() => open({ type: "product" })}>Ürün Ekle</AddButton></SectionHeader>
    {!!products.length && <div className="form filter"><label>Ürün ara<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label></div>}
    {shown.length ? <div className="product-grid">{shown.map(product => <article className="product-card" key={product.id}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {product.photo ? <img className="product-image" src={product.photo} alt={product.name} loading="lazy" /> : <div className="product-placeholder"><Heart aria-hidden="true" /></div>}
      <div className="product-body">
        <div className="inline"><h3>{product.name}</h3><span className={"pill " + (product.stock <= product.lowThreshold ? "warning" : "ok")}>{product.stock} adet</span></div>
        <div className="inline"><span>Dolap</span><strong>{money(product.dolapListPrice)}</strong></div>
        <div className="inline"><span>Gardrops</span><strong>{money(product.gardropsListPrice)}</strong></div>
        <p className="subtle">Düşük stok eşiği {product.lowThreshold}</p>
        <button onClick={() => open({ type: "product", product })}>Düzenle</button>
      </div>
    </article>)}</div> : <Empty>{products.length ? "Aramana uygun ürün bulunamadı." : "Henüz ürün kaydı yok. İlk ürünü ekleyerek başlayabilirsin."}</Empty>}
  </>;
}
function Orders({ orders, open }: { orders: Order[]; open: (editor: Editor) => void }) {
  const [status, setStatus] = useState("all");
  const [platform, setPlatform] = useState("all");
  const shown = orders.filter(order => (status === "all" || order.status === status) && (platform === "all" || order.platform === platform));
  return <>
    <SectionHeader title="Satışlar" description="Siparişleri kaydet, paketleme ve tahsilat durumlarını takip et."><AddButton primary onClick={() => open({ type: "order" })}>Satış Ekle</AddButton></SectionHeader>
    <div className="form form-row filters">
      <label>Platform<select value={platform} onChange={event => setPlatform(event.target.value)}><option value="all">Tüm platformlar</option><option>Dolap</option><option>Gardrops</option></select></label>
      <label>Durum<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">Tüm durumlar</option>{Object.entries(statusLabel).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
    </div>
    <Panel title="Siparişler" meta={<span className="pill">{shown.length} sipariş</span>}>{shown.length ? <div className="list">{shown.map(order => <OrderRow key={order.id} order={order} open={open} />)}</div> : <Empty>{orders.length ? "Bu filtreye uyan sipariş yok." : "Henüz satış kaydı yok."}</Empty>}</Panel>
  </>;
}
function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return <div className="table-wrap"><table><thead><tr>{headers.map(header => <th key={header} scope="col">{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
function getMember(users: Member[], id: number | null) {
  return users.find(member => member.id === id)?.name ?? "—";
}
function StockPage({ data, open }: { data: Shop; open: (editor: Editor) => void }) {
  const [productId, setProductId] = useState("");
  const shown = data.stock.filter(move => !productId || move.productId === Number(productId));
  return <>
    <SectionHeader title="Stok" description="Toptan kutuları, alım ödemelerini ve ürün hareketlerini takip et."><AddButton primary onClick={() => open({ type: "purchase" })}>Stok Ekle</AddButton></SectionHeader>
    <div className="stack">
      <Panel title="Toptan alımlar">{data.purchases.length ? <div className="list">{data.purchases.map(purchase =>
        <details className="purchase-details" key={purchase.id}>
          <summary><span><strong>{purchase.name}</strong><br /><span className="subtle">{dateLabel(purchase.date)} · {money(purchase.total)}</span></span><span className={"pill " + (purchase.paymentDate ? "ok" : "warning")}>{purchase.paymentDate ? "Ödendi" : "Ödeme bekliyor"}</span></summary>
          <Table headers={["Ürün", "Adet", "Birim maliyet", "Toplam"]} rows={purchase.lines.map(line => [line.productName, line.quantity, money(line.unitCost), money(line.quantity * line.unitCost)])} />
          <div className="row"><p className="subtle">Ekleyen {getMember(data.users, purchase.actorId)}{purchase.paymentDate && " · Ödeyen " + getMember(data.users, purchase.payerId) + " · " + dateLabel(purchase.paymentDate)}</p>
          {!purchase.paymentDate && <div className="actions"><button onClick={() => open({ type: "purchase-payment", purchase })}>Ödeme gir</button></div>}</div>
        </details>,
      )}</div> : <Empty>Henüz toptan alım kaydı yok.</Empty>}</Panel>
      <Panel title="Stok hareketleri" meta={<div className="form"><label>Ürün<select value={productId} onChange={event => setProductId(event.target.value)}><option value="">Tüm ürünler</option>{data.products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label></div>}>
        {shown.length ? <Table headers={["Tarih", "Ürün", "Hareket", "Adet", "Birim maliyet", "İşlemi yapan", "Referans"]} rows={shown.map(move => [dateLabel(move.date), move.productName, stockLabel[move.kind] ?? move.kind, (move.quantity > 0 ? "+" : "") + move.quantity, money(move.unitCost), getMember(data.users, move.actorId), move.reference])} /> : <Empty>Bu seçimde stok hareketi yok.</Empty>}
      </Panel>
    </div>
  </>;
}
function CashPage({ data, open }: { data: Shop; open: (editor: Editor) => void }) {
  const expenses = new Map(data.expenses.map(expense => [expense.id, expense]));
  const actions = (entry: CashEntry, edit: Editor) => <div className="actions">
    <button onClick={() => open(edit)}>Düzenle</button>
    <button className="danger" onClick={() => open({ type: "cash-delete", entry })}>Sil</button>
  </div>;
  const expenseActions = (expense: Expense) => actions(
    { kind: "expense", id: expense.id, date: expense.date, amount: expense.amount, description: expense.category },
    { type: "expense", expense },
  );
  return <>
    <SectionHeader title="Kasa ve giderler" description="Gerçekleşen para girişlerini, çıkışlarını ve ödemeyi yapan kişiyi izle."><AddButton primary onClick={() => open({ type: "expense" })}>Gider Ekle</AddButton></SectionHeader>
    <div className="stack">
      <Panel title="Toplam kasa bakiyesi" meta={<strong className="cash-value">{money(data.summary.cashBalance)}</strong>}>
        {data.cash.length ? <Table headers={["Tarih", "İşlem", "Açıklama", "Hesap", "Tutar", "Ekleyen", "İşlemler"]} rows={data.cash.map(item => {
          const expense = expenses.get(item.id);
          const rowActions = item.kind === "expense"
            ? expense && expenseActions(expense)
            : actions(item, { type: "cash-payment-edit", payment: item });
          return [dateLabel(item.date), cashLabels[item.kind], item.description || "—", getMember(data.users, item.memberId),
            money(item.amount), item.memberId !== item.actorId ? getMember(data.users, item.actorId) : "—", rowActions];
        })} /> : <Empty>Henüz kasa hareketi yok.</Empty>}
      </Panel>
      <Panel title="Giderler">{data.expenses.length ? <Table headers={["Tarih", "Kategori", "Not", "Ödeyen", "Tutar", "Ekleyen", "İşlemler"]} rows={data.expenses.map(item => [
        dateLabel(item.date), item.category, item.note || "—", getMember(data.users, item.payerId), money(item.amount),
        item.payerId !== item.actorId ? getMember(data.users, item.actorId) : "—", expenseActions(item),
      ])} /> : <Empty>Henüz gider kaydı yok.</Empty>}</Panel>
    </div>
  </>;
}
function Reports({ month }: { month: string }) {
  const [from, setFrom] = useState(month + "-01");
  const [to, setTo] = useState(today);
  const kinds = [
    { id: "sales", label: "Satışlar", Icon: ShoppingBag },
    { id: "stock", label: "Stok hareketleri", Icon: Archive },
    { id: "expenses", label: "Giderler", Icon: Receipt },
  ];
  return <>
    <SectionHeader title="Raporlar" description="İstediğin tarih aralığındaki kayıtları CSV olarak indir." />
    <Panel title="Tarih aralığı">
      <div className="form form-row filters"><label>Başlangıç<input type="date" min="2000-01-01" max={to} value={from} onChange={event => setFrom(event.target.value)} /></label><label>Bitiş<input type="date" min={from} value={to} onChange={event => setTo(event.target.value)} /></label></div>
      <div className="actions">{kinds.map(({ id, label, Icon }) => from && to && from <= to
        ? <a key={id} className="button" href={"/api/export?" + new URLSearchParams({ kind: id, from, to })}><Icon className="icon" aria-hidden="true" />{label} CSV</a>
        : <button key={id} disabled>{label} CSV</button>,
      )}</div>
    </Panel>
  </>;
}

function DateField({ label = "Tarih", name = "date", value = today() }: { label?: string; name?: string; value?: string }) {
  return <label>{label}<input name={name} type="date" min="2000-01-01" defaultValue={value} required /></label>;
}
function AmountField({ label, name, value }: { label: string; name: string; value?: string }) {
  return <label>{label}<input name={name} inputMode="decimal" defaultValue={value} placeholder="0,00" maxLength={13} required /></label>;
}
function MemberField({ label, users, defaultId, name = "payerId" }: { label: string; users: Member[]; defaultId: number; name?: string }) {
  return <label>{label}<select name={name} defaultValue={defaultId} required>{users.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}</select></label>;
}
function SaveButton({ busy, children = "Kaydet" }: { busy: boolean; children?: ReactNode }) {
  return <div className="actions"><button className="primary" disabled={busy} type="submit">{busy ? "Kaydediliyor…" : children}</button></div>;
}
function authForm(data: FormData, setup: boolean) {
  if (!setup) return { username: field(data, "username"), password: field(data, "password") };
  return {
    token: field(data, "token"),
    users: [1, 2].map(index => ({
      name: field(data, "name" + index), username: field(data, "username" + index), password: field(data, "password" + index),
    })),
  };
}
function Authentication({ setup, onAuthenticated }: { setup: boolean; onAuthenticated: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api(setup ? "setup" : "login", authForm(new FormData(event.currentTarget), setup));
      await onAuthenticated();
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <main className="auth"><section className="auth-card panel"><Brand />
    <h1>{setup ? "Mağazanı kur" : "Hoş geldin"}</h1>
    <p className="muted">{setup ? "Kurulum anahtarını gir ve iki mağaza hesabını oluştur." : "Mağaza panelini açmak için hesabına giriş yap."}</p>
    <form className="form" onSubmit={submit}>
      {setup ? <>
        <label>Kurulum anahtarı<input name="token" type="password" autoComplete="off" required /></label>
        {[1, 2].map(index => <fieldset className="line-editor" key={index}>
          <legend>{index}. hesap</legend>
          <label>Görünen ad<input name={"name" + index} maxLength={70} required /></label>
          <div className="form-row">
            <label>Kullanıcı adı<input name={"username" + index} autoComplete="off" autoCapitalize="none" required /></label>
            <label>Parola<input name={"password" + index} type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          </div>
        </fieldset>)}
      </> : <>
        <label>Kullanıcı adı<input name="username" autoComplete="username" autoCapitalize="none" required /></label>
        <label>Parola<input name="password" type="password" autoComplete="current-password" required /></label>
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <SaveButton busy={busy}>{setup ? "Hesapları oluştur" : "Giriş yap"}</SaveButton>
    </form>
  </section></main>;
}
async function encodePhoto(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("JPEG, PNG veya WebP biçiminde bir fotoğraf seç.");
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 880 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Fotoğraf hazırlanamadı.");
    context.fillStyle = "#fffaf6";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally { image.close(); }
}
function ProductForm({ product, busy, save }: { product?: Product; busy: boolean; save: Save }) {
  const [photo, setPhoto] = useState<string | null | undefined>(undefined);
  const [photoError, setPhotoError] = useState("");
  const [loading, setLoading] = useState(false);
  return <form className="form" onSubmit={event => save(event, "product", data => ({
    id: product?.id, name: field(data, "name"), photo, lowThreshold: Number(field(data, "lowThreshold")),
    dolapListPrice: requiredMoney(field(data, "dolapListPrice")),
    gardropsListPrice: requiredMoney(field(data, "gardropsListPrice")),
  }))}>
    <label>Ürün adı<input name="name" defaultValue={product?.name} maxLength={120} required /></label>
    <div className="form-row">
      <AmountField label="Dolap liste fiyatı (₺)" name="dolapListPrice" value={product ? moneyInput(product.dolapListPrice) : undefined} />
      <AmountField label="Gardrops liste fiyatı (₺)" name="gardropsListPrice" value={product ? moneyInput(product.gardropsListPrice) : undefined} />
    </div>
    <label>Düşük stok eşiği<input name="lowThreshold" type="number" inputMode="numeric" min={0} step={1} defaultValue={product?.lowThreshold ?? 2} required /></label>
    <label>Ürün fotoğrafı<input type="file" accept="image/jpeg,image/png,image/webp" onChange={async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      setLoading(true);
      setPhotoError("");
      try { setPhoto(await encodePhoto(file)); }
      catch (error) { setPhotoError(errorMessage(error)); }
      finally { setLoading(false); }
    }} /></label>
    {photoError && <p className="form-error" role="alert">{photoError}</p>}
    {(photo === undefined ? product?.photo : photo) && <div className="actions">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={(photo === undefined ? product?.photo : photo) || ""} className="thumbnail" alt="Ürün fotoğrafı önizlemesi" />
      <button type="button" onClick={() => setPhoto(null)}>Fotoğrafı kaldır</button>
    </div>}
    <SaveButton busy={busy || loading} />
  </form>;
}
type Save = (event: FormEvent<HTMLFormElement>, action: string, build: (data: FormData) => unknown) => void;
type DraftLine = { id: number; productId: string; quantity: string; priceOverride: string | null };
function LinesForm({ mode, shop, user, busy, save, addProduct }: { mode: "purchase" | "order"; shop: Shop; user: Member; busy: boolean; save: Save; addProduct: () => void }) {
  const purchase = mode === "purchase";
  const products = shop.products.filter(product => purchase || product.stock > 0);
  const [lines, setLines] = useState<DraftLine[]>([{ id: 1, productId: "", quantity: "1", priceOverride: null }]);
  const nextLineId = useRef(2);
  const [platform, setPlatform] = useState<Platform>("Dolap");
  const [total, setTotal] = useState("");
  const [fee, setFee] = useState("0");
  const [shipping, setShipping] = useState("0");
  const [packing, setPacking] = useState("0");
  const [paid, setPaid] = useState(false);
  function updateLine(id: number, change: Partial<DraftLine>) {
    setLines(active => active.map(line => line.id === id ? { ...line, ...change } : line));
  }
  const rows = lines.map(line => {
    const product = products.find(product => product.id === Number(line.productId));
    const listPrice = platform === "Dolap" ? product?.dolapListPrice : product?.gardropsListPrice;
    const price = line.priceOverride ?? (!purchase && listPrice !== undefined ? moneyInput(listPrice) : "");
    return { line, product, listPrice, price };
  });
  const sum = rows.reduce((amount, { line, price }) => amount + Number(line.quantity) * (toMoney(price) || 0), 0);
  const listTotal = rows.reduce((amount, { line, listPrice }) => amount + Number(line.quantity) * (listPrice ?? 0), 0);
  const discount = rows.reduce((amount, { line, listPrice, price }) =>
    amount + Number(line.quantity) * Math.max(0, (listPrice ?? 0) - (toMoney(price) || 0)), 0);
  const receipt = sum - (toMoney(fee) || 0);
  const totalDifference = toMoney(total) - sum;
  if (!products.length) return <div className="stack">
    <Empty>{purchase ? "Stok alımı kaydetmek için önce bir ürün ekle." : "Satış eklemek için stokta en az bir ürün olmalı."}</Empty>
    {purchase && <div className="actions"><AddButton primary onClick={addProduct}>Ürün Ekle</AddButton></div>}
  </div>;
  return <form className="form" onSubmit={event => save(event, mode, data => {
    const date = field(data, "date");
    const baseLines = rows.map(({ line, price }) => ({ productId: Number(line.productId), quantity: Number(line.quantity), price: requiredMoney(price) }));
    if (purchase) {
      const amount = requiredMoney(total);
      if (amount !== sum) throw new Error("Kutu toplamı, ürün satırlarının toplamıyla eşleşmeli.");
      return {
        name: field(data, "name"), date, total: amount,
        lines: baseLines.map(({ price, ...line }) => ({ ...line, unitCost: price })),
        payment: paid ? { date: field(data, "paymentDate"), payerId: Number(field(data, "payerId")) } : undefined,
      };
    }
    return {
      platform, date, reference: field(data, "reference").trim() || undefined,
      lines: baseLines.map(({ price, ...line }) => ({ ...line, agreedPrice: price })),
      platformFee: requiredMoney(fee), shipping: requiredMoney(shipping), packing: requiredMoney(packing),
    };
  })}>
    <div className="form-row">
      {purchase ? <label>Kutu adı<input name="name" maxLength={120} required /></label> : <label>Platform<select name="platform" value={platform} onChange={event => setPlatform(event.target.value as Platform)}><option>Dolap</option><option>Gardrops</option></select></label>}
      <DateField label={purchase ? "Alım tarihi" : "Satış tarihi"} />
    </div>
    {!purchase && <label>Sipariş numarası veya referans (isteğe bağlı)<input name="reference" maxLength={100} /></label>}
    {rows.map(({ line, product, listPrice, price }, index) => (
      <fieldset className="line-editor" key={line.id}>
        <legend>Ürün {index + 1}</legend>
        <label>Ürün seç<select value={line.productId} onChange={event => updateLine(line.id, { productId: event.target.value, quantity: "1", priceOverride: null })} required>
          <option value="">Ürün seç</option>
          {products.filter(product => line.productId === String(product.id) || !lines.some(other => other.id !== line.id && other.productId === String(product.id))).map(product => <option key={product.id} value={product.id}>{product.name}{purchase ? "" : " · " + product.stock + " adet"}</option>)}
        </select></label>
        <div className="form-row">
          <label>Adet<input type="number" min={1} max={purchase ? undefined : product?.stock} inputMode="numeric" step={1} value={line.quantity} onChange={event => updateLine(line.id, { quantity: event.target.value })} required /></label>
          <label>{purchase ? "Birim maliyet (₺)" : "Anlaşılan birim fiyat (₺)"}<input inputMode="decimal" value={price} onChange={event => updateLine(line.id, { priceOverride: event.target.value })} maxLength={13} placeholder="0,00" required /></label>
        </div>
        {!purchase && listPrice !== undefined && <p className="subtle">{platform} liste fiyatı {money(listPrice)}</p>}
        {lines.length > 1 && <div className="actions"><button className="danger" type="button" onClick={() => setLines(active => active.filter(other => other.id !== line.id))}>Satırı kaldır</button></div>}
      </fieldset>
    ))}
    {lines.length < products.length && <div className="actions"><button type="button" onClick={() => {
      const id = nextLineId.current++;
      setLines(active => [...active, { id, productId: "", quantity: "1", priceOverride: null }]);
    }}><Plus className="icon" aria-hidden="true" />Bir ürün daha ekle</button></div>}
    {purchase ? <>
      <label>Faturadaki kutu toplamı (₺)<input inputMode="decimal" value={total} onChange={event => setTotal(event.target.value)} maxLength={13} placeholder="0,00" required /></label>
      <div className="form-totals" aria-live="polite"><div className="inline"><span>Satır toplamı</span><strong>{money(sum)}</strong></div>
        {Number.isFinite(totalDifference) && <div className="inline"><span>{totalDifference ? "Fark" : "Kutu toplamı eşleşiyor"}</span>{totalDifference ? <strong className="danger">{money(totalDifference)}</strong> : <Check className="icon" aria-hidden="true" />}</div>}
      </div>
      <label className="check"><input type="checkbox" checked={paid} onChange={event => setPaid(event.target.checked)} />Ödeme yapıldı</label>
      {paid && <div className="form-row"><DateField label="Ödeme tarihi" name="paymentDate" /><MemberField label="Ödeyen" users={shop.users} defaultId={user.id} /></div>}
    </> : <>
      <div className="form-row">
        <label>Platform kesintisi (₺)<input inputMode="decimal" maxLength={13} value={fee} onChange={event => setFee(event.target.value)} required /></label>
        <label>Ödediğimiz kargo (₺)<input inputMode="decimal" maxLength={13} value={shipping} onChange={event => setShipping(event.target.value)} required /></label>
      </div>
      <p className="subtle">Ödediğimiz kargo ve paketleme maliyeti sipariş kârından düşülür.</p>
      <label>Paketleme maliyeti (₺)<input inputMode="decimal" maxLength={13} value={packing} onChange={event => setPacking(event.target.value)} required /></label>
      <div className="form-totals" aria-live="polite">
        <div className="inline"><span>Liste toplamı</span><strong>{money(listTotal)}</strong></div>
        <div className="inline"><span>Brüt satış</span><strong>{money(sum)}</strong></div>
        <div className="inline"><span>İndirim</span><strong>{money(discount)}</strong></div>
        <div className="inline"><span>Beklenen tahsilat</span><strong>{money(receipt)}</strong></div>
      </div>
    </>}
    <SaveButton busy={busy}>{purchase ? "Stok alımını kaydet" : "Satışı kaydet"}</SaveButton>
  </form>;
}
function orderProducts(order: Order) {
  const grouped = new Map<number, { productId: number; name: string; quantity: number }>();
  for (const line of order.lines) {
    const current = grouped.get(line.productId);
    grouped.set(line.productId, { productId: line.productId, name: line.productName, quantity: (current?.quantity ?? 0) + line.quantity });
  }
  return [...grouped.values()];
}

function OrderDetail({ order, users, audit, open }: { order: Order; users: Member[]; audit: Audit[]; open: (editor: Editor) => void }) {
  const actions: Record<string, string> = {
    order: "Satış kaydedildi", "order-status": "Durum güncellendi", receipt: "Tahsilat kaydedildi",
    "receipt-edit": "Tahsilat düzenlendi", "receipt-delete": "Tahsilat silindi",
  };
  const history = audit.filter(item => item.entityId === order.id && Object.hasOwn(actions, item.action));
  return <div className="stack">
    <div className="inline"><p>{order.platform} · {order.reference || "#" + order.id} · {dateLabel(order.date)}</p><span className="pill">{statusLabel[order.status]}</span></div>
    <Table headers={["Ürün", "Adet", "Liste fiyatı", "Satış fiyatı", "Stok maliyeti"]} rows={order.lines.map(line => [line.productName, line.quantity, money(line.listPrice), money(line.agreedPrice), money(line.cost ?? line.unitCost * line.quantity)])} />
    <div className="form-totals">
      {[["Brüt satış", order.gross], ["İndirim", order.discount], ["Platform kesintisi", order.platformFee], ["Ödediğimiz kargo", order.shipping], ["Paketleme", order.packing], ["Toplam stok maliyeti", order.cost], ["Beklenen tahsilat", order.expectedReceipt], ["Sipariş kârı", order.profit]].map(([label, value]) => <div className="inline" key={label}><span>{label}</span><strong>{money(Number(value))}</strong></div>)}
    </div>
    <p className="subtle">Ekleyen {getMember(users, order.actorId)}</p>
    {!!history.length && <div>
      <h3>İşlem geçmişi</h3>
      <Table headers={["Tarih", "İşlem", "Durum", "İşlemi yapan"]} rows={history.map(item => [
        dateLabel(item.businessDate ?? item.createdAt.slice(0, 10)), actions[item.action],
        item.status ? statusLabel[item.status] : item.action === "order" ? statusLabel.pending : "—", getMember(users, item.actorId),
      ])} />
    </div>}
    {order.receiptDate && <p>Tahsilat {money(order.receiptAmount ?? 0)} · {getMember(users, order.recipientId)} · {dateLabel(order.receiptDate)}</p>}
    {order.status === "returned" && <p>{order.returnLines?.length
      ? "Stoğa eklenenler · " + order.returnLines.map(line => line.quantity + " × " + (order.lines.find(original => original.productId === line.productId)?.productName ?? "#" + line.productId)).join(", ")
      : order.returnSellable ? "Satılabilir olarak kaydedilen adetler stoğa geri eklendi." : "İade stoğa eklenmedi."}</p>}
    {(order.status === "pending" || order.status === "packed") && <>
      <p className="listing-note"><Sparkles className="icon" aria-hidden="true" /> {order.platform === "Dolap" ? "Gardrops" : "Dolap"} ilanındaki ürün adedini kontrol et.</p>
      <OrderActions order={order} open={open} />
    </>}
  </div>;
}
function getTitle(editor: Editor) {
  switch (editor.type) {
    case "product": return editor.product ? "Ürünü düzenle" : "Ürün ekle";
    case "purchase": return "Stok alımı ekle";
    case "order": return "Satış ekle";
    case "expense": return editor.expense ? "Gideri düzenle" : "Gider ekle";
    case "cash-payment-edit": return editor.payment.kind === "receipt" ? "Tahsilatı düzenle" : "Stok ödemesini düzenle";
    case "cash-delete": return "Kasa kaydını sil";
    case "purchase-payment": return "Stok ödemesini kaydet";
    case "receipt": return "Tahsilatı kaydet";
    case "order-detail": return "Sipariş detayı";
    case "order-status": return { packed: "Paketlemeyi tamamla", cancelled: "Siparişi iptal et", returned: "İade kaydet" }[editor.status];
  }
}
function EditorBody({ editor, shop, user, busy, save, open }: { editor: Editor; shop: Shop; user: Member; busy: boolean; save: Save; open: (editor: Editor) => void }) {
  switch (editor.type) {
    case "product":
      return <ProductForm product={editor.product} busy={busy} save={save} />;
    case "purchase":
    case "order":
      return <LinesForm mode={editor.type} shop={shop} user={user} busy={busy} save={save} addProduct={() => open({ type: "product" })} />;
    case "order-detail":
      return <OrderDetail order={editor.order} users={shop.users} audit={shop.audit} open={open} />;
    case "cash-payment-edit": {
      const { payment } = editor;
      const receipt = payment.kind === "receipt";
      return <form className="form" onSubmit={event => save(event, "cash-edit", data => ({
        id: payment.id, kind: payment.kind, date: field(data, "date"), memberId: Number(field(data, "memberId")),
        amount: receipt ? requiredMoney(field(data, "amount")) : undefined,
      }))}>
        <div className="form-totals inline"><span>{payment.description || cashLabels[payment.kind]}</span><strong>{money(Math.abs(payment.amount))}</strong></div>
        {receipt && <AmountField label="Hesaba geçen tutar (₺)" name="amount" value={moneyInput(payment.amount)} />}
        <DateField label={receipt ? "Hesaba geçiş tarihi" : "Ödeme tarihi"} value={payment.date} />
        <MemberField label={receipt ? "Paranın geçtiği hesap" : "Ödeyen"} users={shop.users} defaultId={payment.memberId} name="memberId" />
        <SaveButton busy={busy} />
      </form>;
    }
    case "cash-delete": {
      const { entry } = editor;
      const detail = entry.kind === "receipt" ? "Tahsilat siparişten kaldırılır."
        : entry.kind === "purchase" ? "Stok alımı yeniden ödeme bekleyenlere döner."
        : "Kayıt giderler listesinden de kaldırılır.";
      return <form className="form" onSubmit={event => save(event, "cash-delete", () => ({ id: entry.id, kind: entry.kind }))}>
        <p>{cashLabels[entry.kind]}{entry.description && " · " + entry.description} · {money(Math.abs(entry.amount))} · {dateLabel(entry.date)}</p>
        <p className="listing-note">Bu kayıt kasadan silinir. {detail}</p>
        <div className="actions"><button className="danger" disabled={busy} type="submit">{busy ? "Siliniyor…" : "Silmeyi onayla"}</button></div>
      </form>;
    }
    case "purchase-payment":
      return <form className="form" onSubmit={event => save(event, "purchase-payment", data => ({ id: editor.purchase.id, date: field(data, "date"), payerId: Number(field(data, "payerId")) }))}>
        <div className="form-totals inline"><span>{editor.purchase.name}</span><strong>{money(editor.purchase.total)}</strong></div>
        <DateField label="Ödeme tarihi" /><MemberField label="Ödeyen" users={shop.users} defaultId={user.id} />
        <SaveButton busy={busy} />
      </form>;
    case "receipt":
      return <form className="form" onSubmit={event => save(event, "receipt", data => ({
        id: editor.order.id, date: field(data, "date"), amount: requiredMoney(field(data, "amount")), recipientId: Number(field(data, "recipientId")),
      }))}>
        <div className="form-totals inline"><span>Beklenen tahsilat</span><strong>{money(editor.order.expectedReceipt)}</strong></div>
        <AmountField label="Hesaba geçen tutar (₺)" name="amount" value={moneyInput(editor.order.expectedReceipt)} />
        <DateField label="Hesaba geçiş tarihi" /><MemberField label="Paranın geçtiği hesap" users={shop.users} defaultId={user.id} name="recipientId" />
        <SaveButton busy={busy} />
      </form>;
    case "order-status": {
      const products = orderProducts(editor.order);
      return <form className="form" onSubmit={event => save(event, "order-status", data => ({
        id: editor.order.id, status: editor.status, date: field(data, "date"),
        returns: editor.status === "returned" ? products.map(product => ({
          productId: product.productId, quantity: Number(field(data, "return-" + product.productId)),
        })).filter(product => product.quantity > 0) : undefined,
      }))}>
        <p>{editor.order.platform} · {editor.order.reference || "#" + editor.order.id}</p>
        {editor.status === "cancelled" && <p className="listing-note">İşlemi onayladığında sipariş iptal edilir ve ürünler stoğa geri eklenir.</p>}
        {editor.status === "returned" && <fieldset className="line-editor">
          <legend>Stoğa geri eklenecek satılabilir adetler</legend>
          {products.map(product => <label key={product.productId}>
            {product.name} · En fazla {product.quantity} adet
            <input name={"return-" + product.productId} type="number" inputMode="numeric" min={0} max={product.quantity} step={1} defaultValue={0} required />
          </label>)}
        </fieldset>}
        <DateField label={editor.status === "returned" ? "İade tarihi" : editor.status === "cancelled" ? "İptal tarihi" : "Paketleme tarihi"} />
        <SaveButton busy={busy}>{editor.status === "cancelled" ? "İptali onayla" : "Kaydet"}</SaveButton>
      </form>;
    }
    case "expense": {
      const { expense } = editor;
      const categories = expense && !expenseCategories.includes(expense.category) ? [...expenseCategories, expense.category] : expenseCategories;
      return <form className="form" onSubmit={event => save(event, expense ? "cash-edit" : "expense", data => {
        const details = { category: field(data, "category"), amount: requiredMoney(field(data, "amount")), date: field(data, "date"), note: field(data, "note").trim() || undefined };
        const payerId = Number(field(data, "payerId"));
        return expense ? { ...details, id: expense.id, kind: "expense", memberId: payerId } : { ...details, payerId };
      })}>
        <label>Kategori<select name="category" defaultValue={expense?.category} required>{categories.map(category => <option key={category}>{category}</option>)}</select></label>
        <div className="form-row"><AmountField label="Tutar (₺)" name="amount" value={expense ? moneyInput(expense.amount) : undefined} /><DateField value={expense?.date} /></div>
        <MemberField label="Ödeyen" users={shop.users} defaultId={expense?.payerId ?? user.id} />
        <label>Not (isteğe bağlı)<textarea name="note" defaultValue={expense?.note ?? ""} rows={3} maxLength={500} /></label>
        <SaveButton busy={busy} />
      </form>;
    }
  }
}
function EditorDialog({ editor, shop, user, busy, error, save, open, close }: { editor: Editor; shop: Shop; user: Member; busy: boolean; error: string; save: Save; open: (editor: Editor) => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const current = dialog.current;
    current?.showModal();
    return () => { current?.close(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="editor-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <div className="dialog-head"><h2 id="editor-title">{getTitle(editor)}</h2><button type="button" disabled={busy} onClick={close} aria-label="Kapat"><X className="icon" aria-hidden="true" /></button></div>
    {error && <p className="form-error editor-error" role="alert">{error}</p>}
    <EditorBody key={editor.type + (editor.type === "order-status" ? editor.status : "")} editor={editor} shop={shop} user={user} busy={busy} save={save} open={open} />
  </dialog>;
}
function visiblePage(page: PageName, shop: Shop, open: (editor: Editor) => void) {
  switch (page) {
    case "dashboard": return <Dashboard data={shop} open={open} />;
    case "products": return <Products products={shop.products} open={open} />;
    case "orders": return <Orders orders={shop.orders} open={open} />;
    case "stock": return <StockPage data={shop} open={open} />;
    case "cash": return <CashPage data={shop} open={open} />;
    case "reports": return <Reports month={shop.summary.month} />;
  }
}
export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [shop, setShop] = useState<Shop | null>(null);
  const [page, setPage] = useState<PageName>("dashboard");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [editorError, setEditorError] = useState("");
  const [notice, setNotice] = useState("");
  const refreshSequence = useRef(0);
  const loggingOut = useRef(false);
  const clearSession = useCallback(() => {
    refreshSequence.current += 1;
    setSession({ user: null, needsSetup: false });
    setShop(null);
    setPage("dashboard");
    setNotice("");
    setEditor(null);
    setLoadError("");
  }, []);
  const refresh = useCallback(async () => {
    if (loggingOut.current) return;
    const sequence = ++refreshSequence.current;
    try {
      const current = await api<Session>("session");
      const data = current.user ? await api<Shop>("state") : null;
      if (sequence !== refreshSequence.current) return;
      if (current.user) {
        setShop(data);
        setSession(current);
        setLoadError("");
      } else {
        clearSession();
        setSession(current);
      }
    } catch (error) {
      if (sequence !== refreshSequence.current) return;
      if (isUnauthorized(error)) clearSession();
      else throw error;
    }
  }, [clearSession]);
  useEffect(() => {
    function load() { void refresh().catch(error => setLoadError(errorMessage(error))); }
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [refresh]);
  function open(next: Editor) {
    setEditorError("");
    setNotice("");
    setEditor(next);
  }
  async function logout() {
    if (loggingOut.current) return;
    loggingOut.current = true;
    refreshSequence.current += 1;
    try {
      await api("logout", {});
      clearSession();
    } catch (error) {
      if (isUnauthorized(error)) clearSession();
      else setLoadError(errorMessage(error));
    } finally {
      loggingOut.current = false;
    }
  }
  const save: Save = async (event, action, build) => {
    event.preventDefault();
    if (busy) return;
    setEditorError("");
    setBusy(true);
    try {
      const body = build(new FormData(event.currentTarget));
      await api(action, body);
      setEditor(null);
      const platform = action === "order" && body && typeof body === "object" && "platform" in body ? body.platform : null;
      setNotice(platform ? "Satış kaydedildi. " + (platform === "Dolap" ? "Gardrops" : "Dolap") + " ilanındaki ürün adedini kontrol et."
        : action === "cash-delete" ? "Kasa kaydı silindi." : "Kayıt güncellendi.");
      await refresh().catch(error => setLoadError(errorMessage(error)));
    } catch (error) {
      if (isUnauthorized(error)) clearSession();
      else setEditorError(errorMessage(error));
    }
    finally { setBusy(false); }
  };
  if (!session) return <main className="auth"><section className="auth-card panel"><Brand />
    {loadError ? <><p className="form-error" role="alert">{loadError}</p><button onClick={() => void refresh().catch(error => setLoadError(errorMessage(error)))}>Tekrar dene</button></> : <p className="muted" role="status">Panel yükleniyor…</p>}
  </section></main>;
  if (!session.user) return <Authentication setup={session.needsSetup} onAuthenticated={async () => { await refresh(); }} />;
  if (!shop) return <main className="auth"><p role="status">Mağaza verileri yükleniyor…</p></main>;
  const user = session.user;
  return <div className="shell">
    <aside className="sidebar">
      <Brand />
      <nav className="nav" aria-label="Mağaza paneli">{sections.map(({ id, label, Icon }) => <button key={id} aria-current={page === id ? "page" : undefined} onClick={() => { setPage(id); setNotice(""); window.scrollTo(0, 0); }}><Icon aria-hidden="true" />{label}</button>)}</nav>
      <div className="side-bottom">
        <div className="account"><span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toLocaleUpperCase("tr-TR")}</span><strong>{user.name}</strong></div>
        <button className="quiet" onClick={logout}><LogOut className="icon" aria-hidden="true" /> Çıkış yap</button>
      </div>
    </aside>
    <main className="main">
      <div className="topbar"><span className="date"><CalendarDays className="icon" aria-hidden="true" />{dateLabel(today())}</span><div className="mobile-account"><span>{user.name}</span><button className="quiet" aria-label="Çıkış yap" onClick={logout}><LogOut className="icon" aria-hidden="true" /></button></div></div>
      {loadError && <p className="form-error editor-error" role="alert">{loadError} <button onClick={() => void refresh().catch(error => setLoadError(errorMessage(error)))}>Tekrar dene</button></p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {visiblePage(page, shop, open)}
    </main>
    {editor && <EditorDialog editor={editor} shop={shop} user={user} busy={busy} error={editorError} save={save} open={open} close={() => setEditor(null)} />}
  </div>;
}

