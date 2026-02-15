const path = require('path');
const dotenv = require('dotenv');

// Always load the backend `.env` regardless of where the process is started from.
// (Using `process.cwd()` breaks when the server is launched from the repo root.)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function bool(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

module.exports = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',

  enableAIRecognition: bool(process.env.ENABLE_AI_RECOGNITION, true),
  aiRecognitionTimeoutMs: Number(process.env.AI_RECOGNITION_TIMEOUT_MS || 9000),

  openaiApiBaseUrl: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiVisionModel: process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini',
  openaiVisionReasoningEffort: process.env.OPENAI_VISION_REASONING_EFFORT || '',
  openaiVisionMaxOutputTokens: Number(process.env.OPENAI_VISION_MAX_OUTPUT_TOKENS || 1200),

  enableWebSearchOffers: bool(process.env.ENABLE_WEB_SEARCH_OFFERS, true),
  webSearchRequestTimeoutMs: Number(process.env.WEB_SEARCH_REQUEST_TIMEOUT_MS || 5500),
  webSearchRetailerLimit: Number(process.env.WEB_SEARCH_RETAILER_LIMIT || 4),

  enableSerpApiProxy: bool(process.env.ENABLE_SERPAPI_PROXY, true),
  serpApiBaseUrl: process.env.SERPAPI_BASE_URL || 'https://serpapi.com',
  serpApiApiKey: process.env.SERPAPI_API_KEY || '',
  serpApiEngine: process.env.SERPAPI_ENGINE || 'google',
  serpApiCountry: process.env.SERPAPI_COUNTRY || 'us',
  serpApiLanguage: process.env.SERPAPI_LANGUAGE || 'en',
  serpApiRequestTimeoutMs: Number(process.env.SERPAPI_REQUEST_TIMEOUT_MS || 12000),

  enableUpcDbLookup: bool(process.env.ENABLE_UPC_DB_LOOKUP, true),
  upcDbLookupTimeoutMs: Number(process.env.UPC_DB_LOOKUP_TIMEOUT_MS || 5000),
  enableUpcItemDbLookup: bool(process.env.ENABLE_UPCITEMDB_LOOKUP, true),
  upcItemDbApiBaseUrl: process.env.UPCITEMDB_API_BASE_URL || 'https://api.upcitemdb.com',
  upcItemDbApiKey: process.env.UPCITEMDB_API_KEY || '',
  enableOpenFoodFactsLookup: bool(process.env.ENABLE_OPENFOODFACTS_LOOKUP, true),
  openFoodFactsApiBaseUrl: process.env.OPENFOODFACTS_API_BASE_URL || 'https://world.openfoodfacts.org',

  paymentProvider: process.env.PAYMENT_PROVIDER || 'mock',
  visaApiBaseUrl: process.env.VISA_API_BASE_URL || '',
  visaApiKey: process.env.VISA_API_KEY || '',
  visaApiSecret: process.env.VISA_API_SECRET || '',

  extensionWebhookSecret: process.env.EXTENSION_WEBHOOK_SECRET || '',
  sharedWatchlistWebhookSecret: process.env.SHARED_WATCHLIST_WEBHOOK_SECRET || '',

  enableSharedRemoteWatchlistSync: bool(process.env.ENABLE_SHARED_REMOTE_WATCHLIST_SYNC, false),
  sharedRemoteWatchlistBaseUrl: process.env.SHARED_REMOTE_WATCHLIST_BASE_URL || '',
  sharedRemoteWatchlistTimeoutMs: Number(process.env.SHARED_REMOTE_WATCHLIST_TIMEOUT_MS || 7000),
  enableSharedRemoteWatchlistPull: bool(
    process.env.ENABLE_SHARED_REMOTE_WATCHLIST_PULL,
    bool(process.env.ENABLE_SHARED_REMOTE_WATCHLIST_SYNC, false)
  ),
  sharedRemoteWatchlistPullPath: process.env.SHARED_REMOTE_WATCHLIST_PULL_PATH || '/items',
  sharedRemoteWatchlistPullReplace: bool(process.env.SHARED_REMOTE_WATCHLIST_PULL_REPLACE, false)
};
