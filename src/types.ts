export interface Stock {
  ticker: string;
  description: string;
  quantity: number;
  lastPrice: number;
  lastPriceChange: number;
  currentValue: number;
  isCash: boolean;
  // Absent when Fidelity shows no figure (cash, "--", "n/a")
  costBasis?: number;
  averageCost?: number;
  totalGainLoss?: number;
  totalGainLossPercent?: number;
}

export interface Account {
  accountNumber: string;
  accountName: string;
  nickname: string;
  balance: number;
  withdrawalBalance: number;
  stocks: Stock[];
}

export type OrderAction = "buy" | "sell";
export type OrderType = "market" | "limit";

export interface OrderRequest {
  accountNumber: string;
  symbol: string;
  action: OrderAction;
  quantity: number;
  orderType?: OrderType;
  limitPrice?: number;
  dryRun?: boolean;
}

export interface OrderResult {
  success: boolean;
  message: string;
  orderDetails?: {
    estimatedValue?: string;
    account: string;
    symbol: string;
    action: OrderAction;
    quantity?: number;
    amount?: number;
    price?: number;
    orderType: OrderType;
    limitPrice?: number;
    extendedHours: boolean;
  };
}

export interface QuoteResult {
  symbol: string;
  lastPrice: number;
  extendedHoursPrice?: number;
  isExtendedHours: boolean;
}
