class MockPaymentService {
  async createPaymentIntent(amountCents, currency, metadata = {}) {
    return {
      paymentIntentId: `pi_mock_${Date.now()}`,
      amountCents,
      currency,
      metadata
    };
  }

  async confirmPayment(paymentIntentId, paymentMethodToken) {
    if (!paymentIntentId) throw new Error('paymentIntentId is required');
    if (!paymentMethodToken) throw new Error('paymentMethodToken is required');
    return {
      status: 'CONFIRMED',
      paymentIntentId
    };
  }
}

module.exports = { MockPaymentService };

