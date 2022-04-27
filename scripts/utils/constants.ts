/**
 * Vault params
 */
export const STRIKE_STEP = {
  "ETH": 100*1e18, // ETH strike prices move in increments of 100
  "WBTC": 1000*1e18, // WBTC strike prices move in increments of 1000
  "AVAX": 10*1e18,
  "AAVE": 10*1e18,
  "NEAR": 5*1e18,
  "AURORA": 5*1e18,
  "APE": 1*1e18,
  "PERP": 0.1*1e18,
}

export const STRIKE_DELTA = 1000; // 0.1d
export const PREMIUM_DISCOUNT = 200; // 0.20, 80% discount
export const AUCTION_DURATION = 3600; // 1 hour
export const PERFORMANCE_FEE = 10000000;
export const MANAGEMENT_FEE = 2000000; // 2% per year. 2 * 10**6. Should result in 38356 per week.

/**
 * Treasury Vault Params
 */
export const PERP_STRIKE_MULTIPLIER = 150;
