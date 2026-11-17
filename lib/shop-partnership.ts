type SaleLine = {
  productId: number;
  productName: string;
  purchaseId: number;
  lotId?: number;
  quantity: number;
  agreedPrice: number;
  unitCost: number;
  firstPartnerShare: number | null;
};

type Sale = {
  id: number;
  date: string;
  status: string;
  platformFee: number;
  shipping: number;
  netAfterShipping?: number | null;
  packing: number;
  shippingPayerId?: number | null;
  packingPayerId?: number | null;
  receiptDate: string | null;
  receiptAmount: number | null;
  recipientId: number | null;
  lines: SaleLine[];
};

export type PartnerTransfer = { id: number; senderId: number; recipientId: number; date: string; amount: number; note: string };
export type PurchasePayment = { payerId: number; amount: number; date: string };
export type StockLoss = { id: number; productId: number; productName: string; quantity: number; date: string; reason: string; note: string;
  lines: { purchaseId: number; quantity: number; unitCost: number; firstPartnerShare: number | null }[] };
type PaidPurchase = { id: number; total?: number; openingPayerId?: number | null; date?: string; paymentDate: string | null; payerId: number | null; payments?: PurchasePayment[] };

type PartnershipData = {
  users: { id: number }[];
  orders: Sale[];
  purchases: PaidPurchase[];
  stockLosses?: StockLoss[];
  expenses: { date: string; amount: number; payerId: number; firstPartnerShare: number | null }[];
  cash: { kind: string; date: string; amount: number; memberId: number }[];
  partnerTransfers: PartnerTransfer[];
};

function roundedRatio(amount: number, numerator: number, denominator: number) {
  const absolute = BigInt(Math.abs(amount)) * BigInt(numerator);
  const divisor = BigInt(denominator);
  return Math.sign(amount) * Number((absolute + divisor / 2n) / divisor);
}

export function allocate(amount: number, weights: number[]) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let weightSum = 0;
  let allocated = 0;
  return weights.map(weight => {
    weightSum += weight;
    const next = roundedRatio(amount, weightSum, total);
    const part = next - allocated;
    allocated = next;
    return part;
  });
}

function productGroups(lines: SaleLine[]) {
  const groups = new Map<string, SaleLine[]>();
  for (const line of lines) {
    const key = line.productId + ":" + line.firstPartnerShare;
    const group = groups.get(key);
    if (group) group.push(line);
    else groups.set(key, [line]);
  }
  return [...groups.values()].map(group => {
    const [product] = group;
    return {
      productId: product.productId, productName: product.productName, share: product.firstPartnerShare ?? null,
      quantity: group.reduce((sum, line) => sum + line.quantity, 0),
      gross: group.reduce((sum, line) => sum + line.agreedPrice * line.quantity, 0),
      cost: group.reduce((sum, line) => sum + line.unitCost * line.quantity, 0),
      lots: group,
    };
  });
}

function reimbursements(purchases: Map<number, PaidPurchase>, costs: Map<number, number>, through: string, cumulativeCosts: Map<number, number>) {
  const paid = new Map<number, number>();
  let latest = "";
  for (const [purchaseId, cost] of costs) {
    const purchase = purchases.get(purchaseId);
    if (purchase?.openingPayerId != null && purchase.date && purchase.date <= through) {
      paid.set(purchase.openingPayerId, (paid.get(purchase.openingPayerId) ?? 0) + cost);
      if (purchase.date > latest) latest = purchase.date;
      continue;
    }
    if (!purchase) return null;
    const payments = purchase.payments?.length ? purchase.payments
      : purchase.payerId !== null && purchase.paymentDate !== null ? [{ payerId: purchase.payerId, date: purchase.paymentDate, amount: purchase.total ?? 1 }] : [];
    const total = payments.reduce((sum, payment) => sum + payment.amount, 0);
    if (!total || (purchase.total !== undefined && total !== purchase.total) || payments.some(payment => payment.date > through)) return null;
    const previous = cumulativeCosts.get(purchaseId) ?? 0;
    const weights = payments.map(payment => payment.amount);
    const before = allocate(previous, weights);
    const after = allocate(previous + cost, weights);
    const portions = after.map((amount, index) => amount - before[index]);
    payments.forEach((payment, index) => {
      paid.set(payment.payerId, (paid.get(payment.payerId) ?? 0) + portions[index]);
      if (payment.date > latest) latest = payment.date;
    });
  }
  for (const [purchaseId, cost] of costs) cumulativeCosts.set(purchaseId, (cumulativeCosts.get(purchaseId) ?? 0) + cost);
  return { paid, latest };
}

export function calculatePartnership(data: PartnershipData, from: string, through: string) {
  const [first, second] = [...data.users].sort((a, b) => a.id - b.id);
  const inPeriod = (day: string) => day >= from && day <= through;
  const partners = [first, second].map(member => {
    const movements = data.cash.filter(entry => entry.memberId === member.id && inPeriod(entry.date));
    return {
      id: member.id,
      receipts: movements.reduce((sum, entry) => sum + Math.max(0, entry.amount), 0),
      stockPaid: movements.filter(entry => entry.kind === "purchase").reduce((sum, entry) => sum - entry.amount, 0),
      expensesPaid: movements.filter(entry => entry.kind === "expense" || entry.kind === "sale-cost").reduce((sum, entry) => sum - entry.amount, 0),
      realizedShare: 0,
    };
  });
  const purchaseById = new Map(data.purchases.map(purchase => [purchase.id, purchase]));
  const cumulativeCosts = new Map<number, number>();
  const products = new Map<number, { productId: number; name: string; quantity: number; gross: number; profit: number; lossCost: number; firstProfit: number; secondProfit: number; unassigned: number }>();
  const missingShares = new Set<number>();
  const awaitingStockPayments = new Set<number>();
  let excludedReceipts = 0;
  let firstBalance = 0;

  for (const order of data.orders) {
    const collected = order.receiptDate !== null && order.receiptDate <= through && order.receiptAmount !== null;
    const groups = productGroups(order.lines);
    const directCosts = (order.shippingPayerId != null ? order.shipping : 0) + (order.packingPayerId != null ? order.packing : 0);
    const firstPaid = (order.shippingPayerId === first.id ? order.shipping : 0) + (order.packingPayerId === first.id ? order.packing : 0);
    if (order.status === "returned" || order.status === "cancelled") {
      if (collected) excludedReceipts += order.receiptAmount!;
      if (directCosts && order.date <= through && groups.length && groups.every(group => group.share !== null)) {
        const costs = allocate(directCosts, groups.map(group => group.quantity));
        const firstCost = costs.reduce((sum, amount, i) => sum + roundedRatio(amount, groups[i].share!, 100), 0);
        firstBalance += firstPaid - firstCost;
        if (inPeriod(order.date)) {
          partners[0].realizedShare -= firstCost;
          partners[1].realizedShare -= directCosts - firstCost;
        }
      }
      continue;
    }
    if (!groups.length) continue;
    const hasGross = groups.some(group => group.gross > 0);
    const weights = groups.map(group => hasGross ? group.gross : group.quantity);
    const missing = groups.some(group => group.share === null);
    if (missing && (inPeriod(order.date) || collected)) missingShares.add(order.id);

    if (inPeriod(order.date)) {
      const deductions = order.netAfterShipping == null ? order.platformFee + order.shipping
        : groups.reduce((sum, group) => sum + group.gross, 0) - order.netAfterShipping;
      const fees = allocate(deductions + order.packing, weights);
      groups.forEach((group, i) => {
        const product = products.get(group.productId) ?? { productId: group.productId, name: group.productName, quantity: 0, gross: 0, profit: 0, lossCost: 0, firstProfit: 0, secondProfit: 0, unassigned: 0 };
        const profit = group.gross - fees[i] - group.cost;
        product.quantity += group.quantity;
        product.gross += group.gross;
        product.profit += profit;
        if (group.share === null) product.unassigned += 1;
        else {
          const firstProfit = roundedRatio(profit, group.share, 100);
          product.firstProfit += firstProfit;
          product.secondProfit += profit - firstProfit;
        }
        products.set(group.productId, product);
      });
    }

    if (!collected || missing) continue;
    const costs = new Map<number, number>();
    for (const line of order.lines) {
      if (line.unitCost === 0) continue;
      costs.set(line.purchaseId, (costs.get(line.purchaseId) ?? 0) + line.unitCost * line.quantity);
    }
    const stockPayments = reimbursements(purchaseById, costs, through, cumulativeCosts);
    if (!stockPayments) {
      awaitingStockPayments.add(order.id);
      continue;
    }
    const eligibleDate = stockPayments.latest > order.receiptDate! ? stockPayments.latest : order.receiptDate!;
    const receipts = allocate(order.receiptAmount! - directCosts, weights);
    firstBalance += firstPaid;
    firstBalance += (stockPayments.paid.get(first.id) ?? 0) - (order.recipientId === first.id ? order.receiptAmount! : 0);
    groups.forEach((group, i) => {
      const profit = receipts[i] - group.cost;
      const firstShare = roundedRatio(profit, group.share!, 100);
      firstBalance += firstShare;
      if (inPeriod(eligibleDate)) {
        partners[0].realizedShare += firstShare;
        partners[1].realizedShare += profit - firstShare;
      }
    });
  }

  let awaitingLossPayments = 0;
  for (const loss of data.stockLosses ?? []) {
    if (loss.date > through) continue;
    const costs = new Map<number, number>();
    let lossCost = 0;
    let firstLoss = 0;
    for (const line of loss.lines) {
      const cost = line.quantity * line.unitCost;
      lossCost += cost;
      firstLoss += roundedRatio(cost, line.firstPartnerShare ?? 0, 100);
      if (cost) costs.set(line.purchaseId, (costs.get(line.purchaseId) ?? 0) + cost);
    }
    const product = products.get(loss.productId) ?? { productId: loss.productId, name: loss.productName, quantity: 0, gross: 0, profit: 0, lossCost: 0, firstProfit: 0, secondProfit: 0, unassigned: 0 };
    if (inPeriod(loss.date)) {
      product.profit -= lossCost;
      product.lossCost += lossCost;
      product.firstProfit -= firstLoss;
      product.secondProfit -= lossCost - firstLoss;
      products.set(loss.productId, product);
    }
    const payments = reimbursements(purchaseById, costs, through, cumulativeCosts);
    if (!payments) { awaitingLossPayments += 1; continue; }
    firstBalance += (payments.paid.get(first.id) ?? 0) - firstLoss;
    const eligibleDate = payments.latest > loss.date ? payments.latest : loss.date;
    if (inPeriod(eligibleDate)) {
      partners[0].realizedShare -= firstLoss;
      partners[1].realizedShare -= lossCost - firstLoss;
    }
  }

  let unassignedExpenses = 0;
  for (const expense of data.expenses) {
    if (expense.date > through) continue;
    if (expense.firstPartnerShare == null) {
      unassignedExpenses += 1;
      continue;
    }
    const firstCost = roundedRatio(expense.amount, expense.firstPartnerShare, 100);
    firstBalance += (expense.payerId === first.id ? expense.amount : 0) - firstCost;
    if (inPeriod(expense.date)) {
      partners[0].realizedShare -= firstCost;
      partners[1].realizedShare -= expense.amount - firstCost;
    }
  }
  for (const transfer of data.partnerTransfers ?? []) {
    if (transfer.date <= through) firstBalance += transfer.senderId === first.id ? transfer.amount : -transfer.amount;
  }
  return { partners, products: [...products.values()], firstBalance, missingShares, awaitingStockPayments, awaitingLossPayments, excludedReceipts, unassignedExpenses };
}
