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
  receiptDate: string | null;
  receiptAmount: number | null;
  recipientId: number | null;
  lines: SaleLine[];
};

export type PartnerTransfer = { id: number; senderId: number; recipientId: number; date: string; amount: number; note: string };

type PartnershipData = {
  users: { id: number }[];
  orders: Sale[];
  purchases: { id: number; paymentDate: string | null; payerId: number | null }[];
  expenses: { date: string; amount: number; payerId: number; firstPartnerShare: number | null }[];
  cash: { kind: string; date: string; amount: number; memberId: number }[];
  partnerTransfers: PartnerTransfer[];
};

function roundedRatio(amount: number, numerator: number, denominator: number) {
  const absolute = BigInt(Math.abs(amount)) * BigInt(numerator);
  const divisor = BigInt(denominator);
  return Math.sign(amount) * Number((absolute + divisor / 2n) / divisor);
}

function allocate(amount: number, weights: number[]) {
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

export function calculatePartnership(data: PartnershipData, from: string, through: string) {
  const [first, second] = [...data.users].sort((a, b) => a.id - b.id);
  const inPeriod = (day: string) => day >= from && day <= through;
  const partners = [first, second].map(member => {
    const movements = data.cash.filter(entry => entry.memberId === member.id && inPeriod(entry.date));
    return {
      id: member.id,
      receipts: movements.reduce((sum, entry) => sum + Math.max(0, entry.amount), 0),
      stockPaid: movements.filter(entry => entry.kind === "purchase").reduce((sum, entry) => sum - entry.amount, 0),
      expensesPaid: movements.filter(entry => entry.kind === "expense").reduce((sum, entry) => sum - entry.amount, 0),
      realizedShare: 0,
    };
  });
  const purchaseById = new Map(data.purchases.map(purchase => [purchase.id, purchase]));
  const products = new Map<number, { productId: number; name: string; quantity: number; gross: number; profit: number; firstProfit: number; secondProfit: number; unassigned: number }>();
  const missingShares = new Set<number>();
  const awaitingStockPayments = new Set<number>();
  let excludedReceipts = 0;
  let firstBalance = 0;

  for (const order of data.orders) {
    const collected = order.receiptDate !== null && order.receiptDate <= through && order.receiptAmount !== null;
    if (order.status === "returned" || order.status === "cancelled") {
      if (collected) excludedReceipts += order.receiptAmount!;
      continue;
    }
    const groups = productGroups(order.lines);
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
        const product = products.get(group.productId) ?? { productId: group.productId, name: group.productName, quantity: 0, gross: 0, profit: 0, firstProfit: 0, secondProfit: 0, unassigned: 0 };
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
    let eligibleDate = order.receiptDate!;
    const paidStock = new Map<number, number>();
    let unpaid = false;
    for (const line of order.lines) {
      if (line.unitCost === 0) continue;
      const purchase = purchaseById.get(line.purchaseId);
      if (purchase?.payerId == null || purchase.paymentDate === null || purchase.paymentDate > through) {
        unpaid = true;
        break;
      }
      eligibleDate = purchase.paymentDate > eligibleDate ? purchase.paymentDate : eligibleDate;
      paidStock.set(purchase.payerId, (paidStock.get(purchase.payerId) ?? 0) + line.unitCost * line.quantity);
    }
    if (unpaid) {
      awaitingStockPayments.add(order.id);
      continue;
    }
    const receipts = allocate(order.receiptAmount!, weights);
    firstBalance += (paidStock.get(first.id) ?? 0) - (order.recipientId === first.id ? order.receiptAmount! : 0);
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
  return { partners, products: [...products.values()], firstBalance, missingShares, awaitingStockPayments, excludedReceipts, unassignedExpenses };
}
