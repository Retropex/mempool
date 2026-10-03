import { query } from '../../utils/axios-query';
import priceUpdater, { PriceFeed, PriceHistory } from '../price-updater';

/**
 * BTCB2/USDC price from neoxa.exchange, used from the BLAKE2b fork onwards
 * USDC is treated as USD, other currencies are derived by the price updater
 */
class NeoxaApi implements PriceFeed {
  public name: string = 'Neoxa';
  public currencies: string[] = ['USD'];

  public url: string = 'https://neoxa.exchange/api/exchange/ticker/BTCB2_USDC';
  public urlHist: string = 'https://neoxa.exchange/api/exchange/candles/BTCB2_USDC?interval={GRANULARITY}&limit=1000';

  constructor() {
  }

  /** @asyncUnsafe */
  public async $fetchPrice(currency): Promise<number> {
    if (!this.currencies.includes(currency)) {
      return -1;
    }
    const response = await query(this.url);
    if (response && response['success'] && response['ticker'] && response['ticker']['lastPrice'] > 0) {
      return parseFloat(response['ticker']['lastPrice']);
    } else {
      return -1;
    }
  }

  /** @asyncUnsafe */
  public async $fetchRecentPrice(currencies: string[], type: 'hour' | 'day'): Promise<PriceHistory> {
    const priceHistory: PriceHistory = {};
    if (!currencies.includes('USD')) {
      return priceHistory;
    }

    const response = await query(this.urlHist.replace('{GRANULARITY}', type === 'hour' ? '1h' : '1d'));
    const candles = response && response['success'] && Array.isArray(response['candles']) ? response['candles'] : [];

    for (const candle of candles) {
      if (candle.close > 0) {
        priceHistory[candle.time] = priceUpdater.getEmptyPricesObj();
        priceHistory[candle.time]['USD'] = candle.close;
      }
    }

    return priceHistory;
  }
}

export default NeoxaApi;
