"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Activity, Archive, BarChart3, Boxes, CalendarDays, Check, Download, Heart, House, LogOut, Plus, Receipt, Settings, ShoppingBag, Sparkles, Users, Wallet, X } from "lucide-react";
import { calculatePartnership, type PartnerTransfer, type PurchasePayment, type StockLoss } from "@/lib/shop-partnership";
import { calculatePerformance, comparePlatforms, restockSuggestions, performanceTrend } from "@/lib/shop-performance";
import { budgetPurchases, lastYear, stockoutDays, supplierStats, type WholesalePrice } from "@/lib/shop-planning";
import { boughtTogether, tiedCapital, purchaseRecovery, previousPeriod, periodSummary } from "@/lib/shop-analytics";

type Member = { id: number; username: string; name: string };
type Session = { user: Member | null; needsSetup: boolean };
type Platform = "Dolap" | "Gardrops";
type Product = { id: number; name: string; photo: string | null; dolapListPrice: number; gardropsListPrice: number; lowThreshold: number; stock: number; firstPartnerShare: number | null };
type Purchase = {
  id: number; name: string; date: string; total: number; actorId: number; revision: number;
  paymentDate: string | null; payerId: number | null;
  openingPayerId?: number | null; supplier?: string | null; orderedOn?: string | null; rejectedUnits?: number | null;
  payments: PurchasePayment[];
  lines: { lotId: number; productId: number; productName: string; quantity: number; unitCost: number;
    usedQuantity: number; hasSalesHistory: boolean; firstPartnerShare: number | null }[];
};
type OrderStatus = "pending" | "packed" | "cancelled" | "returned";
type Order = {
  id: number; revision: number; platform: Platform; reference: string | null; date: string; status: OrderStatus;
  gross: number; discount: number; platformFee: number; shipping: number; packing: number; cost: number;
  netAfterShipping?: number | null;
  shippingPayerId?: number | null; packingPayerId?: number | null;
  expectedReceipt: number; profit: number; actorId: number; receiptDate: string | null; receiptAmount: number | null;
  recipientId: number | null; returnSellable?: boolean | null; returnLines?: { productId: number; quantity: number }[];
  lines: { productId: number; productName: string; purchaseId: number; lotId: number; quantity: number; listPrice: number; agreedPrice: number;
    unitCost: number; cost?: number; firstPartnerShare: number | null }[];
};
type Expense = { id: number; category: string; amount: number; date: string; payerId: number; actorId: number; note: string | null; firstPartnerShare: number | null };
type Stock = { id: number; productId: number; productName: string; date: string; kind: string; quantity: number; unitCost: number; actorId: number; reference: string };
type CashKind = "purchase" | "receipt" | "expense" | "sale-cost";
type CashEntry = { kind: CashKind; id: number; date: string; amount: number; description: string };
type Cash = CashEntry & { memberId: number; actorId: number };
type Audit = { id: number; action: string; entityId: number; actorId: number; createdAt: string; businessDate: string | null; status: OrderStatus | null };
type Shop = {
  users: Member[]; products: Product[]; purchases: Purchase[]; orders: Order[]; expenses: Expense[]; stock: Stock[]; cash: Cash[]; audit: Audit[];
  partnerTransfers: PartnerTransfer[];
  catalogKey?: string | null;
  wholesalePrices?: WholesalePrice[];
  settings: { defaultPacking: number };
  stockLosses: StockLoss[];
  packagingMaterials: PackagingMaterial[];
  packagingMovements: { id: number; materialId: number; date: string; quantity: number; orderId: number | null; note: string }[];
  productHistory: { id: number; productId: number; kind: "price" | "cost"; source: "baseline" | "recorded"; date: string; recordedAt: string;
    dolapPrice: number | null; gardropsPrice: number | null; unitCost: number | null; quantity: number | null; purchaseId: number | null }[];
  summary: { month: string; gross: number; collected: number; profit: number; cashBalance: number };
};
type PackagingMaterial = { id: number; name: string; quantity: number; lowThreshold: number; perOrder: number; revision: number };
type PageName = "dashboard" | "products" | "orders" | "stock" | "cash" | "partners" | "performance" | "analytics" | "platforms" | "restock" | "packaging" | "reports" | "settings" | "suppliers" | "missing";
type Editor =
  | { type: "product"; product?: Product }
  | { type: "product-history"; product: Product }
  | { type: "purchase" | "order" | "opening-stock" }
  | { type: "wholesale-price"; price?: WholesalePrice }
  | { type: "wholesale-price-delete"; price: WholesalePrice }
  | { type: "catalog-settings" }
  | { type: "undo"; audit: Audit }
  | { type: "expense"; expense?: Expense }
  | { type: "cash-payment-edit"; payment: Cash }
  | { type: "cash-delete"; entry: CashEntry }
  | { type: "purchase-payment"; purchase: Purchase }
  | { type: "purchase-edit"; purchase: Purchase }
  | { type: "receipt" | "order-detail" | "order-edit" | "order-delete"; order: Order }
  | { type: "order-share"; order: Order; productId: number; lotId: number; productName: string }
  | { type: "partner-transfer"; senderId?: number; amount?: number }
  | { type: "partner-transfer-delete"; transfer: PartnerTransfer }
  | { type: "settings"; defaultPacking: number }
  | { type: "stock-loss" }
  | { type: "stock-loss-delete"; loss: StockLoss }
  | { type: "packaging-material"; material?: PackagingMaterial }
  | { type: "packaging-move"; material: PackagingMaterial }
  | { type: "order-status"; order: Order; status: "packed" | "cancelled" | "returned" };

const sections = [
  { id: "dashboard", label: "Genel Bakış", Icon: House },
  { id: "products", label: "Ürünler", Icon: Heart },
  { id: "orders", label: "Satışlar", Icon: ShoppingBag },
  { id: "stock", label: "Stok", Icon: Boxes },
  { id: "cash", label: "Kasa ve Giderler", Icon: Wallet },
  { id: "partners", label: "Ortaklar", Icon: Users },
  { id: "performance", label: "Ürün Performansı", Icon: BarChart3 },
  { id: "analytics", label: "İş Analizleri", Icon: Activity },
  { id: "platforms", label: "Platform Karşılaştırması", Icon: ShoppingBag },
  { id: "restock", label: "Stok Yenileme", Icon: Boxes },
  { id: "suppliers", label: "Tedarikçiler", Icon: Archive },
  { id: "missing", label: "Eksik Kayıtlar", Icon: Receipt },
  { id: "packaging", label: "Ambalaj Stoku", Icon: Archive },
  { id: "reports", label: "Raporlar", Icon: Download },
  { id: "settings", label: "Ayarlar", Icon: Settings },
] as const;
const statusLabel: Record<OrderStatus, string> = {
  pending: "Paketlenecek", packed: "Paketlendi", cancelled: "İptal edildi", returned: "İade edildi",
};
const stockLabel: Record<string, string> = {
  purchase: "Stok alımı", sale: "Satış", cancelled: "Satış iptali", returned: "Satılabilir iade", adjustment: "Stok düzeltmesi", loss: "Hasar/kayıp",
};
const expenseCategories = ["Ambalaj", "Kargo", "Malzeme", "Pazarlama", "Diğer"];
const undoLabels: Record<string, string> = {
  order: "Yeni satış", purchase: "Yeni stok girişi", expense: "Yeni gider", receipt: "Yeni tahsilat",
  "purchase-payment": "Stok ödemesi", "stock-loss": "Hasar veya kayıp kaydı", "partner-transfer": "Ortaklar arası transfer",
};
const cashLabels: Record<CashKind, string> = { purchase: "Stok ödemesi", receipt: "Tahsilat", expense: "Gider", "sale-cost": "Satış masrafı" };
const defaultPacking = (shop: Shop) => shop.settings?.defaultPacking ?? 1000;
const turkishMoney = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" });
function money(value: number) { return turkishMoney.format(value / 100); }
function moneyInput(value: number) { return (value / 100).toFixed(2).replace(".", ","); }
function toMoney(value: string, allowNegative = false) {
  const text = value.trim();
  const negative = allowNegative && text.startsWith("-");
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(negative ? text.slice(1) : text);
  if (!match) return NaN;
  const amount = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return negative ? -amount : amount;
}
function requiredMoney(value: string, allowNegative = false) {
  const amount = toMoney(value, allowNegative);
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
    {!compact && active && <button onClick={() => open({ type: "order-edit", order })}>Düzenle</button>}
    {!compact && active && <button className="danger" onClick={() => open({ type: "order-status", order, status: "cancelled" })}>İptal et</button>}
    {!compact && order.status === "packed" && <button className="danger" onClick={() => open({ type: "order-status", order, status: "returned" })}>İade kaydet</button>}
    <button onClick={() => open({ type: "order-detail", order })}>Detay</button>
    {!compact && <button className="danger" onClick={() => open({ type: "order-delete", order })}>Sil</button>}
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
  const bills = data.purchases.filter(purchase => !purchase.paymentDate && purchase.openingPayerId == null);
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
          {receivables.length ? <div className="list">{receivables.map(order => <div className="row" key={order.id}><div><h3>{order.platform} · {order.reference || "#" + order.id}</h3><p className="subtle">{order.netAfterShipping == null || order.shippingPayerId != null ? "Beklenen" : "Kargo ve kesinti sonrası net"} {money(order.expectedReceipt)}</p></div><div className="actions"><button onClick={() => open({ type: "receipt", order })}>Tahsilat gir</button></div></div>)}</div> : <Empty>Bekleyen tahsilat yok.</Empty>}
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
        <div className="actions"><button onClick={() => open({ type: "product", product })}>Düzenle</button>
          <button onClick={() => open({ type: "product-history", product })}>Fiyat / Maliyet Geçmişi</button></div>
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
    <SectionHeader title="Stok" description="Toptan kutuları, alım ödemelerini ve ürün hareketlerini takip et.">
      <div className="actions"><AddButton onClick={() => open({ type: "stock-loss" })}>Hasar / Kayıp Kaydet</AddButton><AddButton onClick={() => open({ type: "opening-stock" })}>Açılış Stoğu</AddButton><AddButton primary onClick={() => open({ type: "purchase" })}>Stok Ekle</AddButton></div>
    </SectionHeader>
    <div className="stack">
      <Panel title="Toptan alımlar">{data.purchases.length ? <div className="list">{data.purchases.map(purchase =>
        <details className="purchase-details" key={purchase.id}>
          <summary><span><strong>{purchase.name}</strong><br /><span className="subtle">{dateLabel(purchase.date)} · {money(purchase.total)}</span></span><span className={"pill " + (purchase.openingPayerId || purchase.paymentDate ? "ok" : "warning")}>{purchase.openingPayerId ? "Açılış stoğu" : purchase.paymentDate ? "Ödendi" : "Ödeme bekliyor"}</span></summary>
          {(purchase.supplier || purchase.orderedOn || purchase.rejectedUnits != null || purchase.openingPayerId) && <p className="subtle">
            {[purchase.supplier, purchase.orderedOn && "Sipariş " + dateLabel(purchase.orderedOn),
              purchase.rejectedUnits != null && purchase.rejectedUnits + " kusurlu adet",
              purchase.openingPayerId && "Ödeyen " + getMember(data.users, purchase.openingPayerId)].filter(Boolean).join(" · ")}
          </p>}
          <Table headers={["Ürün", "Alınan adet", "Kalan adet", "Birim maliyet", "Toplam", "Kâr payı"]} rows={purchase.lines.map(line => [
            line.productName, line.quantity, line.quantity - (line.usedQuantity ?? 0), money(line.unitCost), money(line.quantity * line.unitCost),
            line.firstPartnerShare == null ? "Pay girilmedi" : shareLabel(data.users, line.firstPartnerShare),
          ])} />
          <div className="row"><p className="subtle">Ekleyen {getMember(data.users, purchase.actorId)}{purchase.paymentDate && " · " + (purchase.payments ?? []).map(payment => getMember(data.users, payment.payerId) + " " + money(payment.amount)).join(" + ") + " · " + dateLabel(purchase.paymentDate)}</p>
          <div className="actions">
            <button onClick={() => open({ type: "purchase-edit", purchase })}>Düzenle</button>
            {!purchase.openingPayerId && <button onClick={() => open({ type: "purchase-payment", purchase })}>{purchase.paymentDate ? "Ödemeyi düzenle" : "Ödeme gir"}</button>}
          </div></div>
        </details>,
      )}</div> : <Empty>Henüz toptan alım kaydı yok.</Empty>}</Panel>
      <Panel title="Hasarlı ve kayıp ürünler">
        {data.stockLosses?.length ? <Table headers={["Tarih", "Ürün", "Neden", "Adet", "Maliyet zararı", "Not", "İşlem"]}
          rows={data.stockLosses.map(loss => [dateLabel(loss.date), loss.productName, loss.reason === "damaged" ? "Hasarlı" : "Kayıp",
            loss.quantity, money(loss.lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0)), loss.note || "—",
            <button key={loss.id} onClick={() => open({ type: "stock-loss-delete", loss })}>Geri al</button>])} />
          : <Empty>Hasar veya kayıp kaydı yok.</Empty>}
      </Panel>
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
          const purchase = data.purchases.find(purchase => item.kind === "purchase" && purchase.id === item.id);
          const sale = item.kind === "sale-cost" ? data.orders.find(order => order.id === item.id) : undefined;
          const rowActions = sale ? <button onClick={() => open({ type: "order-detail", order: sale })}>Satışı aç</button> : item.kind === "expense"
            ? expense && expenseActions(expense)
            : purchase ? actions({ ...item, amount: -purchase.total }, { type: "purchase-payment", purchase })
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
function PartnersPage({ data, open }: { data: Shop; open: (editor: Editor) => void }) {
  const [from, setFrom] = useState(data.summary.month + "-01");
  const [through, setThrough] = useState(today);
  const valid = from !== "" && through !== "" && from <= through;
  const figures = valid ? calculatePartnership(data, from, through) : null;
  const transfers = (data.partnerTransfers ?? []).filter(transfer => transfer.date >= from && transfer.date <= through);
  const names = figures?.partners.map(partner => getMember(data.users, partner.id));
  const sender = figures && figures.partners[figures.firstBalance > 0 ? 1 : 0];
  const recipient = figures && figures.partners[figures.firstBalance > 0 ? 0 : 1];
  return <>
    <SectionHeader title="Ortaklar" description="Stok alımlarının pay oranlarına göre kârı ve ortaklar arasındaki ödemeleri takip et.">
      <AddButton onClick={() => open({ type: "partner-transfer" })}>Transfer Kaydet</AddButton>
    </SectionHeader>
    <div className="stack">
      <div className="form form-row">
        <label>Başlangıç<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label>Bitiş<input type="date" value={through} onChange={event => setThrough(event.target.value)} /></label>
      </div>
      {figures && names && sender && recipient ? <>
        <Panel title="Ortaklar arası bakiye">
          <p>{figures.firstBalance === 0 ? "Kayıtlı işlemlerde açık bakiye yok."
            : getMember(data.users, sender.id) + ", " + getMember(data.users, recipient.id) + " hesabına " + money(Math.abs(figures.firstBalance)) + " göndermeli."}</p>
          <p className="subtle">Bakiye, bitiş tarihine kadar kaydedilen tahsilatları, satılan ürünler için ödenen stok maliyetlerini, payı girilen giderleri ve transferleri kapsar.</p>
          {figures.firstBalance !== 0 && <div className="actions">
            <button onClick={() => open({ type: "partner-transfer", senderId: sender.id, amount: Math.abs(figures.firstBalance) })}>Ödemeyi kaydet</button>
          </div>}
          {figures.awaitingStockPayments.size > 0 && <p className="subtle">{figures.awaitingStockPayments.size} tahsilat stok ödemesi girilince bölüşüme dahil olur.</p>}
          {figures.awaitingLossPayments > 0 && <p className="subtle">{figures.awaitingLossPayments} hasar/kayıp kaydı stok ödemesi tamamlanınca ortak bakiyesine yansır.</p>}
          {figures.excludedReceipts > 0 && <p className="subtle">İptal ve iadelere ait {money(figures.excludedReceipts)} tahsilat bölüşüm dışında.</p>}
          {figures.unassignedExpenses > 0 && <p className="subtle">{figures.unassignedExpenses} giderin payı boş. Kasa ve Giderler ekranından pay girerek bölüşüme dahil edebilirsin.</p>}
          {figures.missingShares.size > 0 && <div className="stack">
            <p className="subtle">Payı eksik satışlar. Oranları satış detayında tamamla.</p>
            <div className="actions">{data.orders.filter(order => figures.missingShares.has(order.id)).map(order =>
              <button key={order.id} onClick={() => open({ type: "order-detail", order })}>{order.platform} · {order.reference || "#" + order.id}</button>)}</div>
          </div>}
        </Panel>
        <Panel title="Dönem özeti">
          <Table headers={["Ortak", "Aldığı tahsilat", "Ödediği stok", "Ödediği gider", "Bölüşülen net kâr payı"]}
            rows={figures.partners.map((partner, index) => [names[index], money(partner.receipts), money(partner.stockPaid),
              money(partner.expensesPaid), money(partner.realizedShare)])} />
        </Panel>
        <Panel title="Dönemin ürün kârları">
          <p className="subtle">Satış tutarından platform kesintisi, siparişin kargo ve paketleme giderleri, stok maliyeti ve hasar/kayıp maliyeti düşülür.</p>
          {figures.products.length ? <Table headers={["Ürün", "Adet", "Satış kârı", names[0], names[1], "Payı eksik satış"]}
            rows={figures.products.map(product => [product.name, product.quantity, money(product.profit), money(product.firstProfit),
              money(product.secondProfit), product.unassigned || "—"])} /> : <Empty>Bu dönemde ürün satışı yok.</Empty>}
        </Panel>
        <Panel title="Ortaklar arası transferler">
          {transfers.length ? <Table headers={["Tarih", "Gönderen", "Alan", "Tutar", "Not", "İşlemler"]}
            rows={transfers.map(transfer => [dateLabel(transfer.date), getMember(data.users, transfer.senderId),
              getMember(data.users, transfer.recipientId), money(transfer.amount), transfer.note || "—",
              <button className="danger" key={transfer.id} onClick={() => open({ type: "partner-transfer-delete", transfer })}>Sil</button>])} />
            : <Empty>Bu dönemde transfer kaydı yok.</Empty>}
        </Panel>
      </> : <p className="form-error" role="alert">Geçerli bir başlangıç ve bitiş tarihi seç.</p>}
    </div>
  </>;
}
function ChartBars({ values, format, signed = false }: {
  values: { label: string; value: number }[]; format: (value: number) => string; signed?: boolean;
}) {
  const maximum = Math.max(1, ...values.map(item => Math.abs(item.value)));
  return <div className="chart-bars" role="list">
    {values.map((item, index) => {
      const width = Math.abs(item.value) / maximum * (signed ? 50 : 100);
      const left = signed ? item.value < 0 ? 50 - width : 50 : 0;
      return <div className="chart-row" role="listitem" key={item.label + index} title={item.label + " · " + format(item.value)}>
        <span className="chart-label">{item.label}</span>
        <div className={"chart-track" + (signed ? " chart-signed" : "")} aria-hidden="true">
          <span className={"chart-fill" + (item.value < 0 ? " chart-negative" : "")} style={{ width: width + "%", left: left + "%" }} />
        </div>
        <strong>{format(item.value)}</strong>
      </div>;
    })}
  </div>;
}
function PerformancePage({ data }: { data: Shop }) {
  const [from, setFrom] = useState(data.summary.month + "-01");
  const [through, setThrough] = useState(today);
  const [sort, setSort] = useState("quantity");
  const [query, setQuery] = useState("");
  const valid = from !== "" && through !== "" && from <= through;
  const rows = valid ? calculatePerformance(data, from, through, today()) : [];
  const shown = rows.filter(row => row.name.toLocaleLowerCase("tr-TR").includes(query.trim().toLocaleLowerCase("tr-TR")));
  shown.sort((a, b) => {
    if (sort === "profit") return b.profit - a.profit || a.name.localeCompare(b.name, "tr");
    if (sort === "waiting") return b.daysInStock - a.daysInStock || b.stock - a.stock;
    return b.quantity - a.quantity || b.profit - a.profit;
  });
  const totalSold = rows.reduce((sum, row) => sum + row.quantity, 0);
  const totalProfit = rows.reduce((sum, row) => sum + row.profit, 0);
  const trend = valid ? performanceTrend(data, from, through) : [];
  const byQuantity = [...rows].filter(row => row.quantity > 0).sort((a, b) => b.quantity - a.quantity).slice(0, 6);
  const byProfit = [...rows].filter(row => row.gross > 0 || row.lossCost > 0).sort((a, b) => b.profit - a.profit).slice(0, 6);
  return <>
    <SectionHeader title="Ürün Performansı" description="Satılan adetleri, ürün kârlarını ve stokta bekleyen ürünleri takip et." />
    <div className="stack">
      <div className="form form-row">
        <label>Başlangıç<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label>Bitiş<input type="date" value={through} onChange={event => setThrough(event.target.value)} /></label>
      </div>
      {valid ? <>
        <Panel title="Dönem toplamı" meta={<span>{totalSold} ürün · {money(totalProfit)} kâr</span>}>
          <p className="subtle">Net sonuca kargo, platform kesintisi, paketleme, ürün maliyeti ve hasar/kayıp maliyeti dahildir.</p>
        </Panel>
        <div className="chart-grid">
          <Panel title="En çok satan ürünler">
            {byQuantity.length ? <ChartBars values={byQuantity.map(row => ({ label: row.name, value: row.quantity }))} format={value => value + " adet"} />
              : <Empty>Bu dönemde satış yok.</Empty>}
          </Panel>
          <Panel title="Ürünlerin net sonucu">
            {byProfit.length ? <ChartBars values={byProfit.map(row => ({ label: row.name, value: row.profit }))} format={money} signed />
              : <Empty>Bu dönemde satış veya zarar kaydı yok.</Empty>}
          </Panel>
        </div>
        <Panel title="Satış ve net sonuç gelişimi">
          <p className="subtle">Seçilen dönem en fazla 12 zaman aralığına bölünür. Etiketler aralıkların başlangıcını gösterir.</p>
          <ChartBars values={trend.flatMap(point => [
            { label: point.date.slice(8, 10) + "." + point.date.slice(5, 7) + " · Satış", value: point.gross },
            { label: point.date.slice(8, 10) + "." + point.date.slice(5, 7) + " · Net", value: point.profit },
          ])} format={money} signed />
        </Panel>
        <Panel title="Ürünler">
          <div className="form form-row">
            <label>Ürün ara<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <label>Sırala<select value={sort} onChange={event => setSort(event.target.value)}>
              <option value="quantity">En çok satan</option><option value="profit">En çok kâr bırakan</option><option value="waiting">En uzun bekleyen</option>
            </select></label>
          </div>
          <p className="subtle">Stok ve bekleme süresi bugünkü kalan ürünleri gösterir. Bekleme süresi eldeki en eski alımdan hesaplanır.</p>
          {shown.length ? <Table headers={["Ürün", "Satılan adet", "Satış toplamı", "Hasar/kayıp", "Net sonuç", "Kâr oranı", "Güncel stok", "Stokta bekleme"]}
            rows={shown.map(row => [row.name, row.quantity, money(row.gross), money(row.lossCost), money(row.profit),
              row.margin === null ? "—" : "%" + row.margin.toLocaleString("tr-TR", { maximumFractionDigits: 1 }),
              row.stock, row.stock ? row.daysInStock + " gün" : "—"])} /> : <Empty>Bu seçime uygun ürün yok.</Empty>}
        </Panel>
      </> : <p className="form-error" role="alert">Geçerli bir başlangıç ve bitiş tarihi seç.</p>}
    </div>
  </>;
}
function PlatformsPage({ data }: { data: Shop }) {
  const [from, setFrom] = useState(data.summary.month + "-01");
  const [through, setThrough] = useState(today);
  const valid = from !== "" && through !== "" && from <= through;
  const platforms = valid ? comparePlatforms(data.orders, from, through) : [];
  return <>
    <SectionHeader title="Platform Karşılaştırması" description="Dolap ve Gardrops satışlarını, masraflarını ve kârlarını karşılaştır." />
    <div className="stack">
      <div className="form form-row">
        <label>Başlangıç<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label>Bitiş<input type="date" value={through} onChange={event => setThrough(event.target.value)} /></label>
      </div>
      {valid ? <Panel title="Dönem karşılaştırması">
        <p className="subtle">Tutarlar paketlenecek ve paketlenmiş satışları kapsar. Kâr hesabında kesinti, kargo, paketleme ve stok maliyeti düşülür.</p>
        <Table headers={["Platform", "Sipariş", "Satılan adet", "Satış toplamı", "Kesinti + kargo", "Paketleme", "Ürün maliyeti", "Kâr", "Kâr oranı", "Ortalama sepet", "İptal", "İade"]}
          rows={platforms.map(platform => [
            platform.platform, platform.orders, platform.quantity, money(platform.gross), money(platform.deductions),
            money(platform.packing), money(platform.cost), money(platform.profit),
            platform.margin === null ? "—" : "%" + platform.margin.toLocaleString("tr-TR", { maximumFractionDigits: 1 }),
            platform.averageBasket === null ? "—" : money(platform.averageBasket), platform.cancelled, platform.returned,
          ])} />
        <p className="subtle">Kesinti ve kargo, elle girilen net tutarlarda toplam farktan hesaplanır. Genel kasa giderleri bu karşılaştırmaya dahil edilmez.</p>
      </Panel> : <p className="form-error" role="alert">Geçerli bir başlangıç ve bitiş tarihi seç.</p>}
    </div>
  </>;
}
function SuppliersPage({ data, open }: { data: Shop; open: (editor: Editor) => void }) {
  const suppliers = supplierStats(data.purchases);
  const prices = data.wholesalePrices ?? [];
  return <>
    <SectionHeader title="Tedarikçiler" description="Alım kayıtlarından teslim sürelerini ve kusurlu ürün oranını izle.">
      <AddButton primary onClick={() => open({ type: "wholesale-price" })}>Fiyat Kademesi Ekle</AddButton>
    </SectionHeader>
    <div className="stack">
      <Panel title="Kalite ve teslim süreleri">
        {suppliers.length ? <Table headers={["Tedarikçi", "Alım", "Kontrol edilen alım", "Kusurlu / gelen adet", "Kusur oranı", "Ortalama teslim süresi", "Ölçülen teslim"]} rows={suppliers.map(row => [
          row.name, row.purchases, row.checked, row.checked ? row.rejected + " / " + row.received : "—",
          row.received ? "%" + (row.rejected / row.received * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 }) : "—",
          row.timed ? (row.days / row.timed).toLocaleString("tr-TR", { maximumFractionDigits: 1 }) + " gün" : "—", row.timed,
        ])} /> : <Empty>Stok kayıtlarına tedarikçi bilgisi eklediğinde sonuçlar burada görünür.</Empty>}
      </Panel>
      <Panel title="Toptan fiyat kademeleri">
        <p className="subtle">Bir tedarikçiden aynı ürün için 5 ve 10 adet gibi farklı eşikler girebilirsin. Alım listesi sipariş adedine uyan kademeyi kullanır.</p>
        {prices.length ? <Table headers={["Ürün", "Tedarikçi", "En az adet", "Birim fiyat", "İşlemler"]} rows={prices.map(price => [
          data.products.find(product => product.id === price.productId)?.name ?? "—", price.supplier, price.minimumQuantity, money(price.unitCost),
          <div className="actions" key={price.productId + ":" + price.supplier + ":" + price.minimumQuantity}>
            <button onClick={() => open({ type: "wholesale-price", price })}>Düzenle</button>
            <button className="danger" onClick={() => open({ type: "wholesale-price-delete", price })}>Sil</button>
          </div>,
        ])} /> : <Empty>Henüz fiyat kademesi yok.</Empty>}
      </Panel>
    </div>
  </>;
}

function MissingRecords({ data, open }: { data: Shop; open: (editor: Editor) => void }) {
  const active = data.orders.filter(order => order.status === "pending" || order.status === "packed");
  const purchases = data.purchases.filter(purchase => purchase.date <= today());
  const stockRows = purchases.flatMap(purchase => {
    const issues = [
      !purchase.paymentDate && !purchase.openingPayerId && "Ödeme kaydı eksik",
      purchase.lines.some(line => line.firstPartnerShare == null && line.usedQuantity < line.quantity) && "Stok kâr payı eksik",
      purchase.lines.some(line => line.unitCost === 0) && "Sıfır maliyetli satırı kontrol et",
      purchase.supplier && purchase.rejectedUnits == null && "Kalite kontrolü girilmemiş",
      purchase.supplier && !purchase.orderedOn && "Tedarikçi sipariş tarihi eksik",
    ].filter(Boolean);
    return issues.length ? [[dateLabel(purchase.date), purchase.name, issues.join(" · "),
      <div key={purchase.id} className="actions">
        <button onClick={() => open({ type: "purchase-edit", purchase })}>Stok kaydını aç</button>
        {!purchase.paymentDate && !purchase.openingPayerId && <button onClick={() => open({ type: "purchase-payment", purchase })}>Ödeme gir</button>}
      </div>]] : [];
  });
  const saleRows = active.flatMap(order => {
    const issues = [order.status === "packed" && !order.receiptDate && "Tahsilat bekliyor",
      order.lines.some(line => line.firstPartnerShare == null) && "Satış kâr payı eksik"].filter(Boolean);
    return issues.length ? [[dateLabel(order.date), order.platform + " · " + (order.reference || "#" + order.id), issues.join(" · "),
      <button key={order.id} onClick={() => open({ type: "order-detail", order })}>Satışı aç</button>]] : [];
  });
  const expenses = data.expenses.filter(expense => expense.firstPartnerShare == null);
  return <>
    <SectionHeader title="Eksik Kayıtlar" description="Eksik bilgileri ve bekleyen ödemeleri ilgili işlemden tamamla." />
    <div className="stack">
      <Panel title="Stok ve alımlar">{stockRows.length ? <Table headers={["Tarih", "Alım", "Kontrol", "İşlem"]} rows={stockRows} /> : <Empty>Kontrol edilecek stok kaydı yok.</Empty>}</Panel>
      <Panel title="Satışlar ve tahsilatlar">{saleRows.length ? <Table headers={["Tarih", "Satış", "Kontrol", "İşlem"]} rows={saleRows} /> : <Empty>Kontrol edilecek satış yok.</Empty>}</Panel>
      <Panel title="Gider payları">{expenses.length ? <Table headers={["Tarih", "Gider", "Tutar", "İşlem"]} rows={expenses.map(expense => [
        dateLabel(expense.date), expense.category, money(expense.amount), <button key={expense.id} onClick={() => open({ type: "expense", expense })}>Gideri aç</button>,
      ])} /> : <Empty>Payı eksik gider yok.</Empty>}</Panel>
    </div>
  </>;
}

function RestockPage({ data }: { data: Shop }) {
  const [windowDays, setWindowDays] = useState("30");
  const [targetDays, setTargetDays] = useState("14");
  const [query, setQuery] = useState("");
  const [onlyNeeded, setOnlyNeeded] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");
  const window = Number(windowDays);
  const target = Number(targetDays);
  const valid = Number.isInteger(window) && window >= 1 && window <= 365 && Number.isInteger(target) && target >= 1 && target <= 365;
  const suggestions = valid ? restockSuggestions(data, today(), window, target) : [];
  const shown = suggestions.filter(row =>
    (!onlyNeeded || row.suggestedQuantity > 0) && row.name.toLocaleLowerCase("tr-TR").includes(query.trim().toLocaleLowerCase("tr-TR")));
  shown.sort((a, b) => b.suggestedQuantity - a.suggestedQuantity || b.quantity - a.quantity || a.name.localeCompare(b.name, "tr"));
  const needed = suggestions.filter(row => row.suggestedQuantity > 0);
  const unavailable = valid ? stockoutDays(data.products, data.stock, today(), window) : new Map();
  const budget = toMoney(budgetInput);
  const plan = valid && budgetInput.trim() && Number.isFinite(budget)
    ? budgetPurchases(suggestions, data.purchases, data.wholesalePrices ?? [], budget, today()) : null;
  return <>
    <SectionHeader title="Stok Yenileme" description="Son satış hızına göre hangi üründen kaç adet alacağını planla." />
    <div className="stack">
      <div className="form form-row">
        <label>İncelenecek son gün sayısı<input type="number" inputMode="numeric" min={1} max={365} step={1} value={windowDays} onChange={event => setWindowDays(event.target.value)} /></label>
        <label>Hedef stok süresi (gün)<input type="number" inputMode="numeric" min={1} max={365} step={1} value={targetDays} onChange={event => setTargetDays(event.target.value)} /></label>
      </div>
      {valid ? <Panel title="Yenileme önerileri" meta={<span>{needed.length} ürün · {needed.reduce((sum, row) => sum + row.suggestedQuantity, 0)} adet öneriliyor</span>}>
        <p className="subtle">Bugün dahil son {window} gündeki satış hızıyla {target} günlük hedef stok hesaplanır. İptal ve iadeler çıkarılır. Öneri, bu dönemde stokta bulunamadığı günleri de kapsayan ortalamaya dayanır.</p>
        <div className="form form-row">
          <label>Ürün ara<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={onlyNeeded} onChange={event => setOnlyNeeded(event.target.checked)} />Yalnızca yenilenecekler</label>
        </div>
        {shown.length ? <Table headers={["Ürün", "Güncel stok", "Son " + window + " günde satış", "Günlük ortalama", "Stoksuz gün", "Tahmini kalan süre", "Hedef stok", "Alım önerisi"]}
          rows={shown.map(row => [
            row.name, row.stock, row.quantity, row.dailySales.toLocaleString("tr-TR", { maximumFractionDigits: 2 }),
            unavailable.get(row.id) ?? "—",
            row.daysRemaining === null ? "Satış verisi yok" : row.daysRemaining.toLocaleString("tr-TR", { maximumFractionDigits: 1 }) + " gün",
            row.quantity ? row.targetStock : "—", row.suggestedQuantity ? row.suggestedQuantity + " adet" : "—",
          ])} /> : <Empty>Bu seçime uygun ürün yok.</Empty>}
        <p className="subtle">Stoksuz gün, ilk stok girişinden itibaren gün sonunda stoğun 0 olduğu günleri sayar. Hesap kayıtlı stok hareketlerine dayanır.</p>
      </Panel> : <p className="form-error" role="alert">Gün sayılarını 1–365 arasında tam sayı olarak gir.</p>}
      <Panel title="Bütçeye göre alım listesi">
        <div className="form"><label>Alım bütçesi (₺)<input inputMode="decimal" value={budgetInput} maxLength={13} placeholder="0,00" onChange={event => setBudgetInput(event.target.value)} /></label></div>
        <p className="subtle">Stokta kalmayan ve daha hızlı satılan ürünler önceliklidir. Toptan fiyat girilmediyse son alış maliyeti tahmin olarak kullanılır.</p>
        {budgetInput.trim() && !Number.isFinite(budget) && <p className="form-error" role="alert">Geçerli bir bütçe gir.</p>}
        {plan && <>
          <p><strong>Planlanan {money(budget - plan.remaining)}</strong> · Kalan {money(plan.remaining)}</p>
          {plan.rows.length ? <Table headers={["Ürün", "İhtiyaç", "Planlanan adet", "Tedarikçi", "Birim fiyat", "Tutar"]} rows={plan.rows.map(row => [
            row.name, row.suggestedQuantity, row.selected?.quantity ?? (row.priced ? "Bütçe veya asgari adet yetersiz" : "Maliyet eksik"),
            row.selected?.supplier ?? "—", row.selected ? money(row.selected.unitCost) + (row.usesTier ? "" : " (tahmini)") : "—",
            row.selected ? money(row.selected.total) : "—",
          ])} /> : <Empty>Bu dönemde yenileme önerisi yok.</Empty>}
        </>}
      </Panel>
    </div>
  </>;
}
function BusinessAnalyticsPage({ data }: { data: Shop }) {
  const [view, setView] = useState("pairs");
  const [from, setFrom] = useState(data.summary.month + "-01");
  const [through, setThrough] = useState(today);
  const valid = from !== "" && through !== "" && from <= through;
  const datesNeeded = view === "pairs" || view === "period" || view === "season";
  const pairs = view === "pairs" && valid ? boughtTogether(data, from, through) : [];
  const capital = view === "capital" ? tiedCapital(data, today()) : [];
  const recovery = view === "recovery" ? purchaseRecovery(data) : [];
  const comparing = view === "period" || view === "season";
  const previous = valid ? view === "season" ? { from: lastYear(from), through: lastYear(through) } : previousPeriod(from, through) : null;
  const currentFigures = comparing && valid ? periodSummary(data, from, through) : null;
  const previousFigures = comparing && previous ? periodSummary(data, previous.from, previous.through) : null;
  const percentage = (value: number) => "%" + value.toLocaleString("tr-TR", { maximumFractionDigits: 1 });
  const comparisonMetrics: { key: keyof ReturnType<typeof periodSummary>; label: string; format: (value: number) => string }[] = [
    { key: "orders", label: "Aktif sipariş", format: String }, { key: "quantity", label: "Satılan adet", format: String },
    { key: "gross", label: "Satış toplamı", format: money }, { key: "profit", label: "Net sonuç", format: money },
    { key: "collected", label: "Gelen tahsilat", format: money }, { key: "averageBasket", label: "Ortalama sepet", format: money },
    { key: "lossCost", label: "Hasar/kayıp maliyeti", format: money }, { key: "returns", label: "İade sipariş", format: String },
    { key: "returnRate", label: "İade oranı", format: percentage }, { key: "cancelled", label: "İptal sipariş", format: String },
  ];
  return <>
    <SectionHeader title="İş Analizleri" description="Ürünlerin birlikte satışını, stok yatırımını ve dönem sonuçlarını incele." />
    <div className="stack">
      <div className="form"><label>Analiz<select value={view} onChange={event => setView(event.target.value)}>
        <option value="pairs">Birlikte satılan ürünler</option><option value="capital">Stokta bağlı para</option>
        <option value="recovery">Alımın geri dönüşü</option><option value="period">Dönem karşılaştırması</option><option value="season">Sezon ve özel gün analizi</option>
      </select></label></div>
      {view === "season" && <div className="form"><label>Hazır dönem<select defaultValue="" onChange={event => {
        if (!event.target.value) return;
        const [start, end] = event.target.value.split("/");
        const year = today().slice(0, 4);
        setFrom(year + "-" + start);
        setThrough(year + "-" + end);
      }}>
        <option value="">Tarihleri kendin seç</option><option value="02-07/02-14">Sevgililer Günü haftası</option>
        <option value="04-16/04-23">23 Nisan haftası</option><option value="09-01/09-30">Okula dönüş</option>
        <option value="12-15/12-31">Yılbaşı dönemi</option>
      </select></label></div>}
      {datesNeeded && <div className="form form-row">
        <label>Başlangıç<input type="date" min="1900-01-01" value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label>Bitiş<input type="date" min="1900-01-01" value={through} onChange={event => setThrough(event.target.value)} /></label>
      </div>}
      {datesNeeded && !valid ? <p className="form-error" role="alert">Geçerli bir başlangıç ve bitiş tarihi seç.</p> : <>
        {view === "pairs" && <Panel title="Birlikte satılan ürünler">
          <p className="subtle">Her ürün çifti aynı siparişte bir kez sayılır. Oran, dönemdeki aktif siparişler içindeki payıdır.</p>
          {pairs.length ? <Table headers={["İlk ürün", "Birlikte alınan ürün", "Sipariş sayısı", "Siparişlerdeki pay"]}
            rows={pairs.map(pair => [pair.firstName, pair.secondName, pair.orders, percentage(pair.share)])} />
            : <Empty>Bu dönemde birlikte satılmış farklı ürün yok.</Empty>}
        </Panel>}
        {view === "capital" && <Panel title="Stokta bağlı para" meta={<strong>{money(capital.reduce((sum, row) => sum + row.value, 0))}</strong>}>
          <p className="subtle">Bugünkü kalan adetler alış maliyetleriyle değerlenir. Ödenmiş stok kısmı {money(capital.reduce((sum, row) => sum + row.paidValue, 0))}.</p>
          {capital.length ? <>
            <ChartBars values={capital.slice(0, 8).map(row => ({ label: row.name, value: row.value }))} format={money} />
            <Table headers={["Ürün", "Kalan adet", "Bağlı maliyet", "Ödenmiş kısmı", "En eski stok"]}
              rows={capital.map(row => [row.name, row.quantity, money(row.value), money(row.paidValue), row.days + " gün"])} />
          </> : <Empty>Stokta bekleyen ürün yok.</Empty>}
        </Panel>}
        {view === "recovery" && <Panel title="Alımın geri dönüşü">
          <p className="subtle">Tüm kayıtlı satışlarda geri dönen net tahsilat, alımların ödenen tutarıyla karşılaştırılır. Ayrı girilen kargo ve paketleme tahsilattan düşülür. Sipariş tutarı ürünlere satış değerleri oranında dağıtılır.</p>
          {recovery.length ? <Table headers={["Alım", "Toplam maliyet", "Ödenen", "Satılan adet", "Geri dönen net", "Geri dönüş", "Kalan geri dönüş hedefi", "Stoktaki maliyet", "Hasar/kayıp"]}
            rows={recovery.map(row => [row.name, money(row.total), money(row.paid), row.soldQuantity, money(row.collectedNet),
              row.recoveryRate === null ? "Ödeme bekliyor" : percentage(row.recoveryRate), money(row.remainingToRecover), money(row.remainingStock), money(row.lossCost)])} />
            : <Empty>Henüz stok alımı yok.</Empty>}
        </Panel>}
        {comparing && currentFigures && previousFigures && previous && <Panel title={view === "season" ? "Sezon ve özel gün analizi" : "Dönem karşılaştırması"}>
          <p>{dateLabel(from)} – {dateLabel(through)}</p>
          <p className="subtle">{view === "season" ? "Geçen yıl aynı tarihler" : "Önceki eşit uzunluktaki dönem"} {dateLabel(previous.from)} – {dateLabel(previous.through)}. Net sonuç hasar/kayıp maliyetini içerir.</p>
          <div className="period-comparison"><Table headers={["Ölçüm", "Seçilen dönem", view === "season" ? "Geçen yıl" : "Önceki dönem", "Fark", "Değişim"]}
            rows={comparisonMetrics.map(metric => {
              const current = currentFigures[metric.key];
              const before = previousFigures[metric.key];
              const difference = current - before;
              const change = metric.key === "returnRate" ? difference.toLocaleString("tr-TR", { maximumFractionDigits: 1 }) + " puan"
                : before === 0 ? current === 0 ? "—" : "Yeni" : percentage(difference / Math.abs(before) * 100);
              return [metric.label, metric.format(current), metric.format(before), (difference > 0 ? "+" : "") + metric.format(difference), change];
            })} /></div>
        </Panel>}
      </>}
    </div>
  </>;
}
function ProductHistory({ product, data }: { product: Product; data: Shop }) {
  const history = (data.productHistory ?? []).filter(entry => entry.productId === product.id);
  const prices = history.filter(entry => entry.kind === "price");
  const costs = history.filter(entry => entry.kind === "cost");
  const sales = data.orders.filter(order => order.status === "pending" || order.status === "packed").flatMap(order =>
    order.lines.filter(line => line.productId === product.id).map(line => ({ order, line })));
  return <div className="stack">
    <p>{product.name}</p>
    <p className="subtle">Geçmiş mevcut değerlerden başlar. Yeni fiyat değişiklikleri ve alım maliyetleri bundan sonra kaydedilir. Başlangıç kayıtları geçişteki değerleri gösterir.</p>
    <Panel title="Liste fiyatı geçmişi">
      {prices.length ? <>
        <ChartBars values={prices.slice(0, 6).reverse().flatMap(entry => [
          { label: dateLabel(entry.date) + " · Dolap", value: entry.dolapPrice ?? 0 },
          { label: dateLabel(entry.date) + " · Gardrops", value: entry.gardropsPrice ?? 0 },
        ])} format={money} />
        <Table headers={["Tarih", "Dolap", "Gardrops", "Kayıt"]} rows={prices.map(entry => [
          dateLabel(entry.date), money(entry.dolapPrice ?? 0), money(entry.gardropsPrice ?? 0), entry.source === "baseline" ? "Başlangıç" : "Kaydedildi",
        ])} />
      </> : <Empty>Fiyat geçmişi henüz oluşmadı.</Empty>}
    </Panel>
    <Panel title="Alış maliyeti geçmişi">
      {costs.length ? <Table headers={["Tarih", "Alım", "Adet", "Birim maliyet", "Kayıt"]} rows={costs.map(entry => [
        dateLabel(entry.date), data.purchases.find(purchase => purchase.id === entry.purchaseId)?.name ?? "—",
        entry.quantity, money(entry.unitCost ?? 0), entry.source === "baseline" ? "Başlangıç" : "Kaydedildi",
      ])} /> : <Empty>Henüz alış maliyeti kaydı yok.</Empty>}
    </Panel>
    <Panel title="Anlaşılan satış fiyatları">
      {sales.length ? <Table headers={["Tarih", "Platform", "Adet", "Birim satış fiyatı"]} rows={sales.map(({ order, line }) => [
        dateLabel(order.date), order.platform, line.quantity, money(line.agreedPrice),
      ])} /> : <Empty>Henüz aktif satış kaydı yok.</Empty>}
    </Panel>
  </div>;
}
function PackagingPage({ data, open }: { data: Shop; open: (editor: Editor) => void }) {
  const materials = data.packagingMaterials ?? [];
  const movements = data.packagingMovements ?? [];
  return <>
    <SectionHeader title="Ambalaj Stoku" description="Kutu, sticker, kart ve diğer paketleme malzemelerini takip et.">
      <AddButton primary onClick={() => open({ type: "packaging-material" })}>Malzeme Ekle</AddButton>
    </SectionHeader>
    <div className="stack">
      <Panel title="Malzemeler">
        <p className="subtle">Sipariş Paketlendi olunca tanımladığın kullanım adedi otomatik düşülür. Malzeme alımının parasal giderini Kasa ve Giderler ekranına kaydedebilirsin.</p>
        {materials.length ? <Table headers={["Malzeme", "Eldeki adet", "Sipariş başına", "Stok durumu", "İşlemler"]}
          rows={materials.map(material => [material.name, material.quantity, material.perOrder,
            <span key={"status" + material.id} className={"pill " + (material.quantity <= material.lowThreshold ? "warning" : "ok")}>{material.quantity <= material.lowThreshold ? "Azaldı" : "Yeterli"}</span>,
            <div className="actions" key={material.id}>
              <button onClick={() => open({ type: "packaging-move", material })}>Stok giriş / çıkış</button>
              <button onClick={() => open({ type: "packaging-material", material })}>Düzenle</button>
            </div>])} /> : <Empty>İlk ambalaj malzemesini ekleyerek başla.</Empty>}
      </Panel>
      <Panel title="Malzeme hareketleri">
        {movements.length ? <Table headers={["Tarih", "Malzeme", "Adet", "Sipariş", "Not"]}
          rows={movements.map(movement => [dateLabel(movement.date), materials.find(material => material.id === movement.materialId)?.name ?? "—",
            (movement.quantity > 0 ? "+" : "") + movement.quantity, movement.orderId ? "#" + movement.orderId : "—", movement.note || "—"])} />
          : <Empty>Henüz malzeme hareketi yok.</Empty>}
      </Panel>
    </div>
  </>;
}
function SettingsPage({ shop, open }: { shop: Shop; open: (editor: Editor) => void }) {
  const amount = defaultPacking(shop);
  return <>
    <SectionHeader title="Ayarlar" description="Yeni satışlarda kullanılacak ortak varsayılanları yönet." />
    <Panel title="Sipariş başına paketleme" meta={<strong>{money(amount)}</strong>}>
      <p>Kutu, ambalaj, sticker ve kart için ortalama toplam tutar. Her satışta değiştirebilirsin.</p>
      <div className="actions"><button onClick={() => open({ type: "settings", defaultPacking: amount })}>Düzenle</button></div>
    </Panel>
    <Panel title="Paylaşılabilir ürün kataloğu" meta={<span>{shop.catalogKey ? "Açık" : "Kapalı"}</span>}>
      <p>Bağlantıyı alan kişiler stoktaki ürünleri, fotoğrafları ve iki platformdaki liste fiyatlarını görebilir.</p>
      <div className="actions"><button onClick={() => open({ type: "catalog-settings" })}>Kataloğu yönet</button></div>
    </Panel>
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
function paymentPayload(data: FormData, total: number, users: Member[], dateName = "paymentDate") {
  const date = field(data, dateName);
  if (!data.has("sharedPayment")) return { date, payerId: Number(field(data, "payerId")) };
  const [first, second] = [...users].sort((a, b) => a.id - b.id);
  const firstAmount = requiredMoney(field(data, "firstPayment"));
  if (firstAmount < 0 || firstAmount > total) throw new Error("Ödeme tutarı alım toplamını aşamaz.");
  return { date, payments: [{ payerId: first.id, amount: firstAmount }, { payerId: second.id, amount: total - firstAmount }].filter(payment => payment.amount > 0) };
}
function PaymentFields({ users, total, defaultId, purchase }: { users: Member[]; total: number; defaultId: number; purchase?: Purchase }) {
  const [first, second] = [...users].sort((a, b) => a.id - b.id);
  const [shared, setShared] = useState((purchase?.payments?.length ?? 0) > 1);
  const [firstAmount, setFirstAmount] = useState<string | null>(purchase?.payments?.length
    ? moneyInput(purchase.payments.find(payment => payment.payerId === first.id)?.amount ?? 0) : null);
  const value = firstAmount ?? moneyInput(Math.floor(total / 2));
  const remaining = total - toMoney(value);
  return <fieldset className="line-editor">
    <legend>Alım ödemesi</legend>
    <DateField label="Ödeme tarihi" name="paymentDate" value={purchase?.paymentDate ?? undefined} />
    <label className="check"><input name="sharedPayment" type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} />İki ortak birlikte ödedi</label>
    {shared ? <div className="form-row">
      <label>{first.name} ödedi (₺)<input name="firstPayment" inputMode="decimal" value={value} onChange={event => setFirstAmount(event.target.value)} maxLength={13} required /></label>
      <label>{second.name} ödedi (₺)<input value={Number.isFinite(remaining) ? moneyInput(remaining) : ""} readOnly /></label>
    </div> : <MemberField label="Ödeyen" users={users} defaultId={purchase?.payerId ?? defaultId} />}
    {shared && remaining < 0 && <p className="form-error">Ödeme alım toplamını aşamaz.</p>}
  </fieldset>;
}
function shareLabel(users: Member[], share: number) {
  const [first, second] = [...users].sort((a, b) => a.id - b.id);
  return first.name + " %" + share + " · " + second.name + " %" + (100 - share);
}
function ShareField({ users, value, required = false, name = "firstPartnerShare", onChange }: {
  users: Member[]; value?: number | null; required?: boolean; name?: string; onChange?: (share: string) => void;
}) {
  const [first, second] = [...users].sort((a, b) => a.id - b.id);
  const [share, setShare] = useState(value == null ? "" : String(value));
  const valid = share !== "" && Number.isInteger(Number(share)) && Number(share) >= 0 && Number(share) <= 100;
  return <fieldset className="line-editor">
    <legend>Ortaklık payı</legend>
    <div className="form-row">
      <label>{first.name} payı (%)<input name={name} type="number" inputMode="numeric" min={0} max={100} step={1}
        value={share} onChange={event => { setShare(event.target.value); onChange?.(event.target.value); }} required={required} /></label>
      <label>{second.name} payı (%)<input value={valid ? 100 - Number(share) : ""} readOnly /></label>
    </div>
  </fieldset>;
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
type DraftLine = { id: number; productId: string; quantity: string; priceOverride: string | null;
  firstPartnerShare?: string; lotId?: string; original?: Purchase["lines"][number] };
function SaleCostPayer({ label, name, users, payerId }: { label: string; name: string; users: Member[]; payerId?: number | null }) {
  return <label>{label}<select name={name} defaultValue={payerId ?? ""}>
    <option value="">Kasaya ayrı masraf yazma</option>
    {users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
  </select></label>;
}

function WholesaleForm({ editor, shop, busy, save }: {
  editor: Extract<Editor, { type: "wholesale-price" | "wholesale-price-delete" }>; shop: Shop; busy: boolean; save: Save;
}) {
  const price = editor.price;
  if (editor.type === "wholesale-price-delete") return <form className="form" onSubmit={event => save(event, editor.type, () => editor.price)}>
    <p>{shop.products.find(product => product.id === editor.price.productId)?.name} · {editor.price.supplier} · en az {editor.price.minimumQuantity} adet</p>
    <SaveButton busy={busy}>Kademeyi sil</SaveButton>
  </form>;
  return <form className="form" onSubmit={event => save(event, editor.type, data => ({
    productId: price?.productId ?? Number(field(data, "productId")), supplier: price?.supplier ?? field(data, "supplier"),
    minimumQuantity: price?.minimumQuantity ?? Number(field(data, "minimumQuantity")), unitCost: requiredMoney(field(data, "unitCost")),
  }))}>
    {price ? <p>{shop.products.find(product => product.id === price.productId)?.name} · {price.supplier} · en az {price.minimumQuantity} adet</p> : <>
      <label>Ürün<select name="productId" required defaultValue=""><option value="">Ürün seç</option>{shop.products.map(product =>
        <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
      <label>Tedarikçi<input name="supplier" list="tier-suppliers" maxLength={120} required /></label>
      <datalist id="tier-suppliers">{[...new Set([...supplierStats(shop.purchases).map(row => row.name), ...(shop.wholesalePrices ?? []).map(row => row.supplier)])]
        .map(name => <option key={name} value={name} />)}</datalist>
      <label>En az adet<input name="minimumQuantity" type="number" min={1} max={100000} required /></label>
    </>}
    <AmountField name="unitCost" label="Birim fiyat (₺)" value={price ? moneyInput(price.unitCost) : undefined} />
    <SaveButton busy={busy} />
  </form>;
}

function CatalogSettings({ shop, busy, save }: { shop: Shop; busy: boolean; save: Save }) {
  const [copied, setCopied] = useState(false);
  const path = shop.catalogKey ? "/catalog?key=" + shop.catalogKey : "";
  const link = path ? window.location.origin + path : "";
  return <div className="stack">
    {link && <div className="form">
      <label>Katalog bağlantısı<input value={link} readOnly onFocus={event => event.currentTarget.select()} /></label>
      <div className="actions">
        <button type="button" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true), () => setCopied(false))}>{copied ? "Kopyalandı" : "Bağlantıyı kopyala"}</button>
        <a href={path} target="_blank" rel="noreferrer">Kataloğu aç</a>
      </div>
    </div>}
    <form className="form" onSubmit={event => {
      const enabled = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") !== "disable";
      save(event, "catalog-settings", () => ({ enabled }));
    }}>
      {link && <p className="subtle">Kataloğu kapatmak veya bağlantıyı yenilemek eski bağlantının erişimini kaldırır.</p>}
      <div className="actions">
        <button type="submit" disabled={busy}>{link ? "Yeni bağlantı oluştur" : "Kataloğu aç ve bağlantı oluştur"}</button>
        {link && <button type="submit" value="disable" className="danger" disabled={busy}>Kataloğu kapat</button>}
      </div>
    </form>
  </div>;
}

function LinesForm({ mode, purchaseToEdit, orderToEdit, openingStock = false, shop, user, busy, save, addProduct }: {
  mode: "purchase" | "order"; openingStock?: boolean; purchaseToEdit?: Purchase; orderToEdit?: Order; shop: Shop; user: Member; busy: boolean; save: Save; addProduct: () => void;
}) {
  const purchase = mode === "purchase";
  const opening = openingStock || purchaseToEdit?.openingPayerId != null;
  const products = shop.products.filter(product => purchase || product.stock > 0 || orderToEdit?.lines.some(line => line.productId === product.id));
  const [lines, setLines] = useState<DraftLine[]>(() => {
    if (purchaseToEdit) return purchaseToEdit.lines.map((line, index) => ({
      id: index + 1, productId: String(line.productId), quantity: String(line.quantity), priceOverride: moneyInput(line.unitCost), original: line,
      firstPartnerShare: line.firstPartnerShare == null ? "" : String(line.firstPartnerShare),
    }));
    if (orderToEdit) return orderProducts(orderToEdit).map((line, index) => ({
      id: index + 1, productId: String(line.productId), quantity: String(line.quantity),
      priceOverride: moneyInput(Math.floor(orderToEdit.lines.filter(original => original.productId === line.productId)
        .reduce((sum, original) => sum + original.quantity * original.agreedPrice, 0) / line.quantity)),
    }));
    return [{ id: 1, productId: "", quantity: "1", priceOverride: null }];
  });
  const nextLineId = useRef(lines.length + 1);
  const [platform, setPlatform] = useState<Platform>(orderToEdit?.platform ?? "Dolap");
  const [total, setTotal] = useState("");
  const [saleTotal, setSaleTotal] = useState(orderToEdit ? moneyInput(orderToEdit.gross) : "");
  const [netAfterShipping, setNetAfterShipping] = useState(orderToEdit?.netAfterShipping == null ? "" : moneyInput(orderToEdit.netAfterShipping));
  const [fee, setFee] = useState(orderToEdit ? moneyInput(orderToEdit.platformFee) : "0");
  const [shipping, setShipping] = useState(orderToEdit ? moneyInput(orderToEdit.shipping) : "0");
  const [shippingPayer, setShippingPayer] = useState(String(orderToEdit?.shippingPayerId ?? ""));
  const [packing, setPacking] = useState(() => moneyInput(orderToEdit?.packing ?? defaultPacking(shop)));
  const [paid, setPaid] = useState(false);
  const usesSaleTotal = !purchase && saleTotal.trim() !== "";
  const usesNet = netAfterShipping.trim() !== "";
  const canAddLine = purchaseToEdit
    ? lines.length < 100 && lines.every(line => line.productId) && products.some(product => !lines.some(line => line.productId === String(product.id)))
    : lines.length < products.length;
  function updateLine(id: number, change: Partial<DraftLine>) {
    setLines(active => active.map(line => line.id === id ? { ...line, ...change } : line));
  }
  const rows = lines.map(line => {
    const product = products.find(product => product.id === Number(line.productId));
    const originalPrice = orderToEdit?.platform === platform
      ? orderToEdit.lines.find(original => original.productId === Number(line.productId))?.listPrice : undefined;
    const listPrice = originalPrice ?? (platform === "Dolap" ? product?.dolapListPrice : product?.gardropsListPrice);
    const price = line.priceOverride ?? (!purchase && listPrice !== undefined ? moneyInput(listPrice) : "");
    return { line, product, listPrice, price };
  });
  const sum = rows.reduce((amount, { line, price }) => amount + Number(line.quantity) * (toMoney(price) || 0), 0);
  const listTotal = rows.reduce((amount, { line, listPrice }) => amount + Number(line.quantity) * (listPrice ?? 0), 0);
  const gross = usesSaleTotal ? toMoney(saleTotal) : sum;
  const discount = usesSaleTotal ? Math.max(0, listTotal - gross) : rows.reduce((amount, { line, listPrice, price }) =>
    amount + Number(line.quantity) * Math.max(0, (listPrice ?? 0) - (toMoney(price) || 0)), 0);
  const net = usesNet ? toMoney(netAfterShipping, true) : gross - toMoney(fee) - toMoney(shipping);
  const afterPacking = net - toMoney(packing);
  const expectedReceipt = usesNet ? net + (shippingPayer ? toMoney(shipping) : 0) : gross - toMoney(fee);
  const totalDifference = toMoney(total) - sum;
  if (!products.length) return <div className="stack">
    <Empty>{purchase ? "Stok alımı kaydetmek için önce bir ürün ekle." : "Satış eklemek için stokta en az bir ürün olmalı."}</Empty>
    {purchase && <div className="actions"><AddButton primary onClick={addProduct}>Ürün Ekle</AddButton></div>}
  </div>;
  return <form className="form" onSubmit={event => save(event, purchaseToEdit ? "purchase-edit" : orderToEdit ? "order-edit" : mode, data => {
    const date = field(data, "date");
    const baseLines = rows.map(({ line, price }) => ({ productId: Number(line.productId), quantity: Number(line.quantity),
      price: usesSaleTotal ? undefined : requiredMoney(price) }));
    if (purchase) {
      const name = field(data, "name");
      const rejected = field(data, "rejectedUnits");
      const purchaseDetails = { supplier: field(data, "supplier"), orderedOn: field(data, "orderedOn") || null,
        rejectedUnits: rejected === "" ? null : Number(rejected),
        openingPayerId: field(data, "openingPayerId") ? Number(field(data, "openingPayerId")) : undefined };
      if (purchaseToEdit) return {
        id: purchaseToEdit.id, revision: purchaseToEdit.revision, name, date, total: sum, ...purchaseDetails,
        lines: baseLines.map(({ price, ...line }, index) => ({ ...line, unitCost: price, lotId: lines[index].original?.lotId,
        firstPartnerShare: Number(lines[index].firstPartnerShare) })),
      };
      const amount = opening ? sum : requiredMoney(total);
      if (amount !== sum) throw new Error("Kutu toplamı, ürün satırlarının toplamıyla eşleşmeli.");
      return {
        name, date, total: amount, ...purchaseDetails,
        lines: baseLines.map(({ price, ...line }, index) => ({ ...line, unitCost: price, firstPartnerShare: Number(lines[index].firstPartnerShare) })),
        payment: paid ? paymentPayload(data, sum, shop.users) : undefined,
      };
    }
    return {
      id: orderToEdit?.id, revision: orderToEdit?.revision,
      platform, date, reference: field(data, "reference").trim() || undefined,
      lines: baseLines.map(({ price, ...line }, index) => ({ ...line, agreedPrice: price, lotId: lines[index].lotId ? Number(lines[index].lotId) : undefined })),
      saleTotal: usesSaleTotal ? requiredMoney(saleTotal) : undefined,
      netAfterShipping: usesNet ? requiredMoney(netAfterShipping, true) : undefined,
      platformFee: usesNet ? undefined : requiredMoney(fee), shipping: !usesNet || shippingPayer ? requiredMoney(shipping) : undefined,
      packing: requiredMoney(packing),
      shippingPayerId: shippingPayer ? Number(shippingPayer) : null,
      packingPayerId: field(data, "packingPayerId") ? Number(field(data, "packingPayerId")) : null,
    };
  })}>
    <div className="form-row">
      {purchase ? <label>Kutu adı<input name="name" defaultValue={purchaseToEdit?.name} maxLength={120} required /></label> : <label>Platform<select name="platform" value={platform} onChange={event => setPlatform(event.target.value as Platform)}><option>Dolap</option><option>Gardrops</option></select></label>}
      <DateField label={purchase ? opening ? "Stok başlangıç tarihi" : "Teslim / alım tarihi" : "Satış tarihi"} value={purchaseToEdit?.date ?? orderToEdit?.date} />
    </div>
    {opening && <div className="stack">
      <MemberField label="Alımı daha önce ödeyen ortak" name="openingPayerId" users={shop.users} defaultId={purchaseToEdit?.openingPayerId ?? user.id} />
      <p className="subtle">Alış maliyeti satış kârında ve ortak hesabında kullanılır. Kasaya yeni gider eklenmez.</p>
    </div>}
    {purchase && <details className="purchase-details" open={purchaseToEdit?.supplier || purchaseToEdit?.orderedOn || purchaseToEdit?.rejectedUnits != null ? true : undefined}>
      <summary>Tedarik ve kalite bilgileri</summary>
      <label>Tedarikçi<input name="supplier" list="purchase-suppliers" maxLength={120} defaultValue={purchaseToEdit?.supplier ?? ""} /></label>
      <datalist id="purchase-suppliers">{supplierStats(shop.purchases).map(supplier => <option key={supplier.name} value={supplier.name} />)}</datalist>
      <div className="form-row">
        <label>Tedarikçiye sipariş tarihi<input type="date" min="1900-01-01" name="orderedOn" defaultValue={purchaseToEdit?.orderedOn ?? ""} /></label>
        <label>Stoğa alınmayan kusurlu adet<input type="number" min={0} max={100000} name="rejectedUnits" defaultValue={purchaseToEdit?.rejectedUnits ?? ""} /></label>
      </div>
      <p className="subtle">Kalite kontrolü yapıldıysa kusur yokken 0 gir. Ürün satırlarına stoğa aldığın adetleri yaz.</p>
    </details>}
    {!purchase && <label>Sipariş numarası veya referans (isteğe bağlı)<input name="reference" defaultValue={orderToEdit?.reference ?? ""} maxLength={100} /></label>}
    {orderToEdit?.receiptDate && <p className="subtle">Kayıtlı tahsilat {money(orderToEdit.receiptAmount ?? 0)}. Tahsilatı Kasa ve Giderler ekranından düzenleyebilirsin.</p>}
    {rows.map(({ line, product, listPrice, price }, index) => (
      <fieldset className="line-editor" key={line.id}>
        <legend>Ürün {index + 1}</legend>
        <label>Ürün seç<select value={line.productId} disabled={line.original?.hasSalesHistory} onChange={event => {
          const productId = event.target.value;
          updateLine(line.id, line.original ? { productId } : { productId, quantity: "1", priceOverride: null, lotId: "" });
        }} required>
          <option value="">Ürün seç</option>
          {products.filter(product => line.productId === String(product.id) || !lines.some(other => other.id !== line.id && other.productId === String(product.id))).map(product => <option key={product.id} value={product.id}>{product.name}{purchase ? "" : " · " + product.stock + " adet"}</option>)}
        </select></label>
        <div className="form-row">
          <label>{purchaseToEdit ? "Alınan adet" : "Adet"}<input type="number" min={Math.max(1, line.original?.usedQuantity ?? 0)} max={purchase ? 100000 : (product?.stock ?? 0) + (orderToEdit?.lines.filter(original => original.productId === product?.id).reduce((sum, original) => sum + original.quantity, 0) ?? 0)} inputMode="numeric" step={1} value={line.quantity} onChange={event => updateLine(line.id, { quantity: event.target.value })} required /></label>
          {!usesSaleTotal && <label>{purchase ? "Birim maliyet (₺)" : "Anlaşılan birim fiyat (₺)"}<input inputMode="decimal" value={price} readOnly={line.original?.hasSalesHistory} onChange={event => updateLine(line.id, { priceOverride: event.target.value })} maxLength={13} placeholder="0,00" required /></label>}
        </div>
        {purchase && <ShareField users={shop.users} name={"share-" + line.id} value={line.original?.firstPartnerShare} required
          onChange={share => updateLine(line.id, { firstPartnerShare: share })} />}
        {purchase && <p className="subtle">Bu alımdaki ürünlerin kâr payı. %100 ve %0 ile tek ortağa ait stok girebilirsin.</p>}
        {line.original?.hasSalesHistory && <p className="subtle">Satış veya hasar/kayıp kayıtlarında kullanılan {line.original.usedQuantity} adet · Ürün ve birim maliyet işlem geçmişi nedeniyle sabit.</p>}
        {!purchase && product && <label>Stok partisi<select value={line.lotId ?? ""} onChange={event => updateLine(line.id, { lotId: event.target.value })}>
          <option value="">{orderToEdit ? "Otomatik · mevcut partileri önceliklendir" : "Otomatik · önce en eski parti"}</option>
          {shop.purchases.flatMap(batch => batch.lines.filter(item => item.productId === product.id).map(item => {
            const available = item.quantity - item.usedQuantity + (orderToEdit?.lines.filter(current => current.lotId === item.lotId)
              .reduce((sum, current) => sum + current.quantity, 0) ?? 0);
            return available > 0 ? <option key={item.lotId} value={item.lotId}>{batch.name} · {dateLabel(batch.date)} · {available} adet · {money(item.unitCost)} / adet{item.firstPartnerShare != null ? " · " + shareLabel(shop.users, item.firstPartnerShare) : ""}</option> : null;
          }))}
        </select></label>}
        {!purchase && listPrice !== undefined && <p className="subtle">{platform} liste fiyatı {money(listPrice)}</p>}
        {lines.length > 1 && !line.original?.hasSalesHistory && <div className="actions"><button className="danger" type="button" onClick={() => setLines(active => active.filter(other => other.id !== line.id))}>Satırı kaldır</button></div>}
      </fieldset>
    ))}
    {canAddLine && <div className="actions"><button type="button" onClick={() => {
      const id = nextLineId.current++;
      setLines(active => [...active, { id, productId: "", quantity: "1", priceOverride: null }]);
    }}><Plus className="icon" aria-hidden="true" />Bir ürün daha ekle</button></div>}
    {purchaseToEdit ? <div className="form-totals" aria-live="polite">
      <div className="inline"><span>Alım toplamı</span><strong>{money(sum)}</strong></div>
      {purchaseToEdit.paymentDate && <p className="subtle">Bu alımın kasadaki ödeme tutarı da güncellenir.</p>}
    </div> : purchase ? <>
      {!opening && <label>Faturadaki kutu toplamı (₺)<input inputMode="decimal" value={total} onChange={event => setTotal(event.target.value)} maxLength={13} placeholder="0,00" required /></label>}
      <div className="form-totals" aria-live="polite"><div className="inline"><span>Satır toplamı</span><strong>{money(sum)}</strong></div>
        {!opening && Number.isFinite(totalDifference) && <div className="inline"><span>{totalDifference ? "Fark" : "Kutu toplamı eşleşiyor"}</span>{totalDifference ? <strong className="danger">{money(totalDifference)}</strong> : <Check className="icon" aria-hidden="true" />}</div>}
      </div>
      {!opening && <label className="check"><input type="checkbox" checked={paid} onChange={event => setPaid(event.target.checked)} />Ödeme yapıldı</label>}
      {!opening && paid && <PaymentFields users={shop.users} total={sum} defaultId={user.id} />}
    </> : <>
      <div className="form-row">
        <label>Toplam satış tutarı (₺)<input inputMode="decimal" maxLength={13} value={saleTotal} onChange={event => setSaleTotal(event.target.value)} placeholder={moneyInput(sum)} /></label>
        <label>Kargo ve kesinti sonrası net (₺)<input inputMode="decimal" maxLength={13} value={netAfterShipping} onChange={event => setNetAfterShipping(event.target.value)} placeholder="0,00" /></label>
      </div>
      <p className="subtle">Teklifin toplamını yazabilir veya ürün fiyatlarıyla devam etmek için alanı boş bırakabilirsin. Net tutarı paketleme düşmeden gir.</p>
      <details className="purchase-details" open={orderToEdit?.shippingPayerId ? true : undefined}>
        <summary>{usesNet ? "Cepten ödenen kargoyu kaydet" : "Platform kesintisini ve kargoyu ayrı gir"}</summary>
        <div className="form-row">
          {!usesNet && <label>Platform kesintisi (₺)<input inputMode="decimal" maxLength={13} value={fee} onChange={event => setFee(event.target.value)} /></label>}
          {(!usesNet || shippingPayer) && <label>Ödediğimiz kargo (₺)<input inputMode="decimal" maxLength={13} value={shipping} onChange={event => setShipping(event.target.value)} /></label>}
        </div>
        <label>Kargoyu cebinden ödeyen<select value={shippingPayer} onChange={event => setShippingPayer(event.target.value)}>
          <option value="">Kasaya ayrı masraf yazma</option>
          {shop.users.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select></label>
        {usesNet && shippingPayer && <p className="subtle">Cepten ödenen kargoyu net tutardan düşülmüş olarak gir. Bankaya beklenen ödeme bu kargo kadar artar.</p>}
      </details>
      <label>Paketleme maliyeti (₺)<input inputMode="decimal" maxLength={13} value={packing} onChange={event => setPacking(event.target.value)} required /></label>
      <SaleCostPayer label="Paketlemeyi cebinden ödeyen" name="packingPayerId" users={shop.users} payerId={orderToEdit?.packingPayerId} />
      <p className="subtle">Ortak seçtiğin tutarlar kasaya satış masrafı olarak işlenir. Önceden gider olarak girdiğin ambalaj için boş bırak.</p>
      <div className="form-totals" aria-live="polite">
        <div className="inline"><span>Liste toplamı</span><strong>{money(listTotal)}</strong></div>
        <div className="inline"><span>Brüt satış</span><strong>{Number.isFinite(gross) ? money(gross) : "—"}</strong></div>
        <div className="inline"><span>İndirim</span><strong>{Number.isFinite(discount) ? money(discount) : "—"}</strong></div>
        {(!usesNet || shippingPayer) && <div className="inline"><span>Platformdan beklenen ödeme</span><strong>{Number.isFinite(expectedReceipt) ? money(expectedReceipt) : "—"}</strong></div>}
        <div className="inline"><span>Kargo ve kesinti sonrası net</span><strong>{Number.isFinite(net) ? money(net) : "—"}</strong></div>
        <div className="inline"><span>Paketleme sonrası kalan</span><strong>{Number.isFinite(afterPacking) ? money(afterPacking) : "—"}</strong></div>
      </div>
    </>}
    <SaveButton busy={busy}>{purchaseToEdit || orderToEdit ? "Değişiklikleri kaydet" : purchase ? "Stok alımını kaydet" : "Satışı kaydet"}</SaveButton>
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
    "order-share": "Eksik pay oranı kaydedildi",
    "order-edit": "Satış düzenlendi",
  };
  const history = audit.filter(item => item.entityId === order.id && Object.hasOwn(actions, item.action));
  const shares = new Map(order.lines.map(line => [line.lotId + ":" + line.firstPartnerShare, line]));
  const net = order.netAfterShipping ?? (order.gross - order.platformFee - order.shipping);
  const deductions: [string, number][] = order.netAfterShipping == null
    ? [["Platform kesintisi", order.platformFee], ["Ödediğimiz kargo", order.shipping], ["Platformdan beklenen ödeme", order.expectedReceipt]]
    : [["Kargo ve platform kesintisi toplamı", order.gross - net]];
  if (order.netAfterShipping != null && order.shippingPayerId != null) {
    deductions.push(["Cepten ödenen kargo (toplama dahil)", order.shipping], ["Platformdan beklenen ödeme", order.expectedReceipt]);
  }
  const amounts: [string, number][] = [
    ["Brüt satış", order.gross], ["İndirim", order.discount],
    ...deductions,
    ["Kargo ve kesinti sonrası net", net], ["Paketleme", order.packing], ["Paketleme sonrası kalan", net - order.packing],
    ["Toplam stok maliyeti", order.cost], ["Sipariş kârı", order.profit],
  ];
  return <div className="stack">
    <div className="inline"><p>{order.platform} · {order.reference || "#" + order.id} · {dateLabel(order.date)}</p><span className="pill">{statusLabel[order.status]}</span></div>
    <Table headers={["Ürün", "Adet", "Liste fiyatı", "Satış fiyatı", "Stok maliyeti"]} rows={order.lines.map(line => [line.productName, line.quantity, money(line.listPrice), money(line.agreedPrice), money(line.cost ?? line.unitCost * line.quantity)])} />
    <Table headers={["Ürün / Stok alımı", "Satıştaki ortaklık payı"]} rows={[...shares.values()].map(line => [
      line.productName + " · #" + line.purchaseId,
      line.firstPartnerShare == null
        ? <button key={line.lotId} onClick={() => open({ type: "order-share", order, productId: line.productId, lotId: line.lotId, productName: line.productName })}>Pay oranını gir</button>
        : shareLabel(users, line.firstPartnerShare),
    ])} />
    <div className="form-totals">
      {amounts.map(([label, value]) => <div className="inline" key={label}><span>{label}</span><strong>{money(value)}</strong></div>)}
    </div>
    <p className="subtle">Ekleyen {getMember(users, order.actorId)}</p>
    {order.shippingPayerId != null && <p>Kargoyu ödeyen {getMember(users, order.shippingPayerId)}</p>}
    {order.packingPayerId != null && <p>Paketlemeyi ödeyen {getMember(users, order.packingPayerId)}</p>}
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
    case "product-history": return "Fiyat ve maliyet geçmişi";
    case "purchase": return "Stok alımı ekle";
    case "opening-stock": return "Açılış stoğu ekle";
    case "wholesale-price": return editor.price ? "Fiyat kademesini düzenle" : "Toptan fiyat kademesi ekle";
    case "wholesale-price-delete": return "Fiyat kademesini sil";
    case "catalog-settings": return "Ürün kataloğu";
    case "undo": return "Son işlemi geri al";
    case "purchase-edit": return "Stok alımını düzenle";
    case "order": return "Satış ekle";
    case "order-edit": return "Satışı düzenle";
    case "order-delete": return "Satışı sil";
    case "expense": return editor.expense ? "Gideri düzenle" : "Gider ekle";
    case "cash-payment-edit": return editor.payment.kind === "receipt" ? "Tahsilatı düzenle" : "Stok ödemesini düzenle";
    case "cash-delete": return "Kasa kaydını sil";
    case "purchase-payment": return editor.purchase.paymentDate ? "Stok ödemesini düzenle" : "Stok ödemesini kaydet";
    case "stock-loss": return "Hasar veya kayıp kaydet";
    case "stock-loss-delete": return "Hasar/kayıp kaydını geri al";
    case "packaging-material": return editor.material ? "Ambalaj malzemesini düzenle" : "Ambalaj malzemesi ekle";
    case "packaging-move": return "Ambalaj stok hareketi";
    case "receipt": return "Tahsilatı kaydet";
    case "order-detail": return "Sipariş detayı";
    case "order-share": return "Satışın ortaklık payını gir";
    case "partner-transfer": return "Ortaklar arası transferi kaydet";
    case "partner-transfer-delete": return "Transferi sil";
    case "settings": return "Varsayılan paketlemeyi düzenle";
    case "order-status": return { packed: "Paketlemeyi tamamla", cancelled: "Siparişi iptal et", returned: "İade kaydet" }[editor.status];
  }
}
function EditorBody({ editor, shop, user, busy, save, open }: { editor: Editor; shop: Shop; user: Member; busy: boolean; save: Save; open: (editor: Editor) => void }) {
  switch (editor.type) {
    case "product":
      return <ProductForm product={editor.product} busy={busy} save={save} />;
    case "product-history":
      return <ProductHistory product={editor.product} data={shop} />;
    case "wholesale-price":
    case "wholesale-price-delete":
      return <WholesaleForm editor={editor} shop={shop} busy={busy} save={save} />;
    case "catalog-settings":
      return <CatalogSettings shop={shop} busy={busy} save={save} />;
    case "undo":
      return <form className="form" onSubmit={event => save(event, "undo", () => ({ auditId: editor.audit.id }))}>
        <p>{undoLabels[editor.audit.action]} · Kayıt #{editor.audit.entityId}</p>
        <SaveButton busy={busy}>İşlemi geri al</SaveButton>
      </form>;
    case "opening-stock":
      return <LinesForm mode="purchase" openingStock shop={shop} user={user} busy={busy} save={save} addProduct={() => open({ type: "product" })} />;
    case "purchase":
    case "order":
      return <LinesForm mode={editor.type} shop={shop} user={user} busy={busy} save={save} addProduct={() => open({ type: "product" })} />;
    case "purchase-edit":
      return <LinesForm mode="purchase" purchaseToEdit={editor.purchase} shop={shop} user={user} busy={busy} save={save} addProduct={() => open({ type: "product" })} />;
    case "order-edit":
      return <LinesForm mode="order" orderToEdit={editor.order} shop={shop} user={user} busy={busy} save={save} addProduct={() => open({ type: "product" })} />;
    case "order-detail":
      return <OrderDetail order={editor.order} users={shop.users} audit={shop.audit} open={open} />;
    case "order-delete":
      return <form className="form" onSubmit={event => save(event, "order-delete", () => ({ id: editor.order.id, revision: editor.order.revision }))}>
        <p>{editor.order.platform} · {editor.order.reference || "#" + editor.order.id} · {money(editor.order.gross)}</p>
        <p className="listing-note">Bu satış ve bağlı tahsilat kaydı silinecek. Satış nedeniyle stoktan çıkan ürünler ve bu siparişte kullanılan ambalaj malzemeleri geri eklenecek.</p>
        {editor.order.receiptDate && <p>Kasadan kaldırılacak tahsilat {money(editor.order.receiptAmount ?? 0)}.</p>}
        <div className="actions"><button className="danger" disabled={busy} type="submit">{busy ? "Siliniyor…" : "Satışı silmeyi onayla"}</button></div>
      </form>;
    case "settings":
      return <form className="form" onSubmit={event => save(event, "settings", data => ({
        defaultPacking: requiredMoney(field(data, "defaultPacking")),
      }))}>
        <AmountField label="Sipariş başına paketleme (₺)" name="defaultPacking" value={moneyInput(editor.defaultPacking)} />
        <SaveButton busy={busy} />
      </form>;
    case "order-share":
      return <form className="form" onSubmit={event => save(event, "order-share", data => ({
        id: editor.order.id, productId: editor.productId, lotId: editor.lotId, firstPartnerShare: Number(field(data, "firstPartnerShare")),
      }))}>
        <p>{editor.productName} · {dateLabel(editor.order.date)}</p>
        <p className="subtle">Bu satışta geçerli olan oranı gir. Kaydettiğinde bu satışın oranı sabitlenir.</p>
        <ShareField users={shop.users} required />
        <SaveButton busy={busy} />
      </form>;
    case "partner-transfer":
      return <form className="form" onSubmit={event => save(event, "partner-transfer", data => {
        const senderId = Number(field(data, "senderId"));
        return { senderId, recipientId: shop.users.find(member => member.id !== senderId)?.id,
          amount: requiredMoney(field(data, "amount")), date: field(data, "date"), note: field(data, "note").trim() || undefined };
      })}>
        <MemberField label="Gönderen ortak" users={shop.users} defaultId={editor.senderId ?? user.id} name="senderId" />
        <p className="subtle">Transfer, diğer ortağa daha önce gönderilen paranın kaydıdır.</p>
        <div className="form-row">
          <AmountField label="Tutar (₺)" name="amount" value={editor.amount === undefined ? undefined : moneyInput(editor.amount)} /><DateField />
        </div>
        <label>Not (isteğe bağlı)<textarea name="note" maxLength={500} rows={3} /></label>
        <SaveButton busy={busy} />
      </form>;
    case "partner-transfer-delete":
      return <form className="form" onSubmit={event => save(event, "partner-transfer-delete", () => ({ id: editor.transfer.id }))}>
        <p>{dateLabel(editor.transfer.date)} · {money(editor.transfer.amount)}</p>
        <p className="listing-note">Transfer kaydı silinir ve ortaklar arası bakiye yeniden hesaplanır.</p>
        <div className="actions"><button className="danger" disabled={busy} type="submit">{busy ? "Siliniyor…" : "Silmeyi onayla"}</button></div>
      </form>;
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
      return <form className="form" onSubmit={event => save(event, editor.purchase.paymentDate ? "purchase-payment-edit" : "purchase-payment", data => ({
        id: editor.purchase.id, ...paymentPayload(data, editor.purchase.total, shop.users),
      }))}>
        <div className="form-totals inline"><span>{editor.purchase.name}</span><strong>{money(editor.purchase.total)}</strong></div>
        <PaymentFields users={shop.users} total={editor.purchase.total} defaultId={user.id} purchase={editor.purchase} />
        <SaveButton busy={busy} />
      </form>;
    case "stock-loss":
      return <form className="form" onSubmit={event => save(event, "stock-loss", data => ({
        productId: Number(field(data, "productId")), quantity: Number(field(data, "quantity")), reason: field(data, "reason"),
        date: field(data, "date"), note: field(data, "note"),
      }))}>
        <label>Ürün<select name="productId" required><option value="">Ürün seç</option>{shop.products.filter(product => product.stock > 0)
          .map(product => <option key={product.id} value={product.id}>{product.name} · {product.stock} adet</option>)}</select></label>
        <div className="form-row"><label>Adet<input name="quantity" type="number" min={1} max={100000} step={1} defaultValue={1} required /></label>
          <label>Neden<select name="reason"><option value="damaged">Hasarlı</option><option value="lost">Kayıp</option></select></label></div>
        <DateField /><label>Not<textarea name="note" maxLength={500} rows={3} /></label>
        <p className="subtle">Ürünler en eski stoktan düşülür. Alış maliyetleri zarar olarak kaydedilir.</p>
        <SaveButton busy={busy} />
      </form>;
    case "stock-loss-delete":
      return <form className="form" onSubmit={event => save(event, "stock-loss-delete", data => ({ id: editor.loss.id, date: field(data, "date") }))}>
        <p>{editor.loss.quantity} adet {editor.loss.productName} stoğa geri eklenecek ve zarar kaydı kaldırılacak.</p>
        <DateField label="Geri alma tarihi" /><SaveButton busy={busy}>Geri almayı onayla</SaveButton>
      </form>;
    case "packaging-material":
      return <form className="form" onSubmit={event => save(event, "packaging-material", data => ({
        id: editor.material?.id, revision: editor.material?.revision, name: field(data, "name"),
        lowThreshold: Number(field(data, "lowThreshold")), perOrder: Number(field(data, "perOrder")),
      }))}>
        <label>Malzeme adı<input name="name" defaultValue={editor.material?.name} maxLength={120} required /></label>
        <div className="form-row">
          <label>Düşük stok eşiği<input name="lowThreshold" type="number" min={0} max={100000} defaultValue={editor.material?.lowThreshold ?? 5} required /></label>
          <label>Sipariş başına kullanılan adet<input name="perOrder" type="number" min={0} max={100000} defaultValue={editor.material?.perOrder ?? 1} required /></label>
        </div>
        <p className="subtle">Sipariş Paketlendi olarak işaretlenince bu adet otomatik düşülür. Elle kullanım takibi için sıfır gir.</p>
        <SaveButton busy={busy} />
      </form>;
    case "packaging-move":
      return <form className="form" onSubmit={event => save(event, "packaging-move", data => ({
        id: editor.material.id, quantity: Number(field(data, "quantity")), direction: field(data, "direction"), date: field(data, "date"), note: field(data, "note"),
      }))}>
        <p>{editor.material.name} · Eldeki {editor.material.quantity} adet</p>
        <label>İşlem<select name="direction"><option value="in">Stok girişi</option><option value="out">Elle kullanım / çıkış</option></select></label>
        <label>Adet<input name="quantity" type="number" min={1} max={100000} defaultValue={1} required /></label>
        <DateField /><label>Not<textarea name="note" maxLength={500} rows={3} /></label><SaveButton busy={busy} />
      </form>;
    case "receipt":
      return <form className="form" onSubmit={event => save(event, "receipt", data => ({
        id: editor.order.id, date: field(data, "date"), amount: requiredMoney(field(data, "amount")), recipientId: Number(field(data, "recipientId")),
      }))}>
        <div className="form-totals inline"><span>{editor.order.netAfterShipping == null || editor.order.shippingPayerId != null ? "Beklenen tahsilat" : "Kargo ve kesinti sonrası net"}</span><strong>{money(editor.order.expectedReceipt)}</strong></div>
        <AmountField label="Hesaba geçen tutar (₺)" name="amount" value={editor.order.expectedReceipt > 0 ? moneyInput(editor.order.expectedReceipt) : undefined} />
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
        const share = field(data, "firstPartnerShare");
        const details = { category: field(data, "category"), amount: requiredMoney(field(data, "amount")), date: field(data, "date"),
          note: field(data, "note").trim() || undefined, firstPartnerShare: share === "" ? null : Number(share) };
        const payerId = Number(field(data, "payerId"));
        return expense ? { ...details, id: expense.id, kind: "expense", memberId: payerId } : { ...details, payerId };
      })}>
        <label>Kategori<select name="category" defaultValue={expense?.category} required>{categories.map(category => <option key={category}>{category}</option>)}</select></label>
        <div className="form-row"><AmountField label="Tutar (₺)" name="amount" value={expense ? moneyInput(expense.amount) : undefined} /><DateField value={expense?.date} /></div>
        <MemberField label="Ödeyen" users={shop.users} defaultId={expense?.payerId ?? user.id} />
        <ShareField users={shop.users} value={expense?.firstPartnerShare} />
        <p className="subtle">Payı boş bırakırsan gider kasada görünür, ortaklar arası bakiyeye dahil edilmez.</p>
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
    case "partners": return <PartnersPage data={shop} open={open} />;
    case "performance": return <PerformancePage data={shop} />;
    case "analytics": return <BusinessAnalyticsPage data={shop} />;
    case "platforms": return <PlatformsPage data={shop} />;
    case "restock": return <RestockPage data={shop} />;
    case "suppliers": return <SuppliersPage data={shop} open={open} />;
    case "missing": return <MissingRecords data={shop} open={open} />;
    case "packaging": return <PackagingPage data={shop} open={open} />;
    case "reports": return <Reports month={shop.summary.month} />;
    case "settings": return <SettingsPage shop={shop} open={open} />;
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
        : action === "cash-delete" ? "Kasa kaydı silindi." : action === "order-delete" ? "Satış kaydı silindi." : "Kayıt güncellendi.");
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
  const latest = shop.audit[0];
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
      {latest?.actorId === user.id && Object.hasOwn(undoLabels, latest.action) && <div className="actions undo-action"><button type="button" onClick={() => open({ type: "undo", audit: latest })}>Son işlemi geri al</button></div>}
      {visiblePage(page, shop, open)}
    </main>
    {editor && <EditorDialog editor={editor} shop={shop} user={user} busy={busy} error={editorError} save={save} open={open} close={() => setEditor(null)} />}
  </div>;
}

