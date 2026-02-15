const config = require('../../config');
const { MockPaymentService } = require('./mockPaymentService');
const { VisaPaymentService } = require('./visaPaymentService');

function createPaymentService() {
  const provider = String(config.paymentProvider || 'mock').toLowerCase();
  if (provider === 'visa') return new VisaPaymentService();
  return new MockPaymentService();
}

module.exports = { createPaymentService };

