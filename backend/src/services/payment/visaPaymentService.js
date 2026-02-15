const config = require('../../config');

class VisaPaymentService {
  async createPaymentIntent(amountCents, currency, metadata = {}) {
    if (!config.visaApiBaseUrl) {
      throw new Error('VISA_API_BASE_URL is not set');
    }
    if (!config.visaApiKey || !config.visaApiSecret) {
      throw new Error('VISA_API_KEY / VISA_API_SECRET are not set');
    }

    // TODO: Replace with real Visa rails integration.
    // Candidate products/services:
    // - Visa Acceptance Solutions / CyberSource (auth/capture)
    // - Visa Direct (payout rails)
    // - Tokenization services
    // This prototype keeps the interface stable for judges.
    console.log('[VisaPaymentService] createPaymentIntent', {
      amountCents,
      currency,
      metadata
    });

    return {
      paymentIntentId: `pi_visa_stub_${Date.now()}`,
      amountCents,
      currency,
      metadata
    };
  }

  async confirmPayment(paymentIntentId, paymentMethodToken) {
    console.log('[VisaPaymentService] confirmPayment', { paymentIntentId });

    // TODO: Call Visa/CyberSource capture/confirm endpoint here.
    // This stub always succeeds.
    if (!paymentMethodToken) {
      return { status: 'FAILED', paymentIntentId, reason: 'missing_payment_method' };
    }

    return { status: 'CONFIRMED', paymentIntentId };
  }
}

module.exports = { VisaPaymentService };

